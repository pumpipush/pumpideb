import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc } from "drizzle-orm";
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

const router: IRouter = Router();

// GET /tokens/:address/stream  — Server-Sent Events for live trade feed
router.get("/tokens/:address/stream", async (req: Request, res: Response) => {
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

  // Initial ping to confirm connection is live
  res.write(": ping\n\n");

  // Immediately push the current token state so the UI populates without
  // waiting for the next trade event to arrive.
  const [tokenRow] = await db
    .select()
    .from(tokensTable)
    .where(eq(tokensTable.address, address));

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

  // Send a heartbeat comment every 25s so the connection stays alive through proxies
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);

  const tradeHandler    = (event: TradeEvent)    => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const snapshotHandler = (event: SnapshotEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  tradeEmitter.on(`trade:${address}`,    tradeHandler);
  tradeEmitter.on(`snapshot:${address}`, snapshotHandler);

  req.on("close", () => {
    clearInterval(heartbeat);
    tradeEmitter.off(`trade:${address}`,    tradeHandler);
    tradeEmitter.off(`snapshot:${address}`, snapshotHandler);
  });
});

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
router.get("/tokens/:address/ohlcv", async (req, res): Promise<void> => {
  const address = req.params.address as string;
  if (!address) { res.status(400).json({ error: "address required" }); return; }

  const tf = (req.query.tf as string | undefined) ?? "15m";
  const bucketSecs = OHLCV_BUCKET_SECONDS[tf];
  if (!bucketSecs) {
    res.status(400).json({ error: `Unknown timeframe '${tf}'. Valid: ${Object.keys(OHLCV_BUCKET_SECONDS).join(", ")}` });
    return;
  }

  // Window-function query: one pass over all trades for this token.
  // Ordering within each bucket uses (timestamp ASC, id ASC) — insertion
  // order is the best proxy for on-chain sequence given that blockTime is
  // not yet stored.
  const { rows } = await pool.query<{
    bucket: string;
    open:   string;
    high:   string;
    low:    string;
    close:  string;
    volume: string;
  }>(`
    WITH ranked AS (
      SELECT
        (FLOOR(EXTRACT(EPOCH FROM timestamp) / $1) * $1)::bigint AS bucket,
        CAST(price_eth  AS DOUBLE PRECISION)                      AS price,
        CAST(eth_amount AS DOUBLE PRECISION)                      AS vol,
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
    )
    SELECT
      bucket::text                                    AS bucket,
      MAX(CASE WHEN rn_asc  = 1 THEN price END)::text AS open,
      MAX(price)::text                                AS high,
      MIN(price)::text                                AS low,
      MAX(CASE WHEN rn_desc = 1 THEN price END)::text AS close,
      SUM(vol)::text                                  AS volume
    FROM ranked
    GROUP BY bucket
    ORDER BY bucket ASC
  `, [bucketSecs, address]);

  const bars = rows.map(r => ({
    time:   parseInt(r.bucket, 10),
    open:   parseFloat(r.open),
    high:   parseFloat(r.high),
    low:    parseFloat(r.low),
    close:  parseFloat(r.close),
    volume: parseFloat(r.volume),
  }));

  res.json(bars);
});

// GET /tokens/:address/trades
router.get("/tokens/:address/trades", async (req, res): Promise<void> => {
  const params = TradeHistoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const trades = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.tokenAddress, params.data.address))
    .orderBy(desc(tradesTable.timestamp))
    .limit(100);

  res.json(TradeHistoryResponse.parse(trades));
});

// POST /tokens/:address/trades
router.post("/tokens/:address/trades", async (req, res): Promise<void> => {
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

  // Look up token for denormalization + SSE payload
  const [token] = await db
    .select()
    .from(tokensTable)
    .where(eq(tokensTable.address, params.data.address));

  const [trade] = await db
    .insert(tradesTable)
    .values({
      tokenAddress: params.data.address,
      tokenName: token?.name ?? null,
      tokenSymbol: token?.symbol ?? null,
      traderAddress: parsed.data.traderAddress,
      isBuy: parsed.data.isBuy,
      ethAmount: parsed.data.ethAmount,
      tokenAmount: parsed.data.tokenAmount,
      priceEth: parsed.data.priceEth ?? null,
      txHash: parsed.data.txHash,
      platform: parsed.data.platform ?? token?.platform ?? "unknown",
      timestamp: new Date(parsed.data.timestamp),
    })
    .returning();

  const response = RecordTradeResponse.parse(trade);

  // Broadcast to SSE subscribers (per-token channel + global feed)
  if (token) {
    emitTrade({
      type: "trade",
      trade: {
        id: trade.id,
        tokenAddress: trade.tokenAddress,
        traderAddress: trade.traderAddress,
        isBuy: trade.isBuy,
        ethAmount: trade.ethAmount,
        tokenAmount: trade.tokenAmount,
        priceEth: trade.priceEth,
        txHash: trade.txHash,
        platform: trade.platform,
        timestamp: trade.timestamp.toISOString(),
      },
      token: {
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        priceEth: token.priceEth,
        marketCapEth: token.marketCapEth,
        volumeEth: token.volumeEth,
        virtualEthReserves: token.virtualEthReserves,
        virtualTokenReserves: token.virtualTokenReserves,
        tradeCount: Number(token.tradeCount),
        platform: token.platform,
        chain: token.chain,
      },
    });
  }

  res.status(201).json(response);
});

export default router;
