/**
 * solanaConnection.ts — Solana RPC connections for the frontend.
 *
 * TWO separate connections:
 *
 *   getConnection()     — TRANSACTION connection (PublicNode, with fallbacks)
 *     Used for: sendRawTransaction, getLatestBlockhash, confirmTransaction
 *
 *   getReadConnection() — READ-ONLY connection (PublicNode free)
 *     Used for: getBalance, getTokenAccountsByOwner (balance polling)
 *     Staleness of 1-2 blocks is acceptable for balance displays.
 */

import { Connection } from "@solana/web3.js";

const PUBLICNODE = "https://solana-rpc.publicnode.com";

function getTxRpc(): string {
  // Allow override via env var for self-hosted or premium RPCs
  const custom = (import.meta as any).env?.VITE_SOLANA_RPC_URL as string | undefined;
  if (custom) return custom;
  return PUBLICNODE;
}

export const PRIMARY_RPC = getTxRpc();

/** Ordered list of HTTP RPC endpoints — primary first, then free fallbacks */
export const RPC_ENDPOINTS = [
  PRIMARY_RPC,
  PUBLICNODE,
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
] as const;

// ── Transaction connection ────────────────────────────────────────────────────
let _txConnection: Connection | null = null;

/**
 * Shared connection for transaction-critical operations:
 * sendRawTransaction, getLatestBlockhash, confirmTransaction.
 */
export function getConnection(): Connection {
  if (!_txConnection) {
    _txConnection = new Connection(PRIMARY_RPC, "confirmed");
  }
  return _txConnection;
}

// ── Read-only connection (PublicNode free) ────────────────────────────────────
let _readConnection: Connection | null = null;

/**
 * Shared connection for balance polling and read-only queries.
 * Always uses free PublicNode — no Alchemy CUs consumed for polling.
 * Staleness of 1-2 blocks is acceptable for balance displays.
 */
export function getReadConnection(): Connection {
  if (!_readConnection) {
    _readConnection = new Connection(PUBLICNODE, "confirmed");
  }
  return _readConnection;
}

/**
 * Force-reset the cached connections (e.g. after an RPC error so the next
 * call will create fresh instances).
 */
export function resetConnection(): void {
  _txConnection = null;
  _readConnection = null;
}

// ── Multi-RPC fanout broadcast ────────────────────────────────────────────────
//
// Sending a raw transaction to only one RPC is unreliable — if that node is
// not well-connected to validators, the tx may never land even with maxRetries.
// Broadcasting to ALL configured endpoints in parallel significantly increases
// the landing rate at zero extra cost (all endpoints are free).
//
// The transaction signature is deterministic (it's the Ed25519 signature
// already embedded in the serialized bytes), so all endpoints return the same
// value. We fire-and-forget to the secondary endpoints and return the first
// signature we receive (from whichever endpoint responds first).

/**
 * Broadcast a signed transaction to all configured RPC endpoints simultaneously.
 *
 * Returns the transaction signature (same value regardless of which endpoint
 * confirmed receipt first). Errors from individual endpoints are suppressed as
 * long as at least one endpoint accepts the transaction.
 *
 * @param serializedTx  Result of `transaction.serialize()`
 */
export async function broadcastWithFanout(serializedTx: Uint8Array): Promise<string> {
  const opts = { skipPreflight: true, maxRetries: 3 } as const;

  // Deduplicate endpoints in case PRIMARY_RPC is the same as PUBLICNODE.
  const endpoints = [...new Set(RPC_ENDPOINTS)];

  // Broadcast to all endpoints in parallel. Use Promise.any so we resolve
  // as soon as ONE endpoint accepts the tx, and we only fail if ALL reject.
  try {
    const signature = await Promise.any(
      endpoints.map(async (url) => {
        const conn = new Connection(url, "confirmed");
        return conn.sendRawTransaction(serializedTx, opts);
      }),
    );
    return signature;
  } catch {
    // All endpoints rejected — fall back to the primary and let its error
    // propagate with the original message for easier debugging.
    const conn = new Connection(PRIMARY_RPC, "confirmed");
    return conn.sendRawTransaction(serializedTx, opts);
  }
}
