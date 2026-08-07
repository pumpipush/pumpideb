/**
 * Daos.fun adapter — dual-mode indexer.
 *
 * Mode A (chain-native, preferred):
 *   Requires env var: DAOS_FUN_PROGRAM_ID
 *   Subscribes to logsSubscribe via PublicNode for real-time token creation.
 *   How to find the program ID: Go to daos.fun, create/inspect a token transaction
 *   on Solscan, and note the program invoked in the instructions.
 *
 * Mode B (DEXScreener polling, fallback):
 *   Used automatically when DAOS_FUN_PROGRAM_ID is not set.
 *   Polls https://api.dexscreener.com/latest/dex/search?q=daos.fun every 60s.
 *   Accepts any Solana pair whose dexId contains "daos".
 *
 * No minimum env vars required — Mode B runs by default.
 */

import { eq } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { logger } from "../logger";
import { emitNewToken } from "../tradeEmitter";
import { SolanaRpcIndexer, type LogEvent } from "./solanaRpcBase";

const PLATFORM = "daos_fun";
const CHAIN    = "solana";

// ── Mode A: Chain-native ───────────────────────────────────────────────────────

class DaosFunChainIndexer extends SolanaRpcIndexer {
  constructor(programId: string) {
    super({ programId, adapterName: "daos_fun" });
  }

  // Default shouldProcess from base: create-only — appropriate for daos.fun launch tracking
  protected override async onEvent(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    const mint    = this.extractNewMint(tx);
    const creator = this.extractSigner(tx);
    if (!mint) return;

    await db.insert(tokensTable).values({
      address:              mint,
      name:                 mint.slice(0, 8) + "…",
      symbol:               "???",
      description:          null,
      imageUrl:             null,
      creatorAddress:       creator,
      totalSupply:          "1000000000",
      virtualTokenReserves: "1000000000",
      virtualEthReserves:   "0",
      priceEth:             null,
      marketCapEth:         null,
      platform:             PLATFORM,
      chain:                CHAIN,
    }).onConflictDoNothing();

    this.log.info({ mint }, "daos_fun: new token ingested (chain-native)");

    emitNewToken({
      type: "newToken",
      token: {
        address:      mint,
        name:         mint.slice(0, 8) + "…",
        symbol:       "???",
        imageUrl:     null,
        priceEth:     null,
        marketCapEth: null,
        platform:     PLATFORM,
        chain:        CHAIN,
        createdAt:    tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : new Date().toISOString(),
      },
    });
  }
}

// ── Mode B: DEXScreener polling ────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000;
const DEXSCREENER_URL  = "https://api.dexscreener.com/latest/dex/search?q=daos.fun";

interface DexPair {
  chainId:      string;
  dexId:        string;
  pairAddress:  string;
  baseToken:    { address: string; name: string; symbol: string };
  priceNative?: string;
  txns?:        { h24?: { buys: number; sells: number } };
  fdv?:         number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?:  string;
    description?: string;
    websites?:  { url: string }[];
    socials?:   { type: string; url: string }[];
  };
}

interface DexSearchResponse { pairs: DexPair[] | null; }

async function poll(): Promise<void> {
  const log = logger.child({ adapter: "daos_fun" });
  try {
    const res = await fetch(DEXSCREENER_URL, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "daos_fun: DEXScreener non-OK");
      return;
    }

    const body      = (await res.json()) as DexSearchResponse;
    const allSolana = (body.pairs ?? []).filter((p) => p.chainId === "solana");
    const pairs     = allSolana.filter((p) => p.dexId.toLowerCase().includes("daos"));

    log.debug({ count: pairs.length }, "daos_fun: DEXScreener poll");

    let inserted = 0, updated = 0;

    for (const pair of pairs) {
      const addr  = pair.baseToken.address;
      const price = pair.priceNative ?? null;
      const tc    = pair.txns?.h24
        ? (pair.txns.h24.buys + pair.txns.h24.sells).toString()
        : "0";

      const [existing] = await db
        .select({ address: tokensTable.address })
        .from(tokensTable)
        .where(eq(tokensTable.address, addr))
        .limit(1);

      if (!existing) {
        await db.insert(tokensTable).values({
          address:              addr,
          name:                 pair.baseToken.name,
          symbol:               pair.baseToken.symbol,
          description:          pair.info?.description ?? null,
          imageUrl:             pair.info?.imageUrl    ?? null,
          creatorAddress:       "unknown",
          totalSupply:          "1000000000",
          virtualTokenReserves: "1000000000",
          virtualEthReserves:   "0",
          priceEth:             price,
          marketCapEth:         null,
          tradeCount:           tc,
          volumeEth:            "0",
          twitterUrl:           pair.info?.socials?.find((s) => s.type === "twitter")?.url ?? null,
          websiteUrl:           pair.info?.websites?.[0]?.url ?? null,
          platform:             PLATFORM,
          chain:                CHAIN,
        }).onConflictDoNothing();
        inserted++;

        emitNewToken({
          type: "newToken",
          token: {
            address:      addr,
            name:         pair.baseToken.name,
            symbol:       pair.baseToken.symbol,
            imageUrl:     pair.info?.imageUrl ?? null,
            priceEth:     price,
            marketCapEth: null,
            platform:     PLATFORM,
            chain:        CHAIN,
            createdAt:    pair.pairCreatedAt
              ? new Date(pair.pairCreatedAt).toISOString()
              : new Date().toISOString(),
          },
        });
      } else {
        await db.update(tokensTable)
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

// ── Exported entry point ───────────────────────────────────────────────────────

export async function startDaosFunAdapter(): Promise<void> {
  const programId = process.env["DAOS_FUN_PROGRAM_ID"];

  if (programId) {
    logger.info({ adapter: "daos_fun", programId }, "daos_fun: starting chain-native mode");
    const indexer = new DaosFunChainIndexer(programId);
    indexer.start();
  } else {
    logger.info(
      { adapter: "daos_fun" },
      "daos_fun: DAOS_FUN_PROGRAM_ID not set — falling back to DEXScreener polling. " +
      "To enable chain-native: find the program ID on Solscan from a daos.fun token tx."
    );
    await poll();
    setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
  }
}
