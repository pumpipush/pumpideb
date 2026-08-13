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
 *
 * Reliability strategy:
 *  1. On onerror: close the dead EventSource and schedule an explicit reconnect
 *     with exponential backoff + jitter (1 s → 2 s → 4 s → … capped at 30 s).
 *     Native auto-reconnect is unreliable through Replit's reverse proxy.
 *  2. Watchdog timer: if no event (trade, newToken, or SSE comment) has arrived
 *     for 45 s, force a reconnect regardless of readyState — covers silent proxy
 *     drops that never fire onerror.  connected is set to false during the gap
 *     so the UI can show a "reconnecting…" indicator.
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

// ── Reconnect / watchdog constants ────────────────────────────────────────────
const WATCHDOG_TICK      = 10_000;   // ms between watchdog checks
const WATCHDOG_SILENCE   = 20_000;   // ms of silence before watchdog forces reconnect
const RECONNECT_BASE     =  1_000;   // ms — first backoff interval
const RECONNECT_MAX      = 10_000;   // ms — ceiling for exponential backoff
/** Delay before the reconnecting chip appears — suppresses the mount-flash */
const DISCONNECT_GRACE_MS = 500;

/** Exponential backoff with ≤1 s random jitter to spread reconnect storms. */
function reconnectDelayMs(attempt: number): number {
  const base = Math.min(RECONNECT_BASE * Math.pow(2, attempt), RECONNECT_MAX);
  return base + Math.random() * 1_000;
}

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

export function useFeedStream(): UseFeedStreamResult {
  const [liveTokens,     setLiveTokens]     = useState<FeedToken[]>([]);
  const [liveTradeStats, setLiveTradeStats] = useState<Map<string, FeedTradeStats>>(new Map());

  // `displayConnected` starts optimistic (true) so the chip never flickers on
  // initial mount while the first EventSource is still opening.
  // It only flips to false after DISCONNECT_GRACE_MS of genuine disconnection.
  const [displayConnected, setDisplayConnected] = useState(true);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const esRef             = useRef<EventSource | null>(null);
  const reconnectTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRefs         = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedRef        = useRef(true);
  const lastEventMs       = useRef<number>(0);
  const reconnectAttempts = useRef<number>(0);

  /** Cancel any pending grace timer and immediately show connected. */
  const showConnected = useCallback(() => {
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    setDisplayConnected(true);
  }, []);

  /** Start grace timer; only flip to disconnected if it fires un-interrupted. */
  const showDisconnectedAfterGrace = useCallback(() => {
    if (disconnectTimerRef.current) return; // already counting
    disconnectTimerRef.current = setTimeout(() => {
      disconnectTimerRef.current = null;
      setDisplayConnected(false);
    }, DISCONNECT_GRACE_MS);
  }, []);

  const openStream = useCallback(() => {
    // Tear down any existing connection + pending reconnect
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    if (esRef.current) { esRef.current.close(); esRef.current = null; }

    const es = new EventSource("/api/feed/stream");
    esRef.current = es;
    lastEventMs.current = Date.now();

    es.onopen = () => {
      if (!mountedRef.current) return;
      showConnected();
      reconnectAttempts.current = 0;
      lastEventMs.current = Date.now();
    };

    es.onmessage = (e: MessageEvent) => {
      if (!mountedRef.current || es !== esRef.current) return; // discard events from stale sources
      lastEventMs.current = Date.now();
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
      if (!mountedRef.current || es !== esRef.current) return; // ignore errors from replaced sources
      showDisconnectedAfterGrace();
      // Close — don't rely on native auto-reconnect through the reverse proxy.
      es.close();
      esRef.current = null;
      // Guard against stacked timers from repeated onerror calls.
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const delay = reconnectDelayMs(reconnectAttempts.current);
      reconnectAttempts.current += 1;
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) openStream();
      }, delay);
    };
  }, [showConnected, showDisconnectedAfterGrace]); // stable callbacks from useCallback

  useEffect(() => {
    mountedRef.current = true;
    openStream();

    // ── Watchdog ──────────────────────────────────────────────────────────────
    // Polls every WATCHDOG_TICK ms. If the last received event is older than
    // WATCHDOG_SILENCE, the connection is silently dead (proxy held it open
    // without sending data and never fired onerror). Force a fresh connection.
    const watchdog = setInterval(() => {
      if (mountedRef.current && Date.now() - lastEventMs.current > WATCHDOG_SILENCE) {
        showDisconnectedAfterGrace();
        openStream();
      }
    }, WATCHDOG_TICK);

    return () => {
      mountedRef.current = false;
      clearInterval(watchdog);
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      timerRefs.current.forEach((t) => clearTimeout(t));
      timerRefs.current.clear();
      if (disconnectTimerRef.current) { clearTimeout(disconnectTimerRef.current); disconnectTimerRef.current = null; }
    };
  }, [openStream, showDisconnectedAfterGrace]);

  return { liveTokens, liveTradeStats, connected: displayConnected };
}
