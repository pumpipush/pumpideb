import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, profilesTable } from "@workspace/db";
import {
  GetProfileParams,
  GetProfileResponse,
  CreateProfileBody,
  CreateProfileResponse,
  UpdateProfileParams,
  UpdateProfileBody,
  UpdateProfileResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /profiles/:address
router.get("/profiles/:address", async (req, res) => {
  const parsed = GetProfileParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid address" });

  const [profile] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.address, parsed.data.address))
    .limit(1);

  if (!profile) return res.status(404).json({ error: "Profile not found" });

  const response = GetProfileResponse.safeParse(profile);
  if (!response.success) return res.status(500).json({ error: "Response parse error" });
  res.json(response.data);
});

// POST /profiles — create or upsert profile
router.post("/profiles", async (req, res) => {
  const parsed = CreateProfileBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { address, username, ...rest } = parsed.data;

  // Auto-generate username if not provided
  const resolvedUsername = username ?? `user_${address.slice(-6).toLowerCase()}`;

  // Upsert: if profile already exists, return it
  const existing = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.address, address))
    .limit(1);

  if (existing.length > 0) {
    const response = CreateProfileResponse.safeParse(existing[0]);
    if (!response.success) return res.status(500).json({ error: "Response parse error" });
    return res.status(200).json(response.data);
  }

  const [profile] = await db
    .insert(profilesTable)
    .values({ address, username: resolvedUsername, ...rest })
    .returning();

  const response = CreateProfileResponse.safeParse(profile);
  if (!response.success) return res.status(500).json({ error: "Response parse error" });
  res.status(201).json(response.data);
});

// PATCH /profiles/:address
router.patch("/profiles/:address", async (req, res) => {
  const paramsParsed = UpdateProfileParams.safeParse(req.params);
  if (!paramsParsed.success) return res.status(400).json({ error: "Invalid address" });

  const bodyParsed = UpdateProfileBody.safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: bodyParsed.error.message });

  const [updated] = await db
    .update(profilesTable)
    .set({ ...bodyParsed.data, updatedAt: new Date() })
    .where(eq(profilesTable.address, paramsParsed.data.address))
    .returning();

  if (!updated) return res.status(404).json({ error: "Profile not found" });

  const response = UpdateProfileResponse.safeParse(updated);
  if (!response.success) return res.status(500).json({ error: "Response parse error" });
  res.json(response.data);
});

export default router;
