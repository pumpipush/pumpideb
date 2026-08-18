import { Router } from "express";
import { pool } from "@workspace/db";
import { asyncWrap } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";

const router = Router();

type Period = "24h" | "7d" | "30d";
const PERIODS: Period[] = ["24h", "7d", "30d"];
const INTERVAL: Record<Period, string> = {
  "24h": "24 hours",
  "7d":  "7 days",
  "30d": "30 days",
};
const REFRESH_MS = 4 * 60 * 1_000; // 4 min

const _cache = new Map<Period, { data: unknown; computedAt: number }>();
const _refreshing = new Set<Period>();

async function computeLeaderboard(period: Period): Promise<unknown> {
  const interval = INTERVAL[period];
  const client = await pool.connect();
  try {
    await client.query("SET work_mem = '128MB'");

    const [volResult, pnlResult, tokResult] = await Promise.all([
      client.query<{ address: string; volume_lamports: string }>(`
        SELECT
          trader_address                                           AS address,
          COALESCE(SUM(eth_amount::FLOAT8), 0)::text              AS volume_lamports
        FROM   trades
        WHERE  timestamp       > NOW() - INTERVAL '${interval}'
          AND  trader_address IS NOT NULL
          AND  trader_address != ''
          AND  eth_amount      ~ '^[0-9]+$'
        GROUP  BY trader_address
        ORDER  BY SUM(eth_amount::FLOAT8) DESC
        LIMIT  100
      `),
      client.query<{ address: string; trade_count: string; pnl_lamports: string }>(`
        SELECT
          trader_address                                           AS address,
          COUNT(*)::text                                           AS trade_count,
          (
            COALESCE(SUM(CASE WHEN NOT is_buy THEN eth_amount::FLOAT8 ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN is_buy   THEN eth_amount::FLOAT8 ELSE 0 END), 0)
          )::text                                                  AS pnl_lamports
        FROM   trades
        WHERE  timestamp       > NOW() - INTERVAL '${interval}'
          AND  trader_address IS NOT NULL
          AND  trader_address != ''
          AND  eth_amount      ~ '^[0-9]+$'
        GROUP  BY trader_address
        HAVING COUNT(*) >= 2
        ORDER  BY (
            COALESCE(SUM(CASE WHEN NOT is_buy THEN eth_amount::FLOAT8 ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN is_buy   THEN eth_amount::FLOAT8 ELSE 0 END), 0)
          ) DESC
        LIMIT  100
      `),
      client.query<{ address: string; name: string; symbol: string; image_url: string | null; platform: string; trade_count: string; volume_lamports: string }>(`
        SELECT
          t.address,
          t.name,
          t.symbol,
          t.image_url,
          COALESCE(t.platform, 'unknown')                         AS platform,
          COUNT(tr.*)::text                                        AS trade_count,
          COALESCE(SUM(tr.eth_amount::FLOAT8), 0)::text           AS volume_lamports
        FROM   trades   tr
        JOIN   tokens   t  ON t.address = tr.token_address
        WHERE  tr.timestamp > NOW() - INTERVAL '${interval}'
          AND  tr.eth_amount ~ '^[0-9]+$'
        GROUP  BY t.address, t.name, t.symbol, t.image_url, t.platform
        ORDER  BY SUM(tr.eth_amount::FLOAT8) DESC
        LIMIT  100
      `),
    ]);

    return {
      period,
      traders_volume: volResult.rows.map((r, i) => ({
        rank:            i + 1,
        address:         r.address,
        volume_lamports: r.volume_lamports,
      })),
      traders_pnl: pnlResult.rows.map((r, i) => ({
        rank:          i + 1,
        address:       r.address,
        trade_count:   Number(r.trade_count),
        pnl_lamports:  r.pnl_lamports,
      })),
      tokens: tokResult.rows.map((r, i) => ({
        rank:            i + 1,
        address:         r.address,
        name:            r.name,
        symbol:          r.symbol,
        imageUrl:        r.image_url ?? null,
        platform:        r.platform,
        trade_count:     Number(r.trade_count),
        volume_lamports: r.volume_lamports,
      })),
    };
  } finally {
    client.release();
  }
}

async function refreshCache(period: Period) {
  if (_refreshing.has(period)) return;
  _refreshing.add(period);
  const t0 = Date.now();
  try {
    const data = await computeLeaderboard(period);
    _cache.set(period, { data, computedAt: Date.now() });
    logger.info({ ms: Date.now() - t0, period }, "leaderboard: cache refreshed");
  } catch (err) {
    logger.warn({ err, period }, "leaderboard: background refresh failed — stale cache kept");
  } finally {
    _refreshing.delete(period);
  }
}

// Warm all periods on startup, refresh every 4 min
for (const p of PERIODS) refreshCache(p);
setInterval(() => { for (const p of PERIODS) refreshCache(p); }, REFRESH_MS);

router.get(
  "/leaderboard",
  asyncWrap(async (req, res) => {
    const raw = (req.query["period"] as string | undefined) ?? "24h";
    const period: Period = PERIODS.includes(raw as Period) ? (raw as Period) : "24h";

    const cached = _cache.get(period);
    if (cached) {
      res.setHeader("Cache-Control", "public, max-age=240, stale-while-revalidate=240");
      res.setHeader("X-Cache", "HIT");
      res.setHeader("X-Cache-Age", String(Math.floor((Date.now() - cached.computedAt) / 1000)));
      res.json(cached.data);
      return;
    }

    logger.info({ period }, "leaderboard: cold-cache request — computing synchronously");
    const t0 = Date.now();
    const data = await computeLeaderboard(period);
    _cache.set(period, { data, computedAt: Date.now() });
    logger.info({ ms: Date.now() - t0, period }, "leaderboard: cold-cache computed");

    res.setHeader("Cache-Control", "public, max-age=240, stale-while-revalidate=240");
    res.setHeader("X-Cache", "MISS");
    res.json(data);
  }),
);

export default router;
