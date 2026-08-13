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

  private _fallbackTimer:    ReturnType<typeof setTimeout> | null = null;

  private _everConnected   = false;

  /**
   * Set to true when the data-staleness watchdog fires on the active pumpapi
   * connection. Cleared once the chain fallback is actually running (or when
   * pumpapi delivers real data again).  Used to prevent _onConnected from
   * cancelling a fallback that was scheduled due to a stale connection — which
   * would create an infinite loop where pumpapi always reconnects before the
   * fallback timer fires.
   */
  private _pendingStaleFallback = false;

  /** Wall-clock time when the chain fallback was last activated (for duration reporting). */
  private _fallbackActivatedAt: number | null = null;

  constructor() {
    this._pumpApi = new PumpApiAdapter({
      onConnected:    () => this._onConnected(),
      onDisconnected: () => this._onDisconnected(),
      onDataStale:    () => this._onDataStale(),
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
    // fallback is always cancelled by the fast reconnect, leaving the app with
    // no live data indefinitely.
    this._pendingStaleFallback = true;
    managerLog.warn(
      { delayMs: STALE_FALLBACK_DELAY_MS },
      "pumpApiManager: data stale — scheduling immediate chain fallback"
    );
    this._scheduleFallback(STALE_FALLBACK_DELAY_MS);
  }

  private _onConnected(): void {
    this._everConnected = true;

    // If a stale-triggered fallback is pending (timer scheduled but not yet
    // fired), do NOT cancel it. pumpapi.io has reconnected but we don't yet
    // know if it will deliver real data. The fallback will start in ~2 s; if
    // pumpapi.io is actually healthy this time, _onConnected will be called
    // again with a running _chainFallback and will stop it normally.
    if (this._pendingStaleFallback) {
      managerLog.info(
        "pumpApiManager: pumpapi.io reconnected after stale disconnect — keeping fallback scheduled"
      );
      // Do not cancel the fallback timer. Let it fire and start the chain
      // adapters. They will stop once pumpapi.io proves it is delivering data
      // (next _onConnected call after the fallback is running will stop them).
      return;
    }

    managerLog.info("pumpApiManager: pumpapi.io connected — cancelling chain fallback");

    // Cancel any pending fallback timer (normal reconnect after network blip).
    if (this._fallbackTimer !== null) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }

    // Stop chain fallback if it started during a downtime window.
    if (this._chainFallback !== null) {
      const durationSec = this._fallbackActivatedAt !== null
        ? Math.round((Date.now() - this._fallbackActivatedAt) / 1_000)
        : null;
      this._fallbackActivatedAt = null;

      // pumpapi.io is back and this _onConnected was not skipped (i.e. the
      // previous stale fallback has already started). Clear the stale flag now.
      this._pendingStaleFallback = false;

      managerLog.info(
        { durationSec },
        "pumpApiManager: stopping chain fallback adapters — pumpapi.io recovered"
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
    }
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
      // Fallback is now activating — the stale-pending flag moves to "running".
      this._pendingStaleFallback = false;
      this._fallbackActivatedAt = Date.now();
      managerLog.warn("pumpApiManager: activating chain RPC fallback adapters");
      const pumpFun   = new PumpFunChainIndexer();
      const pumpSwap  = new PumpSwapIndexer();
      const launchLab = new RaydiumLaunchLabIndexer();
      pumpFun.start();
      pumpSwap.start();
      launchLab.start();
      this._chainFallback = { pumpFun, pumpSwap, launchLab };

      const reason = coldStart
        ? "pumpapi.io did not connect within the startup window"
        : "pumpapi.io has been disconnected for 30+ seconds";
      void slackAlert(
        `🔴 *pumpapi.io fallback activated* — ${reason}.\n` +
        `Chain-RPC adapters (PublicNode → Alchemy) are now indexing pump.fun + PumpSwap + Raydium LaunchLab.\n` +
        `Alchemy CU spend is elevated until pumpapi.io reconnects.`
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
