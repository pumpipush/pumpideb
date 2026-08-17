/**
 * meteora.ts — real-time indexer for Meteora DLMM pools.
 *
 * Program: LBUZKhRxPF3XUpBCjp4YzTKgLLjggiJEUoQkpkVispN  (Meteora DLMM)
 *
 * Strategy:
 *   - Subscribe via logsSubscribe to the Meteora DLMM program
 *   - Detect new LB pair (new mint in postTokenBalances) → fetch metadata from Birdeye
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

const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLLjggiJEUoQkpkVispN";
const PLATFORM             = "meteora";
const CHAIN                = "solana";

const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

class MeteoraIndexer extends SolanaRpcIndexer {
  constructor() {
    super({
      programId:  METEORA_DLMM_PROGRAM,
      adapterName: PLATFORM,
      watchdogMs: 60_000, // Meteora is lower-frequency than pump.fun
    });
  }

  protected override shouldProcess(logs: string[]): boolean {
    return logs.some((l) =>
      /Instruction:\s*(Swap|InitializeLbPair|Initialize)/i.test(l)
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
    const existing = await db
      .select({ id: tokensTable.id })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);
    if (existing.length > 0) return;

    this.log.info({ mint }, "meteora: new pool detected — fetching metadata");

    const [meta, solPrice] = await Promise.all([
      fetchBirdeyeTokenMeta(mint),
      getSolPriceUsd(),
    ]);
    if (!meta) return;

    const priceEth     = meta.priceUsd     ? usdToLamports(meta.priceUsd,     solPrice) : null;
    const marketCapEth = meta.marketCapUsd ? usdToLamports(meta.marketCapUsd, solPrice) : null;

    const inserted = await db.insert(tokensTable).values({
      address:        mint,
      name:           meta.name,
      symbol:         meta.symbol,
      imageUrl:       meta.logoURI,
      creatorAddress: "unknown",
      platform:       PLATFORM,
      chain:          CHAIN,
      priceEth,
      marketCapEth,
      graduated:      true,
      liquidityUsd:   meta.liquidity    ?? null,
      priceUsd:       meta.priceUsd     ?? null,
      marketCapUsd:   meta.marketCapUsd ?? null,
    }).onConflictDoNothing().returning({ id: tokensTable.id });

    // Only broadcast if we actually inserted a new row — concurrent pool events
    // for the same mint can both pass the SELECT check above and reach this point.
    if (inserted.length === 0) return;

    this.log.info({ mint, name: meta.name }, "meteora: new token indexed");

    emitNewToken({
      type: "newToken",
      token: {
        address:      mint,
        name:         meta.name,
        symbol:       meta.symbol,
        imageUrl:     meta.logoURI,
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
    // token row.  Meteora swap events can arrive before the new-pool event, so
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

    this.log.debug({ mint, isBuy }, "meteora: trade indexed");

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

export async function startMeteoraAdapter(): Promise<void> {
  const indexer = new MeteoraIndexer();
  indexer.start();
}
