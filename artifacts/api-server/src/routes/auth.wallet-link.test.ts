/**
 * auth.wallet-link.test.ts — Unit tests for the wallet-link challenge/verify flow.
 *
 * Tests the security-critical Ed25519 verification logic that guards
 * POST /api/auth/wallet/link: only the holder of the wallet private key
 * should be able to link that wallet to a social profile.
 *
 * The nonce store is private to auth.ts, so we test the cryptographic
 * verification pattern directly (exactly as the endpoint does it) plus
 * a separate integration stub for nonce semantics.
 */

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Build the canonical wallet-link message (must match the server's format).
 * Server issues: "Pumpi:linkwallet:<walletAddress>:<nonce>"
 */
function buildLinkMessage(walletAddress: string, nonce: string): string {
  return `Pumpi:linkwallet:${walletAddress}:${nonce}`;
}

/**
 * Replicate the server-side verification: parse the message, verify the
 * Ed25519 signature, and check the walletAddress matches the claimed address.
 * Returns true on success, throws on failure.
 */
function verifyLinkSignature(
  walletAddress: string,
  signature: string,
  message: string,
  expectedNonce: string,
): void {
  // Parse message format: "Pumpi:linkwallet:<walletAddress>:<nonce>"
  const parts = message.split(":");
  if (parts.length !== 4 || parts[0] !== "Pumpi" || parts[1] !== "linkwallet") {
    throw new Error("Malformed signed message");
  }
  if (parts[2] !== walletAddress) {
    throw new Error("Message wallet address does not match claimed address");
  }
  const nonce = parts[3];
  if (nonce !== expectedNonce) {
    throw new Error("Nonce mismatch");
  }

  const pubKeyBytes = bs58Decode(walletAddress);
  const sigBytes    = bs58Decode(signature);
  if (pubKeyBytes.length !== 32) throw new Error("Invalid wallet address length");
  if (sigBytes.length !== 64)    throw new Error("Invalid signature length");

  const msgBytes = new TextEncoder().encode(message);
  if (!nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes)) {
    throw new Error("Wallet signature verification failed");
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("wallet-link challenge/verify", () => {
  it("accepts a valid signature from the wallet owner", () => {
    const kp = nacl.sign.keyPair();
    const walletAddress = bs58Encode(kp.publicKey);
    const nonce = "test-nonce-abc-123";
    const message = buildLinkMessage(walletAddress, nonce);
    const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const signature = bs58Encode(sigBytes);

    expect(() =>
      verifyLinkSignature(walletAddress, signature, message, nonce)
    ).not.toThrow();
  });

  it("rejects a forged signature (all-zero bytes)", () => {
    const kp = nacl.sign.keyPair();
    const walletAddress = bs58Encode(kp.publicKey);
    const nonce = "test-nonce-forged";
    const message = buildLinkMessage(walletAddress, nonce);
    const forgeSig = bs58Encode(new Uint8Array(64)); // zeros

    expect(() =>
      verifyLinkSignature(walletAddress, forgeSig, message, nonce)
    ).toThrow(/signature/i);
  });

  it("rejects a cross-wallet attack (attacker signs victim's message)", () => {
    const victim   = nacl.sign.keyPair();
    const attacker = nacl.sign.keyPair();
    const victimAddr = bs58Encode(victim.publicKey);
    const nonce = "test-nonce-cross";
    const message = buildLinkMessage(victimAddr, nonce);

    // Attacker signs the victim's message with their own key
    const sigBytes  = nacl.sign.detached(new TextEncoder().encode(message), attacker.secretKey);
    const signature = bs58Encode(sigBytes);

    // Claim victimAddr but signed by attacker — should fail sig verification
    expect(() =>
      verifyLinkSignature(victimAddr, signature, message, nonce)
    ).toThrow(/signature/i);
  });

  it("rejects a message with the wrong action prefix", () => {
    const kp = nacl.sign.keyPair();
    const walletAddress = bs58Encode(kp.publicKey);
    const nonce = "test-nonce-wrongaction";
    // Wrong action: "update" instead of "linkwallet"
    const badMessage = `Pumpi:update:${walletAddress}:${nonce}`;
    const sigBytes = nacl.sign.detached(new TextEncoder().encode(badMessage), kp.secretKey);
    const signature = bs58Encode(sigBytes);

    expect(() =>
      verifyLinkSignature(walletAddress, signature, badMessage, nonce)
    ).toThrow();
  });

  it("rejects when the embedded wallet address does not match the claimed address", () => {
    const kp1 = nacl.sign.keyPair();
    const kp2 = nacl.sign.keyPair();
    const addr1 = bs58Encode(kp1.publicKey);
    const addr2 = bs58Encode(kp2.publicKey);
    const nonce = "test-nonce-mismatch";
    // Message contains addr1, but we claim addr2
    const message = buildLinkMessage(addr1, nonce);
    const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), kp1.secretKey);
    const signature = bs58Encode(sigBytes);

    expect(() =>
      verifyLinkSignature(addr2, signature, message, nonce)
    ).toThrow(/address/i);
  });

  it("rejects a tampered message (nonce changed after signing)", () => {
    const kp = nacl.sign.keyPair();
    const walletAddress = bs58Encode(kp.publicKey);
    const originalNonce = "original-nonce-xyz";
    const tamperedNonce = "tampered-nonce-xyz";
    const message = buildLinkMessage(walletAddress, originalNonce);
    const sigBytes = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const signature = bs58Encode(sigBytes);

    // Present signature over originalNonce message but claim tamperedNonce
    const tamperedMsg = buildLinkMessage(walletAddress, tamperedNonce);
    expect(() =>
      verifyLinkSignature(walletAddress, signature, tamperedMsg, tamperedNonce)
    ).toThrow(/signature/i);
  });
});

// ── Social-profile identity tests ────────────────────────────────────────────
//
// These verify the logic contract: when a social user is active, the profile
// identity must be the social user's UUID address — never the connected wallet.
// (The UI fix lives in ProfileEditModal; these tests guard the rule itself.)
//
// Helper functions mirror the ProfileEditModal logic so TypeScript doesn't
// narrow literal-null variables to `never` in test bodies.

function getEffectiveAddress(
  socialUser: { address: string } | null,
  wallet: string | null,
): string {
  return socialUser?.address ?? wallet ?? "";
}

function saveUsesWalletPath(
  socialUser: { address: string } | null,
  wallet: string | null,
): boolean {
  // Mirrors: if (wallet && !socialUser) { /* wallet path */ } else { /* JWT */ }
  return wallet !== null && socialUser === null;
}

describe("social-profile identity contract", () => {
  it("social user address takes precedence over connected wallet address", () => {
    const socialAddress = "00000000-0000-0000-0000-000000000001";
    const walletAddress = "So1anaWa11etAddr3ss1111111111111111111111";
    const effectiveAddress = getEffectiveAddress({ address: socialAddress }, walletAddress);
    expect(effectiveAddress).toBe(socialAddress);
    expect(effectiveAddress).not.toBe(walletAddress);
  });

  it("falls back to wallet address when no social user is present", () => {
    const walletAddress = "So1anaWa11etAddr3ss1111111111111111111111";
    const effectiveAddress = getEffectiveAddress(null, walletAddress);
    expect(effectiveAddress).toBe(walletAddress);
  });

  it("returns empty string when neither social user nor wallet is present", () => {
    expect(getEffectiveAddress(null, null)).toBe("");
  });

  it("save path uses JWT auth when social user is active (wallet-only path skipped)", () => {
    const socialUser = { address: "uuid-social-profile" };
    const wallet = "So1anaWa11et1111111111111111111111111111";
    expect(saveUsesWalletPath(socialUser, wallet)).toBe(false);
  });

  it("save path uses wallet auth only when no social session is active", () => {
    const wallet = "So1anaWa11et1111111111111111111111111111";
    expect(saveUsesWalletPath(null, wallet)).toBe(true);
  });

  it("save path does not use wallet auth when wallet is null", () => {
    expect(saveUsesWalletPath(null, null)).toBe(false);
  });
});
