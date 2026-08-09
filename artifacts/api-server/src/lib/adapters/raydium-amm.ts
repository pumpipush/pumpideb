/**
 * raydium-amm.ts — Raydium price poller.
 *
 * Because Raydium AMM V4 generates thousands of swaps per minute across
 * thousands of pools, a logsSubscribe approach saturates free RPCs immediately.
 *
 * Strategy instead:
 *   - Every 60 seconds: fetch top 50 pools by 24h volume from Raydium V3 API
 *   - For each pool: upsert token record with latest price/market cap/volume/liquidity
 *   - Token metadata (name, symbol, logo) comes from the Raydium API response directly
 *   - This gives ~1-minute freshness for display — good enough for a screener
 *
 * Raydium V3 REST API — no auth required.
 */

import { sql } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { logger as rootLogger } from "../logger.js";
import { getSolPriceUsd, usdToLamports } from "../birdeye.js";

const log = rootLogger.child({ adapter: "raydium" });

const RAYDIUM_API = "https://api-v3.raydium.io";
const PLATFORM    = "raydium";
const CHAIN       = "solana";
const POLL_MS     = 60_000; // 1 minute

// Known quote/stable mints — identify which side of the pair is the token
const STABLE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",   // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

// ── Raydium API types ─────────────────────────────────────────────────────────

interface RaydiumMint {
  address:  string;
  name:     string;
  symbol:   string;
  decimals: number;
  logoURI?: string;
}

interface RaydiumPool {
  id:       string; // pool address
  mintA:    RaydiumMint;
  mintB:    RaydiumMint;
  price:    number; // price of mintA in terms of mintB
  tvl:      number; // total value locked in USD
  day: {
    volume: number; // 24h volume in USD
  };
  type: string;
}

interface RaydiumPoolsResponse {
  success: boolean;
  data: {
    count: number;
    data:  RaydiumPool[];
  };
}

// ── Poller ────────────────────────────────────────────────────────────────────

async function fetchTopPools(page: number): Promise<RaydiumPool[]> {
  try {
    const url = `${RAYDIUM_API}/pools/info/list?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=50&page=${page}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const json = await res.json() as RaydiumPoolsResponse;
    return json.data?.data ?? [];
  } catch (err) {
    log.warn({ err }, "raydium: failed to fetch pools from API");
    return [];
  }
}

async function pollOnce(): Promise<void> {
  const [pools, solPrice] = await Promise.all([
    fetchTopPools(1),
    getSolPriceUsd(),
  ]);

  if (!pools.length) return;

  log.debug({ count: pools.length }, "raydium: processing pool batch");
  let upserted = 0;

  for (const pool of pools) {
    // Determine which mint is the token (non-stable) and which is the quote
    const aIsStable = STABLE_MINTS.has(pool.mintA.address);
    const bIsStable = STABLE_MINTS.has(pool.mintB.address);

    // Skip pair where both sides are stable, or neither side is (complex pairs)
    if (aIsStable === bIsStable) continue;

    const tokenMint  = aIsStable ? pool.mintB : pool.mintA;
    const quoteMint  = aIsStable ? pool.mintA : pool.mintB;

    // Skip known garbage
    if (!tokenMint.name || !tokenMint.symbol) continue;

    // Price of the token in quote units. Raydium price = mintA / mintB price.
    // If mintA is the token: tokenPriceInQuote = pool.price
    // If mintB is the token: tokenPriceInQuote = 1 / pool.price
    const rawPrice    = aIsStable ? (pool.price > 0 ? 1 / pool.price : 0) : pool.price;

    // Convert to USD
    const quoteIsUsdc = quoteMint.address !== "So11111111111111111111111111111111111111112";
    const priceUsd    = quoteIsUsdc ? rawPrice : rawPrice * solPrice;
    const marketCapUsd = null; // Raydium doesn't provide supply for market cap calc
    const volumeUsd    = pool.day?.volume ?? 0;
    const liquidityUsd = pool.tvl         ?? 0;

    // Convert to lamports-equivalent for existing schema columns
    const priceEth     = priceUsd  ? usdToLamports(priceUsd,  solPrice) : null;
    const volumeEth    = volumeUsd ? usdToLamports(volumeUsd, solPrice) : "0";

    try {
      await db.insert(tokensTable).values({
        address:        tokenMint.address,
        name:           tokenMint.name.trim(),
        symbol:         tokenMint.symbol.trim(),
        imageUrl:       tokenMint.logoURI ?? null,
        creatorAddress: "unknown",
        platform:       PLATFORM,
        chain:          CHAIN,
        priceEth,
        volumeEth,
        graduated:      true,
        poolAddress:    pool.id,
        quoteMint:      quoteMint.address,
        liquidityUsd,
        priceUsd,
        marketCapUsd,
      })
      .onConflictDoUpdate({
        target: tokensTable.address,
        set: {
          // Update price and volume from latest Raydium data
          priceEth,
          volumeEth,
          poolAddress: pool.id,
          liquidityUsd,
          priceUsd,
          // Update name/symbol/logo in case they changed
          name:     tokenMint.name.trim(),
          symbol:   tokenMint.symbol.trim(),
          imageUrl: tokenMint.logoURI ?? null,
        },
      });
      upserted++;
    } catch (err) {
      log.warn({ err, mint: tokenMint.address }, "raydium: upsert error");
    }
  }

  log.info({ upserted, total: pools.length }, "raydium: pool poll complete");
}

// ── Exported start function ───────────────────────────────────────────────────

/** Called by pumpfun.ts on each Migrate event — no-op (Raydium uses polling). */
export function registerGraduatedMint(mint: string): void {
  log.debug({ mint }, "raydium: graduated mint noted (will appear in next poll)");
}

/** Start the Raydium polling loop. Runs forever — does not block. */
export async function startRaydiumAmmAdapter(): Promise<void> {
  log.info({ pollMs: POLL_MS }, "raydium: starting polling adapter");

  // First poll immediately on start
  void pollOnce().catch((err) =>
    log.error({ err }, "raydium: initial poll failed")
  );

  // Then poll every POLL_MS
  setInterval(() => {
    void pollOnce().catch((err) =>
      log.error({ err }, "raydium: poll failed")
    );
  }, POLL_MS);
}
