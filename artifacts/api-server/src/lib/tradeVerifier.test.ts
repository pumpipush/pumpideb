/**
 * tradeVerifier.test.ts
 *
 * Unit tests for fetchAndParseTrade() — all RPC calls are mocked via
 * vi.stubGlobal so no real network requests are made.
 *
 * Coverage:
 *   ✓ Valid buy / sell — native SOL consideration + pump.fun instruction
 *   ✓ Valid buy — WSOL consideration (Jupiter-style)
 *   ✓ Valid sell — WSOL consideration
 *   ✓ Fresh ATA (no pre-balance entry)
 *   ✓ Multiple ATAs for same mint+owner — aggregated correctly
 *   ✓ blockTime propagated; null when absent
 *   ✓ Wrong mint → 409
 *   ✓ Zero token delta → 409
 *   ✓ Missing owner field → 409 (NOT fallback to arbitrary account)
 *   ✓ Mint owned by different wallet → 409
 *   ✓ No swap program in instructions (SPL+System only) → 409 [bypass prevention]
 *   ✓ Transfer + unrelated SOL movement, no swap program → 409 [bypass prevention]
 *   ✓ WSOL movement outside swap instruction accounts → 409 [bypass prevention]
 *   ✓ Swap instruction found in inner instructions
 *   ✓ Wrong fee payer → 403
 *   ✓ Null RPC result → 404
 *   ✓ Reverted tx → 422
 *   ✓ Null meta → 503
 *   ✓ Empty accountKeys → 503
 *   ✓ All RPCs unreachable → 503
 *   ✓ Primary HTTP 500 then secondary throws → 503
 *   ✓ Primary RPC-level error skipped, secondary succeeds
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAndParseTrade } from "./tradeVerifier.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const TRADER         = "Gxyz1111111111111111111111111111111111111111";
const MINT           = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_MINT     = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const WSOL_MINT      = "So11111111111111111111111111111111111111112";
const OTHER_WALLET   = "Other111111111111111111111111111111111111111";
const SIG            = "5J2kbXY6UHX1rWN3VFuZaX4G1kYuBP9Q7jmU1RJRWtZGRMwBUCW1k6nA7HKpfnPEJdFKxyxCUW2eG6";

// Well-known program IDs
const PUMP_FUN       = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SPL_TOKEN      = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROG    = "11111111111111111111111111111111";
const JUPITER_V6     = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

// ── Fixture builder ───────────────────────────────────────────────────────────

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface RpcIx {
  programIdIndex: number;
  accounts: number[];
  data?: string;
}

interface InnerIxSet {
  index: number;
  instructions: RpcIx[];
}

interface RpcOverrides {
  err?: unknown;
  meta?: Record<string, unknown> | null;
  feePayer?: string;
  /** Full accountKeys override — index 0 is always fee payer */
  accountKeys?: string[];
  /** Top-level instructions */
  instructions?: RpcIx[];
  /** Inner instructions */
  innerInstructions?: InnerIxSet[];
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
  preBalances?: number[];
  postBalances?: number[];
  fee?: number;
  blockTime?: number | null;
}

/**
 * Build a minimal valid RPC JSON-RPC response.
 *
 * Defaults:
 *   accountKeys : [TRADER, SPL_TOKEN, PUMP_FUN]
 *   instructions: pump.fun ix at programIdIndex=2 including accounts [0..6]
 *   preBalances : [200_000_000, 1_000_000]
 *   postBalances: [ 90_000_000, 1_000_000]
 *   fee         : 5000
 *   postTokenBalances: trader received 1_000_000 atoms of MINT (accountIndex 3)
 *
 * accountIndex 3 is in instruction.accounts [0,1,2,3,4,5,6] by default, so
 * the token delta is scoped to the swap instruction.
 */
function buildRpcResponse(overrides: RpcOverrides = {}): unknown {
  const feePayer   = overrides.feePayer ?? TRADER;
  // index 0=feePayer, 1=SPL_TOKEN, 2=PUMP_FUN, then spare slots 3-6
  const accountKeys = overrides.accountKeys ?? [feePayer, SPL_TOKEN, PUMP_FUN, "addr3", "addr4", "addr5", "addr6"];
  // Default swap instruction: pump.fun (index 2) over accounts 0..6
  const instructions = overrides.instructions ?? [
    { programIdIndex: 2, accounts: [0, 1, 2, 3, 4, 5, 6], data: "3Bxs4h1Fz3a3b4he" },
  ];
  const innerInstructions = overrides.innerInstructions ?? [];

  const defaultMeta = {
    err:               overrides.err ?? null,
    fee:               overrides.fee ?? 5000,
    preBalances:       overrides.preBalances  ?? [200_000_000, 1_000_000],
    postBalances:      overrides.postBalances ?? [ 90_000_000, 1_000_000],
    preTokenBalances:  overrides.preTokenBalances  ?? [],
    postTokenBalances: overrides.postTokenBalances ?? [
      // accountIndex 3 is in instruction accounts [0..6]
      { accountIndex: 3, mint: MINT, owner: feePayer, uiTokenAmount: { amount: "1000000" } },
    ],
    innerInstructions,
  };

  return {
    result: {
      blockTime:   overrides.blockTime !== undefined ? overrides.blockTime : 1_700_000_000,
      meta:        overrides.meta !== undefined ? overrides.meta : defaultMeta,
      transaction: {
        message: {
          accountKeys,
          instructions,
        },
      },
    },
  };
}

/** Standard buy: 200M→90M SOL, 5k fee, 1M tokens received at accountIndex 3 */
function buyResponse(overrides: RpcOverrides = {}): unknown {
  return buildRpcResponse({
    preBalances:      [200_000_000, 1_000_000],
    postBalances:     [ 90_000_000, 1_000_000],
    fee: 5000,
    preTokenBalances:  [],
    postTokenBalances: [{ accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "1000000" } }],
    ...overrides,
  });
}

/** Standard sell: 90M→200M SOL, 5k fee, 2M tokens sent at accountIndex 3 */
function sellResponse(overrides: RpcOverrides = {}): unknown {
  return buildRpcResponse({
    preBalances:      [ 90_000_000, 1_000_000],
    postBalances:     [199_995_000, 1_000_000],
    fee: 5000,
    preTokenBalances:  [{ accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "2000000" } }],
    postTokenBalances: [{ accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "0" } }],
    ...overrides,
  });
}

function mockFetch(body: unknown, ok = true): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(body),
  }));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(()  => { vi.unstubAllGlobals(); });

// ── Happy-path ────────────────────────────────────────────────────────────────

describe("fetchAndParseTrade — happy path", () => {
  it("returns server-derived fields for a valid buy (native SOL)", async () => {
    mockFetch(buyResponse({ blockTime: 1_700_000_000 }));
    const result = await fetchAndParseTrade(SIG, MINT, TRADER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isBuy).toBe(true);
    expect(result.tokenAmountAtoms).toBe("1000000");
    // SOL spent = (200_000_000 - 90_000_000) - 5000 = 109_995_000
    expect(result.solAmountLamports).toBe("109995000");
    expect(result.priceEth).toBeTruthy();
    expect(result.blockTime).toBe(1_700_000_000);
  });

  it("returns server-derived fields for a valid sell (native SOL)", async () => {
    mockFetch(sellResponse({ blockTime: 1_700_001_000 }));
    const result = await fetchAndParseTrade(SIG, MINT, TRADER);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isBuy).toBe(false);
    expect(result.tokenAmountAtoms).toBe("2000000");
    // SOL received = (199_995_000 - 90_000_000) + 5000 = 110_000_000
    expect(result.solAmountLamports).toBe("110000000");
    expect(result.blockTime).toBe(1_700_001_000);
  });

  it("handles a fresh ATA (no pre-balance entry) as zero pre-balance", async () => {
    mockFetch(buyResponse());
    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isBuy).toBe(true);
    expect(result.tokenAmountAtoms).toBe("1000000");
  });

  it("aggregates balance deltas across multiple ATAs for same mint+owner", async () => {
    // Trader holds MINT in two ATAs (accountIndex 3 and accountIndex 5)
    // Both must be within the swap instruction's account set [0..6]
    mockFetch(buildRpcResponse({
      preTokenBalances: [
        { accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "1000000" } },
        { accountIndex: 5, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "500000"  } },
      ],
      postTokenBalances: [
        { accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "2000000" } },
        { accountIndex: 5, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "500000"  } }, // unchanged
      ],
      // pump.fun ix covers accounts [0..6], so both ATAs are in scope
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isBuy).toBe(true);
    // Total token delta: (2000000-1000000) + (500000-500000) = 1000000
    expect(result.tokenAmountAtoms).toBe("1000000");
  });

  it("accepts a WSOL buy when native SOL delta is too small (Jupiter-style)", async () => {
    // Native SOL only drops by the tx fee — actual payment was via WSOL
    // WSOL ATA is at accountIndex 4, within the swap ix accounts [0..6]
    mockFetch(buildRpcResponse({
      accountKeys: [TRADER, SPL_TOKEN, JUPITER_V6, "addr3", "addr4", "addr5", "addr6"],
      preBalances:  [100_005_000, 1_000_000],
      postBalances: [100_000_000, 1_000_000],
      fee: 5000,
      preTokenBalances: [
        { accountIndex: 4, mint: WSOL_MINT, owner: TRADER, uiTokenAmount: { amount: "50000000" } },
      ],
      postTokenBalances: [
        { accountIndex: 3, mint: MINT,      owner: TRADER, uiTokenAmount: { amount: "1000000"  } },
        { accountIndex: 4, mint: WSOL_MINT, owner: TRADER, uiTokenAmount: { amount: "0"        } },
      ],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isBuy).toBe(true);
    expect(result.solAmountLamports).toBe("50000000"); // WSOL delta
  });

  it("accepts a WSOL sell when native SOL barely changes", async () => {
    mockFetch(buildRpcResponse({
      accountKeys: [TRADER, SPL_TOKEN, JUPITER_V6, "addr3", "addr4", "addr5", "addr6"],
      preBalances:  [100_000_000, 1_000_000],
      postBalances: [ 99_995_000, 1_000_000],
      fee: 5000,
      preTokenBalances: [
        { accountIndex: 3, mint: MINT,      owner: TRADER, uiTokenAmount: { amount: "2000000" } },
        { accountIndex: 4, mint: WSOL_MINT, owner: TRADER, uiTokenAmount: { amount: "0"       } },
      ],
      postTokenBalances: [
        { accountIndex: 3, mint: MINT,      owner: TRADER, uiTokenAmount: { amount: "0"        } },
        { accountIndex: 4, mint: WSOL_MINT, owner: TRADER, uiTokenAmount: { amount: "80000000" } },
      ],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isBuy).toBe(false);
    expect(result.solAmountLamports).toBe("80000000");
  });

  it("finds a swap program in inner instructions", async () => {
    // Top-level instruction is Jupiter aggregator (not in SWAP_PROGRAMS here),
    // inner instruction invokes pump.fun
    const ROUTER = "routerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // not in allowlist
    mockFetch(buildRpcResponse({
      accountKeys: [TRADER, SPL_TOKEN, ROUTER, PUMP_FUN, "addr4", "addr5", "addr6"],
      instructions: [
        { programIdIndex: 2, accounts: [0, 1, 2, 3, 4, 5, 6], data: "" }, // ROUTER — not swap
      ],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            // pump.fun at index 3, accounts include 0..6
            { programIdIndex: 3, accounts: [0, 1, 2, 3, 4, 5, 6], data: "" },
          ],
        },
      ],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(true);
  });

  it("blockTime is null when the field is absent from the RPC response", async () => {
    const response = buyResponse() as { result: { blockTime?: number } };
    delete response.result.blockTime;
    mockFetch(response);
    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blockTime).toBeNull();
  });
});

// ── Bypass prevention (adversarial) ───────────────────────────────────────────

describe("fetchAndParseTrade — bypass prevention", () => {
  it("rejects a tx with token change + SOL movement but NO swap program in instructions", async () => {
    // Attacker crafts: SPL transfer of MINT into their account (accountIndex 3)
    //   + System Program transfer of SOL out of their wallet
    // accountKeys: [TRADER, SYSTEM_PROG, SPL_TOKEN]  — no swap program
    mockFetch(buildRpcResponse({
      accountKeys:  [TRADER, SYSTEM_PROG, SPL_TOKEN],
      instructions: [
        { programIdIndex: 1, accounts: [0, 2], data: "" }, // System Program
        { programIdIndex: 2, accounts: [3, 0], data: "" }, // SPL Token
      ],
      preBalances:  [200_000_000, 1_000_000],
      postBalances: [ 90_000_000, 1_000_000],
      preTokenBalances:  [],
      postTokenBalances: [
        { accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "1000000" } },
      ],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/swap program/i);
  });

  it("rejects a tx with WSOL movement from an account NOT in the swap instruction", async () => {
    // WSOL ATA is at accountIndex 9, but the pump.fun instruction only covers [0..6]
    // An attacker moves WSOL out separately and tries to claim it as the SOL consideration
    mockFetch(buildRpcResponse({
      // pump.fun ix covers only [0..6] — accountIndex 9 is OUT of scope
      preBalances:  [100_005_000, 1_000_000],
      postBalances: [100_000_000, 1_000_000],
      fee: 5000,
      preTokenBalances: [
        { accountIndex: 9, mint: WSOL_MINT, owner: TRADER, uiTokenAmount: { amount: "50000000" } },
      ],
      postTokenBalances: [
        { accountIndex: 3, mint: MINT,      owner: TRADER, uiTokenAmount: { amount: "1000000"  } },
        { accountIndex: 9, mint: WSOL_MINT, owner: TRADER, uiTokenAmount: { amount: "0"        } },
      ],
      // default instructions: pump.fun ix with accounts [0,1,2,3,4,5,6]
      // accountIndex 9 is NOT in that set
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/SOL or WSOL consideration/i);
  });
});

// ── Wrong mint ────────────────────────────────────────────────────────────────

describe("fetchAndParseTrade — wrong mint", () => {
  it("returns 409 when transaction only involves a different mint", async () => {
    mockFetch(buildRpcResponse({
      preTokenBalances:  [],
      postTokenBalances: [
        { accountIndex: 3, mint: OTHER_MINT, owner: TRADER, uiTokenAmount: { amount: "1000000" } },
      ],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(MINT);
  });

  it("returns 409 when token delta is zero", async () => {
    mockFetch(buildRpcResponse({
      preTokenBalances:  [{ accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "1000000" } }],
      postTokenBalances: [{ accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "1000000" } }],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });

  it("returns 409 when owner field is absent — never falls back to arbitrary account", async () => {
    // Owner intentionally omitted — must be treated as unprovable ownership
    mockFetch(buildRpcResponse({
      preTokenBalances:  [],
      postTokenBalances: [
        { accountIndex: 3, mint: MINT, uiTokenAmount: { amount: "1000000" } }, // no owner
      ],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/explicitly owned/i);
  });

  it("returns 409 when the mint is owned by a different wallet", async () => {
    mockFetch(buildRpcResponse({
      preTokenBalances:  [{ accountIndex: 3, mint: MINT, owner: OTHER_WALLET, uiTokenAmount: { amount: "0"       } }],
      postTokenBalances: [{ accountIndex: 3, mint: MINT, owner: OTHER_WALLET, uiTokenAmount: { amount: "1000000" } }],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });
});

// ── Plain transfer rejection ──────────────────────────────────────────────────

describe("fetchAndParseTrade — plain token transfer rejection", () => {
  it("returns 409 for a buy-shaped tx where only the fee was deducted from SOL", async () => {
    // Token received, but SOL only dropped by the tx fee — no real SOL payment
    mockFetch(buildRpcResponse({
      preBalances:  [100_005_000, 1_000_000],
      postBalances: [100_000_000, 1_000_000], // only fee removed
      fee: 5000,
      preTokenBalances:  [],
      postTokenBalances: [{ accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "1000000" } }],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/plain token transfer/i);
  });

  it("returns 409 for a sell-shaped tx where the trader's SOL does not increase", async () => {
    // Token sent, but SOL went down (only fee) — no real SOL received
    mockFetch(buildRpcResponse({
      preBalances:  [100_005_000, 1_000_000],
      postBalances: [100_000_000, 1_000_000],
      fee: 5000,
      preTokenBalances:  [{ accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "2000000" } }],
      postTokenBalances: [{ accountIndex: 3, mint: MINT, owner: TRADER, uiTokenAmount: { amount: "0"       } }],
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/plain token transfer/i);
  });
});

// ── Wrong signer ──────────────────────────────────────────────────────────────

describe("fetchAndParseTrade — wrong signer", () => {
  it("returns 403 when fee payer does not match claimedTrader", async () => {
    mockFetch(buildRpcResponse({ feePayer: OTHER_WALLET }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });
});

// ── Transaction failure states ────────────────────────────────────────────────

describe("fetchAndParseTrade — transaction failures", () => {
  it("returns 404 when RPC result is null", async () => {
    mockFetch({ result: null });

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it("returns 422 when transaction reverted (meta.err != null)", async () => {
    mockFetch(buildRpcResponse({ err: { InstructionError: [0, "Custom"] } }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
  });
});

// ── Fail-closed on malformed RPC data ─────────────────────────────────────────

describe("fetchAndParseTrade — malformed RPC responses (fail closed)", () => {
  it("returns 503 when meta is null", async () => {
    mockFetch(buildRpcResponse({ meta: null }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.error).toMatch(/metadata/i);
  });

  it("returns 503 when accountKeys is empty", async () => {
    const response = buildRpcResponse() as { result: { transaction: { message: { accountKeys: string[] } } } };
    response.result.transaction.message.accountKeys = [];
    mockFetch(response);

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
  });

  it("returns 503 when all RPC endpoints throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.error).toMatch(/RPC endpoints/i);
  });

  it("returns 503 when primary HTTP 500 and secondary throws", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      return Promise.reject(new Error("down"));
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
  });

  it("skips RPC-level errors and succeeds on the next endpoint", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ error: { code: -32000 } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(buyResponse()) });
    }));

    const result = await fetchAndParseTrade(SIG, MINT, TRADER);
    expect(result.ok).toBe(true);
    expect(call).toBe(2);
  });
});
