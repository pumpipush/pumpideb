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
router.get("/profiles/:address", async (req, res): Promise<void> => {
  const parsed = GetProfileParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  const [profile] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.address, parsed.data.address))
    .limit(1);

  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  const response = GetProfileResponse.safeParse(profile);
  if (!response.success) {
    res.status(500).json({ error: "Response parse error" });
    return;
  }
  res.json(response.data);
});

// POST /profiles — create or upsert profile
router.post("/profiles", async (req, res): Promise<void> => {
  const parsed = CreateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

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
    if (!response.success) {
      res.status(500).json({ error: "Response parse error" });
      return;
    }
    res.status(200).json(response.data);
    return;
  }

  const [profile] = await db
    .insert(profilesTable)
    .values({ address, username: resolvedUsername, ...rest })
    .returning();

  const response = CreateProfileResponse.safeParse(profile);
  if (!response.success) {
    res.status(500).json({ error: "Response parse error" });
    return;
  }
  res.status(201).json(response.data);
});

// PATCH /profiles/:address
router.patch("/profiles/:address", async (req, res): Promise<void> => {
  const paramsParsed = UpdateProfileParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  const bodyParsed = UpdateProfileBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: bodyParsed.error.message });
    return;
  }

  const [updated] = await db
    .update(profilesTable)
    .set({ ...bodyParsed.data, updatedAt: new Date() })
    .where(eq(profilesTable.address, paramsParsed.data.address))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  const response = UpdateProfileResponse.safeParse(updated);
  if (!response.success) {
    res.status(500).json({ error: "Response parse error" });
    return;
  }
  res.json(response.data);
});

export default router;
