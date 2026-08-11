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
 */
import { useEffect, useRef, useState, useCallback } from "react";

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
const WATCHDOG_TICK    = 30_000;   // ms between watchdog checks
const WATCHDOG_SILENCE = 45_000;   // ms of silence before watchdog forces reconnect
const RECONNECT_BASE   =  1_000;   // ms — first backoff interval
const RECONNECT_MAX    = 30_000;   // ms — ceiling for exponential backoff

/** Exponential backoff with ≤1 s random jitter to spread reconnect storms. */
function reconnectDelayMs(attempt: number): number {
  const base = Math.min(RECONNECT_BASE * Math.pow(2, attempt), RECONNECT_MAX);
  return base + Math.random() * 1_000;
}

export function useTokenStream(tokenAddress: string | null): UseTokenStreamResult {
  const [liveTrades, setLiveTrades] = useState<LiveTrade[]>([]);
  const [liveToken,  setLiveToken]  = useState<LiveTokenSnapshot | null>(null);
  const [connected,  setConnected]  = useState(false);

  // Refs so the watchdog / reconnect callback always sees the latest values
  // without being re-created on every render.
  const esRef              = useRef<EventSource | null>(null);
  const reconnectTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventMs        = useRef<number>(0);
  const reconnectAttempts  = useRef<number>(0);
  const tokenAddressRef    = useRef<string | null>(null);
  tokenAddressRef.current  = tokenAddress;

  // ── openStream ─────────────────────────────────────────────────────────────
  // Closes any existing connection and opens a fresh EventSource.
  // Stable reference (deps: empty) so useEffect / watchdog can call it safely.
  const openStream = useCallback((address: string) => {
    // Tear down previous connection + pending reconnect timer
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource(`/api/tokens/${address}/stream`);
    esRef.current       = es;
    lastEventMs.current = Date.now();

    es.onopen = () => {
      setConnected(true);
      reconnectAttempts.current = 0;
      lastEventMs.current = Date.now();
    };

    es.onmessage = (e: MessageEvent) => {
      lastEventMs.current = Date.now();
      try {
        const event: StreamEvent = JSON.parse(e.data);
        if (event.type === "trade") {
          setLiveTrades(prev => [event.trade, ...prev].slice(0, MAX_LIVE_TRADES));
          setLiveToken(event.token);
        } else if (event.type === "snapshot") {
          setLiveToken(event.token);
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.onerror = () => {
      // Close immediately — don't trust native auto-reconnect through proxies.
      setConnected(false);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      // Clear any existing pending reconnect before scheduling a new one —
      // multiple rapid onerror calls must not stack timers.
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      // Reconnect with backoff (only if address hasn't changed).
      const delay = reconnectDelayMs(reconnectAttempts.current);
      reconnectAttempts.current += 1;
      reconnectTimer.current = setTimeout(() => {
        if (tokenAddressRef.current === address) {
          openStream(address);
        }
      }, delay);
    };
  }, []); // stable — no deps

  // ── Main effect: open/close stream when address changes ────────────────────
  useEffect(() => {
    // Reset state and bail out when no token selected
    if (!tokenAddress) {
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      if (esRef.current)          { esRef.current.close(); esRef.current = null; }
      setLiveTrades([]);
      setLiveToken(null);
      setConnected(false);
      return;
    }

    // Fresh token selected — reset backoff, clear stale data, and connect
    reconnectAttempts.current = 0;
    setLiveTrades([]);
    setLiveToken(null);
    openStream(tokenAddress);

    // ── Watchdog ──────────────────────────────────────────────────────────────
    // Polls every WATCHDOG_TICK ms. If the last received event is older than
    // WATCHDOG_SILENCE, the connection is silently dead (proxy dropped it
    // without firing onerror). Force a fresh connection.
    const watchdog = setInterval(() => {
      if (
        tokenAddressRef.current === tokenAddress &&
        Date.now() - lastEventMs.current > WATCHDOG_SILENCE
      ) {
        setConnected(false);
        openStream(tokenAddress);
      }
    }, WATCHDOG_TICK);

    return () => {
      clearInterval(watchdog);
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      if (esRef.current)          { esRef.current.close(); esRef.current = null; }
      setConnected(false);
    };
  }, [tokenAddress, openStream]);

  return { liveTrades, liveToken, connected };
}
