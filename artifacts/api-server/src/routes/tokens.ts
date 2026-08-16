import { Router, type IRouter } from "express";
import { eq, desc, ilike, and, not, sql, gte, gt } from "drizzle-orm";
import { db, pool, tokensTable, tradesTable } from "@workspace/db";
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
import { asyncWrap } from "../lib/asyncHandler.js";
import { SERVER_START_TIME } from "../lib/serverMeta.js";
import { logger } from "../lib/logger.js";
import { getSolPriceUsd } from "../lib/birdeye.js";
import { emitSnapshot } from "../lib/tradeEmitter.js";
import {
  deriveDevBuyFromTx, fetchConfirmedTx, extractFeePayer,
  logsForProgramScope, PUMP_FUN_PROGRAM_ID, LAUNCHLAB_PROGRAM_ID,
  extractLaunchLabMintFromInstruction,
} from "../lib/devBuyFromTx.js";
import { parseCreateEventFromLogs } from "../lib/adapters/pumpfun.js";

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
/** Default TTL for cached token lists. Real-time price is handled by SSE; REST only needs freshness for ranking changes. */
const TOKEN_LIST_TTL         = 60_000;   // ms — trending / volume / graduated
/** Shorter TTL for the "newest" sort — ensures fresh tokens appear quickly on page load even before SSE events arrive. */
const TOKEN_LIST_TTL_NEWEST  =  5_000;   // ms — newest sort only
const TOKEN_LIST_MAX = 50;        // max distinct cache slots

function _cacheGet(key: string): unknown | null {
  const entry = _tokenListCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _tokenListCache.delete(key); return null; }
  return entry.payload;
}

function _cacheSet(key: string, payload: unknown, ttl = TOKEN_LIST_TTL): void {
  if (_tokenListCache.size >= TOKEN_LIST_MAX) {
    // Evict oldest entry
    const oldest = _tokenListCache.keys().next().value;
    if (oldest !== undefined) _tokenListCache.delete(oldest);
  }
  _tokenListCache.set(key, { payload, expiresAt: Date.now() + ttl });
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

// GET /sol-price — lightweight endpoint so the frontend can get a reliable
// SOL/USD price from the server (Birdeye, cached 60s) instead of CoinGecko
// which can be rate-limited or blocked on VPS.
router.get("/sol-price", asyncWrap(async (_req, res) => {
  const price = await getSolPriceUsd();
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json({ price: price > 0 ? price : null });
}));

// GET /tokens
router.get("/tokens", asyncWrap(async (req, res) => {
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
    const hitTtl    = sort === "newest" ? TOKEN_LIST_TTL_NEWEST : TOKEN_LIST_TTL;
    const hitMaxAge = Math.floor(hitTtl / 1_000);
    res.setHeader("Cache-Control", `public, max-age=${hitMaxAge}, stale-while-revalidate=${hitMaxAge}`);
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
    // When filtering specifically by raydium_launchlab, allow ??? tokens so
    // newly-indexed tokens appear in the tab before enrichment resolves the symbol.
    const where: string[] = [`t.platform NOT IN ('raydium', 'orca', 'meteora')`];
    if (platform !== "raydium_launchlab") {
      where.push(`t.symbol != '???'`);
    }
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
      const sym = String(t["symbol"] ?? "");
      // Placeholder tokens each have a unique address — deduplicate by address
      // so multiple ??? tokens are not collapsed into one.
      const key = sym === "???" ? String(t["address"]) : sym.toLowerCase();
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

  // ── Volume: tokens ranked by 24-hour SOL trading volume ─────────────────────
  // Uses a raw SQL JOIN against the trades table so we get a live 24h window
  // instead of the all-time cumulative volume_eth column.
  if (sort === "volume") {
    const params: unknown[] = [];
    const where: string[] = [`t.platform NOT IN ('raydium', 'orca', 'meteora')`];
    if (platform !== "raydium_launchlab") {
      where.push(`t.symbol != '???'`);
    }
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
        where.push(`t.platform = 'pumpswap'`);
      } else {
        params.push(platform);
        where.push(`t.platform = $${params.length}`);
      }
    }
    // Only tokens with at least one trade in the 24h window
    where.push(`COALESCE(r24h.vol_sol, 0) > 0`);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const fetchLimit = Number(limit) * 4;
    params.push(fetchLimit);
    const limitIdx = params.length;
    params.push(Number(offset));
    const offsetIdx = params.length;

    const { rows } = await pool.query<Record<string, unknown>>(`
      SELECT t.*,
             COALESCE(r24h.vol_sol, 0)    AS vol_sol_24h,
             COALESCE(r24h.trades,   0)   AS trades_24h,
             COALESCE(r24h.buys,     0)   AS buys_24h,
             COALESCE(r24h.sellers,  0)   AS sellers_24h
      FROM   tokens t
      LEFT JOIN (
        SELECT token_address,
               SUM(CAST(NULLIF(eth_amount, '') AS NUMERIC)) AS vol_sol,
               COUNT(*)                                      AS trades,
               COUNT(CASE WHEN is_buy  THEN 1 END)          AS buys,
               COUNT(DISTINCT trader_address)                AS sellers
        FROM   trades
        WHERE  timestamp > NOW() - INTERVAL '24 hours'
        GROUP  BY token_address
      ) r24h ON r24h.token_address = t.address
      ${whereSql}
      ORDER  BY r24h.vol_sol DESC NULLS LAST
      LIMIT  $${limitIdx}
      OFFSET $${offsetIdx}
    `, params);

    const seen = new Set<string>();
    const deduped = rows.filter(r => {
      const sym = String(r["symbol"] ?? "");
      const key = sym === "???" ? String(r["address"]) : sym.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, Number(limit));

    // Map raw snake_case rows → camelCase shape expected by formatToken
    const mapped = deduped.map(r => ({
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
      trades1h:             0,
    }));

    const pctChanges = await fetch24hPctChanges(mapped.map(r => r.address));
    const payload = ListTokensResponse.parse(mapped.map(r => formatToken(r, pctChanges.get(r.address))));
    _cacheSet(cacheKey, payload);
    res.setHeader("Cache-Control", `public, max-age=${Math.floor(TOKEN_LIST_TTL / 1_000)}, stale-while-revalidate=${Math.floor(TOKEN_LIST_TTL / 1_000)}`);
    res.setHeader("X-Cache", "MISS");
    res.json(payload);
    return;
  }

  // ── All other sorts: marketcap / newest ──────────────────────────────────────
  let query = db.select().from(tokensTable).$dynamic();

  const conditions = [];
  // Filter out placeholder tokens and removed platforms.
  // Exception: when the caller explicitly requests raydium_launchlab, allow ???
  // tokens so freshly-indexed tokens are visible before enrichment resolves the symbol.
  if (platform !== "raydium_launchlab") {
    conditions.push(sql`${tokensTable.symbol} != '???'`);
  }
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
  // "newest" sort: no tradeCount gate — a newly created token appears immediately
  // even before its first trade lands. The frontend live feed already surfaces
  // brand-new coins, so the REST list should be consistent with that.

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  switch (sort) {
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
    // Placeholder tokens each have a unique address — deduplicate by address
    // so multiple ??? tokens are not collapsed into one.
    const key = t.symbol === "???" ? t.address : t.symbol.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Number(limit));

  const pctChanges = await fetch24hPctChanges(tokens.map(t => t.address));
  const payload = ListTokensResponse.parse(tokens.map(t => formatToken(t, pctChanges.get(t.address))));
  const ttl = sort === "newest" ? TOKEN_LIST_TTL_NEWEST : TOKEN_LIST_TTL;
  const maxAge = Math.floor(ttl / 1_000);
  _cacheSet(cacheKey, payload, ttl);
  res.setHeader("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=${maxAge}`);
  res.setHeader("X-Cache", "MISS");
  res.json(payload);
}));

// POST /tokens
// Requires a wallet signature to prove the caller owns the creator wallet.
// The client must sign the message "Pumpi:create:{tokenAddress}:{unixSeconds}"
// and send { walletAddress, signature, message } alongside the token fields.
// creatorAddress is derived server-side from the verified walletAddress — the
// creatorAddress field in the body is ignored and overwritten.
router.post("/tokens", asyncWrap(async (req, res) => {
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
}));

// GET /tokens/search — combined platform + Solana-wide search
// Returns { platformTokens, solanaTokens } so the client can show two sections.
// Must be registered before /:address so "search" is not treated as an address.
router.get("/tokens/search", asyncWrap(async (req, res) => {
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
}));

// GET /tokens/trending
router.get("/tokens/trending", asyncWrap(async (req, res) => {
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
}));

// POST /tokens/register-launch
// Instantly registers a freshly-launched pump.fun / Raydium LaunchLab token by
// verifying the tx signature on-chain and inserting the initial DB record.
// The frontend calls this right after waitForTxConfirmation so the /coin/:address
// page shows the full bonding-curve UI immediately — without waiting for pumpapi.io
// stream latency.
//
// Security: we fetch the full transaction (not just status) so we can verify that
// creatorAddress is the fee payer (first signer) of the tx. This prevents anyone
// from submitting a foreign tx signature to register or poison token metadata.
router.post("/tokens/register-launch", asyncWrap(async (req, res) => {
  const {
    mint, txSignature, name, symbol, description, imageUrl, metadataUri,
    twitter, telegram, website, creatorAddress,
    platform: reqPlatform,
  } = req.body as Record<string, string | undefined>;
  // Client-supplied hint that a dev buy was bundled into the launch tx. Used
  // ONLY as a trigger to inspect the tx — all inserted values are derived from
  // the confirmed transaction itself, never from this number.
  const devBuySol = Number((req.body as Record<string, unknown>).devBuySol ?? 0);

  if (!mint || !txSignature || !name || !symbol || !creatorAddress) {
    res.status(400).json({ error: "Missing required fields: mint, txSignature, name, symbol, creatorAddress" });
    return;
  }

  // ── Fetch & verify the transaction ───────────────────────────────────────────
  // getTransaction replaces the old getSignatureStatuses check: if the tx exists
  // with meta.err === null it is confirmed.  We also get logs and account keys
  // needed for creator verification and dev-buy derivation — one RPC call total.
  const RPC_URLS = [
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com",
  ];
  const confirmedTx = await fetchConfirmedTx(RPC_URLS, txSignature);

  if (!confirmedTx) {
    res.status(422).json({ error: "Transaction not yet confirmed on-chain — retry in a moment" });
    return;
  }
  if (confirmedTx.meta?.err !== null && confirmedTx.meta?.err !== undefined) {
    res.status(422).json({ error: "Transaction failed on-chain" });
    return;
  }

  // ── Verify creatorAddress is the fee payer of the transaction ─────────────────
  // The fee payer is accountKeys[0] and is cryptographically required to sign.
  // This prevents metadata poisoning: an attacker cannot claim creatorAddress =
  // victim wallet unless they can sign as that wallet.
  const feePayer = extractFeePayer(confirmedTx);
  if (!feePayer) {
    logger.warn({ txSignature }, "register-launch: could not extract fee payer from tx");
    res.status(422).json({ error: "Could not read transaction account keys — retry in a moment" });
    return;
  }
  if (feePayer !== creatorAddress) {
    logger.warn({ txSignature, feePayer, creatorAddress }, "register-launch: creatorAddress is not the tx fee payer");
    res.status(403).json({ error: "creatorAddress does not match the transaction fee payer" });
    return;
  }

  // ── pump.fun: require an on-chain CreateEvent that matches the claimed mint ────
  // We scope the raw log lines to those emitted while the pump.fun program is the
  // active invocation frame (logsForProgramScope), then parse the Anchor CreateEvent
  // from that scoped set. Scoping prevents a foreign program in the same tx from
  // emitting a crafted "Program data:" payload that looks like a CreateEvent.
  //
  // Absence of a CreateEvent is also rejected: a valid pump.fun CREATE always
  // emits one. Accepting a missing event would let an attacker reuse any of their
  // own historical txs (where they're the fee payer) to register an arbitrary mint.
  const platform = reqPlatform === "raydium_launchlab" ? "raydium_launchlab" : "pump_fun";
  if (platform === "pump_fun") {
    const allLogs    = confirmedTx.meta?.logMessages ?? [];
    const scopedLogs = logsForProgramScope(allLogs, PUMP_FUN_PROGRAM_ID);
    const createEvent = scopedLogs.length > 0 ? parseCreateEventFromLogs(scopedLogs) : null;

    if (!createEvent) {
      // No CreateEvent in the pump.fun program scope — this tx did not create a
      // pump.fun token, or the logs are missing. Reject unconditionally.
      logger.warn({ txSignature, mint }, "register-launch: no pump.fun CreateEvent found in tx logs");
      res.status(403).json({ error: "No pump.fun CreateEvent found in the provided transaction" });
      return;
    }
    if (createEvent.mint !== mint) {
      logger.warn({ txSignature, claimedMint: mint, onChainMint: createEvent.mint }, "register-launch: mint mismatch vs CreateEvent");
      res.status(403).json({ error: "mint does not match the token created in this transaction" });
      return;
    }
    if (createEvent.creatorAddress !== creatorAddress) {
      logger.warn({ txSignature }, "register-launch: creator mismatch vs CreateEvent");
      res.status(403).json({ error: "creatorAddress does not match the on-chain CreateEvent" });
      return;
    }
  }

  // ── LaunchLab: verify the tx created the claimed mint via program logs + balances ─
  // LaunchLab does NOT emit an Anchor CreateEvent log; instead we check two signals:
  //   1. The tx contains an "Instruction: createLaunchpad" log emitted within the
  //      LaunchLab program's own invocation scope — scoping prevents a foreign program
  //      from emitting a matching log line.
  //   2. The claimed mint appears in the tx's postTokenBalances — proves this specific
  //      mint was created or first touched in this transaction.
  // Combined with the fee-payer check above (creatorAddress paid for the tx), these
  // three signals together prove the caller created this specific LaunchLab token.
  if (platform === "raydium_launchlab") {
    const allLogs    = confirmedTx.meta?.logMessages ?? [];
    const scopedLogs = logsForProgramScope(allLogs, LAUNCHLAB_PROGRAM_ID);

    const hasCreateInstruction = scopedLogs.some(l => /Instruction:\s*createLaunchpad/i.test(l));
    if (!hasCreateInstruction) {
      logger.warn({ txSignature, mint }, "register-launch: no LaunchLab createLaunchpad found in scoped tx logs");
      res.status(403).json({ error: "No Raydium LaunchLab createLaunchpad instruction found in the provided transaction" });
      return;
    }

    // Decode the mint directly from the createLaunchpad instruction data.
    // The Anchor/Borsh layout is [disc(8)][mintA pubkey(32)][name][symbol][uri],
    // so bytes 8–39 of the instruction payload ARE the mint address — no inference
    // from token balances needed. Token-balance presence is insufficient because an
    // attacker can bundle a genuine LaunchLab create for mint A with an unrelated
    // SPL mint-to-new-account instruction for existing mint B in the same tx;
    // B would then appear in postTokenBalances but not preTokenBalances (new token
    // account, existing mint), defeating any balance-based check.
    const txMint = extractLaunchLabMintFromInstruction(confirmedTx, LAUNCHLAB_PROGRAM_ID);
    if (!txMint) {
      logger.warn({ txSignature, mint }, "register-launch: could not decode mint from LaunchLab instruction data");
      res.status(403).json({ error: "Could not decode mint from the LaunchLab createLaunchpad instruction" });
      return;
    }
    if (txMint !== mint) {
      logger.warn({ txSignature, txMint, claimedMint: mint }, "register-launch: instruction mint mismatch");
      res.status(403).json({ error: "mint does not match the token created by this transaction's createLaunchpad instruction" });
      return;
    }
  }

  // ── Upsert token ─────────────────────────────────────────────────────────────
  // `platform` is already declared above (used in CreateEvent verification).
  // pump.fun bonding curve always starts at fixed virtual reserves.
  // Raydium LaunchLab reserves are computed from on-chain parameters and will
  // be filled by the enrichment service within ~30 s — use 0 as a placeholder.
  const VTOK   = platform === "pump_fun" ? "1073000191045000" : "0";
  const VSOL   = platform === "pump_fun" ? "30"               : "0";
  const SUPPLY = platform === "pump_fun" ? "1000000000000000" : "0";

  const [token] = await db
    .insert(tokensTable)
    .values({
      address:              mint,
      name:                 name.trim(),
      symbol:               symbol.trim().toUpperCase(),
      description:          description?.trim() ?? null,
      imageUrl:             imageUrl   ?? null,
      creatorAddress,
      virtualTokenReserves: VTOK,
      virtualEthReserves:   VSOL,
      totalSupply:          SUPPLY,
      twitterUrl:           twitter  ?? null,
      telegramUrl:          telegram ?? null,
      websiteUrl:           website  ?? null,
      metadataUri:          metadataUri ?? null,
      platform,
      chain:    "solana",
      decimals: 6,
    })
    .onConflictDoUpdate({
      target: tokensTable.address,
      // If the pumpapi.io indexer already created a stub row, enrich the metadata
      // fields without touching reserves so live trade data isn't regressed.
      set: {
        name:        sql`COALESCE(NULLIF(EXCLUDED.name, '???'), ${tokensTable.name})`,
        symbol:      sql`COALESCE(NULLIF(EXCLUDED.symbol, '???'), ${tokensTable.symbol})`,
        description: sql`COALESCE(EXCLUDED.description, ${tokensTable.description})`,
        imageUrl:    sql`COALESCE(EXCLUDED.image_url, ${tokensTable.imageUrl})`,
        metadataUri: sql`COALESCE(EXCLUDED.metadata_uri, ${tokensTable.metadataUri})`,
        twitterUrl:  sql`COALESCE(EXCLUDED.twitter_url, ${tokensTable.twitterUrl})`,
        telegramUrl: sql`COALESCE(EXCLUDED.telegram_url, ${tokensTable.telegramUrl})`,
        websiteUrl:  sql`COALESCE(EXCLUDED.website_url, ${tokensTable.websiteUrl})`,
      },
    })
    .returning();

  logger.info({ mint, platform }, "register-launch: token upserted");

  // ── Fallback dev-buy trade, derived from the confirmed transaction ──────────
  // The pumpapi.io stream normally emits the bundled dev buy via the create
  // event's `initialBuy` field (verified live), but if that event is dropped the
  // creator's own purchase would be invisible on the chart forever.
  //
  // Nothing is trusted from the client here beyond "go look at this tx": we
  // fetch the confirmed transaction and extract the EXACT swap amounts from the
  // program-emitted Anchor TradeEvent (never from balance deltas, which include
  // rent and unrelated transfers). The row is only inserted when a verifiable
  // buy event bound to this mint and creator exists in the tx. The UNIQUE
  // constraint on trades.tx_hash makes this a no-op when the indexer already
  // recorded the same tx, so no double-counting is possible — and because the
  // values are on-chain-derived, a fallback row is equivalent to the stream row.
  if (isFinite(devBuySol) && devBuySol > 0) {
    try {
      // Pass the pre-fetched tx to avoid a second RPC call.
      const derived = await deriveDevBuyFromTx(RPC_URLS, txSignature, mint, creatorAddress, platform, confirmedTx);
      if (derived) {
        const [inserted] = await db.insert(tradesTable).values({
          tokenAddress:  mint,
          traderAddress: creatorAddress,
          isBuy:         true,
          ethAmount:     derived.solLamports.toString(),
          tokenAmount:   derived.tokenBaseUnits.toString(),
          priceEth:      derived.priceEth,
          txHash:        txSignature,
          platform,
          timestamp:     derived.blockTime ?? new Date(),
        }).onConflictDoNothing().returning({ id: tradesTable.id });
        if (inserted) {
          logger.info(
            { mint, solLamports: derived.solLamports.toString() },
            "register-launch: dev-buy trade derived from on-chain tx (stream had not recorded it)",
          );
        }
      } else {
        logger.debug({ mint, txSignature }, "register-launch: tx contains no verifiable dev buy for this mint — skipping fallback insert");
      }
    } catch (err) {
      // Never fail registration because of the fallback insert
      logger.warn({ mint, err }, "register-launch: dev-buy fallback derivation failed");
    }
  }

  // Push an updated snapshot to any SSE clients already watching this token.
  // Without this, clients that connected before register-launch fires would
  // never see the imageUrl (their initial snapshot had imageUrl: null from the
  // pumpapi.io stub row, and the adapter's own emitNewToken call goes to the
  // global feed, not per-token subscribers).
  emitSnapshot({
    type: "snapshot",
    token: {
      address:              token.address,
      name:                 token.name,
      symbol:               token.symbol,
      imageUrl:             token.imageUrl,
      priceEth:             token.priceEth,
      marketCapEth:         token.marketCapEth,
      volumeEth:            token.volumeEth ?? "0",
      virtualEthReserves:   token.virtualEthReserves ?? "0",
      virtualTokenReserves: token.virtualTokenReserves ?? "0",
      tradeCount:           Number(token.tradeCount ?? 0),
      platform:             token.platform ?? platform,
      chain:                token.chain ?? "solana",
    },
  });

  res.status(201).json(GetTokenResponse.parse(formatToken(token)));
}));

// GET /tokens/:address
router.get("/tokens/:address", asyncWrap(async (req, res) => {
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
}));

// PATCH /tokens/:address
// Two authentication paths are accepted:
//   A) Indexer service: send `X-Indexer-Secret` header matching SESSION_SECRET
//      (used by internal adapters / backfill scripts that write via HTTP).
//   B) Token creator: send { walletAddress, signature, message } where the
//      signature covers "Pumpi:update:{tokenAddress}:{unixSeconds}" and
//      walletAddress matches the token's stored creatorAddress.
router.patch("/tokens/:address", asyncWrap(async (req, res) => {
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
}));

// GET /sitemap.xml — dynamically generated sitemap containing top/trending token pages.
// Intended to be fetched by the web crawler after the static sitemap index references this URL.
router.get("/sitemap.xml", asyncWrap(async (_req, res) => {
  try {
    // Fetch the top 500 tokens by trade count as a reasonable "popular" proxy.
    // Exclude placeholder symbols that are not real tokens.
    const { rows } = await pool.query<{ address: string }>(
      `SELECT address
       FROM   tokens
       WHERE  symbol != '???'
       ORDER  BY trade_count DESC, id DESC
       LIMIT  500`
    );

    const SITE    = "https://pumpi.io";
    const today   = new Date().toISOString().split("T")[0];

    const urls = rows
      .map((r) => {
        return `  <url>\n    <loc>${SITE}/coin/${r.address}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>hourly</changefreq>\n    <priority>0.8</priority>\n  </url>`;
      })
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(xml);
  } catch (err) {
    logger.error({ err }, "sitemap: failed to generate dynamic sitemap");
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.status(500).send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- sitemap generation error: ${err instanceof Error ? err.message : String(err)} -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>`
    );
  }
}));

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
