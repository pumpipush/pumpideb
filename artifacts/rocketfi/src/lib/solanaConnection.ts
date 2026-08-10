/**
 * solanaConnection.ts — singleton Solana RPC connection for the frontend.
 *
 * Uses the same endpoint list as api-server's FALLBACK_HTTP_RPCS so both
 * sides of the app talk to the same set of public nodes.
 *
 * Cache the Connection instance so it isn't rebuilt on every React render
 * (each new Connection() opens a WebSocket internally when needed).
 */

import { Connection } from "@solana/web3.js";

/** Free public Solana HTTP RPC endpoints — ordered by reliability.
 *  Mirror of api-server/src/lib/adapters/solanaRpcBase.ts:FALLBACK_HTTP_RPCS */
export const RPC_ENDPOINTS = [
  "https://solana-rpc.publicnode.com",   // PublicNode — primary (keyless, fast)
  "https://api.mainnet-beta.solana.com", // Solana Foundation — fallback
] as const;

let _connection: Connection | null = null;

/**
 * Return the shared Solana Connection instance, creating it on first call.
 * "confirmed" commitment matches what the indexer uses for all reads.
 */
export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(RPC_ENDPOINTS[0], "confirmed");
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
