/**
 * auth.ts — social & email authentication endpoints.
 *
 * POST /api/auth/google         Verify Google ID token → create/find profile → return JWT
 * POST /api/auth/email/send     Send 6-digit OTP to email
 * POST /api/auth/email/verify   Verify OTP → create/find profile → return JWT
 * GET  /api/auth/me             Return profile from JWT (Authorization: Bearer <token>)
 * POST /api/auth/logout         Client-side logout hint (clears server-side nonce if any)
 */

import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "crypto";
import { eq, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { profilesTable } from "@workspace/db/schema";
import { signToken, verifyToken, extractBearer } from "../lib/auth-jwt";
import { generateOTP, verifyOTP, sendOTPEmail } from "../lib/email-otp";

const router = Router();

// ── helpers ────────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID || undefined);

function slugifyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 20);
}

async function uniqueUsername(base: string): Promise<string> {
  const slug = slugifyName(base) || "user";
  // Try base first, then with random suffix
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = attempt === 0 ? slug : `${slug}_${Math.floor(1000 + Math.random() * 9000)}`;
    const existing = await db
      .select({ username: profilesTable.username })
      .from(profilesTable)
      .where(eq(profilesTable.username, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  return `user_${randomUUID().slice(0, 8)}`;
}

// ── POST /api/auth/google ──────────────────────────────────────────────────

router.post("/auth/google", async (req, res) => {
  const { credential } = req.body as { credential?: string };
  if (!credential) return void res.status(400).json({ error: "credential required" });
  if (!GOOGLE_CLIENT_ID) return void res.status(503).json({ error: "Google auth not configured" });

  let googleId: string, email: string, name: string, picture: string;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) throw new Error("empty payload");
    googleId = payload.sub;
    email    = payload.email ?? "";
    name     = payload.name  ?? email.split("@")[0] ?? "user";
    picture  = payload.picture ?? "";
  } catch (err: unknown) {
    return void res.status(401).json({ error: "invalid Google token", detail: String(err) });
  }

  // Find or create profile
  const existing = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.googleId, googleId))
    .limit(1);

  let profile = existing[0];

  if (!profile) {
    // Also check by email in case user signed up via email first
    const byEmail = email
      ? await db.select().from(profilesTable).where(eq(profilesTable.email, email)).limit(1)
      : [];

    if (byEmail[0]) {
      // Link Google to existing email profile
      profile = (
        await db
          .update(profilesTable)
          .set({ googleId, avatarUrl: byEmail[0].avatarUrl || picture || null })
          .where(eq(profilesTable.address, byEmail[0].address))
          .returning()
      )[0];
    } else {
      // Create new profile
      const address  = randomUUID();
      const username = await uniqueUsername(name);
      profile = (
        await db
          .insert(profilesTable)
          .values({
            address,
            username,
            email:     email || null,
            googleId,
            avatarUrl: picture || null,
            authType:  "google",
          })
          .returning()
      )[0];
    }
  }

  const token = signToken({ sub: profile.address, authType: "google" });
  return void res.json({ token, profile });
});

// ── POST /api/auth/email/send ──────────────────────────────────────────────

router.post("/auth/email/send", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email || !email.includes("@")) {
    return void res.status(400).json({ error: "valid email required" });
  }
  const code = generateOTP(email.toLowerCase());
  try {
    await sendOTPEmail(email.toLowerCase(), code);
    return void res.json({ ok: true });
  } catch (err) {
    return void res.status(500).json({ error: "Failed to send email", detail: String(err) });
  }
});

// ── POST /api/auth/email/verify ────────────────────────────────────────────

router.post("/auth/email/verify", async (req, res) => {
  const { email, code } = req.body as { email?: string; code?: string };
  if (!email || !code) return void res.status(400).json({ error: "email and code required" });

  const ok = verifyOTP(email.toLowerCase(), code);
  if (!ok) return void res.status(401).json({ error: "Invalid or expired code" });

  const existing = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.email, email.toLowerCase()))
    .limit(1);

  let profile = existing[0];
  if (!profile) {
    const address  = randomUUID();
    const username = await uniqueUsername(email.split("@")[0]);
    profile = (
      await db
        .insert(profilesTable)
        .values({ address, username, email: email.toLowerCase(), authType: "email" })
        .returning()
    )[0];
  }

  const token = signToken({ sub: profile.address, authType: "email" });
  return void res.json({ token, profile });
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────

router.get("/auth/me", async (req, res) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) return void res.status(401).json({ error: "No token" });

  const payload = verifyToken(token);
  if (!payload) return void res.status(401).json({ error: "Invalid or expired token" });

  const profiles = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.address, payload.sub))
    .limit(1);

  if (!profiles[0]) return void res.status(404).json({ error: "Profile not found" });

  return void res.json({ profile: profiles[0], authType: payload.authType });
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────

router.post("/auth/logout", (_req, res) => {
  // JWT is stateless — client just drops the token. Nothing server-side to clear.
  return void res.json({ ok: true });
});

export default router;
