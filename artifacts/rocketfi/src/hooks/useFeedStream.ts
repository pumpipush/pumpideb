/**
 * useFeedStream — connects to the global SSE feed at /api/feed/stream.
 *
 * Receives two event types:
 *   newToken — new token launches from ALL platforms (pump_fun, moonshot, letsbonk, daos_fun, raydium_launchlab)
 *   trade    — every buy/sell swap indexed by the chain-native adapters
 *
 * Returns:
 *   liveTokens     — recent new launches (capped at 100), with isNew badge TTL
 *   liveTradeStats — latest per-token trade stats (price, mcap, volume, tradeCount)
 *                    updated in real time; used by Dashboard cards to show live data
 *   connected      — whether the SSE connection is open
 */

import { useEffect, useRef, useState, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FeedToken {
  address: string;
  name: string;
  symbol: string;
  imageUrl?: string | null;
  priceEth?: string | null;
  marketCapEth?: string | null;
  platform: string;
  chain: string;
  createdAt: string;
  /** Set when the token has graduated from a bonding curve (e.g. pump.fun → Raydium) */
  graduated?: boolean;
  /** True for the first BADGE_TTL_MS after arrival — drives the "NEW" badge */
  isNew: boolean;
}

/** Latest trade-derived stats for a token — overlaid on Dashboard cards */
export interface FeedTradeStats {
  priceEth:     string | null;
  marketCapEth: string | null;
  volumeEth:    string;
  tradeCount:   number;
  /** Unix ms timestamp of the last observed trade — drives the activity pulse */
  lastTradeAt:  number;
}

const MAX_LIVE_TOKENS = 100;
/** How long the "NEW" badge stays visible (ms) */
export const BADGE_TTL_MS = 12_000;

// ── Internal event shapes (from SSE) ──────────────────────────────────────────

interface FeedEventNewToken {
  type: "newToken";
  token: Omit<FeedToken, "isNew">;
}

interface FeedEventTrade {
  type: "trade";
  trade: {
    tokenAddress: string;
    txHash: string;
  };
  token: {
    address:              string;
    priceEth:             string | null;
    marketCapEth:         string | null;
    volumeEth:            string;
    tradeCount:           number;
  };
}

type FeedEvent = FeedEventNewToken | FeedEventTrade;

// ── Hook ───────────────────────────────────────────────────────────────────────

export interface UseFeedStreamResult {
  liveTokens:     FeedToken[];
  /** Map from token address → latest trade stats (price, mcap, volume, tradeCount) */
  liveTradeStats: Map<string, FeedTradeStats>;
  connected:      boolean;
}

const RECONNECT_DELAY_MS = 3_000;

export function useFeedStream(): UseFeedStreamResult {
  const [liveTokens,     setLiveTokens]     = useState<FeedToken[]>([]);
  const [liveTradeStats, setLiveTradeStats] = useState<Map<string, FeedTradeStats>>(new Map());
  const [connected,      setConnected]      = useState(false);
  const esRef           = useRef<EventSource | null>(null);
  const reconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRefs       = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedRef      = useRef(true);

  const openStream = useCallback(() => {
    // Tear down any existing connection + pending reconnect
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    if (esRef.current) { esRef.current.close(); esRef.current = null; }

    const es = new EventSource("/api/feed/stream");
    esRef.current = es;

    es.onopen = () => { if (mountedRef.current) setConnected(true); };

    es.onmessage = (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const event = JSON.parse(e.data as string) as FeedEvent;

        // ── New token launch ──────────────────────────────────────────────────
        if (event.type === "newToken") {
          const token: FeedToken = { ...event.token, isNew: true };

          setLiveTokens((prev) => {
            const filtered = prev.filter((t) => t.address !== token.address);
            return [token, ...filtered].slice(0, MAX_LIVE_TOKENS);
          });

          // Clear the "new" flag after TTL
          const existing = timerRefs.current.get(token.address);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            setLiveTokens((prev) =>
              prev.map((t) => (t.address === token.address ? { ...t, isNew: false } : t))
            );
            timerRefs.current.delete(token.address);
          }, BADGE_TTL_MS);
          timerRefs.current.set(token.address, timer);
        }

        // ── Trade (buy / sell) ────────────────────────────────────────────────
        if (event.type === "trade" && event.token?.address) {
          const { address, priceEth, marketCapEth, volumeEth, tradeCount } = event.token;
          setLiveTradeStats((prev) => {
            const next = new Map(prev);
            next.set(address, {
              priceEth:     priceEth ?? null,
              marketCapEth: marketCapEth ?? null,
              volumeEth:    volumeEth ?? "0",
              tradeCount:   tradeCount ?? 0,
              lastTradeAt:  Date.now(),
            });
            return next;
          });
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.onerror = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      // Close — don't rely on native auto-reconnect through the reverse proxy.
      es.close();
      esRef.current = null;
      // Guard against stacked timers from repeated onerror calls.
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) openStream();
      }, RECONNECT_DELAY_MS);
    };
  }, []); // stable — no external deps

  useEffect(() => {
    mountedRef.current = true;
    openStream();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      timerRefs.current.forEach((t) => clearTimeout(t));
      timerRefs.current.clear();
    };
  }, [openStream]);

  return { liveTokens, liveTradeStats, connected };
}
