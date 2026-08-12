import { Router, type IRouter } from "express";
import { asyncWrap } from "../lib/asyncHandler.js";
import { desc, sql, gte } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import {
  GetPlatformStatsResponse,
  GetRecentActivityQueryParams,
  GetRecentActivityResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /stats
router.get("/stats", asyncWrap(async (_req, res) => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [totalStats] = await db
    .select({
      totalTokens: sql<number>`count(*)::int`,
      totalGraduated: sql<number>`count(*) filter (where ${tokensTable.graduated} = true)::int`,
      totalVolumeEth: sql<string>`coalesce(sum(${tokensTable.volumeEth}::numeric)::text, '0')`,
    })
    .from(tokensTable);

  const [tradeStats] = await db
    .select({
      totalTrades: sql<number>`count(*)::int`,
    })
    .from(tradesTable);

  const [recent] = await db
    .select({
      tokensLast24h: sql<number>`count(*)::int`,
    })
    .from(tokensTable)
    .where(gte(tokensTable.createdAt, yesterday));

  const [recentTrades] = await db
    .select({
      tradesLast24h: sql<number>`count(*)::int`,
      volumeLast24h: sql<string>`coalesce(sum(${tradesTable.ethAmount}::numeric)::text, '0')`,
    })
    .from(tradesTable)
    .where(gte(tradesTable.timestamp, yesterday));

  const stats = {
    totalTokens: totalStats?.totalTokens ?? 0,
    totalGraduated: totalStats?.totalGraduated ?? 0,
    totalVolumeEth: totalStats?.totalVolumeEth ?? "0",
    totalTrades: tradeStats?.totalTrades ?? 0,
    tokensLast24h: recent?.tokensLast24h ?? 0,
    volumeLast24h: recentTrades?.volumeLast24h ?? "0",
    tradesLast24h: recentTrades?.tradesLast24h ?? 0,
  };

  res.json(GetPlatformStatsResponse.parse(stats));
}));

// GET /stats/recent-activity
router.get("/stats/recent-activity", asyncWrap(async (req, res) => {
  const parsed = GetRecentActivityQueryParams.safeParse(req.query);
  const limit = parsed.success ? Number(parsed.data.limit ?? 20) : 20;

  const activity = await db
    .select({
      id: tradesTable.id,
      tokenAddress: tradesTable.tokenAddress,
      tokenName: tradesTable.tokenName,
      tokenSymbol: tradesTable.tokenSymbol,
      tokenImageUrl: tokensTable.imageUrl,
      traderAddress: tradesTable.traderAddress,
      isBuy: tradesTable.isBuy,
      ethAmount: tradesTable.ethAmount,
      tokenAmount: tradesTable.tokenAmount,
      txHash: tradesTable.txHash,
      timestamp: tradesTable.timestamp,
    })
    .from(tradesTable)
    .leftJoin(tokensTable, sql`${tradesTable.tokenAddress} = ${tokensTable.address}`)
    .orderBy(desc(tradesTable.timestamp))
    .limit(limit);

  // Ensure required fields have fallbacks
  const safe = activity.map((a) => ({
    ...a,
    tokenName: a.tokenName ?? "Unknown",
    tokenSymbol: a.tokenSymbol ?? "???",
  }));

  res.json(GetRecentActivityResponse.parse(safe));
}));

export default router;
