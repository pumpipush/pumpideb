/**
 * React hook that connects to the SSE trade stream for a specific token.
 * Returns live trades and latest token snapshot pushed by the server.
 *
 * Reliability strategy:
 *  1. On onerror: close the dead EventSource and schedule an explicit reconnect
 *     with exponential backoff + jitter (1 s → 2 s → 4 s → … capped at 30 s).
 *     Native auto-reconnect is unreliable through Replit's reverse proxy.
 *  2. Watchdog timer: if no event (trade or snapshot) has arrived for 45 s,
 *     force a reconnect regardless of readyState — covers silent proxy drops
 *     that never fire onerror.
 *  3. Stale-callback guard: every EventSource callback checks stream identity
 *     (esRef === es) before acting, so a late error/open on a previous address
 *     can never close the current stream or flip connected state incorrectly.
 *     This logic lives in TokenStreamController; useTokenStream is a thin wrapper.
 */
import { useEffect, useRef, useState } from "react";
import { TokenStreamController } from "./TokenStreamController.js";

export interface LiveTrade {
  id: number;
  tokenAddress: string;
  traderAddress: string;
  isBuy: boolean;
  ethAmount: string;
  tokenAmount: string;
  priceEth: string | null;
  txHash: string;
  platform: string;
  timestamp: string;
}

export interface LiveTokenSnapshot {
  address:              string;
  name:                 string | null;
  symbol:               string | null;
  imageUrl:             string | null;
  priceEth:             string | null;
  marketCapEth:         string | null;
  volumeEth:            string;
  virtualEthReserves:   string;
  virtualTokenReserves: string;
  tradeCount:           number;
  platform?:            string;
  chain?:               string;
}

type StreamEvent =
  | { type: "trade";    trade: LiveTrade; token: LiveTokenSnapshot }
  | { type: "snapshot"; token: LiveTokenSnapshot };

interface UseTokenStreamResult {
  /** Newest trades received from the stream (newest first, max 200) */
  liveTrades: LiveTrade[];
  /** Latest token snapshot from the last trade event */
  liveToken: LiveTokenSnapshot | null;
  /** Whether the SSE connection is currently open */
  connected: boolean;
}

const MAX_LIVE_TRADES  = 200;
const WATCHDOG_TICK    = 10_000;   // ms between watchdog checks
const WATCHDOG_SILENCE = 20_000;   // ms of silence before watchdog forces reconnect

// How long to wait before showing the reconnecting chip after `connected` goes
// false.  Suppresses the brief flash that occurs on every initial mount while
// the first EventSource is still opening.
const DISCONNECT_GRACE_MS = 500;

export function useTokenStream(tokenAddress: string | null): UseTokenStreamResult {
  const [liveTrades, setLiveTrades] = useState<LiveTrade[]>([]);
  const [liveToken,  setLiveToken]  = useState<LiveTokenSnapshot | null>(null);

  // `displayConnected` is what callers see.  It starts optimistic (true) so
  // the chip never flickers on mount.  It only flips to false after
  // DISCONNECT_GRACE_MS of genuine disconnection.
  const [displayConnected, setDisplayConnected] = useState(true);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastEventMs = useRef<number>(0);

  /** Cancel any pending grace timer and immediately show connected. */
  const handleConnected = () => {
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    setDisplayConnected(true);
  };

  /** Start grace timer; only flip to disconnected if it fires un-interrupted. */
  const handleDisconnected = () => {
    if (disconnectTimerRef.current) return; // already counting
    disconnectTimerRef.current = setTimeout(() => {
      disconnectTimerRef.current = null;
      setDisplayConnected(false);
    }, DISCONNECT_GRACE_MS);
  };

  // Create the controller once. State setters are stable across renders
  // (React guarantees this), so we don't need to recreate the controller.
  const ctrlRef = useRef<TokenStreamController | null>(null);
  if (!ctrlRef.current) {
    ctrlRef.current = new TokenStreamController({
      onConnected:    handleConnected,
      onDisconnected: handleDisconnected,
      onLastEvent:    (ms) => { lastEventMs.current = ms; },
      onMessage: (data) => {
        try {
          const event: StreamEvent = JSON.parse(data);
          if (event.type === "trade") {
            setLiveTrades(prev => [event.trade, ...prev].slice(0, MAX_LIVE_TRADES));
            setLiveToken(event.token);
          } else if (event.type === "snapshot") {
            setLiveToken(event.token);
          }
        } catch {
          // ignore malformed frames
        }
      },
    });
  }

  useEffect(() => {
    const ctrl = ctrlRef.current!;

    if (!tokenAddress) {
      ctrl.setAddress(null);
      setLiveTrades([]);
      setLiveToken(null);
      // No token → reset grace state so next mount starts fresh.
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      setDisplayConnected(true);
      return;
    }

    // Fresh token selected — reset stale data and restart the grace window,
    // then open the stream.
    setLiveTrades([]);
    setLiveToken(null);
    lastEventMs.current = Date.now();
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    setDisplayConnected(true);
    ctrl.setAddress(tokenAddress);

    // ── Watchdog ──────────────────────────────────────────────────────────────
    // Polls every WATCHDOG_TICK ms. If the last received event is older than
    // WATCHDOG_SILENCE, the connection is silently dead (proxy dropped it
    // without firing onerror). Force a fresh connection.
    const watchdog = setInterval(() => {
      ctrl.watchdogTick(tokenAddress, lastEventMs.current, WATCHDOG_SILENCE);
    }, WATCHDOG_TICK);

    return () => {
      clearInterval(watchdog);
      ctrl.teardown();
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
    };
  }, [tokenAddress]);

  return { liveTrades, liveToken, connected: displayConnected };
}
