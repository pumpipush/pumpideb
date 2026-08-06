/**
 * React hook: subscribe to PumpPortal new token stream.
 * Maintains a rolling buffer of the latest N new tokens.
 */
import { useEffect, useRef, useState } from "react";
import { subscribeNewToken, PumpToken, resolveImage } from "@/lib/pumpportal";

export interface LiveToken extends PumpToken {
  imageResolved?: string;
  receivedAt: number;
}

export function usePumpPortalFeed(maxItems = 20): {
  tokens: LiveToken[];
  connected: boolean;
} {
  const [tokens, setTokens] = useState<LiveToken[]>([]);
  const [connected, setConnected] = useState(false);
  const unsub = useRef<(() => void) | null>(null);

  useEffect(() => {
    let live = true;

    // Small delay so WebSocket has time to connect
    const timer = setTimeout(() => {
      if (!live) return;

      unsub.current = subscribeNewToken((msg) => {
        const token = msg as PumpToken;
        if (!token.name || !token.symbol) return; // skip non-token messages

        setConnected(true);
        setTokens((prev) => {
          const next: LiveToken = {
            ...token,
            imageResolved: resolveImage(token.image_uri ?? token.uri),
            receivedAt: Date.now(),
          };
          return [next, ...prev].slice(0, maxItems);
        });
      });
    }, 500);

    return () => {
      live = false;
      clearTimeout(timer);
      unsub.current?.();
      unsub.current = null; // Bug fix: null ref so stale handles don't accumulate
      setConnected(false);  // Bug fix: reset connected state on unmount/cleanup
    };
  }, [maxItems]);

  return { tokens, connected };
}
