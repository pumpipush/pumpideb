import { Router, type IRouter } from "express";
import { eq, desc, ilike, and, not, sql } from "drizzle-orm";
import { db, pool, tokensTable } from "@workspace/db";
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

// ── Helper: fetch 24-hour price % change for a set of token addresses ────────
// Returns a Map<address, pctChange24h>. Tokens with no trades in the window
// are absent from the map (caller should treat as null).
async function fetch24hPctChanges(addresses: string[]): Promise<Map<string, number>> {
  if (addresses.length === 0) return new Map();
  const { rows } = await pool.query<{ token_address: string; pct_change_24h: string }>(
    `SELECT
       o.token_address,
       CASE WHEN o.price_eth::numeric > 0
         THEN ((c.price_eth::numeric - o.price_eth::numeric) / o.price_eth::numeric * 100)
         ELSE 0
       END AS pct_change_24h
     FROM (
       SELECT DISTINCT ON (token_address) token_address, price_eth
       FROM   trades
       WHERE  timestamp   > NOW() - INTERVAL '24 hours'
         AND  price_eth  IS NOT NULL
         AND  price_eth::numeric > 0
         AND  token_address = ANY($1)
       ORDER  BY token_address, timestamp ASC
     ) o
     JOIN (
       SELECT DISTINCT ON (token_address) token_address, price_eth
       FROM   trades
       WHERE  timestamp   > NOW() - INTERVAL '24 hours'
         AND  price_eth  IS NOT NULL
         AND  price_eth::numeric > 0
         AND  token_address = ANY($1)
       ORDER  BY token_address, timestamp DESC
     ) c ON o.token_address = c.token_address`,
    [addresses],
  );
  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.token_address, parseFloat(row.pct_change_24h));
  }
  return result;
}

// GET /tokens
router.get("/tokens", async (req, res): Promise<void> => {
  const parsed = ListTokensQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sort = "newest", limit = 20, offset = 0, search, graduated, platform } = parsed.data;

  // ── Trending: pre-aggregated JOIN to avoid correlated subquery per-row ──────
  if (sort === "trending") {
    const fetchLimit = Number(limit) * 4;
    const params: unknown[] = [];
    const where: string[] = [`t.symbol != '???'`];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(t.name ILIKE $${params.length} OR t.symbol ILIKE $${params.length})`);
    }
    if (graduated !== undefined) {
      params.push(graduated);
      where.push(`t.graduated = $${params.length}`);
    }
    if (platform) {
      params.push(platform);
      where.push(`t.platform = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(fetchLimit);
    const { rows } = await pool.query<Record<string, unknown>>(`
      SELECT t.*,
             COALESCE(r.cnt, 0) AS recent_trade_count
      FROM   tokens t
      LEFT JOIN (
        SELECT token_address, COUNT(*) AS cnt
        FROM   trades
        WHERE  timestamp > NOW() - INTERVAL '1 hour'
        GROUP  BY token_address
      ) r ON r.token_address = t.address
      ${whereSql}
      ORDER  BY recent_trade_count DESC, t.trade_count DESC
      LIMIT  $${params.length}
    `, params);
    const seen = new Set<string>();
    const tokens = rows.filter(t => {
      const key = String(t["symbol"] ?? "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, Number(limit));
    // Map raw rows → token shape expected by formatToken
    const mapped = tokens.map(r => ({
      id:                   r["id"] as string,
      address:              r["address"] as string,
      name:                 r["name"] as string,
      symbol:               r["symbol"] as string,
      description:          r["description"] as string | null,
      imageUrl:             r["image_url"] as string | null,
      creatorAddress:       r["creator_address"] as string,
      totalSupply:          r["total_supply"] as string,
      virtualTokenReserves: r["virtual_token_reserves"] as string,
      virtualEthReserves:   r["virtual_eth_reserves"] as string,
      realTokenReserves:    r["real_token_reserves"] as string,
      realEthReserves:      r["real_eth_reserves"] as string,
      marketCapEth:         r["market_cap_eth"] as string | null,
      priceEth:             r["price_eth"] as string | null,
      volumeEth:            r["volume_eth"] as string | null,
      twitterUrl:           r["twitter_url"] as string | null,
      telegramUrl:          r["telegram_url"] as string | null,
      websiteUrl:           r["website_url"] as string | null,
      platform:             r["platform"] as string,
      chain:                r["chain"] as string,
      graduated:            r["graduated"] as boolean,
      graduatedAt:          r["graduated_at"] as string | null,
      tradeCount:           Number(r["trade_count"] ?? 0),
      holderCount:          Number(r["holder_count"] ?? 0),
      createdAt:            r["created_at"] as string,
      updatedAt:            r["updated_at"] as string,
    }));
    const pctChanges = await fetch24hPctChanges(mapped.map(r => r.address));
    res.json(ListTokensResponse.parse(mapped.map(r => formatToken(r, pctChanges.get(r.address)))));
    return;
  }

  let query = db.select().from(tokensTable).$dynamic();

  const conditions = [];
  // Filter out placeholder tokens that haven't been enriched yet
  conditions.push(sql`${tokensTable.symbol} != '???'`);
  if (search) {
    conditions.push(
      sql`(${ilike(tokensTable.name, `%${search}%`)} OR ${ilike(tokensTable.symbol, `%${search}%`)})`
    );
  }
  if (graduated !== undefined) {
    conditions.push(eq(tokensTable.graduated, graduated));
  }
  if (platform) {
    conditions.push(eq(tokensTable.platform, platform));
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  switch (sort) {
    case "volume":
      query = query.orderBy(desc(sql<number>`CAST(COALESCE(NULLIF(${tokensTable.volumeEth},''), '0') AS NUMERIC)`));
      break;
    case "marketcap":
      query = query.orderBy(desc(sql<number>`CAST(COALESCE(NULLIF(${tokensTable.marketCapEth},''), '0') AS NUMERIC)`));
      break;
    case "newest":
    default:
      query = query.orderBy(desc(tokensTable.createdAt));
      break;
  }

  const raw = await query.limit(Number(limit) * 4).offset(Number(offset));
  const seen = new Set<string>();
  const tokens = raw.filter(t => {
    const key = t.symbol.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Number(limit));

  const pctChanges = await fetch24hPctChanges(tokens.map(t => t.address));
  res.json(ListTokensResponse.parse(tokens.map(t => formatToken(t, pctChanges.get(t.address)))));
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
    .where(
      and(
        eq(tokensTable.graduated, false),
        not(eq(tokensTable.symbol, "???"))
      )
    )
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

function formatToken(t: typeof tokensTable.$inferSelect | Record<string, unknown>, pctChange24h?: number) {
  return {
    ...t,
    tradeCount: Number((t as Record<string, unknown>).tradeCount ?? 0),
    holderCount: Number((t as Record<string, unknown>).holderCount ?? 0),
    pctChange24h: pctChange24h ?? null,
  };
}

export default router;
