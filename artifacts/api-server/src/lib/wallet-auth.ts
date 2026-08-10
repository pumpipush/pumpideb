/**
 * wallet-auth.ts — Solana Ed25519 wallet signature verification utilities.
 *
 * Solana wallets sign raw bytes with Ed25519 (not a hash). The wallet adapter
 * calls `signMessage(messageBytes)` and returns a 64-byte signature.
 *
 * Convention used here:
 *   message  = "RocketFi:{action}:{tokenAddress}:{unixSeconds}"
 *   signature = base58-encoded 64-byte Ed25519 signature of the UTF-8 message
 *   walletAddress = base58-encoded 32-byte Ed25519 public key
 *
 * The timestamp embedded in the message must be within ±5 minutes of server
 * time to prevent replay attacks.
 */

import nacl from "tweetnacl";
import { timingSafeEqual } from "crypto";

// ── Tolerance window for timestamp-based replay protection ─────────────────
const MAX_AGE_SECONDS = 300; // 5 minutes

// ── Base58 helpers (same alphabet as Solana) ──────────────────────────────
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

// ── Message construction ───────────────────────────────────────────────────

/**
 * Build the canonical message string that the client must sign.
 * `timestampSeconds` defaults to the current server time (useful for testing).
 */
export function buildSignMessage(
  action: "create" | "update",
  tokenAddress: string,
  timestampSeconds?: number,
): string {
  const ts = timestampSeconds ?? Math.floor(Date.now() / 1000);
  return `RocketFi:${action}:${tokenAddress}:${ts}`;
}

// ── Timestamp validation ───────────────────────────────────────────────────

/**
 * Parse and validate the timestamp embedded in the signed message.
 * Returns the parsed Unix timestamp in seconds, or throws if invalid / expired.
 */
export function parseAndValidateTimestamp(message: string): number {
  // Expected format: "RocketFi:{action}:{tokenAddress}:{unixSeconds}"
  const parts = message.split(":");
  if (parts.length < 4) {
    throw new Error("Malformed signed message");
  }
  const ts = Number(parts[parts.length - 1]);
  if (!Number.isFinite(ts)) {
    throw new Error("Invalid timestamp in signed message");
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - ts;
  if (ageSeconds > MAX_AGE_SECONDS || ageSeconds < -MAX_AGE_SECONDS) {
    throw new Error("Signed message has expired or is from the future");
  }
  return ts;
}

// ── Signature verification ─────────────────────────────────────────────────

export interface WalletAuthPayload {
  /** Base58-encoded Solana wallet public key. */
  walletAddress: string;
  /** Base58-encoded 64-byte Ed25519 signature of the UTF-8 message. */
  signature: string;
  /** The exact string that was signed (must match expected format). */
  message: string;
}

/**
 * Verify that `signature` is a valid Ed25519 signature by `walletAddress`
 * over `message`, and that the message timestamp is fresh.
 *
 * Throws a descriptive Error on any failure so callers can surface 401/403.
 */
export function verifyWalletSignature(
  payload: WalletAuthPayload,
  expectedAction: "create" | "update",
  expectedTokenAddress: string,
): void {
  const { walletAddress, signature, message } = payload;

  // 1. Validate message format and timestamp freshness
  parseAndValidateTimestamp(message);

  // 2. Validate message content matches expected action + token address
  const expectedPrefix = `RocketFi:${expectedAction}:${expectedTokenAddress}:`;
  if (!message.startsWith(expectedPrefix)) {
    throw new Error("Signed message does not match expected action or token address");
  }

  // 3. Decode public key and signature from base58
  let pubKeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubKeyBytes = bs58Decode(walletAddress);
    sigBytes    = bs58Decode(signature);
  } catch (e) {
    throw new Error(`Invalid base58 encoding: ${(e as Error).message}`);
  }

  if (pubKeyBytes.length !== 32) {
    throw new Error(`Invalid wallet address length (expected 32 bytes, got ${pubKeyBytes.length})`);
  }
  if (sigBytes.length !== 64) {
    throw new Error(`Invalid signature length (expected 64 bytes, got ${sigBytes.length})`);
  }

  // 4. Verify Ed25519 signature over raw UTF-8 message bytes
  const messageBytes = new TextEncoder().encode(message);
  const valid = nacl.sign.detached.verify(messageBytes, sigBytes, pubKeyBytes);
  if (!valid) {
    throw new Error("Wallet signature verification failed");
  }
}

// ── Indexer shared secret check ────────────────────────────────────────────

/**
 * Returns true if the `X-Indexer-Secret` request header matches the
 * `SESSION_SECRET` environment variable. Used to authenticate internal
 * indexer/script PATCH calls without a wallet signature.
 */
export function isValidIndexerSecret(headerValue: string | undefined): boolean {
  const secret = process.env["SESSION_SECRET"];
  if (!secret || !headerValue) return false;
  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(headerValue, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
