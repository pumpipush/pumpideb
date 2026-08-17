/**
 * birdeye.ts — shared Birdeye Data Services API client.
 *
 * Requires env var: BIRDEYE_API_KEY
 * Base URL: https://public-api.birdeye.so
 *
 * All functions return null on error / missing key — callers must handle.
 *
 * Data source priority:
 *   getSolPriceUsd  → DexScreener primary (free), Birdeye fallback
 *   OHLCV / trades  → Birdeye only (DexScreener has no equivalent)
 */

import { fetchDexScreenerTokens } from "./dexscreener.js";

const BIRDEYE_BASE = "https://public-api.birdeye.so";

function apiKey(): string {
  return process.env.BIRDEYE_API_KEY ?? "";
}

async function birdeyeGet<T>(path: string): Promise<T | null> {
  const key = apiKey();
  if (!key) {
    console.warn("[birdeye] BIRDEYE_API_KEY not set — skipping API call");
    return null;
  }
  try {
    const res = await fetch(`${BIRDEYE_BASE}${path}`, {
      headers: {
        "X-API-KEY": key,
        "x-chain": "solana",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn(`[birdeye] HTTP ${res.status} for ${path}`);
      return null;
    }
    const json = (await res.json()) as { data?: T; success?: boolean };
    if (json.success === false) return null;
    return json.data ?? null;
  } catch (err) {
    console.warn(`[birdeye] fetch error for ${path}:`, err);
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BirdeyeTokenMeta {
  address:             string;
  name:                string;
  symbol:              string;
  logoURI:             string | null;
  decimals:            number;
  priceUsd:            number | null;
  marketCapUsd:        number | null;
  v24hUSD:             number | null;
  liquidity:           number | null;
  priceChange24h:      number | null;  // 24h % change from token_overview
}

export interface BirdeyeTokenListItem {
  address:            string;
  name:               string;
  symbol:             string;
  logoURI?:           string;
  decimals:           number;
  price?:             number;
  mc?:                number;
  v24hUSD?:           number;
  v24hChangePercent?: number;  // 24h price change %; available from tokenlist endpoint
  liquidity?:         number;
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch metadata + price for a single token.
 * Consumes ~5 CU.
 */
export async function fetchBirdeyeTokenMeta(address: string): Promise<BirdeyeTokenMeta | null> {
  const data = await birdeyeGet<{
    address:               string;
    name:                  string;
    symbol:                string;
    logoURI?:              string;
    decimals:              number;
    price?:                number;
    mc?:                   number;
    marketCap?:            number;  // Birdeye sometimes uses "marketCap" instead of "mc"
    v24hUSD?:              number;
    liquidity?:            number;
    priceChange24hPercent?: number;
  }>(`/defi/token_overview?address=${address}`);

  if (!data) return null;

  return {
    address:        data.address,
    name:           data.name      || address.slice(0, 8),
    symbol:         data.symbol    || "???",
    logoURI:        data.logoURI   ?? null,
    decimals:       data.decimals  ?? 6,
    priceUsd:       data.price     ?? null,
    marketCapUsd:   (data.marketCap ?? data.mc) ?? null,  // Birdeye field is "marketCap" not "mc"
    v24hUSD:        data.v24hUSD   ?? null,
    liquidity:      data.liquidity ?? null,
    priceChange24h: data.priceChange24hPercent ?? null,
  };
}

/**
 * Fetch paginated token list, optionally filtered by DEX exchange.
 * Consumes ~1-2 CU per call (50 tokens per page).
 *
 * Known exchange IDs: "raydium", "orca", "meteora", "pump_amm"
 */
export interface BirdeyeTokenListResult {
  items: BirdeyeTokenListItem[];  // normalised from "tokens" field in API response
  total: number;
}

export async function fetchBirdeyeTokenList(opts: {
  exchange?:     string;
  sortBy?:       string;
  offset?:       number;
  limit?:        number;
  minLiquidity?: number;
}): Promise<BirdeyeTokenListResult | null> {
  const params = new URLSearchParams({
    sort_by:       opts.sortBy       ?? "v24hUSD",
    sort_type:     "desc",
    offset:        String(opts.offset      ?? 0),
    limit:         String(opts.limit       ?? 50),
    min_liquidity: String(opts.minLiquidity ?? 500),
  });
  if (opts.exchange) params.set("exchange", opts.exchange);

  // API returns { tokens: [...], total: N } — normalise to { items, total }
  const raw = await birdeyeGet<{
    tokens?: BirdeyeTokenListItem[];
    items?:  BirdeyeTokenListItem[];
    total?:  number;
  }>(`/defi/tokenlist?${params.toString()}`);

  if (!raw) return null;
  const items = raw.tokens ?? raw.items ?? [];
  return { items, total: raw.total ?? items.length };
}

/**
 * Get current SOL price in USD from Birdeye.
 * Falls back to 150 if unavailable.
 */
// ── OHLCV & price overview for DEX tokens ────────────────────────────────────

export interface BirdeyeOHLCVBar {
  time:   number; // unix seconds
  open:   number; // price in USD
  high:   number;
  low:    number;
  close:  number;
  volume: number; // volume in USD
}

/**
 * Fetch OHLCV bars from Birdeye for a token.
 * Prices are returned in USD.
 * tf: "1m" | "5m" | "15m" | "1H" | "4H" | "1D" | "1W"
 * Consumes ~5–15 CU depending on bar count.
 */
export async function fetchBirdeyeOHLCV(
  address: string,
  tf: string,
  timeFrom: number,
  timeTo: number,
): Promise<BirdeyeOHLCVBar[] | null> {
  const params = new URLSearchParams({
    address,
    type:      tf,
    time_from: String(timeFrom),
    time_to:   String(timeTo),
    currency:  "usd",
  });
  const data = await birdeyeGet<{ items?: { unixTime: number; o: number; h: number; l: number; c: number; v?: number; vUsd?: number }[] }>(
    `/defi/ohlcv?${params.toString()}`
  );
  if (!data?.items) return null;
  return data.items.map(bar => ({
    time:   bar.unixTime,
    open:   bar.o,
    high:   bar.h,
    low:    bar.l,
    close:  bar.c,
    volume: bar.vUsd ?? (bar.v ?? 0),
  }));
}

export interface BirdeyeTokenOverview {
  price:                   number;
  mc:                      number | null;  // = marketCap field from Birdeye
  v24hUSD:                 number | null;
  vBuy24hUSD:              number | null;
  vSell24hUSD:             number | null;
  buy24h:                  number | null;  // trade count
  sell24h:                 number | null;
  liquidity:               number | null;
  circulatingSupply:       number | null;
  priceChange30mPercent:   number | null;
  priceChange1hPercent:    number | null;
  priceChange6hPercent:    number | null;
  priceChange24hPercent:   number | null;
  // Historical prices at specific look-back windows (more accurate than computing from %)
  history5mPrice:          number | null;
  history1hPrice:          number | null;
  history6hPrice:          number | null;
  history24hPrice:         number | null;
}

/**
 * Fetch token overview (live price + 24h stats) from Birdeye.
 * NOTE: Birdeye uses "marketCap" (not "mc") for market cap. "fdv" is fully diluted.
 * Consumes ~5 CU.
 */
export async function fetchBirdeyeTokenOverview(address: string): Promise<BirdeyeTokenOverview | null> {
  const data = await birdeyeGet<Record<string, unknown>>(`/defi/token_overview?address=${address}`);
  if (!data || typeof data.price !== "number") return null;
  const n = (k: string): number | null => {
    const v = data[k];
    return typeof v === "number" ? v : null;
  };
  return {
    price:                 data.price as number,
    mc:                    n("marketCap") ?? n("mc"),
    v24hUSD:               n("v24hUSD"),
    vBuy24hUSD:            n("vBuy24hUSD"),
    vSell24hUSD:           n("vSell24hUSD"),
    buy24h:                n("buy24h"),
    sell24h:               n("sell24h"),
    liquidity:             n("liquidity"),
    circulatingSupply:     n("circulatingSupply"),
    priceChange30mPercent: n("priceChange30mPercent"),
    priceChange1hPercent:  n("priceChange1hPercent"),
    priceChange6hPercent:  n("priceChange6hPercent"),
    priceChange24hPercent: n("priceChange24hPercent"),
    history5mPrice:        n("history5mPrice"),
    history1hPrice:        n("history1hPrice"),
    history6hPrice:        n("history6hPrice") ?? n("history8hPrice"),
    history24hPrice:       n("history24hPrice"),
  };
}

// ── Token trade history from Birdeye ─────────────────────────────────────────

export interface BirdeyeTradeItem {
  txHash:        string;
  blockUnixTime: number;
  owner:         string;
  side:          "buy" | "sell";
  tokenPrice:    number;
  from: { address: string; uiAmount: number; price: number; decimals: number; changeAmount: number };
  to:   { address: string; uiAmount: number; price: number; decimals: number; changeAmount: number };
}

/**
 * Fetch recent swap transactions for a token from Birdeye.
 * Returns the last `limit` swaps (max 50 per call), newest first.
 * Consumes ~5 CU per call.
 */
export async function fetchBirdeyeTokenTrades(
  address: string,
  limit = 50,
): Promise<BirdeyeTradeItem[] | null> {
  const params = new URLSearchParams({
    address,
    tx_type: "swap",
    sort_type: "desc",
    limit: String(Math.min(limit, 50)),
  });
  const data = await birdeyeGet<{ items?: unknown[] }>(`/defi/txs/token?${params}`);
  return (data?.items as BirdeyeTradeItem[] | undefined) ?? null;
}

// In-memory cache for SOL/USD price — refreshed at most once per 60 s.
// Eliminates redundant API calls when multiple endpoints are hit in the same
// page-load cycle (ohlcv, stats, price-history, trades).
let _solPriceCache: { value: number; expiresAt: number } | null = null;

const WSOL = "So11111111111111111111111111111111111111112";

export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (_solPriceCache && now < _solPriceCache.expiresAt) {
    return _solPriceCache.value;
  }

  // ── Primary: DexScreener (free, no API key required) ─────────────────────
  // Query WSOL pairs; pick the highest-liquidity pair where SOL is the base
  // token — priceUsd on such a pair is the SOL/USD rate directly.
  try {
    const pairs = await fetchDexScreenerTokens([WSOL]);
    const solPair = pairs
      .filter(p =>
        p.chainId === "solana" &&
        p.baseToken?.address === WSOL &&
        p.priceUsd,
      )
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

    if (solPair?.priceUsd) {
      const price = parseFloat(solPair.priceUsd);
      // Sanity gate: SOL is always between $10 and $100 000
      if (price > 10 && price < 100_000) {
        _solPriceCache = { value: price, expiresAt: now + 60_000 };
        return price;
      }
    }
  } catch {
    // fall through to Birdeye
  }

  // ── Fallback: Birdeye ─────────────────────────────────────────────────────
  const data = await birdeyeGet<{ value: number }>(`/defi/price?address=${WSOL}`);
  const freshPrice = data?.value;

  if (freshPrice && freshPrice > 0) {
    _solPriceCache = { value: freshPrice, expiresAt: now + 60_000 };
    return freshPrice;
  }

  // Both sources unavailable — return stale cached value rather than
  // corrupting SOL-denominated values with a hardcoded guess.
  if (_solPriceCache) return _solPriceCache.value;

  // No cached value at all — return 0 so callers can detect unavailability.
  return 0;
}

/**
 * Convert USD price to lamports-equivalent for storage in priceEth/marketCapEth columns.
 * priceEth column stores SOL per token (in lamports unit = SOL × 1e9).
 */
export function usdToLamports(usd: number, solPriceUsd: number): string {
  if (!usd || !solPriceUsd) return "0";
  return Math.round((usd / solPriceUsd) * 1e9).toString();
}
