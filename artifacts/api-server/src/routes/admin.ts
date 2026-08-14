/**
 * Admin-only routes — protected by the ADMIN_SECRET environment variable.
 *
 * These endpoints perform one-time data-repair operations that are not
 * part of the regular API surface. They should only be called by operators,
 * never by the frontend.
 *
 * Auth: every request must include the header
 *   X-Admin-Secret: <value of ADMIN_SECRET env var>
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, tokensTable } from "@workspace/db";
import { inArray, isNotNull, gt, sql } from "drizzle-orm";
import { getSolPriceUsd } from "../lib/birdeye.js";
import { asyncWrap } from "../lib/asyncHandler.js";

const router: IRouter = Router();

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAdminSecret(req: Request, res: Response, next: () => void): void {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    // If no secret is configured, block all admin access.
    res.status(503).json({ error: "Admin secret not configured on this server." });
    return;
  }
  const provided = req.headers["x-admin-secret"];
  if (!provided || provided !== secret) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
}

// ── POST /admin/fix-dex-market-caps ─────────────────────────────────────────
//
// One-time repair: recompute market_cap_eth from market_cap_usd for all
// pumpswap and raydium_launchlab tokens that have a valid market_cap_usd.
//
// Background: the original adapter stored market_cap_eth using the wrong
// formula (missing the ÷ sol_price step), producing values that were off by
// ~76–100×. The correct formula is:
//   market_cap_eth = ROUND(market_cap_usd / sol_price * 1e9)
//
// This endpoint:
//   1. Fetches the current SOL/USD price from Birdeye.
//   2. Updates every affected token in one SQL statement.
//   3. Returns the number of rows updated and the SOL price used.
//
// It is idempotent — running it again just re-applies the correct formula
// with the current SOL price (which changes the lamport value slightly but
// never produces a wrong order-of-magnitude).
//
// Usage:
//   curl -X POST /admin/fix-dex-market-caps \
//        -H "X-Admin-Secret: <ADMIN_SECRET>"
//
router.post(
  "/admin/fix-dex-market-caps",
  requireAdminSecret,
  asyncWrap(async (req: Request, res: Response) => {
    const solPriceUsd = await getSolPriceUsd();

    if (!solPriceUsd || solPriceUsd <= 0) {
      res.status(502).json({
        error: "Could not fetch SOL/USD price from Birdeye. Try again in a few seconds.",
      });
      return;
    }

    // Single atomic UPDATE — recomputes marketCapEth from marketCapUsd for
    // all pumpswap / raydium_launchlab tokens that have a valid USD market cap.
    const result = await db.execute(sql`
      UPDATE tokens
      SET market_cap_eth = ROUND(market_cap_usd / ${solPriceUsd} * 1e9)::text
      WHERE platform IN ('pumpswap', 'raydium_launchlab')
        AND market_cap_usd IS NOT NULL
        AND market_cap_usd > 0
    `);

    const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;

    console.log(
      `[admin] fix-dex-market-caps: updated ${rowCount} tokens at SOL=$${solPriceUsd.toFixed(2)}`
    );

    res.json({
      ok: true,
      rowsUpdated: rowCount,
      solPriceUsed: solPriceUsd,
    });
  })
);

// ── GET /admin/dex-market-cap-stats ─────────────────────────────────────────
//
// Diagnostic: shows how many DEX tokens have correct vs. implausible
// market_cap_eth values. Useful to verify the fix ran correctly.
//
// A "bad" token is one where market_cap_eth / market_cap_usd is wildly
// outside the expected lamports-per-USD range (5e6 – 2e7, covering $50–200
// SOL price). Anything outside that range was computed with the wrong formula.
//
router.get(
  "/admin/dex-market-cap-stats",
  requireAdminSecret,
  asyncWrap(async (_req: Request, res: Response) => {
    const stats = await db.execute(sql`
      SELECT
        platform,
        COUNT(*)                                                                 AS total,
        COUNT(*) FILTER (WHERE market_cap_usd > 0)                              AS has_mc_usd,
        COUNT(*) FILTER (
          WHERE market_cap_usd > 0
            AND market_cap_eth IS NOT NULL
            AND market_cap_eth != '0'
            AND (market_cap_eth::numeric / market_cap_usd) BETWEEN 5e6 AND 2e7
        )                                                                        AS correct_mc_eth,
        COUNT(*) FILTER (
          WHERE market_cap_usd > 0
            AND market_cap_eth IS NOT NULL
            AND market_cap_eth != '0'
            AND (market_cap_eth::numeric / market_cap_usd) NOT BETWEEN 5e6 AND 2e7
        )                                                                        AS bad_mc_eth,
        AVG(
          CASE
            WHEN market_cap_usd > 0
              AND market_cap_eth IS NOT NULL
              AND market_cap_eth != '0'
              AND (market_cap_eth::numeric / market_cap_usd) BETWEEN 5e6 AND 2e7
            THEN 1e9 / (market_cap_eth::numeric / market_cap_usd)
          END
        )                                                                        AS avg_implied_sol_price
      FROM tokens
      WHERE platform IN ('pumpswap', 'raydium_launchlab')
      GROUP BY platform
      ORDER BY platform
    `);

    res.json({ stats: (stats as unknown as { rows: unknown[] }).rows });
  })
);

export default router;
