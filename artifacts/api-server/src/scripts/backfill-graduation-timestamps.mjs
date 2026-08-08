#!/usr/bin/env node
/**
 * backfill-graduation-timestamps.mjs
 *
 * One-time backfill: set `graduated_at` for tokens that were already marked
 * `graduated = true` before the `graduated_at` column was added.
 *
 * Strategy: use the timestamp of the most recent trade recorded for the token
 * as a proxy for the graduation time. This is an approximation — the true
 * graduation moment is the Migrate instruction, but that transaction is not
 * stored in the trades table. The last trade on the bonding curve is the
 * closest available timestamp.
 *
 * Safe to re-run: only touches rows where `graduated = true AND graduated_at IS NULL`.
 *
 * Run:
 *   DATABASE_URL=postgres://... node artifacts/api-server/src/scripts/backfill-graduation-timestamps.mjs
 *
 * Dry-run (report only, no writes):
 *   DRY_RUN=1 DATABASE_URL=... node artifacts/api-server/src/scripts/backfill-graduation-timestamps.mjs
 */

import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN      = process.env.DRY_RUN === "1";

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

async function main() {
  console.log(`=== Graduation timestamp backfill${DRY_RUN ? " (DRY RUN)" : ""} ===\n`);

  // ── Count tokens needing backfill ─────────────────────────────────────────
  const { rows: [{ needs_backfill }] } = await pool.query(`
    SELECT COUNT(*) AS needs_backfill
    FROM   tokens
    WHERE  graduated     = TRUE
      AND  graduated_at IS NULL
  `);
  console.log(`Tokens with graduated=true and graduated_at=NULL: ${needs_backfill}`);

  if (parseInt(needs_backfill, 10) === 0) {
    console.log("Nothing to do — all graduated tokens already have graduated_at set.");
    await pool.end();
    return;
  }

  // ── Preview what will be updated ──────────────────────────────────────────
  const { rows: preview } = await pool.query(`
    SELECT
      t.address,
      t.name,
      t.symbol,
      latest.last_trade_ts
    FROM tokens t
    JOIN (
      SELECT DISTINCT ON (token_address)
             token_address,
             timestamp AS last_trade_ts
      FROM   trades
      WHERE  token_address IN (
               SELECT address FROM tokens
               WHERE  graduated = TRUE AND graduated_at IS NULL
             )
      ORDER BY token_address, id DESC
    ) latest ON latest.token_address = t.address
    WHERE t.graduated    = TRUE
      AND t.graduated_at IS NULL
    ORDER BY latest.last_trade_ts DESC
    LIMIT 10
  `);

  if (preview.length > 0) {
    console.log("\nSample rows to be updated (up to 10):");
    for (const r of preview) {
      console.log(`  ${r.address.slice(0, 8)}…  ${r.symbol.padEnd(10)}  last_trade=${r.last_trade_ts?.toISOString() ?? "null"}`);
    }
  }

  // ── Tokens with no trades at all ──────────────────────────────────────────
  const { rows: [{ no_trades }] } = await pool.query(`
    SELECT COUNT(*) AS no_trades
    FROM   tokens t
    WHERE  t.graduated    = TRUE
      AND  t.graduated_at IS NULL
      AND  NOT EXISTS (
             SELECT 1 FROM trades tr WHERE tr.token_address = t.address
           )
  `);
  if (parseInt(no_trades, 10) > 0) {
    console.log(`\nNote: ${no_trades} graduated token(s) have no trades — graduated_at will remain NULL for those.`);
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — no writes performed.");
    await pool.end();
    return;
  }

  // ── Perform the backfill ───────────────────────────────────────────────────
  // Use the timestamp of the most-recently-inserted trade (ORDER BY id DESC)
  // as the graduation time approximation.
  const { rowCount } = await pool.query(`
    UPDATE tokens t
    SET    graduated_at = latest.last_trade_ts
    FROM (
      SELECT DISTINCT ON (token_address)
             token_address,
             timestamp AS last_trade_ts
      FROM   trades
      ORDER BY token_address, id DESC
    ) latest
    WHERE t.address      = latest.token_address
      AND t.graduated    = TRUE
      AND t.graduated_at IS NULL
  `);

  console.log(`\nUpdated ${rowCount} token row(s) with graduated_at.`);

  // ── Final assertion ────────────────────────────────────────────────────────
  const { rows: [assertion] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE graduated = TRUE)                  AS total_graduated,
      COUNT(*) FILTER (WHERE graduated = TRUE AND graduated_at IS NOT NULL) AS with_ts,
      COUNT(*) FILTER (WHERE graduated = TRUE AND graduated_at IS NULL)     AS without_ts
    FROM tokens
  `);

  console.log("\n── Assertion ───────────────────────────────────────────────────────");
  console.log(`  Total graduated tokens   : ${assertion.total_graduated}`);
  console.log(`  With    graduated_at     : ${assertion.with_ts}`);
  console.log(`  Without graduated_at     : ${assertion.without_ts}  (tokens with no recorded trades)`);

  const remaining = parseInt(assertion.without_ts, 10);
  const noTradesCount = parseInt(no_trades, 10);

  if (remaining > noTradesCount) {
    // More tokens lack graduated_at than can be explained by missing trades
    console.error(
      `\nASSERTION FAILED: ${remaining - noTradesCount} token(s) unexpectedly still missing graduated_at`
    );
    process.exitCode = 1;
  } else {
    console.log(`\n✓ Backfill complete — ${assertion.with_ts} graduated token(s) now have graduated_at set`);
  }

  await pool.end();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
