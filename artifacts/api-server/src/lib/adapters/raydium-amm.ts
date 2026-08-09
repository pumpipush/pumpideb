/**
 * Raydium AMM v4 adapter — indexes post-graduation swaps for pump.fun graduated tokens.
 *
 * Data source: wss://solana-rpc.publicnode.com (PublicNode free RPC)
 * Program:     675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (Raydium AMM v4)
 *
 * Design decisions:
 *
 *  1. Per-mint subscriptions (not per-program).
 *     Instead of subscribing to every Raydium AMM v4 swap (enormous global volume),
 *     we issue one `logsSubscribe { mentions: [mint] }` request per graduated token.
 *     The RPC node filters at the source — we only receive notifications for
 *     transactions that actually mention our tokens, and only call getTransaction
 *     when one arrives. This prevents saturating the shared PublicNode RPC quota.
 *
 *  2. WSOL-aware swap parsing (not native-SOL balance diff).
 *     Native SOL balance (preBalances[0]) includes transaction fees, rent changes,
 *     and WSOL wrapping overhead. Instead, we look at WSOL (wrapped-SOL) token
 *     account balance changes and the expected-mint account balance changes from
 *     the pre/postTokenBalances arrays — these reflect only the swap amounts.
 *
 *  3. Multiple subscriptions on one WebSocket connection.
 *     We maintain a single reconnecting WebSocket and keep a map of
 *     subscriptionId → mint. When a new token graduates, we send an additional
 *     logsSubscribe on the same live connection.
 *
 * Entry points:
 *   startRaydiumAmmAdapter()  — start the subscriber (called from adapters/index.ts)
 *   registerGraduatedMint()   — called by pumpfun.ts on each Migrate event
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { emitTrade } from "../tradeEmitter";
import { logger as rootLogger } from "../logger";
import {
  PUBLICNODE_WSS,
  PUBLICNODE_HTTP,
  FALLBACK_HTTP_RPCS,
  type RpcTx,
} from "./solanaRpcBase";

// ── Constants ──────────────────────────────────────────────────────────────────

const WSOL_MINT  = "So11111111111111111111111111111111111111112";
const PLATFORM   = "raydium_amm";
const CHAIN      = "solana";

// PumpSwap — pump.fun's native AMM for graduated tokens (launched March 2025).
// Tokens that graduate after March 2025 trade here instead of Raydium AMM v4.
const PUMPSWAP_PROGRAM   = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PLATFORM_PUMPSWAP  = "pumpswap";

// Refresh interval for the graduated-mints cache (5 minutes).
// The primary update path is registerGraduatedMint(); the periodic refresh is a
// safety net so the adapter recovers mints that graduated while offline.
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

// ── ID counter (shared with base class via module scope is fine) ───────────────
let _reqId = 1_000_000; // Start high to avoid collisions with other adapters
function nextReqId(): number { return _reqId++; }

// ── Graduated mint registry ─────────────────────────────────────────────────────
const graduatedMints = new Set<string>();

/**
 * Register a mint as graduated so the adapter immediately starts indexing its swaps.
 * Called by the pump.fun adapter on each detected Migrate instruction.
 */
export function registerGraduatedMint(mint: string): void {
  if (graduatedMints.has(mint)) return;
  graduatedMints.add(mint);
  rootLogger.info({ adapter: "raydium_amm", mint }, "raydium_amm: graduated mint registered");
  // Subscribe on the live WebSocket if already open
  _sharedSubscriber?.subscribeToMint(mint);
}

async function refreshGraduatedMints(): Promise<void> {
  const rows = await db
    .select({ address: tokensTable.address })
    .from(tokensTable)
    .where(eq(tokensTable.graduated, true));
  for (const r of rows) graduatedMints.add(r.address);
}

// ── RPC helper ─────────────────────────────────────────────────────────────────
// Thin rate-limited HTTP RPC helper (mirrors SolanaRpcIndexer.rpcCall).

let _rpcInFlight   = 0;
const _rpcMaxConcurrent = 4;
const _rpcQueueMax      = 16;
const _rpcQueue: Array<() => void> = [];

function _acquireRpcSlot(): Promise<void> {
  if (_rpcInFlight < _rpcMaxConcurrent) { _rpcInFlight++; return Promise.resolve(); }
  if (_rpcQueue.length >= _rpcQueueMax) {
    rootLogger.warn({ adapter: "raydium_amm", queued: _rpcQueue.length }, "raydium_amm: rpc queue full, dropping");
    return Promise.reject(new Error("rpc queue full"));
  }
  return new Promise((resolve) => { _rpcQueue.push(() => { _rpcInFlight++; resolve(); }); });
}

function _releaseRpcSlot(): void {
  _rpcInFlight--;
  const next = _rpcQueue.shift();
  if (next) next();
}

async function rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T | null> {
  try { await _acquireRpcSlot(); } catch { return null; }
  const urls = [PUBLICNODE_HTTP, ...FALLBACK_HTTP_RPCS];
  try {
    for (const url of urls) {
      try {
        const res  = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ jsonrpc: "2.0", id: nextReqId(), method, params }),
          signal:  AbortSignal.timeout(8_000),
        });
        const json = (await res.json()) as { result?: T; error?: { code?: number } };
        const errCode = json.error?.code;
        if (errCode === -32005 || errCode === 429) continue;
        if (json.error) { rootLogger.warn({ method, url, err: json.error }, "raydium_amm: rpc error"); continue; }
        return json.result ?? null;
      } catch { continue; }
    }
    return null;
  } finally { _releaseRpcSlot(); }
}

async function getTransaction(sig: string): Promise<RpcTx | null> {
  return rpcCall<RpcTx>("getTransaction", [
    sig,
    { encoding: "json", maxSupportedTransactionVersion: 0 },
  ]);
}

// ── Swap detection ──────────────────────────────────────────────────────────────

/**
 * Detect which DEX platform executed a swap in these log lines.
 *
 * Returns the platform string ("raydium_amm" | "pumpswap") if a known swap
 * instruction is found, or null when the transaction is not a tracked swap
 * (e.g. a token transfer, approval, or an unknown program interaction).
 *
 * Detection strategy:
 *   - Raydium AMM v4:  look for SwapBaseIn / SwapBaseOut instruction names.
 *   - Raydium CPMM:    look for "Swap" instruction name.
 *   - PumpSwap:        look for the PumpSwap program ID + Buy / Sell instruction.
 *     PumpSwap was launched by pump.fun in March 2025 to replace the Raydium AMM v4
 *     migration path. Graduated tokens after that date trade on PumpSwap.
 */
function detectDexPlatform(logs: string[]): string | null {
  for (const l of logs) {
    if (/Instruction:\s*SwapBase(In|Out)/i.test(l)) return PLATFORM;          // Raydium AMM v4
    if (/Instruction:\s*Swap\b/i.test(l))           return PLATFORM;          // Raydium CPMM
  }
  // PumpSwap: confirm the PumpSwap program is actually invoked before accepting
  // a Buy/Sell instruction (those same names appear in the bonding-curve program).
  const hasPumpSwap = logs.some(l => l.includes(PUMPSWAP_PROGRAM));
  if (hasPumpSwap && logs.some(l => /Instruction:\s*(Buy|Sell)\b/i.test(l))) {
    return PLATFORM_PUMPSWAP;
  }
  return null;
}

// ── WSOL-aware swap parser ─────────────────────────────────────────────────────
/**
 * Parse a Raydium AMM swap from a full transaction.
 *
 * Strategy:
 *   - Identify the expected token mint's pre/post balance changes.
 *   - Identify WSOL (So111…) balance changes for the SOL leg of the swap.
 *   - Use the fee payer's accounts (owner === feePayer) to determine direction:
 *       user's WSOL decreased → bought tokens (BUY)
 *       user's WSOL increased → sold tokens for SOL (SELL)
 *   - Fall back to the sign of the largest WSOL delta when owner info is absent.
 *
 * This avoids the native-SOL balance diff (preBalances[0]) which includes
 * transaction fees, rent exemption changes, and WSOL wrapping overhead.
 */
function parseRaydiumSwap(
  tx: RpcTx,
  expectedMint: string,
): { isBuy: boolean; solLamports: string; tokenAmount: string; traderAddress: string } | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;

  const pre  = meta.preTokenBalances  ?? [];
  const post = meta.postTokenBalances ?? [];

  // ── Extract fee payer (account key 0) ────────────────────────────────────
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const k0   = keys[0];
  const feePayer = k0 ? (typeof k0 === "string" ? k0 : (k0.pubkey ?? "")) : "";

  // ── WSOL balance changes (per account index) ──────────────────────────────
  const wsolDeltas = new Map<number, { delta: bigint; owner: string | undefined }>();
  for (const pb of post) {
    if (pb.mint !== WSOL_MINT) continue;
    const preAmt  = BigInt(pre.find((p) => p.mint === WSOL_MINT && p.accountIndex === pb.accountIndex)?.uiTokenAmount.amount ?? "0");
    const postAmt = BigInt(pb.uiTokenAmount.amount);
    const delta   = postAmt - preAmt;
    if (delta !== 0n) wsolDeltas.set(pb.accountIndex, { delta, owner: pb.owner });
  }

  if (wsolDeltas.size === 0) {
    // No WSOL changes — not a SOL-denominated swap (could be token-to-token router hop)
    return null;
  }

  // ── Token (expectedMint) balance changes ──────────────────────────────────
  const tokenDeltas = new Map<number, bigint>();
  for (const pb of post) {
    if (pb.mint !== expectedMint) continue;
    const preAmt  = BigInt(pre.find((p) => p.mint === expectedMint && p.accountIndex === pb.accountIndex)?.uiTokenAmount.amount ?? "0");
    const postAmt = BigInt(pb.uiTokenAmount.amount);
    const delta   = postAmt - preAmt;
    if (delta !== 0n) tokenDeltas.set(pb.accountIndex, delta);
  }

  if (tokenDeltas.size === 0) return null;

  const abs = (n: bigint) => (n < 0n ? -n : n);

  // ── Determine direction ───────────────────────────────────────────────────
  // Primary: look for the fee-payer's WSOL account.
  //   fee payer's WSOL decreased → they spent SOL → BUY
  //   fee payer's WSOL increased → they received SOL → SELL
  let isBuy: boolean | null = null;
  let wsolAmount = 0n;

  for (const [, { delta, owner }] of wsolDeltas) {
    if (owner && owner === feePayer) {
      isBuy    = delta < 0n; // fee payer's WSOL down → they spent SOL → BUY
      wsolAmount = abs(delta);
      break;
    }
  }

  // Fallback: if no WSOL account owned by fee payer (they may have used native SOL
  // which gets auto-wrapped), look at the largest WSOL delta.
  // The pool's WSOL vault increases on a buy (SOL flows in) and decreases on a sell.
  if (isBuy === null) {
    let maxWsol = 0n;
    let maxDelta = 0n;
    for (const [, { delta }] of wsolDeltas) {
      if (abs(delta) > maxWsol) { maxWsol = abs(delta); maxDelta = delta; }
    }
    wsolAmount = maxWsol;
    // Largest token delta direction: positive = user gained tokens = BUY
    let maxTokDelta = 0n;
    let maxTokAbs = 0n;
    for (const [, d] of tokenDeltas) {
      if (abs(d) > maxTokAbs) { maxTokAbs = abs(d); maxTokDelta = d; }
    }
    // If the fee payer's native SOL decreased, it's a buy (confirmed by token direction)
    const preBalances  = meta.preBalances  ?? [];
    const postBalances = meta.postBalances ?? [];
    const nativeDelta  = (postBalances[0] ?? 0) - (preBalances[0] ?? 0);
    if (nativeDelta !== 0) {
      isBuy = nativeDelta < 0;
    } else {
      // Last resort: positive token delta = user gained tokens = BUY
      isBuy = maxTokDelta > 0n;
    }
  }

  // ── Token amount = largest absolute token delta ───────────────────────────
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

// ── Multi-subscription WebSocket manager ───────────────────────────────────────
/**
 * Manages one reconnecting WebSocket connection with multiple logsSubscribe
 * subscriptions — one per graduated token mint. The RPC node does the filtering
 * so we only receive log notifications for transactions that mention our tokens.
 */
class RaydiumMultiSubscriber {
  private readonly log = rootLogger.child({ adapter: "raydium_amm" });
  private ws: WebSocket | null = null;
  // Request id (we sent) → mint — used to correlate subscription acknowledgments
  private readonly pendingReqToMint = new Map<number, string>();
  // subscription id (server assigned) → mint — used when notifications arrive
  private readonly subscriptionToMint = new Map<number, string>();

  private delay    = 5_000;
  private maxDelay = 120_000;

  start(): void {
    this.log.info({ count: graduatedMints.size }, "raydium_amm: starting multi-mint subscriber");
    this.connect();
  }

  /** Subscribe to a specific mint on the live WebSocket (if open). */
  subscribeToMint(mint: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const reqId = nextReqId();
    this.pendingReqToMint.set(reqId, mint);
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id:      reqId,
      method:  "logsSubscribe",
      params:  [{ mentions: [mint] }, { commitment: "confirmed" }],
    }));
    this.log.debug({ mint, reqId }, "raydium_amm: logsSubscribe sent for mint");
  }

  private connect(): void {
    const ws = new WebSocket(PUBLICNODE_WSS);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.delay = 5_000;
      this.log.info({ mintCount: graduatedMints.size }, "raydium_amm: WebSocket connected — subscribing to mints");
      // Re-subscribe to all known graduated mints on (re)connect
      for (const mint of graduatedMints) {
        const reqId = nextReqId();
        this.pendingReqToMint.set(reqId, mint);
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id:      reqId,
          method:  "logsSubscribe",
          params:  [{ mentions: [mint] }, { commitment: "confirmed" }],
        }));
      }
    });

    ws.addEventListener("message", (event) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(event.data as string) as Record<string, unknown>; }
      catch { return; }

      // ── Subscription acknowledgment ──────────────────────────────────────
      // { "jsonrpc": "2.0", "result": <subId>, "id": <ourReqId> }
      if (typeof msg["result"] === "number" && typeof msg["id"] === "number") {
        const subId = msg["result"] as number;
        const reqId = msg["id"]    as number;
        const mint  = this.pendingReqToMint.get(reqId);
        if (mint) {
          this.subscriptionToMint.set(subId, mint);
          this.pendingReqToMint.delete(reqId);
          this.log.debug({ mint, subId }, "raydium_amm: subscription confirmed");
        }
        return;
      }

      // ── Log notification ─────────────────────────────────────────────────
      // { "method": "logsNotification", "params": { "result": { "subscription": <subId>, "value": {...} } } }
      if (msg["method"] !== "logsNotification") return;

      const params = msg["params"] as Record<string, unknown> | undefined;
      const result = params?.["result"] as Record<string, unknown> | undefined;
      const subId  = result?.["subscription"] as number | undefined;
      const value  = result?.["value"]        as Record<string, unknown> | undefined;

      if (!value || value["err"]) return; // skip failed txs
      if (typeof subId !== "number") return;

      const mint      = this.subscriptionToMint.get(subId);
      const signature = value["signature"] as string | undefined;
      const logs      = value["logs"]      as string[] | undefined;

      if (!mint || !signature || !Array.isArray(logs)) return;
      const swapPlatform = detectDexPlatform(logs);
      if (!swapPlatform) return; // not a tracked swap (approval/transfer/unknown)

      void this.handleSwap(signature, mint, swapPlatform).catch((err: unknown) => {
        this.log.error({ err, signature, mint, swapPlatform }, "raydium_amm: error processing swap");
      });
    });

    ws.addEventListener("error", (err) => {
      this.log.error({ err: String(err) }, "raydium_amm: WebSocket error");
    });

    ws.addEventListener("close", () => {
      // Clear subscription state — will re-subscribe on reconnect
      this.subscriptionToMint.clear();
      this.pendingReqToMint.clear();
      this.log.warn({ retryMs: this.delay }, "raydium_amm: disconnected — reconnecting");
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, this.maxDelay);
    });
  }

  private async handleSwap(signature: string, mint: string, platform: string): Promise<void> {
    const tx = await getTransaction(signature);
    if (!tx || tx.meta?.err) return;

    const swap = parseRaydiumSwap(tx, mint);
    if (!swap) {
      this.log.debug({ signature, mint, platform }, "raydium_amm: could not parse swap — skipping");
      return;
    }

    const { isBuy, solLamports, tokenAmount, traderAddress } = swap;

    // price_eth convention: SOL per token = lamports / base_units / 1000
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
        platform,          // "raydium_amm" or "pumpswap" depending on which DEX
        timestamp:     new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (!trade) return; // duplicate tx

    // Lazy-insert a minimal token stub if this mint was never indexed.
    // This handles tokens that graduated during a WebSocket gap — the pumpfun
    // graduation handler does an upsert now, but older gaps before that fix are
    // also covered here. The enrichment job will overwrite name/symbol/image.
    // Pump.fun standard total supply: 1,000,000,000 × 10^6 atoms = 1_000_000_000_000_000.
    await db.insert(tokensTable).values({
      address:              mint,
      name:                 "???",
      symbol:               "???",
      creatorAddress:       traderAddress,         // best available: first post-graduation trader
      totalSupply:          "1000000000000000",     // pump.fun standard
      virtualTokenReserves: "0",
      virtualEthReserves:   "0",
      marketCapEth:         "0",
      priceEth:             null,
      platform:             "pump_fun",             // token origin (always pump.fun for graduated tokens)
      chain:                CHAIN,
      graduated:            true,
    }).onConflictDoNothing();

    // Update token aggregate stats.
    // market_cap_eth (lamports) = total_supply_atoms × sol_lamports / token_atoms
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
      { mint, isBuy, solLamports, tokenAmount, priceEth, platform },
      `${platform}: post-graduation trade ingested`
    );

    // Fetch latest token state for the SSE payload
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
        platform,
        timestamp:     trade.timestamp.toISOString(),
      },
      token: {
        address:              mint,
        name:                 tokenRow?.name        ?? null,
        symbol:               tokenRow?.symbol      ?? null,
        priceEth,
        marketCapEth:         tokenRow?.marketCapEth ?? null,
        volumeEth:            tokenRow?.volumeEth    ?? solLamports,
        // xy=k pool — no "virtual reserves" concept on either Raydium or PumpSwap.
        virtualEthReserves:   "0",
        virtualTokenReserves: "0",
        tradeCount:           Number(tokenRow?.tradeCount ?? 0),
        platform,
        chain:                CHAIN,
      },
    });
  }
}

// Module-level reference so registerGraduatedMint() can reach the live subscriber
let _sharedSubscriber: RaydiumMultiSubscriber | null = null;

// ── Exported entry point ───────────────────────────────────────────────────────

export async function startRaydiumAmmAdapter(): Promise<void> {
  // Load all currently-graduated mints first so we subscribe to them on connect
  try {
    await refreshGraduatedMints();
    rootLogger.info(
      { adapter: "raydium_amm", graduatedCount: graduatedMints.size },
      "raydium_amm: graduated mint cache initialised"
    );
  } catch (err) {
    rootLogger.warn({ err }, "raydium_amm: failed to load graduated mints at startup");
  }

  // Periodic refresh as a safety net (primary updates via registerGraduatedMint)
  setInterval(() => {
    void refreshGraduatedMints().catch((err: unknown) =>
      rootLogger.warn({ err }, "raydium_amm: graduated-mint refresh failed")
    );
  }, REFRESH_INTERVAL_MS);

  const subscriber = new RaydiumMultiSubscriber();
  _sharedSubscriber = subscriber;
  subscriber.start();
}
