/**
 * React hook: subscribe to PumpPortal trade stream for a specific mint.
 * Returns accumulated trades usable for building OHLCV candles.
 */
import { useEffect, useRef, useState } from "react";
import { subscribeTokenTrade, PumpTrade } from "@/lib/pumpportal";

export function usePumpPortalTrades(mint: string | null, maxTrades = 500): {
  trades: PumpTrade[];
  connected: boolean;
} {
  const [trades, setTrades] = useState<PumpTrade[]>([]);
  const [connected, setConnected] = useState(false);
  const unsub = useRef<(() => void) | null>(null);

  useEffect(() => {
    setTrades([]);
    setConnected(false);

    if (!mint) return;

    unsub.current = subscribeTokenTrade(mint, (trade) => {
      setConnected(true);
      setTrades((prev) => [trade, ...prev].slice(0, maxTrades));
    });

    return () => {
      unsub.current?.();
      unsub.current = null; // Bug fix: null ref after cleanup
    };
  }, [mint, maxTrades]);

  return { trades, connected };
}
