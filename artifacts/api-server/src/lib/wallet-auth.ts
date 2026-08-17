/**
 * wallet-auth.ts — Solana Ed25519 wallet signature verification utilities.
 *
 * Solana wallets sign raw bytes with Ed25519 (not a hash). The wallet adapter
 * calls `signMessage(messageBytes)` and returns a 64-byte signature.
 *
 * Convention used here:
 *   message  = "Pumpi:{action}:{tokenAddress}:{unixSeconds}"
 *   signature = base58-encoded 64-byte Ed25519 signature of the UTF-8 message
 *   walletAddress = base58-encoded 32-byte Ed25519 public key
 *
 * The timestamp embedded in the message must be within ±5 minutes of server
 * time to prevent replay attacks.
 */

import nacl from "tweetnacl";
import { timingSafeEqual, randomUUID } from "crypto";

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
  return `Pumpi:${action}:${tokenAddress}:${ts}`;
}

// ── Timestamp validation ───────────────────────────────────────────────────

/**
 * Parse and validate the timestamp embedded in the signed message.
 * Returns the parsed Unix timestamp in seconds, or throws if invalid / expired.
 */
export function parseAndValidateTimestamp(message: string): number {
  // Expected format: "Pumpi:{action}:{tokenAddress}:{unixSeconds}"
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
  const expectedPrefix = `Pumpi:${expectedAction}:${expectedTokenAddress}:`;
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

// ── Single-use nonce store (profile challenge/response auth) ──────────────
//
// Nonces are server-issued, action/address-bound, and atomically consumed on
// first use to prevent replay attacks within the validity window.
// Node.js is single-threaded so Map operations are atomic.

interface NonceEntry {
  address:   string;
  action:    "create" | "update" | "follow";
  expiresAt: number; // ms epoch
}

const nonceStore = new Map<string, NonceEntry>();

// Prune expired nonces periodically so the Map doesn't grow unboundedly.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of nonceStore) {
    if (now > entry.expiresAt) nonceStore.delete(key);
  }
}, 60_000).unref();

/** Issue a fresh single-use nonce tied to one action + wallet address. */
export function issueNonce(action: "create" | "update" | "follow", address: string): string {
  const nonce = randomUUID();
  nonceStore.set(nonce, { address, action, expiresAt: Date.now() + MAX_AGE_SECONDS * 1_000 });
  return nonce;
}

/**
 * Atomically consume a nonce.
 * Returns true only if the nonce exists, has not expired, and matches action + address.
 * The nonce is deleted on the first call regardless of outcome — subsequent calls return false.
 */
export function consumeNonce(
  nonce: string,
  action: "create" | "update" | "follow",
  address: string,
): boolean {
  const entry = nonceStore.get(nonce);
  nonceStore.delete(nonce); // always remove — single-use guarantee
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  return entry.address === address && entry.action === action;
}

/** Build the canonical message string for profile nonce-based auth. */
export function buildProfileSignMessage(
  action: "create" | "update" | "follow",
  address: string,
  nonce: string,
): string {
  return `Pumpi:${action}:${address}:${nonce}`;
}

/**
 * Verify a wallet signature over a profile nonce message.
 * Atomically consumes the nonce (prevents replay even within the validity window).
 * Throws a descriptive Error on any failure.
 */
export function verifyWalletSignatureWithNonce(
  payload: WalletAuthPayload,
  expectedAction: "create" | "update" | "follow",
  expectedAddress: string,
): void {
  const { walletAddress, signature, message } = payload;

  // 0. The signer must be the expected address owner — checked before nonce
  //    consumption so a cross-wallet attempt doesn't burn the victim's nonce.
  if (walletAddress !== expectedAddress) {
    throw new Error("Wallet address does not match the expected profile owner");
  }

  // 1. Validate message structure — exactly 4 colon-separated segments
  const parts = message.split(":");
  if (parts.length !== 4) throw new Error("Malformed signed message");
  const [prefix, action, addr, nonce] = parts;
  if (prefix !== "Pumpi" || action !== expectedAction || addr !== expectedAddress || !nonce) {
    throw new Error("Signed message does not match expected action or address");
  }

  // 2. Verify nonce EXISTS and is valid without consuming it yet.
  //    Consuming before sig verify allows an attacker with a valid nonce but
  //    wrong signature to permanently burn the victim's challenge (DoS).
  const nonceEntry = nonceStore.get(nonce);
  if (!nonceEntry || Date.now() > nonceEntry.expiresAt ||
      nonceEntry.address !== expectedAddress || nonceEntry.action !== expectedAction) {
    throw new Error("Invalid, expired, or already-used challenge nonce");
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
  if (!nacl.sign.detached.verify(messageBytes, sigBytes, pubKeyBytes)) {
    throw new Error("Wallet signature verification failed");
  }

  // 5. Atomically consume nonce only after successful verification.
  //    Single-threaded Node.js guarantees no TOCTOU race here.
  nonceStore.delete(nonce);
}

// ── Wallet auth field parser (shared by POST/PATCH routes) ────────────────

export interface WalletAuthFields {
  walletAddress: string;
  signature:     string;
  message:       string;
}

/**
 * Extract wallet auth fields from a request body.
 * Returns null if any required field is missing or has the wrong type.
 */
export function parseWalletAuthFields(body: unknown): WalletAuthFields | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const walletAddress = b["walletAddress"];
  const signature     = b["signature"];
  const message       = b["message"];
  if (
    typeof walletAddress === "string" && walletAddress.length >= 32 &&
    typeof signature     === "string" && signature.length     >= 1  &&
    typeof message       === "string" && message.length       >= 1
  ) {
    return { walletAddress, signature, message };
  }
  return null;
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
