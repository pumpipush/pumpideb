/**
 * solanaConnection.ts — Solana RPC connections for the frontend.
 *
 * TWO separate connections with different priorities:
 *
 *   getConnection()     — TRANSACTION connection (Alchemy if key set)
 *     Used for: sendRawTransaction, getLatestBlockhash, confirmTransaction
 *     Needs: high reliability, fast block propagation, low latency
 *
 *   getReadConnection() — READ-ONLY connection (PublicNode free)
 *     Used for: getBalance, getTokenAccountsByOwner (balance polling)
 *     Needs: correctness only; polling means staleness of 1-2 blocks is fine
 *     Saves: ~10 Alchemy CUs × every 30s × every open tab — adds up fast
 */

import { Connection } from "@solana/web3.js";

const PUBLICNODE = "https://solana-rpc.publicnode.com";

function getTxRpc(): string {
  const alchemyKey = (import.meta as any).env?.VITE_ALCHEMY_API_KEY as string | undefined;
  if (alchemyKey) return `https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}`;

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
] as const;

// ── Transaction connection (Alchemy) ──────────────────────────────────────────
let _txConnection: Connection | null = null;

/**
 * Shared connection for transaction-critical operations:
 * sendRawTransaction, getLatestBlockhash, confirmTransaction.
 * Uses Alchemy when VITE_ALCHEMY_API_KEY is set for reliable delivery.
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
