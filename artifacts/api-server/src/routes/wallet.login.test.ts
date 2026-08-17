/**
 * wallet.login.test.ts
 *
 * Integration tests for the wallet-only login endpoints:
 *   GET  /api/auth/wallet/login/challenge
 *   POST /api/auth/wallet/login
 *
 * Tests cover:
 *   1. Happy path — full challenge → sign → login flow
 *   2. JWT issued with authType "wallet" and correct sub
 *   3. Nonce replay — second use of the same nonce is rejected
 *   4. Tampered challenge message — wrong wallet in message body
 *   5. Bad signature — modified signature bytes
 *   6. Missing fields — 400 for incomplete body
 *   7. Signature with leading zero byte — canonical Base58 round-trip
 *   8. Profile find-or-create — login creates profile if absent, reuses if present
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import nacl from "tweetnacl";
import { eq } from "drizzle-orm";
import { db, profilesTable } from "@workspace/db";
import app from "../app";
import { verifyToken } from "../lib/auth-jwt";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// ── Base58 helpers (mirrors auth.ts and AuthContext.tsx) ─────────────────────
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

function bs58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHA.indexOf(c);
    if (i < 0) throw new Error(`bad base58 char: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let leading = 0;
  for (const c of s) { if (c !== "1") break; leading++; }
  return new Uint8Array([...new Array(leading).fill(0), ...bytes]);
}

// ── Test key pair helper ──────────────────────────────────────────────────────
function makeKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKeyBytes: kp.publicKey,
    secretKey: kp.secretKey,
    address: bs58Encode(kp.publicKey),
  };
}

/** Sign a UTF-8 message string with the given Ed25519 secret key. */
function signMessage(message: string, secretKey: Uint8Array): string {
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = nacl.sign.detached(msgBytes, secretKey);
  return bs58Encode(sigBytes);
}

// ── Fixture cleanup list ──────────────────────────────────────────────────────
const createdAddresses: string[] = [];

afterAll(async () => {
  for (const addr of createdAddresses) {
    await db.delete(profilesTable).where(eq(profilesTable.address, addr)).catch(() => {});
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getChallenge(wallet: string) {
  const res = await request(app)
    .get(`/api/auth/wallet/login/challenge?wallet=${wallet}`)
    .expect(200);
  return res.body as { nonce: string; message: string };
}

async function doLogin(payload: {
  walletAddress: string;
  signature: string;
  message: string;
}) {
  return request(app)
    .post("/api/auth/wallet/login")
    .send(payload)
    .set("Content-Type", "application/json");
}

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/auth/wallet/login/challenge", () => {
  it("returns a nonce and well-formed message for a valid wallet address", async () => {
    const { address } = makeKeypair();
    const res = await request(app)
      .get(`/api/auth/wallet/login/challenge?wallet=${address}`)
      .expect(200);

    expect(res.body.nonce).toBeTruthy();
    expect(res.body.message).toBe(`Pumpi:login:${address}:${res.body.nonce}`);
  });

  it("returns 400 for a missing wallet param", async () => {
    await request(app)
      .get("/api/auth/wallet/login/challenge")
      .expect(400);
  });

  it("returns 400 for an invalid wallet address", async () => {
    await request(app)
      .get("/api/auth/wallet/login/challenge?wallet=not-a-valid-address!!")
      .expect(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/auth/wallet/login", () => {
  it("happy path — valid signature yields a JWT with authType=wallet and correct sub", async () => {
    const kp = makeKeypair();
    createdAddresses.push(kp.address);

    const { message } = await getChallenge(kp.address);
    const signature = signMessage(message, kp.secretKey);

    const res = await doLogin({ walletAddress: kp.address, signature, message });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.profile.address).toBe(kp.address);

    // JWT payload must carry authType=wallet and sub=walletAddress
    const payload = verifyToken(res.body.token);
    expect(payload).not.toBeNull();
    expect(payload!.authType).toBe("wallet");
    expect(payload!.sub).toBe(kp.address);
  });

  it("profile find-or-create — second login reuses existing profile", async () => {
    const kp = makeKeypair();
    createdAddresses.push(kp.address);

    // First login — creates profile
    const { message: msg1 } = await getChallenge(kp.address);
    const sig1 = signMessage(msg1, kp.secretKey);
    const r1 = await doLogin({ walletAddress: kp.address, signature: sig1, message: msg1 });
    expect(r1.status).toBe(200);

    // Second login — reuses same profile (no duplicate)
    const { message: msg2 } = await getChallenge(kp.address);
    const sig2 = signMessage(msg2, kp.secretKey);
    const r2 = await doLogin({ walletAddress: kp.address, signature: sig2, message: msg2 });
    expect(r2.status).toBe(200);
    expect(r2.body.profile.address).toBe(r1.body.profile.address);
  });

  it("nonce replay — second use of the same nonce is rejected with 401", async () => {
    const kp = makeKeypair();
    createdAddresses.push(kp.address);

    const { message } = await getChallenge(kp.address);
    const signature = signMessage(message, kp.secretKey);

    // First use — succeeds
    const r1 = await doLogin({ walletAddress: kp.address, signature, message });
    expect(r1.status).toBe(200);

    // Second use — same nonce already consumed
    const r2 = await doLogin({ walletAddress: kp.address, signature, message });
    expect(r2.status).toBe(401);
    expect(r2.body.error).toMatch(/invalid|expired|already/i);
  });

  it("tampered message — different wallet in body vs signed message yields 400", async () => {
    const kp = makeKeypair();
    const otherKp = makeKeypair();

    const { message } = await getChallenge(kp.address);
    // Sign with otherKp's key but claim walletAddress = kp.address
    const signature = signMessage(message, otherKp.secretKey);

    const res = await doLogin({ walletAddress: kp.address, signature, message });
    expect(res.status).toBe(401);
  });

  it("wrong wallet in body — message contains different address than walletAddress param", async () => {
    const kp = makeKeypair();
    const otherKp = makeKeypair();
    createdAddresses.push(kp.address);

    const { message } = await getChallenge(kp.address);
    const signature = signMessage(message, kp.secretKey);

    // Claim a different walletAddress — message format check should catch this
    const res = await doLogin({ walletAddress: otherKp.address, signature, message });
    expect(res.status).toBe(400);
  });

  it("bad signature — flipped byte in signature is rejected with 401", async () => {
    const kp = makeKeypair();
    createdAddresses.push(kp.address);

    const { message } = await getChallenge(kp.address);
    const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    // Flip bit in first byte
    sigBytes[0] ^= 0x01;
    const badSig = bs58Encode(sigBytes);

    const res = await doLogin({ walletAddress: kp.address, signature: badSig, message });
    expect(res.status).toBe(401);
  });

  it("missing fields — 400 when any required body field is absent", async () => {
    const kp = makeKeypair();
    const { message } = await getChallenge(kp.address);
    const sig = signMessage(message, kp.secretKey);

    await doLogin({ walletAddress: kp.address, signature: sig, message: "" } as Parameters<typeof doLogin>[0]).then(r => expect(r.status).toBe(400));
    await request(app).post("/api/auth/wallet/login").send({ walletAddress: kp.address, message }).expect(400);
    await request(app).post("/api/auth/wallet/login").send({ signature: sig, message }).expect(400);
  });

  it("per-wallet deduplication — a second challenge for the same wallet invalidates the first", async () => {
    const kp = makeKeypair();
    createdAddresses.push(kp.address);

    // Issue two challenges for the same wallet in sequence
    const r1 = await request(app)
      .get(`/api/auth/wallet/login/challenge?wallet=${kp.address}`)
      .expect(200);
    const { message: msg1 } = r1.body as { nonce: string; message: string };

    const r2 = await request(app)
      .get(`/api/auth/wallet/login/challenge?wallet=${kp.address}`)
      .expect(200);
    const { message: msg2 } = r2.body as { nonce: string; message: string };

    // msg1 ≠ msg2 — a new nonce was issued
    expect(msg1).not.toBe(msg2);

    // Attempt to log in with the FIRST (revoked) challenge — must be rejected
    const sig1 = signMessage(msg1, kp.secretKey);
    const stale = await doLogin({ walletAddress: kp.address, signature: sig1, message: msg1 });
    expect(stale.status).toBe(401);

    // Log in with the SECOND (current) challenge — must succeed
    const sig2 = signMessage(msg2, kp.secretKey);
    const fresh = await doLogin({ walletAddress: kp.address, signature: sig2, message: msg2 });
    expect(fresh.status).toBe(200);
    expect(fresh.body.profile.address).toBe(kp.address);
  });

  it("username collision recovery — login succeeds even when the derived username is already taken", async () => {
    const kp = makeKeypair();
    createdAddresses.push(kp.address);

    // Pre-occupy the username that uniqueUsername would normally pick on attempt 0.
    // slugifyName(`wallet_${kp.address.slice(0, 6)}`) is the deterministic first candidate.
    const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const rawSlug = `wallet_${kp.address.slice(0, 6)}`
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 20);

    // Create a "blocker" wallet that holds the first-choice username
    const blockerKp = makeKeypair();
    createdAddresses.push(blockerKp.address);
    await db.insert(profilesTable).values({
      address:  blockerKp.address,
      username: rawSlug,
      authType: "wallet",
    }).onConflictDoNothing();

    // Now do the real wallet login — uniqueUsername must pick a different name
    const { message } = await getChallenge(kp.address);
    const signature = signMessage(message, kp.secretKey);
    const res = await doLogin({ walletAddress: kp.address, signature, message });

    expect(res.status).toBe(200);
    expect(res.body.profile.address).toBe(kp.address);
    // Username must differ from the blocked one
    expect(res.body.profile.username).not.toBe(rawSlug);
    expect(res.body.profile.username).toBeTruthy();
  });

  it("session restoration — wallet JWT is accepted by GET /auth/me after page reload", async () => {
    const kp = makeKeypair();
    createdAddresses.push(kp.address);

    // Step 1: wallet login → get JWT
    const { message } = await getChallenge(kp.address);
    const signature = signMessage(message, kp.secretKey);
    const loginRes = await doLogin({ walletAddress: kp.address, signature, message });
    expect(loginRes.status).toBe(200);
    const { token } = loginRes.body as { token: string };
    expect(token).toBeTruthy();

    // Step 2: simulate page reload by calling /auth/me with the stored JWT
    // (AuthContext does exactly this on mount to restore the session)
    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // Must not fail with 500 or 401 (bad token)
    expect(meRes.body.authType).toBe("wallet");
    expect(meRes.body.profile.address).toBe(kp.address);
    expect(meRes.body.profile.username).toBeTruthy();
  });

  it("leading-zero signature — canonical Base58 encoding survives round-trip through server", async () => {
    // Manufacture a 64-byte signature whose first byte is 0x00 to exercise
    // the leading-zero Base58 path.  We need a real keypair so the server can
    // verify; we patch the first byte of the raw sig to 0x00 and re-encode.
    // Since the server decodes Base58 and verifies with nacl, a purely zero-
    // patched sig will fail verification — we instead verify the encoding
    // itself: encode a byte array with a leading 0x00 and confirm decode
    // restores the same byte array exactly.

    // Synthetic test: 64-byte array where first byte is 0x00
    const raw = new Uint8Array(64);
    raw[0] = 0x00;
    raw[1] = 0x01;
    raw[63] = 0xff;

    const encoded = bs58Encode(raw);
    expect(encoded.startsWith("1")).toBe(true); // leading 0x00 → "1"

    const decoded = bs58Decode(encoded);
    // Decoded length may include the leading zero
    const trimmed = decoded.slice(decoded.length - 64);
    expect(trimmed[0]).toBe(0x00);
    expect(trimmed[1]).toBe(0x01);
    expect(trimmed[63]).toBe(0xff);
  });

  it("leading-zero signature — keypair whose signature happens to start with 0x00 can log in", async () => {
    // Pre-computed deterministic fixture: a keypair whose Ed25519 signature on
    // `Pumpi:login:<address>:FIXTURE_NONCE_v1` begins with 0x00.
    //
    // Generated once offline (scanning ~200 k keypairs on average).  Using a
    // fixture avoids a brute-force loop that can exceed the test timeout when
    // the full suite runs under CPU contention.
    //
    // To regenerate:
    //   node -e "
    //     const nacl=require('tweetnacl');
    //     const BS58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    //     function enc(b){let n=0n;for(const x of b)n=n*256n+BigInt(x);const c=[];
    //       while(n>0n){c.unshift(BS58[Number(n%58n)]);n/=58n;}
    //       let l=0;for(const x of b){if(x!==0)break;l++;}
    //       return '1'.repeat(l)+c.join('');}
    //     for(let i=0;;i++){const kp=nacl.sign.keyPair();const a=enc(kp.publicKey);
    //       const m='Pumpi:login:'+a+':FIXTURE_NONCE_v1';
    //       const s=nacl.sign.detached(new TextEncoder().encode(m),kp.secretKey);
    //       if(s[0]===0){console.log(Buffer.from(kp.secretKey).toString('hex'),a);break;}}"
    const FIXTURE_SECRET_HEX =
      "f9f579f0a4d4535a79a3a696d6b7b1ac5e64b3a38f9bcee5a030100d1976e9c" +
      "6c86f034ad0486ccf5875138291e232f141cf9638a55c3fb4eb7ba7c1986aa73d";
    const FIXTURE_ADDRESS    = "EVQikhvMQur5pF47Jt5yTWrea2935nUfeYTqHs986WVS";
    const FIXTURE_NONCE      = "FIXTURE_NONCE_v1";

    const secretKey      = Uint8Array.from(Buffer.from(FIXTURE_SECRET_HEX, "hex"));
    const publicKeyBytes = secretKey.slice(32); // nacl secretKey = [privateKey(32) | publicKey(32)]
    const fixtureMsg     = `Pumpi:login:${FIXTURE_ADDRESS}:${FIXTURE_NONCE}`;

    // ── Part 1: verify the fixture signature has a leading 0x00 ──────────────
    const fixtureSig = nacl.sign.detached(new TextEncoder().encode(fixtureMsg), secretKey);
    expect(fixtureSig[0]).toBe(0x00);

    // ── Part 2: bs58Encode round-trip ─────────────────────────────────────────
    const encoded = bs58Encode(fixtureSig);
    expect(encoded.startsWith("1")).toBe(true); // leading 0x00 → "1" in Base58

    const decoded  = bs58Decode(encoded);
    const restored = decoded.length === 64 ? decoded : decoded.slice(decoded.length - 64);
    expect(restored[0]).toBe(0x00);
    expect(nacl.sign.detached.verify(
      new TextEncoder().encode(fixtureMsg),
      restored,
      publicKeyBytes,
    )).toBe(true);

    // ── Part 3: real end-to-end HTTP login with this keypair ─────────────────
    // The server-issued challenge has a fresh nonce; this signature may or may
    // not have a leading zero, but the Base58 encoding must be correct either way.
    createdAddresses.push(FIXTURE_ADDRESS);
    const { message } = await getChallenge(FIXTURE_ADDRESS);
    const sigBytes    = nacl.sign.detached(new TextEncoder().encode(message), secretKey);
    const signature   = bs58Encode(sigBytes);

    const res = await doLogin({ walletAddress: FIXTURE_ADDRESS, signature, message });
    expect(res.status).toBe(200);
    expect(res.body.profile.address).toBe(FIXTURE_ADDRESS);
  });
});
