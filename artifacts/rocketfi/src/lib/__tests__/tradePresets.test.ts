import { describe, it, expect } from "vitest";
import { computeSellPresetAmount, formatAtomicAmount } from "../tradePresets.js";

// ── formatAtomicAmount ────────────────────────────────────────────────────────

describe("formatAtomicAmount", () => {
  it("zero → '0'", () => {
    expect(formatAtomicAmount(0n, 6)).toBe("0");
  });

  it("whole amount with no remainder → no decimal point", () => {
    expect(formatAtomicAmount(5_000_000n, 6)).toBe("5");
  });

  it("fractional amount with trailing zeros stripped", () => {
    expect(formatAtomicAmount(1_500_000n, 6)).toBe("1.5");
  });

  it("sub-unit dust (1 atom of 9-decimal token) → '0.000000001'", () => {
    expect(formatAtomicAmount(1n, 9)).toBe("0.000000001");
  });

  it("large 9-decimal balance — max-value case", () => {
    // 999999999.999999999 token = 999999999999999999 atomic units
    expect(formatAtomicAmount(999_999_999_999_999_999n, 9))
      .toBe("999999999.999999999");
  });

  it("remainder is padded with leading zeros", () => {
    // 1.000001 with 6 decimals → 1000001n
    expect(formatAtomicAmount(1_000_001n, 6)).toBe("1.000001");
  });
});

// ── computeSellPresetAmount ───────────────────────────────────────────────────

describe("computeSellPresetAmount — BigInt floor, never exceeds balance", () => {

  // ── Standard 6-decimal tokens ─────────────────────────────────────────────

  it("100% of 1.999 (6-decimal) truncates to '1.999', not '2'", () => {
    // 1.999 tokens = 1999000n atoms (6 decimals)
    expect(computeSellPresetAmount(1_999_000n, 1, 6)).toBe("1.999");
  });

  it("25% of 1.999 (6-decimal) truncates correctly", () => {
    // 0.25 * 1999000n = 499750n → "0.49975"
    expect(computeSellPresetAmount(1_999_000n, 0.25, 6)).toBe("0.49975");
  });

  it("50% of 1.999 (6-decimal)", () => {
    // 0.5 * 1999000n = 999500n → "0.9995"
    expect(computeSellPresetAmount(1_999_000n, 0.5, 6)).toBe("0.9995");
  });

  it("100% preset equals the exact atomic balance converted to display", () => {
    const atoms = 1_234_567n;
    expect(computeSellPresetAmount(atoms, 1, 6)).toBe("1.234567");
  });

  // ── 9-decimal tokens ──────────────────────────────────────────────────────

  it("1-atom 9-decimal dust at 100% → '0.000000001', not '0'", () => {
    expect(computeSellPresetAmount(1n, 1, 9)).toBe("0.000000001");
  });

  it("25% of a 1-atom 9-decimal balance → '0' (floor of 0.25 atoms)", () => {
    // 1n * 2500 / 10000 = 0n → "0"
    expect(computeSellPresetAmount(1n, 0.25, 9)).toBe("0");
  });

  it("50% of a 2-atom 9-decimal balance → '0.000000001'", () => {
    // 2n * 5000 / 10000 = 1n → "0.000000001"
    expect(computeSellPresetAmount(2n, 0.5, 9)).toBe("0.000000001");
  });

  it("large 9-decimal balance — 100% never exceeds holdings", () => {
    // 999999999.999999999 tokens
    const atoms = 999_999_999_999_999_999n;
    const result = computeSellPresetAmount(atoms, 1, 9);
    expect(result).toBe("999999999.999999999");
    // Verify result as BigInt does not exceed atomic balance
    const [whole, frac = ""] = result.split(".");
    const resultAtomic = BigInt(whole) * (10n ** 9n) + BigInt(frac.padEnd(9, "0"));
    expect(resultAtomic).toBeLessThanOrEqual(atoms);
  });

  it("large 9-decimal balance — 25% floor", () => {
    // 999999999999999999n * 2500 / 10000 = 249999999999999999n (exact floor)
    const atoms  = 999_999_999_999_999_999n;
    const result = computeSellPresetAmount(atoms, 0.25, 9);
    expect(result).toBe("249999999.999999999");
  });

  // ── Property: result never exceeds balance ────────────────────────────────

  it("property — preset never exceeds atomic balance at 6 decimals", () => {
    const cases = [
      { atoms: 1n, pct: 1 },
      { atoms: 1_000_000n, pct: 0.25 },
      { atoms: 1_999_000n, pct: 0.5 },
      { atoms: 999_999_999n, pct: 1 },
    ];
    for (const { atoms, pct } of cases) {
      const str = computeSellPresetAmount(atoms, pct, 6);
      const [w, f = ""] = str.split(".");
      const resultAtoms = BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
      expect(resultAtoms).toBeLessThanOrEqual(atoms);
    }
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("zero balance → '0'", () => {
    expect(computeSellPresetAmount(0n, 1, 6)).toBe("0");
  });

  it("zero pct → '0'", () => {
    expect(computeSellPresetAmount(1_000_000n, 0, 6)).toBe("0");
  });

  it("trailing zeros stripped — 1.5 not 1.500000", () => {
    expect(computeSellPresetAmount(1_500_000n, 1, 6)).toBe("1.5");
  });

  it("whole number balance has no decimal point", () => {
    expect(computeSellPresetAmount(10_000_000n, 1, 6)).toBe("10");
  });
});
