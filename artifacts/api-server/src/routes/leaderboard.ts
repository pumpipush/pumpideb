import { Router } from "express";
import { pool } from "@workspace/db";
import { asyncWrap } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";

const router = Router();

const TTL = 4 * 60 * 1_000; // 4 minutes in ms

let _cache: { data: unknown; computedAt: number } | null = null;
let _refreshing = false;

// ── Core computation (runs in background or on first request) ─────────────────
async function computeLeaderboard(): Promise<unknown> {
  const client = await pool.connect();
  try {
    // Prevent disk spill for the HashAggregate over 100k+ trader groups
    await client.query("SET work_mem = '128MB'");

    // ── Top traders by total SOL volume (24h) ─────────────────────────────────
    const volResult = await client.query<{
      address: string;
      trade_count: string;
      volume_lamports: string;
    }>(`
      SELECT
        trader_address                                               AS address,
        COUNT(*)::text                                               AS trade_count,
        COALESCE(SUM(eth_amount::FLOAT8), 0)::text                   AS volume_lamports
      FROM   trades
      WHERE  timestamp       > NOW() - INTERVAL '24 hours'
        AND  trader_address IS NOT NULL
        AND  trader_address != ''
        AND  eth_amount      ~ '^[0-9]+$'
      GROUP  BY trader_address
      ORDER  BY SUM(eth_amount::FLOAT8) DESC
      LIMIT  10
    `);

    // ── Top traders by estimated PnL (24h): sell proceeds − buy cost ──────────
    const pnlResult = await client.query<{
      address: string;
      trade_count: string;
      pnl_lamports: string;
    }>(`
      SELECT
        trader_address                                               AS address,
        COUNT(*)::text                                               AS trade_count,
        (
          COALESCE(SUM(CASE WHEN NOT is_buy THEN eth_amount::FLOAT8 ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN is_buy     THEN eth_amount::FLOAT8 ELSE 0 END), 0)
        )::text                                                      AS pnl_lamports
      FROM   trades
      WHERE  timestamp       > NOW() - INTERVAL '24 hours'
        AND  trader_address IS NOT NULL
        AND  trader_address != ''
        AND  eth_amount      ~ '^[0-9]+$'
      GROUP  BY trader_address
      HAVING COUNT(*) >= 2
      ORDER  BY (
          COALESCE(SUM(CASE WHEN NOT is_buy THEN eth_amount::FLOAT8 ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN is_buy     THEN eth_amount::FLOAT8 ELSE 0 END), 0)
        ) DESC
      LIMIT  10
    `);

    // ── Top tokens by total SOL volume (24h) ──────────────────────────────────
    const tokResult = await client.query<{
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
        COALESCE(SUM(tr.eth_amount::FLOAT8), 0)::text               AS volume_lamports
      FROM   trades   tr
      JOIN   tokens   t  ON t.address = tr.token_address
      WHERE  tr.timestamp > NOW() - INTERVAL '24 hours'
        AND  tr.eth_amount ~ '^[0-9]+$'
      GROUP  BY t.address, t.name, t.symbol, t.image_url, t.platform
      ORDER  BY SUM(tr.eth_amount::FLOAT8) DESC
      LIMIT  10
    `);

    return {
      traders_volume: volResult.rows.map((r) => ({
        address:         r.address,
        trade_count:     Number(r.trade_count),
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
  } finally {
    client.release();
  }
}

// ── Background refresh ─────────────────────────────────────────────────────────
// Runs immediately on import (warm cache before first request) and then every
// 4 minutes so users always get a cached response (no waiting for heavy queries).
async function refreshCache() {
  if (_refreshing) return; // prevent overlapping runs
  _refreshing = true;
  const t0 = Date.now();
  try {
    const data = await computeLeaderboard();
    _cache = { data, computedAt: Date.now() };
    logger.info({ ms: Date.now() - t0 }, "leaderboard: cache refreshed");
  } catch (err) {
    logger.warn({ err }, "leaderboard: background refresh failed — stale cache kept");
  } finally {
    _refreshing = false;
  }
}

// Warm immediately, then every 4 minutes
refreshCache();
setInterval(refreshCache, TTL);

// ── Route ─────────────────────────────────────────────────────────────────────
router.get(
  "/leaderboard",
  asyncWrap(async (_req, res) => {
    if (_cache) {
      const ageMs = Date.now() - _cache.computedAt;
      res.setHeader("Cache-Control", "public, max-age=240, stale-while-revalidate=240");
      res.setHeader("X-Cache", "HIT");
      res.setHeader("X-Cache-Age", String(Math.floor(ageMs / 1000)));
      res.json(_cache.data);
      return;
    }

    // Cold start — cache not ready yet (first few seconds after server boot).
    // Block and compute synchronously for this one request.
    logger.info("leaderboard: cold-cache request — computing synchronously");
    const t0 = Date.now();
    const data = await computeLeaderboard();
    _cache = { data, computedAt: Date.now() };
    logger.info({ ms: Date.now() - t0 }, "leaderboard: cold-cache computed");

    res.setHeader("Cache-Control", "public, max-age=240, stale-while-revalidate=240");
    res.setHeader("X-Cache", "MISS");
    res.json(data);
  }),
);

export default router;
