/**
 * raydium-amm.ts — stub (PumpSwap indexer belum diimplementasi)
 *
 * Exported functions dipertahankan agar import dari adapter lain (pumpfun.ts) tidak error.
 * startRaydiumAmmAdapter() tidak melakukan apa-apa sampai implementasi siap.
 */

import { logger as rootLogger } from "../logger";

/** Called by pumpfun.ts on each Migrate event — no-op for now. */
export function registerGraduatedMint(mint: string): void {
  rootLogger.debug({ mint }, "raydium_amm: graduated mint noted (indexer not yet active)");
}

/** Called from adapters/index.ts — no-op for now. */
export async function startRaydiumAmmAdapter(): Promise<void> {
  rootLogger.info("raydium_amm: adapter disabled — PumpSwap indexer pending planning");
}
