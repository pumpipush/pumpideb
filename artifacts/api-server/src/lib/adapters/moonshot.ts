/**
 * Moonshot adapter — polls DEXScreener every 30 s for Moonshot pairs on Solana
 * and upserts token listings with live price/volume/trade-count stats.
 *
 * Data source: https://api.dexscreener.com/latest/dex/search?q=moonshot
 * - Filters: chainId=solana, dexId=moonshot
 * - Inserts new tokens (onConflictDoNothing on address)
 * - Updates priceEth, marketCapEth, tradeCount, volumeEth for existing tokens
 *
 * Individual trade records are not available via DEXScreener's public API;
 * only aggregate stats (trade counts, volume) are synced. A future Solana RPC
 * subscription could supplement this with individual trades.
 *
 * No env vars required.
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { logger } from "../logger";

const POLL_INTERVAL_MS = 30_000;
const PLATFORM = "moonshot";
const CHAIN = "solana";

// DEXScreener returns priceNative (price in SOL) which we store as priceEth
const DEXSCREENER_URL =
  "https://api.dexscreener.com/latest/dex/search?q=moonshot";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceNative?: string; // price in SOL
  priceUsd?: string;
  txns?: {
    h24?: { buys: number; sells: number };
    h6?: { buys: number; sells: number };
  };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; description?: string; websites?: {url:string}[]; socials?: {type:string; url:string}[] };
}

interface DexSearchResponse {
  pairs: DexPair[] | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tradeCount(pair: DexPair): number {
  const h24 = pair.txns?.h24;
  return h24 ? h24.buys + h24.sells : 0;
}

function volumeEth(pair: DexPair): string {
  // DEXScreener gives USD volume; without a SOL/USD price oracle we store "0"
  // A future improvement could convert via priceNative/priceUsd ratio
  return "0";
}

// ── Core poll ─────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  const log = logger.child({ adapter: "moonshot" });
  try {
    const res = await fetch(DEXSCREENER_URL, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });

    if (!res.ok) {
      log.warn({ status: res.status }, "moonshot: DEXScreener returned non-OK status");
      return;
    }

    const body = (await res.json()) as DexSearchResponse;
    const pairs = (body.pairs ?? []).filter(
      (p) => p.chainId === "solana" && p.dexId === "moonshot"
    );

    log.debug({ count: pairs.length }, "moonshot: fetched pairs from DEXScreener");

    let inserted = 0;
    let updated = 0;

    for (const pair of pairs) {
      const addr = pair.baseToken.address;
      const price = pair.priceNative ?? null;
      const tc = tradeCount(pair).toString();
      const vol = volumeEth(pair);
      const mcap = price != null && pair.fdv != null
        ? null // Can't compute SOL-denominated mcap without SOL/USD rate
        : null;

      // Try to insert; if conflict (token already exists), update stats instead
      const [existing] = await db
        .select({ address: tokensTable.address })
        .from(tokensTable)
        .where(eq(tokensTable.address, addr))
        .limit(1);

      if (!existing) {
        await db
          .insert(tokensTable)
          .values({
            address: addr,
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
            description: pair.info?.description ?? null,
            imageUrl: pair.info?.imageUrl ?? null,
            creatorAddress: "unknown",
            totalSupply: "1000000000", // Moonshot typical
            virtualTokenReserves: "1000000000",
            virtualEthReserves: "0",
            priceEth: price,
            marketCapEth: mcap,
            tradeCount: tc,
            volumeEth: vol,
            twitterUrl: pair.info?.socials?.find(s => s.type === "twitter")?.url ?? null,
            websiteUrl: pair.info?.websites?.[0]?.url ?? null,
            platform: PLATFORM,
            chain: CHAIN,
          })
          .onConflictDoNothing();
        inserted++;
      } else {
        // Update live stats
        await db
          .update(tokensTable)
          .set({ priceEth: price, marketCapEth: mcap, tradeCount: tc })
          .where(eq(tokensTable.address, addr));
        updated++;
      }
    }

    if (inserted > 0 || updated > 0) {
      log.info({ inserted, updated }, "moonshot: poll complete");
    }
  } catch (err) {
    log.error({ err }, "moonshot: poll failed");
  }
}

// ── Exported adapter entry point ──────────────────────────────────────────────

export async function startMoonshotAdapter(): Promise<void> {
  logger.info({ adapter: "moonshot" }, "moonshot: starting — will poll DEXScreener every 30s");
  await poll(); // immediate first poll
  setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
}
