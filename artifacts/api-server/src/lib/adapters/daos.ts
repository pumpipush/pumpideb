/**
 * Daos.fun adapter — dual-mode indexer.
 *
 * Mode A (chain-native, default):
 *   Subscribes to logsSubscribe via PublicNode for real-time token creation.
 *   Uses DEFAULT_DAOS_PROGRAM_ID unless DAOS_FUN_PROGRAM_ID env var is set.
 *
 * Program ID source: daos.fun JS bundle (chunk fd26f1249bde05b8.js),
 *   FOUNDER_DAO_IDL.address = "Daosz93P15uZ1aTFTrBUAJyU1KERmZm3XQ5u4hbfHVQS"
 *   Anchor IDL name: "founder_dao"
 *   Verified executable on-chain: 2025-08-07
 *   Override via DAOS_FUN_PROGRAM_ID env var if daos.fun deploys a new program.
 *
 * Mode B (DEXScreener polling, fallback):
 *   Activated only when DAOS_FUN_PROGRAM_ID is explicitly set to an empty string
 *   or the chain-native adapter is disabled. Polls DEXScreener every 60s.
 *
 * No minimum env vars required — Mode A runs by default.
 */

import { eq } from "drizzle-orm";
import { db, tokensTable } from "@workspace/db";
import { logger } from "../logger";
import { emitNewToken } from "../tradeEmitter";
import { SolanaRpcIndexer, type LogEvent } from "./solanaRpcBase";

const PLATFORM = "daos_fun";
const CHAIN    = "solana";

// Default program ID — the daos.fun FounderDAO program.
// Source: daos.fun JS bundle, FOUNDER_DAO_IDL.address (Anchor IDL name: "founder_dao")
// Verified executable on-chain 2025-08-07. Override via DAOS_FUN_PROGRAM_ID env var.
const DEFAULT_DAOS_PROGRAM_ID = "Daosz93P15uZ1aTFTrBUAJyU1KERmZm3XQ5u4hbfHVQS";

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
  const programId = process.env["DAOS_FUN_PROGRAM_ID"] ?? DEFAULT_DAOS_PROGRAM_ID;

  logger.info(
    { adapter: "daos_fun", programId },
    "daos_fun: starting chain-native mode + DEXScreener polling"
  );

  // Mode A: chain-native real-time indexer (catches new launches as they happen)
  const indexer = new DaosFunChainIndexer(programId);
  indexer.start();

  // Mode B: DEXScreener polling — runs unconditionally alongside the chain indexer
  // so existing daos.fun tokens are always visible even when chain events are rare.
  await poll();
  setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
}
