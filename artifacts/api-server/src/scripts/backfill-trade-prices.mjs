#!/usr/bin/env node
/**
 * backfill-trade-prices.mjs
 *
 * Two-pass backfill for pump_fun trades whose `token_amount` and `price_eth`
 * were not recorded due to the parseSwap bug fixed on 2026-08-08.
 *
 * PASS 1 — AMM replay
 *   Walk each token's trades in serial-ID order (auto-increment ID is the
 *   insertion sequence and is more deterministic than `timestamp`, which is
 *   set to wall-clock `new Date()` at ingest time and can be slightly
 *   out-of-block-order under concurrent ingestion).
 *   Re-derive tokenAmount using the constant-product formula:
 *     k  = vSol × vTok  (invariant)
 *     buy:  newVSol = vSol + Δsol  →  tokenOut = vTok - k/newVSol
 *     sell: newVSol = vSol − Δsol  →  tokenIn  = k/newVSol − vTok
 *   Skips rows where price_eth IS NOT NULL (already good).
 *
 * PASS 2 — Price interpolation
 *   For trades that AMM-replay could not fix (diverged state, missing
 *   surrounding trades), use the nearest preceding/following valid price
 *   from the same token to fill the gap (forward-fill then backward-fill).
 *   Derives token_amount from the interpolated price.
 *
 * Safe to re-run: both passes skip rows where price_eth IS NOT NULL.
 *
 * Run:
 *   DATABASE_URL=postgres://... node artifacts/api-server/src/scripts/backfill-trade-prices.mjs
 *
 * Dry-run (report only, no writes):
 *   DRY_RUN=1 DATABASE_URL=... node artifacts/api-server/src/scripts/backfill-trade-prices.mjs
 */

import pg from "pg";

const { Pool } = pg;

// ── Pump.fun bonding curve constants ─────────────────────────────────────────
const PUMP_INIT_VSOL_LAM = 30_000_000_000n;       // 30 virtual SOL in lamports
const PUMP_INIT_VTOK     = 1_073_000_191_045_000n; // virtual token reserves at launch (atomic)

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN      = process.env.DRY_RUN === "1";

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

// ── Pass 1: AMM replay ────────────────────────────────────────────────────────

async function ammReplayToken(client, mint) {
  // Order by serial id (insertion order) — more deterministic than wall-clock
  // timestamp under concurrent ingestion.
  const { rows: trades } = await client.query(`
    SELECT id, is_buy, eth_amount, token_amount, price_eth
    FROM   trades
    WHERE  token_address = $1 AND platform = 'pump_fun'
    ORDER BY id ASC
  `, [mint]);

  if (trades.length === 0) return { updated: 0, errors: 0 };

  let vSolLam = PUMP_INIT_VSOL_LAM;
  let vTok    = PUMP_INIT_VTOK;
  const k     = vSolLam * vTok; // constant product invariant

  let updated = 0, errors = 0;
  const batch = [];

  for (const trade of trades) {
    const solLam   = BigInt(trade.eth_amount);
    const needsFix = trade.token_amount === "0" && trade.price_eth === null;

    if (solLam === 0n) { if (needsFix) errors++; continue; }

    let newVSolLam, newVTok, tokenAmount;
    try {
      if (trade.is_buy) {
        newVSolLam  = vSolLam + solLam;
        newVTok     = k / newVSolLam;
        tokenAmount = vTok - newVTok;
      } else {
        newVSolLam  = vSolLam > solLam ? vSolLam - solLam : vSolLam;
        newVTok     = k / newVSolLam;
        tokenAmount = newVTok - vTok;
      }

      if (tokenAmount <= 0n || newVTok <= 0n) { if (needsFix) errors++; continue; }

      const priceEth = (Number(solLam) / Number(tokenAmount)).toFixed(12);

      if (needsFix) {
        batch.push({ id: trade.id, tokenAmount: tokenAmount.toString(), priceEth });
        updated++;
      }

      // Always advance the virtual reserves — whether or not we updated the row
      vSolLam = newVSolLam;
      vTok    = newVTok;
    } catch {
      if (needsFix) errors++;
    }
  }

  if (batch.length > 0 && !DRY_RUN) {
    await client.query(`
      UPDATE trades AS t
      SET    token_amount = v.token_amount,
             price_eth    = v.price_eth
      FROM   unnest($1::int[], $2::text[], $3::text[]) AS v(id, token_amount, price_eth)
      WHERE  t.id = v.id
    `, [batch.map(u => u.id), batch.map(u => u.tokenAmount), batch.map(u => u.priceEth)]);
  }

  return { updated, errors };
}

// ── Pass 2: Price interpolation ───────────────────────────────────────────────

async function interpolateToken(client, mint) {
  const { rows: trades } = await client.query(`
    SELECT id, eth_amount, token_amount, price_eth
    FROM   trades
    WHERE  token_address = $1 AND platform = 'pump_fun'
    ORDER BY id ASC
  `, [mint]);

  if (trades.length === 0) return { updated: 0 };

  const prices = trades.map(r => (r.price_eth !== null ? parseFloat(r.price_eth) : null));

  // Forward-fill then backward-fill
  let last = null;
  for (let i = 0; i < prices.length; i++) {
    if (prices[i] !== null && prices[i] > 0) { last = prices[i]; }
    else if (last !== null) { prices[i] = last; }
  }
  let next = null;
  for (let i = prices.length - 1; i >= 0; i--) {
    if (prices[i] !== null && prices[i] > 0) { next = prices[i]; }
    else if (next !== null) { prices[i] = next; }
  }

  const batch = [];
  for (let i = 0; i < trades.length; i++) {
    const row = trades[i];
    if (row.token_amount !== "0" || row.price_eth !== null) continue;
    const price = prices[i];
    if (!price || !Number.isFinite(price) || price <= 0) continue;

    const solLam = parseFloat(row.eth_amount);
    if (solLam <= 0) continue;

    const tokenAmount = Math.round(solLam / price);
    if (tokenAmount <= 0) continue;

    batch.push({ id: row.id, tokenAmount: tokenAmount.toString(), priceEth: price.toFixed(12) });
  }

  if (batch.length > 0 && !DRY_RUN) {
    await client.query(`
      UPDATE trades AS t
      SET    token_amount = v.token_amount,
             price_eth    = v.price_eth
      FROM   unnest($1::int[], $2::text[], $3::text[]) AS v(id, token_amount, price_eth)
      WHERE  t.id = v.id
    `, [batch.map(u => u.id), batch.map(u => u.tokenAmount), batch.map(u => u.priceEth)]);
  }

  return { updated: batch.length };
}

// ── Token-set helpers ─────────────────────────────────────────────────────────

async function tokensNeedingFix(pool) {
  const { rows } = await pool.query(`
    SELECT DISTINCT token_address
    FROM   trades
    WHERE  platform     = 'pump_fun'
      AND  token_amount = '0'
      AND  price_eth    IS NULL
      AND  CAST(eth_amount AS NUMERIC) > 0
    ORDER BY token_address
  `);
  return rows.map(r => r.token_address);
}

async function runParallel(mints, fn, label) {
  const CONCURRENCY = 4;
  let totalUpdated = 0, totalErrors = 0;

  for (let i = 0; i < mints.length; i += CONCURRENCY) {
    const batch = mints.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async mint => {
      const client = await pool.connect();
      try { return { mint, ...(await fn(client, mint)) }; }
      catch (err) { return { mint, updated: 0, errors: 1, fatal: err.message }; }
      finally { client.release(); }
    }));

    for (const r of results) {
      totalUpdated += r.updated ?? 0;
      totalErrors  += r.errors  ?? 0;
      if ((r.updated > 0) || r.fatal)
        console.log(`  [${label}] ${r.mint.slice(0,8)}…  +${r.updated}  err=${r.errors ?? 0}${r.fatal ? " FATAL:" + r.fatal : ""}`);
    }

    if ((i + CONCURRENCY) % 400 === 0)
      console.log(`  … ${i + CONCURRENCY}/${mints.length} tokens (${label} updated=${totalUpdated})`);
  }

  return { totalUpdated, totalErrors };
}

// ── Final assertions ──────────────────────────────────────────────────────────

async function assertCoverage() {
  // A trade is "chart-eligible" when eth_amount > 0; zero-SOL trades cannot
  // produce a price and are legitimately left without price_eth.
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                                            AS total,
      COUNT(*) FILTER (WHERE CAST(eth_amount AS NUMERIC) > 0)            AS eligible,
      COUNT(*) FILTER (WHERE CAST(eth_amount AS NUMERIC) > 0
                         AND price_eth IS NOT NULL)                      AS priced_eligible,
      COUNT(*) FILTER (WHERE CAST(eth_amount AS NUMERIC) > 0
                         AND price_eth IS NULL)                          AS unpriced_eligible,
      COUNT(*) FILTER (WHERE CAST(eth_amount AS NUMERIC) = 0)            AS zero_sol
    FROM trades
    WHERE platform = 'pump_fun'
  `);
  const r = rows[0];
  console.log("\n── Coverage assertion ──────────────────────────────────────────────");
  console.log(`  Total pump_fun trades         : ${r.total}`);
  console.log(`  Chart-eligible (eth_amount>0) : ${r.eligible}`);
  console.log(`    with price_eth              : ${r.priced_eligible}`);
  console.log(`    WITHOUT price_eth (target=0): ${r.unpriced_eligible}`);
  console.log(`  Zero-SOL trades (no price)    : ${r.zero_sol}`);

  const remaining = parseInt(r.unpriced_eligible, 10);
  if (remaining > 0) {
    console.error(`\nASSERTION FAILED: ${remaining} chart-eligible pump_fun trades still lack price_eth`);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ All ${r.priced_eligible} chart-eligible pump_fun trades have price_eth`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== Pump.fun trade price backfill${DRY_RUN ? " (DRY RUN)" : ""} ===\n`);

  // ── Pass 1: AMM replay ────────────────────────────────────────────────────
  const pass1Tokens = await tokensNeedingFix(pool);
  console.log(`Pass 1 (AMM replay): ${pass1Tokens.length} token(s) with eligible zero-amount trades`);
  if (pass1Tokens.length > 0) {
    const { totalUpdated: u1, totalErrors: e1 } = await runParallel(pass1Tokens, ammReplayToken, "amm");
    console.log(`Pass 1 done — updated=${u1}  unrepairable=${e1}`);
  }

  // ── Pass 2: Price interpolation for remaining zeros ───────────────────────
  const pass2Tokens = await tokensNeedingFix(pool);
  console.log(`\nPass 2 (interpolation): ${pass2Tokens.length} token(s) still need repair`);
  if (pass2Tokens.length > 0) {
    const { totalUpdated: u2 } = await runParallel(pass2Tokens, interpolateToken, "interp");
    console.log(`Pass 2 done — updated=${u2}`);
  }

  // ── Back-fill tokens.price_eth for tokens where it is still null/zero ─────
  if (!DRY_RUN) {
    await pool.query(`
      UPDATE tokens t
      SET    price_eth = latest.price_eth
      FROM (
        SELECT DISTINCT ON (token_address)
               token_address,
               price_eth
        FROM   trades
        WHERE  platform  = 'pump_fun'
          AND  price_eth IS NOT NULL
        ORDER BY token_address, id DESC
      ) latest
      WHERE t.address   = latest.token_address
        AND t.platform  = 'pump_fun'
        AND (t.price_eth IS NULL OR t.price_eth = '0')
    `);
    console.log("\ntoken.price_eth back-filled for all qualifying tokens");
  }

  // ── Assertions ────────────────────────────────────────────────────────────
  await assertCoverage();
  await pool.end();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
