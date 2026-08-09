/**
 * Post-graduation swap indexer for pump.fun tokens — PumpSwap AMM.
 *
 * Data source: wss://solana-rpc.publicnode.com (PublicNode free RPC)
 * Program:     pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA (PumpSwap, March 2025)
 *
 * Architecture (single-program subscription + pool-address pre-filter):
 *
 *  1. Single PumpSwap PROGRAM subscription.
 *     Per-mint `logsSubscribe { mentions: [mint] }` proved unreliable: PublicNode
 *     does not deliver notifications when the mint is loaded via Address Lookup
 *     Tables (used by Jupiter and most aggregators). The PumpSwap PROGRAM ID is
 *     always in the static account keys, so a program subscription fires reliably.
 *
 *  2. Pool-address pre-filter (zero RPC calls per notification).
 *     Subscribing to the PumpSwap program delivers ALL global PumpSwap trades
 *     (high volume). To avoid calling getTransaction for every one, we maintain
 *     a poolPubkey → mint map built at startup. Each PumpSwap TradeEvent embeds
 *     the pool pubkey at bytes 8-39 of its "Program data:" log line. We decode
 *     that 32-byte field in shouldProcess() — synchronously, no RPC — and only
 *     forward the event to onEvent() when the pool matches a graduated token.
 *
 *  3. Extends SolanaRpcIndexer for keepalive, watchdog, and endpoint rotation.
 *
 * Entry points:
 *   startRaydiumAmmAdapter()  — called from adapters/index.ts
 *   registerGraduatedMint()   — called by pumpfun.ts on each Migrate event
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade } from "../tradeEmitter";
import { logger as rootLogger } from "../logger";
import {
  SolanaRpcIndexer,
  PUBLICNODE_HTTP,
  FALLBACK_HTTP_RPCS,
  type LogEvent,
  type RpcTx,
} from "./solanaRpcBase";

// ── Constants ──────────────────────────────────────────────────────────────────

const WSOL_MINT  = "So11111111111111111111111111111111111111112";
const CHAIN      = "solana";

const PUMPSWAP_PROGRAM   = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PLATFORM_PUMPSWAP  = "pumpswap";

/** PumpSwap TradeEvent discriminator (sha256("event:TradeEvent")[:8]). */
const TRADE_EVENT_DISC = new Uint8Array([0x67, 0xf4, 0x52, 0x1f, 0x2c, 0xf5, 0x77, 0x77]);
/** Base64 prefix of the discriminator — used for cheap string pre-filter. */
const TRADE_EVENT_B64_PREFIX = "Z/RSHyz1";

const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

/** Mints that must never be indexed as pump.fun tokens. */
const SKIP_MINTS = new Set([
  WSOL_MINT,
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
]);

// ── Graduated mint registry ─────────────────────────────────────────────────────
const graduatedMints = new Set<string>();

// Pool pubkey (base58) → token mint — built at startup from recent transactions.
// Enables zero-cost pre-filtering in shouldProcess() before any getTransaction call.
const poolToMint = new Map<string, string>();

// ── Base58 encoder (no dependency required) ────────────────────────────────────
const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const result: string[] = [];
  while (n > 0n) { result.push(B58_ALPHA[Number(n % 58n)]!); n /= 58n; }
  const leadingZeroes = bytes.findIndex(b => b !== 0);
  return B58_ALPHA[0]!.repeat(Math.max(0, leadingZeroes)) + result.reverse().join("");
}

// ── Pool-address extractor ─────────────────────────────────────────────────────
/**
 * Decode the PumpSwap TradeEvent from a "Program data:" log line and return the
 * pool pubkey (bytes 8-39 of the event, base58-encoded).
 *
 * Returns null if the log does not contain a valid PumpSwap TradeEvent.
 * This is pure computation — no RPC calls.
 */
function extractPoolFromLogs(logs: string[]): string | null {
  for (const log of logs) {
    if (!log.startsWith("Program data: ")) continue;
    const b64 = log.slice(14); // "Program data: ".length === 14
    // Cheap prefix filter: TRADE_EVENT_B64_PREFIX encodes discriminator bytes 0-5
    if (!b64.startsWith(TRADE_EVENT_B64_PREFIX)) continue;
    try {
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 40) continue;
      // Verify full 8-byte discriminator
      let match = true;
      for (let i = 0; i < 8; i++) {
        if (buf[i] !== TRADE_EVENT_DISC[i]) { match = false; break; }
      }
      if (!match) continue;
      // Pool pubkey occupies bytes 8-39
      return b58encode(new Uint8Array(buf.buffer, buf.byteOffset + 8, 32));
    } catch { continue; }
  }
  return null;
}

// ── Swap detection ──────────────────────────────────────────────────────────────
/**
 * Return true if these log lines are a PumpSwap swap instruction.
 * PumpSwap instruction variants: Buy, Sell, BuyExactQuoteIn, SellExactBaseIn, etc.
 * Regex has no \b so it matches all "Buy*" and "Sell*" variants.
 */
function isPumpSwapTrade(logs: string[]): boolean {
  const hasProg  = logs.some(l => l.includes(PUMPSWAP_PROGRAM));
  const hasSwap  = logs.some(l => /Instruction:\s*(Buy|Sell)/i.test(l));
  return hasProg && hasSwap;
}

// ── WSOL-aware swap parser ─────────────────────────────────────────────────────
function parseRaydiumSwap(
  tx: RpcTx,
  expectedMint: string,
): { isBuy: boolean; solLamports: string; tokenAmount: string; traderAddress: string } | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;

  const pre  = meta.preTokenBalances  ?? [];
  const post = meta.postTokenBalances ?? [];

  const keys     = tx.transaction?.message?.accountKeys ?? [];
  const k0       = keys[0];
  const feePayer = k0 ? (typeof k0 === "string" ? k0 : (k0.pubkey ?? "")) : "";

  // WSOL balance changes per account index
  const wsolDeltas = new Map<number, { delta: bigint; owner: string | undefined }>();
  for (const pb of post) {
    if (pb.mint !== WSOL_MINT) continue;
    const preAmt  = BigInt(pre.find(p => p.mint === WSOL_MINT && p.accountIndex === pb.accountIndex)?.uiTokenAmount.amount ?? "0");
    const postAmt = BigInt(pb.uiTokenAmount.amount);
    const delta   = postAmt - preAmt;
    if (delta !== 0n) wsolDeltas.set(pb.accountIndex, { delta, owner: pb.owner });
  }
  if (wsolDeltas.size === 0) return null;

  // Token balance changes per account index
  const tokenDeltas = new Map<number, bigint>();
  for (const pb of post) {
    if (pb.mint !== expectedMint) continue;
    const preAmt  = BigInt(pre.find(p => p.mint === expectedMint && p.accountIndex === pb.accountIndex)?.uiTokenAmount.amount ?? "0");
    const postAmt = BigInt(pb.uiTokenAmount.amount);
    const delta   = postAmt - preAmt;
    if (delta !== 0n) tokenDeltas.set(pb.accountIndex, delta);
  }
  if (tokenDeltas.size === 0) return null;

  const abs = (n: bigint) => (n < 0n ? -n : n);

  // Determine direction from fee-payer's WSOL account
  let isBuy: boolean | null = null;
  let wsolAmount = 0n;
  for (const [, { delta, owner }] of wsolDeltas) {
    if (owner && owner === feePayer) {
      isBuy      = delta < 0n;
      wsolAmount = abs(delta);
      break;
    }
  }

  // Fallback: native SOL delta, then largest token delta direction
  if (isBuy === null) {
    let maxWsol = 0n;
    for (const [, { delta }] of wsolDeltas) {
      if (abs(delta) > maxWsol) { maxWsol = abs(delta); }
    }
    wsolAmount = maxWsol;
    const preBalances  = meta.preBalances  ?? [];
    const postBalances = meta.postBalances ?? [];
    const nativeDelta  = (postBalances[0] ?? 0) - (preBalances[0] ?? 0);
    if (nativeDelta !== 0) {
      isBuy = nativeDelta < 0;
    } else {
      let maxTokDelta = 0n;
      let maxTokAbs   = 0n;
      for (const [, d] of tokenDeltas) {
        if (abs(d) > maxTokAbs) { maxTokAbs = abs(d); maxTokDelta = d; }
      }
      isBuy = maxTokDelta > 0n;
    }
  }

  // Largest absolute token delta
  let tokenAmount = 0n;
  for (const [, d] of tokenDeltas) {
    if (abs(d) > tokenAmount) tokenAmount = abs(d);
  }
  if (wsolAmount === 0n || tokenAmount === 0n) return null;

  return {
    isBuy,
    solLamports:   wsolAmount.toString(),
    tokenAmount:   tokenAmount.toString(),
    traderAddress: feePayer || "unknown",
  };
}

// ── Simple RPC helper for startup pool-map building ────────────────────────────
// (Used outside the class, before the indexer is started.)

let _reqId = 2_000_000; // start high to avoid collisions
function nextId(): number { return _reqId++; }

async function simpleFetch<T>(method: string, params: unknown[]): Promise<T | null> {
  const urls = [PUBLICNODE_HTTP, ...FALLBACK_HTTP_RPCS];
  for (const url of urls) {
    try {
      const res  = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params }),
        signal:  AbortSignal.timeout(8_000),
      });
      const json = (await res.json()) as { result?: T; error?: { code?: number } };
      if ((json.error?.code === -32005) || (json.error?.code === 429)) continue;
      if (json.error) { rootLogger.warn({ method, err: json.error }, "raydium_amm pool-map: rpc error"); continue; }
      return json.result ?? null;
    } catch { continue; }
  }
  return null;
}

/**
 * Fetch the pool pubkey for a given graduated mint by looking at its most recent
 * PumpSwap transactions and decoding the TradeEvent's "Program data:" log line.
 * Adds the result to `poolToMint` on success.
 */
async function buildPoolMappingForMint(mint: string): Promise<void> {
  try {
    const sigs = await simpleFetch<Array<{ signature: string; err: unknown }>>(
      "getSignaturesForAddress", [mint, { limit: 10 }]
    );
    if (!sigs?.length) return;

    for (const { signature, err: txErr } of sigs) {
      if (txErr) continue; // skip failed transactions
      const tx = await simpleFetch<{
        meta?: { logMessages?: string[] | null; err?: unknown } | null;
      }>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
      if (!tx?.meta?.logMessages) continue;
      if (tx.meta.err) continue;

      const logs = tx.meta.logMessages;
      // Only process transactions that invoked PumpSwap
      if (!logs.some(l => l.includes(PUMPSWAP_PROGRAM))) continue;

      const pool = extractPoolFromLogs(logs);
      if (pool) {
        poolToMint.set(pool, mint);
        rootLogger.debug({ adapter: "raydium_amm", mint, pool: pool.slice(0,8) },
          "raydium_amm: pool mapping built");
        return;
      }
    }
  } catch (err) {
    rootLogger.debug({ adapter: "raydium_amm", err, mint }, "raydium_amm: pool map build failed for mint");
  }
}

async function buildAllPoolMappings(): Promise<void> {
  if (graduatedMints.size === 0) return;
  await Promise.all(Array.from(graduatedMints).map(buildPoolMappingForMint));
  rootLogger.info(
    { adapter: "raydium_amm", poolsMapped: poolToMint.size, graduated: graduatedMints.size },
    "raydium_amm: pool address map built"
  );
}

// ── Graduated mint registry ─────────────────────────────────────────────────────

export function registerGraduatedMint(mint: string): void {
  if (graduatedMints.has(mint) || SKIP_MINTS.has(mint)) return;
  graduatedMints.add(mint);
  rootLogger.info({ adapter: "raydium_amm", mint }, "raydium_amm: graduated mint registered");
  // Build pool mapping asynchronously — will be ready before next trade for this mint
  void buildPoolMappingForMint(mint).catch(() => { /* ignore */ });
}

async function refreshGraduatedMints(): Promise<void> {
  const rows = await db
    .select({ address: tokensTable.address })
    .from(tokensTable)
    .where(eq(tokensTable.graduated, true));
  for (const r of rows) {
    if (!SKIP_MINTS.has(r.address)) graduatedMints.add(r.address);
  }
}

// ── PumpSwap indexer ───────────────────────────────────────────────────────────
class PumpSwapChainIndexer extends SolanaRpcIndexer {
  constructor() {
    super({
      programId:   PUMPSWAP_PROGRAM,
      adapterName: "raydium_amm",
      watchdogMs:  120_000, // PumpSwap has lower volume than pump.fun; allow 2 min of silence
    });
  }

  /**
   * Pre-filter: only forward to onEvent() when this notification is for one of
   * our tracked graduated tokens. Uses the pool pubkey embedded in the TradeEvent
   * "Program data:" — zero RPC calls.
   *
   * Falls through (returns true) if the pool map is empty (startup race),
   * allowing onEvent to handle it gracefully.
   */
  protected override shouldProcess(logs: string[]): boolean {
    if (!isPumpSwapTrade(logs)) return false;
    if (poolToMint.size === 0) {
      // Pool map not yet built — drop event to avoid overwhelming the RPC queue.
      // Map builds async; once ready, all subsequent notifications will be filtered.
      return false;
    }
    const pool = extractPoolFromLogs(logs);
    return pool !== null && poolToMint.has(pool);
  }

  /** Fetch the full transaction and record the trade. */
  protected override async onEvent(event: LogEvent): Promise<void> {
    const { signature, logs } = event;

    // Resolve mint directly from pool map (shouldProcess already verified it's there)
    const pool = extractPoolFromLogs(logs);
    if (!pool) return;
    const mint = poolToMint.get(pool);
    if (!mint) return;

    const tx = await this.getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    await this.ingestTrade(signature, mint, tx);
  }

  private async ingestTrade(signature: string, mint: string, tx: RpcTx): Promise<void> {
    const swap = parseRaydiumSwap(tx, mint);
    if (!swap) {
      this.log.debug({ signature, mint }, "raydium_amm: could not parse PumpSwap swap — skipping");
      return;
    }

    const { isBuy, solLamports, tokenAmount, traderAddress } = swap;

    const priceEth =
      tokenAmount !== "0" && solLamports !== "0"
        ? (Number(solLamports) / Number(tokenAmount) / 1000).toFixed(15)
        : null;

    const [trade] = await db
      .insert(tradesTable)
      .values({
        tokenAddress:  mint,
        tokenName:     null,
        tokenSymbol:   null,
        traderAddress,
        isBuy,
        ethAmount:     solLamports,
        tokenAmount,
        priceEth,
        txHash:        signature,
        platform:      PLATFORM_PUMPSWAP,
        timestamp:     new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (!trade) return; // duplicate tx

    // Lazy-insert stub if this graduated token was never indexed
    await db.insert(tokensTable).values({
      address:              mint,
      name:                 "???",
      symbol:               "???",
      creatorAddress:       traderAddress,
      totalSupply:          "1000000000000000",
      virtualTokenReserves: "0",
      virtualEthReserves:   "0",
      marketCapEth:         "0",
      priceEth:             null,
      platform:             "pump_fun",
      chain:                CHAIN,
      graduated:            true,
    }).onConflictDoNothing();

    // Update token aggregate stats
    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
      ...(priceEth !== null
        ? {
            priceEth,
            marketCapEth: sql`CAST(
              CAST(${tokensTable.totalSupply} AS NUMERIC) *
              ${solLamports}::NUMERIC /
              ${tokenAmount}::NUMERIC
            AS TEXT)`,
          }
        : {}),
    }).where(eq(tokensTable.address, mint));

    this.log.info(
      { mint, isBuy, solLamports, tokenAmount, priceEth },
      "pumpswap: post-graduation trade ingested"
    );

    const [tokenRow] = await db
      .select({
        name:         tokensTable.name,
        symbol:       tokensTable.symbol,
        marketCapEth: tokensTable.marketCapEth,
        volumeEth:    tokensTable.volumeEth,
        tradeCount:   tokensTable.tradeCount,
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
        platform:      PLATFORM_PUMPSWAP,
        timestamp:     trade.timestamp.toISOString(),
      },
      token: {
        address:              mint,
        name:                 tokenRow?.name         ?? null,
        symbol:               tokenRow?.symbol       ?? null,
        priceEth,
        marketCapEth:         tokenRow?.marketCapEth ?? null,
        volumeEth:            tokenRow?.volumeEth    ?? solLamports,
        virtualEthReserves:   "0",
        virtualTokenReserves: "0",
        tradeCount:           Number(tokenRow?.tradeCount ?? 0),
        platform:             PLATFORM_PUMPSWAP,
        chain:                CHAIN,
      },
    });
  }
}

// ── Exported entry point ───────────────────────────────────────────────────────

export async function startRaydiumAmmAdapter(): Promise<void> {
  // 1. Load graduated mints from DB
  try {
    await refreshGraduatedMints();
    rootLogger.info(
      { adapter: "raydium_amm", graduatedCount: graduatedMints.size },
      "raydium_amm: graduated mint cache initialised"
    );
  } catch (err) {
    rootLogger.warn({ err }, "raydium_amm: failed to load graduated mints at startup");
  }

  // 2. Build pool→mint map BEFORE starting the subscription.
  //    This means shouldProcess() filters immediately on connect — no RPC flood.
  try {
    await buildAllPoolMappings();
  } catch (err) {
    rootLogger.warn({ err }, "raydium_amm: pool map build failed (will retry per-mint on graduation)");
  }

  // 3. Periodic graduated-mint refresh (safety net)
  setInterval(() => {
    void refreshGraduatedMints().catch((err: unknown) =>
      rootLogger.warn({ err }, "raydium_amm: graduated-mint refresh failed")
    );
  }, REFRESH_INTERVAL_MS);

  // 4. Start the PumpSwap indexer (subscription begins in start())
  const indexer = new PumpSwapChainIndexer();
  indexer.start();
}
