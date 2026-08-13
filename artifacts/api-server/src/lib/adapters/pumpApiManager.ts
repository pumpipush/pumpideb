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
import { logger as rootLogger } from "../logger.js";

const managerLog = rootLogger.child({ component: "PumpStreamManager" });

/** Seconds to wait after pumpapi.io disconnect before activating chain fallback. */
const FALLBACK_DELAY_MS = 30_000;

/** Shorter delay on the initial cold-start (pumpapi.io hasn't connected yet). */
const COLD_START_DELAY_MS = 15_000;

class PumpStreamManager {
  private readonly _pumpApi: PumpApiAdapter;
  private _chainFallback: {
    pumpFun:  PumpFunChainIndexer;
    pumpSwap: PumpSwapIndexer;
  } | null = null;
  private _fallbackTimer:  ReturnType<typeof setTimeout> | null = null;
  private _everConnected = false;

  constructor() {
    this._pumpApi = new PumpApiAdapter({
      onConnected:    () => this._onConnected(),
      onDisconnected: () => this._onDisconnected(),
    });
  }

  start(): void {
    this._pumpApi.start();
    // Schedule a cold-start fallback: if pumpapi.io hasn't connected within
    // COLD_START_DELAY_MS, activate the chain RPC adapters immediately.
    this._scheduleFallback(COLD_START_DELAY_MS);
  }

  // ── Connection callbacks ────────────────────────────────────────────────────

  private _onConnected(): void {
    this._everConnected = true;
    managerLog.info("pumpApiManager: pumpapi.io connected — cancelling chain fallback");

    // Cancel any pending fallback timer.
    if (this._fallbackTimer !== null) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }

    // Stop chain fallback if it started during a downtime window.
    if (this._chainFallback !== null) {
      managerLog.info("pumpApiManager: stopping chain fallback adapters");
      this._chainFallback.pumpFun.stop();
      this._chainFallback.pumpSwap.stop();
      this._chainFallback = null;
    }
  }

  private _onDisconnected(): void {
    this._scheduleFallback(FALLBACK_DELAY_MS);
  }

  // ── Fallback scheduling ─────────────────────────────────────────────────────

  private _scheduleFallback(delay: number): void {
    if (this._fallbackTimer !== null) return; // already scheduled
    managerLog.warn(
      { delayMs: delay, coldStart: !this._everConnected },
      "pumpApiManager: scheduling chain fallback"
    );
    this._fallbackTimer = setTimeout(() => {
      this._fallbackTimer = null;
      if (this._chainFallback !== null) return; // already running
      managerLog.warn("pumpApiManager: activating chain RPC fallback adapters");
      const pumpFun  = new PumpFunChainIndexer();
      const pumpSwap = new PumpSwapIndexer();
      pumpFun.start();
      pumpSwap.start();
      this._chainFallback = { pumpFun, pumpSwap };
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
