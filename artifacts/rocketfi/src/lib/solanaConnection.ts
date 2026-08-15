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
