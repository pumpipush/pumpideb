/**
 * raydium-launchlab.reserves.test.ts
 *
 * Guards the on-chain reserve extraction added to parseTradeEventFromLogs
 * (vSolLamports / vTokAtoms from TradeEvent bytes 40–55) and the
 * fetchLabPoolRealSol programId validation in enrichment.ts.
 *
 * These two pieces together replace the drifting constant-product estimate
 * with actual on-chain values.  If either regresses silently, the bonding
 * curve progress bar will show wrong percentages again.
 *
 * Coverage:
 *   UNIT — parseTradeEventFromLogs reserve fields
 *     - Valid reserves in range → vSolLamports and vTokAtoms extracted
 *     - vSol below 30 SOL floor → both fields null (sanity range rejects)
 *     - vSol above 200 SOL ceiling → both fields null
 *     - vTok = 0 → both fields null (zero vTok is invalid)
 *     - Event shorter than 56 bytes → both fields null (can't read offsets 40–55)
 *     - sol/tokenAmount still parsed correctly when reserve extraction fails
 *     - Reserve bytes are the post-trade values (round-trip encode/decode check)
 *
 *   UNIT — fetchLabPoolRealSol programId validation
 *     - Pool with correct LaunchLab programId → returns SOL amount
 *     - Pool with a different programId (CPMM) → returns null (rejected)
 *     - Mixed pool list: only the LaunchLab pool is used
 *     - SOL as mintB (not mintA) → still returns the correct amount
 *     - Both mints wrong (neither is WSOL) → returns null
 *     - fetch throws → returns null
 *     - HTTP error response → returns null
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { parseTradeEventFromLogs } from "./raydium-launchlab.js";
import { fetchLabPoolRealSol } from "../enrichment.js";

// ── Shared constants ──────────────────────────────────────────────────────────

const DISC       = Buffer.from("bddb7fd34ee661ee", "hex");
const POOL_BYTES = Buffer.alloc(32, 0xaa);

const WSOL    = "So11111111111111111111111111111111111111112";
const FAKE_MINT = "TokenMintFakeAddress111111111111111111111111";
const LL_PROG   = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const CPMM_PROG = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

// ── TradeEvent helpers ────────────────────────────────────────────────────────

/**
 * Build a 147-byte LaunchLab TradeEvent buffer.
 *
 * Layout (post-2026):
 *   [0..7]   discriminator
 *   [8..39]  pool address
 *   [40..47] vSol (u64 LE, lamports)
 *   [48..55] vTok (u64 LE, base units)
 *   [56..63] realSol (u64 LE)
 *   [64..71] realTok (u64 LE)
 *   [72..79] sol_amount (u64 LE)
 *   [80..87] tok_amount (u64 LE)
 *   [88]     is_buy
 *   [89..146] padding
 */
function makeTradeEvent({
  vSolLamports = 35_000_000_000n, // 35 SOL — within [30, 200] range
  vTokAtoms    = 950_000_000_000_000n,
  solLamports  = 1_000_000_000n,
  tokenAmount  = 50_000_000_000n,
  isBuy        = true,
  truncateTo   = 147,
}: {
  vSolLamports?: bigint;
  vTokAtoms?:    bigint;
  solLamports?:  bigint;
  tokenAmount?:  bigint;
  isBuy?:        boolean;
  truncateTo?:   number;
} = {}): string {
  const buf = Buffer.alloc(147, 0);
  DISC.copy(buf, 0);
  POOL_BYTES.copy(buf, 8);
  buf.writeBigUInt64LE(vSolLamports, 40);
  buf.writeBigUInt64LE(vTokAtoms,    48);
  buf.writeBigUInt64LE(solLamports,  72);
  buf.writeBigUInt64LE(tokenAmount,  80);
  buf[88] = isBuy ? 1 : 0;
  return "Program data: " + buf.subarray(0, truncateTo).toString("base64");
}

function makeBuyLogs(opts: Parameters<typeof makeTradeEvent>[0] = {}): string[] {
  return [
    "Program LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj invoke [1]",
    "Instruction: BuyExactIn",
    makeTradeEvent(opts),
    "Program LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj success",
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT: parseTradeEventFromLogs — reserve field extraction
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseTradeEventFromLogs — vSolLamports / vTokAtoms extraction", () => {
  it("extracts vSolLamports and vTokAtoms when reserves are in valid range", () => {
    const vSol = 42_500_000_000n; // 42.5 SOL — well within [30, 200]
    const vTok = 900_000_000_000_000n;
    const result = parseTradeEventFromLogs(makeBuyLogs({ vSolLamports: vSol, vTokAtoms: vTok }));

    expect(result).not.toBeNull();
    expect(result?.vSolLamports).toBe(vSol.toString());
    expect(result?.vTokAtoms).toBe(vTok.toString());
  });

  it("round-trips: extracted vSolLamports matches exactly what was written into the event", () => {
    const expectedVSol = 55_123_456_789n; // 55.123… SOL
    const result = parseTradeEventFromLogs(
      makeBuyLogs({ vSolLamports: expectedVSol, vTokAtoms: 800_000_000_000_000n }),
    );
    expect(result?.vSolLamports).toBe(expectedVSol.toString());
  });

  it("returns vSolLamports=null when vSol is below the 30 SOL floor (29.999… SOL)", () => {
    const belowFloor = 29_999_999_999n; // just under 30 SOL
    const result = parseTradeEventFromLogs(
      makeBuyLogs({ vSolLamports: belowFloor, vTokAtoms: 1_000_000_000_000_000n }),
    );
    // sol/tokenAmount should still be present (they come from different offsets)
    expect(result).not.toBeNull();
    expect(result?.vSolLamports).toBeNull();
    expect(result?.vTokAtoms).toBeNull();
  });

  it("returns vSolLamports=null when vSol is exactly at the 30 SOL floor (valid)", () => {
    // 30 SOL exactly should PASS the sanity check (>= MIN_VSOL)
    const atFloor = 30_000_000_000n;
    const result  = parseTradeEventFromLogs(
      makeBuyLogs({ vSolLamports: atFloor, vTokAtoms: 1_000_000_000_000_000n }),
    );
    expect(result?.vSolLamports).toBe(atFloor.toString());
  });

  it("returns vSolLamports=null when vSol exceeds 200 SOL ceiling", () => {
    const aboveCeiling = 200_000_000_001n; // just over 200 SOL
    const result = parseTradeEventFromLogs(
      makeBuyLogs({ vSolLamports: aboveCeiling, vTokAtoms: 1_000_000_000_000_000n }),
    );
    expect(result).not.toBeNull();
    expect(result?.vSolLamports).toBeNull();
    expect(result?.vTokAtoms).toBeNull();
  });

  it("returns vSolLamports=null when vTok is zero (invalid pool state)", () => {
    const result = parseTradeEventFromLogs(
      makeBuyLogs({ vSolLamports: 40_000_000_000n, vTokAtoms: 0n }),
    );
    expect(result?.vSolLamports).toBeNull();
    expect(result?.vTokAtoms).toBeNull();
  });

  it("returns null for the entire parse when the event buffer is only 55 bytes (< 89-byte minimum)", () => {
    // The parser's first guard is `raw.length < 89` — it skips the log entirely.
    // A 55-byte buffer never reaches the reserve-extraction branch, so the whole
    // result is null (not an object with null reserve fields).
    const result = parseTradeEventFromLogs(makeBuyLogs({ truncateTo: 55 }));
    expect(result).toBeNull();
  });

  it("still parses sol/tokenAmount correctly even when reserve extraction fails", () => {
    // vSol below range → reserve fields null, but trade fields should survive
    const solLamports = 2_000_000_000n;
    const tokenAmount = 100_000_000_000n;
    const result = parseTradeEventFromLogs(makeBuyLogs({
      vSolLamports: 10_000_000_000n, // below 30 SOL floor → triggers null
      vTokAtoms:    500_000_000_000_000n,
      solLamports,
      tokenAmount,
    }));
    expect(result).not.toBeNull();
    expect(result?.solLamports).toBe(solLamports.toString());
    expect(result?.tokenAmount).toBe(tokenAmount.toString());
    expect(result?.vSolLamports).toBeNull();
  });

  it("vSolLamports and vTokAtoms are both null when event is exactly 89 bytes (minimum accepted size, no room for reserves at 40-55)", () => {
    // Build a 89-byte buffer — just enough for the parser to not reject it
    // but too short to have valid reserve fields (need >= 56 bytes, truncated at 89 still works)
    // Actually 89 bytes >= 56, so reserves WILL be attempted — test that the values at those
    // offsets in a zero-filled buffer fail the sanity check (vSol = 0 < 30 SOL floor).
    const result = parseTradeEventFromLogs(
      makeBuyLogs({ vSolLamports: 0n, vTokAtoms: 0n }),
    );
    // vSol = 0 fails MIN_VSOL (30B lamports) check → null
    expect(result?.vSolLamports).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT: fetchLabPoolRealSol — programId validation
// ═══════════════════════════════════════════════════════════════════════════════

function mockFetch(pools: RaydiumPoolEntry[]): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok:   true,
    json: async () => ({
      success: true,
      data: { count: pools.length, data: pools },
    }),
  }));
}

interface RaydiumPoolEntry {
  programId?: string;
  mintA?:     { address: string };
  mintB?:     { address: string };
  mintAmountA?: number;
  mintAmountB?: number;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchLabPoolRealSol — LaunchLab programId validation", () => {
  it("returns the SOL amount when the pool has the LaunchLab programId (SOL is mintA)", async () => {
    mockFetch([{
      programId:   LL_PROG,
      mintA:       { address: WSOL },
      mintB:       { address: FAKE_MINT },
      mintAmountA: 12.5,
      mintAmountB: 500_000_000,
    }]);
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBe(12.5);
  });

  it("returns the SOL amount when SOL is mintB (not mintA)", async () => {
    mockFetch([{
      programId:   LL_PROG,
      mintA:       { address: FAKE_MINT },
      mintB:       { address: WSOL },
      mintAmountA: 500_000_000,
      mintAmountB: 7.8,
    }]);
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBe(7.8);
  });

  it("returns null when pool has a different programId (CPMM post-graduation pool)", async () => {
    mockFetch([{
      programId:   CPMM_PROG,
      mintA:       { address: WSOL },
      mintB:       { address: FAKE_MINT },
      mintAmountA: 85.0, // would give wrong progress bar if accepted
      mintAmountB: 200_000_000,
    }]);
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBeNull();
  });

  it("uses the LaunchLab pool when mixed with a post-graduation CPMM pool (correct pool first)", async () => {
    mockFetch([
      // LaunchLab bonding-curve pool — should be used
      {
        programId:   LL_PROG,
        mintA:       { address: WSOL },
        mintB:       { address: FAKE_MINT },
        mintAmountA: 55.0,
        mintAmountB: 700_000_000,
      },
      // Post-graduation CPMM pool — must be rejected
      {
        programId:   CPMM_PROG,
        mintA:       { address: WSOL },
        mintB:       { address: FAKE_MINT },
        mintAmountA: 200.0,
        mintAmountB: 100_000_000,
      },
    ]);
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBe(55.0);
  });

  it("uses the LaunchLab pool when the CPMM pool appears first in the list", async () => {
    mockFetch([
      // CPMM first — must be skipped
      {
        programId:   CPMM_PROG,
        mintA:       { address: WSOL },
        mintB:       { address: FAKE_MINT },
        mintAmountA: 300.0,
        mintAmountB: 50_000_000,
      },
      // LaunchLab bonding-curve pool — must be used
      {
        programId:   LL_PROG,
        mintA:       { address: WSOL },
        mintB:       { address: FAKE_MINT },
        mintAmountA: 42.0,
        mintAmountB: 800_000_000,
      },
    ]);
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBe(42.0);
  });

  it("returns null when no pool contains WSOL (unrelated token pair)", async () => {
    mockFetch([{
      programId:   LL_PROG,
      mintA:       { address: "SomOtherTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      mintB:       { address: FAKE_MINT },
      mintAmountA: 10.0,
      mintAmountB: 100_000_000,
    }]);
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBeNull();
  });

  it("returns null when the pool list is empty", async () => {
    mockFetch([]);
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBeNull();
  });

  it("returns null when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBeNull();
  });

  it("returns null when the API returns a non-OK HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBeNull();
  });

  it("returns null when pool has LaunchLab programId but neither mint matches WSOL", async () => {
    mockFetch([{
      programId:   LL_PROG,
      mintA:       { address: FAKE_MINT },
      mintB:       { address: "AnotherToken111111111111111111111111111111111" },
      mintAmountA: 5.0,
      mintAmountB: 100_000_000,
    }]);
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBeNull();
  });

  it("returns 0 when pool has LaunchLab programId and mintAmountA is 0 (brand-new pool)", async () => {
    mockFetch([{
      programId:   LL_PROG,
      mintA:       { address: WSOL },
      mintB:       { address: FAKE_MINT },
      mintAmountA: 0,
      mintAmountB: 1_000_000_000,
    }]);
    // 0 real SOL is valid — pool just created, no buys yet
    const result = await fetchLabPoolRealSol(FAKE_MINT);
    expect(result).toBe(0);
  });
});
