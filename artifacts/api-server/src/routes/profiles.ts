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
 *   message   = "RocketFi:{action}:{walletAddress}:{unixSeconds}"
 *   signature = base58-encoded 64-byte Ed25519 signature over UTF-8 message bytes
 *   The timestamp must be within ±5 minutes of server time (replay protection).
 */

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
import {
  parseWalletAuthFields,
  issueNonce,
  verifyWalletSignatureWithNonce,
} from "../lib/wallet-auth.js";

const router: IRouter = Router();

// ── POST /profiles/challenge ───────────────────────────────────────────────────
// Issue a single-use nonce that the client must include in the message it signs.
// Binds the nonce to one (action, address) pair and a 5-minute expiry window.

router.post("/profiles/challenge", (req, res): void => {
  const body = req.body as { action?: unknown; address?: unknown };
  const action = body.action;
  const address = body.address;

  if ((action !== "create" && action !== "update") || typeof address !== "string" || address.length < 32) {
    res.status(400).json({ error: "Required: action ('create'|'update') and address (string ≥ 32 chars)" });
    return;
  }

  const nonce = issueNonce(action as "create" | "update", address);
  res.json({ nonce });
});

// ── GET /profiles/:address ────────────────────────────────────────────────────
// Public — no auth required.

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

// ── POST /profiles ─────────────────────────────────────────────────────────────
// Create a profile for the signing wallet.
//
// Required body fields: walletAddress, signature, message  (wallet auth)
// Optional body fields: username, bio, avatarUrl, twitterHandle, websiteUrl
//
// address is always derived from the verified walletAddress — any "address" field
// in the body is ignored and overwritten before schema validation.

router.post("/profiles", async (req, res): Promise<void> => {
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
  //    If the profile already exists the INSERT silently skips and returns no rows.
  const [inserted] = await db
    .insert(profilesTable)
    .values({ address: walletAddress, username: resolvedUsername, ...profileFields })
    .onConflictDoNothing()
    .returning();

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
});

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

router.patch("/profiles/:address", async (req, res): Promise<void> => {
  // 1. Parse and validate route param
  const paramsParsed = UpdateProfileParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid address" });
    return;
  }

  const { address } = paramsParsed.data;

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
  const [updated] = await db
    .insert(profilesTable)
    .values({ address: walletAddress, username: resolvedUsername, ...updateData })
    .onConflictDoUpdate({
      target: profilesTable.address,
      set: { ...updateData, updatedAt: new Date() },
    })
    .returning();

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
});

export default router;
