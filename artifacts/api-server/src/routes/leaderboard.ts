import { Router } from "express";
import { pool } from "@workspace/db";
import { asyncWrap } from "../lib/asyncHandler.js";

const router = Router();

const TTL = 60; // 60-second cache — leaderboard is heavy, refresh once a minute

let _cache: { data: unknown; expiresAt: number } | null = null;

function cacheGet() {
  if (_cache && Date.now() < _cache.expiresAt) return _cache.data;
  return null;
}
function cacheSet(data: unknown) {
  _cache = { data, expiresAt: Date.now() + TTL * 1_000 };
}

/**
 * GET /api/leaderboard
 *
 * Returns three leaderboards for the last 7 days:
 *   traders_volume  — top 10 wallets by total SOL volume
 *   traders_pnl     — top 10 wallets by estimated PnL (sells - buys in lamports)
 *   tokens          — top 10 tokens by total SOL volume
 *
 * All eth_amount values are stored as lamport strings in the DB.
 */
router.get(
  "/api/leaderboard",
  asyncWrap(async (_req, res) => {
    const cached = cacheGet();
    if (cached) {
      res.setHeader("Cache-Control", `public, max-age=${TTL}, stale-while-revalidate=${TTL}`);
      res.setHeader("X-Cache", "HIT");
      res.json(cached);
      return;
    }

    const [volResult, pnlResult, tokResult] = await Promise.all([
      // ── Top traders by total SOL volume (7d) ───────────────────────────────
      pool.query<{
        address: string;
        trade_count: string;
        volume_lamports: string;
      }>(`
        SELECT
          trader_address                                               AS address,
          COUNT(*)::text                                               AS trade_count,
          COALESCE(
            SUM(CAST(NULLIF(eth_amount, '') AS NUMERIC)), 0
          )::text                                                      AS volume_lamports
        FROM   trades
        WHERE  timestamp       > NOW() - INTERVAL '7 days'
          AND  trader_address IS NOT NULL
          AND  trader_address != ''
          AND  eth_amount      != ''
          AND  eth_amount      IS NOT NULL
        GROUP  BY trader_address
        ORDER  BY volume_lamports::NUMERIC DESC
        LIMIT  10
      `),

      // ── Top traders by estimated PnL (7d): sell proceeds − buy cost ────────
      pool.query<{
        address: string;
        trade_count: string;
        pnl_lamports: string;
      }>(`
        SELECT
          trader_address                                               AS address,
          COUNT(*)::text                                               AS trade_count,
          (
            COALESCE(SUM(CASE WHEN NOT is_buy
              THEN CAST(NULLIF(eth_amount, '') AS NUMERIC) ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN is_buy
              THEN CAST(NULLIF(eth_amount, '') AS NUMERIC) ELSE 0 END), 0)
          )::text                                                      AS pnl_lamports
        FROM   trades
        WHERE  timestamp       > NOW() - INTERVAL '7 days'
          AND  trader_address IS NOT NULL
          AND  trader_address != ''
          AND  eth_amount      != ''
          AND  eth_amount      IS NOT NULL
        GROUP  BY trader_address
        HAVING COUNT(*) >= 2
        ORDER  BY pnl_lamports::NUMERIC DESC
        LIMIT  10
      `),

      // ── Top tokens by total SOL volume (7d) ────────────────────────────────
      pool.query<{
        address: string;
        name: string;
        symbol: string;
        image_url: string | null;
        platform: string;
        trade_count: string;
        volume_lamports: string;
      }>(`
        SELECT
          t.address,
          t.name,
          t.symbol,
          t.image_url,
          COALESCE(t.platform, 'unknown')                             AS platform,
          COUNT(tr.*)::text                                            AS trade_count,
          COALESCE(
            SUM(CAST(NULLIF(tr.eth_amount, '') AS NUMERIC)), 0
          )::text                                                      AS volume_lamports
        FROM   trades   tr
        JOIN   tokens   t  ON t.address = tr.token_address
        WHERE  tr.timestamp > NOW() - INTERVAL '7 days'
          AND  tr.eth_amount != ''
          AND  tr.eth_amount IS NOT NULL
        GROUP  BY t.address, t.name, t.symbol, t.image_url, t.platform
        ORDER  BY volume_lamports::NUMERIC DESC
        LIMIT  10
      `),
    ]);

    const payload = {
      traders_volume: volResult.rows.map((r) => ({
        address:        r.address,
        trade_count:    Number(r.trade_count),
        volume_lamports: r.volume_lamports,
      })),
      traders_pnl: pnlResult.rows.map((r) => ({
        address:       r.address,
        trade_count:   Number(r.trade_count),
        pnl_lamports:  r.pnl_lamports,
      })),
      tokens: tokResult.rows.map((r) => ({
        address:         r.address,
        name:            r.name,
        symbol:          r.symbol,
        imageUrl:        r.image_url ?? null,
        platform:        r.platform,
        trade_count:     Number(r.trade_count),
        volume_lamports: r.volume_lamports,
      })),
    };

    cacheSet(payload);
    res.setHeader("Cache-Control", `public, max-age=${TTL}, stale-while-revalidate=${TTL}`);
    res.setHeader("X-Cache", "MISS");
    res.json(payload);
  }),
);

export default router;
