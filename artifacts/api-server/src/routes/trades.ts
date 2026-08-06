import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, tradesTable, tokensTable } from "@workspace/db";
import {
  TradeHistoryParams,
  TradeHistoryResponse,
  RecordTradeParams,
  RecordTradeBody,
  RecordTradeResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

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

  // Look up token name/symbol for denormalization
  const [token] = await db
    .select({ name: tokensTable.name, symbol: tokensTable.symbol })
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
      timestamp: new Date(parsed.data.timestamp),
    })
    .returning();

  res.status(201).json(RecordTradeResponse.parse(trade));
});

export default router;
