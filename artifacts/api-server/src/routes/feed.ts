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
 *   { type: "ping" } — heartbeat every 5 s to keep the connection alive and
 *       reset the client-side watchdog timer
 *
 * On connect, the server immediately replays the last 30 tokens from the
 * current server session (created_at >= SERVER_START_TIME) as newToken events.
 * This fills the "New" tab instantly without waiting for the next live event.
 *
 * Clients should use the browser EventSource API with its built-in auto-retry.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { desc, gte } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import {
  tradeEmitter,
  type TradeEvent,
  type NewTokenEvent,
} from "../lib/tradeEmitter";
import { SERVER_START_TIME } from "../lib/serverMeta.js";

const router: IRouter = Router();

/** Heartbeat every 5 s — keeps SSE alive through proxies and resets client watchdog. */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** How many recent tokens to replay to each new SSE client on connect. */
const REPLAY_LIMIT = 30;

router.get("/feed/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Initial ping — fires onmessage immediately so the client watchdog resets.
  res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);

  // ── Replay recent tokens ────────────────────────────────────────────────────
  // Push the last REPLAY_LIMIT tokens from the current server session so the
  // "New" tab populates immediately on page load without waiting for live events.
  void (async () => {
    try {
      const recent = await db
        .select({
          address:      tokensTable.address,
          name:         tokensTable.name,
          symbol:       tokensTable.symbol,
          imageUrl:     tokensTable.imageUrl,
          priceEth:     tokensTable.priceEth,
          marketCapEth: tokensTable.marketCapEth,
          platform:     tokensTable.platform,
          chain:        tokensTable.chain,
          createdAt:    tokensTable.createdAt,
          graduated:    tokensTable.graduated,
          tradeCount:   tokensTable.tradeCount,
        })
        .from(tokensTable)
        .where(gte(tokensTable.createdAt, SERVER_START_TIME))
        .orderBy(desc(tokensTable.createdAt))
        .limit(REPLAY_LIMIT);

      // Push oldest-first so the client sees them in chronological order
      // (the "New" tab prepends, so newest arrives last and ends up at top).
      for (const t of recent.reverse()) {
        if (res.writableEnded) break;
        const event: NewTokenEvent = {
          type: "newToken",
          token: {
            address:      t.address,
            name:         t.name ?? "???",
            symbol:       t.symbol ?? "???",
            imageUrl:     t.imageUrl ?? null,
            priceEth:     t.priceEth ?? null,
            marketCapEth: t.marketCapEth ?? null,
            platform:     t.platform,
            chain:        t.chain,
            createdAt:    (t.createdAt instanceof Date
              ? t.createdAt.toISOString()
              : String(t.createdAt)),
            tradeCount:   Number(t.tradeCount ?? 0),
          },
        };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch {
      // Non-fatal — live events still flow; replay is a UX enhancement.
    }
  })();

  // ── Periodic heartbeat ─────────────────────────────────────────────────────
  const safeSend = (payload: unknown) => {
    if (!res.writableEnded && !res.destroyed) {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* ignore write-after-close */ }
    }
  };

  const heartbeat = setInterval(() => safeSend({ type: "ping" }), HEARTBEAT_INTERVAL_MS);

  // ── Live event forwarding ──────────────────────────────────────────────────
  const onTrade    = (event: TradeEvent)    => safeSend(event);
  const onNewToken = (event: NewTokenEvent) => safeSend(event);

  tradeEmitter.on("trade:*", onTrade);
  tradeEmitter.on("newToken:*", onNewToken);

  req.on("close", () => {
    clearInterval(heartbeat);
    tradeEmitter.off("trade:*", onTrade);
    tradeEmitter.off("newToken:*", onNewToken);
  });
});

export default router;
