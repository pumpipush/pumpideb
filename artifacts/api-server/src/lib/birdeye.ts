/**
 * birdeye.ts — shared Birdeye Data Services API client.
 *
 * Requires env var: BIRDEYE_API_KEY
 * Base URL: https://public-api.birdeye.so
 *
 * All functions return null on error / missing key — callers must handle.
 */

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
  address:      string;
  name:         string;
  symbol:       string;
  logoURI:      string | null;
  decimals:     number;
  priceUsd:     number | null;
  marketCapUsd: number | null;
  v24hUSD:      number | null;
  liquidity:    number | null;
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
    address:   string;
    name:      string;
    symbol:    string;
    logoURI?:  string;
    decimals:  number;
    price?:    number;
    mc?:       number;
    v24hUSD?:  number;
    liquidity?: number;
  }>(`/defi/token_overview?address=${address}`);

  if (!data) return null;

  return {
    address:      data.address,
    name:         data.name      || address.slice(0, 8),
    symbol:       data.symbol    || "???",
    logoURI:      data.logoURI   ?? null,
    decimals:     data.decimals  ?? 6,
    priceUsd:     data.price     ?? null,
    marketCapUsd: data.mc        ?? null,
    v24hUSD:      data.v24hUSD   ?? null,
    liquidity:    data.liquidity ?? null,
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
export async function getSolPriceUsd(): Promise<number> {
  const WSOL = "So11111111111111111111111111111111111111112";
  const data = await birdeyeGet<{ value: number }>(`/defi/price?address=${WSOL}`);
  return data?.value ?? 150;
}

/**
 * Convert USD price to lamports-equivalent for storage in priceEth/marketCapEth columns.
 * priceEth column stores SOL per token (in lamports unit = SOL × 1e9).
 */
export function usdToLamports(usd: number, solPriceUsd: number): string {
  if (!usd || !solPriceUsd) return "0";
  return Math.round((usd / solPriceUsd) * 1e9).toString();
}
