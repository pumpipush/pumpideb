/**
 * useFeedStream — connects to the global SSE feed at /api/feed/stream.
 *
 * Returns new token launches from ALL platforms in real time (pump_fun,
 * moonshot, letsbonk). Automatically reconnects via EventSource's built-in
 * retry. Capped at 100 tokens in memory to avoid memory growth.
 *
 * Usage:
 *   const { liveTokens, connected } = useFeedStream();
 */

import { useEffect, useRef, useState, useCallback } from "react";

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
  /** True for the first BADGE_TTL_MS after arrival — drives the "NEW" badge */
  isNew: boolean;
}

const MAX_LIVE_TOKENS = 100;
/** How long the "NEW" badge stays visible (ms) */
export const BADGE_TTL_MS = 12_000;

interface FeedEventNewToken {
  type: "newToken";
  token: Omit<FeedToken, "isNew">;
}

export interface UseFeedStreamResult {
  liveTokens: FeedToken[];
  connected: boolean;
}

export function useFeedStream(): UseFeedStreamResult {
  const [liveTokens, setLiveTokens] = useState<FeedToken[]>([]);
  const [connected, setConnected]   = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const timerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const cleanup = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    timerRefs.current.forEach((t) => clearTimeout(t));
    timerRefs.current.clear();
    setConnected(false);
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/feed/stream");
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data as string) as FeedEventNewToken;
        if (event.type !== "newToken") return;

        const token: FeedToken = { ...event.token, isNew: true };

        setLiveTokens((prev) => {
          // De-duplicate by address
          const filtered = prev.filter((t) => t.address !== token.address);
          return [token, ...filtered].slice(0, MAX_LIVE_TOKENS);
        });

        // Clear the "new" flag after TTL
        const timer = setTimeout(() => {
          setLiveTokens((prev) =>
            prev.map((t) => (t.address === token.address ? { ...t, isNew: false } : t))
          );
          timerRefs.current.delete(token.address);
        }, BADGE_TTL_MS);

        // Cancel any previous timer for the same address
        const existing = timerRefs.current.get(token.address);
        if (existing) clearTimeout(existing);
        timerRefs.current.set(token.address, timer);
      } catch {
        // ignore malformed frames
      }
    };

    es.onerror = () => setConnected(false);

    return cleanup;
  }, [cleanup]);

  return { liveTokens, connected };
}
