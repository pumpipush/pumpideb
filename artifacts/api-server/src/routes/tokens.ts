import { Router, type IRouter } from "express";
import { eq, desc, ilike, and, sql } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import {
  ListTokensQueryParams,
  ListTokensResponse,
  CreateTokenBody,
  CreateTokenResponse,
  GetTrendingTokensQueryParams,
  GetTrendingTokensResponse,
  GetTokenParams,
  GetTokenResponse,
  UpdateTokenParams,
  UpdateTokenBody,
  UpdateTokenResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /tokens
router.get("/tokens", async (req, res): Promise<void> => {
  const parsed = ListTokensQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sort = "newest", limit = 20, offset = 0, search, graduated } = parsed.data;

  let query = db.select().from(tokensTable).$dynamic();

  const conditions = [];
  if (search) {
    conditions.push(
      sql`(${ilike(tokensTable.name, `%${search}%`)} OR ${ilike(tokensTable.symbol, `%${search}%`)})`
    );
  }
  if (graduated !== undefined) {
    conditions.push(eq(tokensTable.graduated, graduated));
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  switch (sort) {
    case "volume":
      query = query.orderBy(desc(tokensTable.volumeEth));
      break;
    case "marketcap":
      query = query.orderBy(desc(tokensTable.marketCapEth));
      break;
    case "trending":
      query = query.orderBy(desc(tokensTable.tradeCount));
      break;
    case "newest":
    default:
      query = query.orderBy(desc(tokensTable.createdAt));
      break;
  }

  const tokens = await query.limit(Number(limit)).offset(Number(offset));
  res.json(ListTokensResponse.parse(tokens.map(formatToken)));
});

// POST /tokens
router.post("/tokens", async (req, res): Promise<void> => {
  const parsed = CreateTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [token] = await db
    .insert(tokensTable)
    .values({
      address: parsed.data.address,
      name: parsed.data.name,
      symbol: parsed.data.symbol,
      description: parsed.data.description ?? null,
      imageUrl: parsed.data.imageUrl ?? null,
      creatorAddress: parsed.data.creatorAddress,
      totalSupply: parsed.data.totalSupply,
      virtualTokenReserves: parsed.data.virtualTokenReserves,
      virtualEthReserves: parsed.data.virtualEthReserves,
      twitterUrl: parsed.data.twitterUrl ?? null,
      telegramUrl: parsed.data.telegramUrl ?? null,
      websiteUrl: parsed.data.websiteUrl ?? null,
      platform: parsed.data.platform ?? "unknown",
      chain: parsed.data.chain ?? "base",
    })
    .returning();

  res.status(201).json(CreateTokenResponse.parse(formatToken(token)));
});

// GET /tokens/trending
router.get("/tokens/trending", async (req, res): Promise<void> => {
  const parsed = GetTrendingTokensQueryParams.safeParse(req.query);
  const limit = parsed.success ? Number(parsed.data.limit ?? 10) : 10;

  const tokens = await db
    .select()
    .from(tokensTable)
    .where(eq(tokensTable.graduated, false))
    .orderBy(desc(tokensTable.tradeCount))
    .limit(limit);

  res.json(GetTrendingTokensResponse.parse(tokens.map(formatToken)));
});

// GET /tokens/:address
router.get("/tokens/:address", async (req, res): Promise<void> => {
  const params = GetTokenParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [token] = await db
    .select()
    .from(tokensTable)
    .where(eq(tokensTable.address, params.data.address));

  if (!token) {
    res.status(404).json({ error: "Token not found" });
    return;
  }

  res.json(GetTokenResponse.parse(formatToken(token)));
});

// PATCH /tokens/:address
router.patch("/tokens/:address", async (req, res): Promise<void> => {
  const params = UpdateTokenParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  const d = parsed.data;
  if (d.virtualTokenReserves !== undefined) updates.virtualTokenReserves = d.virtualTokenReserves;
  if (d.virtualEthReserves !== undefined) updates.virtualEthReserves = d.virtualEthReserves;
  if (d.realTokenReserves !== undefined) updates.realTokenReserves = d.realTokenReserves;
  if (d.realEthReserves !== undefined) updates.realEthReserves = d.realEthReserves;
  if (d.marketCapEth !== undefined) updates.marketCapEth = d.marketCapEth;
  if (d.priceEth !== undefined) updates.priceEth = d.priceEth;
  if (d.graduated !== undefined) updates.graduated = d.graduated;
  if (d.volumeEth !== undefined) updates.volumeEth = d.volumeEth;
  if (d.tradeCount !== undefined) updates.tradeCount = String(d.tradeCount);
  if (d.holderCount !== undefined) updates.holderCount = String(d.holderCount);

  const [token] = await db
    .update(tokensTable)
    .set(updates)
    .where(eq(tokensTable.address, params.data.address))
    .returning();

  if (!token) {
    res.status(404).json({ error: "Token not found" });
    return;
  }

  res.json(UpdateTokenResponse.parse(formatToken(token)));
});

function formatToken(t: typeof tokensTable.$inferSelect) {
  return {
    ...t,
    tradeCount: Number(t.tradeCount),
    holderCount: Number(t.holderCount),
  };
}

export default router;
