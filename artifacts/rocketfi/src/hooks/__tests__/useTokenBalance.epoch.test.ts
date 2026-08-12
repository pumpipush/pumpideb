/**
 * useTokenBalance — epoch-guard race-condition tests
 *
 * These tests exercise the epoch-counter logic that prevents stale RPC
 * responses from updating balance state after the user has switched tokens.
 * They also verify the `isLoading` flag is set correctly so UI consumers
 * (sell preset buttons) can be disabled while a stale atomicBalance is held.
 *
 * The hook itself relies on React state; testing it directly would require
 * jsdom + renderHook.  Instead, the tests simulate the epoch-guard pattern
 * as a pure state machine — the same invariants the hook enforces — so they
 * run in the existing node/vitest environment without additional dependencies.
 *
 * Invariants under test:
 *  1. A stale RPC response (old epoch) cannot overwrite atomicBalance.
 *  2. The faster new-mint response wins when both are in flight simultaneously.
 *  3. isLoading becomes true on the first fetch for a new mint and is cleared
 *     once the response for the current epoch settles.
 *  4. A stale response for the old epoch does NOT clear isLoading for the
 *     current epoch (preset buttons stay disabled until the right fetch lands).
 *  5. When wallet/mint is cleared, both balances and isLoading reset to null/false.
 */

import { describe, it, expect, vi } from "vitest";

// ── Epoch-guard state machine (mirrors useTokenBalance internals) ──────────────

interface BalanceState {
  atomicBalance: string | null;
  tokenBalance:  number | null;
  isLoading:     boolean;
}

type FetchFn = (mint: string) => Promise<{ atomic: string; display: number }>;

/**
 * Minimal replica of the epoch-guard logic inside useTokenBalance.
 * Allows tests to inject an async `fetchFn` and observe state transitions.
 */
class EpochGuardedFetcher {
  private epochRef = 0;
  state: BalanceState = { atomicBalance: null, tokenBalance: null, isLoading: false };

  /** Switch to a new mint (or null to clear). Returns the fetch promise (or void). */
  switchMint(mint: string | null, fetchFn: FetchFn): Promise<void> | void {
    this.epochRef += 1;

    if (!mint) {
      this.state = { atomicBalance: null, tokenBalance: null, isLoading: false };
      return;
    }

    const epoch = this.epochRef;
    // Mark loading; intentionally retain previous atomicBalance so preset
    // buttons can be disabled (via isLoading) without flashing "–".
    this.state = { ...this.state, isLoading: true };

    return fetchFn(mint).then(({ atomic, display }) => {
      // Drop stale responses — epoch must match the current selection.
      if (epoch !== this.epochRef) return;
      this.state = { atomicBalance: atomic, tokenBalance: display, isLoading: false };
    }).catch(() => {
      if (epoch !== this.epochRef) return;
      this.state = { ...this.state, isLoading: false };
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useTokenBalance — epoch guard prevents stale balance from being used in presets", () => {

  // 1. Stale slow response cannot overwrite the newer mint's atomicBalance ------

  it("stale slow RPC response for old mint does NOT overwrite atomicBalance", async () => {
    vi.useFakeTimers();
    const fetcher = new EpochGuardedFetcher();

    // First mint fetches slowly (200 ms).
    const slowFetch: FetchFn = async () => {
      await delay(200);
      return { atomic: "1000000", display: 1 };
    };
    // Second mint fetches quickly (10 ms).
    const fastFetch: FetchFn = async () => {
      await delay(10);
      return { atomic: "500000", display: 0.5 };
    };

    // Switch to MINT_A (slow)
    const p1 = fetcher.switchMint("MINT_A", slowFetch);
    // Immediately switch to MINT_B (fast) — advances epoch
    const p2 = fetcher.switchMint("MINT_B", fastFetch);

    // Advance past the fast fetch (10 ms) but not the slow one (200 ms)
    await vi.advanceTimersByTimeAsync(50);

    // MINT_B's fetch has resolved — MINT_A's is still pending
    expect(fetcher.state.atomicBalance).toBe("500000");
    expect(fetcher.state.isLoading).toBe(false);

    // Let MINT_A's stale response arrive — should be discarded
    await vi.advanceTimersByTimeAsync(200);
    await Promise.allSettled([p1, p2]);

    expect(fetcher.state.atomicBalance).toBe("500000"); // still MINT_B
    expect(fetcher.state.isLoading).toBe(false);

    vi.useRealTimers();
  });

  // 2. isLoading=true while new-mint fetch is in flight ─────────────────────

  it("isLoading is true from the moment of switch until the new fetch settles", async () => {
    vi.useFakeTimers();
    const fetcher = new EpochGuardedFetcher();

    // Seed with MINT_A balance
    const instantFetch: FetchFn = () => Promise.resolve({ atomic: "999", display: 0.999 });
    await fetcher.switchMint("MINT_A", instantFetch);
    expect(fetcher.state.isLoading).toBe(false);
    expect(fetcher.state.atomicBalance).toBe("999");

    // Switch to MINT_B — slow fetch
    const slowFetch: FetchFn = async () => {
      await delay(150);
      return { atomic: "42", display: 0.042 };
    };
    const p = fetcher.switchMint("MINT_B", slowFetch);

    // Immediately after switch: loading=true, atomicBalance is MINT_A's stale value
    expect(fetcher.state.isLoading).toBe(true);
    expect(fetcher.state.atomicBalance).toBe("999"); // stale, but presets are disabled

    await vi.advanceTimersByTimeAsync(200);
    await p;

    // After fetch resolves: correct values, loading=false
    expect(fetcher.state.isLoading).toBe(false);
    expect(fetcher.state.atomicBalance).toBe("42");

    vi.useRealTimers();
  });

  // 3. Stale response does NOT clear isLoading for the active epoch ─────────

  it("stale response for old mint does NOT clear isLoading while new fetch is pending", async () => {
    vi.useFakeTimers();
    const fetcher = new EpochGuardedFetcher();

    // MINT_A slow (200 ms), MINT_B very slow (500 ms)
    const mintAFetch: FetchFn = async () => { await delay(200); return { atomic: "111", display: 0.111 }; };
    const mintBFetch: FetchFn = async () => { await delay(500); return { atomic: "222", display: 0.222 }; };

    const pA = fetcher.switchMint("MINT_A", mintAFetch);
    const pB = fetcher.switchMint("MINT_B", mintBFetch);

    // At 250 ms: MINT_A's response has arrived (stale), MINT_B still loading
    await vi.advanceTimersByTimeAsync(250);

    expect(fetcher.state.isLoading).toBe(true);   // MINT_B still loading — NOT cleared by stale A
    expect(fetcher.state.atomicBalance).not.toBe("111"); // MINT_A's value not written

    // Advance past MINT_B
    await vi.advanceTimersByTimeAsync(300);
    await Promise.allSettled([pA, pB]);

    expect(fetcher.state.isLoading).toBe(false);
    expect(fetcher.state.atomicBalance).toBe("222");

    vi.useRealTimers();
  });

  // 4. Clearing wallet/mint resets everything ─────────────────────────────────

  it("clearing the mint resets atomicBalance and isLoading to null/false immediately", () => {
    const fetcher = new EpochGuardedFetcher();
    // Manually set some state to simulate a loaded token
    fetcher.state = { atomicBalance: "999999", tokenBalance: 0.999, isLoading: false };

    fetcher.switchMint(null, () => Promise.resolve({ atomic: "", display: 0 }));

    expect(fetcher.state.atomicBalance).toBeNull();
    expect(fetcher.state.tokenBalance).toBeNull();
    expect(fetcher.state.isLoading).toBe(false);
  });

  // 5. Rapid three-way switch: only the last mint's balance is written ─────────

  it("rapid A→B→C switch: only MINT_C balance is ever written", async () => {
    vi.useFakeTimers();
    const fetcher = new EpochGuardedFetcher();

    const makeFetch = (atomic: string, ms: number): FetchFn =>
      async () => { await delay(ms); return { atomic, display: 0 }; };

    const pA = fetcher.switchMint("MINT_A", makeFetch("AAA", 300));
    const pB = fetcher.switchMint("MINT_B", makeFetch("BBB", 200));
    const pC = fetcher.switchMint("MINT_C", makeFetch("CCC",  50));

    await vi.advanceTimersByTimeAsync(400);
    await Promise.allSettled([pA, pB, pC]);

    expect(fetcher.state.atomicBalance).toBe("CCC");
    expect(fetcher.state.isLoading).toBe(false);

    vi.useRealTimers();
  });
});
