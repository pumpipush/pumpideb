/**
 * useSolBalance — poll the connected wallet's native SOL balance.
 *
 * Returns the balance in SOL (not lamports), or null when no wallet is
 * connected or the fetch hasn't resolved yet.  Refreshes every 15 s while
 * the tab is VISIBLE; polling is completely suspended when the tab is hidden
 * so we don't burn Alchemy Compute Units for users who have switched away.
 * Resumes immediately (with a catch-up fetch) when the tab becomes visible
 * again.  Exposes `refresh()` so callers can force a re-fetch after a trade.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { getReadConnection } from "@/lib/solanaConnection";

/** Polling interval while tab is visible. */
const POLL_INTERVAL_MS = 15_000;

export function useSolBalance(wallet: string | null): {
  solBalance: number | null;
  /**
   * True when the most recent RPC fetch failed (network error, rate-limit, etc.).
   * The previous solBalance is still shown so the user has a reference, but the
   * UI should indicate the value may be stale. Resets to false on next success.
   */
  isError: boolean;
  refresh: () => void;
} {
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [isError,    setIsError]    = useState(false);
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const walletRef  = useRef<string | null>(null);
  const fetchFnRef = useRef<((address: string) => Promise<void>) | null>(null);

  const fetchBalance = useCallback(async (address: string) => {
    try {
      const lamports = await getReadConnection().getBalance(new PublicKey(address), "confirmed");
      // Fix #6 — guard against stale responses: a fetch for wallet A can resolve
      // after the user has disconnected or switched to wallet B.
      if (walletRef.current !== address) return;
      setSolBalance(lamports / 1e9);
      setIsError(false);
    } catch {
      // Keep the previous balance visible; surface the error so the UI can
      // show a staleness indicator rather than silently displaying a stale value.
      if (walletRef.current === address) setIsError(true);
    }
  }, []);

  const refresh = useCallback(() => {
    if (wallet) fetchBalance(wallet);
  }, [wallet, fetchBalance]);

  useEffect(() => {
    walletRef.current  = wallet;
    fetchFnRef.current = fetchBalance;

    if (!wallet) {
      setSolBalance(null);
      setIsError(false);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }

    const startInterval = () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        if (walletRef.current) fetchFnRef.current?.(walletRef.current);
      }, POLL_INTERVAL_MS);
    };

    const stopInterval = () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };

    // Immediate fetch on mount / wallet change
    fetchBalance(wallet);

    // Only run the interval when the tab is visible — saves Alchemy CU for hidden tabs
    if (!document.hidden) {
      startInterval();
    }

    const handleVisibility = () => {
      if (document.hidden) {
        stopInterval();
      } else {
        // Catch-up fetch when user returns to the tab
        if (walletRef.current) fetchFnRef.current?.(walletRef.current);
        startInterval();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      stopInterval();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [wallet, fetchBalance]);

  return { solBalance, isError, refresh };
}
