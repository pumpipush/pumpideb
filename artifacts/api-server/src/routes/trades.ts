import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc } from "drizzle-orm";
import { db, tradesTable, tokensTable } from "@workspace/db";
import {
  TradeHistoryParams,
  TradeHistoryResponse,
  RecordTradeParams,
  RecordTradeBody,
  RecordTradeResponse,
} from "@workspace/api-zod";
import { emitTrade, tradeEmitter, type TradeEvent } from "../lib/tradeEmitter";

const router: IRouter = Router();

// GET /tokens/:address/stream  — Server-Sent Events for live trade feed
router.get("/tokens/:address/stream", (req: Request, res: Response) => {
  const { address } = req.params;
  if (!address) {
    res.status(400).json({ error: "address required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if present
  res.flushHeaders();

  // Send a heartbeat comment every 20s so the connection stays alive
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 20_000);

  const handler = (event: TradeEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const channel = `trade:${address}`;
  tradeEmitter.on(channel, handler);

  req.on("close", () => {
    clearInterval(heartbeat);
    tradeEmitter.off(channel, handler);
  });
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

  // Broadcast to SSE subscribers
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
        timestamp: trade.timestamp.toISOString(),
      },
      token: {
        address: token.address,
        priceEth: token.priceEth,
        marketCapEth: token.marketCapEth,
        volumeEth: token.volumeEth,
        virtualEthReserves: token.virtualEthReserves,
        virtualTokenReserves: token.virtualTokenReserves,
        tradeCount: Number(token.tradeCount),
      },
    });
  }

  res.status(201).json(response);
});

export default router;
