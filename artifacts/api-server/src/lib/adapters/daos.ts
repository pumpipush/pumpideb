/**
 * Daos.fun adapter — polls DEXScreener every 60 s for Daos.fun pairs on Solana
 * and upserts token listings with live price/volume/trade-count stats.
 *
 * Data source: https://api.dexscreener.com/latest/dex/search?q=daos.fun
 * - Filters: chainId=solana, dexId contains "daos"
 * - Inserts new tokens (onConflictDoNothing on address)
 * - Updates priceEth, marketCapEth, tradeCount for existing tokens
 *
 * No env vars required.
 */

import { eq } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { logger } from "../logger";
import { emitNewToken } from "../tradeEmitter";

const POLL_INTERVAL_MS = 60_000;
const PLATFORM = "daos_fun";
const CHAIN = "solana";

const DEXSCREENER_URL =
  "https://api.dexscreener.com/latest/dex/search?q=daos.fun";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: { h24?: { buys: number; sells: number } };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    description?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
}

interface DexSearchResponse {
  pairs: DexPair[] | null;
}

// ── Core poll ─────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  const log = logger.child({ adapter: "daos_fun" });
  try {
    const res = await fetch(DEXSCREENER_URL, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });

    if (!res.ok) {
      log.warn({ status: res.status }, "daos_fun: DEXScreener returned non-OK status");
      return;
    }

    const body = (await res.json()) as DexSearchResponse;

    // Accept any Solana pair where dexId includes "daos"
    const pairs = (body.pairs ?? []).filter(
      (p) => p.chainId === "solana" && p.dexId.toLowerCase().includes("daos")
    );

    // Log what dexIds are coming back on first run (helps debugging)
    const dexIds = [...new Set((body.pairs ?? []).filter(p => p.chainId === "solana").map(p => p.dexId))];
    log.debug({ count: pairs.length, solana_dex_ids: dexIds }, "daos_fun: fetched pairs from DEXScreener");

    let inserted = 0;
    let updated = 0;

    for (const pair of pairs) {
      const addr = pair.baseToken.address;
      const price = pair.priceNative ?? null;
      const tc = pair.txns?.h24
        ? (pair.txns.h24.buys + pair.txns.h24.sells).toString()
        : "0";

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
            totalSupply: "1000000000",
            virtualTokenReserves: "1000000000",
            virtualEthReserves: "0",
            priceEth: price,
            marketCapEth: null,
            tradeCount: tc,
            volumeEth: "0",
            twitterUrl: pair.info?.socials?.find((s) => s.type === "twitter")?.url ?? null,
            websiteUrl: pair.info?.websites?.[0]?.url ?? null,
            platform: PLATFORM,
            chain: CHAIN,
          })
          .onConflictDoNothing();
        inserted++;

        emitNewToken({
          type: "newToken",
          token: {
            address: addr,
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
            imageUrl: pair.info?.imageUrl ?? null,
            priceEth: price,
            marketCapEth: null,
            platform: PLATFORM,
            chain: CHAIN,
            createdAt: pair.pairCreatedAt
              ? new Date(pair.pairCreatedAt).toISOString()
              : new Date().toISOString(),
          },
        });
      } else {
        await db
          .update(tokensTable)
          .set({ priceEth: price, tradeCount: tc })
          .where(eq(tokensTable.address, addr));
        updated++;
      }
    }

    if (inserted > 0 || updated > 0) {
      log.info({ inserted, updated }, "daos_fun: poll complete");
    }
  } catch (err) {
    log.error({ err }, "daos_fun: poll failed");
  }
}

// ── Exported adapter entry point ──────────────────────────────────────────────

export async function startDaosFunAdapter(): Promise<void> {
  logger.info({ adapter: "daos_fun" }, "daos_fun: starting — will poll DEXScreener every 60s");
  await poll(); // immediate first poll
  setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
}
