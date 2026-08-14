/**
 * pumpApiManager.ts — Primary stream manager for pump.fun + PumpSwap data.
 *
 * Architecture:
 *   PRIMARY:  wss://stream.pumpapi.io/ — free, no API key, all events pre-decoded.
 *             Handles pool:"pump" (bonding curve) and pool:"pump-amm" (PumpSwap).
 *             Zero getTransaction calls → zero Alchemy CUs for these platforms.
 *
 *   FALLBACK: Chain-native logsSubscribe adapters (PublicNode → Alchemy WSS) kick in
 *             FALLBACK_DELAY_MS after pumpapi.io disconnects. They stop automatically
 *             when pumpapi.io reconnects.
 *
 * Startup sequence:
 *   1. PumpApiAdapter starts immediately (connects to pumpapi.io WSS).
 *   2. If pumpapi.io hasn't confirmed a connection within 15 s, chain adapters start
 *      as a cold-start safety net.
 *   3. On each subsequent disconnect, chain adapters start after FALLBACK_DELAY_MS.
 *   4. On reconnect, chain adapters stop (saving Alchemy CU spend).
 *
 * DB dedup (onConflictDoNothing on tx_hash in both trades and tokens) handles the
 * brief overlap window where both sources are simultaneously active.
 */

import { PumpApiAdapter, PumpFunChainIndexer, startZeroHealJob } from "./pumpfun.js";
import { PumpSwapIndexer } from "./pumpswap.js";
import { RaydiumLaunchLabIndexer } from "./raydium-launchlab.js";
import { PUBLICNODE_WSS } from "./solanaRpcBase.js";
import { logger as rootLogger } from "../logger.js";

const managerLog = rootLogger.child({ component: "PumpStreamManager" });

/** Seconds to wait after a normal pumpapi.io disconnect before activating chain fallback. */
const FALLBACK_DELAY_MS = 30_000;

/** Shorter delay on the initial cold-start (pumpapi.io hasn't connected yet). */
const COLD_START_DELAY_MS = 15_000;

/**
 * Delay used when the data-staleness watchdog triggered the disconnect.
 * Must be shorter than FALLBACK_DELAY_MS so the fallback fires BEFORE
 * pumpapi.io reconnects (reconnect delay starts at 5 s and doubles).
 * 2 s is enough: the watchdog calls onDataStale → we schedule the fallback →
 * then pumpapi closes → reconnects after 5 s. The fallback fires at 2 s,
 * well before the reconnect at 5 s, so _onConnected sees a running fallback
 * and leaves it running instead of cancelling a pending timer.
 */
const STALE_FALLBACK_DELAY_MS = 2_000;

/**
 * Minimum time (ms) pumpapi.io must deliver real data continuously before the
 * chain fallback is considered safe to stop.
 *
 * Without this guard, a partial pumpapi.io outage where it delivers one trade
 * then immediately goes stale again causes a "stale loop":
 *   stale (30s) → fallback activates → 1 real event → fallback stops →
 *   stale (30s) → fallback activates → ... repeat indefinitely.
 * Each loop burns 30+ seconds of silence visible to users.
 *
 * With this guard, the fallback stays running for at least 10 s after the first
 * real event. If pumpapi.io goes stale again within that window, the confirmation
 * timer is cancelled and the fallback continues uninterrupted.
 */
const REAL_DATA_CONFIRM_MS = 10_000;

// ── Slack alert helper ─────────────────────────────────────────────────────────

/**
 * Post a message to the Slack webhook configured in SLACK_WEBHOOK_URL.
 * Silently no-ops when the env var is absent — alerts are opt-in.
 * Logs a warning if the webhook is configured but the POST fails.
 */
async function slackAlert(text: string): Promise<void> {
  const url = process.env["SLACK_WEBHOOK_URL"];
  if (!url) return;
  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text }),
    });
    if (!res.ok) {
      managerLog.warn(
        { status: res.status, statusText: res.statusText },
        "pumpApiManager: Slack webhook returned non-OK status"
      );
    }
  } catch (err) {
    managerLog.warn({ err }, "pumpApiManager: failed to post Slack alert");
  }
}

// ── PumpStreamManager ──────────────────────────────────────────────────────────

class PumpStreamManager {
  private readonly _pumpApi: PumpApiAdapter;

  private _chainFallback: {
    pumpFun:  PumpFunChainIndexer;
    pumpSwap: PumpSwapIndexer;
    launchLab: RaydiumLaunchLabIndexer;
  } | null = null;

  private _fallbackTimer:      ReturnType<typeof setTimeout> | null = null;

  /**
   * Confirmation timer: set when pumpapi.io delivers the first real event after a
   * fallback period. The chain fallback stops only after REAL_DATA_CONFIRM_MS of
   * continuous real data — not immediately on the first event.  Cancelled if
   * pumpapi.io goes stale again before the window expires.
   */
  private _confirmTimer:       ReturnType<typeof setTimeout> | null = null;

  private _everConnected   = false;

  /** Wall-clock time when the chain fallback was last activated (for duration reporting). */
  private _fallbackActivatedAt: number | null = null;

  constructor() {
    this._pumpApi = new PumpApiAdapter({
      onConnected:    () => this._onConnected(),
      onDisconnected: () => this._onDisconnected(),
      onDataStale:    () => this._onDataStale(),
      onRealData:     () => this._onRealData(),
    });
  }

  start(): void {
    this._pumpApi.start();
    // Schedule a cold-start fallback: if pumpapi.io hasn't connected within
    // COLD_START_DELAY_MS, activate the chain RPC adapters immediately.
    this._scheduleFallback(COLD_START_DELAY_MS);
  }

  // ── Connection callbacks ────────────────────────────────────────────────────

  private _onDataStale(): void {
    // Data-staleness watchdog fired — pumpapi.io is connected but delivering no
    // trade data. Schedule chain fallback immediately (2 s) so it activates
    // BEFORE pumpapi.io reconnects (~5 s). Without this, the normal 30 s
    // fallback timer is always cancelled by pumpapi's fast reconnect.
    //
    // Also cancel any pending confirmation timer — if pumpapi.io delivered one
    // event and immediately went stale again, we must NOT stop the chain fallback.
    if (this._confirmTimer !== null) {
      clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
      managerLog.warn("pumpApiManager: data stale again before confirm window — keeping chain fallback running");
    }
    managerLog.warn(
      { delayMs: STALE_FALLBACK_DELAY_MS },
      "pumpApiManager: data stale — scheduling immediate chain fallback"
    );
    this._scheduleFallback(STALE_FALLBACK_DELAY_MS);
  }

  private _onConnected(): void {
    this._everConnected = true;
    // Cancel any pending confirmation timer — this is a new connection, so the
    // previous connection's "first real event" is no longer proof of health.
    if (this._confirmTimer !== null) {
      clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
    }
    // Cancel any pending fallback TIMER so we don't start the chain adapters
    // if pumpapi.io connects quickly (cold start or brief network blip).
    // However, if chain adapters are already RUNNING, we do NOT stop them here —
    // reconnecting is not proof that pumpapi.io is healthy; it can reconnect and
    // immediately go stale again. The adapters stop only in _onRealData() once
    // pumpapi.io proves it is delivering real trade data.
    if (this._fallbackTimer !== null) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
      managerLog.info("pumpApiManager: pumpapi.io connected — cancelled pending fallback timer");
    } else if (this._chainFallback !== null) {
      managerLog.info(
        "pumpApiManager: pumpapi.io reconnected — chain fallback still running until real data arrives"
      );
    } else {
      managerLog.info("pumpApiManager: pumpapi.io connected");
    }
  }

  private _onRealData(): void {
    // pumpapi.io just delivered the first real trade/create event on this
    // connection. Do NOT stop the chain fallback immediately — pumpapi.io can
    // deliver one event then go stale again (partial outage), which would cause
    // a "stale loop": fallback stops → stale → fallback activates → one event →
    // fallback stops → repeat, burning 30+ s of silence per cycle.
    //
    // Instead, start a REAL_DATA_CONFIRM_MS confirmation window. The chain
    // fallback only stops after pumpapi.io has been delivering data continuously
    // for that window. If _onDataStale fires before the window expires, the
    // confirmation timer is cancelled and the fallback keeps running.
    if (this._chainFallback === null) return;
    if (this._confirmTimer !== null) return; // confirmation already counting down

    managerLog.info(
      { confirmMs: REAL_DATA_CONFIRM_MS },
      "pumpApiManager: pumpapi.io real data received — starting confirmation window before stopping fallback"
    );

    const fallbackActivatedAt = this._fallbackActivatedAt;
    this._confirmTimer = setTimeout(() => {
      this._confirmTimer = null;
      if (this._chainFallback === null) return; // already stopped

      const durationSec = fallbackActivatedAt !== null
        ? Math.round((Date.now() - fallbackActivatedAt) / 1_000)
        : null;
      this._fallbackActivatedAt = null;

      managerLog.info(
        { durationSec },
        "pumpApiManager: pumpapi.io confirmed healthy — stopping chain fallback adapters"
      );
      this._chainFallback.pumpFun.stop();
      this._chainFallback.pumpSwap.stop();
      this._chainFallback.launchLab.stop();
      this._chainFallback = null;

      const durationStr = durationSec !== null ? ` after ${durationSec}s` : "";
      void slackAlert(
        `✅ *pumpapi.io recovered${durationStr}* — chain-RPC fallback stopped.\n` +
        `Alchemy CU spend is back to baseline.`
      );
    }, REAL_DATA_CONFIRM_MS);
  }

  private _onDisconnected(): void {
    this._scheduleFallback(FALLBACK_DELAY_MS);
  }

  // ── Fallback scheduling ─────────────────────────────────────────────────────

  private _scheduleFallback(delay: number): void {
    if (this._fallbackTimer !== null) return; // already scheduled
    const coldStart = !this._everConnected;
    managerLog.warn(
      { delayMs: delay, coldStart },
      "pumpApiManager: scheduling chain fallback"
    );
    this._fallbackTimer = setTimeout(() => {
      this._fallbackTimer = null;
      if (this._chainFallback !== null) return; // already running
      this._fallbackActivatedAt = Date.now();
      managerLog.warn("pumpApiManager: activating chain RPC fallback adapters");
      // Fallback adapters use PublicNode WSS (free) — not Alchemy.
      // These run only briefly while pumpapi.io reconnects; they don't need
      // Alchemy's premium reliability, and pump.fun volume drains Alchemy CUs fast.
      const pumpFun   = new PumpFunChainIndexer({ wssUrl: PUBLICNODE_WSS });
      const pumpSwap  = new PumpSwapIndexer({ wssUrl: PUBLICNODE_WSS });
      const launchLab = new RaydiumLaunchLabIndexer({ wssUrl: PUBLICNODE_WSS });
      pumpFun.start();
      pumpSwap.start();
      launchLab.start();
      this._chainFallback = { pumpFun, pumpSwap, launchLab };

      const reason = coldStart
        ? "pumpapi.io did not connect within the startup window"
        : "pumpapi.io has been disconnected for 30+ seconds";
      void slackAlert(
        `🔴 *pumpapi.io fallback activated* — ${reason}.\n` +
        `Chain-RPC adapters (PublicNode free WSS) are now indexing pump.fun + PumpSwap + Raydium LaunchLab.\n` +
        `Alchemy CUs unaffected — fallback uses PublicNode only.`
      );
    }, delay);
  }
}

// ── Public entry point ─────────────────────────────────────────────────────────

/**
 * Start the unified pump.fun + PumpSwap stream manager.
 * Call this once on server boot; it handles primary/fallback switching internally.
 */
export async function startPumpStreamManager(): Promise<void> {
  const manager = new PumpStreamManager();
  manager.start();
  // Zero-heal job runs regardless of which data source is active.
  startZeroHealJob();
}
