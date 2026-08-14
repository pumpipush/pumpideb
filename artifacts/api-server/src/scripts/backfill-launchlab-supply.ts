/**
 * backfill-launchlab-supply.ts — one-shot correction of LaunchLab token rows
 * that were stored with the hardcoded 1B default supply before per-token
 * on-chain supply fetching was added.
 *
 * Context
 * ───────
 * Prior to the supply-fix deployment, every new LaunchLab token was inserted
 * with `totalSupply = '1000000000000000'` (1B tokens × 10^6 decimals). Tokens
 * with a non-standard supply (e.g. USD1 or other custom-supply tokens) therefore
 * showed wildly wrong market caps because the MC formula multiplies `totalSupply`
 * by the SOL/token ratio from the bonding curve.
 *
 * The live enrichment loop (`backfillLaunchLabSupply`) runs at startup and
 * corrects these rows automatically. This script provides the same operation
 * as a standalone, manually-runnable command — useful for:
 *   • Verifying the backfill status on production without restarting the server
 *   • Re-running after a fresh data restore or migration
 *   • Dry-run auditing before committing changes
 *
 * Safety
 * ──────
 * • Safe to re-run: standard-1B rows and RPC-failed rows are skipped (no DB write).
 * • Dry-run mode (--dry-run): prints what would be written without touching the DB.
 * • Rate-limited: 150 ms pause between pages of 20 tokens, ~8 RPC calls/s max.
 *
 * Usage
 * ─────
 *   # Live run (writes corrections):
 *   DATABASE_URL=postgres://... npx tsx src/scripts/backfill-launchlab-supply.ts
 *
 *   # Dry run (audit only, no DB writes):
 *   DATABASE_URL=postgres://... npx tsx src/scripts/backfill-launchlab-supply.ts --dry-run
 */

import { and, eq, gt } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { fetchMintTotalSupply }        from "../lib/adapters/raydium-launchlab.js";
import { computeSupplyBackfillUpdate, LL_DEFAULT_SUPPLY_STR } from "../lib/enrichment.js";

// ── Config ────────────────────────────────────────────────────────────────────

const PAGE_SIZE      = 20;   // rows per DB page — small to avoid RPC bursts
const PAGE_DELAY_MS  = 150;  // pause between pages to pace free RPC usage
const isDryRun       = process.argv.includes("--dry-run");

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    isDryRun
      ? "🔍  DRY-RUN MODE — no DB writes will be made"
      : "🔧  LIVE MODE — corrections will be written to the database",
  );
  console.log(`   Querying LaunchLab tokens with totalSupply = '${LL_DEFAULT_SUPPLY_STR}' …\n`);

  let cursor    = "";       // keyset cursor — "" sorts before all valid base58 addresses
  let totalSeen = 0;
  let corrected = 0;
  let skipped   = 0;        // standard-1B (supply on-chain also = 1B)
  let rpcFailed = 0;        // fetchMintTotalSupply returned null

  for (;;) {
    const page = await db
      .select({ address: tokensTable.address, priceEth: tokensTable.priceEth })
      .from(tokensTable)
      .where(
        and(
          eq(tokensTable.platform, "raydium_launchlab"),
          eq(tokensTable.totalSupply, LL_DEFAULT_SUPPLY_STR),
          gt(tokensTable.address, cursor),
        ),
      )
      .orderBy(tokensTable.address)
      .limit(PAGE_SIZE);

    if (page.length === 0) break;

    cursor     = page[page.length - 1]!.address;
    totalSeen += page.length;

    for (const { address, priceEth } of page) {
      try {
        const realSupply = await fetchMintTotalSupply(address);

        if (realSupply === null) {
          rpcFailed++;
          console.log(`  ⚠  ${address}  — RPC failed, will retry on next server restart`);
          continue;
        }

        const update = computeSupplyBackfillUpdate(realSupply, priceEth);

        if (!update) {
          // realSupply === LL_DEFAULT_SUPPLY_STR — token is standard 1B, no fix needed
          skipped++;
          continue;
        }

        // Non-standard supply found — apply (or preview) the correction
        if (isDryRun) {
          console.log(
            `  📋 ${address}  ` +
            `totalSupply: ${update.totalSupply}  ` +
            (update.marketCapEth ? `marketCapEth: ${update.marketCapEth}` : "marketCapEth: (no price — will skip)"),
          );
        } else {
          await db.update(tokensTable)
            .set(update)
            .where(eq(tokensTable.address, address));
          console.log(
            `  ✅ ${address}  ` +
            `supply corrected → ${update.totalSupply}` +
            (update.marketCapEth ? `  mcEth → ${update.marketCapEth}` : ""),
          );
        }

        corrected++;
      } catch (err) {
        rpcFailed++;
        console.error(`  ❌ ${address}  — unexpected error:`, err);
      }
    }

    // Brief pause between pages to stay within free RPC rate limits
    if (page.length === PAGE_SIZE) {
      await new Promise<void>(r => setTimeout(r, PAGE_DELAY_MS));
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n────────────────────────────────────────");
  if (totalSeen === 0) {
    console.log("✅  No LaunchLab tokens with legacy-default supply found — nothing to do.");
  } else {
    console.log(`Total rows scanned  : ${totalSeen}`);
    console.log(`Standard 1B (skipped): ${skipped}`);
    console.log(`RPC failures (skipped): ${rpcFailed}`);
    if (isDryRun) {
      console.log(`Would correct       : ${corrected}`);
      console.log("\n↑  Re-run without --dry-run to apply these changes.");
    } else {
      console.log(`Corrected           : ${corrected}`);
      if (rpcFailed > 0) {
        console.log(
          "\nℹ  Some tokens failed RPC — re-run this script (or restart the server) to retry them.",
        );
      }
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
