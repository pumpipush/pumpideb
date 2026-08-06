/**
 * Pump.fun adapter — connects to PumpPortal WebSocket and ingests real-time
 * token launches and trades into the shared database.
 *
 * Data source: wss://pumpportal.fun/api/data
 * - subscribeNewToken  → inserts new token row + subscribes to its trades
 * - subscribeTokenTrade → inserts trade row + updates token stats
 *
 * No env vars required; will connect automatically on startup.
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { logger } from "../logger";
import { emitTrade } from "../tradeEmitter";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const PLATFORM = "pump_fun";
const CHAIN = "solana";

// ── Types mirroring PumpPortal payloads ───────────────────────────────────────

interface PumpNewToken {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "create";
  initialBuy: number;
  solAmount: number;
  tokenAmount: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  name: string;
  symbol: string;
  uri?: string;
  pool?: string;
}

interface PumpTrade {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  newTokenPrice?: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  pool?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert SOL float → lamport string (BigInt-safe via string arithmetic) */
function solToLamports(sol: number): string {
  return Math.round(sol * 1_000_000_000).toString();
}

// ── Core adapter ──────────────────────────────────────────────────────────────

async function handleNewToken(payload: PumpNewToken): Promise<void> {
  const log = logger.child({ adapter: "pump_fun", mint: payload.mint });
  try {
    await db
      .insert(tokensTable)
      .values({
        address: payload.mint,
        name: payload.name,
        symbol: payload.symbol,
        description: null,
        imageUrl: null,
        creatorAddress: payload.traderPublicKey,
        totalSupply: "1000000000000000", // Pump.fun default 1B tokens (6 decimals)
        virtualTokenReserves: Math.round(payload.vTokensInBondingCurve).toString(),
        virtualEthReserves: Math.round(payload.vSolInBondingCurve).toString(),
        marketCapEth: solToLamports(payload.marketCapSol),
        priceEth: payload.tokenAmount > 0
          ? (payload.solAmount / payload.tokenAmount).toFixed(12)
          : null,
        platform: PLATFORM,
        chain: CHAIN,
      })
      .onConflictDoNothing();

    log.info({ name: payload.name, symbol: payload.symbol }, "pump_fun: new token ingested");

    // Optionally fetch metadata from IPFS in background (fire-and-forget)
    if (payload.uri) {
      fetchAndUpdateMetadata(payload.mint, payload.uri).catch(() => undefined);
    }
  } catch (err) {
    log.error({ err }, "pump_fun: failed to insert token");
  }
}

async function handleTrade(payload: PumpTrade): Promise<void> {
  const log = logger.child({ adapter: "pump_fun", mint: payload.mint, sig: payload.signature });
  try {
    const lamports = solToLamports(payload.solAmount);
    const isBuy = payload.txType === "buy";
    const priceEth = payload.newTokenPrice != null
      ? payload.newTokenPrice.toString()
      : null;

    // Upsert trade (ignore duplicate signatures)
    const [trade] = await db
      .insert(tradesTable)
      .values({
        tokenAddress: payload.mint,
        tokenName: null,
        tokenSymbol: null,
        traderAddress: payload.traderPublicKey,
        isBuy,
        ethAmount: lamports,
        tokenAmount: Math.round(payload.tokenAmount).toString(),
        priceEth,
        txHash: payload.signature,
        platform: PLATFORM,
        timestamp: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (!trade) return; // duplicate

    // Update token stats (reserves, price, marketcap, tradeCount, volumeEth)
    await db
      .update(tokensTable)
      .set({
        virtualTokenReserves: Math.round(payload.vTokensInBondingCurve).toString(),
        virtualEthReserves: Math.round(payload.vSolInBondingCurve).toString(),
        marketCapEth: solToLamports(payload.marketCapSol),
        priceEth,
        tradeCount: sql`${tokensTable.tradeCount} + 1`,
        volumeEth: sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${lamports} AS TEXT)`,
      })
      .where(eq(tokensTable.address, payload.mint));

    log.debug({ isBuy, sol: payload.solAmount }, "pump_fun: trade ingested");

    // Emit SSE for any subscribers on this token
    emitTrade({
      type: "trade",
      trade: {
        id: trade.id,
        tokenAddress: trade.tokenAddress,
        traderAddress: trade.traderAddress,
        isBuy: trade.isBuy,
        ethAmount: trade.ethAmount,
        tokenAmount: trade.tokenAmount,
        priceEth: trade.priceEth,
        txHash: trade.txHash,
        timestamp: trade.timestamp.toISOString(),
      },
      token: {
        address: payload.mint,
        priceEth,
        marketCapEth: solToLamports(payload.marketCapSol),
        volumeEth: lamports,
        virtualEthReserves: Math.round(payload.vSolInBondingCurve).toString(),
        virtualTokenReserves: Math.round(payload.vTokensInBondingCurve).toString(),
        tradeCount: 0, // incremented above, client will refresh
      },
    });
  } catch (err) {
    log.error({ err }, "pump_fun: failed to insert trade");
  }
}

/** Fire-and-forget: fetch IPFS/arweave metadata and update imageUrl + description */
async function fetchAndUpdateMetadata(mint: string, uri: string): Promise<void> {
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return;
    const meta = await res.json() as { image?: string; description?: string };
    const updates: Record<string, string> = {};
    if (meta.image) updates.imageUrl = meta.image;
    if (meta.description) updates.description = meta.description;
    if (Object.keys(updates).length > 0) {
      await db.update(tokensTable).set(updates).where(eq(tokensTable.address, mint));
    }
  } catch {
    // Non-critical; ignore errors
  }
}

function subscribeToTokenTrades(ws: WebSocket, mint: string): void {
  ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
}

// ── Exported adapter entry point ──────────────────────────────────────────────

export async function startPumpFunAdapter(): Promise<void> {
  let delay = RECONNECT_DELAY_MS;

  // On startup, subscribe to trades for the most recent pump_fun tokens we already have
  async function loadExistingSubscriptions(ws: WebSocket): Promise<void> {
    try {
      const recent = await db
        .select({ address: tokensTable.address })
        .from(tokensTable)
        .where(eq(tokensTable.platform, PLATFORM))
        .limit(200);
      for (const { address } of recent) {
        subscribeToTokenTrades(ws, address);
      }
      logger.info({ adapter: "pump_fun", count: recent.length }, "pump_fun: subscribed to existing token trades");
    } catch (err) {
      logger.error({ err, adapter: "pump_fun" }, "pump_fun: failed to load existing tokens");
    }
  }

  function connect(): void {
    const ws = new WebSocket(PUMPPORTAL_WS);
    logger.info({ adapter: "pump_fun" }, "pump_fun: connecting to PumpPortal...");

    ws.addEventListener("open", () => {
      delay = RECONNECT_DELAY_MS; // reset backoff
      logger.info({ adapter: "pump_fun" }, "pump_fun: connected — subscribing to new tokens and trades");
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      void loadExistingSubscriptions(ws);
    });

    ws.addEventListener("message", (event) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const msg = data as Record<string, unknown>;

      // Skip acknowledgement messages
      if (!msg["mint"]) return;

      if (msg["txType"] === "create") {
        void handleNewToken(msg as unknown as PumpNewToken);
        // Subscribe to this token's trades now that we know its mint
        subscribeToTokenTrades(ws, msg["mint"] as string);
      } else if (msg["txType"] === "buy" || msg["txType"] === "sell") {
        void handleTrade(msg as unknown as PumpTrade);
      }
    });

    ws.addEventListener("error", (err) => {
      logger.error({ adapter: "pump_fun", err: String(err) }, "pump_fun: WebSocket error");
    });

    ws.addEventListener("close", () => {
      logger.warn({ adapter: "pump_fun", retryMs: delay }, "pump_fun: disconnected — reconnecting...");
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    });
  }

  connect();
}
