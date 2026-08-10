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
import { verifyWalletSignature, isValidIndexerSecret, parseWalletAuthFields } from "../lib/wallet-auth";

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

  // ── Trending: smart score ranking ────────────────────────────────────────────
  // Score = weighted sum of multiple signals:
  //   • trades_5m × 20  — very recent activity (HOT signal)
  //   • trades_1h × 5   — sustained 1-hour momentum
  //   • buys_1h   × 8   — buy pressure (bullish)
  //   • sells_1h  × 2   — sell activity (bearish but still shows interest)
  //   • unique_traders_1h × 3  — organic interest (not just bots)
  //   • vol_sol_1h (capped)    — SOL volume, capped so whales don't dominate
  //   • age bonus: +50 if < 1h old, +20 if < 6h old
  //   • graduation bonus: +10
  if (sort === "trending") {
    const fetchLimit = Number(limit) * 4;
    const params: unknown[] = [];
    const where: string[] = [`t.symbol != '???'`, `t.platform NOT IN ('raydium', 'orca', 'meteora')`];
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
        where.push(`t.platform = 'raydium_launchlab'`);
      } else if (platform === "pumpswap") {
        // Only show tokens natively indexed on PumpSwap.
        // Graduated pump.fun tokens are re-platformed to 'pumpswap' at migration time
        // (in the pumpfun adapter handleGraduation), so they appear here automatically.
        where.push(`t.platform = 'pumpswap'`);
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
             COALESCE(r1h.trades,         0) AS recent_trade_count,
             COALESCE(r1h.trades,         0) AS trades_1h,
             COALESCE(r1h.buy_count,      0) AS buys_1h,
             COALESCE(r1h.sell_count,     0) AS sells_1h,
             COALESCE(r1h.unique_traders, 0) AS traders_1h,
             COALESCE(r1h.vol_sol,        0) AS vol_sol_1h,
             COALESCE(r5m.trades,         0) AS trades_5m,
             -- Smart score: multi-signal trending rank
             (
               COALESCE(r5m.trades, 0) * 20
               + COALESCE(r1h.trades, 0) * 5
               + COALESCE(r1h.buy_count, 0) * 8
               - COALESCE(r1h.sell_count, 0) * 2
               + COALESCE(r1h.unique_traders, 0) * 3
               + LEAST(COALESCE(r1h.vol_sol, 0) / 1e9, 500) * 2
               + CASE WHEN t.created_at > NOW() - INTERVAL '1 hour'  THEN 50 ELSE 0 END
               + CASE WHEN t.created_at > NOW() - INTERVAL '6 hours' THEN 20 ELSE 0 END
               + CASE WHEN t.graduated THEN 10 ELSE 0 END
             ) AS smart_score
      FROM   tokens t
      LEFT JOIN (
        SELECT token_address,
               COUNT(*)                                                AS trades,
               COUNT(CASE WHEN is_buy  THEN 1 END)                    AS buy_count,
               COUNT(CASE WHEN NOT is_buy THEN 1 END)                 AS sell_count,
               COUNT(DISTINCT trader_address)                          AS unique_traders,
               SUM(CAST(NULLIF(eth_amount, '') AS NUMERIC))           AS vol_sol
        FROM   trades
        WHERE  timestamp > NOW() - INTERVAL '1 hour'
        GROUP  BY token_address
      ) r1h ON r1h.token_address = t.address
      LEFT JOIN (
        SELECT token_address, COUNT(*) AS trades
        FROM   trades
        WHERE  timestamp > NOW() - INTERVAL '5 minutes'
        GROUP  BY token_address
      ) r5m ON r5m.token_address = t.address
      ${whereSql}
      ORDER  BY smart_score DESC, t.trade_count DESC
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
      trades1h:             Number(r["trades_1h"] ?? 0),
    }));
    const pctChanges = await fetch24hPctChanges(mapped.map(r => r.address));
    const payload = ListTokensResponse.parse(mapped.map(r => formatToken(r, pctChanges.get(r.address), Number(r.trades1h ?? 0))));
    _cacheSet(cacheKey, payload);
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
    res.setHeader("X-Cache", "MISS");
    res.json(payload);
    return;
  }

  let query = db.select().from(tokensTable).$dynamic();

  const conditions = [];
  // Filter out placeholder tokens and removed platforms
  conditions.push(sql`${tokensTable.symbol} != '???'`);
  conditions.push(sql`${tokensTable.platform} NOT IN ('raydium', 'orca', 'meteora')`);
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
      // Only natively-indexed LaunchLab tokens — same logic as pumpswap.
      conditions.push(eq(tokensTable.platform, "raydium_launchlab"));
    } else if (platform === "pumpswap") {
      // Only natively-indexed PumpSwap tokens. Graduated pump.fun tokens are
      // re-platformed to 'pumpswap' at migration time in the pumpfun adapter.
      conditions.push(eq(tokensTable.platform, "pumpswap"));
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
// Requires a wallet signature to prove the caller owns the creator wallet.
// The client must sign the message "RocketFi:create:{tokenAddress}:{unixSeconds}"
// and send { walletAddress, signature, message } alongside the token fields.
// creatorAddress is derived server-side from the verified walletAddress — the
// creatorAddress field in the body is ignored and overwritten.
router.post("/tokens", async (req, res): Promise<void> => {
  // 1. Parse and verify wallet auth fields
  const authFields = parseWalletAuthFields(req.body);
  if (!authFields) {
    res.status(401).json({ error: "Missing wallet authentication fields (walletAddress, signature, message)" });
    return;
  }

  const { walletAddress, signature, message } = authFields;

  // 2. Parse the token body so we know the address before verifying the message.
  //    Inject walletAddress as creatorAddress so the schema validation passes even
  //    when the client omits creatorAddress (it is derived from the signer anyway).
  const bodyWithCreator = { creatorAddress: walletAddress, ...req.body };
  const parsed = CreateTokenBody.safeParse(bodyWithCreator);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // 3. Verify the signature covers this exact token address
  try {
    verifyWalletSignature({ walletAddress, signature, message }, "create", parsed.data.address);
  } catch (err) {
    res.status(401).json({ error: `Wallet signature invalid: ${(err as Error).message}` });
    return;
  }

  // 4. Insert — creatorAddress comes from the verified wallet, not the request body
  const [token] = await db
    .insert(tokensTable)
    .values({
      address: parsed.data.address,
      name: parsed.data.name,
      symbol: parsed.data.symbol,
      description: parsed.data.description ?? null,
      imageUrl: parsed.data.imageUrl ?? null,
      creatorAddress: walletAddress,          // server-derived from verified signer
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

  // Use the same smart score formula as the explore trending tab
  const { rows } = await pool.query<Record<string, unknown>>(`
    SELECT t.*,
           COALESCE(r1h.trades, 0)         AS trades_1h,
           COALESCE(r5m.trades, 0)         AS trades_5m,
           (
             COALESCE(r5m.trades, 0) * 20
             + COALESCE(r1h.trades, 0) * 5
             + COALESCE(r1h.buy_count, 0) * 8
             - COALESCE(r1h.sell_count, 0) * 2
             + COALESCE(r1h.unique_traders, 0) * 3
             + LEAST(COALESCE(r1h.vol_sol, 0) / 1e9, 500) * 2
             + CASE WHEN t.created_at > NOW() - INTERVAL '1 hour'  THEN 50 ELSE 0 END
             + CASE WHEN t.created_at > NOW() - INTERVAL '6 hours' THEN 20 ELSE 0 END
           ) AS smart_score
    FROM   tokens t
    LEFT JOIN (
      SELECT token_address,
             COUNT(*)                                           AS trades,
             COUNT(CASE WHEN is_buy THEN 1 END)                AS buy_count,
             COUNT(CASE WHEN NOT is_buy THEN 1 END)            AS sell_count,
             COUNT(DISTINCT trader_address)                     AS unique_traders,
             SUM(CAST(NULLIF(eth_amount, '') AS NUMERIC))      AS vol_sol
      FROM   trades
      WHERE  timestamp > NOW() - INTERVAL '1 hour'
      GROUP  BY token_address
    ) r1h ON r1h.token_address = t.address
    LEFT JOIN (
      SELECT token_address, COUNT(*) AS trades
      FROM   trades
      WHERE  timestamp > NOW() - INTERVAL '5 minutes'
      GROUP  BY token_address
    ) r5m ON r5m.token_address = t.address
    WHERE  t.graduated = FALSE AND t.symbol != '???'
    ORDER  BY smart_score DESC, t.trade_count DESC
    LIMIT  $1
  `, [limit]);

  const tokens = rows.map(r => ({
    id:                   Number(r["id"]),
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
    pctChange24h:         null as null,
    trades1h:             Number(r["trades_1h"] ?? 0),
  }));

  res.json(GetTrendingTokensResponse.parse(tokens.map(t => formatToken(t, undefined, t.trades1h))));
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
// Two authentication paths are accepted:
//   A) Indexer service: send `X-Indexer-Secret` header matching SESSION_SECRET
//      (used by internal adapters / backfill scripts that write via HTTP).
//   B) Token creator: send { walletAddress, signature, message } where the
//      signature covers "RocketFi:update:{tokenAddress}:{unixSeconds}" and
//      walletAddress matches the token's stored creatorAddress.
router.patch("/tokens/:address", async (req, res): Promise<void> => {
  const params = UpdateTokenParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const tokenAddress = params.data.address;

  // ── Auth path A: indexer shared secret ─────────────────────────────────
  const indexerHeader = req.headers["x-indexer-secret"] as string | undefined;
  const isIndexer = isValidIndexerSecret(indexerHeader);

  // ── Auth path B: wallet signature from the token creator ───────────────
  if (!isIndexer) {
    const authFields = parseWalletAuthFields(req.body);
    if (!authFields) {
      res.status(401).json({
        error: "Unauthorized: provide X-Indexer-Secret header or wallet auth fields (walletAddress, signature, message)",
      });
      return;
    }

    const { walletAddress, signature, message } = authFields;

    // Verify the signature before hitting the DB
    try {
      verifyWalletSignature({ walletAddress, signature, message }, "update", tokenAddress);
    } catch (err) {
      res.status(401).json({ error: `Wallet signature invalid: ${(err as Error).message}` });
      return;
    }

    // Fetch the token to check ownership
    const [existing] = await db
      .select({ creatorAddress: tokensTable.creatorAddress })
      .from(tokensTable)
      .where(eq(tokensTable.address, tokenAddress));

    if (!existing) {
      res.status(404).json({ error: "Token not found" });
      return;
    }

    if (existing.creatorAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      res.status(403).json({ error: "Forbidden: only the token creator can update this token" });
      return;
    }
  }

  // ── Parse and apply updates ─────────────────────────────────────────────
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

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updatable fields provided" });
    return;
  }

  const [token] = await db
    .update(tokensTable)
    .set(updates)
    .where(eq(tokensTable.address, tokenAddress))
    .returning();

  if (!token) {
    res.status(404).json({ error: "Token not found" });
    return;
  }

  res.json(UpdateTokenResponse.parse(formatToken(token)));
});

function formatToken(t: typeof tokensTable.$inferSelect | Record<string, unknown>, pctChange24h?: number, trades1h?: number) {
  const row = t as Record<string, unknown>;
  return {
    ...t,
    tradeCount:   Number(row.tradeCount   ?? 0),
    holderCount:  Number(row.holderCount  ?? 0),
    // Prefer live-computed pctChange24h (from trade history / Birdeye overview in list route),
    // then fall back to the stored column value (populated by enrich-dex-pct script).
    pctChange24h: pctChange24h ?? (typeof row.pctChange24h === "number" ? row.pctChange24h : null),
    // trades1h: only populated for trending sort (smart score query); null otherwise.
    trades1h: trades1h ?? null,
  };
}

export default router;
