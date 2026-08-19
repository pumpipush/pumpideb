/**
 * profiles.ts — Profile CRUD routes.
 *
 * Auth model:
 *   POST  /profiles        — Create a profile. Requires a wallet signature proving
 *                            the caller owns the wallet address. Address is derived
 *                            from the verified signer, not from the request body.
 *                            Uses INSERT ... ON CONFLICT (address) DO NOTHING to
 *                            atomically handle concurrent creation (fixes TOCTOU race).
 *
 *   PATCH /profiles/:address — Update a profile. Requires a wallet signature proving
 *                            the caller owns :address. Implemented as an upsert so
 *                            the first authenticated edit also creates the profile.
 *                            The DB target comes from the verified walletAddress, not
 *                            from the route param (though both must match after verify).
 *
 *   GET   /profiles/:address — Public, no auth.
 *
 * Signature convention (identical to token auth):
 *   message   = "Pumpi:{action}:{walletAddress}:{unixSeconds}"
 *   signature = base58-encoded 64-byte Ed25519 signature over UTF-8 message bytes
 *   The timestamp must be within ±5 minutes of server time (replay protection).
 */

import { Router, type IRouter } from "express";
import { eq, or, and, sql } from "drizzle-orm";
import { db, profilesTable, followsTable } from "@workspace/db";
import {
  GetProfileParams,
  GetProfileResponse,
  CreateProfileBody,
  CreateProfileResponse,
  UpdateProfileParams,
  UpdateProfileBody,
  UpdateProfileResponse,
} from "@workspace/api-zod";
import {
  parseWalletAuthFields,
  issueNonce,
  verifyWalletSignatureWithNonce,
} from "../lib/wallet-auth.js";
import { extractBearer, verifyToken } from "../lib/auth-jwt.js";
import { asyncWrap } from "../lib/asyncHandler.js";

const router: IRouter = Router();

// ── POST /profiles/challenge ───────────────────────────────────────────────────
// Issue a single-use nonce that the client must include in the message it signs.
// Binds the nonce to one (action, address) pair and a 5-minute expiry window.

router.post("/profiles/challenge", (req, res): void => {
  const body = req.body as { action?: unknown; address?: unknown };
  const action = body.action;
  const address = body.address;

  // Validate address as a canonical Solana base58 public key (32–44 base58 chars).
  // Strict validation prevents multi-MB strings from ever entering the nonce store.
  const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (
    (action !== "create" && action !== "update" && action !== "follow") ||
    typeof address !== "string" ||
    !SOLANA_ADDRESS_RE.test(address)
  ) {
    res.status(400).json({
      error: "Required: action ('create'|'update'|'follow') and a valid Solana base58 address (32–44 chars)",
    });
    return;
  }

  const nonce = issueNonce(action as "create" | "update" | "follow", address);
  if (!nonce) {
    res.status(429).json({ error: "Challenge store is at capacity — please try again in a moment." });
    return;
  }
  res.json({ nonce });
});

// ── GET /profiles/:identifier ─────────────────────────────────────────────────
// Public — no auth required.
// :identifier can be a wallet address (32–44 base58 chars) OR a username.
// Address lookup is exact; username lookup is case-insensitive.

router.get("/profiles/:address", asyncWrap(async (req, res) => {
  const identifier = String(req.params.address ?? "").trim();
  if (!identifier) {
    res.status(400).json({ error: "Missing identifier" });
    return;
  }

  // Solana addresses: base58, always 32-44 characters (no hyphens).
  // Social user addresses: UUID format (lowercase hex with hyphens).
  // Usernames: everything else.
  const looksLikeAddress =
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(identifier) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

  const [profile] = await db
    .select()
    .from(profilesTable)
    .where(
      looksLikeAddress
        ? eq(profilesTable.address, identifier)
        : or(
            eq(profilesTable.username, identifier),
            eq(profilesTable.username, identifier.toLowerCase()),
          )
    )
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
}));

// ── POST /profiles ─────────────────────────────────────────────────────────────
// Create a profile for the signing wallet.
//
// Required body fields: walletAddress, signature, message  (wallet auth)
// Optional body fields: username, bio, avatarUrl, twitterHandle, websiteUrl
//
// address is always derived from the verified walletAddress — any "address" field
// in the body is ignored and overwritten before schema validation.

router.post("/profiles", asyncWrap(async (req, res) => {
  // 1. Require wallet authentication
  const authFields = parseWalletAuthFields(req.body);
  if (!authFields) {
    res.status(401).json({
      error: "Missing wallet authentication fields (walletAddress, signature, message)",
    });
    return;
  }

  const { walletAddress, signature, message } = authFields;

  // 2. Verify signature (nonce-based — single-use, prevents replay)
  try {
    verifyWalletSignatureWithNonce({ walletAddress, signature, message }, "create", walletAddress);
  } catch (err) {
    res.status(401).json({ error: `Wallet signature invalid: ${(err as Error).message}` });
    return;
  }

  // 3. Parse body — inject server-derived address so schema validation passes;
  //    any client-supplied "address" is silently overwritten.
  const parsed = CreateProfileBody.safeParse({ ...req.body, address: walletAddress });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { username, ...rest } = parsed.data;
  // Drop address from rest (it's in parsed.data but we use walletAddress directly)
  const { address: _ignored, ...profileFields } = rest;

  const resolvedUsername = username ?? `user_${walletAddress.slice(-6).toLowerCase()}`;

  // 4. Atomic insert — ON CONFLICT (address) DO NOTHING eliminates the TOCTOU race.
  //    Specifying the target column ensures only address conflicts are silently skipped;
  //    a username uniqueness violation still surfaces as a 23505 → 409 response.
  //    Without the target, any unique violation (including on username) would be
  //    silently swallowed, returning the wrong existing profile as 200.
  let inserted: typeof profilesTable.$inferSelect | undefined;
  try {
    [inserted] = await db
      .insert(profilesTable)
      .values({ address: walletAddress, username: resolvedUsername, ...profileFields })
      .onConflictDoNothing({ target: profilesTable.address })
      .returning();
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "Username is already taken" });
      return;
    }
    throw err;
  }

  // 5. If the insert was skipped (profile already existed), fetch the existing row.
  const profile = inserted ?? (
    await db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.address, walletAddress))
      .limit(1)
  )[0];

  if (!profile) {
    // Should never happen, but fail safely
    res.status(500).json({ error: "Profile not found after insert" });
    return;
  }

  const response = CreateProfileResponse.safeParse(profile);
  if (!response.success) {
    res.status(500).json({ error: "Response parse error" });
    return;
  }

  res.status(inserted ? 201 : 200).json(response.data);
}));

// ── PATCH /profiles/:address ───────────────────────────────────────────────────
// Update (or create on first edit) the profile for the signing wallet.
//
// Required body fields: walletAddress, signature, message  (wallet auth)
// Optional body fields: username, bio, avatarUrl, twitterHandle, websiteUrl
//
// The verified walletAddress must equal :address — callers cannot edit another
// user's profile even if they know the address.
//
// Implemented as an upsert so the first authenticated PATCH also creates the
// profile row, removing the need for a separate profile-creation step.

router.patch("/profiles/:address", asyncWrap(async (req, res) => {
  // 1. Parse and validate route param
  const paramsParsed = UpdateProfileParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  const { address } = paramsParsed.data;

  // ── Auth path A: JWT Bearer token (social/email users) ──────────────────────
  const bearerToken = extractBearer(req.headers.authorization);
  if (bearerToken) {
    const payload = verifyToken(bearerToken);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    if (payload.sub !== address) {
      res.status(403).json({ error: "Token does not match profile address" });
      return;
    }

    const bodyParsed = UpdateProfileBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.message });
      return;
    }

    const updateData = bodyParsed.data;
    const resolvedUsername = updateData.username ?? `user_${address.slice(-6).toLowerCase()}`;

    let updated: typeof profilesTable.$inferSelect | undefined;
    try {
      [updated] = await db
        .insert(profilesTable)
        .values({ address, username: resolvedUsername, ...updateData })
        .onConflictDoUpdate({
          target: profilesTable.address,
          set: { ...updateData, updatedAt: new Date() },
        })
        .returning();
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "Username is already taken" });
        return;
      }
      throw err;
    }

    if (!updated) { res.status(500).json({ error: "Profile update failed" }); return; }
    const jwtResponse = UpdateProfileResponse.safeParse(updated);
    if (!jwtResponse.success) { res.status(500).json({ error: "Response parse error" }); return; }
    res.json(jwtResponse.data);
    return;
  }

  // ── Auth path B: Wallet signature (on-chain wallet users) ───────────────────

  // 2. Require wallet authentication
  const authFields = parseWalletAuthFields(req.body);
  if (!authFields) {
    res.status(401).json({
      error: "Missing wallet authentication fields (walletAddress, signature, message)",
    });
    return;
  }

  const { walletAddress, signature, message } = authFields;

  // 3. Verify the signature covers this exact profile address (nonce-based — single-use)
  try {
    verifyWalletSignatureWithNonce({ walletAddress, signature, message }, "update", address);
  } catch (err) {
    res.status(401).json({ error: `Wallet signature invalid: ${(err as Error).message}` });
    return;
  }

  // 4. The signer must be the profile owner — prevents editing another wallet's profile
  if (walletAddress !== address) {
    res.status(403).json({
      error: "Wallet address does not match the profile address — you can only edit your own profile",
    });
    return;
  }

  // 5. Parse body (auth fields pass through the schema as unknown extra keys are ignored)
  const bodyParsed = UpdateProfileBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: bodyParsed.error.message });
    return;
  }

  const updateData = bodyParsed.data;
  const resolvedUsername = updateData.username ?? `user_${walletAddress.slice(-6).toLowerCase()}`;

  // 6. Upsert — INSERT if no profile exists yet, otherwise UPDATE in place.
  //    The DB target address comes from the verified walletAddress (not the route
  //    param), so even if a buggy client sends a mismatched URL the write lands
  //    on the signer's own row.
  //    The unique constraint on username produces a 23505 error when another
  //    profile already owns the requested handle — surface that as a 409.
  let updated: typeof profilesTable.$inferSelect | undefined;
  try {
    [updated] = await db
      .insert(profilesTable)
      .values({ address: walletAddress, username: resolvedUsername, ...updateData })
      .onConflictDoUpdate({
        target: profilesTable.address,
        set: { ...updateData, updatedAt: new Date() },
      })
      .returning();
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "Username is already taken" });
      return;
    }
    throw err;
  }

  if (!updated) {
    res.status(500).json({ error: "Profile update failed" });
    return;
  }

  const response = UpdateProfileResponse.safeParse(updated);
  if (!response.success) {
    res.status(500).json({ error: "Response parse error" });
    return;
  }

  res.json(response.data);
}));

// ── Follow auth helper ────────────────────────────────────────────────────────
// Resolves the caller's profile address from either:
//   A) JWT Bearer token  (social / email users) — Authorization: Bearer <token>
//   B) Wallet signature in body  (wallet-only users) — { walletAddress, signature, message }
//      message must be "Pumpi:follow:<walletAddress>:<nonce>" with a valid server-issued nonce
// Returns the verified caller address, or null if no valid auth found.
// Throws a string error message when auth is present but invalid (caller should 401).
function resolveFollowCaller(authHeader: string | undefined, body: unknown): string | null {
  // Path A: JWT Bearer token
  if (authHeader) {
    const bearer = extractBearer(authHeader);
    if (bearer) {
      const payload = verifyToken(bearer);
      return payload ? payload.sub : null;
    }
  }

  // Path B: Wallet signature in request body
  const fields = parseWalletAuthFields(body);
  if (fields) {
    // verifyWalletSignatureWithNonce throws on any failure — let it bubble so
    // the caller can surface a descriptive 401.
    verifyWalletSignatureWithNonce(fields, "follow", fields.walletAddress);
    return fields.walletAddress;
  }

  return null;
}

// ── POST /profiles/:address/follow ────────────────────────────────────────────
// Follow a profile. Auth required (JWT Bearer or wallet signature). No self-follow.
router.post("/profiles/:address/follow", asyncWrap(async (req, res) => {
  const targetAddress = String(req.params.address ?? "").trim();
  if (!targetAddress) { res.status(400).json({ error: "Missing target address" }); return; }

  let callerAddress: string | null;
  try {
    callerAddress = resolveFollowCaller(req.headers.authorization, req.body);
  } catch (err) {
    res.status(401).json({ error: `Authentication failed: ${(err as Error).message}` }); return;
  }
  if (!callerAddress) { res.status(401).json({ error: "Authentication required" }); return; }

  if (callerAddress === targetAddress) {
    res.status(400).json({ error: "Cannot follow yourself" }); return;
  }

  // Verify target profile exists
  const [target] = await db.select({ address: profilesTable.address }).from(profilesTable)
    .where(eq(profilesTable.address, targetAddress)).limit(1);
  if (!target) { res.status(404).json({ error: "Profile not found" }); return; }

  // Verify caller profile exists
  const [caller] = await db.select({ address: profilesTable.address }).from(profilesTable)
    .where(eq(profilesTable.address, callerAddress)).limit(1);
  if (!caller) { res.status(403).json({ error: "You need a profile to follow others" }); return; }

  // Insert follow + increment counters in a transaction.
  // .returning() returns 0 rows when ON CONFLICT DO NOTHING fires (row already
  // existed), so we can guard counter updates behind `inserted.length > 0` to
  // prevent double-counting when the same follow request fires twice.
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(followsTable)
      .values({ followerAddress: callerAddress, followingAddress: targetAddress })
      .onConflictDoNothing()
      .returning();

    // No new row → already following. Skip counter updates entirely.
    if (inserted.length === 0) return;

    await tx.update(profilesTable)
      .set({ followingCount: sql`${profilesTable.followingCount} + 1` })
      .where(eq(profilesTable.address, callerAddress));
    await tx.update(profilesTable)
      .set({ followersCount: sql`${profilesTable.followersCount} + 1` })
      .where(eq(profilesTable.address, targetAddress));
  });

  // Re-read counters to return accurate values
  const [updated] = await db.select({
    followersCount: profilesTable.followersCount,
    followingCount: profilesTable.followingCount,
  }).from(profilesTable).where(eq(profilesTable.address, targetAddress)).limit(1);

  res.json({ isFollowing: true, followersCount: updated?.followersCount ?? 0 });
}));

// ── DELETE /profiles/:address/follow ──────────────────────────────────────────
// Unfollow a profile. Auth required (JWT Bearer or wallet signature).
router.delete("/profiles/:address/follow", asyncWrap(async (req, res) => {
  const targetAddress = String(req.params.address ?? "").trim();
  if (!targetAddress) { res.status(400).json({ error: "Missing target address" }); return; }

  let callerAddress: string | null;
  try {
    callerAddress = resolveFollowCaller(req.headers.authorization, req.body);
  } catch (err) {
    res.status(401).json({ error: `Authentication failed: ${(err as Error).message}` }); return;
  }
  if (!callerAddress) { res.status(401).json({ error: "Authentication required" }); return; }

  // Delete follow row and decrement counters atomically.
  // Previous code did delete then transaction separately — a concurrent follow/unfollow
  // could interleave and leave counters inconsistent with the actual followsTable state.
  let deleted: (typeof followsTable.$inferSelect)[] = [];
  await db.transaction(async (tx) => {
    deleted = await tx.delete(followsTable)
      .where(and(
        eq(followsTable.followerAddress, callerAddress),
        eq(followsTable.followingAddress, targetAddress),
      ))
      .returning();

    if (deleted.length > 0) {
      await tx.update(profilesTable)
        .set({ followingCount: sql`GREATEST(${profilesTable.followingCount} - 1, 0)` })
        .where(eq(profilesTable.address, callerAddress));
      await tx.update(profilesTable)
        .set({ followersCount: sql`GREATEST(${profilesTable.followersCount} - 1, 0)` })
        .where(eq(profilesTable.address, targetAddress));
    }
  });

  const [updated] = await db.select({
    followersCount: profilesTable.followersCount,
  }).from(profilesTable).where(eq(profilesTable.address, targetAddress)).limit(1);

  res.json({ isFollowing: false, followersCount: updated?.followersCount ?? 0 });
}));

// ── GET /profiles/:address/follow-status ──────────────────────────────────────
// Check if viewer follows target. viewer provided via ?viewer=<address>.
router.get("/profiles/:address/follow-status", asyncWrap(async (req, res) => {
  const targetAddress = String(req.params.address ?? "").trim();
  const viewerAddress = String(req.query.viewer ?? "").trim();

  if (!targetAddress || !viewerAddress) {
    res.json({ isFollowing: false }); return;
  }

  const [row] = await db.select({ followerAddress: followsTable.followerAddress })
    .from(followsTable)
    .where(and(
      eq(followsTable.followerAddress, viewerAddress),
      eq(followsTable.followingAddress, targetAddress),
    ))
    .limit(1);

  res.json({ isFollowing: !!row });
}));

// ── GET /profiles/:address/followers ─────────────────────────────────────────
// List followers of :address. Optional ?viewer=<address> for isFollowedByViewer.
router.get("/profiles/:address/followers", asyncWrap(async (req, res) => {
  const targetAddress = String(req.params.address ?? "").trim();
  const viewerAddress = String(req.query.viewer ?? "").trim();
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offset = Number(req.query.offset ?? 0);

  if (!targetAddress) { res.status(400).json({ error: "Missing address" }); return; }

  // Count total followers
  const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` })
    .from(followsTable)
    .where(eq(followsTable.followingAddress, targetAddress));

  // Fetch follower profiles
  const rows = await db
    .select({
      address: profilesTable.address,
      username: profilesTable.username,
      avatarUrl: profilesTable.avatarUrl,
      bio: profilesTable.bio,
      followersCount: profilesTable.followersCount,
      followingCount: profilesTable.followingCount,
    })
    .from(followsTable)
    .innerJoin(profilesTable, eq(followsTable.followerAddress, profilesTable.address))
    .where(eq(followsTable.followingAddress, targetAddress))
    .orderBy(followsTable.createdAt)
    .limit(limit)
    .offset(offset);

  // Resolve isFollowedByViewer for each row
  let viewerFollowingSet = new Set<string>();
  if (viewerAddress && rows.length > 0) {
    const addresses = rows.map(r => r.address);
    const viewerFollows = await db
      .select({ followingAddress: followsTable.followingAddress })
      .from(followsTable)
      .where(and(
        eq(followsTable.followerAddress, viewerAddress),
        sql`${followsTable.followingAddress} = ANY(${sql.raw(`ARRAY[${addresses.map(a => `'${a.replace(/'/g, "''")}'`).join(",")}]::text[]`)})`,
      ));
    viewerFollowingSet = new Set(viewerFollows.map(r => r.followingAddress));
  }

  const items = rows.map(r => ({
    ...r,
    isFollowedByViewer: viewerFollowingSet.has(r.address),
  }));

  res.json({ items, total });
}));

// ── GET /profiles/:address/following ─────────────────────────────────────────
// List profiles that :address is following.
router.get("/profiles/:address/following", asyncWrap(async (req, res) => {
  const targetAddress = String(req.params.address ?? "").trim();
  const viewerAddress = String(req.query.viewer ?? "").trim();
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offset = Number(req.query.offset ?? 0);

  if (!targetAddress) { res.status(400).json({ error: "Missing address" }); return; }

  const [{ total }] = await db.select({ total: sql<number>`COUNT(*)::int` })
    .from(followsTable)
    .where(eq(followsTable.followerAddress, targetAddress));

  const rows = await db
    .select({
      address: profilesTable.address,
      username: profilesTable.username,
      avatarUrl: profilesTable.avatarUrl,
      bio: profilesTable.bio,
      followersCount: profilesTable.followersCount,
      followingCount: profilesTable.followingCount,
    })
    .from(followsTable)
    .innerJoin(profilesTable, eq(followsTable.followingAddress, profilesTable.address))
    .where(eq(followsTable.followerAddress, targetAddress))
    .orderBy(followsTable.createdAt)
    .limit(limit)
    .offset(offset);

  let viewerFollowingSet = new Set<string>();
  if (viewerAddress && rows.length > 0) {
    const addresses = rows.map(r => r.address);
    const viewerFollows = await db
      .select({ followingAddress: followsTable.followingAddress })
      .from(followsTable)
      .where(and(
        eq(followsTable.followerAddress, viewerAddress),
        sql`${followsTable.followingAddress} = ANY(${sql.raw(`ARRAY[${addresses.map(a => `'${a.replace(/'/g, "''")}'`).join(",")}]::text[]`)})`,
      ));
    viewerFollowingSet = new Set(viewerFollows.map(r => r.followingAddress));
  }

  const items = rows.map(r => ({
    ...r,
    isFollowedByViewer: viewerFollowingSet.has(r.address),
  }));

  res.json({ items, total });
}));

export default router;
