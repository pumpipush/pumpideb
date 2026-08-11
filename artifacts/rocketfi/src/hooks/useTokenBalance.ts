/**
 * useTokenBalance — poll the connected wallet's SPL token balance for a given mint.
 *
 * Returns:
 *  - tokenBalance (number | null)   — display amount (float from uiAmountString), for UI only
 *  - atomicBalance (string | null)  — exact raw atomic amount string (tokenAmount.amount),
 *                                     suitable for BigInt conversion in sell-preset arithmetic
 *  - refresh()                       — force a re-fetch after a trade settles
 *
 * Precision notes:
 *  - uiAmountString is preferred over uiAmount (JSON float64) for the display value
 *    to avoid rounding errors on large balances with many decimal places.
 *  - atomicBalance preserves the full integer amount so callers can do exact
 *    percentage arithmetic without any floating-point representation risk.
 *
 * Stale-response safety (two-level guard):
 *  1. Epoch counter: incremented on every wallet/mint change (including clears).
 *     RPC callbacks only update state when their epoch matches epochRef.current.
 *  2. Pinned-refresh ref (refreshWithEpochRef): refresh() delegates to a closure
 *     capturing the active wallet+mint+epoch at setup time, not epochRef.current
 *     at invocation time. On effect cleanup it is replaced with a no-op, so a
 *     settled trade calling refresh() after the user has navigated to a different
 *     token will trigger a fetch for the NEW token, and the epoch check still
 *     ensures stale responses for the old token cannot update state.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "@/lib/solanaConnection";

const POLL_INTERVAL_MS = 30_000;

export interface TokenBalanceResult {
  /** Balance in display units (float); for UI display only. */
  tokenBalance:  number | null;
  /**
   * Raw atomic balance as a decimal integer string (tokenAmount.amount from RPC).
   * Convert with BigInt(atomicBalance) for exact percentage arithmetic.
   * null while loading or when the wallet/mint is not set.
   */
  atomicBalance: string | null;
  refresh: () => void;
}

export function useTokenBalance(
  wallet:      string | null,
  mintAddress: string | null,
): TokenBalanceResult {
  const [tokenBalance,  setTokenBalance]  = useState<number | null>(null);
  const [atomicBalance, setAtomicBalance] = useState<string | null>(null);

  const timerRef            = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Monotonically-incrementing epoch — incremented on any wallet/mint change, including clears. */
  const epochRef            = useRef(0);
  /**
   * Pinned to the active wallet+mint+epoch. No-op when that selection is cleared.
   * Allows trade `finally` blocks to refresh the CURRENT token, not a stale one.
   */
  const refreshWithEpochRef = useRef<() => void>(() => {});

  const fetchBalance = useCallback(async (
    walletAddr: string,
    mint:       string,
    epoch:      number,
  ) => {
    try {
      const conn     = getConnection();
      const mintPk   = new PublicKey(mint);
      const walletPk = new PublicKey(walletAddr);

      const { value: accounts } = await conn.getParsedTokenAccountsByOwner(
        walletPk,
        { mint: mintPk },
        "confirmed",
      );

      // Drop response if a newer wallet/mint combination was established while awaiting
      if (epoch !== epochRef.current) return;

      if (accounts.length === 0) {
        setTokenBalance(0);
        setAtomicBalance("0");
        return;
      }

      // Sum all token accounts for this mint (virtually always exactly one).
      // • uiAmountString: authoritative decimal string — no float precision loss
      // • amount: exact integer atom count — used for BigInt preset arithmetic
      let totalDisplay = 0;
      let totalAtomic  = 0n;

      for (const { account } of accounts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ta = (account.data as any)?.parsed?.info?.tokenAmount;
        const uiStr:    string | undefined = ta?.uiAmountString;
        const uiNum:    number | undefined = ta?.uiAmount;
        const atomicStr: string | undefined = ta?.amount;

        totalDisplay += uiStr != null ? parseFloat(uiStr) : (uiNum ?? 0);
        if (atomicStr) {
          try { totalAtomic += BigInt(atomicStr); } catch { /* ignore */ }
        }
      }

      setTokenBalance(totalDisplay);
      setAtomicBalance(totalAtomic.toString());
    } catch {
      // Silently ignore RPC errors — state stays at previous value (null on first fetch)
    }
  }, []);

  const refresh = useCallback(() => {
    refreshWithEpochRef.current();
  }, []);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);

    // Always advance epoch, even on clear, so any in-flight request is invalidated
    epochRef.current += 1;

    if (!wallet || !mintAddress) {
      setTokenBalance(null);
      setAtomicBalance(null);
      refreshWithEpochRef.current = () => {};
      return;
    }

    const epoch      = epochRef.current;
    const snapWallet = wallet;
    const snapMint   = mintAddress;

    // Pin the refresh function to this exact wallet+mint+epoch
    refreshWithEpochRef.current = () => fetchBalance(snapWallet, snapMint, epoch);

    // Show null (loading) immediately while the first fetch is in flight
    setTokenBalance(null);
    setAtomicBalance(null);
    fetchBalance(snapWallet, snapMint, epoch);

    timerRef.current = setInterval(
      () => fetchBalance(snapWallet, snapMint, epoch),
      POLL_INTERVAL_MS,
    );

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      refreshWithEpochRef.current = () => {};
    };
  }, [wallet, mintAddress, fetchBalance]);

  return { tokenBalance, atomicBalance, refresh };
}
