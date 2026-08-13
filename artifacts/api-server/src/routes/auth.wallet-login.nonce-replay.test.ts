/**
 * auth.wallet-login.nonce-replay.test.ts
 *
 * Proves that the POST /api/auth/wallet/login handler cannot be exploited
 * via a replay attack — even when two requests carrying the same nonce race
 * concurrently, exactly one succeeds (HTTP 200) and the other is rejected
 * with HTTP 401.
 *
 * Strategy
 * ────────
 * Node.js is single-threaded, so `consumeWalletLoginNonce` in auth.ts uses a
 * synchronous Map.delete that is inherently atomic: whichever microtask runs
 * first wins the nonce; the second finds it already gone.  This test confirms
 * that guarantee end-to-end through the Express router so that:
 *
 *   • An accidental double-submit from the frontend is rejected gracefully.
 *   • A bad actor who intercepts a signed challenge and replays it immediately
 *     cannot obtain a second valid session JWT.
 *
 * The test:
 *   1. Generates a real Ed25519 keypair (nacl) so the server can verify the
 *      signature without any mocking.
 *   2. Requests one challenge from GET /api/auth/wallet/login/challenge.
 *   3. Signs the challenge message once.
 *   4. Fires two concurrent POST /api/auth/wallet/login requests carrying the
 *      same {walletAddress, signature, message} via Promise.all.
 *   5. Asserts exactly one response is 200 and the other is 401.
 *   6. Asserts the winner returns a valid JWT and a correct profile.
 *   7. Confirms a third attempt (after both settle) is also rejected with 401.
 *
 * This is an integration test: it requires DATABASE_URL (always present in
 * Replit environments with a provisioned Postgres database).
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import nacl from "tweetnacl";
import { eq } from "drizzle-orm";
import { db, profilesTable } from "@workspace/db";
import app from "../app";
import { verifyToken } from "../lib/auth-jwt";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// ── Base58 helpers (mirrors auth.ts) ─────────────────────────────────────────
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const chars: string[] = [];
  while (n > 0n) { chars.unshift(ALPHA[Number(n % 58n)]); n /= 58n; }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + chars.join("");
}

// ── Key-pair and signing helpers ──────────────────────────────────────────────

function makeKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKeyBytes: kp.publicKey,
    secretKey:      kp.secretKey,
    address:        bs58Encode(kp.publicKey),
  };
}

function signMessage(message: string, secretKey: Uint8Array): string {
  const msgBytes = new TextEncoder().encode(message);
  return bs58Encode(nacl.sign.detached(msgBytes, secretKey));
}

// ── Fixture cleanup ───────────────────────────────────────────────────────────
const createdAddresses: string[] = [];

afterAll(async () => {
  for (const addr of createdAddresses) {
    await db.delete(profilesTable).where(eq(profilesTable.address, addr)).catch(() => {});
  }
});

// ── Helper: fetch one challenge from the server ───────────────────────────────
async function getChallenge(walletAddress: string): Promise<{ nonce: string; message: string }> {
  const res = await request(app)
    .get(`/api/auth/wallet/login/challenge?wallet=${walletAddress}`)
    .expect(200);
  return res.body as { nonce: string; message: string };
}

// ── Helper: POST a login attempt ──────────────────────────────────────────────
function postLogin(payload: { walletAddress: string; signature: string; message: string }) {
  return request(app)
    .post("/api/auth/wallet/login")
    .set("Content-Type", "application/json")
    .send(payload);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("wallet login nonce replay guard", () => {
  it(
    "concurrent replay — exactly one of two simultaneous requests with the same nonce succeeds",
    async () => {
      const kp = makeKeypair();
      createdAddresses.push(kp.address);

      // Step 1: obtain a single challenge nonce
      const { message } = await getChallenge(kp.address);

      // Step 2: sign the challenge once (same signature reused for both requests)
      const signature = signMessage(message, kp.secretKey);

      // Step 3: fire both requests concurrently — they race to consume the nonce
      const loginPayload = { walletAddress: kp.address, signature, message };
      const [r1, r2] = await Promise.all([
        postLogin(loginPayload),
        postLogin(loginPayload),
      ]);

      const statuses = [r1.status, r2.status].sort(); // normalise order

      // Exactly one 200 and one 401 — never two 200s, never two 401s
      expect(statuses).toEqual([200, 401]);

      // The 401 body must clearly indicate the nonce was already used
      const rejected = r1.status === 401 ? r1 : r2;
      expect(rejected.body.error).toMatch(/invalid|expired|already/i);
    },
  );

  it(
    "concurrent replay — the winning response contains a valid JWT and correct profile",
    async () => {
      const kp = makeKeypair();
      createdAddresses.push(kp.address);

      const { message } = await getChallenge(kp.address);
      const signature   = signMessage(message, kp.secretKey);
      const loginPayload = { walletAddress: kp.address, signature, message };

      const [r1, r2] = await Promise.all([
        postLogin(loginPayload),
        postLogin(loginPayload),
      ]);

      const winner = r1.status === 200 ? r1 : r2;
      expect(winner.status).toBe(200);

      // JWT must be present, parseable, and carry the right claims
      const { token, profile } = winner.body as { token: string; profile: { address: string; username: string } };
      expect(token).toBeTruthy();

      const payload = verifyToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.authType).toBe("wallet");
      expect(payload!.sub).toBe(kp.address);

      // Profile must belong to the authenticated wallet
      expect(profile.address).toBe(kp.address);
      expect(profile.username).toBeTruthy();
    },
  );

  it(
    "post-race replay — a third attempt after both concurrent calls settle is also rejected",
    async () => {
      const kp = makeKeypair();
      createdAddresses.push(kp.address);

      const { message } = await getChallenge(kp.address);
      const signature   = signMessage(message, kp.secretKey);
      const loginPayload = { walletAddress: kp.address, signature, message };

      // Let both concurrent requests complete first
      await Promise.all([postLogin(loginPayload), postLogin(loginPayload)]);

      // A third sequential attempt must also be rejected — nonce already consumed
      const r3 = await postLogin(loginPayload);
      expect(r3.status).toBe(401);
      expect(r3.body.error).toMatch(/invalid|expired|already/i);
    },
  );
});
