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
import { fetchDexScreenerPumpSwapPair, pairToDbFields } from "../dexscreener.js";

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
  /**
   * Global rate limiter for trade events on free RPC.
   * PumpSwap generates 100-200 events/second; free RPC can sustain ~4 concurrent
   * getTransaction calls (~4-8/s). Throttle to 1 trade event per interval so the
   * RPC queue never fills. New pool creation is always allowed through.
   *
   * At 1 trade/500ms = 2 trades/second we get ~120 real on-chain trade samples
   * per minute — enough to keep prices and charts accurate without paid RPC.
   */
  private _lastTradePassMs = 0;
  private readonly _tradeIntervalMs = 3000; // max 1 trade event per 3 s — sustainable on free RPC

  constructor() {
    super({ programId: PUMPSWAP_PROGRAM, adapterName: PLATFORM });
  }

  /**
   * Filter by instruction type BEFORE making any getTransaction call.
   * - New pool creation: always allowed through (rare, critical for token indexing).
   * - Trades (buy/sell): throttled to _tradeIntervalMs to stay within free RPC limits.
   */
  protected override shouldProcess(logs: string[]): boolean {
    // "Create" and "Initialize" are too generic — they match thousands of unrelated
    // Solana instructions (token account creation, liquidity provision, etc.) and
    // flood the queue on free RPC. Only match "CreatePool" for pool creation.
    const isNewPool = logs.some((l) => /Instruction:\s*CreatePool\b/i.test(l));
    if (isNewPool) return true;

    // Trade: buy or sell only
    const isTrade = logs.some((l) => /Instruction:\s*(Buy|Sell)\b/i.test(l));
    if (!isTrade) return false;

    // Throttle trades to at most 1 per interval — keeps getTransaction load
    // within free-RPC capacity (~1-2 req/s sustained).
    const now = Date.now();
    if (now - this._lastTradePassMs < this._tradeIntervalMs) return false;
    this._lastTradePassMs = now;
    return true;
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

    this.log.info({ mint }, "pumpswap: new pool detected — fetching metadata from DexScreener");

    // Use DexScreener (free, no API key) instead of Birdeye for new pool metadata.
    // DexScreener indexes PumpSwap pools within seconds of creation.
    const pair = await fetchDexScreenerPumpSwapPair(mint);

    const name     = pair?.baseToken.name    ?? mint.slice(0, 8);
    const symbol   = pair?.baseToken.symbol  ?? "???";
    const imageUrl = pair?.info?.imageUrl    ?? null;

    const priceFields = pair ? pairToDbFields(pair) : {};

    await db.insert(tokensTable).values({
      address:        mint,
      name,
      symbol,
      imageUrl,
      creatorAddress: "unknown",
      platform:       PLATFORM,
      chain:          CHAIN,
      graduated:      true,
      ...priceFields,
    }).onConflictDoNothing();

    this.log.info({ mint, name, symbol }, "pumpswap: new token indexed");

    emitNewToken({
      type: "newToken",
      token: {
        address:      mint,
        name,
        symbol,
        imageUrl,
        priceEth:     priceFields.priceEth ?? null,
        marketCapEth: priceFields.marketCapEth ?? null,
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
