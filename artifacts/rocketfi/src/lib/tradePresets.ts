/**
 * tradePresets — pure helpers for sell-preset amount calculation.
 *
 * All percentage arithmetic uses BigInt so there is zero floating-point
 * representation error. The result can never exceed the wallet's actual
 * on-chain balance regardless of token decimals or balance magnitude.
 *
 * Kept separate from React components so they can be unit-tested without
 * any DOM/React dependency.
 */

/**
 * Format a raw atomic amount as a human-readable decimal string.
 *
 * Example: formatAtomicAmount(999999999999999999n, 9) → "999999999.999999999"
 *
 * Trailing zeros after the decimal point are stripped for readability.
 */
export function formatAtomicAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) return "0";

  const divisor   = 10n ** BigInt(decimals);
  const whole     = amount / divisor;
  const remainder = amount % divisor;

  if (remainder === 0n) return whole.toString();

  // Pad remainder to `decimals` digits, then strip trailing zeros
  const remStr = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${remStr}`;
}

/**
 * Compute the sell preset amount for a given atomic wallet balance.
 *
 * Uses only BigInt arithmetic so the result is guaranteed to be ≤ the actual
 * on-chain balance. BigInt division truncates toward zero (same as floor for
 * positive values), so every preset is strictly safe.
 *
 * The `pct` argument (0–1, e.g. 0.25 for 25%) is converted to a 4-decimal-
 * place integer ratio (× 10 000) before any arithmetic, preserving the exact
 * values used in the UI (25%, 50%, 100%).
 *
 * @param atomicBalance  Wallet's raw token balance as a BigInt (tokenAmount.amount).
 * @param pct            Fraction to sell (0–1, e.g. 0.25, 0.5, 1.0).
 * @param decimals       Token's on-chain decimal count (e.g. 6 or 9).
 *
 * @returns A display-unit string ready to paste into the trade amount input.
 *          Returns "0" when the result rounds down to zero at the given precision.
 */
export function computeSellPresetAmount(
  atomicBalance: bigint,
  pct:           number,
  decimals:      number,
): string {
  if (atomicBalance <= 0n || pct <= 0) return "0";

  // Multiply pct by 10_000 to get an exact integer percentage with 4dp precision.
  // 0.25 → 2500, 0.5 → 5000, 1.0 → 10000 — all representable exactly.
  const SCALE      = 10_000n;
  const pctScaled  = BigInt(Math.round(pct * 10_000));
  const atomicPreset = (atomicBalance * pctScaled) / SCALE; // BigInt division = floor

  return formatAtomicAmount(atomicPreset, decimals);
}
