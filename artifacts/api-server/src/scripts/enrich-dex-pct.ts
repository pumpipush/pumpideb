/**
 * enrich-dex-pct.ts — one-off script to populate pct_change_24h for DEX tokens.
 * Calls Birdeye token_overview for top DEX tokens that are missing pct_change_24h.
 * Safe to re-run; only updates tokens where pct_change_24h IS NULL.
 */

import { db, pool } from "@workspace/db";
import { fetchBirdeyeTokenOverview } from "../lib/birdeye.js";

const BATCH_DELAY_MS = 150;
const MAX_TOKENS     = 300;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log("[enrich-dex-pct] Starting pct_change_24h enrichment for DEX tokens...");

  const { rows } = await pool.query<{ address: string; symbol: string; platform: string }>(`
    SELECT address, symbol, platform
    FROM   tokens
    WHERE  platform IN ('raydium', 'orca', 'meteora', 'pumpswap', 'raydium_launchlab')
      AND  pct_change_24h IS NULL
    ORDER  BY liquidity_usd DESC NULLS LAST
    LIMIT  $1
  `, [MAX_TOKENS]);

  console.log(`[enrich-dex-pct] ${rows.length} tokens to enrich`);
  let updated = 0, skipped = 0;

  for (const token of rows) {
    const overview = await fetchBirdeyeTokenOverview(token.address);
    if (overview && overview.priceChange24hPercent !== null) {
      await pool.query(
        `UPDATE tokens SET pct_change_24h = $1, price_usd = COALESCE(price_usd, $2), market_cap_usd = COALESCE(market_cap_usd, $3), liquidity_usd = COALESCE(liquidity_usd, $4) WHERE address = $5`,
        [overview.priceChange24hPercent, overview.price, overview.mc, overview.liquidity, token.address]
      );
      updated++;
      if (updated % 20 === 0) {
        console.log(`[enrich-dex-pct] ${updated}/${rows.length} updated (last: ${token.symbol} ${token.platform} pct=${overview.priceChange24hPercent?.toFixed(2)}%)`);
      }
    } else {
      skipped++;
    }
    await sleep(BATCH_DELAY_MS);
  }

  console.log(`[enrich-dex-pct] Done — updated: ${updated}, skipped (no Birdeye data): ${skipped}`);
  process.exit(0);
}

main().catch(err => {
  console.error("[enrich-dex-pct] Fatal:", err);
  process.exit(1);
});
