/**
 * SolanaRpcIndexer — shared WebSocket base for subscribing to Solana program logs.
 *
 * RPC priority order (both WSS and HTTP):
 *   1. PublicNode  — primary free public endpoint
 *   2. Solana Foundation / Ankr — free public fallbacks
 *
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

/**
 * Returns the primary HTTP RPC URL — always a free public endpoint.
 * Exported so consumers outside this module can build their endpoint lists.
 */
export function getPrimaryHttpRpc(): string {
  return PUBLICNODE_HTTP;
}

/**
 * Free public Solana WebSocket RPC endpoints — rotated on silent-drop reconnects.
 * PublicNode is primary (most reliable free WSS); Solana Foundation and Ankr
 * are fallbacks for when PublicNode is saturated.
 */
export const FALLBACK_WSS_RPCS = [
  "wss://solana-rpc.publicnode.com",   // PublicNode (primary)
  "wss://api.mainnet-beta.solana.com", // Solana Foundation
  "wss://rpc.ankr.com/solana/ws",      // Ankr free tier
] as const;

/**
 * Free public Solana HTTP RPC endpoints — tried in order on rate-limit errors.
 * Three endpoints give enough rotation headroom under normal indexer load.
 */
export const FALLBACK_HTTP_RPCS = [
  "https://solana-rpc.publicnode.com",   // PublicNode
  "https://api.mainnet-beta.solana.com", // Solana Foundation
  "https://rpc.ankr.com/solana",         // Ankr free tier
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
  /** Set by stop() — prevents reconnect loop from restarting after a close. */
  private _stopped = false;

  /** Reference to the currently open WebSocket so stop() can close it immediately. */
  private _currentWs: WebSocket | null = null;

  /**
   * Gracefully stop this indexer — closes the active WebSocket, clears all
   * keepalive/watchdog timers, and prevents the reconnect loop from restarting.
   * Subclasses that manage additional timers (e.g. HTTP poll fallbacks) should
   * override this method, call their own cleanup, then invoke super.stop().
   */
  stop(): void {
    this._stopped = true;
    // Clear base timers — these belong to the current connection
    if (this._watchdogTimer !== null) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this._keepaliveTimer !== null) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
    // Close the active WebSocket so the logsSubscribe stream stops immediately
    if (this._currentWs !== null) {
      try { this._currentWs.close(); } catch { /* ignore */ }
      this._currentWs = null;
    }
  }
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

  // ── Fallback exhaustion tracking ──────────────────────────────────────────
  // After a complete rotation through every WSS URL with zero events on each,
  // call onAllRpcsExhausted() so subclasses can activate a last-resort fallback.
  // Reset on the first event received (call onRpcRecovered()).
  private _fallbackActive = false;

  // Configurable watchdog — low-frequency programs (e.g. Raydium LaunchLab) need
  // a longer window before concluding the connection is silent/dead.
  private readonly _watchdogMs: number;

  constructor(opts: {
    programId:   string;
    adapterName: string;
    wssUrl?:     string;
    httpUrl?:    string;
    /** How long (ms) to wait with zero events before rotating endpoint. Default: 30 000 */
    watchdogMs?: number;
  }) {
    this.programId   = opts.programId;
    this._watchdogMs = opts.watchdogMs ?? 30_000;
    // Round-robin WSS pool: caller-supplied → PublicNode (primary), then free fallbacks
    const primary = opts.wssUrl ?? PUBLICNODE_WSS;
    this._wssUrls = [primary, ...FALLBACK_WSS_RPCS.filter(u => u !== primary)];
    // HTTP: always PublicNode (free) — Alchemy is reserved for WSS only.
    // HTTP calls (getAccountInfo, getSignaturesForAddress, etc.) don't need
    // Alchemy's premium reliability and would drain CUs at indexer volume.
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

  /**
   * Called every time an established WebSocket connection (one that successfully
   * opened) drops.  Fires before the reconnect is attempted, so subclasses can
   * start an HTTP polling fallback promptly rather than waiting for the slow
   * all-endpoints-exhausted path.
   * Default: no-op.
   */
  protected onWssDisconnected(): void { /* no-op */ }

  /**
   * Called on every valid WS event that passes shouldProcess(), unconditionally —
   * regardless of whether onAllRpcsExhausted() has fired.  Subclasses use this to
   * cancel any disconnect-triggered fallback polling the moment the WSS delivers
   * events again, without relying on the _fallbackActive flag.
   * Default: no-op.
   */
  protected onEventReceived(): void { /* no-op */ }

  /**
   * Called once after a full round-trip through every WSS URL with zero events
   * (i.e. all Solana RPC endpoints appear silent / unreachable).
   * Subclasses can override to activate a last-resort fallback data source.
   * Default: no-op.
   */
  protected onAllRpcsExhausted(): void { /* no-op */ }

  /**
   * Called on the first valid event received after onAllRpcsExhausted() fired.
   * Subclasses can override to deactivate the fallback data source.
   * Default: no-op.
   */
  protected onRpcRecovered(): void { /* no-op */ }

  // ── RPC helpers ────────────────────────────────────────────────────────────

  // ── Concurrency limiter (semaphore with queue) ─────────────────────────────
  // Cap concurrent getTransaction calls to avoid free RPC rate limits.
  // Free public endpoints (PublicNode, Solana Foundation, Ankr): ~4 req/s each.
  // Excess calls are queued (up to _rpcQueueMax) so no event is silently
  // discarded while the RPC is temporarily saturated.
  private _rpcInFlight   = 0;
  private readonly _rpcMaxConcurrent = 4; // conservative: free public RPCs
  private readonly _rpcQueueMax      = 64;
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
    // Use "confirmed" commitment to match the logsSubscribe level — the tx is
    // already confirmed when the WS fires, so the RPC can return it immediately
    // without waiting for "finalized" (which adds 5–13 s on many endpoints).
    //
    // IMPORTANT: We deliberately bypass this.httpUrl (Alchemy) here and go
    // straight to the free public fallbacks. Alchemy charges 100 CU per
    // getTransaction call; at pump.fun/PumpSwap/LaunchLab volume this drains
    // the free tier in hours. The WSS logsSubscribe (which does need Alchemy's
    // reliability) already runs on this.httpUrl via the WebSocket connection —
    // getTransaction only needs best-effort delivery, which PublicNode provides.
    const freeUrls = [PUBLICNODE_HTTP, ...FALLBACK_HTTP_RPCS];
    const params   = [
      signature,
      { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ];
    for (const url of freeUrls) {
      try {
        const res = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "getTransaction", params }),
          signal:  AbortSignal.timeout(8_000),
        });
        const json = (await res.json()) as { result?: RpcTx; error?: { code?: number } & unknown };
        const errCode = (json.error as { code?: number } | undefined)?.code;
        if (errCode === -32005 || errCode === 429) continue; // rate-limited, try next
        if (json.error) continue;
        return json.result ?? null;
      } catch {
        continue;
      }
    }
    return null;
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
      { programId: this.programId, rpc: this._wssUrls[0] },
      `${this.constructor.name}: starting`
    );
    this.connect();
  }

  private connect(): void {
    if (this._stopped) return; // stop() was called — do not reconnect
    const wssUrl = this._wssUrls[this._wssIdx % this._wssUrls.length];
    const ws = new WebSocket(wssUrl);
    // Track the active connection so stop() can close it immediately.
    this._currentWs = ws;

    // Per-connection flags — prevent stale callbacks from touching a newer connection's
    // timers, and detect pre-open failures (connection closed before `open` fired).
    let openFired  = false;
    let connClosed = false;

    ws.addEventListener("open", () => {
      if (connClosed) return; // guard against racing close
      openFired = true;
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
        if (!connClosed && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "getHealth" }));
        }
      }, 20_000);

      // Watchdog: if watchdogMs pass with zero events, rotate to the next WSS endpoint
      // and force a close so the reconnect loop kicks in immediately.
      // Low-frequency programs (e.g. Raydium LaunchLab) should use a longer watchdogMs.
      this._watchdogTimer = setTimeout(() => {
        if (connClosed) return; // stale timer from a now-closed connection — ignore
        if (this._eventsSeenThisConnection === 0) {
          this._rotateEndpoint(wssUrl, `${this._watchdogMs / 1000} s with zero events`);
          ws.close();
        }
      }, this._watchdogMs);
    });

    ws.addEventListener("message", (event) => {
      if (connClosed) return; // stale message from a connection already closed

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
      // Unconditional hook — fires regardless of _fallbackActive so subclasses can
      // cancel disconnect-triggered fallbacks as soon as the WSS delivers events.
      this.onEventReceived();
      // If a fallback is active and the chain RPC delivers events again, deactivate it.
      if (this._fallbackActive) {
        this._fallbackActive = false;
        this.log.info(
          { programId: this.programId, wss: wssUrl },
          `${this.constructor.name}: chain RPC recovered — deactivating fallback`
        );
        this.onRpcRecovered();
      }

      void this.onEvent({ signature, logs }).catch((err: unknown) => {
        this.log.error({ err, signature }, "error in onEvent");
      });
    });

    ws.addEventListener("error", (err) => {
      // error is always followed by close; logging here is sufficient.
      this.log.error({ err: String(err) }, `${this.constructor.name}: WebSocket error`);
    });

    ws.addEventListener("close", () => {
      if (connClosed) return; // guard against double-fire
      connClosed = true;
      // Discard the reference only if this ws is still the current one —
      // stop() may have already nulled it out (and closed a newer connection).
      if (this._currentWs === ws) this._currentWs = null;

      // Clear watchdog + keepalive for THIS connection only.
      // The connClosed flag above prevents stale keepalive/watchdog callbacks
      // from a previous connection from clearing timers installed by the next one.
      if (this._watchdogTimer !== null) {
        clearTimeout(this._watchdogTimer);
        this._watchdogTimer = null;
      }
      if (this._keepaliveTimer !== null) {
        clearInterval(this._keepaliveTimer);
        this._keepaliveTimer = null;
      }

      // Pre-open failure: connection refused, unreachable, or immediately dropped.
      // The watchdog was never installed, so rotate the endpoint here.
      if (!openFired) {
        this._rotateEndpoint(wssUrl, "pre-open connection failure");
      } else {
        // Notify subclasses that an established connection dropped — they can
        // start an HTTP fallback without waiting for the slow all-exhausted path.
        this.onWssDisconnected();
      }

      if (this._stopped) return; // stop() was called — do not reconnect
      this.log.warn({ retryMs: this.delay }, `${this.constructor.name}: disconnected — reconnecting`);
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, this.maxDelay);
    });
  }

  /**
   * Increment `_wssIdx` to select the next endpoint on reconnect, then check
   * whether a full rotation through every WSS URL has been completed without any
   * events. If so, activate the last-resort fallback by calling onAllRpcsExhausted().
   */
  private _rotateEndpoint(currentWss: string, reason: string): void {
    const nextUrl = this._wssUrls[(this._wssIdx + 1) % this._wssUrls.length];
    this.log.warn(
      { programId: this.programId, currentWss, nextWss: nextUrl, reason },
      `${this.constructor.name}: rotating WSS endpoint`
    );
    this._wssIdx++;

    // After every WSS URL has been tried once without any events, activate fallback.
    if (!this._fallbackActive && this._wssIdx > 0 && this._wssIdx % this._wssUrls.length === 0) {
      this._fallbackActive = true;
      this.log.warn(
        { programId: this.programId },
        `${this.constructor.name}: all ${this._wssUrls.length} WSS endpoints exhausted — activating fallback`
      );
      this.onAllRpcsExhausted();
    }
  }
}
