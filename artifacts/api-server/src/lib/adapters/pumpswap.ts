/**
 * pumpswap.ts — real-time indexer for PumpSwap (pump-amm) DEX.
 *
 * Program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *
 * Strategy:
 *   - Subscribe via logsSubscribe to the pump-amm program
 *   - For each event: fetch the full transaction
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

const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PLATFORM         = "pumpswap";
const CHAIN            = "solana";

// Mints that are never the "interesting" token (quote/stable tokens)
const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112",   // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

class PumpSwapIndexer extends SolanaRpcIndexer {
  constructor() {
    super({ programId: PUMPSWAP_PROGRAM, adapterName: PLATFORM });
  }

  /**
   * Filter by instruction type in log lines BEFORE making any getTransaction call.
   * Only process buy/sell swaps and pool creation — skip fee, liquidity, and other events.
   * This prevents flooding the RPC queue on high-volume programs.
   */
  protected override shouldProcess(logs: string[]): boolean {
    return logs.some((l) =>
      /Instruction:\s*(Buy|Sell|Swap|CreatePool|Create|Initialize)/i.test(l)
    );
  }

  protected override async onEvent(event: LogEvent): Promise<void> {
    const tx = await this.getTransaction(event.signature);
    if (!tx || tx.meta?.err) return;

    // ── New pool detection ────────────────────────────────────────────────────
    const newMint = this.extractNewMint(tx);
    if (newMint && !SKIP_MINTS.has(newMint)) {
      await this.handleNewPool(newMint, event.signature);
      return;
    }

    // ── Swap detection ────────────────────────────────────────────────────────
    const swap = this.parseSwap(tx);
    if (!swap || SKIP_MINTS.has(swap.mint)) return;

    await this.handleTrade(swap.mint, swap.isBuy, swap.solLamports, swap.tokenAmount,
      swap.traderAddress, event.signature);
  }

  private async handleNewPool(mint: string, _sig: string): Promise<void> {
    // Check if already indexed
    const existing = await db
      .select({ id: tokensTable.id })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);
    if (existing.length > 0) return;

    this.log.info({ mint }, "pumpswap: new pool detected — fetching metadata");

    const [meta, solPrice] = await Promise.all([
      fetchBirdeyeTokenMeta(mint),
      getSolPriceUsd(),
    ]);

    if (!meta) {
      this.log.warn({ mint }, "pumpswap: Birdeye metadata unavailable — skipping");
      return;
    }

    const priceEth     = meta.priceUsd     ? usdToLamports(meta.priceUsd,     solPrice) : null;
    const marketCapEth = meta.marketCapUsd ? usdToLamports(meta.marketCapUsd, solPrice) : null;

    await db.insert(tokensTable).values({
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
    }).onConflictDoNothing();

    this.log.info({ mint, name: meta.name, symbol: meta.symbol }, "pumpswap: new token indexed");

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

    if (!trade) return; // duplicate

    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth ? { priceEth } : {}),
    }).where(eq(tokensTable.address, mint));

    this.log.debug({ mint, isBuy, sol: solLamports }, "pumpswap: trade indexed");

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

export async function startPumpSwapAdapter(): Promise<void> {
  const indexer = new PumpSwapIndexer();
  indexer.start();
}
