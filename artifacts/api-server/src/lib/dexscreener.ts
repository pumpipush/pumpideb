/**
 * DexScreener API client — free, no API key required.
 * Docs: https://docs.dexscreener.com/api/reference
 * Rate limit: 300 req/min on free tier.
 *
 * Used as the primary data source for PumpSwap & LaunchLab tokens:
 *   - Price, market cap, volume, 24h % change
 *   - Token metadata (name, symbol, image) for new pools
 *   - Graduation detection (which DEX a token ended up on)
 */

const BASE = "https://api.dexscreener.com";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DsTxns {
  buys:  number;
  sells: number;
}

export interface DexScreenerPair {
  chainId:       string;                    // "solana"
  dexId:         string;                    // "pumpswap", "raydium", "raydium-cp", etc.
  url:           string;
  pairAddress:   string;
  baseToken:     { address: string; name: string; symbol: string };
  quoteToken:    { address: string; name: string; symbol: string };
  priceNative:   string;                    // price in SOL per token
  priceUsd?:     string;                    // price in USD per token
  txns?: {
    m5?:  DsTxns;
    h1?:  DsTxns;
    h6?:  DsTxns;
    h24?: DsTxns;
  };
  volume?:       { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?:  { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?:    { usd?: number; base?: number; quote?: number };
  fdv?:          number;
  marketCap?:    number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?:  string;
    header?:    string;
    websites?:  { label: string; url: string }[];
    socials?:   { type: string; url: string }[];
  };
}

interface DsTokensResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

// ── API calls ────────────────────────────────────────────────────────────────

/**
 * Fetch all DEX pairs for up to 30 token addresses (comma-joined).
 * Returns pairs across ALL DEXes — filter by dexId as needed.
 */
export async function fetchDexScreenerTokens(
  addresses: string[],
): Promise<DexScreenerPair[]> {
  if (addresses.length === 0) return [];
  const chunk = addresses.slice(0, 30).join(",");
  try {
    const res = await fetch(`${BASE}/latest/dex/tokens/${chunk}`, {
      headers: { Accept: "application/json", "User-Agent": "RocketFi/1.0" },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as DsTokensResponse;
    return json.pairs ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch the best PumpSwap pair for a single token address.
 * Picks the pair with the highest liquidity if multiple exist.
 * Returns null if the token has no PumpSwap pair.
 */
export async function fetchDexScreenerPumpSwapPair(
  address: string,
): Promise<DexScreenerPair | null> {
  const pairs = await fetchDexScreenerTokens([address]);
  return (
    pairs
      .filter(p => p.dexId === "pumpswap" && p.chainId === "solana")
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null
  );
}

/**
 * From a set of pairs for one token, pick the best pair on our supported DEXes.
 * Priority: pumpswap > raydium_launchlab > raydium-cp > raydium > any Solana pair.
 */
export function bestSolanaPair(pairs: DexScreenerPair[]): DexScreenerPair | null {
  const PRIORITY = ["pumpswap", "raydium_launchlab", "raydium-cp", "raydium"];
  for (const dex of PRIORITY) {
    const match = pairs.find(p => p.dexId === dex && p.chainId === "solana");
    if (match) return match;
  }
  return pairs.find(p => p.chainId === "solana") ?? null;
}

// ── Price helpers ────────────────────────────────────────────────────────────

/**
 * Derive the SOL/USD price from a pair that has both priceNative and priceUsd.
 * priceNative = token price in SOL, priceUsd = token price in USD
 * → SOL/USD = priceUsd / priceNative
 *
 * No external SOL price call needed — computed from the pair itself.
 */
export function pairToSolPrice(pair: DexScreenerPair): number {
  const native = parseFloat(pair.priceNative);
  const usd    = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
  if (!native || !usd || native === 0) return 0;
  return usd / native;
}

/**
 * Convert a DexScreener pair → DB-ready price columns.
 *
 * Conventions (match existing DB schema):
 *   priceEth    = price in SOL per token  (15 decimal string)
 *   marketCapEth = market cap in lamports (string)
 *   volumeEth   = 24h volume in lamports  (string)
 *   priceUsd    = price in USD            (string)
 *   marketCapUsd = market cap in USD      (string)
 */
export function pairToDbFields(pair: DexScreenerPair) {
  const solPrice    = pairToSolPrice(pair);
  const priceNative = parseFloat(pair.priceNative);
  const priceUsd    = pair.priceUsd ? parseFloat(pair.priceUsd) : null;
  const mcapUsd     = pair.marketCap ?? null;
  const volUsd24h   = pair.volume?.h24 ?? null;

  const priceEth = priceNative > 0 ? priceNative.toFixed(15) : undefined;

  // lamports = USD ÷ SOL_PRICE × 1e9
  const mcapEth = mcapUsd && solPrice > 0
    ? Math.round(mcapUsd  / solPrice * 1e9).toString()
    : undefined;
  // volumeEth: text NOT NULL column — omit (undefined) rather than set null when unavailable
  const volumeEth = volUsd24h && solPrice > 0
    ? Math.round(volUsd24h / solPrice * 1e9).toString()
    : undefined;

  const liquidityUsd = pair.liquidity?.usd ?? undefined;
  const pctChange24h = pair.priceChange?.h24 ?? undefined;
  // priceUsd / marketCapUsd are doublePrecision columns — store as number, not string
  const priceUsdNum  = priceUsd  != null ? priceUsd  : undefined;
  const mcapUsdNum   = mcapUsd   != null ? mcapUsd   : undefined;

  return {
    priceEth,
    priceUsd:     priceUsdNum,
    marketCapEth: mcapEth,
    marketCapUsd: mcapUsdNum,
    liquidityUsd,
    pctChange24h,
    volumeEth,
    // Pool address: stored so Birdeye OHLCV/trades proxies can route correctly
    // and the token-detail page links to the right pair on external explorers.
    poolAddress: pair.pairAddress ?? undefined,
  };
}

/**
 * Reconstruct historical SOL prices from current price + DexScreener % changes.
 * Used for the price-history endpoint when no internal trades exist.
 *
 * Formula: priceAtT = currentPrice / (1 + pctChange / 100)
 */
export function pairToPriceHistory(pair: DexScreenerPair) {
  const current   = parseFloat(pair.priceNative);
  if (!current || current === 0) return { p5m: null, p1h: null, p6h: null, p24h: null };
  const pChange   = pair.priceChange ?? {};
  const fromPct   = (pct: number | undefined) =>
    pct !== undefined ? current / (1 + pct / 100) : null;
  return {
    p5m:  fromPct(pChange.m5),
    p1h:  fromPct(pChange.h1),
    p6h:  fromPct(pChange.h6),
    p24h: fromPct(pChange.h24),
  };
}
