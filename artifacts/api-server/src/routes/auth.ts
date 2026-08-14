/**
 * auth.ts — social & email authentication endpoints.
 *
 * POST /api/auth/google               Verify Google ID token → create/find profile → return JWT
 * POST /api/auth/email/send           Send 6-digit OTP to email
 * POST /api/auth/email/verify         Verify OTP → create/find profile → return JWT
 * POST /api/auth/link/email/send      (wallet-auth only) Send OTP to email to link it
 * POST /api/auth/link/email/verify    (wallet-auth only) Verify OTP and save email to profile
 * POST /api/auth/link/google          (wallet-auth only) Link Google account to wallet profile
 * GET  /api/auth/me                   Return profile from JWT (Authorization: Bearer <token>)
 * POST /api/auth/logout               Client-side logout hint (clears server-side nonce if any)
 */

import { Router } from "express";
import { authLimiter } from "../lib/rateLimiters.js";
import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "crypto";
import { eq, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { profilesTable } from "@workspace/db/schema";
import { signToken, verifyToken, extractBearer } from "../lib/auth-jwt";
import { generateOTP, verifyOTP, sendOTPEmail } from "../lib/email-otp";
import nacl from "tweetnacl";
import { asyncWrap } from "../lib/asyncHandler.js";

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

// ── Bounded wallet-login nonce store ─────────────────────────────────────
// Each unauthenticated GET /auth/wallet/login/challenge is a public endpoint.
// To prevent heap exhaustion from distributed callers we:
//   1. Keep at most MAX_WALLET_LOGIN_CHALLENGES entries globally.
//   2. Allow only ONE outstanding challenge per wallet address; issuing a new
//      challenge for the same wallet atomically revokes the old one.
//   3. Prune expired entries before enforcing the global cap.

const MAX_WALLET_LOGIN_CHALLENGES = 10_000;
const WALLET_LOGIN_NONCE_TTL_MS   = 5 * 60_000; // 5 minutes

interface WalletLoginNonce {
  walletAddress: string;
  expiresAt:     number; // ms epoch
}
// nonce → { walletAddress, expiresAt }
const walletLoginNonces = new Map<string, WalletLoginNonce>();
// walletAddress → current outstanding nonce (per-wallet deduplication)
const walletLoginByAddress = new Map<string, string>();

function pruneWalletLoginNonces(): void {
  const now = Date.now();
  for (const [nonce, entry] of walletLoginNonces) {
    if (now > entry.expiresAt) {
      walletLoginNonces.delete(nonce);
      walletLoginByAddress.delete(entry.walletAddress);
    }
  }
}

/**
 * Issue a new login challenge for `walletAddress`.
 * Returns null when the global cap is still exceeded after pruning.
 */
function issueWalletLoginChallenge(walletAddress: string): string | null {
  // Atomically revoke any existing challenge for this wallet (per-wallet dedup)
  const prev = walletLoginByAddress.get(walletAddress);
  if (prev) {
    walletLoginNonces.delete(prev);
    walletLoginByAddress.delete(walletAddress);
  }

  // Prune expired entries, then enforce global cap
  pruneWalletLoginNonces();
  if (walletLoginNonces.size >= MAX_WALLET_LOGIN_CHALLENGES) return null;

  const nonce = randomUUID();
  const expiresAt = Date.now() + WALLET_LOGIN_NONCE_TTL_MS;
  walletLoginNonces.set(nonce, { walletAddress, expiresAt });
  walletLoginByAddress.set(walletAddress, nonce);
  return nonce;
}

/**
 * Atomically consume a wallet-login nonce.
 * Returns the walletAddress it was bound to, or null if invalid/expired/used.
 */
function consumeWalletLoginNonce(nonce: string): string | null {
  const entry = walletLoginNonces.get(nonce);
  walletLoginNonces.delete(nonce);
  if (entry) walletLoginByAddress.delete(entry.walletAddress);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.walletAddress;
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

// Prune wallet-link and wallet-login nonces periodically.
setInterval(() => {
  pruneWalletLoginNonces();
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
  // Full UUID fallback — 128 bits of entropy makes collision essentially impossible
  return `user_${randomUUID().replace(/-/g, "")}`;
}

// ── POST /api/auth/google ──────────────────────────────────────────────────
// Accepts either:
//   { access_token }  — from @react-oauth/google useGoogleLogin implicit flow
//   { credential }    — Google ID token (legacy GSI / future use)

router.post("/auth/google", asyncWrap(async (req, res) => {
  const { credential, access_token } = req.body as { credential?: string; access_token?: string };
  if (!credential && !access_token) {
    return void res.status(400).json({ error: "credential or access_token required" });
  }

  let googleId: string, email: string, name: string, picture: string, emailVerified: boolean;

  if (access_token) {
    // Verify via Google's userinfo endpoint — no client secret needed on the server
    let info: Record<string, unknown>;
    try {
      const r = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!r.ok) throw new Error(`Google userinfo ${r.status}`);
      info = await r.json() as Record<string, unknown>;
    } catch (err: unknown) {
      return void res.status(401).json({ error: "invalid Google access_token", detail: String(err) });
    }
    googleId      = String(info.sub ?? "");
    // Always normalise to lowercase — OTP-registered emails are stored lowercase;
    // without this, a capitalisation difference from Google would bypass the byEmail
    // merge and silently create a duplicate account.
    email         = (String(info.email ?? "")).toLowerCase();
    name          = String(info.name  ?? "") || email.split("@")[0] || "user";
    picture       = String(info.picture ?? "");
    // Only use the email for merging if Google has confirmed ownership.
    emailVerified = info.email_verified === true || info.email_verified === "true";
    if (!googleId) return void res.status(401).json({ error: "could not retrieve Google user ID" });
  } else {
    // Legacy: verify ID token
    if (!GOOGLE_CLIENT_ID) return void res.status(503).json({ error: "Google auth not configured" });
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential!,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload) throw new Error("empty payload");
      googleId      = payload.sub;
      // Same lowercase normalisation for the ID-token path.
      email         = (payload.email ?? "").toLowerCase();
      name          = payload.name  ?? email.split("@")[0] ?? "user";
      picture       = payload.picture ?? "";
      emailVerified = payload.email_verified ?? false;
    } catch (err: unknown) {
      return void res.status(401).json({ error: "invalid Google token", detail: String(err) });
    }
  }

  // Find or create profile
  const existing = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.googleId, googleId))
    .limit(1);

  let profile = existing[0];
  // Track outcome so the client can surface appropriate messaging:
  //   isNewAccount — brand-new profile was created
  //   wasLinked    — an existing email-OTP profile was merged with this Google account
  //                  for the first time (won't fire on subsequent Google sign-ins)
  let isNewAccount = false;
  let wasLinked    = false;

  if (!profile) {
    // Also check by email in case user signed up via email first.
    // We only trust the email for merging when Google has verified it (emailVerified),
    // otherwise an attacker who controls an unverified Google address could hijack
    // an existing account.
    const byEmail = (email && emailVerified)
      ? await db.select().from(profilesTable).where(eq(profilesTable.email, email)).limit(1)
      : [];

    if (byEmail[0]) {
      // Link Google to existing email profile — preserve the existing avatar.
      profile = (
        await db
          .update(profilesTable)
          .set({ googleId, avatarUrl: byEmail[0].avatarUrl || picture || null })
          .where(eq(profilesTable.address, byEmail[0].address))
          .returning()
      )[0];
      wasLinked = true;
    } else {
      // Create new profile
      isNewAccount   = true;
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
  return void res.json({ token, profile, isNewAccount, wasLinked });
}));

// ── POST /api/auth/email/send ──────────────────────────────────────────────

router.post("/auth/email/send", authLimiter, asyncWrap(async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email || !email.includes("@")) {
    return void res.status(400).json({ error: "valid email required" });
  }
  // Max 3 sends per email per 15 minutes
  if (!checkRateLimit(otpSendLimiter, email.toLowerCase(), 3, 15 * 60_000)) {
    return void res.status(429).json({ error: "Too many attempts. Please wait 15 minutes before requesting another code." });
  }
  const code = generateOTP(email.toLowerCase());
  await sendOTPEmail(email.toLowerCase(), code);
  return void res.json({ ok: true });
}));

// ── POST /api/auth/email/verify ────────────────────────────────────────────

router.post("/auth/email/verify", authLimiter, asyncWrap(async (req, res) => {
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
}));

// ── POST /api/auth/link/email/send ────────────────────────────────────────
// Wallet-only users can add an email address by sending an OTP.
// Requires: Authorization: Bearer <wallet-auth JWT>

router.post("/auth/link/email/send", authLimiter, asyncWrap(async (req, res) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) return void res.status(401).json({ error: "No token" });

  const payload = verifyToken(token);
  if (!payload) return void res.status(401).json({ error: "Invalid or expired token" });
  if (payload.authType !== "wallet") {
    return void res.status(400).json({ error: "Only wallet-auth accounts can link an email this way" });
  }

  const { email } = req.body as { email?: string };
  if (!email || !email.includes("@")) {
    return void res.status(400).json({ error: "valid email required" });
  }

  // Check email isn't already registered to another profile
  const taken = await db
    .select({ address: profilesTable.address })
    .from(profilesTable)
    .where(eq(profilesTable.email, email.toLowerCase()))
    .limit(1);
  if (taken.length > 0 && taken[0].address !== payload.sub) {
    return void res.status(409).json({ error: "That email is already associated with another account" });
  }

  // Max 3 sends per email per 15 minutes (reuse same limiter as registration flow)
  if (!checkRateLimit(otpSendLimiter, `link:${email.toLowerCase()}`, 3, 15 * 60_000)) {
    return void res.status(429).json({ error: "Too many attempts. Please wait 15 minutes before requesting another code." });
  }

  const code = generateOTP(email.toLowerCase());
  await sendOTPEmail(email.toLowerCase(), code);
  return void res.json({ ok: true });
}));

// ── POST /api/auth/link/email/verify ──────────────────────────────────────
// Verify OTP and save the email to the authenticated wallet user's profile.
// Requires: Authorization: Bearer <wallet-auth JWT>

router.post("/auth/link/email/verify", authLimiter, asyncWrap(async (req, res) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) return void res.status(401).json({ error: "No token" });

  const payload = verifyToken(token);
  if (!payload) return void res.status(401).json({ error: "Invalid or expired token" });
  if (payload.authType !== "wallet") {
    return void res.status(400).json({ error: "Only wallet-auth accounts can link an email this way" });
  }

  const { email, code } = req.body as { email?: string; code?: string };
  if (!email || !code) return void res.status(400).json({ error: "email and code required" });

  // Brute-force guard: max 10 attempts per email per 15 minutes
  if (!checkRateLimit(otpVerifyLimiter, `link:${email.toLowerCase()}`, 10, 15 * 60_000)) {
    return void res.status(429).json({ error: "Too many verification attempts. Please request a new code." });
  }

  const ok = verifyOTP(email.toLowerCase(), code);
  if (!ok) return void res.status(401).json({ error: "Invalid or expired code" });

  // Re-check uniqueness at verify time (race-condition safety)
  const taken = await db
    .select({ address: profilesTable.address })
    .from(profilesTable)
    .where(eq(profilesTable.email, email.toLowerCase()))
    .limit(1);
  if (taken.length > 0 && taken[0].address !== payload.sub) {
    return void res.status(409).json({ error: "That email is already associated with another account" });
  }

  let updated;
  try {
    updated = await db
      .update(profilesTable)
      .set({ email: email.toLowerCase(), updatedAt: new Date() })
      .where(eq(profilesTable.address, payload.sub))
      .returning();
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return void res.status(409).json({ error: "That email is already associated with another account" });
    }
    throw err;
  }

  if (!updated[0]) return void res.status(404).json({ error: "Profile not found" });
  return void res.json({ ok: true, profile: updated[0] });
}));

// ── POST /api/auth/link/google ─────────────────────────────────────────────
// Link a Google account to the authenticated wallet user's profile.
// Accepts { access_token } from @react-oauth/google implicit flow.
// Requires: Authorization: Bearer <wallet-auth JWT>

router.post("/auth/link/google", asyncWrap(async (req, res) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) return void res.status(401).json({ error: "No token" });

  const payload = verifyToken(token);
  if (!payload) return void res.status(401).json({ error: "Invalid or expired token" });
  if (payload.authType !== "wallet") {
    return void res.status(400).json({ error: "Only wallet-auth accounts can link a Google account this way" });
  }

  const { access_token } = req.body as { access_token?: string };
  if (!access_token) {
    return void res.status(400).json({ error: "access_token required" });
  }

  // Verify via Google's userinfo endpoint
  let googleId: string, email: string, picture: string, emailVerified: boolean;
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!r.ok) throw new Error(`Google userinfo ${r.status}`);
    const info = await r.json() as Record<string, unknown>;
    googleId      = String(info.sub ?? "");
    email         = (String(info.email ?? "")).toLowerCase();
    picture       = String(info.picture ?? "");
    emailVerified = info.email_verified === true || info.email_verified === "true";
    if (!googleId) throw new Error("no sub in userinfo");
  } catch (err: unknown) {
    return void res.status(401).json({ error: "invalid Google access_token", detail: String(err) });
  }

  // Ensure neither googleId nor email is already taken by a different profile
  const conditions = [eq(profilesTable.googleId, googleId)];
  if (email && emailVerified) conditions.push(eq(profilesTable.email, email));

  const conflicts = await db
    .select({ address: profilesTable.address })
    .from(profilesTable)
    .where(or(...conditions))
    .limit(1);

  if (conflicts.length > 0 && conflicts[0].address !== payload.sub) {
    return void res.status(409).json({ error: "That Google account is already associated with another profile" });
  }

  let updated;
  try {
    updated = await db
      .update(profilesTable)
      .set({
        googleId,
        email: (email && emailVerified) ? email : undefined,
        avatarUrl: picture || undefined,
        updatedAt: new Date(),
      })
      .where(eq(profilesTable.address, payload.sub))
      .returning();
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return void res.status(409).json({ error: "That Google account or email is already associated with another profile" });
    }
    throw err;
  }

  if (!updated[0]) return void res.status(404).json({ error: "Profile not found" });
  return void res.json({ ok: true, profile: updated[0] });
}));

// ── GET /api/auth/me ───────────────────────────────────────────────────────

router.get("/auth/me", asyncWrap(async (req, res) => {
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

  // Return only safe serializable fields — solBalanceLamports is a BigInt
  // and cannot be passed through Express's default JSON serializer.
  const p = profiles[0];
  return void res.json({
    profile: {
      address:      p.address,
      username:     p.username,
      avatarUrl:    p.avatarUrl    ?? null,
      email:        p.email        ?? null,
      linkedWallet: p.linkedWallet ?? null,
    },
    authType: payload.authType,
  });
}));

// ── GET /api/auth/wallet/login/challenge ──────────────────────────────────
// Issue a one-time challenge message for a wallet-only login.
// No prior JWT required — this is how wallet-only users get their first JWT.
// Query: ?wallet=<base58 Solana address>

router.get("/auth/wallet/login/challenge", authLimiter, asyncWrap(async (req, res) => {
  const walletAddress = typeof req.query.wallet === "string" ? req.query.wallet.trim() : "";
  if (!walletAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return void res.status(400).json({ error: "wallet query param must be a valid Solana address" });
  }
  const nonce = issueWalletLoginChallenge(walletAddress);
  if (!nonce) {
    // Global cap reached — caller should retry after a moment
    return void res.status(503).json({ error: "Server busy, please retry" });
  }
  const message = `RocketFi:login:${walletAddress}:${nonce}`;
  return void res.json({ nonce, message });
}));

// ── POST /api/auth/wallet/login ────────────────────────────────────────────
// Verify an Ed25519 wallet signature over the login challenge,
// then find-or-create a profile and issue a JWT.
// Body: { walletAddress, signature, message }

router.post("/auth/wallet/login", authLimiter, asyncWrap(async (req, res) => {
  const body = req.body as { walletAddress?: string; signature?: string; message?: string };
  const { walletAddress, signature, message } = body;

  if (!walletAddress || !signature || !message) {
    return void res.status(400).json({ error: "walletAddress, signature, and message are required" });
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return void res.status(400).json({ error: "Invalid Solana wallet address" });
  }

  // Validate message format: "RocketFi:login:<walletAddress>:<nonce>"
  const parts = message.split(":");
  if (parts.length !== 4 || parts[0] !== "RocketFi" || parts[1] !== "login" || parts[2] !== walletAddress) {
    return void res.status(400).json({ error: "Malformed challenge message" });
  }
  const nonce = parts[3];

  // Atomically consume the nonce — single-use guarantee
  const boundAddress = consumeWalletLoginNonce(nonce);
  if (!boundAddress || boundAddress !== walletAddress) {
    return void res.status(401).json({ error: "Invalid, expired, or already-used challenge nonce" });
  }

  // Verify Ed25519 signature
  let pubKeyBytes: Uint8Array, sigBytes: Uint8Array;
  try {
    pubKeyBytes = bs58Decode(walletAddress);
    sigBytes    = bs58Decode(signature);
  } catch (e) {
    return void res.status(400).json({ error: `Invalid base58: ${(e as Error).message}` });
  }
  if (pubKeyBytes.length !== 32 || sigBytes.length !== 64) {
    return void res.status(400).json({ error: "Invalid key or signature length" });
  }
  const msgBytes = new TextEncoder().encode(message);
  if (!nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes)) {
    return void res.status(401).json({ error: "Wallet signature verification failed" });
  }

  // Find or create the wallet profile
  let profile = (await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.address, walletAddress))
    .limit(1))[0];

  if (!profile) {
    // uniqueUsername does a DB-checked search with 10 retries + full-UUID fallback,
    // so the chosen name is free at the time of the check.  The only remaining
    // constraint that can fire on the INSERT is the address PK (handled below).
    const username = await uniqueUsername(`wallet_${walletAddress.slice(0, 6)}`);
    const rows = await db
      .insert(profilesTable)
      .values({ address: walletAddress, username, authType: "wallet" })
      .onConflictDoNothing()   // address PK race — another request created it first
      .returning();
    profile = rows[0];
    // Address PK race: re-select to find the row created by the concurrent request
    if (!profile) {
      profile = (await db
        .select()
        .from(profilesTable)
        .where(eq(profilesTable.address, walletAddress))
        .limit(1))[0];
    }
  }

  if (!profile) {
    return void res.status(500).json({ error: "Failed to find or create profile" });
  }

  const token = signToken({ sub: walletAddress, authType: "wallet" });
  return void res.json({
    token,
    profile: {
      address:      profile.address,
      username:     profile.username,
      avatarUrl:    profile.avatarUrl    ?? null,
      email:        profile.email        ?? null,
      linkedWallet: profile.linkedWallet ?? null,
    },
  });
}));

// ── GET /api/auth/wallet/link/challenge ────────────────────────────────────
// Issue a single-use nonce the client must sign with the target wallet before
// calling POST /api/auth/wallet/link.
// Query: ?wallet=<base58 Solana address>
// Requires: Authorization: Bearer <social-user JWT>

router.get("/auth/wallet/link/challenge", asyncWrap(async (req, res) => {
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
}));

// ── POST /api/auth/wallet/link ─────────────────────────────────────────────
// Link a Solana wallet to the authenticated social user's profile.
// Requires proof of ownership: a server-issued nonce signed by the wallet.
// Body: { walletAddress, signature, message }
// Requires: Authorization: Bearer <social-user JWT>

router.post("/auth/wallet/link", asyncWrap(async (req, res) => {
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
}));

// ── DELETE /api/auth/wallet/link ───────────────────────────────────────────
// Remove the linked wallet from the authenticated social user's profile.
// No wallet signature required — the JWT proves the user controls the social account.
// Requires: Authorization: Bearer <social-user JWT>

router.delete("/auth/wallet/link", asyncWrap(async (req, res) => {
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
}));

// ── POST /api/auth/logout ──────────────────────────────────────────────────

router.post("/auth/logout", (_req, res) => {
  // JWT is stateless — client just drops the token. Nothing server-side to clear.
  return void res.json({ ok: true });
});

export default router;
