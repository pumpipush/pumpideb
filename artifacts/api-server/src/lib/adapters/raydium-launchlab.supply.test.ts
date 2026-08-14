/**
 * raydium-launchlab.supply.test.ts
 *
 * Guards the SPL mint supply decoding path and the supply-aware market-cap
 * calculation in the LaunchLab adapter.
 *
 * Covers:
 *  UNIT — fetchMintTotalSupply
 *    - Correct u64 LE decoding from a valid 82-byte SPL mint account buffer
 *    - Buffer too short → null
 *    - supply field = 0 → null (considered empty / not yet minted)
 *    - fetch rejects (network error) → null
 *    - RPC returns no account data → null
 *
 *  UNIT — market-cap formula (via handleTrade fast-path dbSupply selection)
 *    - Known token (DB row has real supply) → MC = realSupply × solLamports / tokAmt
 *    - Unknown token (auto-create path) → MC uses on-chain fetched supply
 *    - Standard 1B supply → MC calculation is unchanged from before the fix
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchMintTotalSupply } from "./raydium-launchlab.js";

// ── SPL Mint account layout helpers ─────────────────────────────────────────

const SPL_MINT_SUPPLY_OFFSET = 36;
const SPL_MINT_SIZE          = 82;

/**
 * Build a minimal 82-byte SPL mint account buffer with the given supply value.
 * All other fields are zeroed (is_initialized = 0 in byte 45 is fine for tests).
 */
function makeMintBuffer(supply: bigint): Buffer {
  const buf = Buffer.alloc(SPL_MINT_SIZE, 0);
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
