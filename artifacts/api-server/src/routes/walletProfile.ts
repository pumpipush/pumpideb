import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { asyncWrap } from "../lib/asyncHandler.js";
import { getWalletLeaderboardStats } from "./leaderboard.js";

const router = Router();

// ── Cache ─────────────────────────────────────────────────────────────────────
// Bounded LRU-style cache: once MAX_CACHE_ENTRIES is reached, the oldest
// entry is evicted on insert. A periodic sweep removes entries whose TTL has
// expired so memory is reclaimed even for infrequently re-requested addresses.

const CACHE_TTL_MS      = 2 * 60_000;   // 2 minutes
const MAX_CACHE_ENTRIES = 500;           // hard upper bound on resident entries

interface CacheEntry { data: unknown; ts: number }

/** Insertion-order Map — oldest entry is Map.prototype.keys().next().value. */
const _cache = new Map<string, CacheEntry>();
const _inflight = new Set<string>();

function cacheSet(address: string, data: unknown): void {
  // Evict the oldest entry when the cap is reached.
  if (_cache.size >= MAX_CACHE_ENTRIES && !_cache.has(address)) {
    const oldest = _cache.keys().next().value as string | undefined;
    if (oldest) _cache.delete(oldest);
  }
  _cache.set(address, { data, ts: Date.now() });
}

// Periodic sweep: remove all expired entries every 5 minutes so
// high-churn addresses do not accumulate over time.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _cache) {
    if (now - entry.ts >= CACHE_TTL_MS) _cache.delete(key);
  }
}, 5 * 60_000);

// ── Solana address validation ─────────────────────────────────────────────────
// Solana public keys are 32-byte values encoded as base58.
// Base58 length range for 32 bytes: 43–44 chars (commonly exactly 44, minimum 32).
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isValidSolanaAddress(s: string): boolean {
  return BASE58_RE.test(s);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

// How long to wait for a free pool connection before falling back to
// leaderboard-cache-only data. The leaderboard background refresh holds
// connections for several minutes at startup; this cap keeps the endpoint
// responsive during that window.
const CONNECT_TIMEOUT_MS = 6_000;
// Per-statement cap applied as a session variable and reset before release.
const STMT_TIMEOUT_MS    = 10_000;

/**
 * Run `fn` inside a borrowed pool connection, with two safety guarantees:
 *
 * 1. Leak-safe timeout: if no connection is available within CONNECT_TIMEOUT_MS,
 *    we resolve with null immediately. If pool.connect() resolves *later* (the
 *    promise is not cancellable in node-postgres), the late client is released
 *    immediately so it is never stranded in the pool.
 *
 * 2. Timeout-safe session: `SET statement_timeout` is applied before calling
 *    `fn` and always reset to DEFAULT before the client is released — so the
 *    cap never leaks to subsequent requests on the same connection.
 *
 * Note: `connect` is passed as `() => pool.connect()` (not a raw method
 * reference) so TypeScript selects the no-argument Promise overload rather
 * than the callback overload that returns void.
 */
async function withClientTimeout<TClient extends { query: Function; release: () => void }, TResult>(
  connect: () => Promise<TClient>,
  fn: (client: TClient) => Promise<TResult>,
): Promise<TResult | null> {
  let timedOut = false;

  return Promise.race<TResult | null>([
    connect().then(async (client: TClient) => {
      if (timedOut) {
        // The timeout already fired. Release the late client immediately
        // to prevent a pool-exhaustion leak.
        client.release();
        return null;
      }

      let timeoutSet = false;
      try {
        await client.query(`SET statement_timeout = '${STMT_TIMEOUT_MS}ms'`);
        timeoutSet = true;
        return await fn(client);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("statement timeout") || msg.includes("57014")) {
          // Swallow DB-level timeouts; the caller handles null gracefully.
          return null;
        }
        throw err;
      } finally {
        // Always reset the per-session timeout before releasing the client
        // so subsequent requests on this connection are not affected.
        if (timeoutSet) {
          try { await client.query("SET statement_timeout = DEFAULT"); } catch { /* ignore */ }
        }
        client.release();
      }
    }, () => null),

    new Promise<null>(resolve =>
      setTimeout(() => { timedOut = true; resolve(null); }, CONNECT_TIMEOUT_MS)
    ),
  ]);
}

// ── BigInt-safe lamport arithmetic ────────────────────────────────────────────
// SOL amounts stored in the DB are lamports (integer values) serialised as
// strings (or returned by NUMERIC casts). We keep them as BigInt throughout
// to avoid float precision loss on large aggregates, and only convert to a
// decimal string for the JSON response.

/** Parse a lamport value that may come from the DB as a string or number. */
function parseLamports(v: string | number | null | undefined): bigint {
  if (v == null || v === "") return 0n;
  const s = String(v).trim();
  // NUMERIC may include a decimal point from intermediate division; truncate.
  const dotIdx = s.indexOf(".");
  const intPart = dotIdx >= 0 ? s.slice(0, dotIdx) : s;
  try { return BigInt(intPart); } catch { return 0n; }
}

interface RecentTrade {
  id: number;
  token_address: string;
  token_name: string;
  token_symbol: string;
  token_image_url: string | null;
  platform: string;
  is_buy: boolean;
  eth_amount: string;
  token_amount: string;
  tx_hash: string;
  timestamp: string;
}

// ── Core computation ──────────────────────────────────────────────────────────

async function computeWalletProfile(address: string): Promise<unknown> {
  // ── Leaderboard-cache stats (instant, no DB hit) ──────────────────────────
  const cached = getWalletLeaderboardStats(address);

  // ── Attempt DB queries ─────────────────────────────────────────────────────
  type DbResult = {
    recentTrades: RecentTrade[];
    pnl24h: string;   // lamports, exact integer as string
    pnl7d: string;
    buy24: number;
    sell24: number;
    buy7d: number;
    sell7d: number;
  };

  const dbResult = await withClientTimeout(() => pool.connect(), async client => {
    // ── Recent 50 trades ────────────────────────────────────────────────────
    // idx_trades_trader_address (trader_address, timestamp DESC) + LIMIT 50
    // early exit → sub-second even for heavy traders.
    const recentRes = await client.query<{
      id: number; token_address: string; token_name: string;
      token_symbol: string; token_image_url: string | null;
      platform: string; is_buy: boolean; eth_amount: string;
      token_amount: string | null; tx_hash: string; timestamp: string;
    }>(`
      SELECT
        tr.id,
        tr.token_address,
        COALESCE(t.name,   tr.token_name,   'Unknown') AS token_name,
        COALESCE(t.symbol, tr.token_symbol,  '???')    AS token_symbol,
        t.image_url                                     AS token_image_url,
        COALESCE(t.platform, 'unknown')                AS platform,
        tr.is_buy, tr.eth_amount, tr.token_amount, tr.tx_hash, tr.timestamp
      FROM   trades tr
      LEFT   JOIN tokens t ON t.address = tr.token_address
      WHERE  tr.trader_address = $1
      ORDER  BY tr.timestamp DESC
      LIMIT  50
    `, [address]);

    // ── 24h aggregate (exact NUMERIC arithmetic, no FLOAT8) ─────────────────
    // Composite index (trader_address, timestamp DESC) enables a bounded range
    // scan so only recent rows for this trader are read.
    //
    // We SUM eth_amount::NUMERIC to preserve lamport precision — FLOAT8 would
    // lose integer accuracy for large aggregates (> 2^53 lamports ≈ 9M SOL).
    // The result is returned as a string via ::TEXT and parsed with BigInt.
    const agg24 = await client.query<{
      buy_count: string; sell_count: string;
      buys_lam: string; sells_lam: string;
    }>(`
      SELECT
        SUM(CASE WHEN  is_buy THEN 1 ELSE 0 END)::TEXT                            AS buy_count,
        SUM(CASE WHEN NOT is_buy THEN 1 ELSE 0 END)::TEXT                         AS sell_count,
        COALESCE(SUM(CASE WHEN  is_buy THEN eth_amount::NUMERIC ELSE 0 END), 0)::TEXT AS buys_lam,
        COALESCE(SUM(CASE WHEN NOT is_buy THEN eth_amount::NUMERIC ELSE 0 END), 0)::TEXT AS sells_lam
      FROM   trades
      WHERE  trader_address = $1
        AND  timestamp      > NOW() - INTERVAL '24 hours'
        AND  eth_amount IS NOT NULL AND eth_amount <> ''
    `, [address]);

    // ── 7d aggregate ────────────────────────────────────────────────────────
    const agg7d = await client.query<{
      buy_count: string; sell_count: string;
      buys_lam: string; sells_lam: string;
    }>(`
      SELECT
        SUM(CASE WHEN  is_buy THEN 1 ELSE 0 END)::TEXT                            AS buy_count,
        SUM(CASE WHEN NOT is_buy THEN 1 ELSE 0 END)::TEXT                         AS sell_count,
        COALESCE(SUM(CASE WHEN  is_buy THEN eth_amount::NUMERIC ELSE 0 END), 0)::TEXT AS buys_lam,
        COALESCE(SUM(CASE WHEN NOT is_buy THEN eth_amount::NUMERIC ELSE 0 END), 0)::TEXT AS sells_lam
      FROM   trades
      WHERE  trader_address = $1
        AND  timestamp      > NOW() - INTERVAL '7 days'
        AND  eth_amount IS NOT NULL AND eth_amount <> ''
    `, [address]);

    const d24 = agg24.rows[0];
    const d7d  = agg7d.rows[0];

    // Exact BigInt difference: sells - buys (can be negative for net buyers)
    const pnl24 = parseLamports(d24?.sells_lam) - parseLamports(d24?.buys_lam);
    const pnl7d  = parseLamports(d7d?.sells_lam) - parseLamports(d7d?.buys_lam);

    const result: DbResult = {
      recentTrades: recentRes.rows.map(r => ({
        id: r.id, token_address: r.token_address,
        token_name: r.token_name, token_symbol: r.token_symbol,
        token_image_url: r.token_image_url ?? null, platform: r.platform,
        is_buy: r.is_buy, eth_amount: r.eth_amount,
        token_amount: r.token_amount ?? "0", tx_hash: r.tx_hash,
        timestamp: r.timestamp,
      })),
      pnl24h: String(pnl24),
      pnl7d:  String(pnl7d),
      buy24:  Number(d24?.buy_count  ?? 0),
      sell24: Number(d24?.sell_count ?? 0),
      buy7d:  Number(d7d?.buy_count  ?? 0),
      sell7d: Number(d7d?.sell_count ?? 0),
    };
    return result;
  });

  const dbAvailable  = dbResult !== null;
  const recentTrades = dbResult?.recentTrades ?? [];

  // ── Merge: prefer live DB, fall back to leaderboard cache ─────────────────
  const pnl24 = dbAvailable ? dbResult.pnl24h : (cached.pnl_24h ?? "0");
  const pnl7d  = dbAvailable ? dbResult.pnl7d  : (cached.pnl_7d  ?? "0");

  // has_both_sides determines whether the UI shows a meaningful P&L value.
  // Priority: live DB → leaderboard cache → recent-50 approximation.
  // The leaderboard HAVING clause requires buy_count ≥ 1 AND sell_count ≥ 1,
  // so a non-null cached PnL guarantees both sides exist in the window.
  const recentCutoff24 = Date.now() - 24 * 60 * 60 * 1000;
  const recentCutoff7d  = Date.now() -  7 * 24 * 60 * 60 * 1000;
  const trades24 = recentTrades.filter(t => new Date(t.timestamp).getTime() > recentCutoff24);
  const trades7d  = recentTrades.filter(t => new Date(t.timestamp).getTime() > recentCutoff7d);

  const hasBoth24 = dbAvailable
    ? (dbResult.buy24 >= 1 && dbResult.sell24 >= 1)
    : cached.pnl_24h !== null                                           // leaderboard guarantees both sides
      || (trades24.some(t => t.is_buy) && trades24.some(t => !t.is_buy));

  const hasBoth7d = dbAvailable
    ? (dbResult.buy7d >= 1 && dbResult.sell7d >= 1)
    : cached.pnl_7d !== null
      || (trades7d.some(t => t.is_buy) && trades7d.some(t => !t.is_buy));

  // ── Top tokens from recent 50 trades ──────────────────────────────────────
  // Derived from the recent-50 list only; from_recent_50=true lets the UI
  // show an honest "last 50 trades" label.
  const tokenMap = new Map<string, {
    token_address: string; token_name: string; token_symbol: string;
    token_image_url: string | null; platform: string;
    trade_count: number; volume_lam: bigint;
  }>();
  for (const t of recentTrades) {
    const vol = parseLamports(t.eth_amount);
    const ex = tokenMap.get(t.token_address);
    if (ex) { ex.trade_count++; ex.volume_lam += vol; }
    else tokenMap.set(t.token_address, {
      token_address: t.token_address, token_name: t.token_name,
      token_symbol: t.token_symbol, token_image_url: t.token_image_url,
      platform: t.platform, trade_count: 1, volume_lam: vol,
    });
  }
  const topTokens = [...tokenMap.values()]
    .sort((a, b) => (a.volume_lam > b.volume_lam ? -1 : a.volume_lam < b.volume_lam ? 1 : 0))
    .slice(0, 6)
    .map(({ volume_lam, ...rest }) => ({
      ...rest, volume_lamports: String(volume_lam), from_recent_50: true,
    }));

  const recentCount  = recentTrades.length;
  const recentVolLam = recentTrades.reduce((s, t) => s + parseLamports(t.eth_amount), 0n);

  // from_leaderboard_cache is true whenever any period's cached data was used
  // (not just when 24h cache supplies data).
  const fromLbCache = !dbAvailable && (cached.pnl_24h !== null || cached.pnl_7d !== null);

  return {
    address,
    summary: {
      // net_sol_flow = SUM(sell lamports) - SUM(buy lamports) in the window.
      // This is NOT realized P&L / cost-basis accounting — it is aggregate
      // SOL in vs out, labelled accordingly in the UI.
      net_sol_flow_24h_lamports: pnl24,
      net_sol_flow_7d_lamports:  pnl7d,
      has_both_sides_24h:        hasBoth24,
      has_both_sides_7d:         hasBoth7d,
      from_leaderboard_cache:    fromLbCache,
      recent_trade_count:        recentCount,
      recent_volume_lamports:    String(recentVolLam),
      recent_trades_label:       `last ${recentCount} trades`,
      db_available:              dbAvailable,
    },
    top_tokens:    topTokens,
    recent_trades: recentTrades,
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get(
  "/wallet/:address/profile",
  asyncWrap(async (req: Request, res: Response) => {
    const address = req.params.address as string;

    // Validate before any cache lookup so scanners can't pollute the cache
    // with arbitrary strings.
    if (!address || !isValidSolanaAddress(address)) {
      res.status(400).json({ error: "Invalid Solana address" });
      return;
    }

    const hit = _cache.get(address);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      res.setHeader("X-Cache", "HIT");
      res.json(hit.data);
      return;
    }

    if (_inflight.has(address)) {
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 500));
        const c = _cache.get(address);
        if (c && Date.now() - c.ts < CACHE_TTL_MS) {
          res.setHeader("X-Cache", "WAIT-HIT");
          res.json(c.data);
          return;
        }
      }
      res.status(503).json({ error: "Query in progress, please retry" });
      return;
    }

    _inflight.add(address);
    try {
      const data = await computeWalletProfile(address) as {
        summary: { db_available: boolean; recent_trade_count: number };
      };
      // Don't cache partial results (DB unavailable + no trades) so the next
      // request retries once the pool frees up after startup warmup.
      const shouldCache = data.summary.db_available || data.summary.recent_trade_count > 0;
      if (shouldCache) cacheSet(address, data);
      res.setHeader("X-Cache", shouldCache ? "MISS" : "PARTIAL");
      res.json(data);
    } finally {
      _inflight.delete(address);
    }
  }),
);

export default router;
