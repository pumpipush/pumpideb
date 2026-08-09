/**
 * Unit tests for the pump.fun constant-product AMM math used in handleTrade.
 *
 * Verifies buy/sell amounts and slippage detection at both the initial reserve
 * state and a progressed state (roughly 50% of bonding curve filled).
 *
 * Run with: pnpm --filter @workspace/rocketfi test
 */

// ── Helpers matching handleTrade implementation exactly ─────────────────────

const ATOMS_PER_TOKEN = 1_000_000; // pump.fun 6-decimal mint

/**
 * Simulate a buy.
 * @param vSolSol  Virtual SOL reserves as decimal SOL string (matches DB format)
 * @param vTokStr  Virtual token reserves as atom integer string (matches DB format)
 * @param solIn    SOL amount to spend (display SOL)
 */
function simulateBuy(
  vSolSol: string,
  vTokStr: string,
  solIn: number,
): { tokenOutAtoms: bigint; quotedAtoms: bigint; impactPct: number } {
  const vSolLam  = BigInt(Math.round(parseFloat(vSolSol) * 1e9));
  const vTokAtom = BigInt(vTokStr.replace(/\..*/, ""));
  const k        = vSolLam * vTokAtom;
  const ethAmtLam  = BigInt(Math.round(solIn * 1e9));
  const newVSolLam = vSolLam + ethAmtLam;
  const newVTokAtom = k / newVSolLam;
  const tokenOutAtoms = vTokAtom - newVTokAtom;
  const quotedAtoms   = (ethAmtLam * vTokAtom) / vSolLam;
  const impactPct     = Number(quotedAtoms - tokenOutAtoms) / Number(quotedAtoms) * 100;
  return { tokenOutAtoms, quotedAtoms, impactPct };
}

/**
 * Simulate a sell.
 */
function simulateSell(
  vSolSol: string,
  vTokStr: string,
  displayTokensIn: number,
): { solOutLam: bigint; quotedSolLam: bigint; impactPct: number } {
  const vSolLam  = BigInt(Math.round(parseFloat(vSolSol) * 1e9));
  const vTokAtom = BigInt(vTokStr.replace(/\..*/, ""));
  const k        = vSolLam * vTokAtom;
  const tokenAmtAtom  = BigInt(Math.round(displayTokensIn * ATOMS_PER_TOKEN));
  const newVTokAtom   = vTokAtom + tokenAmtAtom;
  const newVSolLam    = k / newVTokAtom;
  const solOutLam     = vSolLam - newVSolLam;
  const quotedSolLam  = (tokenAmtAtom * vSolLam) / vTokAtom;
  const impactPct     = Number(quotedSolLam - solOutLam) / Number(quotedSolLam) * 100;
  return { solOutLam, quotedSolLam, impactPct };
}

// ── Reserve states ───────────────────────────────────────────────────────────

// Initial pump.fun virtual reserves (from pumpfun.ts constants)
const INIT_VSOL = "30.000000";
const INIT_VTOK = "1073000191045000"; // 1,073,000,191 display tokens × 1e6 atoms

// Progressed state: ~50% of bonding curve filled (roughly 536.5 M tokens sold)
// Derived by applying a large buy to initial reserves analytically
const PROG_VSOL = "60.000000";        // doubled SOL (approx 50% fill)
const PROG_VTOK = "536500095522500";  // approx half the initial atom count

// ── BUY tests ────────────────────────────────────────────────────────────────

describe("Buy — initial reserves", () => {
  const tiny   = simulateBuy(INIT_VSOL, INIT_VTOK, 0.001); // 0.001 SOL
  const small  = simulateBuy(INIT_VSOL, INIT_VTOK, 1);     // 1 SOL
  const medium = simulateBuy(INIT_VSOL, INIT_VTOK, 3);     // 3 SOL = 10% of pool

  test("tiny buy returns positive atom count", () => {
    expect(tiny.tokenOutAtoms).toBeGreaterThan(0n);
  });

  test("tiny buy has near-zero price impact (< 0.01%)", () => {
    expect(tiny.impactPct).toBeGreaterThanOrEqual(0);
    expect(tiny.impactPct).toBeLessThan(0.01);
  });

  test("small buy (1 SOL) passes 5% slippage tolerance", () => {
    expect(small.impactPct).toBeGreaterThanOrEqual(0);
    expect(small.impactPct).toBeLessThan(5);
  });

  test("small buy (1 SOL) is rejected at 1% slippage tolerance", () => {
    // ~3% impact expected for 1/30 = 3.3% pool fraction
    expect(small.impactPct).toBeGreaterThan(1);
  });

  test("medium buy (3 SOL = 10% pool) has > 5% impact", () => {
    expect(medium.impactPct).toBeGreaterThan(5);
  });

  test("quoted atoms > AMM atoms (CP curve always returns fewer than spot)", () => {
    expect(small.quotedAtoms).toBeGreaterThan(small.tokenOutAtoms);
  });

  test("token output is in expected magnitude (millions of display tokens)", () => {
    // 1 SOL at init price of ~2.8e-8 SOL/token → ~35 million display tokens
    const displayTokens = Number(small.tokenOutAtoms) / ATOMS_PER_TOKEN;
    expect(displayTokens).toBeGreaterThan(30_000_000);
    expect(displayTokens).toBeLessThan(40_000_000);
  });
});

describe("Buy — progressed reserves (50% filled)", () => {
  const small = simulateBuy(PROG_VSOL, PROG_VTOK, 1);

  test("small buy returns positive atom count", () => {
    expect(small.tokenOutAtoms).toBeGreaterThan(0n);
  });

  test("small buy (1 SOL at 50% fill) passes 5% slippage", () => {
    expect(small.impactPct).toBeGreaterThanOrEqual(0);
    expect(small.impactPct).toBeLessThan(5);
  });

  test("token output is in expected magnitude (millions of display tokens)", () => {
    // Price doubled → ~17-18 million display tokens for 1 SOL
    const displayTokens = Number(small.tokenOutAtoms) / ATOMS_PER_TOKEN;
    expect(displayTokens).toBeGreaterThan(8_000_000);
    expect(displayTokens).toBeLessThan(20_000_000);
  });
});

// ── SELL tests ───────────────────────────────────────────────────────────────

describe("Sell — initial reserves", () => {
  const tiny   = simulateSell(INIT_VSOL, INIT_VTOK, 100);       // 100 display tokens
  const small  = simulateSell(INIT_VSOL, INIT_VTOK, 35_000_000); // ~1 SOL worth

  test("tiny sell returns positive lamport count", () => {
    expect(tiny.solOutLam).toBeGreaterThan(0n);
  });

  test("tiny sell has near-zero price impact (|impact| < 0.1%)", () => {
    // CP curve can give slightly more SOL than the linear spot quote for tiny sells
    // (concave curve → negative impact is normal and fine for the user)
    expect(Math.abs(tiny.impactPct)).toBeLessThan(0.1);
  });

  test("sell equivalent of ~1 SOL worth passes 5% slippage", () => {
    expect(small.impactPct).toBeGreaterThanOrEqual(0);
    expect(small.impactPct).toBeLessThan(5);
  });

  test("sell equivalent of ~1 SOL worth is rejected at 1% slippage", () => {
    expect(small.impactPct).toBeGreaterThan(1);
  });

  test("quoted SOL > AMM SOL (CP curve returns fewer than spot)", () => {
    expect(small.quotedSolLam).toBeGreaterThan(small.solOutLam);
  });

  test("SOL output for 35M tokens is ~1 SOL (within 10%)", () => {
    // 35M tokens at spot gives ~1 SOL, but CP curve gives slightly less due to price impact
    const solOut = Number(small.solOutLam) / 1e9;
    expect(solOut).toBeGreaterThan(0.90);
    expect(solOut).toBeLessThan(1.05);
  });
});

describe("Sell — progressed reserves (50% filled)", () => {
  const small = simulateSell(PROG_VSOL, PROG_VTOK, 17_000_000); // ~1 SOL worth at double price

  test("sell returns positive lamport count", () => {
    expect(small.solOutLam).toBeGreaterThan(0n);
  });

  test("sell passes 5% slippage tolerance", () => {
    expect(small.impactPct).toBeGreaterThanOrEqual(0);
    expect(small.impactPct).toBeLessThan(5);
  });
});
