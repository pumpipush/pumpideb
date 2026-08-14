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
 * Concurrency safety
 * ──────────────────
 * The UPDATE uses a compare-and-set WHERE guard:
 *   WHERE address = $addr AND total_supply = '1000000000000000'
 *
 * If another process (e.g. server restart triggering the startup backfill) has
 * already corrected a row between this script's SELECT and UPDATE, the guard
 * rejects the write (0 rows matched) and the row is not double-counted.
 *
 * marketCapEth is computed from the current price_eth column value at write time
 * (SQL expression), not from the stale value read during the page scan. A trade
 * that lands between SELECT and UPDATE is therefore reflected in the new MC.
 *
 * Safety
 * ──────
 * • Safe to re-run: standard-1B rows and RPC-failed rows are skipped (no write).
 * • --dry-run mode: prints what would be written without touching the DB.
 * • Rate-limited: 150 ms pause between pages of 20 tokens, ~8 RPC calls/s max.
 *
 * Usage
 * ─────
 *   # Build first (or let the package script handle it):
 *   pnpm --filter @workspace/api-server backfill:launchlab-supply
 *   pnpm --filter @workspace/api-server backfill:launchlab-supply -- --dry-run
 *
 *   # Or run from source during development:
 *   DATABASE_URL=postgres://... npx tsx src/scripts/backfill-launchlab-supply.ts [--dry-run]
 */

import { and, eq, gt, sql } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { fetchMintTotalSupply }          from "../lib/adapters/raydium-launchlab.js";
import { LL_DEFAULT_SUPPLY_STR }         from "../lib/enrichment.js";

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

  let cursor    = "";   // keyset cursor — "" sorts before all valid base58 addresses
  let totalSeen = 0;
  let corrected = 0;   // rows actually updated (WHERE guard matched)
  let skipped   = 0;   // standard-1B supply on-chain (no correction needed)
  let rpcFailed = 0;   // fetchMintTotalSupply returned null
  let concurrent = 0; // concurrent fix already applied (returning() = 0 rows)

  for (;;) {
    const page = await db
      .select({ address: tokensTable.address })
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

    for (const { address } of page) {
      try {
        const realSupply = await fetchMintTotalSupply(address);

        if (realSupply === null) {
          rpcFailed++;
          console.log(`  ⚠  ${address}  — RPC failed, will retry on next run`);
          continue;
        }

        if (realSupply.toString() === LL_DEFAULT_SUPPLY_STR) {
          // On-chain supply is genuinely 1B — this is a standard LaunchLab token.
          skipped++;
          continue;
        }

        const supplyStr = realSupply.toString();

        if (isDryRun) {
          console.log(
            `  📋 ${address}  ` +
            `totalSupply: ${supplyStr}  ` +
            `marketCapEth: (computed from current price_eth at write time)`,
          );
          corrected++;
          continue;
        }

        // Compare-and-set UPDATE:
        //   WHERE totalSupply = LL_DEFAULT_SUPPLY_STR prevents this write from
        //   overwriting a correction already applied by a concurrent process
        //   (e.g. server restart running backfillLaunchLabSupply) between our
        //   SELECT and this UPDATE.
        //
        // marketCapEth uses the current price_eth column value at write time —
        // not the value from the page SELECT — so a trade that landed between
        // the SELECT and this UPDATE is reflected in the corrected market cap.
        const [updated] = await db.update(tokensTable)
          .set({
            totalSupply:  supplyStr,
            marketCapEth: sql<string>`
              CASE
                WHEN price_eth IS NOT NULL AND CAST(price_eth AS numeric) > 0
                THEN ROUND(CAST(price_eth AS numeric) * CAST(${supplyStr} AS numeric) * 1000)::text
                ELSE market_cap_eth
              END
            `,
          })
          .where(and(
            eq(tokensTable.address, address),
            eq(tokensTable.totalSupply, LL_DEFAULT_SUPPLY_STR), // compare-and-set guard
          ))
          .returning({ address: tokensTable.address });

        if (!updated) {
          // 0 rows matched: a concurrent process already corrected this row
          // between our SELECT and this UPDATE — do not double-count it.
          concurrent++;
          continue;
        }

        corrected++;
        console.log(`  ✅ ${address}  supply corrected → ${supplyStr}`);
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
    console.log(`Total rows scanned       : ${totalSeen}`);
    console.log(`Standard 1B (skipped)    : ${skipped}`);
    console.log(`RPC failures (skipped)   : ${rpcFailed}`);
    if (concurrent > 0) {
      console.log(`Concurrent fixes (skipped): ${concurrent}`);
    }
    if (isDryRun) {
      console.log(`Would correct            : ${corrected}`);
      console.log("\n↑  Re-run without --dry-run to apply these changes.");
    } else {
      console.log(`Corrected                : ${corrected}`);
      if (rpcFailed > 0) {
        console.log(
          "\nℹ  Some tokens failed RPC — re-run this script to retry them.",
        );
      }
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
