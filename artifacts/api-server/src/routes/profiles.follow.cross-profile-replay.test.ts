/**
 * profiles.follow.cross-profile-replay.test.ts
 *
 * Security regression test: a wallet-signed follow request must NOT be usable
 * to follow a second, different profile once the nonce has been consumed.
 *
 * Threat model
 * ────────────
 * The signed message format is:
 *   Pumpi:follow:<callerWalletAddress>:<nonce>
 *
 * It intentionally does NOT embed the target profile address, so the signed
 * message alone is "follow intent by <caller>" without specifying whom.
 * The only protection against cross-profile replay is the server-side single-use
 * nonce: once the nonce is consumed (on first auth), the same auth package must
 * be rejected on every subsequent request, including requests to different target
 * URLs.
 *
 * Test matrix
 * ───────────
 *   ✓ Auth used against target A → 200 (nonce consumed)
 *   ✓ Same auth body replayed against target B → 401 (nonce already used)
 *   ✓ Same auth body replayed against target A again → 401 (nonce already used)
 *   ✓ Nonce is consumed even when follow fails mid-request (non-auth error):
 *       auth against a non-existent profile target → 404, then replay → 401
 *   ✓ Cross-wallet claim: attacker claims to be caller but signs with own key → 401
 *
 * Strategy: spin up an in-process Express server against the real dev DB,
 * insert ephemeral test profiles, run all assertions, clean up in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import nacl from "tweetnacl";
import { db, profilesTable, followsTable } from "@workspace/db";
import { eq, and, or } from "drizzle-orm";
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
// CALLER uses a real nacl keypair so Ed25519 verification works end-to-end.
// TARGET_A and TARGET_B are the two different profiles an attacker might try to
// exploit with a single signed auth package.
const RUN = Date.now().toString(36);
const callerKp   = nacl.sign.keyPair();
const CALLER_ADDR = bs58Encode(callerKp.publicKey);
const TARGET_A    = `TstReplayTargetA${RUN}`.padEnd(44, "4").slice(0, 44);
const TARGET_B    = `TstReplayTargetB${RUN}`.padEnd(44, "5").slice(0, 44);

// ── Server lifecycle ───────────────────────────────────────────────────────────
let server: Server;
let base: string;

beforeAll(async () => {
  // Insert ephemeral profiles for caller, target A, and target B.
  await db
    .insert(profilesTable)
    .values([
      { address: CALLER_ADDR, username: `crossreplay_caller_${RUN}` },
      { address: TARGET_A,    username: `crossreplay_tgtA_${RUN}` },
      { address: TARGET_B,    username: `crossreplay_tgtB_${RUN}` },
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
  // Remove follow rows in both directions, then remove the profiles.
  await db.delete(followsTable).where(or(
    and(
      eq(followsTable.followerAddress, CALLER_ADDR),
      eq(followsTable.followingAddress, TARGET_A),
    ),
    and(
      eq(followsTable.followerAddress, CALLER_ADDR),
      eq(followsTable.followingAddress, TARGET_B),
    ),
  ));
  await db.delete(profilesTable).where(
    or(
      eq(profilesTable.address, CALLER_ADDR),
      eq(profilesTable.address, TARGET_A),
      eq(profilesTable.address, TARGET_B),
    ),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get a fresh server-issued nonce and return a signed auth body. */
async function buildFollowAuth(): Promise<{
  walletAddress: string;
  signature: string;
  message: string;
}> {
  const challengeRes = await fetch(`${base}/profiles/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "follow", address: CALLER_ADDR }),
  });
  if (!challengeRes.ok) throw new Error(`Challenge failed: ${challengeRes.status}`);
  const { nonce } = await challengeRes.json() as { nonce: string };

  const message  = `Pumpi:follow:${CALLER_ADDR}:${nonce}`;
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = nacl.sign.detached(msgBytes, callerKp.secretKey);
  return { walletAddress: CALLER_ADDR, signature: bs58Encode(sigBytes), message };
}

/** Send a follow POST to a specific target URL. */
function postFollowTo(
  targetAddr: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetch(`${base}/profiles/${targetAddr}/follow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cross-profile nonce replay prevention", () => {
  // ── 1. Primary cross-profile replay test ─────────────────────────────────
  it("follow target A with valid auth succeeds, then the same auth against target B is rejected", async () => {
    const auth = await buildFollowAuth();

    // First request: follow target A — nonce is consumed on success
    const firstRes = await postFollowTo(TARGET_A, auth);
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json() as { isFollowing: boolean };
    expect(firstBody.isFollowing).toBe(true);

    // Second request: exact same signed body, but URL changed to target B
    // The nonce is already consumed — server must reject with 401
    const secondRes = await postFollowTo(TARGET_B, auth);
    expect(secondRes.status).toBe(401);
    const secondBody = await secondRes.json() as { error: string };
    // Error should indicate nonce exhaustion (not a missing-auth or missing-profile error)
    expect(secondBody.error).toMatch(/nonce|authentication/i);
  });

  // ── 2. Replay against original target also rejected ───────────────────────
  it("the same auth is also rejected when replayed against target A a second time", async () => {
    // At this point the previous test already consumed a nonce and followed A.
    // Issue a fresh nonce, follow A successfully, then try to replay to A again.
    const auth = await buildFollowAuth();

    // Unfollow A first so the follow can succeed (may already be following from prev test)
    await fetch(`${base}/profiles/${TARGET_A}/follow`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await buildFollowAuth()),
    });

    // Now follow A with the captured auth
    const followRes = await postFollowTo(TARGET_A, auth);
    expect(followRes.status).toBe(200);

    // Replay the captured auth at target A — must fail
    const replayRes = await postFollowTo(TARGET_A, auth);
    expect(replayRes.status).toBe(401);
  });

  // ── 3. Nonce consumed even when the follow request itself fails ────────────
  //
  // Scenario: attacker obtains a valid signed auth, sends it against a
  // non-existent profile, gets a 404 — then tries to reuse the nonce
  // against a real profile. The nonce must still be consumed on the
  // first auth attempt (regardless of what happens later in the handler).
  it("nonce is consumed even when the request fails for a non-auth reason (e.g. target not found)", async () => {
    const auth = await buildFollowAuth();
    const NONEXISTENT = "NonExistentProfile111111111111111111111111";

    // First: valid auth, but target profile doesn't exist in DB → 404
    const firstRes = await postFollowTo(NONEXISTENT, auth);
    expect(firstRes.status).toBe(404);

    // Second: same auth replayed against a real profile → 401 (nonce consumed)
    const secondRes = await postFollowTo(TARGET_A, auth);
    expect(secondRes.status).toBe(401);
  });

  // ── 4. Cross-wallet claim: attacker signs with their own key but claims ───
  //       to be the caller. The message contains the caller's address, so the
  //       signature is invalid against the caller's public key → 401.
  it("cross-wallet claim: signing with own key while claiming to be caller is rejected", async () => {
    const attackerKp = nacl.sign.keyPair();

    // Attacker gets a nonce issued for CALLER_ADDR
    const challengeRes = await fetch(`${base}/profiles/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "follow", address: CALLER_ADDR }),
    });
    const { nonce } = await challengeRes.json() as { nonce: string };

    // Attacker builds the correct-format message for CALLER_ADDR…
    const message  = `Pumpi:follow:${CALLER_ADDR}:${nonce}`;
    const msgBytes = new TextEncoder().encode(message);
    // …but signs it with their OWN key
    const sigBytes    = nacl.sign.detached(msgBytes, attackerKp.secretKey);
    const signature   = bs58Encode(sigBytes);

    // Attacker submits CALLER_ADDR as walletAddress — server verifies against
    // CALLER's public key and the signature fails
    const res = await postFollowTo(TARGET_A, { walletAddress: CALLER_ADDR, signature, message });
    expect(res.status).toBe(401);
  });
});
