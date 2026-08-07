/**
 * Pump.fun adapter — chain-native real-time indexer.
 *
 * Data source: wss://solana-rpc.publicnode.com (PublicNode free RPC)
 * Program:     6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *
 * Indexes:
 *   - Token creation (CreateV2): extracts mint, fetches pump.fun API for metadata
 *   - Swaps (Buy / Sell): persists trade to DB, updates token stats, emits SSE
 *
 * No env vars required — uses PublicNode free RPC.
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade, emitNewToken } from "../tradeEmitter";
import {
  SolanaRpcIndexer,
  detectInstructionType,
  type LogEvent,
  type RpcTx,
} from "./solanaRpcBase";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_API     = "https://frontend-api.pump.fun/coins";
const PLATFORM     = "pump_fun";
const CHAIN        = "solana";

// ── Pump.fun API metadata ──────────────────────────────────────────────────────

interface PumpCoin {
  mint?:                   string;
  name?:                   string;
  symbol?:                 string;
  description?:            string;
  image_uri?:              string;
  twitter?:                string;
  website?:                string;
  creator?:                string;
  market_cap?:             number;
  virtual_sol_reserves?:   number;
  virtual_token_reserves?: number;
  created_timestamp?:      number;
}

async function fetchPumpMeta(mint: string): Promise<PumpCoin | null> {
  try {
    const res = await fetch(`${PUMP_API}/${mint}`, {
      signal: AbortSignal.timeout(8_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });
    if (!res.ok) return null;
    return (await res.json()) as PumpCoin;
  } catch {
    return null;
  }
}

// ── Indexer ────────────────────────────────────────────────────────────────────

class PumpFunChainIndexer extends SolanaRpcIndexer {
  constructor() {
    super({ programId: PUMP_PROGRAM, adapterName: "pump_fun" });
  }

  /** Process create, buy, and sell instructions */
  protected override shouldProcess(logs: string[]): boolean {
    const t = detectInstructionType(logs);
    return t === "create" || t === "buy" || t === "sell";
  }

  protected override async onEvent(event: LogEvent): Promise<void> {
    const instrType = detectInstructionType(event.logs);

    if (instrType === "create") {
      await this.handleCreate(event);
    } else if (instrType === "buy" || instrType === "sell") {
      await this.handleTrade(event);
    }
  }

  // ── Creation ───────────────────────────────────────────────────────────────

  private async handleCreate(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    const mint    = this.extractPumpMint(tx);
    const creator = this.extractSigner(tx);
    if (!mint) {
      this.log.debug({ signature }, "pump_fun: could not extract mint — skipping create");
      return;
    }

    // Fetch pump.fun API for rich metadata
    const meta = await fetchPumpMeta(mint);

    const name        = meta?.name        ?? mint.slice(0, 8) + "…";
    const symbol      = meta?.symbol      ?? "???";
    const description = meta?.description ?? null;
    const imageUrl    = meta?.image_uri   ?? null;
    const twitterUrl  = meta?.twitter     ?? null;
    const websiteUrl  = meta?.website     ?? null;
    const creatorAddr = meta?.creator     ?? creator;

    // Convert market cap SOL value to lamports string for storage
    const mcapSol = meta?.market_cap ?? null;
    const marketCapEth = mcapSol != null
      ? Math.round(mcapSol * 1_000_000_000).toString()
      : null;

    await db.insert(tokensTable).values({
      address:              mint,
      name,
      symbol,
      description,
      imageUrl,
      creatorAddress:       creatorAddr,
      totalSupply:          "1000000000000000",
      virtualTokenReserves: meta?.virtual_token_reserves?.toString() ?? "1000000000000000",
      virtualEthReserves:   meta?.virtual_sol_reserves?.toString()   ?? "0",
      marketCapEth,
      priceEth:             null,
      twitterUrl,
      websiteUrl,
      platform:             PLATFORM,
      chain:                CHAIN,
    }).onConflictDoNothing();

    this.log.info({ mint, name, symbol }, "pump_fun: new token ingested (chain-native)");

    emitNewToken({
      type: "newToken",
      token: {
        address:      mint,
        name,
        symbol,
        imageUrl,
        priceEth:     null,
        marketCapEth,
        platform:     PLATFORM,
        chain:        CHAIN,
        createdAt:    tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : new Date().toISOString(),
      },
    });
  }

  // ── Trade (buy / sell) ────────────────────────────────────────────────────

  private async handleTrade(event: LogEvent): Promise<void> {
    const { signature } = event;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    const swap = this.parseSwap(tx);
    if (!swap) return;

    const { mint, isBuy, solLamports, tokenAmount, traderAddress } = swap;

    const priceEth = tokenAmount !== "0"
      ? (Number(solLamports) / Number(tokenAmount)).toFixed(12)
      : null;

    const [trade] = await db.insert(tradesTable).values({
      tokenAddress:  mint,
      tokenName:     null,
      tokenSymbol:   null,
      traderAddress,
      isBuy,
      ethAmount:     solLamports,
      tokenAmount,
      priceEth,
      txHash:        signature,
      platform:      PLATFORM,
      timestamp:     new Date(),
    }).onConflictDoNothing().returning();

    if (!trade) return; // duplicate tx

    // Update token aggregate stats
    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      priceEth,
    }).where(eq(tokensTable.address, mint));

    this.log.debug({ mint, isBuy, sol: solLamports }, "pump_fun: trade ingested");

    // Fetch latest token state for SSE payload
    const [tokenRow] = await db
      .select({
        name:                 tokensTable.name,
        symbol:               tokensTable.symbol,
        marketCapEth:         tokensTable.marketCapEth,
        volumeEth:            tokensTable.volumeEth,
        virtualEthReserves:   tokensTable.virtualEthReserves,
        virtualTokenReserves: tokensTable.virtualTokenReserves,
        tradeCount:           tokensTable.tradeCount,
      })
      .from(tokensTable)
      .where(eq(tokensTable.address, mint))
      .limit(1);

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
        name:                 tokenRow?.name        ?? null,
        symbol:               tokenRow?.symbol      ?? null,
        priceEth,
        marketCapEth:         tokenRow?.marketCapEth ?? null,
        volumeEth:            tokenRow?.volumeEth    ?? solLamports,
        virtualEthReserves:   tokenRow?.virtualEthReserves   ?? "0",
        virtualTokenReserves: tokenRow?.virtualTokenReserves ?? "0",
        tradeCount:           Number(tokenRow?.tradeCount ?? 0),
        platform:             PLATFORM,
        chain:                CHAIN,
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * pump.fun mint is reliably at accountKeys[1] (ends in "pump").
   * Falls back to postTokenBalances diff for safety.
   */
  private extractPumpMint(tx: RpcTx): string | null {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const k1   = keys[1];
    if (k1) {
      const addr = typeof k1 === "string" ? k1 : k1.pubkey;
      if (addr?.endsWith("pump")) return addr;
    }
    return this.extractNewMint(tx);
  }
}

// ── Exported entry point ───────────────────────────────────────────────────────

export async function startPumpFunAdapter(): Promise<void> {
  const indexer = new PumpFunChainIndexer();
  indexer.start();
}
