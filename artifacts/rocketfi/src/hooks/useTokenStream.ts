/**
 * React hook that connects to the SSE trade stream for a specific token.
 * Returns live trades and latest token snapshot pushed by the server.
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

const MAX_LIVE_TRADES = 200;

export function useTokenStream(tokenAddress: string | null): UseTokenStreamResult {
  const [liveTrades, setLiveTrades] = useState<LiveTrade[]>([]);
  const [liveToken, setLiveToken] = useState<LiveTokenSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const cleanup = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setConnected(false);
  }, []);

  useEffect(() => {
    cleanup();
    setLiveTrades([]);
    setLiveToken(null);

    if (!tokenAddress) return;

    const url = `/api/tokens/${tokenAddress}/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (e: MessageEvent) => {
      try {
        const event: StreamEvent = JSON.parse(e.data);
        if (event.type === "trade") {
          setLiveTrades((prev) => [event.trade, ...prev].slice(0, MAX_LIVE_TRADES));
          setLiveToken(event.token);
        } else if (event.type === "snapshot") {
          // Initial snapshot on connect, or enrichment update (name/symbol/image changed)
          setLiveToken(event.token);
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; just mark disconnected until it recovers
      setConnected(false);
    };

    return cleanup;
  }, [tokenAddress, cleanup]);

  return { liveTrades, liveToken, connected };
}
