/**
 * SolanaRpcIndexer — shared WebSocket base for subscribing to Solana program logs.
 *
 * Uses PublicNode's free public RPC by default (wss://solana-rpc.publicnode.com).
 * Handles:
 *   - logsSubscribe to a given program ID
 *   - Filtering failed transactions (err !== null)
 *   - Auto-reconnect with exponential backoff
 *   - HTTP RPC helper for getTransaction
 *
 * Subclasses implement:
 *   - shouldProcess(logs): whether to call onEvent for this tx (default: true for all)
 *   - onEvent(event): handle the confirmed tx — creation, trade, or anything else
 */

import { logger as rootLogger } from "../logger";

export const PUBLICNODE_WSS  = "wss://solana-rpc.publicnode.com";
export const PUBLICNODE_HTTP = "https://solana-rpc.publicnode.com";

/** Free public Solana WebSocket RPC endpoints — rotated on silent-drop reconnects. */
export const FALLBACK_WSS_RPCS = [
  "wss://api.mainnet-beta.solana.com",           // Solana Foundation
  "wss://rpc.ankr.com/solana/ws",                // Ankr free tier
  "wss://solana-rpc.publicnode.com",             // PublicNode (back as third option)
] as const;

/** Free public Solana RPC endpoints used as fallbacks when the primary is rate-limited.
 *  Tried in order on -32005 / 429 responses. No auth needed on any of these. */
export const FALLBACK_HTTP_RPCS = [
  "https://rpc.ankr.com/solana",                           // Ankr free tier
  "https://api.mainnet-beta.solana.com",                   // Solana Foundation
  "https://solana-api.tt-prod.net",                        // Triton
  "https://endpoints.omniatech.io/v1/sol/mainnet/public",  // Omnia public
] as const;

export interface LogEvent {
  signature: string;
  logs: string[];
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

export interface RpcInstruction {
  programIdIndex: number;
  accounts:       number[];
  /** Base58-encoded instruction data (present when encoding="json") */
  data:           string;
}

export interface RpcTx {
  blockTime?: number | null;
  meta?: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    preBalances?: number[];
    postBalances?: number[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?:  Array<{ pubkey?: string } | string>;
      instructions?: RpcInstruction[];
    };
  };
}

/** Instruction type parsed from program log lines */
export type InstructionType = "create" | "buy" | "sell" | "unknown";

export function detectInstructionType(logs: string[]): InstructionType {
  for (const l of logs) {
    if (/Instruction:\s*Create(V\d+)?/i.test(l) || /Instruction:\s*InitializeMint/i.test(l))
      return "create";
    if (/Instruction:\s*Buy/i.test(l))   return "buy";
    if (/Instruction:\s*Sell/i.test(l))  return "sell";
  }
  return "unknown";
}

let _id = 1;
function nextId() { return _id++; }

export abstract class SolanaRpcIndexer {
  protected readonly programId: string;
  protected readonly httpUrl: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly log: any;

  // WSS rotation — tried in round-robin on each silent-drop reconnect
  private readonly _wssUrls: string[];
  private _wssIdx = 0;

  private delay    = 5_000;
  private maxDelay = 120_000;

  // ── Zero-event startup watchdog ────────────────────────────────────────────
  // If the program ID is wrong OR the connection silently drops, the WebSocket
  // will stay "open" but deliver no log events. We force a reconnect after 30 s
  // of silence so the indexer self-heals without operator intervention.
  private _eventsSeenThisConnection = 0;
  private _watchdogTimer:  ReturnType<typeof setTimeout>  | null = null;
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    programId:   string;
    adapterName: string;
    wssUrl?:     string;
    httpUrl?:    string;
  }) {
    this.programId = opts.programId;
    // Round-robin WSS pool: start with caller-supplied or PublicNode, then fallbacks
    const primary = opts.wssUrl ?? PUBLICNODE_WSS;
    this._wssUrls = [primary, ...FALLBACK_WSS_RPCS.filter(u => u !== primary)];
    this.httpUrl   = opts.httpUrl ?? PUBLICNODE_HTTP;
    this.log       = rootLogger.child({ adapter: opts.adapterName });
  }

  /**
   * Return true if this event's log lines should trigger `onEvent`.
   * Default: only confirmed creation instructions. Override to handle trades too.
   */
  protected shouldProcess(logs: string[]): boolean {
    return detectInstructionType(logs) === "create";
  }

  /** Handle a confirmed, relevant program event */
  protected abstract onEvent(event: LogEvent): Promise<void>;

  // ── RPC helpers ────────────────────────────────────────────────────────────

  // ── Concurrency limiter (semaphore with queue) ─────────────────────────────
  // PublicNode free tier allows ~10 req/s. Cap concurrent getTransaction calls
  // to avoid rate limits. Excess calls are queued (up to _rpcQueueMax) so no
  // event is silently discarded while the RPC is temporarily saturated.
  // Only if the queue itself is full (sustained overload) are new arrivals
  // dropped — this is an explicit backpressure boundary, not a silent loss.
  private _rpcInFlight   = 0;
  private readonly _rpcMaxConcurrent = 4;  // keep low — PublicNode free tier rate-limits at ~4 req/s
  private readonly _rpcQueueMax      = 32; // small queue — stale events aren't worth processing
  private _rpcQueue: Array<() => void> = [];

  private _acquireRpcSlot(): Promise<void> {
    if (this._rpcInFlight < this._rpcMaxConcurrent) {
      this._rpcInFlight++;
      return Promise.resolve();
    }
    if (this._rpcQueue.length >= this._rpcQueueMax) {
      // Sustained overload — drop to prevent unbounded memory growth
      this.log.warn({ queued: this._rpcQueue.length }, "rpc: queue full, dropping event");
      return Promise.reject(new Error("rpc queue full"));
    }
    return new Promise((resolve) => {
      this._rpcQueue.push(() => {
        this._rpcInFlight++;
        resolve();
      });
    });
  }

  private _releaseRpcSlot(): void {
    this._rpcInFlight--;
    const next = this._rpcQueue.shift();
    if (next) next();
  }

  protected async rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T | null> {
    try {
      await this._acquireRpcSlot();
    } catch {
      return null; // queue full — explicit drop after warning
    }
    // Try primary RPC first, then fall through to free public fallbacks on rate-limit (-32005).
    const urlsToTry = [this.httpUrl, ...FALLBACK_HTTP_RPCS];
    try {
      for (const url of urlsToTry) {
        try {
          const res = await fetch(url, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params }),
            signal:  AbortSignal.timeout(8_000),
          });
          const json = (await res.json()) as { result?: T; error?: { code?: number } & unknown };
          const errCode = (json.error as { code?: number } | undefined)?.code;
          if (errCode === -32005 || errCode === 429) {
            // Rate-limited on this endpoint — silently try next fallback
            continue;
          }
          if (json.error) {
            this.log.warn({ rpcError: json.error, method, url }, "rpc: error response");
            continue; // try next endpoint instead of giving up entirely
          }
          return json.result ?? null;
        } catch {
          // Network failure on this endpoint — try next
          continue;
        }
      }
      this.log.warn({ method }, "rpc: all endpoints rate-limited or failed");
      return null;
    } finally {
      this._releaseRpcSlot();
    }
  }

  protected async getTransaction(signature: string): Promise<RpcTx | null> {
    return this.rpcCall<RpcTx>("getTransaction", [
      signature,
      { encoding: "json", maxSupportedTransactionVersion: 0 },
    ]);
  }

  /** Extract a newly-minted token: in post-balances but NOT in pre-balances */
  protected extractNewMint(tx: RpcTx): string | null {
    const pre  = new Set((tx.meta?.preTokenBalances  ?? []).map((b) => b.mint));
    const post =          tx.meta?.postTokenBalances ?? [];
    for (const b of post) {
      if (!pre.has(b.mint)) return b.mint;
    }
    return null;
  }

  /** Creator / trader = fee-payer = account key 0 */
  protected extractSigner(tx: RpcTx): string {
    const keys  = tx.transaction?.message?.accountKeys ?? [];
    const first = keys[0];
    if (!first) return "unknown";
    return typeof first === "string" ? first : (first.pubkey ?? "unknown");
  }

  /**
   * Parse the primary token delta and SOL amounts from a swap transaction.
   * Returns null when no meaningful token change is found.
   */
  protected parseSwap(tx: RpcTx): {
    mint: string;
    isBuy: boolean;
    solLamports: string;
    tokenAmount: string;
    traderAddress: string;
  } | null {
    const meta = tx.meta;
    if (!meta || meta.err) return null;

    const pre          = meta.preTokenBalances  ?? [];
    const post         = meta.postTokenBalances ?? [];
    const preBalances  = meta.preBalances       ?? [];
    const postBalances = meta.postBalances      ?? [];

    // Determine buy/sell from SOL balance of fee-payer (index 0): spends SOL = buy.
    const solDelta  = (postBalances[0] ?? 0) - (preBalances[0] ?? 0);
    const isBuy     = solDelta < 0;
    const solLamports = Math.abs(solDelta).toString();

    // Collect per-account token deltas WITHOUT summing across accounts.
    // Summing cancels because the trader gains exactly what the bonding curve loses.
    // Instead, keep the single largest-magnitude individual account delta whose
    // direction matches isBuy (+ for buy, − for sell).
    type AccountDelta = { mint: string; delta: bigint };
    const perAccount: AccountDelta[] = [];
    for (const pb of post) {
      const preEntry = pre.find(
        (p) => p.mint === pb.mint && p.accountIndex === pb.accountIndex
      );
      const preAmt  = BigInt(preEntry?.uiTokenAmount.amount ?? "0");
      const postAmt = BigInt(pb.uiTokenAmount.amount);
      const delta   = postAmt - preAmt;
      if (delta !== 0n) perAccount.push({ mint: pb.mint, delta });
    }

    if (perAccount.length === 0) return null;

    const abs = (n: bigint) => (n < 0n ? -n : n);

    // Prefer accounts whose delta direction matches the SOL-based isBuy flag.
    const matching = perAccount.filter(e => isBuy ? e.delta > 0n : e.delta < 0n);
    const candidates = matching.length > 0 ? matching : perAccount;
    const best = candidates.reduce((a, b) => abs(a.delta) >= abs(b.delta) ? a : b);

    const mint        = best.mint;
    const tokenAmount = abs(best.delta).toString();
    const traderAddress = this.extractSigner(tx);

    return { mint, isBuy, solLamports, tokenAmount, traderAddress };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    this.log.info(
      { programId: this.programId, rpc: this.wssUrl },
      `${this.constructor.name}: starting`
    );
    this.connect();
  }

  private connect(): void {
    const wssUrl = this._wssUrls[this._wssIdx % this._wssUrls.length];
    const ws = new WebSocket(wssUrl);

    ws.addEventListener("open", () => {
      this.delay = 5_000;
      this._eventsSeenThisConnection = 0;
      this.log.info({ programId: this.programId, wss: wssUrl }, `${this.constructor.name}: connected`);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: nextId(),
        method: "logsSubscribe",
        params: [{ mentions: [this.programId] }, { commitment: "confirmed" }],
      }));

      // Keepalive: send a getHealth ping every 20 s to prevent silent drops.
      // Some RPCs silently close idle WebSocket connections; this keeps them alive.
      this._keepaliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "getHealth" }));
        }
      }, 20_000);

      // Watchdog: if 30 s pass with zero events, rotate to the next WSS endpoint
      // and force a close so the reconnect loop kicks in immediately.
      this._watchdogTimer = setTimeout(() => {
        if (this._eventsSeenThisConnection === 0) {
          const nextUrl = this._wssUrls[(this._wssIdx + 1) % this._wssUrls.length];
          this.log.warn(
            { programId: this.programId, currentWss: wssUrl, nextWss: nextUrl },
            `${this.constructor.name}: 30 s with zero events — rotating WSS endpoint and reconnecting`
          );
          this._wssIdx++; // rotate before close so the reconnect uses next URL
          ws.close();
        }
      }, 30_000);
    });

    ws.addEventListener("message", (event) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(event.data as string) as Record<string, unknown>; }
      catch { return; }

      if (msg["method"] !== "logsNotification") return;

      const value = (
        (msg["params"] as Record<string, unknown>)?.["result"] as Record<string, unknown>
      )?.["value"] as Record<string, unknown> | undefined;

      if (!value || value["err"]) return; // skip failed txs

      const signature = value["signature"] as string | undefined;
      const logs      = value["logs"]      as string[] | undefined;
      if (!signature || !Array.isArray(logs)) return;

      if (!this.shouldProcess(logs)) return;

      this._eventsSeenThisConnection++;
      // Cancel watchdog on first valid event
      if (this._watchdogTimer !== null) {
        clearTimeout(this._watchdogTimer);
        this._watchdogTimer = null;
      }

      void this.onEvent({ signature, logs }).catch((err: unknown) => {
        this.log.error({ err, signature }, "error in onEvent");
      });
    });

    ws.addEventListener("error", (err) => {
      this.log.error({ err: String(err) }, `${this.constructor.name}: WebSocket error`);
    });

    ws.addEventListener("close", () => {
      // Clear watchdog + keepalive on disconnect (reconnect will start fresh ones)
      if (this._watchdogTimer !== null) {
        clearTimeout(this._watchdogTimer);
        this._watchdogTimer = null;
      }
      if (this._keepaliveTimer !== null) {
        clearInterval(this._keepaliveTimer);
        this._keepaliveTimer = null;
      }
      this.log.warn({ retryMs: this.delay }, `${this.constructor.name}: disconnected — reconnecting`);
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, this.maxDelay);
    });
  }
}
