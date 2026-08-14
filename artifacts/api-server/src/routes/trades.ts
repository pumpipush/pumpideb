import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, and, or, isNull, sql } from "drizzle-orm";
import { db, pool, tradesTable, tokensTable } from "@workspace/db";
import {
  TradeHistoryParams,
  TradeHistoryResponse,
  RecordTradeParams,
  RecordTradeBody,
  RecordTradeResponse,
} from "@workspace/api-zod";
import { emitTrade, emitSnapshot, tradeEmitter, type TradeEvent, type SnapshotEvent } from "../lib/tradeEmitter";
import type { NewTokenEvent } from "../lib/tradeEmitter"; // imported for type completeness
import { registerGraduatedMint } from "../lib/adapters/raydium-amm";
import { fetchBirdeyeOHLCV, fetchBirdeyeTokenTrades, fetchBirdeyeTokenOverview, getSolPriceUsd, type BirdeyeOHLCVBar } from "../lib/birdeye.js";
import { fetchDexScreenerTokens, bestSolanaPair, pairToSolPrice, pairToPriceHistory } from "../lib/dexscreener.js";
import { fetchAndParseTrade } from "../lib/tradeVerifier.js";
import { asyncWrap } from "../lib/asyncHandler.js";

// Platforms that use Birdeye for OHLCV + price-history (no internal trade stream in prod yet)
const DEX_PLATFORMS = new Set(["pumpswap", "raydium_launchlab"]);

// ── OHLCV server-side cache ────────────────────────────────────────────────────
// Prevents the SQL aggregation (or Birdeye call) from running for every polling
// tick from every connected client. TTL is shorter than the client refetch interval
// so the first poll after expiry always gets fresh data.
const _ohlcvCache = new Map<string, { payload: unknown; expiresAt: number }>();
const OHLCV_CACHE_TTL: Record<string, number> = {
  "1m":  6_000,   // client polls 8 s  → cache 6 s
  "5m":  6_000,
  "15m": 12_000,  // client polls 15 s → cache 12 s
  "1H":  12_000,
  "4H":  25_000,  // client polls 30 s → cache 25 s
  "1D":  25_000,
  "1W":  25_000,
};
function _ohlcvCacheGet(key: string): unknown | null {
  const entry = _ohlcvCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.payload;
}
function _ohlcvCacheSet(key: string, payload: unknown, tf: string): void {
  const ttl = OHLCV_CACHE_TTL[tf] ?? 10_000;
  _ohlcvCache.set(key, { payload, expiresAt: Date.now() + ttl });
  // Evict stale entries periodically so the map doesn't grow unbounded
  if (_ohlcvCache.size > 2_000) {
    const now = Date.now();
    for (const [k, v] of _ohlcvCache) { if (now > v.expiresAt) _ohlcvCache.delete(k); }
  }
}

// ── Birdeye backfill helper ────────────────────────────────────────────────────
// Fetches the last 50 trades from Birdeye for a DEX token and persists them to
// the trades table (ON CONFLICT DO NOTHING on tx_hash). Fully idempotent — safe
// to call many times. Returns the count of newly-inserted rows (0 if all already
// present or Birdeye is unavailable).
//
// This is the mechanism by which Jupiter/aggregator swaps enter the DB for
// graduated tokens: our on-chain logsSubscribe only sees direct PumpSwap and
// Raydium swaps; Jupiter-routed swaps go through different program paths and
// are invisible to those adapters. Birdeye's `/defi/txs/token` endpoint
// aggregates across all DEX venues, so it captures these missing trades.
async function backfillBirdeyeTradesToDb(
  address: string,
  platform: string,
  tokenName: string | null,
  tokenSymbol: string | null,
): Promise<number> {
  try {
    const [birdeyeTrades, solPrice] = await Promise.all([
      fetchBirdeyeTokenTrades(address, 50),
      getSolPriceUsd(),
    ]);
    if (!birdeyeTrades || birdeyeTrades.length === 0) return 0;

    // Dedup by txHash — Birdeye can return each swap leg separately for multi-hop routes.
    // Prefer the leg where the tracked token appears as an exact from/to address.
    const seen = new Map<string, typeof birdeyeTrades[number]>();
    for (const item of birdeyeTrades) {
      const existing = seen.get(item.txHash);
      if (!existing) {
        seen.set(item.txHash, item);
      } else {
        const isExact = item.to.address === address || item.from.address === address;
        if (isExact) seen.set(item.txHash, item);
      }
    }

    const rows = Array.from(seen.values()).map(item => {
      const isBuy = item.to.address === address
        ? true
        : item.from.address === address
        ? false
        : item.side === "buy";

      const tokenSide = (item.to.address === address) ? item.to : item.from;
      const otherSide = (item.to.address === address) ? item.from : item.to;

      const tokenDecimals = tokenSide.decimals ?? 6;
      const tokenAmount   = String(Math.round(Math.abs(tokenSide.uiAmount) * Math.pow(10, tokenDecimals)));

      // Trade value in SOL lamports (other-side USD value ÷ SOL price × 1e9)
      const tradeUsd  = Math.abs(otherSide.uiAmount) * (otherSide.price || item.tokenPrice || 0);
      const ethAmount = solPrice > 0 ? String(Math.round(tradeUsd / solPrice * 1e9)) : "0";

      // Price in SOL per token
      const priceEth = item.tokenPrice > 0 && solPrice > 0
        ? String(item.tokenPrice / solPrice)
        : null;

      return {
        tokenAddress:  address,
        tokenName:     tokenName ?? null,
        tokenSymbol:   tokenSymbol ?? null,
        traderAddress: item.owner,
        isBuy,
        ethAmount,
        tokenAmount,
        priceEth,
        txHash:    item.txHash,
        platform,
        timestamp: new Date(item.blockUnixTime * 1000),
      };
    });

    if (rows.length === 0) return 0;

    const inserted = await db
      .insert(tradesTable)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: tradesTable.id });

    return inserted.length;
  } catch {
    // Non-fatal — backfill is best-effort
    return 0;
  }
}

/** Solana base58 transaction signature: 64 bytes encoded as 87-88 base58 chars. */
const SOLANA_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

// Time ranges (seconds) to request from Birdeye for each timeframe
const BIRDEYE_HISTORY_SECS: Record<string, number> = {
  "1m":  4  * 60 * 60,          //  4h history
  "5m":  24 * 60 * 60,          // 24h history
  "15m": 3  * 24 * 60 * 60,     //  3d history
  "1H":  30 * 24 * 60 * 60,     // 30d history
  "4H":  90 * 24 * 60 * 60,     // 90d history
  "1D":  365 * 24 * 60 * 60,    //  1y history
  "1W":  2 * 365 * 24 * 60 * 60, // 2y history
};

// Candle bucket size in seconds — used to compute the current-candle timestamp
const BIRDEYE_TF_SECS: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900,
  "1H": 3600, "4H": 14400, "1D": 86400, "1W": 604800,
};

const router: IRouter = Router();

// GET /tokens/:address/stream  — Server-Sent Events for live trade feed
router.get("/tokens/:address/stream", asyncWrap(async (req: Request, res: Response) => {
  const address = req.params.address as string;
  if (!address) {
    res.status(400).json({ error: "address required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if present
  res.flushHeaders();

  // Initial ping — sent as a real data frame so the client's onmessage fires
  // and resets the watchdog timer immediately on connect.
  res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);

  // Immediately push the current token state so the UI populates without
  // waiting for the next trade event to arrive.
  let tokenRow: typeof tokensTable.$inferSelect | undefined;
  try {
    [tokenRow] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, address));
  } catch (err) {
    // DB failure after headers/SSE stream opened: log and continue without snapshot.
    console.error("[SSE] Failed to fetch initial token snapshot:", err);
  }

  // On-demand PumpSwap tracking.
  //
  // Case 1: Token is in DB and marked graduated — ensure per-mint subscription is
  // active even if this token graduated between periodic refreshes or during a
  // reconnect gap (registerGraduatedMint is a no-op if already registered).
  //
  // Case 2: Token not in DB (missed during creation due to a WebSocket gap) but its
  // address ends in "pump" — register it for per-mint tracking proactively. Since
  // detectDexPlatform checks the PumpSwap program ID in logs explicitly, subscribing
  // to a bonding-curve token is safe: those swaps are filtered out because they don't
  // mention the PumpSwap program. Only post-graduation PumpSwap swaps will match.
  // The lazy-insert in handleSwap will create a DB stub on the first trade received.
  const isPumpFun = address.endsWith("pump");
  if (tokenRow?.graduated || (!tokenRow && isPumpFun)) {
    registerGraduatedMint(address);
  }

  // For graduated DEX tokens, backfill the last 50 Birdeye trades into the DB
  // in the background. This ensures Jupiter/aggregator swaps are captured even
  // if they were never seen by our on-chain logsSubscribe adapters.
  if (tokenRow?.graduated && tokenRow.platform && DEX_PLATFORMS.has(tokenRow.platform)) {
    void backfillBirdeyeTradesToDb(
      address,
      tokenRow.platform,
      tokenRow.name ?? null,
      tokenRow.symbol ?? null,
    ).catch(() => { /* non-fatal */ });
  }

  if (tokenRow) {
    const snapshot: SnapshotEvent = {
      type: "snapshot",
      token: {
        address:              tokenRow.address,
        name:                 tokenRow.name,
        symbol:               tokenRow.symbol,
        imageUrl:             tokenRow.imageUrl,
        priceEth:             tokenRow.priceEth,
        marketCapEth:         tokenRow.marketCapEth,
        volumeEth:            tokenRow.volumeEth,
        virtualEthReserves:   tokenRow.virtualEthReserves,
        virtualTokenReserves: tokenRow.virtualTokenReserves,
        tradeCount:           Number(tokenRow.tradeCount),
        platform:             tokenRow.platform,
        chain:                tokenRow.chain,
      },
    };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  // Send a heartbeat data frame every 10 s.
  // Must be a real "data:" SSE frame — comment lines (": ping") are invisible
  // to the browser's EventSource.onmessage and would never reset the client
  // watchdog timer, causing spurious reconnects on quiet streams.
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
  }, 10_000);

  const tradeHandler    = (event: TradeEvent)    => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const snapshotHandler = (event: SnapshotEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  tradeEmitter.on(`trade:${address}`,    tradeHandler);
  tradeEmitter.on(`snapshot:${address}`, snapshotHandler);

  req.on("close", () => {
    clearInterval(heartbeat);
    tradeEmitter.off(`trade:${address}`,    tradeHandler);
    tradeEmitter.off(`snapshot:${address}`, snapshotHandler);
  });
}));

// ── OHLCV bucket sizes (seconds) — mirrors ohlcv.ts BUCKET_SECONDS ───────────
const OHLCV_BUCKET_SECONDS: Record<string, number> = {
  "1m":  60,
  "5m":  5   * 60,
  "15m": 15  * 60,
  "1H":  60  * 60,
  "4H":  4   * 60 * 60,
  "1D":  24  * 60 * 60,
  "1W":  7   * 24 * 60 * 60,
};

// GET /tokens/:address/ohlcv?tf=15m
// Returns server-side OHLCV candles aggregated from the full trade history
// (no 100-row limit). Uses a window-function query so every historical trade
// contributes regardless of the REST trade-history limit.
//
// DEX tokens (pumpswap, raydium_launchlab) always proxy to Birdeye — our
// indexer intentionally captures only a sample of trades (30s throttle on
// PumpSwap) so the internal DB does not represent full price history.
router.get("/tokens/:address/ohlcv", asyncWrap(async (req, res) => {
  const address = req.params.address as string;
  if (!address) { res.status(400).json({ error: "address required" }); return; }

  const tf = (req.query.tf as string | undefined) ?? "15m";
  const bucketSecs = OHLCV_BUCKET_SECONDS[tf];
  if (!bucketSecs) {
    res.status(400).json({ error: `Unknown timeframe '${tf}'. Valid: ${Object.keys(OHLCV_BUCKET_SECONDS).join(", ")}` });
    return;
  }

  // ── Cache check — short TTL so live trades still feel real-time ──────────────
  const cacheKey = `${address}:${tf}`;
  const cached = _ohlcvCacheGet(cacheKey);
  if (cached !== null) {
    res.setHeader("X-Cache", "HIT");
    res.json(cached);
    return;
  }

  // ── Early DEX path: skip internal aggregation, go straight to Birdeye ───────
  // Our indexer samples PumpSwap/Raydium at low frequency; internal DB has at
  // most a handful of trades and would produce a misleading chart.
  {
    const [tokenRow] = await db
      .select({ platform: tokensTable.platform })
      .from(tokensTable)
      .where(eq(tokensTable.address, address))
      .limit(1);

    if (tokenRow && DEX_PLATFORMS.has(tokenRow.platform)) {
      const now      = Math.floor(Date.now() / 1000);
      const timeFrom = now - (BIRDEYE_HISTORY_SECS[tf] ?? 86400);

      const [birdeyeBars, overview] = await Promise.all([
        fetchBirdeyeOHLCV(address, tf, timeFrom, now),
        fetchBirdeyeTokenOverview(address),
      ]);

      let bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];

      if (birdeyeBars && birdeyeBars.length > 0) {
        const solPrice = await getSolPriceUsd();
        bars = birdeyeBars.map((b: BirdeyeOHLCVBar) => ({
          time:   b.time,
          open:   solPrice > 0 ? b.open  / solPrice : b.open,
          high:   solPrice > 0 ? b.high  / solPrice : b.high,
          low:    solPrice > 0 ? b.low   / solPrice : b.low,
          close:  solPrice > 0 ? b.close / solPrice : b.close,
          volume: b.volume,
        }));

        if (overview && overview.price > 0 && solPrice > 0) {
          const currentSol    = overview.price / solPrice;
          const candleSecs    = BIRDEYE_TF_SECS[tf] ?? 60;
          const currentBucket = Math.floor(now / candleSecs) * candleSecs;
          const lastBar       = bars[bars.length - 1];

          if (lastBar && lastBar.time === currentBucket) {
            lastBar.high  = Math.max(lastBar.high,  currentSol);
            lastBar.low   = Math.min(lastBar.low,   currentSol);
            lastBar.close = currentSol;
          } else if (!lastBar || currentBucket > lastBar.time) {
            bars.push({
              time:   currentBucket,
              open:   lastBar?.close ?? currentSol,
              high:   currentSol,
              low:    currentSol,
              close:  currentSol,
              volume: 0,
            });
          }

          // Keep DB price fresh without blocking the response
          db.update(tokensTable)
            .set({
              priceEth:     currentSol.toFixed(15),
              priceUsd:     overview.price,
              marketCapEth: overview.mc ? String(Math.round(overview.mc / solPrice * 1e9)) : undefined,
            })
            .where(eq(tokensTable.address, address))
            .catch(() => { /* non-fatal */ });
        }
      }

      const payload = { bars, maxTradeId: 0 };
      _ohlcvCacheSet(cacheKey, payload, tf);
      res.setHeader("X-Cache", "MISS");
      res.json(payload);
      return;
    }
  }

  // Window-function query: one pass over all trades for this token.
  // Ordering within each bucket uses (timestamp ASC, id ASC) — insertion
  // order is the best proxy for on-chain sequence given that blockTime is
  // not yet stored.
  // MAX(id) per bucket (and globally) is included so clients can identify
  // which SSE/live trades are already baked into this aggregate — they
  // should only overlay trades with id > maxTradeId to avoid double-counting.
  const { rows } = await pool.query<{
    bucket: string;
    open:   string;
    high:   string;
    low:    string;
    close:  string;
    volume: string;
    max_id: string;
  }>(`
    WITH ranked AS (
      SELECT
        (FLOOR(EXTRACT(EPOCH FROM timestamp) / $1) * $1)::bigint AS bucket,
        CAST(price_eth  AS DOUBLE PRECISION)                      AS price,
        CAST(eth_amount AS DOUBLE PRECISION)                      AS vol,
        id,
        ROW_NUMBER() OVER (
          PARTITION BY FLOOR(EXTRACT(EPOCH FROM timestamp) / $1)
          ORDER BY timestamp ASC, id ASC
        ) AS rn_asc,
        ROW_NUMBER() OVER (
          PARTITION BY FLOOR(EXTRACT(EPOCH FROM timestamp) / $1)
          ORDER BY timestamp DESC, id DESC
        ) AS rn_desc
      FROM trades
      WHERE token_address = $2
        AND price_eth  IS NOT NULL
        AND CAST(price_eth  AS DOUBLE PRECISION) > 0
        AND CAST(eth_amount AS DOUBLE PRECISION) > 0
        -- Sanity guard: pump.fun prices are never legitimately above ~0.0001 SOL/token.
        -- 1.0 SOL/token is a generous ceiling that blocks corrupted price spikes from
        -- appearing in the chart, even if a future heal-job regression writes bad data.
        AND CAST(price_eth  AS DOUBLE PRECISION) < 1.0
    )
    SELECT
      bucket::text                                    AS bucket,
      MAX(CASE WHEN rn_asc  = 1 THEN price END)::text AS open,
      MAX(price)::text                                AS high,
      MIN(price)::text                                AS low,
      MAX(CASE WHEN rn_desc = 1 THEN price END)::text AS close,
      SUM(vol)::text                                  AS volume,
      MAX(id)::text                                   AS max_id
    FROM ranked
    GROUP BY bucket
    ORDER BY bucket ASC
  `, [bucketSecs, address]);

  let bars = rows.map(r => ({
    time:   parseInt(r.bucket, 10),
    open:   parseFloat(r.open),
    high:   parseFloat(r.high),
    low:    parseFloat(r.low),
    close:  parseFloat(r.close),
    volume: parseFloat(r.volume),
  }));

  // maxTradeId: the highest trade ID present in this aggregate.
  const maxTradeId = rows.reduce((m, r) => Math.max(m, parseInt(r.max_id ?? "0", 10)), 0);

  // ── Birdeye OHLCV proxy for DEX tokens ──────────────────────────────────────
  // If internal trade history is empty, check if this is a DEX token and proxy
  // OHLCV from Birdeye so the chart shows real price history.
  if (bars.length === 0) {
    const [tokenRow] = await db
      .select({ platform: tokensTable.platform })
      .from(tokensTable)
      .where(eq(tokensTable.address, address))
      .limit(1);

    if (tokenRow && DEX_PLATFORMS.has(tokenRow.platform)) {
      const now      = Math.floor(Date.now() / 1000);
      const timeFrom = now - (BIRDEYE_HISTORY_SECS[tf] ?? 86400);

      // Fetch OHLCV bars and current overview in parallel
      const [birdeyeBars, overview] = await Promise.all([
        fetchBirdeyeOHLCV(address, tf, timeFrom, now),
        fetchBirdeyeTokenOverview(address),
      ]);

      if (birdeyeBars && birdeyeBars.length > 0) {
        const solPrice = await getSolPriceUsd();
        bars = birdeyeBars.map((b: BirdeyeOHLCVBar) => ({
          time:   b.time,
          open:   solPrice > 0 ? b.open  / solPrice : b.open,
          high:   solPrice > 0 ? b.high  / solPrice : b.high,
          low:    solPrice > 0 ? b.low   / solPrice : b.low,
          close:  solPrice > 0 ? b.close / solPrice : b.close,
          volume: b.volume,
        }));

        // Append / update a synthetic "current" candle so the chart's last point
        // matches the live Birdeye price — prevents stale-price vs chart mismatch.
        if (overview && overview.price > 0 && solPrice > 0) {
          const currentSol    = overview.price / solPrice;
          const candleSecs    = BIRDEYE_TF_SECS[tf] ?? 60;
          const currentBucket = Math.floor(now / candleSecs) * candleSecs;
          const lastBar       = bars[bars.length - 1];

          if (lastBar && lastBar.time === currentBucket) {
            // Update existing open candle
            lastBar.high  = Math.max(lastBar.high,  currentSol);
            lastBar.low   = Math.min(lastBar.low,   currentSol);
            lastBar.close = currentSol;
          } else if (!lastBar || currentBucket > lastBar.time) {
            // New candle bucket — open at previous close
            bars.push({
              time:   currentBucket,
              open:   lastBar?.close ?? currentSol,
              high:   currentSol,
              low:    currentSol,
              close:  currentSol,
              volume: 0,
            });
          }

          // Background: keep token.price_eth fresh in the DB so the info panel
          // always reflects the current Birdeye price, not the stale backfill value.
          db.update(tokensTable)
            .set({
              priceEth:     currentSol.toFixed(15),
              priceUsd:     overview.price,            // doublePrecision column — store as number
              marketCapEth: overview.mc ? String(Math.round(overview.mc / solPrice * 1e9)) : undefined,
            })
            .where(eq(tokensTable.address, address))
            .catch(() => { /* non-fatal */ });
        }
      }
    }
  }

  const payload = { bars, maxTradeId };
  _ohlcvCacheSet(cacheKey, payload, tf);
  res.setHeader("X-Cache", "MISS");
  res.json(payload);
}));

// GET /tokens/:address/holders — net token balance per wallet across ALL trades in DB.
// Client-side computation from the 100-row trade history only sees a fraction of
// wallets for high-volume tokens; this endpoint has no row limit.
router.get("/tokens/:address/holders", asyncWrap(async (req, res) => {
  const address = req.params.address as string;
  if (!address) { res.status(400).json({ error: "address required" }); return; }

  const { rows } = await pool.query<{
    trader_address: string;
    balance: string;
  }>(`
    SELECT
      trader_address,
      SUM(
        CASE WHEN is_buy
          THEN  CAST(NULLIF(token_amount, '') AS NUMERIC)
          ELSE -CAST(NULLIF(token_amount, '') AS NUMERIC)
        END
      ) AS balance
    FROM trades
    WHERE token_address = $1
      AND token_amount IS NOT NULL
      AND token_amount <> ''
      AND token_amount <> '0'
    GROUP BY trader_address
    HAVING SUM(
      CASE WHEN is_buy
        THEN  CAST(NULLIF(token_amount, '') AS NUMERIC)
        ELSE -CAST(NULLIF(token_amount, '') AS NUMERIC)
      END
    ) > 0
    ORDER BY balance DESC
  `, [address]);

  const holders = rows.map(r => ({
    address: r.trader_address,
    balance: r.balance,
  }));

  res.json({ holders, count: holders.length });
}));

// GET /wallet/:address/holdings — tokens held by a wallet (net balance > 0 across ALL trades)
router.get("/wallet/:address/holdings", asyncWrap(async (req, res) => {
  const wallet = req.params.address as string;
  if (!wallet) { res.status(400).json({ error: "address required" }); return; }

  const { rows } = await pool.query<{
    token_address: string;
    balance: string;
    name: string | null;
    symbol: string | null;
    image_url: string | null;
    price_eth: string | null;
    market_cap_eth: string | null;
    volume_eth: string | null;
    decimals: number | null;
  }>(`
    SELECT
      t.token_address,
      t.balance,
      tok.name,
      tok.symbol,
      tok.image_url,
      tok.price_eth,
      tok.market_cap_eth,
      tok.volume_eth,
      tok.decimals
    FROM (
      SELECT
        token_address,
        SUM(
          CASE WHEN is_buy
            THEN  CAST(NULLIF(token_amount, '') AS NUMERIC)
            ELSE -CAST(NULLIF(token_amount, '') AS NUMERIC)
          END
        ) AS balance
      FROM trades
      WHERE trader_address = $1
        AND token_amount IS NOT NULL
        AND token_amount <> ''
        AND token_amount <> '0'
      GROUP BY token_address
      HAVING SUM(
        CASE WHEN is_buy
          THEN  CAST(NULLIF(token_amount, '') AS NUMERIC)
          ELSE -CAST(NULLIF(token_amount, '') AS NUMERIC)
        END
      ) > 0
    ) t
    LEFT JOIN tokens tok ON tok.address = t.token_address
    ORDER BY t.balance DESC
  `, [wallet]);

  const holdings = rows.map(r => ({
    address: r.token_address,
    balance: r.balance,
    name: r.name ?? r.token_address.slice(0, 8),
    symbol: r.symbol ?? "???",
    imageUrl: r.image_url ?? null,
    priceEth: r.price_eth ?? null,
    marketCapEth: r.market_cap_eth ?? null,
    volumeEth: r.volume_eth ?? null,
    // Fallback to 6 only when the token has no DB row (ghost trade).
    // Any token in the DB uses its stored decimals — even 9, 0, or other.
    decimals: r.decimals ?? 6,
  }));

  res.json({ holdings, count: holdings.length });
}));

// GET /tokens/:address/position?wallet=<address>
// Per-wallet aggregate across ALL trades in DB — no 100-row cap.
// Returns tokensBought/Sold (atomic), solSpent/Received (lamports), tradeCount, maxTradeId.
// maxTradeId lets the client overlay only SSE trades with id > maxTradeId to avoid double-counting.
router.get("/tokens/:address/position", asyncWrap(async (req, res) => {
  const tokenAddress = req.params.address as string;
  const wallet = req.query.wallet as string | undefined;
  if (!tokenAddress) { res.status(400).json({ error: "address required" }); return; }
  if (!wallet)       { res.status(400).json({ error: "wallet required" });  return; }

  const { rows } = await pool.query<{
    tokens_bought: string;
    tokens_sold:   string;
    sol_spent:     string;
    sol_received:  string;
    trade_count:   string;
    max_trade_id:  string;
  }>(`
    SELECT
      COALESCE(SUM(CASE WHEN is_buy
        THEN  CAST(NULLIF(token_amount, '') AS NUMERIC) ELSE 0 END), 0) AS tokens_bought,
      COALESCE(SUM(CASE WHEN NOT is_buy
        THEN  CAST(NULLIF(token_amount, '') AS NUMERIC) ELSE 0 END), 0) AS tokens_sold,
      COALESCE(SUM(CASE WHEN is_buy
        THEN  CAST(NULLIF(eth_amount,   '') AS NUMERIC) ELSE 0 END), 0) AS sol_spent,
      COALESCE(SUM(CASE WHEN NOT is_buy
        THEN  CAST(NULLIF(eth_amount,   '') AS NUMERIC) ELSE 0 END), 0) AS sol_received,
      COUNT(*)          AS trade_count,
      COALESCE(MAX(id), 0) AS max_trade_id
    FROM trades
    WHERE token_address  = $1
      AND trader_address = $2
      AND token_amount IS NOT NULL
      AND token_amount <> ''
      AND token_amount <> '0'
  `, [tokenAddress, wallet]);

  const r = rows[0];
  if (!r || r.trade_count === "0") {
    res.json({ tokensBought: 0, tokensSold: 0, solSpent: 0, solReceived: 0, tradeCount: 0, maxTradeId: 0 });
    return;
  }

  res.json({
    tokensBought: parseFloat(r.tokens_bought),
    tokensSold:   parseFloat(r.tokens_sold),
    solSpent:     parseFloat(r.sol_spent),
    solReceived:  parseFloat(r.sol_received),
    tradeCount:   parseInt(r.trade_count,  10),
    maxTradeId:   parseInt(r.max_trade_id, 10),
  });
}));

// GET /tokens/:address/stats  — 24-hour aggregated stats (SQL, no row-limit)
router.get("/tokens/:address/stats", asyncWrap(async (req, res) => {
  const address = req.params.address as string;
  if (!address) { res.status(400).json({ error: "address required" }); return; }

  const { rows } = await pool.query<{
    vol24h_sol:      string;
    vol24h_buy_sol:  string;
    vol24h_sell_sol: string;
    txns_buy:        string;
    txns_sell:       string;
  }>(`
    SELECT
      COALESCE(SUM(CAST(eth_amount AS NUMERIC)) / 1e9, 0)                                       AS vol24h_sol,
      COALESCE(SUM(CASE WHEN is_buy     THEN CAST(eth_amount AS NUMERIC) ELSE 0 END) / 1e9, 0)  AS vol24h_buy_sol,
      COALESCE(SUM(CASE WHEN NOT is_buy THEN CAST(eth_amount AS NUMERIC) ELSE 0 END) / 1e9, 0)  AS vol24h_sell_sol,
      COUNT(CASE WHEN is_buy     THEN 1 END)                                                     AS txns_buy,
      COUNT(CASE WHEN NOT is_buy THEN 1 END)                                                     AS txns_sell
    FROM trades
    WHERE token_address = $1
      AND timestamp > NOW() - INTERVAL '24 hours'
      AND CAST(eth_amount AS NUMERIC) > 0
  `, [address]);

  const r = rows[0];
  const vol24hSol    = parseFloat(r.vol24h_sol);
  const txns24hBuy   = parseInt(r.txns_buy, 10);
  const txns24hSell  = parseInt(r.txns_sell, 10);

  // If no internal trades found, check if this is a DEX token and use Birdeye vol data
  if (vol24hSol === 0 && txns24hBuy === 0 && txns24hSell === 0) {
    const [tokenRow] = await db
      .select({ platform: tokensTable.platform })
      .from(tokensTable)
      .where(eq(tokensTable.address, address))
      .limit(1);

    if (tokenRow && DEX_PLATFORMS.has(tokenRow.platform)) {
      const pairs = await fetchDexScreenerTokens([address]);
      const pair  = bestSolanaPair(pairs);
      if (pair && pair.volume?.h24) {
        const solPrice      = pairToSolPrice(pair);
        const toSol         = (usd: number) => solPrice > 0 ? usd / solPrice : 0;
        const vol24hSol     = toSol(pair.volume.h24);
        const buys24h       = pair.txns?.h24?.buys  ?? 0;
        const sells24h      = pair.txns?.h24?.sells ?? 0;
        const total24h      = buys24h + sells24h;
        const buyRatio      = total24h > 0 ? buys24h / total24h : 0.5;
        res.json({
          vol24hSol,
          vol24hBuySol:  vol24hSol * buyRatio,
          vol24hSellSol: vol24hSol * (1 - buyRatio),
          txns24hBuy:    buys24h,
          txns24hSell:   sells24h,
        });
        return;
      }
    }
  }

  res.json({
    vol24hSol,
    vol24hBuySol:   parseFloat(r.vol24h_buy_sol),
    vol24hSellSol:  parseFloat(r.vol24h_sell_sol),
    txns24hBuy,
    txns24hSell,
  });
}));

// GET /tokens/:address/price-history  — reference prices at 5m / 1h / 6h / 24h ago
// Used by the frontend to compute % changes without relying on the 100-row history cap.
router.get("/tokens/:address/price-history", asyncWrap(async (req, res) => {
  const address = req.params.address as string;
  if (!address) { res.status(400).json({ error: "address required" }); return; }

  // Helper CTE: the oldest valid price for this token (= launch price fallback).
  // If the token is younger than the cutoff window (e.g. < 5 min old) there is no
  // trade before the cutoff, so we fall back to the first-ever trade so that
  // percentages are shown immediately from launch instead of waiting.
  const { rows } = await pool.query<{
    p5m:  string | null;
    p1h:  string | null;
    p6h:  string | null;
    p24h: string | null;
  }>(`
    WITH oldest AS (
      SELECT CAST(price_eth AS DOUBLE PRECISION)::text AS price
      FROM   trades
      WHERE  token_address = $1
        AND  price_eth IS NOT NULL
        AND  CAST(price_eth AS DOUBLE PRECISION) > 0
        AND  CAST(price_eth AS DOUBLE PRECISION) < 1.0
      ORDER BY timestamp ASC
      LIMIT 1
    )
    SELECT
      COALESCE(
        (SELECT CAST(price_eth AS DOUBLE PRECISION)::text FROM trades
         WHERE token_address = $1
           AND price_eth IS NOT NULL
           AND CAST(price_eth AS DOUBLE PRECISION) > 0
           AND CAST(price_eth AS DOUBLE PRECISION) < 1.0
           AND timestamp <= NOW() - INTERVAL '5 minutes'
         ORDER BY timestamp DESC LIMIT 1),
        (SELECT price FROM oldest)
      ) AS p5m,

      COALESCE(
        (SELECT CAST(price_eth AS DOUBLE PRECISION)::text FROM trades
         WHERE token_address = $1
           AND price_eth IS NOT NULL
           AND CAST(price_eth AS DOUBLE PRECISION) > 0
           AND CAST(price_eth AS DOUBLE PRECISION) < 1.0
           AND timestamp <= NOW() - INTERVAL '1 hour'
         ORDER BY timestamp DESC LIMIT 1),
        (SELECT price FROM oldest)
      ) AS p1h,

      COALESCE(
        (SELECT CAST(price_eth AS DOUBLE PRECISION)::text FROM trades
         WHERE token_address = $1
           AND price_eth IS NOT NULL
           AND CAST(price_eth AS DOUBLE PRECISION) > 0
           AND CAST(price_eth AS DOUBLE PRECISION) < 1.0
           AND timestamp <= NOW() - INTERVAL '6 hours'
         ORDER BY timestamp DESC LIMIT 1),
        (SELECT price FROM oldest)
      ) AS p6h,

      COALESCE(
        (SELECT CAST(price_eth AS DOUBLE PRECISION)::text FROM trades
         WHERE token_address = $1
           AND price_eth IS NOT NULL
           AND CAST(price_eth AS DOUBLE PRECISION) > 0
           AND CAST(price_eth AS DOUBLE PRECISION) < 1.0
           AND timestamp <= NOW() - INTERVAL '24 hours'
         ORDER BY timestamp DESC LIMIT 1),
        (SELECT price FROM oldest)
      ) AS p24h
  `, [address]);

  const r = rows[0];
  const toNum = (v: string | null) => (v != null ? parseFloat(v) : null);
  const internalResult = { p5m: toNum(r.p5m), p1h: toNum(r.p1h), p6h: toNum(r.p6h), p24h: toNum(r.p24h) };

  // For DEX tokens (pumpswap, raydium_launchlab) our internal trade history is
  // often sparse — trades arrive via pumpapi.io stream and gaps exist for older
  // intervals. Try DexScreener whenever ANY interval is null, then back-fill
  // only the missing slots so internal values (more accurate for recent data)
  // take precedence.
  const anyNull = Object.values(internalResult).some(v => v === null);
  if (anyNull) {
    const [tokenRow] = await db
      .select({ platform: tokensTable.platform })
      .from(tokensTable)
      .where(eq(tokensTable.address, address))
      .limit(1);

    if (tokenRow && DEX_PLATFORMS.has(tokenRow.platform)) {
      const pairs = await fetchDexScreenerTokens([address]);
      const pair  = bestSolanaPair(pairs);
      if (pair && pair.priceNative) {
        const dex = pairToPriceHistory(pair);
        // Prefer our internal value when available; fill gaps from DexScreener.
        res.json({
          p5m:  internalResult.p5m  ?? dex.p5m,
          p1h:  internalResult.p1h  ?? dex.p1h,
          p6h:  internalResult.p6h  ?? dex.p6h,
          p24h: internalResult.p24h ?? dex.p24h,
        });
        return;
      }
    }
  }

  res.json(internalResult);
}));

// GET /tokens/:address/trades
router.get("/tokens/:address/trades", asyncWrap(async (req, res) => {
  const params = TradeHistoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const address = params.data.address;

  // Determine platform first so we can skip the price guard for DEX tokens
  const [tokenRow] = await db
    .select({ platform: tokensTable.platform })
    .from(tokensTable)
    .where(eq(tokensTable.address, address))
    .limit(1);

  const isDex = tokenRow && DEX_PLATFORMS.has(tokenRow.platform);

  const trades = await db
    .select()
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.tokenAddress, address),
        // Sanity guard for pump.fun only: prices are never legitimately above 1.0 SOL/token.
        // DEX tokens (cbBTC ~849 SOL/token) must NOT have this filter applied.
        isDex
          ? undefined
          : or(
              isNull(tradesTable.priceEth),
              sql`CAST(${tradesTable.priceEth} AS DOUBLE PRECISION) < 1.0`,
            ),
      ),
    )
    .orderBy(desc(tradesTable.timestamp))
    .limit(100);

  // Internal trades exist — return them directly for pump.fun tokens.
  // For DEX tokens we always prefer Birdeye: our indexer samples PumpSwap
  // at 30-second intervals so DB may have only a handful of trades even for
  // very active tokens, producing a misleadingly sparse trade history.
  if (trades.length > 0 && !isDex) {
    res.json(TradeHistoryResponse.parse(trades));
    return;
  }

  // DEX tokens → always proxy from Birdeye (fall back to sparse DB if Birdeye fails)
  if (isDex) {
    const [birdeyeTrades, solPrice] = await Promise.all([
      fetchBirdeyeTokenTrades(address, 50),
      getSolPriceUsd(),
    ]);

    if (birdeyeTrades && birdeyeTrades.length > 0) {
      // Deduplicate by txHash — Birdeye may return each swap leg separately (multi-hop routes).
      // Prefer the leg where our token appears as an exact match in `to` or `from`.
      const seen = new Map<string, (typeof birdeyeTrades)[number]>();
      for (const item of birdeyeTrades) {
        const existing = seen.get(item.txHash);
        if (!existing) {
          seen.set(item.txHash, item);
        } else {
          const isExact = item.to.address === address || item.from.address === address;
          if (isExact) seen.set(item.txHash, item);
        }
      }
      const deduped = Array.from(seen.values());

      const mapped = deduped.map((item, idx) => {
        // Determine buy/sell: if the token we're tracking is in "to", it was bought
        const isBuy = item.to.address === address
          ? true
          : item.from.address === address
          ? false
          : item.side === "buy";

        const tokenSide = (item.to.address === address) ? item.to : item.from;
        const otherSide = (item.to.address === address) ? item.from : item.to;

        // Token amount in atomic units (ui amount × 10^decimals)
        const tokenDecimals = tokenSide.decimals ?? 6;
        const tokenUiAmt    = Math.abs(tokenSide.uiAmount);
        const tokenAmount   = String(Math.round(tokenUiAmt * Math.pow(10, tokenDecimals)));

        // Trade value in SOL lamports (other-side USD value ÷ SOL price × 1e9)
        const tradeUsd      = Math.abs(otherSide.uiAmount) * (otherSide.price || item.tokenPrice || 0);
        const ethAmount     = solPrice > 0 ? String(Math.round(tradeUsd / solPrice * 1e9)) : "0";

        // Price: SOL per token
        const priceEth = item.tokenPrice > 0 && solPrice > 0
          ? String(item.tokenPrice / solPrice)
          : null;

        return {
          id:             -(item.blockUnixTime * 100 + idx), // synthetic negative ID — won't clash with DB
          tokenAddress:   address,
          traderAddress:  item.owner,
          isBuy,
          ethAmount,
          tokenAmount,
          priceEth,
          txHash:         item.txHash,
          platform:       tokenRow.platform,
          timestamp:      new Date(item.blockUnixTime * 1000).toISOString(),
        };
      });

      // Bypass zod parse — Birdeye data matches shape but uses synthetic IDs
      res.json(mapped);

      // Background: persist these trades to DB so Top Wallets and future
      // requests benefit from a populated trade history. Idempotent — any
      // trades already in DB (from the on-chain indexer) are skipped.
      void backfillBirdeyeTradesToDb(
        address,
        tokenRow.platform,
        null,
        null,
      ).catch(() => { /* non-fatal */ });

      return;
    }
  }

  res.json(TradeHistoryResponse.parse(trades));
}));

// POST /tokens/:address/trades
//
// Security: full on-chain verification required before any write.
//
// fetchAndParseTrade() calls getTransaction on the Solana RPC and:
//   1. Confirms the tx is finalized (meta.err === null, meta present)
//   2. Verifies the fee payer (accountKeys[0]) == traderAddress
//   3. Confirms the expected mint appears in pre/post token balances
//   4. Derives isBuy, tokenAmountAtoms, solAmountLamports from balance deltas
//
// All economic fields (isBuy, ethAmount, tokenAmount, priceEth) stored in the
// DB are derived entirely from the on-chain transaction — the client-supplied
// body values for those fields are ignored.
//
// Internal adapters (pumpfun.ts, pumpswap.ts, etc.) write directly to the DB
// and never call this route. This endpoint exists for external callers who
// want to register a trade they just submitted on-chain.
router.post("/tokens/:address/trades", asyncWrap(async (req, res) => {
  const params = RecordTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = RecordTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { txHash, traderAddress } = parsed.data;
  const tokenAddress = params.data.address;

  // ── txHash format guard ───────────────────────────────────────────────────
  // Reject obviously invalid signatures before making any RPC call.
  if (!SOLANA_SIG_RE.test(txHash)) {
    res.status(400).json({
      error: "txHash must be a valid Solana transaction signature (87-88 base58 chars)",
    });
    return;
  }

  // ── Duplicate guard ───────────────────────────────────────────────────────
  // If the indexer already recorded this tx, return 200 immediately rather
  // than spending an RPC call and then hitting the unique-constraint.
  const [alreadyIndexed] = await db
    .select({ id: tradesTable.id })
    .from(tradesTable)
    .where(eq(tradesTable.txHash, txHash))
    .limit(1);

  if (alreadyIndexed) {
    res.status(200).json({ id: alreadyIndexed.id, alreadyIndexed: true });
    return;
  }

  // ── On-chain verification (derives all economic fields) ───────────────────
  const verification = await fetchAndParseTrade(txHash, tokenAddress, traderAddress);

  if (!verification.ok) {
    res.status(verification.status).json({ error: verification.error });
    return;
  }

  // verification.ok === true: all fields are derived from the transaction.
  const { isBuy, tokenAmountAtoms, solAmountLamports, priceEth } = verification;

  // ── Look up token for denormalization + SSE payload ───────────────────────
  const [token] = await db
    .select()
    .from(tokensTable)
    .where(eq(tokensTable.address, tokenAddress));

  // ── Insert trade (idempotent via onConflictDoNothing) ─────────────────────
  // A concurrent indexer write between our duplicate-check and this INSERT is
  // handled gracefully — onConflictDoNothing returns undefined instead of
  // throwing a unique-constraint error.
  const [trade] = await db
    .insert(tradesTable)
    .values({
      tokenAddress,
      tokenName:    token?.name   ?? null,
      tokenSymbol:  token?.symbol ?? null,
      traderAddress,
      // ↓ All economic fields are server-derived from on-chain data.
      //   Client-supplied body values (isBuy, ethAmount, tokenAmount, priceEth)
      //   are intentionally ignored here.
      isBuy,
      ethAmount:    solAmountLamports,
      tokenAmount:  tokenAmountAtoms,
      priceEth:     priceEth ?? null,
      txHash,
      platform:     token?.platform ?? "unknown",
      // Use the RPC blockTime as the authoritative timestamp.
      // If the RPC omitted blockTime (some archive nodes do), fall back to
      // server time — never trust the client-supplied timestamp.
      timestamp: verification.blockTime
        ? new Date(verification.blockTime * 1000)
        : new Date(),
    })
    .onConflictDoNothing()
    .returning();

  if (!trade) {
    // Concurrent indexer inserted between our duplicate-check and this INSERT
    res.status(200).json({ alreadyIndexed: true });
    return;
  }

  // ── Broadcast to SSE subscribers ──────────────────────────────────────────
  if (token) {
    emitTrade({
      type: "trade",
      trade: {
        id:            trade.id,
        tokenAddress:  trade.tokenAddress,
        traderAddress: trade.traderAddress,
        isBuy:         trade.isBuy,
        ethAmount:     trade.ethAmount,
        tokenAmount:   trade.tokenAmount,
        priceEth:      trade.priceEth,
        txHash:        trade.txHash,
        platform:      trade.platform,
        timestamp:     trade.timestamp.toISOString(),
      },
      token: {
        address:              token.address,
        name:                 token.name,
        symbol:               token.symbol,
        priceEth:             token.priceEth,
        marketCapEth:         token.marketCapEth,
        volumeEth:            token.volumeEth,
        virtualEthReserves:   token.virtualEthReserves,
        virtualTokenReserves: token.virtualTokenReserves,
        tradeCount:           Number(token.tradeCount),
        platform:             token.platform,
        chain:                token.chain,
      },
    });
  }

  res.status(201).json(RecordTradeResponse.parse(trade));
}));

// GET /tokens/:address/top-wallets — per-wallet P&L and trade stats across ALL trades in DB.
// Returns top 50 wallets by net token balance with SOL in/out, avg entry, and trade counts.
router.get("/tokens/:address/top-wallets", asyncWrap(async (req, res) => {
  const address = req.params.address as string;
  if (!address) { res.status(400).json({ error: "address required" }); return; }

  // For DEX tokens (graduated pump.fun → pumpswap, raydium_launchlab), pull the
  // latest Birdeye trades into the DB before computing wallet stats. This captures
  // Jupiter/aggregator swaps that our on-chain adapters never saw, so the leaderboard
  // reflects the real post-graduation trade history rather than just indexed samples.
  // Birdeye call + DB upsert adds ~300–400 ms on the first view; repeat calls are
  // near-instant because ON CONFLICT DO NOTHING skips already-present rows.
  const [tokenRowForWallets] = await db
    .select({ platform: tokensTable.platform, name: tokensTable.name, symbol: tokensTable.symbol })
    .from(tokensTable)
    .where(eq(tokensTable.address, address))
    .limit(1);

  if (tokenRowForWallets && DEX_PLATFORMS.has(tokenRowForWallets.platform)) {
    await backfillBirdeyeTradesToDb(
      address,
      tokenRowForWallets.platform,
      tokenRowForWallets.name ?? null,
      tokenRowForWallets.symbol ?? null,
    );
  }

  const { rows } = await pool.query<{
    trader_address: string;
    balance: string;
    total_sol_in: string;
    total_sol_out: string;
    buy_count: string;
    sell_count: string;
    trade_count: string;
    last_activity: string;
    avg_entry_lamports_per_token: string | null;
  }>(`
    SELECT
      trader_address,
      SUM(CASE WHEN is_buy
        THEN  CAST(NULLIF(token_amount, '') AS NUMERIC)
        ELSE -CAST(NULLIF(token_amount, '') AS NUMERIC)
      END) AS balance,
      COALESCE(SUM(CASE WHEN is_buy      THEN CAST(NULLIF(eth_amount,'') AS NUMERIC) ELSE 0 END), 0) AS total_sol_in,
      COALESCE(SUM(CASE WHEN NOT is_buy  THEN CAST(NULLIF(eth_amount,'') AS NUMERIC) ELSE 0 END), 0) AS total_sol_out,
      SUM(CASE WHEN is_buy      THEN 1 ELSE 0 END)::int AS buy_count,
      SUM(CASE WHEN NOT is_buy  THEN 1 ELSE 0 END)::int AS sell_count,
      COUNT(*)::int AS trade_count,
      MAX(timestamp) AS last_activity,
      SUM(CASE WHEN is_buy THEN CAST(NULLIF(eth_amount,'') AS NUMERIC) ELSE 0 END) /
        NULLIF(SUM(CASE WHEN is_buy THEN CAST(NULLIF(token_amount,'') AS NUMERIC) ELSE 0 END), 0)
        AS avg_entry_lamports_per_token
    FROM trades
    WHERE token_address = $1
      AND token_amount IS NOT NULL AND token_amount <> '' AND token_amount <> '0'
      AND eth_amount   IS NOT NULL AND eth_amount   <> ''
    GROUP BY trader_address
    HAVING SUM(CASE WHEN is_buy
      THEN  CAST(NULLIF(token_amount, '') AS NUMERIC)
      ELSE -CAST(NULLIF(token_amount, '') AS NUMERIC)
    END) > 0
    ORDER BY balance DESC
    LIMIT 50
  `, [address]);

  const wallets = rows.map(r => ({
    address:                    r.trader_address,
    balance:                    r.balance,
    totalSolIn:                 r.total_sol_in,
    totalSolOut:                r.total_sol_out,
    buyCount:                   Number(r.buy_count),
    sellCount:                  Number(r.sell_count),
    tradeCount:                 Number(r.trade_count),
    lastActivity:               new Date(r.last_activity),
    avgEntryLamportsPerToken:   r.avg_entry_lamports_per_token ?? null,
  }));

  res.json({ wallets, count: wallets.length });
}));

export default router;
