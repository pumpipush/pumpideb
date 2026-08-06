/**
 * Global SSE feed — GET /api/feed/stream
 *
 * Streams every newToken launch and trade event from all platform adapters
 * (Pump.fun, Moonshot, LetsBONK) in real time to connected frontend clients.
 *
 * Message format (JSON):
 *   { type: "newToken", token: { address, name, symbol, imageUrl, priceEth,
 *       marketCapEth, platform, chain, createdAt } }
 *   { type: "trade", trade: { id, tokenAddress, traderAddress, isBuy, ethAmount,
 *       tokenAmount, priceEth, txHash, platform, timestamp },
 *     token: { address, name, symbol, priceEth, marketCapEth, volumeEth,
 *       virtualEthReserves, virtualTokenReserves, tradeCount, platform, chain } }
 *   ": ping"  — heartbeat comment every 25 s (not a message event)
 *
 * Clients should use the browser EventSource API with its built-in auto-retry.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  tradeEmitter,
  type TradeEvent,
  type NewTokenEvent,
} from "../lib/tradeEmitter";

const router: IRouter = Router();

const HEARTBEAT_INTERVAL_MS = 25_000;

router.get("/feed/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Initial ping so the client knows the connection is live
  res.write(": ping\n\n");

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_INTERVAL_MS);

  const onTrade = (event: TradeEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const onNewToken = (event: NewTokenEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  tradeEmitter.on("trade:*", onTrade);
  tradeEmitter.on("newToken:*", onNewToken);

  req.on("close", () => {
    clearInterval(heartbeat);
    tradeEmitter.off("trade:*", onTrade);
    tradeEmitter.off("newToken:*", onNewToken);
  });
});

export default router;
