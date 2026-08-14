/**
 * raydium-launchlab.supply.test.ts
 *
 * Guards the SPL mint supply decoding path and the supply-aware market-cap
 * calculation in the LaunchLab adapter.
 *
 * Covers:
 *  UNIT — fetchMintTotalSupply
 *    - Correct u64 LE decoding from a valid 82-byte SPL mint account buffer
 *    - Oversized buffer (Token-2022 extension data appended after offset 82)
 *    - Buffer too short → null
 *    - supply field = 0 → null (considered empty / not yet minted)
 *    - fetch rejects (network error) → null
 *    - RPC returns no account data → null
 *
 *  UNIT — computeInitialTokenParams (handleCreate formula)
 *    - initMcLamports is always 30 SOL in lamports regardless of supply (t=0 invariant)
 *    - totalSupply string matches the realSupply bigint
 *    - priceEth is supply-dependent: smaller supply → higher price
 *    - Falls back to LL_TOTAL_SUPPLY (1e15) when realSupply = 0
 *
 *  UNIT — computeTradeMarketCap (handleTrade formula)
 *    - Uses the stored totalSupply, not the hardcoded 1B constant
 *    - Non-standard supply produces a different (correct) MC than 1B supply
 *    - Returns undefined for dust token amounts (< 1 000 atoms)
 *    - Returns undefined when solLamports = 0
 *    - Standard 1B supply result matches manual calculation (regression guard)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchMintTotalSupply,
  computeInitialTokenParams,
  computeTradeMarketCap,
} from "./raydium-launchlab.js";

// ── SPL Mint account layout helpers ─────────────────────────────────────────

const SPL_MINT_SUPPLY_OFFSET = 36;
const SPL_MINT_SIZE          = 82;

/**
 * Build a minimal 82-byte SPL mint account buffer with the given supply value.
 * All other fields are zeroed (is_initialized = 0 in byte 45 is fine for tests).
 */
function makeMintBuffer(supply: bigint, extraBytes = 0): Buffer {
  const buf = Buffer.alloc(SPL_MINT_SIZE + extraBytes, 0);
  buf.writeBigUInt64LE(supply, SPL_MINT_SUPPLY_OFFSET);
  return buf;
}

/** Wrap a raw buffer in the JSON shape returned by getAccountInfo. */
function makeRpcResponse(data: Buffer | null): unknown {
  if (!data) {
    return { result: { value: null } };
  }
  return {
    result: {
      value: { data: [data.toString("base64"), "base64"] },
    },
  };
}

// ── Suite: fetchMintTotalSupply ──────────────────────────────────────────────

describe("fetchMintTotalSupply — SPL u64 decoding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes a standard 1B LaunchLab supply correctly", async () => {
    const supply = 1_000_000_000_000_000n;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => makeRpcResponse(makeMintBuffer(supply)),
    }));

    const result = await fetchMintTotalSupply("FakeMint1111111111111111111111111111111111");
    expect(result).toBe(supply);
  });

  it("decodes a non-standard supply (e.g. USD1-like) correctly", async () => {
    // USD1 example: suppose its actual total supply is 50_000_000_000n atoms
    const supply = 50_000_000_000n;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => makeRpcResponse(makeMintBuffer(supply)),
    }));

    const result = await fetchMintTotalSupply("FakeMint2222222222222222222222222222222222");
    expect(result).toBe(supply);
  });

  it("reads supply from the correct byte offset (u64 LE at offset 36)", async () => {
    // Place a sentinel value at offset 36 and zeros everywhere else.
    // If the reader uses the wrong offset it would pick up 0 and return null.
    const sentinelSupply = 999_999_999n;
    const buf = Buffer.alloc(SPL_MINT_SIZE, 0);
    buf.writeBigUInt64LE(sentinelSupply, 36);

    // Also write a different value at offset 0 to confirm offset=0 is NOT used.
    buf.writeBigUInt64LE(0xdeadbeefn, 0);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => makeRpcResponse(buf),
    }));

    const result = await fetchMintTotalSupply("FakeMint3333333333333333333333333333333333");
    expect(result).toBe(sentinelSupply);
  });

  it("succeeds when the buffer is larger than 82 bytes (Token-2022 extension data)", async () => {
    // Token-2022 mints can have extra extension data appended after the standard
    // 82-byte SPL mint layout.  The function must still read correctly from offset 36.
    const supply = 500_000_000_000n;
    const buf = makeMintBuffer(supply, 118); // 82 + 118 = 200 bytes
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => makeRpcResponse(buf),
    }));

    const result = await fetchMintTotalSupply("FakeMintTok22222222222222222222222222222222");
    expect(result).toBe(supply);
  });

  it("returns null when supply field is 0 (uninitialized mint)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => makeRpcResponse(makeMintBuffer(0n)),
    }));

    const result = await fetchMintTotalSupply("FakeMint4444444444444444444444444444444444");
    expect(result).toBeNull();
  });

  it("returns null when buffer is shorter than 82 bytes", async () => {
    const shortBuf = Buffer.alloc(50, 0);
    shortBuf.writeBigUInt64LE(1_000_000n, 36); // valid offset but buffer too short

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => makeRpcResponse(shortBuf),
    }));

    const result = await fetchMintTotalSupply("FakeMint5555555555555555555555555555555555");
    expect(result).toBeNull();
  });

  it("returns null when the account does not exist (value: null)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => makeRpcResponse(null),
    }));

    const result = await fetchMintTotalSupply("FakeMint6666666666666666666666666666666666");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await fetchMintTotalSupply("FakeMint7777777777777777777777777777777777");
    expect(result).toBeNull();
  });

  it("returns null when the RPC response is malformed (missing result)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({}), // no 'result' key
    }));

    const result = await fetchMintTotalSupply("FakeMint8888888888888888888888888888888888");
    expect(result).toBeNull();
  });
});

// ── Suite: computeInitialTokenParams ─────────────────────────────────────────
//
// Guards the handleCreate formula: initial MC and priceEth computed from the
// real on-chain supply (not the hardcoded 1B constant).

describe("computeInitialTokenParams — handleCreate formula", () => {
  const LL_TOTAL_SUPPLY       = 1_000_000_000_000_000n; // 1B × 10^6 decimals
  const LL_INIT_VSOL_LAMPORTS = 30_000_000_000n;        // 30 SOL in lamports

  it("initMcLamports is always 30 SOL regardless of supply (t=0 bonding-curve invariant)", () => {
    // At t=0: MC = supply × vSol/vTok = supply × 30e9/supply = 30e9 (constant).
    // A regression here would mean wrong initial MC for all non-standard tokens.
    const standard  = computeInitialTokenParams(LL_TOTAL_SUPPLY);
    const small     = computeInitialTokenParams(50_000_000_000n);     // 50B atoms
    const large     = computeInitialTokenParams(9_999_999_999_999_999n);

    const expected = LL_INIT_VSOL_LAMPORTS.toString(); // "30000000000"
    expect(standard.initMcLamports).toBe(expected);
    expect(small.initMcLamports).toBe(expected);
    expect(large.initMcLamports).toBe(expected);
  });

  it("totalSupply string matches the realSupply bigint", () => {
    const supply = 42_000_000_000n;
    const result = computeInitialTokenParams(supply);
    expect(result.totalSupply).toBe(supply.toString());
  });

  it("stores standard 1B supply correctly", () => {
    const result = computeInitialTokenParams(LL_TOTAL_SUPPLY);
    expect(result.totalSupply).toBe(LL_TOTAL_SUPPLY.toString());
  });

  it("priceEth is supply-dependent: smaller supply → higher price per token", () => {
    // Fewer tokens in existence → each one is worth more SOL.
    // A regression to the hardcoded 1B constant would make non-standard tokens
    // show the same (wrong) priceEth as standard tokens.
    const standard = computeInitialTokenParams(LL_TOTAL_SUPPLY);
    const small    = computeInitialTokenParams(1_000_000n); // 1 display token at 6 decimals

    expect(parseFloat(small.initPriceEth)).toBeGreaterThan(parseFloat(standard.initPriceEth));
  });

  it("priceEth for standard supply matches the expected constant (30e9 / 1e15 / 1000)", () => {
    const result = computeInitialTokenParams(LL_TOTAL_SUPPLY);
    // 30_000_000_000 lamports / 1_000_000_000_000_000 atoms / 1000 = 3e-8 SOL/display-token
    // The /1000 factor converts lamports/atom → SOL/display-token (6-decimal token,
    // so 1 display token = 1e6 atoms; and 1 SOL = 1e9 lamports: 1e6/1e9 = 1/1000).
    expect(parseFloat(result.initPriceEth)).toBeCloseTo(3e-8, 15);
  });

  it("falls back to LL_TOTAL_SUPPLY when realSupply is 0 (fetchMintTotalSupply returned null)", () => {
    // callers use: fetchMintTotalSupply(mint) ?? LL_TOTAL_SUPPLY
    // computeInitialTokenParams(0n) represents a defensive edge case.
    const fallback = computeInitialTokenParams(0n);
    const standard = computeInitialTokenParams(LL_TOTAL_SUPPLY);
    expect(fallback.totalSupply).toBe(standard.totalSupply);
    expect(fallback.initMcLamports).toBe(standard.initMcLamports);
  });

  it("non-standard supply produces a different (correct) priceEth from the 1B constant", () => {
    const nonStd  = computeInitialTokenParams(50_000_000_000n); // 50B atoms
    const standard = computeInitialTokenParams(LL_TOTAL_SUPPLY);

    // The ratio should be 1e15/50e9 = 20000× (standard is 20 000× cheaper per token)
    const ratio = parseFloat(nonStd.initPriceEth) / parseFloat(standard.initPriceEth);
    expect(ratio).toBeCloseTo(20_000, 0);
  });
});

// ── Suite: computeTradeMarketCap ─────────────────────────────────────────────
//
// Guards the handleTrade formula: MC computed from stored totalSupply (not
// the hardcoded 1B constant).

describe("computeTradeMarketCap — handleTrade formula", () => {
  const LL_TOTAL_SUPPLY = 1_000_000_000_000_000n;

  it("uses the stored totalSupply (not the hardcoded 1B constant) to compute MC", () => {
    // Non-standard token: 50B atomic supply.
    // If the code mistakenly used LL_TOTAL_SUPPLY the result would be 20 000× wrong.
    const nonStdSupply = 50_000_000_000n;  // 50B atoms
    const solLamports  = 1_000_000_000n;   // 1 SOL
    const tokenAmount  = 10_000_000_000n;  // 10B atoms (20% of supply)

    const mc = computeTradeMarketCap(nonStdSupply, solLamports, tokenAmount);
    // Expected: 50e9 × 1e9 / 10e9 = 5 000 000 000 lamports (5 SOL)
    expect(mc).toBe("5000000000");

    // Confirm this differs from the constant-supply calculation:
    const wrongMc = computeTradeMarketCap(LL_TOTAL_SUPPLY, solLamports, tokenAmount);
    expect(mc).not.toBe(wrongMc);
    // With 1B supply the MC would be vastly larger: 1e15 × 1e9 / 10e9 = 1e14 lamports
    expect(Number(wrongMc)).toBeGreaterThan(Number(mc));
  });

  it("produces the correct MC for standard 1B supply (regression guard)", () => {
    // MC = totalSupply × solLamports / tokenAmount
    const solLamports = 500_000_000n;  // 0.5 SOL
    const tokenAmount = 2_000_000n;    // 2M atoms traded
    const mc = computeTradeMarketCap(LL_TOTAL_SUPPLY, solLamports, tokenAmount);
    expect(mc).toBe((LL_TOTAL_SUPPLY * solLamports / tokenAmount).toString());
  });

  it("returns undefined for dust token amounts (tokenAmount < 1 000 atoms)", () => {
    const mc = computeTradeMarketCap(LL_TOTAL_SUPPLY, 1_000_000_000n, 999n);
    expect(mc).toBeUndefined();
  });

  it("returns undefined when tokenAmount is exactly at the 1 000-atom boundary", () => {
    // 999 → undefined; 1000 → defined.  Boundary is exclusive-lower (< 1000).
    expect(computeTradeMarketCap(LL_TOTAL_SUPPLY, 1_000_000_000n, 999n)).toBeUndefined();
    expect(computeTradeMarketCap(LL_TOTAL_SUPPLY, 1_000_000_000n, 1_000n)).toBeDefined();
  });

  it("returns undefined when solLamports is 0", () => {
    const mc = computeTradeMarketCap(LL_TOTAL_SUPPLY, 0n, 1_000_000_000n);
    expect(mc).toBeUndefined();
  });

  it("respects a custom minPriceAtoms threshold when provided", () => {
    // With threshold = 5 000, amounts of 4 999 should return undefined.
    expect(computeTradeMarketCap(LL_TOTAL_SUPPLY, 1_000_000_000n, 4_999n, 5_000n)).toBeUndefined();
    expect(computeTradeMarketCap(LL_TOTAL_SUPPLY, 1_000_000_000n, 5_000n, 5_000n)).toBeDefined();
  });

  it("handles very large supplies without BigInt overflow", () => {
    // Max u64 supply (~1.8e19) × 1 SOL / 1e9 tokens = large but valid MC
    const maxSupply   = 18_446_744_073_709_551_615n; // u64 max
    const solLamports = 1_000_000_000n;
    const tokenAmount = 1_000_000_000n;
    const mc = computeTradeMarketCap(maxSupply, solLamports, tokenAmount);
    expect(mc).toBe((maxSupply * solLamports / tokenAmount).toString());
    expect(() => BigInt(mc!)).not.toThrow();
  });
});
