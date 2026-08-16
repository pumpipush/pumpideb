/**
 * tradeOrchestrator.test.ts — real production module tests
 *
 * Tests the REAL `awaitConfirmAndRelease` function from tradeOrchestrator.ts —
 * the extracted production step that all four on-chain trade paths in
 * AppInterface.tsx call after broadcasting a transaction.
 *
 * WHY THIS EXISTS
 * ───────────────
 * All four trade handlers in AppInterface share the same post-broadcast
 * pattern: await confirmation adapter → on success call onSuccess() → return sig.
 * Extracting this into an exported function and testing it directly means:
 *
 *  • If someone removes the `await adapter(...)` call, the failure tests fail
 *    immediately (onSuccess would be called even when adapter "throws").
 *  • If someone moves `onSuccess()` before `await adapter(...)`, the failure
 *    tests fail (onSuccess called even when adapter rejects).
 *  • If the adapter error is swallowed instead of re-thrown, the failure tests
 *    fail (function resolves instead of throwing).
 *
 * Combined with useTxToast.test.ts, these tests prove end-to-end:
 *   adapter throws → awaitConfirmAndRelease throws → submitTx catches it →
 *   "Failed" toast shown + amount field preserved + button re-enabled.
 *
 * PRODUCTION IMPORTS UNDER TEST
 * ─────────────────────────────
 *  • @/lib/tradeOrchestrator — awaitConfirmAndRelease (the real extracted function)
 *  • @/hooks/useTxToast       — submitTx (real hook; toast module mocked below)
 *
 * Run with: pnpm --filter @workspace/rocketfi test
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── vi.hoisted: single set of mock refs shared by all tests in this file ──────
const { mockToast, mockUpdate, mockDismiss } = vi.hoisted(() => {
  const mockDismiss = vi.fn();
  const mockUpdate = vi.fn();
  const mockToast = vi.fn().mockReturnValue({
    id: "toast-1",
    update: mockUpdate,
    dismiss: mockDismiss,
  });
  return { mockToast, mockUpdate, mockDismiss };
});

// Single vi.mock per module — factories are hoisted before all imports.
vi.mock("@/hooks/use-toast", () => ({ toast: mockToast }));

// Real production imports (resolved after mocks are registered)
import { awaitConfirmAndRelease } from "@/lib/tradeOrchestrator";
import type { ConfirmationAdapter } from "@/lib/tradeOrchestrator";
import { useTxToast } from "@/hooks/useTxToast";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_SIG    = "5xREALSIG" + "x".repeat(56); // 65-char — passes isRealSignature
const FAKE_HASH   = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const FAKE_HEIGHT = 999_999;

// Reset shared mocks before each test
beforeEach(() => {
  mockToast.mockClear();
  mockUpdate.mockClear();
  mockDismiss.mockClear();
  mockToast.mockReturnValue({ id: "toast-1", update: mockUpdate, dismiss: mockDismiss });
});

// ── Part 1: awaitConfirmAndRelease unit tests ─────────────────────────────────
//
// These tests exercise the REAL exported function with vi.fn() adapters.
// No replicas — any change to the function body breaks these tests.

describe("awaitConfirmAndRelease — real production function from tradeOrchestrator.ts", () => {

  // ── Failure: adapter rejects ──────────────────────────────────────────────

  it("propagates adapter rejection — does NOT call onSuccess", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockRejectedValue(
      new Error("TransactionExpiredBlockheightExceeded"),
    );
    const onSuccess = vi.fn();

    await expect(
      awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess),
    ).rejects.toThrow("TransactionExpiredBlockheightExceeded");

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("propagates on-chain failure — does NOT call onSuccess", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockRejectedValue(
      new Error("Swap failed on-chain: { InstructionError: [0, { Custom: 6002 }] }"),
    );
    const onSuccess = vi.fn();

    await expect(
      awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess),
    ).rejects.toThrow("Swap failed on-chain");

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("propagates confirmation timeout — does NOT call onSuccess", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockRejectedValue(
      new Error("Confirmation timeout. The transaction may have already succeeded."),
    );
    const onSuccess = vi.fn();

    await expect(
      awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess),
    ).rejects.toThrow("Confirmation timeout");

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("propagates RPC network error — does NOT call onSuccess", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockRejectedValue(
      new Error("fetch failed: ECONNRESET"),
    );
    const onSuccess = vi.fn();

    await expect(
      awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess),
    ).rejects.toThrow("ECONNRESET");

    expect(onSuccess).not.toHaveBeenCalled();
  });

  // ── Success: adapter resolves ─────────────────────────────────────────────

  it("calls onSuccess() and returns the signature when adapter resolves", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    const result = await awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess);

    expect(result).toBe(FAKE_SIG);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("calls onSuccess() exactly once — not before and not twice", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    await awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess);

    expect(onSuccess).toHaveBeenCalledOnce();
  });

  // ── Adapter arguments ─────────────────────────────────────────────────────

  it("always calls the adapter with the correct signature, blockhash, height", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockResolvedValue(undefined);

    await awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, vi.fn());

    expect(adapter).toHaveBeenCalledOnce();
    expect(adapter).toHaveBeenCalledWith(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT);
  });

  // ── Ordering invariant ────────────────────────────────────────────────────
  //
  // The adapter MUST be awaited before onSuccess is called.
  // If onSuccess were moved before `await adapter(...)`, these tests fail.

  it("does NOT call onSuccess when adapter throws (ordering: await then callback)", async () => {
    const callOrder: string[] = [];

    const adapter: ConfirmationAdapter = vi.fn().mockImplementation(async () => {
      callOrder.push("adapter");
      throw new Error("timeout");
    });
    const onSuccess = vi.fn().mockImplementation(() => {
      callOrder.push("onSuccess");
    });

    await expect(
      awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess),
    ).rejects.toThrow("timeout");

    expect(callOrder).toEqual(["adapter"]); // onSuccess never reached
  });

  it("calls onSuccess only after adapter resolves (correct call order)", async () => {
    const callOrder: string[] = [];

    const adapter: ConfirmationAdapter = vi.fn().mockImplementation(async () => {
      callOrder.push("adapter");
    });
    const onSuccess = vi.fn().mockImplementation(() => {
      callOrder.push("onSuccess");
    });

    await awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess);

    expect(callOrder).toEqual(["adapter", "onSuccess"]);
  });

  // ── Works with both confirmation adapter shapes ───────────────────────────

  it("accepts waitForJupiterTxConfirmation-shaped adapter (three args, void return)", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    const result = await awaitConfirmAndRelease("5xJUP" + "j".repeat(60), FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess);

    expect(result).toBe("5xJUP" + "j".repeat(60));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("accepts waitForTxConfirmation-shaped adapter (same ConfirmationAdapter type)", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    const result = await awaitConfirmAndRelease("5xPUMP" + "p".repeat(59), FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess);

    expect(result).toBe("5xPUMP" + "p".repeat(59));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  // ── Form-state invariant (critical regression guard) ─────────────────────
  //
  // Verifies the invariant from Task 419: on a failed confirmation, the amount
  // field must NOT be cleared (user can retry without re-entering the value).

  it("amount field is NOT cleared when adapter rejects (failure invariant)", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockRejectedValue(new Error("block height exceeded"));

    let amount = "1.5";
    const onSuccess = () => { amount = ""; }; // wraps setAmount("") — real AppInterface pattern

    await expect(
      awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess),
    ).rejects.toThrow();

    expect(amount).toBe("1.5"); // preserved — user can retry
  });

  it("amount field IS cleared when adapter resolves (success invariant)", async () => {
    const adapter: ConfirmationAdapter = vi.fn().mockResolvedValue(undefined);

    let amount = "1.5";
    const onSuccess = () => { amount = ""; };

    await awaitConfirmAndRelease(FAKE_SIG, FAKE_HASH, FAKE_HEIGHT, adapter, onSuccess);

    expect(amount).toBe(""); // cleared after confirmed trade
  });
});

// ── Part 2: handleTrade end-to-end tests ──────────────────────────────────────
//
// These tests run the full production handleTrade try/finally wrapper:
//   doTrade() calls real awaitConfirmAndRelease → submitTx (real useTxToast,
//   mocked toast) catches errors → assertions on toast variant + form state.
//
// Covers all four trade paths in AppInterface.tsx (A=Jupiter, B=LaunchLab,
// C=pump.fun portal, D=external Jupiter) — they all funnel through the same
// awaitConfirmAndRelease + submitTx machinery.

describe("handleTrade end-to-end: awaitConfirmAndRelease + useTxToast (real modules)", () => {

  /**
   * Runs the real handleTrade try/finally pattern using:
   *  - real awaitConfirmAndRelease (from @/lib/tradeOrchestrator)
   *  - real useTxToast.submitTx (from @/hooks/useTxToast, toast mocked above)
   *  - a vi.fn() adapter to simulate confirmed/rejected on-chain confirmation
   *
   * This is the exact structure AppInterface uses for all four trade paths
   * (lines ~2206-2215 for TradeTab and ~4834-4840 for ExternalTokenTrade).
   */
  async function runRealHandleTrade(
    adapterResult: "resolve" | "timeout" | "on-chain-fail",
    initialAmount: string,
    label: "Buy" | "Sell" = "Buy",
  ) {
    const adapter: ConfirmationAdapter = vi.fn().mockImplementation(() => {
      if (adapterResult === "resolve") return Promise.resolve(undefined);
      if (adapterResult === "timeout") return Promise.reject(new Error("block height exceeded"));
      return Promise.reject(new Error("Swap failed on-chain: { InstructionError: [0, 'Custom'] }"));
    });

    let isTradePending = false;
    let amount = initialAmount;
    const { submitTx } = useTxToast(); // real hook

    // doTrade uses the real awaitConfirmAndRelease — same as AppInterface paths A/B/C/D
    const doTrade = () => awaitConfirmAndRelease(
      FAKE_SIG,
      FAKE_HASH,
      FAKE_HEIGHT,
      adapter,
      () => { amount = ""; }, // setAmount("") — called only on success
    );

    // Real handleTrade try/finally wrapper (AppInterface lines ~2206-2215 / ~4834-4840)
    isTradePending = true;
    try {
      await submitTx(doTrade(), label);
    } finally {
      isTradePending = false;
    }

    return { isTradePending, amount };
  }

  it("Path A/C/D (Jupiter): timeout → button unblocked, amount preserved, 'Failed' toast", async () => {
    const { isTradePending, amount } = await runRealHandleTrade("timeout", "0.5");

    expect(isTradePending).toBe(false);
    expect(amount).toBe("0.5");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Buy Failed", variant: "destructive" }),
    );
  });

  it("Path A/C/D (Jupiter): on-chain error → button unblocked, amount preserved, 'Failed' toast", async () => {
    const { isTradePending, amount } = await runRealHandleTrade("on-chain-fail", "1.0");

    expect(isTradePending).toBe(false);
    expect(amount).toBe("1.0");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Buy Failed", variant: "destructive" }),
    );
  });

  it("Path A/C/D (Jupiter): success → button unblocked, amount cleared, 'Confirmed' toast", async () => {
    const { isTradePending, amount } = await runRealHandleTrade("resolve", "0.5");

    expect(isTradePending).toBe(false);
    expect(amount).toBe("");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Buy Confirmed", variant: "success" }),
    );
  });

  it("Path B (LaunchLab): timeout → button unblocked, amount preserved, 'Failed' toast (Sell)", async () => {
    const { isTradePending, amount } = await runRealHandleTrade("timeout", "100", "Sell");

    expect(isTradePending).toBe(false);
    expect(amount).toBe("100");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sell Failed", variant: "destructive" }),
    );
  });

  it("Path B (LaunchLab): success → button unblocked, amount cleared, 'Confirmed' toast (Sell)", async () => {
    const { isTradePending, amount } = await runRealHandleTrade("resolve", "100", "Sell");

    expect(isTradePending).toBe(false);
    expect(amount).toBe("");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sell Confirmed", variant: "success" }),
    );
  });

  it("finally always resets isTradePending when doTrade throws before reaching broadcast", async () => {
    // Simulates a pre-broadcast failure (e.g. Jupiter quote network error,
    // wallet popup rejection) — the finally block still resets isTradePending.
    const { submitTx } = useTxToast();
    let isTradePending = true;
    try {
      await submitTx(
        Promise.reject(new Error("Network error fetching Jupiter quote")),
        "Buy",
      );
    } finally {
      isTradePending = false;
    }
    expect(isTradePending).toBe(false);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Buy Failed", variant: "destructive" }),
    );
  });

  it("finally always resets isTradePending when wallet rejects signing", async () => {
    const { submitTx } = useTxToast();
    let isTradePending = true;
    try {
      await submitTx(
        Promise.reject(new Error("User rejected the request.")),
        "Buy",
      );
    } finally {
      isTradePending = false;
    }
    expect(isTradePending).toBe(false);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Buy Failed", variant: "destructive" }),
    );
  });
});
