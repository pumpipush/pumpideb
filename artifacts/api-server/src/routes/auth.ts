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

// ── Short-lived merge nonces ───────────────────────────────────────────────
// Issued when a social user tries to link a wallet that is already a primary
// account. The nonce allows a subsequent merge call without re-signing.
interface WalletMergeNonce {
  socialAddress:  string;
  walletAddress:  string;
  expiresAt:      number;
}
const walletMergeNonces = new Map<string, WalletMergeNonce>();

// Prune wallet-link, wallet-login, and wallet-merge nonces periodically.
setInterval(() => {
  pruneWalletLoginNonces();
  const now = Date.now();
  for (const [key, entry] of walletLinkNonces) {
    if (now > entry.expiresAt) walletLinkNonces.delete(key);
  }
  for (const [key, entry] of walletMergeNonces) {
    if (now > entry.expiresAt) walletMergeNonces.delete(key);
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

/** Deterministic adjective+noun username from a wallet address — matches client generateUsername(). */
function generateWalletUsername(address: string): string {
  const ADJECTIVES = ["Swift","Neon","Cyber","Lunar","Solar","Cosmic","Dark","Hyper","Turbo","Iron","Laser","Void","Sonic","Alpha","Omega","Nova","Quantum","Pixel","Atomic","Prism","Shadow","Blazing","Golden","Silver","Stealth","Nitro","Rapid","Apex","Ultra","Infra"];
  const NOUNS = ["Ape","Doge","Wolf","Fox","Bear","Eagle","Shark","Tiger","Panda","Hawk","Bull","Lynx","Viper","Cobra","Raven","Drake","Sphinx","Phoenix","Dragon","Jaguar","Falcon","Rhino","Manta","Bison","Badger","Gecko","Mantis","Panther","Raptor","Titan"];
  const s1 = (parseInt(address.slice(2, 10), 16) || 0) >>> 0;
  const s2 = (parseInt(address.slice(-8), 16) || 0) >>> 0;
  const combined = (s1 ^ s2) >>> 0;
  const adj  = ADJECTIVES[combined % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(combined / ADJECTIVES.length) % NOUNS.length];
  const num  = (s1 % 90) + (s2 % 910);
  return `${adj}${noun}${num}`;
}

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
      return void res.status(401).json({ error: "invalid Google access_token", });
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
      return void res.status(401).json({ error: "invalid Google token", });
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

// ── POST /api/auth/email/send ─────────────────────────────────────────────
// Public — no auth required. Send a 6-digit OTP to the given email address
// so the user can sign in or create an account without a wallet.

router.post("/auth/email/send", authLimiter, asyncWrap(async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email || !email.includes("@")) {
    return void res.status(400).json({ error: "valid email required" });
  }
  const norm = email.toLowerCase().trim();

  // Max 3 sends per email per 15 minutes
  if (!checkRateLimit(otpSendLimiter, `login:${norm}`, 3, 15 * 60_000)) {
    return void res.status(429).json({ error: "Too many attempts. Please wait 15 minutes before requesting another code." });
  }

  const code = generateOTP(norm);
  await sendOTPEmail(norm, code);
  return void res.json({ ok: true });
}));

// ── POST /api/auth/email/verify ───────────────────────────────────────────
// Public — no auth required. Verify the OTP, then find-or-create a profile
// and return a JWT. Creates an email-auth profile if this is a new address.

router.post("/auth/email/verify", authLimiter, asyncWrap(async (req, res) => {
  const { email, code } = req.body as { email?: string; code?: string };
  if (!email || !code) return void res.status(400).json({ error: "email and code required" });
  const norm = email.toLowerCase().trim();

  // Brute-force guard: max 10 attempts per email per 15 minutes
  if (!checkRateLimit(otpVerifyLimiter, `login:${norm}`, 10, 15 * 60_000)) {
    return void res.status(429).json({ error: "Too many verification attempts. Please request a new code." });
  }

  const ok = verifyOTP(norm, code);
  if (!ok) return void res.status(401).json({ error: "Invalid or expired code" });

  // Find existing profile by email, or create a new one
  const existing = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.email, norm))
    .limit(1);

  let profile = existing[0];
  let isNewAccount = false;

  if (!profile) {
    isNewAccount   = true;
    const address  = randomUUID();
    const username = await uniqueUsername(norm.split("@")[0]);
    profile = (
      await db
        .insert(profilesTable)
        .values({ address, username, email: norm, authType: "email" })
        .returning()
    )[0];
  }

  const token = signToken({ sub: profile.address, authType: "email" });
  return void res.json({ token, profile, isNewAccount });
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
    return void res.status(401).json({ error: "invalid Google access_token", });
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

  // Return only the fields needed by the client.
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
  // Keep message short — the full wallet address added ~44 chars but is redundant:
  // the nonce alone is enough for the server to look up which wallet it belongs to.
  const message = `Pumpi:login:${nonce}`;
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

  // Validate message format: "Pumpi:login:<nonce>"
  const parts = message.split(":");
  if (parts.length !== 3 || parts[0] !== "Pumpi" || parts[1] !== "login") {
    return void res.status(400).json({ error: "Malformed challenge message" });
  }
  const nonce = parts[2];

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

  // ── Find or create the wallet profile ────────────────────────────────────
  //
  // Priority order:
  //   1. Direct wallet-primary row (address = walletAddress, authType = 'wallet')
  //   2. Social profile that has this wallet linked (linkedWallet = walletAddress)
  //      This handles the post-merge case: the wallet-primary row was deleted by the
  //      cleanup migration but the user's identity now lives under the social row.
  //      Returning a token for the social profile prevents a duplicate row being
  //      silently re-created on the next wallet login.
  //   3. Create a new wallet-primary row (first-ever login with this wallet)

  let profile = (await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.address, walletAddress))
    .limit(1))[0];

  if (!profile) {
    // Check whether this wallet is already linked to a social profile (post-merge).
    profile = (await db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.linkedWallet, walletAddress))
      .limit(1))[0];
  }

  if (!profile) {
    // First-ever login — create a fresh wallet-primary row.
    // uniqueUsername does a DB-checked search with 10 retries + full-UUID fallback,
    // so the chosen name is free at the time of the check.  The only remaining
    // constraint that can fire on the INSERT is the address PK (handled below).
    const username = await uniqueUsername(generateWalletUsername(walletAddress));
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

  // Issue the JWT for the resolved profile (may be social authType if post-merge).
  const resolvedAuthType = (profile.authType ?? "wallet") as "wallet" | "google" | "email";
  const token = signToken({ sub: profile.address, authType: resolvedAuthType });
  return void res.json({
    token,
    // Include authType so the client can set socialUser.authType correctly even for
    // post-merge profiles where the resolved row has authType 'google' or 'email'.
    authType: resolvedAuthType,
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

  return void res.json({ nonce, message: `Pumpi:linkwallet:${walletAddress}:${nonce}` });
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
  // Expected: "Pumpi:linkwallet:<walletAddress>:<nonce>"
  const parts = message.split(":");
  if (parts.length !== 4 || parts[0] !== "Pumpi" || parts[1] !== "linkwallet" ||
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
  // If it is, issue a short-lived merge nonce so the client can offer a
  // one-click "merge accounts" flow without asking the user to sign again.
  const byPrimary = await db
    .select({ address: profilesTable.address })
    .from(profilesTable)
    .where(eq(profilesTable.address, walletAddress))
    .limit(1);
  if (byPrimary.length > 0) {
    const mergeNonce = randomUUID();
    walletMergeNonces.set(mergeNonce, {
      socialAddress: payload.sub,
      walletAddress,
      expiresAt: Date.now() + 5 * 60_000, // 5 minutes
    });
    return void res.status(409).json({
      error: "wallet_is_primary_account",
      mergeNonce,
    });
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

// ── POST /api/auth/wallet/merge ───────────────────────────────────────────
// Merge a wallet-primary profile into the authenticated social profile.
// Used when the user tries to link a wallet that already has its own primary row.
// Requires: Authorization: Bearer <social-user JWT>
// Body: { mergeNonce: string }
// The nonce proves prior wallet-ownership verification (issued by POST /auth/wallet/link).

router.post("/auth/wallet/merge", asyncWrap(async (req, res) => {
  const token = extractBearer(req.headers.authorization);
  if (!token) return void res.status(401).json({ error: "No token" });

  const payload = verifyToken(token);
  if (!payload) return void res.status(401).json({ error: "Invalid or expired token" });
  if (payload.authType === "wallet") {
    return void res.status(400).json({ error: "Wallet-auth accounts cannot merge this way" });
  }

  const { mergeNonce } = req.body as { mergeNonce?: string };
  if (!mergeNonce) return void res.status(400).json({ error: "mergeNonce is required" });

  const entry = walletMergeNonces.get(mergeNonce);
  walletMergeNonces.delete(mergeNonce); // single-use
  if (!entry || Date.now() > entry.expiresAt || entry.socialAddress !== payload.sub) {
    return void res.status(401).json({ error: "Invalid or expired merge token — please try again" });
  }

  const { socialAddress, walletAddress } = entry;

  // Load both profiles
  const [socialProfile, walletProfile] = await Promise.all([
    db.select().from(profilesTable).where(eq(profilesTable.address, socialAddress)).limit(1).then(r => r[0]),
    db.select().from(profilesTable).where(eq(profilesTable.address, walletAddress)).limit(1).then(r => r[0]),
  ]);
  if (!socialProfile) return void res.status(404).json({ error: "Social profile not found" });
  if (!walletProfile) return void res.status(404).json({ error: "Wallet profile not found" });

  // Merge: link the wallet to the social profile, delete the wallet-primary row.
  // Trades and tokens are stored by raw wallet address, so they remain accessible
  // once linkedWallet is set on the social profile — no row rewriting needed.
  // Prefer the social profile's username/bio; fall back to wallet profile's if blank.
  const mergedUsername = (socialProfile.username && !socialProfile.username.startsWith("user_"))
    ? socialProfile.username
    : (walletProfile.username && !walletProfile.username.startsWith("user_"))
      ? walletProfile.username
      : socialProfile.username;
  const mergedBio     = socialProfile.bio     || walletProfile.bio     || null;
  const mergedAvatar  = socialProfile.avatarUrl || walletProfile.avatarUrl || null;

  const [updated] = await db
    .update(profilesTable)
    .set({ linkedWallet: walletAddress, username: mergedUsername, bio: mergedBio, avatarUrl: mergedAvatar, updatedAt: new Date() })
    .where(eq(profilesTable.address, socialAddress))
    .returning();

  // Delete the wallet-primary row — its identity now lives under the social profile.
  await db.delete(profilesTable).where(eq(profilesTable.address, walletAddress));

  return void res.json({ ok: true, profile: updated });
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
