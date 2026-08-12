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
import nacl from "tweetnacl";

// ── Base58 decoder (Solana alphabet) ──────────────────────────────────────
const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = BS58_ALPHA.indexOf(c);
    if (i < 0) throw new Error(`Invalid base58 character: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let leading = 0;
  for (const c of s) { if (c !== "1") break; leading++; }
  return new Uint8Array([...new Array(leading).fill(0), ...bytes]);
}

// ── Single-use wallet-link nonce store ────────────────────────────────────
// Nonces are issued per (JWT profile address, wallet address) pair,
// consumed on first use to prevent replay.
interface WalletLinkNonce {
  profileAddress: string;
  walletAddress:  string;
  expiresAt:      number; // ms epoch
}
const walletLinkNonces = new Map<string, WalletLinkNonce>();

// Prune expired entries periodically so the Map doesn't grow unboundedly.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of walletLinkNonces) {
    if (now > entry.expiresAt) walletLinkNonces.delete(key);
  }
}, 60_000).unref();

// ── OTP rate limiting ─────────────────────────────────────────────────────
// Prevents email-send spam and brute-force attempts against the 6-digit code.
const otpSendLimiter   = new Map<string, { count: number; resetAt: number }>();
const otpVerifyLimiter = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(
  store: Map<string, { count: number; resetAt: number }>,
  key: string,
  max: number,
  windowMs: number,
): boolean {
  const now   = Date.now();
  const entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// Prune limiter maps every 30 min so they don't grow unboundedly.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpSendLimiter)   { if (now > v.resetAt) otpSendLimiter.delete(k);   }
  for (const [k, v] of otpVerifyLimiter) { if (now > v.resetAt) otpVerifyLimiter.delete(k); }
}, 30 * 60_000).unref();

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
  // Max 3 sends per email per 15 minutes
  if (!checkRateLimit(otpSendLimiter, email.toLowerCase(), 3, 15 * 60_000)) {
    return void res.status(429).json({ error: "Too many attempts. Please wait 15 minutes before requesting another code." });
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

  // Max 10 verify attempts per email per 15 minutes (brute-force guard)
  if (!checkRateLimit(otpVerifyLimiter, email.toLowerCase(), 10, 15 * 60_000)) {
    return void res.status(429).json({ error: "Too many verification attempts. Please request a new code." });
  }

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

// ── GET /api/auth/wallet/link/challenge ────────────────────────────────────
// Issue a single-use nonce the client must sign with the target wallet before
// calling POST /api/auth/wallet/link.
// Query: ?wallet=<base58 Solana address>
// Requires: Authorization: Bearer <social-user JWT>

router.get("/auth/wallet/link/challenge", async (req, res) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) return void res.status(401).json({ error: "No token" });

  const payload = verifyToken(token);
  if (!payload) return void res.status(401).json({ error: "Invalid or expired token" });
  if (payload.authType === "wallet") {
    return void res.status(400).json({ error: "Wallet-auth accounts do not need a linked wallet" });
  }

  const walletAddress = typeof req.query.wallet === "string" ? req.query.wallet.trim() : "";
  if (!walletAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return void res.status(400).json({ error: "wallet query param must be a valid Solana address" });
  }

  const nonce = randomUUID();
  walletLinkNonces.set(nonce, {
    profileAddress: payload.sub,
    walletAddress,
    expiresAt: Date.now() + 5 * 60_000, // 5 minutes
  });

  return void res.json({ nonce, message: `RocketFi:linkwallet:${walletAddress}:${nonce}` });
});

// ── POST /api/auth/wallet/link ─────────────────────────────────────────────
// Link a Solana wallet to the authenticated social user's profile.
// Requires proof of ownership: a server-issued nonce signed by the wallet.
// Body: { walletAddress, signature, message }
// Requires: Authorization: Bearer <social-user JWT>

router.post("/auth/wallet/link", async (req, res) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) return void res.status(401).json({ error: "No token" });

  const payload = verifyToken(token);
  if (!payload) return void res.status(401).json({ error: "Invalid or expired token" });
  if (payload.authType === "wallet") {
    return void res.status(400).json({ error: "Wallet-auth accounts do not need a linked wallet" });
  }

  const body = req.body as { walletAddress?: string; signature?: string; message?: string };
  const { walletAddress, signature, message } = body;

  if (!walletAddress || !signature || !message) {
    return void res.status(400).json({ error: "walletAddress, signature, and message are required" });
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return void res.status(400).json({ error: "Invalid Solana wallet address" });
  }

  // ── Parse and validate the signed message format ──────────────────────
  // Expected: "RocketFi:linkwallet:<walletAddress>:<nonce>"
  const parts = message.split(":");
  if (parts.length !== 4 || parts[0] !== "RocketFi" || parts[1] !== "linkwallet" ||
      parts[2] !== walletAddress) {
    return void res.status(400).json({ error: "Malformed signed message" });
  }
  const nonce = parts[3];

  // ── Atomically verify and consume the nonce ───────────────────────────
  const nonceEntry = walletLinkNonces.get(nonce);
  walletLinkNonces.delete(nonce); // single-use: delete before any further checks
  if (!nonceEntry || Date.now() > nonceEntry.expiresAt ||
      nonceEntry.profileAddress !== payload.sub ||
      nonceEntry.walletAddress  !== walletAddress) {
    return void res.status(401).json({ error: "Invalid, expired, or already-used challenge nonce" });
  }

  // ── Verify Ed25519 wallet signature over the message ──────────────────
  let pubKeyBytes: Uint8Array, sigBytes: Uint8Array;
  try {
    pubKeyBytes = bs58Decode(walletAddress);
    sigBytes    = bs58Decode(signature);
  } catch (e) {
    return void res.status(400).json({ error: `Invalid base58 encoding: ${(e as Error).message}` });
  }
  if (pubKeyBytes.length !== 32) {
    return void res.status(400).json({ error: "Invalid wallet address length" });
  }
  if (sigBytes.length !== 64) {
    return void res.status(400).json({ error: "Invalid signature length (expected 64 bytes)" });
  }
  const msgBytes = new TextEncoder().encode(message);
  if (!nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes)) {
    return void res.status(401).json({ error: "Wallet signature verification failed" });
  }

  // ── Ensure wallet isn't a primary address of another profile ──────────
  const byPrimary = await db
    .select({ address: profilesTable.address })
    .from(profilesTable)
    .where(eq(profilesTable.address, walletAddress))
    .limit(1);
  if (byPrimary.length > 0) {
    return void res.status(409).json({ error: "This wallet is already a primary account" });
  }

  // ── Persist the linked wallet ─────────────────────────────────────────
  let updated;
  try {
    updated = await db
      .update(profilesTable)
      .set({ linkedWallet: walletAddress, updatedAt: new Date() })
      .where(eq(profilesTable.address, payload.sub))
      .returning();
  } catch (err: unknown) {
    // Unique constraint violation — wallet is already linked to another social profile
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return void res.status(409).json({ error: "This wallet is already linked to another account" });
    }
    throw err;
  }

  if (!updated[0]) return void res.status(404).json({ error: "Profile not found" });
  return void res.json({ ok: true, profile: updated[0] });
});

// ── DELETE /api/auth/wallet/link ───────────────────────────────────────────
// Remove the linked wallet from the authenticated social user's profile.
// No wallet signature required — the JWT proves the user controls the social account.
// Requires: Authorization: Bearer <social-user JWT>

router.delete("/auth/wallet/link", async (req, res) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) return void res.status(401).json({ error: "No token" });

  const payload = verifyToken(token);
  if (!payload) return void res.status(401).json({ error: "Invalid or expired token" });
  if (payload.authType === "wallet") {
    return void res.status(400).json({ error: "Wallet-auth accounts do not need a linked wallet" });
  }

  const updated = await db
    .update(profilesTable)
    .set({ linkedWallet: null, updatedAt: new Date() })
    .where(eq(profilesTable.address, payload.sub))
    .returning();

  if (!updated[0]) return void res.status(404).json({ error: "Profile not found" });
  return void res.json({ ok: true, profile: updated[0] });
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────

router.post("/auth/logout", (_req, res) => {
  // JWT is stateless — client just drops the token. Nothing server-side to clear.
  return void res.json({ ok: true });
});

export default router;
