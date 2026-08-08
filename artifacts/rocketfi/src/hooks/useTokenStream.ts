/**
 * React hook that connects to the SSE trade stream for a specific token.
 * Returns live trades and latest token snapshot pushed by the server.
 *
 * Reliability strategy:
 *  1. On onerror: close the dead EventSource and schedule an explicit reconnect
 *     after 3 s (native auto-reconnect is unreliable through Replit's proxy).
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
const RECONNECT_DELAY  = 3_000;   // ms before attempting reconnect after error
const WATCHDOG_TICK    = 30_000;  // ms between watchdog checks
const WATCHDOG_SILENCE = 45_000;  // ms of silence before watchdog forces reconnect

export function useTokenStream(tokenAddress: string | null): UseTokenStreamResult {
  const [liveTrades, setLiveTrades] = useState<LiveTrade[]>([]);
  const [liveToken,  setLiveToken]  = useState<LiveTokenSnapshot | null>(null);
  const [connected,  setConnected]  = useState(false);

  // Refs so the watchdog / reconnect callback always sees the latest values
  // without being re-created on every render.
  const esRef              = useRef<EventSource | null>(null);
  const reconnectTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventMs        = useRef<number>(0);
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
    esRef.current    = es;
    lastEventMs.current = Date.now();

    es.onopen = () => {
      setConnected(true);
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
      // Reconnect after a short delay (only if address hasn't changed).
      reconnectTimer.current = setTimeout(() => {
        if (tokenAddressRef.current === address) {
          openStream(address);
        }
      }, RECONNECT_DELAY);
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

    // Fresh token selected — clear stale data and connect
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
