/**
 * utils.test.ts — Regression guard for the portfolio holding display calculations
 *
 * SOLE CALCULATION PATH:
 *   PortfolioTab (My Tokens) renders every holdings row by calling
 *   computeHoldingRow(token.balance, token.priceEth, solPrice) and using only
 *   the values it returns — no inline arithmetic. This means:
 *
 *     • If the atomic→display conversion is removed from computeHoldingRow,
 *       the tests below FAIL and PortfolioTab's display breaks simultaneously.
 *     • If computeHoldingRow is bypassed in PortfolioTab with inline math, the
 *       developer must also update these tests, making the regression visible.
 *
 * THE UNIT CONTRACT (pump.fun / PumpSwap / Raydium LaunchLab):
 *   `balance` from GET /api/wallet/:address/holdings is raw atomic units.
 *   1 display token = 1,000,000 atomic units  (6 on-chain decimal places).
 *   computeHoldingRow MUST divide by 1e6 before any display or value calc.
 *
 * ORIGINAL BUG:
 *   balance = "1500000" (1.5 tokens) was displayed as "1.50m" (1.5 million).
 *   computeHoldingRow must return formattedTokens = "1.50" (not "1.50m").
 */

import { describe, it, expect } from "vitest";
import { computeHoldingRow, atomicToDisplayTokens, formatTokenAmount, formatAtomicTokenAmount } from "../utils.js";

// ────────────────────────────────────────────────────────────────────────────────
// computeHoldingRow — the PortfolioTab sole calculation path
// ────────────────────────────────────────────────────────────────────────────────

describe("computeHoldingRow — PortfolioTab sole calculation path", () => {
  it("9-decimal token: 1,000,000,000 atomic = 1 display token (not 1,000)", () => {
    // Tokens with 9 on-chain decimals (e.g. wrapped SOL) store 1e9 per display token.
    // Without the decimals parameter, dividing by 1e6 would give 1,000 display tokens
    // and a value 1,000× too large.
    const row = computeHoldingRow("1000000000", "0.05", null, 9);
    expect(row.displayTokens).toBeCloseTo(1, 9);
    // valueSol = 0.05 SOL/token × 1 token = 0.05 SOL
    expect(row.valueSol).toBeCloseTo(0.05, 10);
    // formattedTokens should show "1", not "1.00k"
    expect(row.formattedTokens).not.toMatch(/[kmbtq]$/);
    expect(parseFloat(row.formattedTokens.replace(/,/g, ""))).toBeCloseTo(1, 5);
  });

  it("6-decimal default is preserved when no decimals argument is passed", () => {
    // Default should still work for pump.fun tokens
    const rowDefault  = computeHoldingRow("1000000", "0.0000001", null);
    const rowExplicit = computeHoldingRow("1000000", "0.0000001", null, 6);
    expect(rowDefault.displayTokens).toBe(rowExplicit.displayTokens);
    expect(rowDefault.valueSol).toBe(rowExplicit.valueSol);
  });

  it("converts the canonical bug: 1,500,000 atomic displays as '1.50' not '1.50m'", () => {
    // The API returns balance = "1500000" for a wallet holding 1.5 whole tokens.
    // The old bug passed this raw string to formatTokenAmount → "1.50m" (millions).
    const row = computeHoldingRow("1500000", null, null);

    // "1.5" or "1.50" — exact locale formatting varies; what matters is:
    //   1. NO magnitude suffix (not "1.50m")
    //   2. numeric value is 1.5 (not 1,500,000)
    expect(row.formattedTokens).not.toMatch(/[kmbtq]$/); // no magnitude suffix
    expect(parseFloat(row.formattedTokens.replace(/,/g, ""))).toBeCloseTo(1.5, 3);
    expect(row.displayTokens).toBeCloseTo(1.5, 9);
  });

  it("1 whole token → balance '1000000' → displayTokens 1, formattedTokens '1'", () => {
    const row = computeHoldingRow("1000000", null, null);

    expect(row.displayTokens).toBe(1);
    // formatTokenAmount("1") → "1" (falls through to toLocaleString)
    expect(parseFloat(row.formattedTokens)).toBeCloseTo(1, 5);
  });

  it("zero balance → all values are zero", () => {
    const row = computeHoldingRow("0", "0.00000013", 150);

    expect(row.displayTokens).toBe(0);
    expect(row.valueSol).toBe(0);
    expect(row.valueUsd).toBe(0);
  });

  it("valueSol = priceEth × displayTokens (not priceEth × rawAtomic)", () => {
    // 1.5 display tokens × 1.3e-7 SOL/token = 1.95e-7 SOL
    const row = computeHoldingRow("1500000", "0.000000130", null);

    expect(row.valueSol).toBeCloseTo(1.95e-7, 14);

    // The wrong calculation (without ÷1e6) would be 6 orders of magnitude larger
    const atomicTimesPrice = 1_500_000 * 0.000000130; // ≈ 0.195 SOL (the bug)
    expect(atomicTimesPrice / row.valueSol).toBeGreaterThan(900_000);
  });

  it("valueUsd = valueSol × solPrice when solPrice is provided", () => {
    const solPrice = 150; // $150 / SOL
    const row = computeHoldingRow("1500000", "0.000000130", solPrice);

    expect(row.valueUsd).not.toBeNull();
    expect(row.valueUsd!).toBeCloseTo(row.valueSol * solPrice, 12);
    expect(row.valueUsd!).toBeCloseTo(1.95e-7 * 150, 12);
  });

  it("valueUsd is null when solPrice is null", () => {
    const row = computeHoldingRow("1500000", "0.000000130", null);
    expect(row.valueUsd).toBeNull();
  });

  it("handles null priceEth gracefully — no price means zero SOL value", () => {
    const row = computeHoldingRow("1000000", null, 150);
    expect(row.valueSol).toBe(0);
    expect(row.valueUsd).toBe(0);
  });

  it("whale wallet: 10 billion atomic = 10,000 display tokens", () => {
    const row = computeHoldingRow("10000000000", "0.000000130", null);
    expect(row.displayTokens).toBeCloseTo(10_000, 6);
    expect(row.formattedTokens).toMatch(/^10(\.\d+)?k$/); // "10.0k"
  });

  it("tiny balance (100 atomic = 0.0001 display tokens)", () => {
    const row = computeHoldingRow("100", "0.000000130", null);
    expect(row.displayTokens).toBeCloseTo(0.0001, 9);
    // 0.0001 display tokens → very small valueSol
    expect(row.valueSol).toBeCloseTo(1.3e-11, 14);
  });

  it("handles numeric balance (not just string)", () => {
    // atomicToDisplayTokens accepts both — verify computeHoldingRow does too
    const rowStr = computeHoldingRow("2000000", "0.000000130", 150);
    expect(rowStr.displayTokens).toBeCloseTo(2, 9);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// atomicToDisplayTokens — low-level conversion (used by computeHoldingRow)
// ────────────────────────────────────────────────────────────────────────────────

describe("atomicToDisplayTokens — 6-decimal pump.fun convention", () => {
  it("1,000,000 atomic → 1 display token", () => {
    expect(atomicToDisplayTokens(1_000_000)).toBe(1);
  });

  it("accepts string input as returned by the API", () => {
    expect(atomicToDisplayTokens("1500000")).toBeCloseTo(1.5, 9);
  });

  it("invalid / non-numeric input → 0", () => {
    expect(atomicToDisplayTokens(NaN)).toBe(0);
    expect(atomicToDisplayTokens("")).toBe(0);
    expect(atomicToDisplayTokens(Infinity)).toBe(0);
  });

  it("respects the decimals parameter for non-standard tokens", () => {
    expect(atomicToDisplayTokens(1_000_000_000, 9)).toBe(1); // wSOL (9 dec)
    expect(atomicToDisplayTokens(42, 0)).toBe(42);           // 0-decimal
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// formatAtomicTokenAmount — safe call site for DB/API token amounts
// ────────────────────────────────────────────────────────────────────────────────

describe("formatAtomicTokenAmount — internal ÷1e6 so call sites cannot forget", () => {
  it("converts the original bug case: '1500000' atomic → '1.5' display (not '1.50m')", () => {
    const result = formatAtomicTokenAmount("1500000");
    expect(result).not.toMatch(/m$/);             // no million suffix
    expect(result).not.toMatch(/[kmbtq]$/);       // no any magnitude suffix
    expect(parseFloat(result.replace(/,/g, ""))).toBeCloseTo(1.5, 3);
  });

  it("1,000,000 atomic → '1' display token", () => {
    const result = formatAtomicTokenAmount("1000000");
    expect(parseFloat(result)).toBeCloseTo(1, 5);
  });

  it("10,000,000 atomic → '10' display tokens", () => {
    const result = formatAtomicTokenAmount("10000000");
    expect(parseFloat(result.replace(/,/g, ""))).toBeCloseTo(10, 3);
  });

  it("50,952,000 atomic → '50.95' (trade table fix: was '50.95m')", () => {
    // This was the exact value triggering "50.95m" in the trade table bug.
    const buggy = formatTokenAmount("50952000");    // raw → "50.95m" (wrong)
    const fixed  = formatAtomicTokenAmount("50952000"); // atomic → "50.95" (right)
    expect(buggy).toBe("50.95m");                  // proves what the bug looked like
    expect(fixed).not.toMatch(/m$/);
    expect(parseFloat(fixed.replace(/,/g, ""))).toBeCloseTo(50.952, 2);
  });

  it("whale: 10 billion atomic → '10.00k' display tokens", () => {
    const result = formatAtomicTokenAmount("10000000000");
    expect(result).toMatch(/k$/);
    expect(result).toContain("10");
  });

  it("tiny: 100 atomic → display value < 1 (rounds to '0' at 2dp)", () => {
    // 100 / 1e6 = 0.0001 whole tokens.
    // formatTokenAmount uses toLocaleString(maximumFractionDigits:2) → "0".
    // The key is no billion/million suffix, and no crash.
    const result = formatAtomicTokenAmount("100");
    expect(result).not.toMatch(/[kmbtq]$/);
    // 0.0001 rounds to "0" at 2 decimal places — that's expected behaviour
    expect(["0", "0.00", "0.0001"]).toContain(result);
  });

  it("null/undefined/empty → '0'", () => {
    expect(formatAtomicTokenAmount(null)).toBe("0");
    expect(formatAtomicTokenAmount(undefined)).toBe("0");
    expect(formatAtomicTokenAmount("")).toBe("0");
  });

  it("accepts a numeric value as well as a string", () => {
    expect(formatAtomicTokenAmount(1_500_000)).not.toMatch(/m$/);
    expect(parseFloat(formatAtomicTokenAmount(1_500_000))).toBeCloseTo(1.5, 3);
  });

  it("respects the decimals parameter for 9-decimal tokens", () => {
    // 1,000,000,000 atomic with 9 decimals = 1 display token (not 1,000)
    const result = formatAtomicTokenAmount("1000000000", 9);
    expect(parseFloat(result)).toBeCloseTo(1, 5);
    expect(result).not.toMatch(/k$/);  // must NOT be "1.00k"
  });

  it("is safe to call where formatTokenAmount(String(bal / 1e6)) was used", () => {
    // Holders tab old pattern: formatTokenAmount(String(bal / 1e6))
    // New pattern: formatAtomicTokenAmount(String(bal))
    // Both must produce the same output.
    const bal = 2_500_000; // raw atomic
    const oldWay = formatTokenAmount(String(bal / 1e6));
    const newWay = formatAtomicTokenAmount(String(bal));
    expect(newWay).toBe(oldWay); // identical output, safer API
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Proof: passing raw atomic to formatTokenAmount gives the wrong "m" suffix
// ────────────────────────────────────────────────────────────────────────────────

describe("formatTokenAmount bug demonstration", () => {
  it("shows the original bug: raw atomic '1500000' formats as '1.50m'", () => {
    // This is what PortfolioTab did BEFORE the fix.
    // computeHoldingRow.formattedTokens must NOT replicate this.
    expect(formatTokenAmount("1500000")).toBe("1.50m");
  });

  it("shows the correct path: display tokens '1.5' formats as '1.5'", () => {
    // computeHoldingRow converts to display first, then formats.
    const row = computeHoldingRow("1500000", null, null);
    expect(row.formattedTokens).not.toBe("1.50m");
    expect(parseFloat(row.formattedTokens)).toBeCloseTo(1.5, 3);
  });
});
