/**
 * orca.ts — real-time indexer for Orca Whirlpools (CLMM).
 *
 * Program: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
 *
 * Strategy:
 *   - Subscribe via logsSubscribe to the Whirlpool program
 *   - Detect new pool (new mint in postTokenBalances) → fetch metadata from Birdeye
 *   - Detect swap (token + SOL balance changes) → insert trade, update volume
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade, emitNewToken } from "../tradeEmitter.js";
import { logger as rootLogger } from "../logger.js";
import { SolanaRpcIndexer, type LogEvent } from "./solanaRpcBase.js";
import {
  fetchBirdeyeTokenMeta,
  getSolPriceUsd,
  usdToLamports,
} from "../birdeye.js";
import {
  fetchDexScreenerTokens,
  bestSolanaPair,
  pairToDbFields,
} from "../dexscreener.js";

const ORCA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const PLATFORM               = "orca";
const CHAIN                  = "solana";

const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export class OrcaIndexer extends SolanaRpcIndexer {
  constructor() {
    super({
      programId:   ORCA_WHIRLPOOL_PROGRAM,
      adapterName: PLATFORM,
      watchdogMs:  60_000,
    });
  }

  protected override shouldProcess(logs: string[]): boolean {
    return logs.some((l) =>
      /Instruction:\s*(Swap|TwoHopSwap|InitializePool|InitializeTickArray)/i.test(l)
    );
  }

  protected override async onEvent(event: LogEvent): Promise<void> {
    const tx = await this.getTransaction(event.signature);
    if (!tx || tx.meta?.err) return;

    const newMint = this.extractNewMint(tx);
    if (newMint && !SKIP_MINTS.has(newMint)) {
      await this.handleNewPool(newMint);
      return;
    }

    const swap = this.parseSwap(tx);
    if (!swap || SKIP_MINTS.has(swap.mint)) return;

    await this.handleTrade(swap.mint, swap.isBuy, swap.solLamports,
      swap.tokenAmount, swap.traderAddress, event.signature);
  }

  private async handleNewPool(mint: string): Promise<void> {
    // Skip cheaply if a real (non-placeholder) token row already exists.
    // A placeholder has name === mint.slice(0, 8) AND symbol === '???'.
    const existing = await db
      .select({ id: tokensTable.id, name: tokensTable.name, symbol: tokensTable.symbol })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);

    const isPlaceholder =
      existing.length > 0 &&
      existing[0].name === mint.slice(0, 8) &&
      existing[0].symbol === "???";

    if (existing.length > 0 && !isPlaceholder) return;

    this.log.info({ mint, isPlaceholder }, "orca: new pool — fetching metadata");

    // ── Primary: DexScreener (free, no API key) ───────────────────────────
    const dsPairs = await fetchDexScreenerTokens([mint]);
    const dsPair  = bestSolanaPair(dsPairs);

    let meta: {
      name: string; symbol: string; logoURI?: string | null;
      priceUsd?: number | null; marketCapUsd?: number | null; liquidity?: number | null;
    } | null = null;
    let priceEth:     string | null = null;
    let marketCapEth: string | null = null;

    if (dsPair?.baseToken?.name) {
      const dbFields = pairToDbFields(dsPair);
      meta = {
        name:         dsPair.baseToken.name,
        symbol:       dsPair.baseToken.symbol,
        logoURI:      dsPair.info?.imageUrl    ?? null,
        priceUsd:     dsPair.priceUsd ? parseFloat(dsPair.priceUsd) : null,
        marketCapUsd: dsPair.marketCap         ?? null,
        liquidity:    dsPair.liquidity?.usd    ?? null,
      };
      priceEth     = dbFields.priceEth     ?? null;
      marketCapEth = dbFields.marketCapEth ?? null;
    } else {
      // ── Fallback: Birdeye ───────────────────────────────────────────────
      const [birdMeta, solPrice] = await Promise.all([
        fetchBirdeyeTokenMeta(mint),
        getSolPriceUsd(),
      ]);
      if (!birdMeta) return;
      meta         = birdMeta;
      priceEth     = birdMeta.priceUsd     ? usdToLamports(birdMeta.priceUsd,     solPrice) : null;
      marketCapEth = birdMeta.marketCapUsd ? usdToLamports(birdMeta.marketCapUsd, solPrice) : null;
    }
    if (!meta) return;

    // Atomic upsert covering three arrival orderings in one SQL statement:
    //
    //   a. No conflict (new token):        INSERT real metadata → RETURNING row → broadcast
    //   b. Placeholder conflict (TOCTOU):  handleTrade inserted symbol='???' during the
    //                                      Birdeye fetch; DO UPDATE WHERE fires → upgrades
    //                                      name/symbol/metadata → RETURNING row → broadcast
    //   c. Real-row conflict (concurrent   handleNewPool beat us and already wrote real
    //      handleNewPool):                 metadata; DO UPDATE WHERE condition (symbol='???')
    //                                      is false → DO UPDATE is skipped → RETURNING empty
    //                                      → row === undefined → skip broadcast (no duplicate)
    //
    // The WHERE guard on symbol='???' is the key: when the condition is false,
    // PostgreSQL skips the DO UPDATE entirely and returns nothing from RETURNING,
    // so the check `if (!row)` reliably detects "real row already exists".
    const [row] = await db.insert(tokensTable).values({
      address:        mint,
      name:           meta.name,
      symbol:         meta.symbol,
      imageUrl:       meta.logoURI ?? null,
      creatorAddress: "unknown",
      platform:       PLATFORM,
      chain:          CHAIN,
      priceEth,
      marketCapEth,
      graduated:      true,
      liquidityUsd:   meta.liquidity    ?? null,
      priceUsd:       meta.priceUsd     ?? null,
      marketCapUsd:   meta.marketCapUsd ?? null,
    }).onConflictDoUpdate({
      target: tokensTable.address,
      // Only fire when the existing row is still a trade-first placeholder.
      where: sql`${tokensTable.symbol} = '???'`,
      set: {
        name:         meta.name,
        symbol:       meta.symbol,
        imageUrl:     meta.logoURI ?? null,
        graduated:    true,
        priceEth,
        marketCapEth,
        liquidityUsd: meta.liquidity    ?? null,
        priceUsd:     meta.priceUsd     ?? null,
        marketCapUsd: meta.marketCapUsd ?? null,
      },
    }).returning({ id: tokensTable.id });

    // Empty RETURNING means the DO UPDATE WHERE condition was false:
    // a concurrent handleNewPool already wrote real metadata. Skip broadcast.
    if (!row) {
      this.log.debug({ mint }, "orca: real token row preserved by concurrent handler — skipping");
      return;
    }

    this.log.info({ mint, name: meta.name }, "orca: token indexed/upgraded");

    emitNewToken({
      type: "newToken",
      token: {
        address:      mint,
        name:         meta.name,
        symbol:       meta.symbol,
        imageUrl:     meta.logoURI ?? null,
        priceEth,
        marketCapEth,
        platform:     PLATFORM,
        chain:        CHAIN,
        createdAt:    new Date().toISOString(),
      },
    });
  }

  private async handleTrade(
    mint: string, isBuy: boolean, solLamports: string,
    tokenAmount: string, traderAddress: string, signature: string,
  ): Promise<void> {
    const priceEth = tokenAmount !== "0" && solLamports !== "0"
      ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
      : null;

    // Ensure the token row exists before inserting the trade.
    // Migration 0017 added a FK that rejects trade inserts with no matching
    // token row.  Orca swap events can arrive before the new-pool event, so
    // we upsert a minimal placeholder; handleNewPool fills in metadata later.
    await db.insert(tokensTable).values({
      address:        mint,
      name:           mint.slice(0, 8),
      symbol:         "???",
      creatorAddress: "unknown",
      platform:       PLATFORM,
      chain:          CHAIN,
    }).onConflictDoNothing();

    const [trade] = await db.insert(tradesTable).values({
      tokenAddress:  mint,
      traderAddress,
      isBuy,
      ethAmount:     solLamports,
      tokenAmount,
      priceEth,
      txHash:        signature,
      platform:      PLATFORM,
      timestamp:     new Date(),
    }).onConflictDoNothing().returning();

    if (!trade) return;

    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth ? { priceEth } : {}),
    }).where(eq(tokensTable.address, mint));

    this.log.debug({ mint, isBuy }, "orca: trade indexed");

    emitTrade({
      type: "trade",
      trade: {
        id:            trade.id,
        tokenAddress:  trade.tokenAddress,
        traderAddress: trade.traderAddress,
        isBuy:         trade.isBuy,
        ethAmount:     trade.ethAmount,
        tokenAmount:   trade.tokenAmount,
        priceEth:      trade.priceEth,
        txHash:        trade.txHash,
        platform:      PLATFORM,
        timestamp:     trade.timestamp.toISOString(),
      },
      token: {
        address:              mint,
        name:                 null,
        symbol:               null,
        priceEth,
        marketCapEth:         null,
        volumeEth:            solLamports,
        virtualEthReserves:   "0",
        virtualTokenReserves: "0",
        tradeCount:           1,
        platform:             PLATFORM,
        chain:                CHAIN,
      },
    });
  }
}

export async function startOrcaAdapter(): Promise<void> {
  const indexer = new OrcaIndexer();
  indexer.start();
}
