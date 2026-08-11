/**
 * useSolBalance — poll the connected wallet's native SOL balance.
 *
 * Returns the balance in SOL (not lamports), or null when no wallet is
 * connected or the fetch hasn't resolved yet.  Refreshes every 30 s and
 * whenever `wallet` changes.  Exposes `refresh()` so callers can force a
 * re-fetch right after a trade settles.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "@/lib/solanaConnection";

const POLL_INTERVAL_MS = 30_000;

export function useSolBalance(wallet: string | null): {
  solBalance: number | null;
  refresh: () => void;
} {
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetch = useCallback(async (address: string) => {
    try {
      const lamports = await getConnection().getBalance(new PublicKey(address), "confirmed");
      setSolBalance(lamports / 1e9);
    } catch {
      // silently ignore — balance stays at previous value
    }
  }, []);

  const refresh = useCallback(() => {
    if (wallet) fetch(wallet);
  }, [wallet, fetch]);

  useEffect(() => {
    if (!wallet) {
      setSolBalance(null);
      return;
    }

    // Immediate fetch on mount / wallet change
    fetch(wallet);

    // Periodic refresh
    timerRef.current = setInterval(() => fetch(wallet), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [wallet, fetch]);

  return { solBalance, refresh };
}
