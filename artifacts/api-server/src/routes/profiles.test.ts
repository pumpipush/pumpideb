/**
 * profiles.test.ts — Auth coverage for wallet signature + nonce-based profile endpoints.
 *
 * Tests the core security functions directly (no HTTP server needed):
 *  - issueNonce / consumeNonce (single-use, expiry, action/address binding)
 *  - verifyWalletSignatureWithNonce (valid auth, replay, forged sig, wrong address)
 *
 * Also exercises parseWalletAuthFields for field extraction.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import nacl from "tweetnacl";
import {
  issueNonce,
  consumeNonce,
  buildProfileSignMessage,
  verifyWalletSignatureWithNonce,
  parseWalletAuthFields,
} from "../lib/wallet-auth.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a fresh Ed25519 keypair and a base58-encoded wallet address. */
function makeWallet() {
  const kp = nacl.sign.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const chars: string[] = [];
  while (n > 0n) { chars.unshift(BS58_ALPHA[Number(n % 58n)]); n /= 58n; }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + chars.join("");
}

/** Build a valid signed payload for a given keypair, action, and address. */
function makeSignedPayload(
  kp: ReturnType<typeof makeWallet>,
  action: "create" | "update" | "follow",
  address: string,
  nonce: string,
) {
  const walletAddress = bs58Encode(kp.publicKey);
  const message = buildProfileSignMessage(action, address, nonce);
  const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  const signature = bs58Encode(sigBytes);
  return { walletAddress, signature, message };
}

// ── issueNonce / consumeNonce ─────────────────────────────────────────────────

describe("issueNonce / consumeNonce", () => {
  it("issues a non-empty nonce string", () => {
    const nonce = issueNonce("update", "TestAddress123456789012345678901");
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBeGreaterThan(10);
  });

  it("accepts a valid nonce on first use", () => {
    const address = "Addr1111111111111111111111111111";
    const nonce = issueNonce("update", address);
    expect(consumeNonce(nonce, "update", address)).toBe(true);
  });

  it("rejects the same nonce on second use (replay protection)", () => {
    const address = "Addr2222222222222222222222222222";
    const nonce = issueNonce("update", address);
    consumeNonce(nonce, "update", address); // first use
    expect(consumeNonce(nonce, "update", address)).toBe(false); // replay
  });

  it("rejects a nonce with the wrong action", () => {
    const address = "Addr3333333333333333333333333333";
    const nonce = issueNonce("create", address);
    expect(consumeNonce(nonce, "update", address)).toBe(false);
  });

  it("rejects a nonce with the wrong address", () => {
    const address = "Addr4444444444444444444444444444";
    const nonce = issueNonce("update", address);
    expect(consumeNonce(nonce, "update", "Addr5555555555555555555555555555")).toBe(false);
  });

  it("rejects a nonce that was never issued", () => {
    expect(consumeNonce("not-a-real-nonce", "update", "Addr6666666666666666666666666666")).toBe(false);
  });

  it("rejects an expired nonce", () => {
    const address = "Addr7777777777777777777777777777";
    const nonce = issueNonce("update", address);
    // Simulate expiry by manipulating Date.now
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockReturnValue(realNow() + 6 * 60 * 1000); // +6 minutes
    try {
      expect(consumeNonce(nonce, "update", address)).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("each issued nonce is unique", () => {
    const address = "Addr8888888888888888888888888888";
    const n1 = issueNonce("update", address);
    const n2 = issueNonce("update", address);
    expect(n1).not.toBe(n2);
  });

  it("supports the 'follow' action alongside 'create' and 'update'", () => {
    const address = "Addr9999999999999999999999999999";
    const nonce = issueNonce("follow", address);
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBeGreaterThan(10);
    expect(consumeNonce(nonce, "follow", address)).toBe(true);
  });

  it("rejects a 'follow' nonce when the wrong action is specified on consumption", () => {
    const address = "AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const nonce = issueNonce("follow", address);
    // Trying to consume a "follow" nonce as "update" must fail
    expect(consumeNonce(nonce, "update", address)).toBe(false);
  });
});

// ── verifyWalletSignatureWithNonce ────────────────────────────────────────────

describe("verifyWalletSignatureWithNonce", () => {
  it("accepts a valid signed nonce message", () => {
    const kp = makeWallet();
    const walletAddress = bs58Encode(kp.publicKey);
    const nonce = issueNonce("update", walletAddress);
    const payload = makeSignedPayload(kp, "update", walletAddress, nonce);
    expect(() =>
      verifyWalletSignatureWithNonce(payload, "update", walletAddress)
    ).not.toThrow();
  });

  it("rejects a replayed valid message (nonce already consumed)", () => {
    const kp = makeWallet();
    const walletAddress = bs58Encode(kp.publicKey);
    const nonce = issueNonce("update", walletAddress);
    const payload = makeSignedPayload(kp, "update", walletAddress, nonce);

    // First use succeeds
    verifyWalletSignatureWithNonce(payload, "update", walletAddress);

    // Replay: same payload, same nonce — must fail
    expect(() =>
      verifyWalletSignatureWithNonce(payload, "update", walletAddress)
    ).toThrow(/nonce/i);
  });

  it("rejects a forged signature", () => {
    const kp = makeWallet();
    const walletAddress = bs58Encode(kp.publicKey);
    const nonce = issueNonce("update", walletAddress);
    const payload = makeSignedPayload(kp, "update", walletAddress, nonce);

    // Corrupt signature (replace with zeros in base58)
    const zeroSig = bs58Encode(new Uint8Array(64));
    expect(() =>
      verifyWalletSignatureWithNonce(
        { ...payload, signature: zeroSig },
        "update",
        walletAddress,
      )
    ).toThrow(/signature/i);
  });

  it("rejects a signature from a different wallet (cross-wallet attack)", () => {
    const kp1 = makeWallet();
    const kp2 = makeWallet();
    const victim   = bs58Encode(kp1.publicKey);
    const attacker = bs58Encode(kp2.publicKey);

    const nonce = issueNonce("update", victim);
    const message = buildProfileSignMessage("update", victim, nonce);

    // Attacker signs the victim's message with their own key
    const sigBytes  = nacl.sign.detached(new TextEncoder().encode(message), kp2.secretKey);
    const signature = bs58Encode(sigBytes);

    expect(() =>
      verifyWalletSignatureWithNonce(
        { walletAddress: attacker, signature, message },
        "update",
        victim,
      )
    ).toThrow(); // either message-prefix mismatch or sig verification failure
  });

  it("rejects message with wrong action prefix", () => {
    const kp = makeWallet();
    const walletAddress = bs58Encode(kp.publicKey);
    const nonce = issueNonce("create", walletAddress);
    const payload = makeSignedPayload(kp, "create", walletAddress, nonce);

    // Server expects "update" but message says "create"
    expect(() =>
      verifyWalletSignatureWithNonce(payload, "update", walletAddress)
    ).toThrow();
  });

  it("accepts a valid signed nonce message for 'follow' action", () => {
    const kp = makeWallet();
    const walletAddress = bs58Encode(kp.publicKey);
    const nonce = issueNonce("follow", walletAddress);
    const payload = makeSignedPayload(kp, "follow", walletAddress, nonce);
    expect(() =>
      verifyWalletSignatureWithNonce(payload, "follow", walletAddress)
    ).not.toThrow();
  });

  it("rejects a 'create'-action nonce when the endpoint expects 'follow'", () => {
    const kp = makeWallet();
    const walletAddress = bs58Encode(kp.publicKey);
    // Issue a nonce for "create" — wrong action for a follow endpoint
    const nonce = issueNonce("create", walletAddress);
    // Sign the message with the correct create prefix
    const payload = makeSignedPayload(kp, "create", walletAddress, nonce);
    // Server verifying "follow" must reject it
    expect(() =>
      verifyWalletSignatureWithNonce(payload, "follow", walletAddress)
    ).toThrow();
  });

  it("rejects a malformed message (too few segments)", () => {
    const kp = makeWallet();
    const walletAddress = bs58Encode(kp.publicKey);
    const sigBytes = nacl.sign.detached(new TextEncoder().encode("bad"), kp.secretKey);
    expect(() =>
      verifyWalletSignatureWithNonce(
        { walletAddress, signature: bs58Encode(sigBytes), message: "bad" },
        "update",
        walletAddress,
      )
    ).toThrow(/malformed/i);
  });
});

// ── parseWalletAuthFields ─────────────────────────────────────────────────────

describe("parseWalletAuthFields", () => {
  it("returns fields when all three are present and non-empty", () => {
    const result = parseWalletAuthFields({
      walletAddress: "1".repeat(32),
      signature: "abc",
      message: "Pumpi:update:addr:nonce",
    });
    expect(result).not.toBeNull();
    expect(result?.walletAddress).toBe("1".repeat(32));
  });

  it("returns null when walletAddress is missing", () => {
    expect(parseWalletAuthFields({ signature: "sig", message: "msg" })).toBeNull();
  });

  it("returns null when signature is missing", () => {
    expect(
      parseWalletAuthFields({ walletAddress: "1".repeat(32), message: "msg" })
    ).toBeNull();
  });

  it("returns null when message is missing", () => {
    expect(
      parseWalletAuthFields({ walletAddress: "1".repeat(32), signature: "sig" })
    ).toBeNull();
  });

  it("returns null when body is not an object", () => {
    expect(parseWalletAuthFields(null)).toBeNull();
    expect(parseWalletAuthFields("string")).toBeNull();
    expect(parseWalletAuthFields(42)).toBeNull();
  });

  it("returns null when walletAddress is shorter than 32 chars", () => {
    expect(
      parseWalletAuthFields({ walletAddress: "short", signature: "sig", message: "msg" })
    ).toBeNull();
  });
});
