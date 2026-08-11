/**
 * solanaConnection.ts — singleton Solana RPC connection for the frontend.
 *
 * Priority order:
 *   1. VITE_ALCHEMY_API_KEY — Alchemy premium endpoint (fast, high rate limits)
 *   2. VITE_SOLANA_RPC_URL  — custom override (any RPC URL)
 *   3. PublicNode free RPC  — keyless fallback
 */

import { Connection } from "@solana/web3.js";

function getPrimaryRpc(): string {
  const alchemyKey = (import.meta as any).env?.VITE_ALCHEMY_API_KEY as string | undefined;
  if (alchemyKey) return `https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}`;

  const custom = (import.meta as any).env?.VITE_SOLANA_RPC_URL as string | undefined;
  if (custom) return custom;

  return "https://solana-rpc.publicnode.com";
}

export const PRIMARY_RPC = getPrimaryRpc();

/** Ordered list of HTTP RPC endpoints — primary first, then free fallbacks */
export const RPC_ENDPOINTS = [
  PRIMARY_RPC,
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
] as const;

let _connection: Connection | null = null;

/**
 * Return the shared Solana Connection instance, creating it on first call.
 * "confirmed" commitment matches what the indexer uses for all reads.
 */
export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(PRIMARY_RPC, "confirmed");
  }
  return _connection;
}

/**
 * Force-reset the cached connection (e.g. after an RPC error so the next
 * call to getConnection() will create a fresh instance).
 */
export function resetConnection(): void {
  _connection = null;
}
