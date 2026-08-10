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
import { searchJupiterTokens } from "../lib/jupiter-tokens";

const router: IRouter = Router();

// ── In-memory response cache for GET /tokens ──────────────────────────────────
// The token list (especially the expensive 24h pct-change query) does not need
// to be recomputed on every request.  A 60-second TTL is plenty — real-time
// price movement is already delivered via the WebSocket live-update feed, so
// the REST poll only needs to pick up new tokens entering the top-40 list.
//
// Cache key = serialised query-param object so different sort/limit combos
// each get their own slot.  Max entries capped at 50 to bound memory.
const _tokenListCache = new Map<string, { payload: unknown; expiresAt: number }>();
const TOKEN_LIST_TTL = 60_000;   // ms — how long a cached response is valid
const TOKEN_LIST_MAX = 50;        // max distinct cache slots

function _cacheGet(key: string): unknown | null {
  const entry = _tokenListCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _tokenListCache.delete(key); return null; }
  return entry.payload;
}

function _cacheSet(key: string, payload: unknown): void {
  if (_tokenListCache.size >= TOKEN_LIST_MAX) {
    // Evict oldest entry
    const oldest = _tokenListCache.keys().next().value;
    if (oldest !== undefined) _tokenListCache.delete(oldest);
  }
  _tokenListCache.set(key, { payload, expiresAt: Date.now() + TOKEN_LIST_TTL });
}

// ── Helper: fetch 24-hour price % change for a set of token addresses ────────
// Returns a Map<address, pctChange24h>. Tokens with no trades in the window
// are absent from the map (caller should treat as null).
async function fetch24hPctChanges(addresses: string[]): Promise<Map<string, number>> {
  if (addresses.length === 0) return new Map();

  // Step 1: compute pct change from internal trade history (pump.fun / live DEX trades)
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

  // Step 2: for addresses with no internal trades, fall back to pct_change_24h
  // stored in the tokens table (refreshed from Birdeye for DEX tokens).
  const missing = addresses.filter(a => !result.has(a));
  if (missing.length > 0) {
    const { rows: tokenRows } = await pool.query<{ address: string; pct_change_24h: string | null }>(
      `SELECT address, pct_change_24h FROM tokens WHERE address = ANY($1) AND pct_change_24h IS NOT NULL`,
      [missing],
    );
    for (const row of tokenRows) {
      if (row.pct_change_24h !== null) {
        result.set(row.address, parseFloat(row.pct_change_24h));
      }
    }
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

  // ── Cache check ─────────────────────────────────────────────────────────────
  // 60-second in-memory cache keyed on all query params.
  // Real-time price movement comes from the WebSocket feed; the REST poll
  // only needs to catch new tokens entering the list and 24h pct refreshes.
  const cacheKey = JSON.stringify({ sort, limit, offset, search, graduated, platform });
  const cached = _cacheGet(cacheKey);
  if (cached !== null) {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
    res.setHeader("X-Cache", "HIT");
    res.json(cached);
    return;
  }

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
      if (platform === "raydium_launchlab") {
        // "Raydium LaunchLab" tab: native tokens + graduated pump.fun that migrated
        where.push(`(t.platform = 'raydium_launchlab' OR (t.platform = 'pump_fun' AND t.graduated = TRUE))`);
      } else if (platform === "pumpswap") {
        // "PumpSwap" tab: tokens indexed as pumpswap + graduated pump.fun tokens
        // (pump.fun tokens graduate to PumpSwap when bonding curve fills)
        where.push(`(t.platform = 'pumpswap' OR (t.platform = 'pump_fun' AND t.graduated = TRUE))`);
      } else if (platform === "raydium") {
        // "Raydium" tab: tokens indexed via Raydium polling adapter
        where.push(`(t.platform = 'raydium')`);
      } else {
        params.push(platform);
        where.push(`t.platform = $${params.length}`);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(fetchLimit);
    const limitParamIdx = params.length;
    params.push(Number(offset));
    const offsetParamIdx = params.length;
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
      LIMIT  $${limitParamIdx}
      OFFSET $${offsetParamIdx}
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
    const payload = ListTokensResponse.parse(mapped.map(r => formatToken(r, pctChanges.get(r.address))));
    _cacheSet(cacheKey, payload);
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
    res.setHeader("X-Cache", "MISS");
    res.json(payload);
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
    if (platform === "raydium_launchlab") {
      conditions.push(
        sql`(${tokensTable.platform} = 'raydium_launchlab' OR (${tokensTable.platform} = 'pump_fun' AND ${tokensTable.graduated} = TRUE))`
      );
    } else if (platform === "pumpswap") {
      // PumpSwap tab: pumpswap-indexed tokens + graduated pump.fun tokens
      conditions.push(
        sql`(${tokensTable.platform} = 'pumpswap' OR (${tokensTable.platform} = 'pump_fun' AND ${tokensTable.graduated} = TRUE))`
      );
    } else {
      conditions.push(eq(tokensTable.platform, platform));
    }
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
  const payload = ListTokensResponse.parse(tokens.map(t => formatToken(t, pctChanges.get(t.address))));
  _cacheSet(cacheKey, payload);
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
  res.setHeader("X-Cache", "MISS");
  res.json(payload);
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

// GET /tokens/search — combined platform + Solana-wide search
// Returns { platformTokens, solanaTokens } so the client can show two sections.
// Must be registered before /:address so "search" is not treated as an address.
router.get("/tokens/search", async (req, res): Promise<void> => {
  const q = String(req.query["q"] ?? "").trim();
  if (!q) {
    res.json({ platformTokens: [], solanaTokens: [] });
    return;
  }

  // ── Platform tokens (from DB) — limit 5, sorted by trade activity ────────
  const dbRows = await db
    .select()
    .from(tokensTable)
    .where(
      and(
        not(eq(tokensTable.symbol, "???")),
        sql`(${ilike(tokensTable.name, `%${q}%`)} OR ${ilike(tokensTable.symbol, `%${q}%`)})`,
      ),
    )
    .orderBy(desc(tokensTable.tradeCount))
    .limit(5);

  const platformAddresses = new Set(dbRows.map((t) => t.address));
  const platformTokens    = dbRows.map((t) => formatToken(t));

  // ── Solana-wide tokens (from Jupiter strict list) — limit 5, excl. platform ─
  const jupiterResults = searchJupiterTokens(q, 5, platformAddresses);
  const solanaTokens   = jupiterResults.map((t) => ({
    address:  t.address,
    name:     t.name,
    symbol:   t.symbol,
    logoURI:  t.logoURI ?? null,
    decimals: t.decimals,
  }));

  res.json({ platformTokens, solanaTokens });
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
  const row = t as Record<string, unknown>;
  return {
    ...t,
    tradeCount:   Number(row.tradeCount   ?? 0),
    holderCount:  Number(row.holderCount  ?? 0),
    // Prefer live-computed pctChange24h (from trade history / Birdeye overview in list route),
    // then fall back to the stored column value (populated by enrich-dex-pct script).
    pctChange24h: pctChange24h ?? (typeof row.pctChange24h === "number" ? row.pctChange24h : null),
  };
}

export default router;
