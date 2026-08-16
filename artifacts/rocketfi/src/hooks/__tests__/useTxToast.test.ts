/**
 * useTxToast — integration tests
 *
 * Tests the REAL useTxToast hook (imported from production source) with the
 * `@/hooks/use-toast` module mocked so toast calls are observable without a DOM.
 *
 * What this catches
 * ─────────────────
 * • submitTx returning null on failure (not a stale sig)
 * • toast.update being called with "Confirmed ✓" title on success
 * • toast.update being called with "Failed" + variant:"destructive" on failure
 * • err.data.message being preferred over err.message (wallet provider error shape)
 * • err.data.logs being used when message is absent
 * • friendlyTxError mappings for 0x1772/0x1771/0x1770/block-height inside the hook
 *
 * Run with: pnpm --filter @workspace/rocketfi test
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── vi.hoisted: define mock refs before vi.mock hoisting ─────────────────────
// vi.mock factories run in a hoisted scope; any variables they reference must
// also be hoisted. vi.hoisted() guarantees these run before the vi.mock calls.
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

// Mock the real use-toast module so toast() calls are captured
vi.mock("@/hooks/use-toast", () => ({
  toast: mockToast,
}));

// Import the REAL production hook — it will receive the mocked toast()
import { useTxToast } from "@/hooks/useTxToast";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A realistic 65-char base58 Solana signature */
const REAL_SIG = "5xABC" + "a".repeat(60);

/** Drain the update spy and return all title strings it was called with */
function updateTitles(): string[] {
  return mockUpdate.mock.calls.map((c) => (c[0] as { title?: string }).title ?? "");
}

function lastUpdateTitle(): string {
  return updateTitles().at(-1) ?? "";
}

function lastUpdateVariant(): string | undefined {
  const last = mockUpdate.mock.calls.at(-1)?.[0] as { variant?: string } | undefined;
  return last?.variant;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useTxToast (real hook, mocked toast)", () => {
  beforeEach(() => {
    mockToast.mockClear();
    mockUpdate.mockClear();
    mockDismiss.mockClear();
    // Reset the return value in case a test overwrites it
    mockToast.mockReturnValue({ id: "toast-1", update: mockUpdate, dismiss: mockDismiss });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("shows 'Pending…' immediately when called, then 'Confirmed' on success", async () => {
    const { submitTx } = useTxToast();

    await submitTx(Promise.resolve(REAL_SIG), "Buy");

    // toast() must have been called first with Pending title
    expect(mockToast).toHaveBeenCalledOnce();
    expect(mockToast.mock.calls[0][0]).toMatchObject({ title: "Buy Pending…" });

    // update() must have been called with Confirmed title and success variant
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(lastUpdateTitle()).toBe("Buy Confirmed");
    expect(lastUpdateVariant()).toBe("success"); // green accent — NOT destructive
  });

  it("returns the signature string on success", async () => {
    const { submitTx } = useTxToast();
    const result = await submitTx(Promise.resolve(REAL_SIG), "Sell");
    expect(result).toBe(REAL_SIG);
  });

  it("shows 'Order Filled' (not Confirmed) for sim_* non-real signatures", async () => {
    const { submitTx } = useTxToast();
    await submitTx(Promise.resolve("sim_abc123"), "Buy");

    expect(lastUpdateTitle()).toBe("Buy Order Filled");
    expect(lastUpdateVariant()).toBe("success"); // also gets green accent
  });

  // ── Failure path ───────────────────────────────────────────────────────────

  it("shows 'Failed' with destructive variant when promise rejects", async () => {
    const { submitTx } = useTxToast();
    const result = await submitTx(Promise.reject(new Error("Swap failed on-chain")), "Buy");

    expect(result).toBeNull();
    expect(lastUpdateTitle()).toBe("Buy Failed");
    expect(lastUpdateVariant()).toBe("destructive");
  });

  it("still shows 'Pending…' first even when the trade will fail", async () => {
    const { submitTx } = useTxToast();
    await submitTx(Promise.reject(new Error("rpc error")), "Sell");

    expect(mockToast).toHaveBeenCalledOnce();
    expect(mockToast.mock.calls[0][0]).toMatchObject({ title: "Sell Pending…" });
  });

  it("defaults label to 'Trade' when none is supplied", async () => {
    const { submitTx } = useTxToast();
    await submitTx(Promise.reject(new Error("oops")), undefined);

    expect(mockToast.mock.calls[0][0]).toMatchObject({ title: "Trade Pending…" });
    expect(lastUpdateTitle()).toBe("Trade Failed");
  });

  // ── Error message extraction ────────────────────────────────────────────────

  it("maps 'block height exceeded' to a readable timeout message", async () => {
    const { submitTx } = useTxToast();
    await submitTx(Promise.reject(new Error("block height exceeded")), "Buy");

    const desc = (mockUpdate.mock.calls.at(-1)?.[0] as { description?: string })?.description ?? "";
    expect(String(desc)).toMatch(/timed out/i);
  });

  it("maps 0x1772 (SlippageExceeded) to a readable slippage message", async () => {
    const { submitTx } = useTxToast();
    await submitTx(Promise.reject(new Error("custom program error: 0x1772")), "Buy");

    const desc = (mockUpdate.mock.calls.at(-1)?.[0] as { description?: string })?.description ?? "";
    expect(String(desc)).toMatch(/slippage/i);
  });

  it("maps 0x1771 (NotEnoughSOL) to a readable balance message", async () => {
    const { submitTx } = useTxToast();
    await submitTx(Promise.reject(new Error("custom program error: 0x1771")), "Buy");

    const desc = (mockUpdate.mock.calls.at(-1)?.[0] as { description?: string })?.description ?? "";
    expect(String(desc)).toMatch(/not enough sol/i);
  });

  it("maps 0x1770 (NotEnoughTokens) to a readable token message", async () => {
    const { submitTx } = useTxToast();
    await submitTx(Promise.reject(new Error("custom program error: 0x1770")), "Sell");

    const desc = (mockUpdate.mock.calls.at(-1)?.[0] as { description?: string })?.description ?? "";
    expect(String(desc)).toMatch(/not enough tokens/i);
  });

  it("prefers err.data.message over err.message when present (wallet provider shape)", async () => {
    const { submitTx } = useTxToast();
    const err = Object.assign(new Error("Internal error"), {
      data: { message: "InstructionError: SlippageExceeded" },
    });
    await submitTx(Promise.reject(err), "Buy");

    const desc = (mockUpdate.mock.calls.at(-1)?.[0] as { description?: string })?.description ?? "";
    expect(String(desc)).toMatch(/SlippageExceeded/);
  });

  it("extracts the best log line from err.data.logs when message is absent", async () => {
    const { submitTx } = useTxToast();
    // The hook's find() regex: /AnchorError|Error:|failed:|Program log:/i
    // Both lines match "Program log:", so the first matching line is returned.
    // Put the AnchorError line first so find() selects it.
    const err = Object.assign(new Error("Internal error"), {
      data: {
        logs: [
          "Program log: AnchorError: InsufficientFundsForFees",
          "Program log: Instruction: Buy",
        ],
      },
    });
    await submitTx(Promise.reject(err), "Buy");

    const desc = (mockUpdate.mock.calls.at(-1)?.[0] as { description?: string })?.description ?? "";
    expect(String(desc)).toMatch(/InsufficientFundsForFees/);
  });

  it("falls back to the last log line when no recognisable log pattern matches", async () => {
    const { submitTx } = useTxToast();
    const err = Object.assign(new Error("Internal error"), {
      data: { logs: ["Program log: something unexpected happened"] },
    });
    await submitTx(Promise.reject(err), "Buy");

    const desc = (mockUpdate.mock.calls.at(-1)?.[0] as { description?: string })?.description ?? "";
    expect(String(desc)).toMatch(/something unexpected happened/);
  });

  it("truncates very long error messages to 200 chars", async () => {
    const { submitTx } = useTxToast();
    const longMsg = "x".repeat(300);
    await submitTx(Promise.reject(new Error(longMsg)), "Buy");

    const desc = (mockUpdate.mock.calls.at(-1)?.[0] as { description?: string })?.description ?? "";
    expect(String(desc).length).toBeLessThanOrEqual(200);
  });
});
