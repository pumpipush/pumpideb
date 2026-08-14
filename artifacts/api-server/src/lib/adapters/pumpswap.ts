/**
 * pumpswap.ts — real-time indexer for PumpSwap (pump-amm) DEX.
 *
 * Program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *
 * Strategy:
 *   - Subscribe via logsSubscribe to the pump-amm program
 *   - Only process Buy/Sell trade events (CreatePool is intentionally skipped —
 *     extractNewMint returns the LP mint, not the tradeable base token)
 *   - On first trade for an unknown token: auto-create it using DexScreener metadata
 *   - Throttle to 1 event per 3 s to stay within free-RPC capacity
 *
 * Token discovery:
 *   Tokens are NOT created at pool creation time. Instead they are auto-inserted
 *   when their first trade is detected. DexScreener is called once per new token
 *   to fetch name, symbol, image, and current price. Subsequent price updates
 *   come from the enrichment loop (every 5 min) via enrichPumpSwapPrices().
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade, emitNewToken } from "../tradeEmitter.js";
import { logger as rootLogger } from "../logger.js";
import { SolanaRpcIndexer, type LogEvent } from "./solanaRpcBase.js";
import { fetchDexScreenerPumpSwapPair, pairToDbFields, pairToSocialFields } from "../dexscreener.js";

const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PLATFORM         = "pumpswap";
const CHAIN            = "solana";

// Mints that are never the "interesting" token (quote/stable tokens)
const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112",   // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export class PumpSwapIndexer extends SolanaRpcIndexer {
  /**
   * Rate limiter — PumpSwap generates 100-200 events/second.
   * getTransaction is always routed to free PublicNode (never Alchemy),
   * so the bottleneck is PublicNode throughput, not Alchemy CU budget.
   * 10 s gives ~6 samples/minute — good price discovery without hammering RPCs.
   */
  private _lastTradePassMs = 0;
  private readonly _tradeIntervalMs = 10_000; // 10 s — PublicNode throughput limit

  constructor(opts?: { wssUrl?: string }) {
    super({ programId: PUMPSWAP_PROGRAM, adapterName: PLATFORM, wssUrl: opts?.wssUrl });
  }

  /**
   * Only process Buy/Sell trade events. CreatePool is intentionally excluded:
   * - extractNewMint returns the LP token mint, not the tradeable base token
   * - Tokens are auto-created on first trade instead (correct base mint from parseSwap)
   * - "Create"/"Initialize" are too generic and flood the RPC queue
   */
  protected override shouldProcess(logs: string[]): boolean {
    const isTrade = logs.some((l) => /Instruction:\s*(Buy|Sell)\b/i.test(l));
    if (!isTrade) return false;

    const now = Date.now();
    if (now - this._lastTradePassMs < this._tradeIntervalMs) return false;
    this._lastTradePassMs = now;
    return true;
  }

  protected override async onEvent(event: LogEvent): Promise<void> {
    const tx = await this.getTransaction(event.signature);
    if (!tx || tx.meta?.err) return;

    const swap = this.parseSwap(tx);
    if (!swap || SKIP_MINTS.has(swap.mint)) return;

    await this.handleTrade(
      swap.mint, swap.isBuy, swap.solLamports,
      swap.tokenAmount, swap.traderAddress, event.signature,
    );
  }

  private async handleTrade(
    mint: string, isBuy: boolean, solLamports: string,
    tokenAmount: string, traderAddress: string, signature: string,
  ): Promise<void> {
    const tokBig   = BigInt(tokenAmount);
    const priceEth = tokBig > 0n && solLamports !== "0"
      ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
      : null;

    // ── Dust trade guard ──────────────────────────────────────────────────────
    // Trades with fewer than 1 000 atomic token units produce astronomically
    // wrong prices and pollute trade history / volume stats.  Skip entirely.
    const MIN_PRICE_ATOMS = 1_000n;
    if (tokBig < MIN_PRICE_ATOMS) {
      this.log.debug({ mint, tokenAmount, solLamports },
        "pumpswap: dust trade skipped (tokenAmount < MIN_PRICE_ATOMS)");
      return;
    }

    // ── Auto-create token on first encounter ─────────────────────────────────
    // If this mint is unknown, fetch DexScreener once to get name/symbol/image/price/socials.
    // This is safer than CreatePool detection (which returns the LP mint, not base token).
    const existing = await db
      .select({ id: tokensTable.id, name: tokensTable.name, symbol: tokensTable.symbol })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);

    // Track name/symbol for the trade SSE payload below
    let tokenName:   string | null = existing[0]?.name   ?? null;
    let tokenSymbol: string | null = existing[0]?.symbol ?? null;

    if (existing.length === 0) {
      this.log.info({ mint }, "pumpswap: new token via first trade — fetching DexScreener metadata");

      const pair         = await fetchDexScreenerPumpSwapPair(mint);
      const name         = pair?.baseToken.name   ?? mint.slice(0, 8);
      const symbol       = pair?.baseToken.symbol ?? "???";
      const imageUrl     = pair?.info?.imageUrl   ?? null;
      const fields       = pair ? pairToDbFields(pair)    : null;
      const socialFields = pair ? pairToSocialFields(pair) : {};

      tokenName   = name;
      tokenSymbol = symbol;

      // Only emit newToken when the INSERT actually inserted a new row.
      // Two concurrent handlers for the same unknown mint can both pass the
      // `existing.length === 0` check (async SELECT races). onConflictDoNothing
      // ensures only one row is written; checking the RETURNING result ensures
      // only the winning handler broadcasts the SSE event.
      // pump.fun total supply is constant: 1B tokens × 10^6 decimals = 1e15 atomic.
      // Must be set explicitly — the schema default (now "0") and any value from
      // DexScreener fields must not override this known-correct constant.
      const PUMP_TOTAL_SUPPLY = "1000000000000000";
      const [inserted] = await db.insert(tokensTable).values({
        address:        mint,
        name,
        symbol,
        imageUrl,
        creatorAddress: traderAddress,
        platform:       PLATFORM,
        chain:          CHAIN,
        graduated:      true,
        ...socialFields,
        ...(fields ?? {}),
        // Pin totalSupply last so it always wins over the spread above
        totalSupply:    PUMP_TOTAL_SUPPLY,
        // Use on-chain price from this trade if DexScreener has nothing yet
        ...(priceEth && !fields?.priceEth ? { priceEth } : {}),
      }).onConflictDoNothing().returning({ id: tokensTable.id });

      if (inserted) {
        emitNewToken({
          type: "newToken",
          token: {
            address:      mint,
            name,
            symbol,
            imageUrl,
            priceEth:     fields?.priceEth ?? priceEth,
            marketCapEth: fields?.marketCapEth ?? null,
            platform:     PLATFORM,
            chain:        CHAIN,
            createdAt:    new Date().toISOString(),
          },
        });
      }
    }

    // ── Insert trade ──────────────────────────────────────────────────────────
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
        name:                 tokenName,
        symbol:               tokenSymbol,
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
