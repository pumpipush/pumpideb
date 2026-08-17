/**
 * profiles.follow.wallet-auth.test.ts
 *
 * Endpoint-level security coverage for the wallet-signature auth path on
 * POST /profiles/:address/follow and DELETE /profiles/:address/follow.
 *
 * Test matrix:
 *   ✓ Valid signed nonce  → 200 follow
 *   ✓ Valid signed nonce  → 200 unfollow
 *   ✓ Missing auth        → 401
 *   ✓ Wrong-action nonce  → 401 ("create" nonce used for "follow" endpoint)
 *   ✓ Replayed nonce      → 401 (same signed body sent twice)
 *   ✓ Forged signature    → 401 (valid nonce, signature from a different key)
 *
 * Strategy: in-process Express server against the real dev DB, ephemeral
 * profiles created in beforeAll and removed in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import nacl from "tweetnacl";
import { db, profilesTable, followsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import app from "../app.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ── Base58 helper ──────────────────────────────────────────────────────────────
const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const chars: string[] = [];
  while (n > 0n) { chars.unshift(BS58_ALPHA[Number(n % 58n)]!); n /= 58n; }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + chars.join("");
}

// ── Test identities ────────────────────────────────────────────────────────────
const RUN = Date.now().toString(36);
const callerKp = nacl.sign.keyPair();
const CALLER_ADDR = bs58Encode(callerKp.publicKey);
const TARGET_ADDR = `TstFollowWalletTgt${RUN}`.padEnd(44, "3").slice(0, 44);

// ── Server lifecycle ───────────────────────────────────────────────────────────
let server: Server;
let base: string;

beforeAll(async () => {
  await db
    .insert(profilesTable)
    .values([
      { address: CALLER_ADDR, username: `walletcaller_${RUN}` },
      { address: TARGET_ADDR, username: `wallettarget_${RUN}` },
    ])
    .onConflictDoNothing();

  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  await db
    .delete(followsTable)
    .where(and(
      eq(followsTable.followerAddress, CALLER_ADDR),
      eq(followsTable.followingAddress, TARGET_ADDR),
    ));
  await db.delete(profilesTable).where(eq(profilesTable.address, CALLER_ADDR));
  await db.delete(profilesTable).where(eq(profilesTable.address, TARGET_ADDR));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Obtain a single-use "follow" nonce from the challenge endpoint and return a
 * fully-signed wallet auth body ready to include in a follow/unfollow request.
 */
async function buildFollowAuth(
  walletAddress: string,
  secretKey: Uint8Array,
): Promise<{ walletAddress: string; signature: string; message: string }> {
  const challengeRes = await fetch(`${base}/profiles/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "follow", address: walletAddress }),
  });
  if (!challengeRes.ok) throw new Error(`Challenge failed: ${challengeRes.status}`);
  const { nonce } = await challengeRes.json() as { nonce: string };

  const message = `Pumpi:follow:${walletAddress}:${nonce}`;
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = nacl.sign.detached(msgBytes, secretKey);
  const signature = bs58Encode(sigBytes);
  return { walletAddress, signature, message };
}

async function followReq(body: Record<string, string>): Promise<Response> {
  return fetch(`${base}/profiles/${TARGET_ADDR}/follow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function unfollowReq(body: Record<string, string>): Promise<Response> {
  return fetch(`${base}/profiles/${TARGET_ADDR}/follow`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("wallet-signature auth on follow / unfollow endpoints", () => {
  it("follows with a valid signed nonce → 200 with isFollowing:true", async () => {
    const auth = await buildFollowAuth(CALLER_ADDR, callerKp.secretKey);
    const res = await followReq(auth);
    expect(res.status).toBe(200);
    const body = await res.json() as { isFollowing: boolean; followersCount: number };
    expect(body.isFollowing).toBe(true);
    expect(body.followersCount).toBeGreaterThanOrEqual(1);
  });

  it("unfollows with a valid signed nonce → 200 with isFollowing:false", async () => {
    const auth = await buildFollowAuth(CALLER_ADDR, callerKp.secretKey);
    const res = await unfollowReq(auth);
    expect(res.status).toBe(200);
    const body = await res.json() as { isFollowing: boolean };
    expect(body.isFollowing).toBe(false);
  });

  it("rejects a follow with no auth at all → 401", async () => {
    const res = await fetch(`${base}/profiles/${TARGET_ADDR}/follow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a follow when a 'create' nonce is used for a 'follow' endpoint → 401", async () => {
    // Get a nonce issued for action="create" (wrong action for this endpoint)
    const challengeRes = await fetch(`${base}/profiles/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", address: CALLER_ADDR }),
    });
    const { nonce } = await challengeRes.json() as { nonce: string };

    // Sign with the correct wallet but the wrong action in the message
    const message = `Pumpi:create:${CALLER_ADDR}:${nonce}`;
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = nacl.sign.detached(msgBytes, callerKp.secretKey);
    const signature = bs58Encode(sigBytes);

    const res = await followReq({ walletAddress: CALLER_ADDR, signature, message });
    expect(res.status).toBe(401);
  });

  it("rejects a replayed follow (same signed body sent twice) → 401 on second request", async () => {
    // Build auth once — the nonce is consumed on the first successful use
    const auth = await buildFollowAuth(CALLER_ADDR, callerKp.secretKey);

    // First request succeeds (or the follow already exists — either way it's 200)
    const first = await followReq(auth);
    expect([200, 400]).toContain(first.status); // 200=ok, 400=self-follow guard (shouldn't happen here)

    // Second request reuses the EXACT same body — nonce is already consumed
    const second = await followReq(auth);
    expect(second.status).toBe(401);
  });

  it("rejects a forged signature (valid nonce, signed by a different key) → 401", async () => {
    // Attacker has their own key; they try to sign a nonce issued for CALLER_ADDR
    const attackerKp = nacl.sign.keyPair();

    const challengeRes = await fetch(`${base}/profiles/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "follow", address: CALLER_ADDR }),
    });
    const { nonce } = await challengeRes.json() as { nonce: string };

    // Build the correct message but sign it with the attacker's key
    const message = `Pumpi:follow:${CALLER_ADDR}:${nonce}`;
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = nacl.sign.detached(msgBytes, attackerKp.secretKey);
    const signature = bs58Encode(sigBytes);

    const res = await followReq({ walletAddress: CALLER_ADDR, signature, message });
    expect(res.status).toBe(401);
  });
});
