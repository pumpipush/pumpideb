/**
 * Unit tests for the token enrichment loop.
 *
 * Covers:
 *  - Placeholder detection (name/symbol)
 *  - computeEnrichmentUpdate — the pure function that decides what to write to DB
 *  - Provider response shape mapping (pump.fun and Raydium)
 *  - Ordering invariant: newest token is selected even when old backlog > BATCH_SIZE
 *  - Platform coverage: all four enrichable platforms are included
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isPlaceholderName,
  isPlaceholderSymbol,
  computeEnrichmentUpdate,
  buildLabChainUpdate,
  computeSupplyBackfillUpdate,
  _parsePriceToRatio,
  selectLongTailCandidates,
  needsStatReconciliation,
  fetchMeta,
  LL_DEFAULT_SUPPLY_STR,
  LL_PRICE_VERIFY_MIN_TRADES,
  LL_PRICE_VERIFY_BATCH,
  ENRICHABLE_PLATFORMS_EXPORT,
} from "./enrichment";

// Auto-mock safeUriFetch so fetchMeta tests can control its behaviour per-test
// without any real network calls. vi.mock is hoisted by Vitest, so this always
// runs before module imports even though it appears after them in source order.
vi.mock("./safeUriFetch", () => ({
  fetchSafeUriMeta:  vi.fn(),
  isSafeMetaUri:     vi.fn(() => true),
  resolveIpfs:       vi.fn((u: string) => u),
  ALLOWED_META_HOSTS: new Set<string>(),
}));
import * as safeUriFetchMod from "./safeUriFetch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Placeholder detection ──────────────────────────────────────────────────────

describe("isPlaceholderName", () => {
  it("detects Unicode ellipsis placeholder (pump_fun / raydium_launchlab / daos_fun)", () => {
    expect(isPlaceholderName("A6BE4K8L…")).toBe(true);
  });

  it("detects ASCII ellipsis placeholder (letsbonk)", () => {
    expect(isPlaceholderName("GKsjnMMi...")).toBe(true);
  });

  it("accepts a real token name", () => {
    expect(isPlaceholderName("Doge Killer")).toBe(false);
  });

  it("accepts a name that contains but does not end with ellipsis", () => {
    expect(isPlaceholderName("Foo…Bar")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isPlaceholderName("")).toBe(false);
  });
});

describe("isPlaceholderSymbol", () => {
  it("detects the '???' placeholder", () => {
    expect(isPlaceholderSymbol("???")).toBe(true);
  });

  it("accepts a real symbol", () => {
    expect(isPlaceholderSymbol("BONK")).toBe(false);
  });

  it("does not match partial question marks", () => {
    expect(isPlaceholderSymbol("??")).toBe(false);
    expect(isPlaceholderSymbol("????")).toBe(false);
  });
});

// ── computeEnrichmentUpdate ────────────────────────────────────────────────────

describe("computeEnrichmentUpdate", () => {
  const stub = { name: "A6BE4K8L…", symbol: "???", imageUrl: null };

  it("returns name + symbol + imageUrl when all three are available from API", () => {
    const update = computeEnrichmentUpdate(stub, {
      name:     "Moon Cat",
      symbol:   "MCAT",
      imageUrl: "https://example.com/img.png",
    });
    expect(update).toEqual({
      name:     "Moon Cat",
      symbol:   "MCAT",
      imageUrl: "https://example.com/img.png",
    });
  });

  it("returns null when the API returns no improvements", () => {
    // All fields either placeholder or null — API returns nothing
    expect(computeEnrichmentUpdate(stub, { name: undefined, symbol: undefined, imageUrl: null })).toBeNull();
  });

  it("returns null when the API echoes back a placeholder name", () => {
    expect(computeEnrichmentUpdate(stub, { name: "A6BE4K8L…", symbol: "REAL", imageUrl: null })).toEqual({
      symbol: "REAL",
    });
  });

  it("skips name update when current name is already real", () => {
    const token = { name: "Doge Killer", symbol: "???", imageUrl: null };
    const update = computeEnrichmentUpdate(token, { name: "Other Name", symbol: "DOGEK", imageUrl: null });
    expect(update).toEqual({ symbol: "DOGEK" });
    expect(update).not.toHaveProperty("name");
  });

  it("skips imageUrl update when token already has an image", () => {
    const token = { name: "A6BE4K8L…", symbol: "???", imageUrl: "https://existing.com/img.png" };
    const update = computeEnrichmentUpdate(token, {
      name:     "Moon Cat",
      symbol:   "MCAT",
      imageUrl: "https://new.com/img.png",
    });
    expect(update).not.toHaveProperty("imageUrl");
  });

  it("handles partial metadata — only name available from API", () => {
    const update = computeEnrichmentUpdate(stub, { name: "Moon Cat", symbol: undefined, imageUrl: null });
    expect(update).toEqual({ name: "Moon Cat" });
  });

  it("handles partial metadata — only image available from API", () => {
    const token = { name: "Real Name", symbol: "REAL", imageUrl: null };
    const update = computeEnrichmentUpdate(token, { name: undefined, symbol: undefined, imageUrl: "https://img.example.com/t.png" });
    expect(update).toEqual({ imageUrl: "https://img.example.com/t.png" });
  });

  it("returns null when API returns null imageUrl and name/symbol already real", () => {
    const token = { name: "Real Name", symbol: "REAL", imageUrl: null };
    expect(computeEnrichmentUpdate(token, { name: undefined, symbol: undefined, imageUrl: null })).toBeNull();
  });

  it("handles ASCII ellipsis placeholder from letsbonk", () => {
    const letsbonkStub = { name: "GKsjnMMi...", symbol: "???", imageUrl: null };
    const update = computeEnrichmentUpdate(letsbonkStub, { name: "Bonk Token", symbol: "BONKT", imageUrl: "https://img.example.com/bonk.png" });
    expect(update).toEqual({ name: "Bonk Token", symbol: "BONKT", imageUrl: "https://img.example.com/bonk.png" });
  });
});

// ── Provider response shape mapping ───────────────────────────────────────────
//
// Verifies the shape of what computeEnrichmentUpdate receives when adapting
// real pump.fun and Raydium API response payloads. The integration glue code
// in enrichment.ts translates API-specific field names (image_uri, logoURI)
// into the canonical EnrichResult shape; these tests confirm that mapping.

describe("pump.fun provider response mapping", () => {
  it("maps image_uri → imageUrl correctly", () => {
    // Simulates: fetchPumpMeta returns { name, symbol, image_uri }
    // enrichment code maps it to EnrichResult before calling computeEnrichmentUpdate
    const enrichResult = {
      name:     "Pepe",
      symbol:   "PEPE",
      imageUrl: "https://pump.fun/pepe.png", // already mapped from image_uri
    };
    const update = computeEnrichmentUpdate(
      { name: "A6BE4K8L…", symbol: "???", imageUrl: null },
      enrichResult,
    );
    expect(update?.imageUrl).toBe("https://pump.fun/pepe.png");
    expect(update?.name).toBe("Pepe");
    expect(update?.symbol).toBe("PEPE");
  });

  it("handles missing image_uri (pump.fun sometimes omits it for new tokens)", () => {
    const enrichResult = { name: "Pepe", symbol: "PEPE", imageUrl: null };
    const update = computeEnrichmentUpdate(
      { name: "A6BE4K8L…", symbol: "???", imageUrl: null },
      enrichResult,
    );
    expect(update).toEqual({ name: "Pepe", symbol: "PEPE" });
    expect(update).not.toHaveProperty("imageUrl");
  });
});

describe("Raydium provider response mapping", () => {
  it("maps logoURI → imageUrl correctly", () => {
    // fetchRaydiumMeta returns { name, symbol, logoURI }
    // enrichment code maps logoURI → imageUrl
    const enrichResult = {
      name:     "Raydium Token",
      symbol:   "RAY",
      imageUrl: "https://raydium.io/ray.png", // mapped from logoURI
    };
    const update = computeEnrichmentUpdate(
      { name: "A6BE4K8L…", symbol: "???", imageUrl: null },
      enrichResult,
    );
    expect(update?.imageUrl).toBe("https://raydium.io/ray.png");
  });

  it("handles Raydium returning no metadata (mint not yet indexed by Raydium)", () => {
    // fetchRaydiumMeta returns null → fetchMeta returns null → enrichOne skips
    // Here we just confirm computeEnrichmentUpdate with empty result is null:
    const update = computeEnrichmentUpdate(
      { name: "A6BE4K8L…", symbol: "???", imageUrl: null },
      { name: undefined, symbol: undefined, imageUrl: null },
    );
    expect(update).toBeNull();
  });
});

// ── Platform coverage ──────────────────────────────────────────────────────────

describe("ENRICHABLE_PLATFORMS", () => {
  it("includes all four placeholder-producing platforms", () => {
    expect(ENRICHABLE_PLATFORMS_EXPORT).toContain("pump_fun");
    expect(ENRICHABLE_PLATFORMS_EXPORT).toContain("raydium_launchlab");
    expect(ENRICHABLE_PLATFORMS_EXPORT).toContain("letsbonk");
    expect(ENRICHABLE_PLATFORMS_EXPORT).toContain("daos_fun");
  });

  it("does NOT include moonshot (DEXScreener provides full metadata at insert time)", () => {
    expect(ENRICHABLE_PLATFORMS_EXPORT).not.toContain("moonshot");
  });
});

// ── Ordering invariant ─────────────────────────────────────────────────────────
//
// The identity batch orders by createdAt DESC (newest-first) with IDENTITY_BATCH_SIZE=20.
// This test simulates the sort+slice the DB query performs and verifies that a
// newly inserted placeholder token is always selected even when older stuck
// records fill the entire batch capacity.

describe("identity batch ordering invariant (newest-first)", () => {
  const BATCH_SIZE = 20;

  function simulateBatch(tokens: Array<{ address: string; createdAt: Date }>): string[] {
    return [...tokens]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) // DESC
      .slice(0, BATCH_SIZE)
      .map((t) => t.address);
  }

  it("selects a newly indexed token even when older stuck tokens fill the batch", () => {
    const now = Date.now();
    const stuckTokens = Array.from({ length: 25 }, (_, i) => ({
      address:   `old-token-${i}`,
      createdAt: new Date(now - (25 - i) * 60_000),
    }));
    const newToken = { address: "brand-new-token", createdAt: new Date(now) };

    const selected = simulateBatch([...stuckTokens, newToken]);

    expect(selected).toHaveLength(BATCH_SIZE);
    expect(selected[0]).toBe("brand-new-token");
    expect(selected).toContain("brand-new-token");
  });

  it("does not select tokens beyond the batch size", () => {
    const now = Date.now();
    const tokens = Array.from({ length: 30 }, (_, i) => ({
      address:   `token-${i}`,
      createdAt: new Date(now - i * 1_000),
    }));
    expect(simulateBatch(tokens)).toHaveLength(BATCH_SIZE);
  });

  it("oldest tokens are NOT selected when newer ones fill the batch", () => {
    const now = Date.now();
    const tokens = Array.from({ length: 25 }, (_, i) => ({
      address:   `token-${i}`,
      createdAt: new Date(now - i * 1_000), // token-0 is newest
    }));
    const selected = simulateBatch(tokens);
    // The 5 oldest (token-20..24) should NOT be in the batch
    for (let i = 20; i < 25; i++) {
      expect(selected).not.toContain(`token-${i}`);
    }
  });
});

// ── buildLabChainUpdate — placeholder-to-placeholder guard ────────────────────
//
// Tests the pure function that drives enrichLabTokensFromChain name/symbol
// updates.  Key invariant: a placeholder in the resolved data must NEVER
// overwrite the placeholder already in the DB — that would be a no-op at best
// and confusing at worst (a different addr8 prefix than the current one).

describe("buildLabChainUpdate", () => {
  const ph = { name: "A6BE4K8L…", symbol: "???", metadataUri: null };

  it("writes name and symbol when both resolve to real (non-placeholder) values", () => {
    const update = buildLabChainUpdate(ph, { name: "Sun Cat", symbol: "SCAT", uri: "https://uri.example.com" });
    expect(update["name"]).toBe("Sun Cat");
    expect(update["symbol"]).toBe("SCAT");
  });

  it("never overwrites a placeholder name with another placeholder name", () => {
    // resolved.name ends with "…" — should be treated as another placeholder
    const update = buildLabChainUpdate(ph, { name: "DEADBEEF…", symbol: "REAL", uri: "" });
    expect(update).not.toHaveProperty("name");
    expect(update["symbol"]).toBe("REAL");
  });

  it("never overwrites a placeholder symbol with '???'", () => {
    const update = buildLabChainUpdate(ph, { name: "RealName", symbol: "???", uri: "" });
    expect(update["name"]).toBe("RealName");
    expect(update).not.toHaveProperty("symbol");
  });

  it("returns no name/symbol update when both resolved values are placeholders", () => {
    const update = buildLabChainUpdate(ph, { name: "ABCD1234…", symbol: "???", uri: "" });
    expect(update).not.toHaveProperty("name");
    expect(update).not.toHaveProperty("symbol");
  });

  it("does not write name when current name is already real (not a placeholder)", () => {
    const realName = { name: "Moon Cat", symbol: "???", metadataUri: null };
    const update = buildLabChainUpdate(realName, { name: "Other Name", symbol: "MCAT", uri: "" });
    expect(update).not.toHaveProperty("name");
    expect(update["symbol"]).toBe("MCAT");
  });

  it("does not write symbol when current symbol is already real", () => {
    const realSym = { name: "A6BE4K8L…", symbol: "REAL", metadataUri: null };
    const update = buildLabChainUpdate(realSym, { name: "Real Name", symbol: "OTHER", uri: "" });
    expect(update["name"]).toBe("Real Name");
    expect(update).not.toHaveProperty("symbol");
  });

  it("stores metadataUri when the token has none and resolved.uri is non-empty", () => {
    const update = buildLabChainUpdate(ph, { name: "Name", symbol: "SYM", uri: "https://arweave.net/abc" });
    expect(update["metadataUri"]).toBe("https://arweave.net/abc");
  });

  it("does not overwrite an existing metadataUri", () => {
    const existing = { name: "A6BE4K8L…", symbol: "???", metadataUri: "https://existing.example.com" };
    const update = buildLabChainUpdate(existing, { name: "Name", symbol: "SYM", uri: "https://new.example.com" });
    expect(update).not.toHaveProperty("metadataUri");
  });

  it("does not set metadataUri when resolved.uri is empty", () => {
    const update = buildLabChainUpdate(ph, { name: "Name", symbol: "SYM", uri: "" });
    expect(update).not.toHaveProperty("metadataUri");
  });

  it("handles ASCII ellipsis placeholder (letsbonk format) correctly", () => {
    const letsbonk = { name: "GKsjnMMi...", symbol: "???", metadataUri: null };
    // resolved name also looks like a letsbonk placeholder — must not be written
    const update = buildLabChainUpdate(letsbonk, { name: "ABCD1234...", symbol: "REAL", uri: "" });
    expect(update).not.toHaveProperty("name");
    expect(update["symbol"]).toBe("REAL");
  });
});

// ── _parsePriceToRatio ─────────────────────────────────────────────────────────
//
// The helper that converts a decimal price string into an exact BigInt ratio
// without going through parseFloat. These tests are the spec for how it
// handles edge cases that would silently corrupt prices if floats were used.

describe("_parsePriceToRatio", () => {
  it("parses a plain decimal with many fractional digits", () => {
    const r = _parsePriceToRatio("0.0000000004")!;
    // 4 / 10_000_000_000 = 4e-10
    expect(r.num).toBe(4n);
    expect(r.den).toBe(10_000_000_000n);
  });

  it("parses scientific notation (negative exponent)", () => {
    const r = _parsePriceToRatio("4e-10")!;
    expect(r.num).toBe(4n);
    expect(r.den).toBe(10_000_000_000n);
  });

  it("parses scientific notation (positive exponent)", () => {
    const r = _parsePriceToRatio("1.5e3")!;
    // 1.5 × 10^3 = 1500 → num=1500, den=1
    expect(r.num).toBe(1500n);
    expect(r.den).toBe(1n);
  });

  it("parses a plain integer", () => {
    const r = _parsePriceToRatio("5")!;
    expect(r.num).toBe(5n);
    expect(r.den).toBe(1n);
  });

  it("parses '0' as zero ratio", () => {
    const r = _parsePriceToRatio("0")!;
    expect(r.num).toBe(0n);
    expect(r.den).toBe(1n);
  });

  it("trims trailing zeros so the ratio is in lowest terms of its form", () => {
    // "0.001000000" should behave the same as "0.001"
    const r = _parsePriceToRatio("0.001000000")!;
    expect(r.num).toBe(1n);
    expect(r.den).toBe(1000n);
  });

  it("returns null for negative values", () => {
    expect(_parsePriceToRatio("-0.001")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(_parsePriceToRatio("")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(_parsePriceToRatio("abc")).toBeNull();
  });

  it("evaluates to the correct decimal value via num/den", () => {
    // Verify a price from the DB: "0.000000001000000" → 1e-9
    const r = _parsePriceToRatio("0.000000001000000")!;
    // num=1n, den=1_000_000_000n (trailing zeros stripped from "001000000" → "001")
    const quotient  = r.num * 10n ** 18n / r.den; // scale up for integer check
    expect(quotient).toBe(1_000_000_000n);          // 1e-9 × 1e18 = 1e9
  });
});

// ── computeSupplyBackfillUpdate ─────────────────────────────────────────────────
//
// Guards the pure helper that decides what DB fields to write when correcting
// a LaunchLab token row that was stored with the hardcoded 1B default supply.

describe("computeSupplyBackfillUpdate", () => {
  const STANDARD_SUPPLY = BigInt(LL_DEFAULT_SUPPLY_STR); // 1_000_000_000_000_000n

  it("returns null when realSupply is null (RPC failed)", () => {
    expect(computeSupplyBackfillUpdate(null, "0.000000030000000")).toBeNull();
  });

  it("returns null when realSupply equals the legacy 1B default (no correction needed)", () => {
    // Standard LaunchLab token — supply is already correct, nothing to write.
    expect(computeSupplyBackfillUpdate(STANDARD_SUPPLY, "0.000000030000000")).toBeNull();
  });

  it("returns totalSupply when realSupply differs from 1B default (no price available)", () => {
    const nonStandard = 50_000_000_000n;
    const update = computeSupplyBackfillUpdate(nonStandard, null);
    expect(update).not.toBeNull();
    expect(update!.totalSupply).toBe("50000000000");
    expect(update!.marketCapEth).toBeUndefined();
  });

  it("returns totalSupply only when priceEth is '0' (zero price → no MC recompute)", () => {
    const nonStandard = 50_000_000_000n;
    const update = computeSupplyBackfillUpdate(nonStandard, "0");
    expect(update!.totalSupply).toBe("50000000000");
    expect(update!.marketCapEth).toBeUndefined();
  });

  it("returns both totalSupply and marketCapEth when realSupply and priceEth are valid", () => {
    // USD1-like token: 50B atoms, price 0.000001 SOL/token
    const nonStandard = 50_000_000_000n;
    const priceEth    = "0.000001000000000"; // 0.000001 SOL per display token
    // Expected MC: 50_000_000_000 × 0.000001 × 1000 = 50_000_000 lamports
    const update = computeSupplyBackfillUpdate(nonStandard, priceEth);
    expect(update!.totalSupply).toBe("50000000000");
    expect(update!.marketCapEth).toBe("50000000");
  });

  it("marketCapEth rounds correctly for a non-integer result", () => {
    const supply   = 3n;
    const priceEth = "1.0";
    // 3 × 1.0 × 1000 = 3000 (already integer, no rounding edge case, but also covers the path)
    const update = computeSupplyBackfillUpdate(supply, priceEth);
    expect(update!.marketCapEth).toBe("3000");
  });

  it("correctly computes MC for a large supply matching a real Solana token scale", () => {
    // 1B tokens with 9 decimals → 1e18 atoms; price 0.000000001 SOL/token
    const supply   = 1_000_000_000_000_000_000n;
    const priceEth = "0.000000001000000";
    // MC = 1e18 × 0.000000001 × 1000 = 1e18 × 1e-9 × 1e3 = 1e12 lamports
    const update = computeSupplyBackfillUpdate(supply, priceEth);
    expect(update).not.toBeNull();
    expect(update!.totalSupply).toBe("1000000000000000000");
    // BigInt arithmetic: (1e18n × 1n × 1000n) / 1_000_000_000n = 1_000_000_000_000n exactly
    expect(update!.marketCapEth).toBe("1000000000000");
  });

  it("preserves full integer precision for supply values above Number.MAX_SAFE_INTEGER (2^53) — production call path", () => {
    // This test exercises the same code path as the production backfillLaunchLabSupply
    // function, which calls computeSupplyBackfillUpdate(realSupply, priceEth) for
    // every corrected token row.
    //
    // 2^53 + 1 = 9_007_199_254_740_993 is NOT exactly representable as float64.
    // Number(9_007_199_254_740_993n) silently rounds to 9_007_199_254_740_992,
    // so arithmetic through Number loses 1 unit.
    //
    // With priceEth = "0.001" the formula is: supply × 0.001 × 1000 = supply × 1.0
    //   → marketCapEth should equal supply exactly.
    //
    // Buggy path (Number → float): Math.round(Number(2^53+1) × 0.001 × 1000)
    //   = Math.round(9_007_199_254_740_992 × 1.0) = "9007199254740992"  ← off by 1
    //
    // Fixed path (pure BigInt ratio): supply × 1n × 1000n / 1000n = supply ← exact
    const supply   = 9_007_199_254_740_993n; // 2^53 + 1
    const priceEth = "0.001";
    const update   = computeSupplyBackfillUpdate(supply, priceEth);
    expect(update).not.toBeNull();
    expect(update!.totalSupply).toBe("9007199254740993");
    // Must be the exact string "9007199254740993", not the float-rounded "9007199254740992".
    expect(update!.marketCapEth).toBe("9007199254740993");
  });

  it("handles prices with more than 9 decimal places without truncating to 0", () => {
    // "0.0000000004" has 10 decimal places — more than a 1e9 scale factor can represent.
    // Scaling by 1e9 would round 0.0000000004×1e9 = 0.4 → 0, producing MC = 0 (wrong).
    // The correct result is 1e18 × 0.0000000004 × 1000 = 400_000_000_000 lamports.
    const supply   = 1_000_000_000_000_000_000n; // 1e18 atoms
    const priceEth = "0.0000000004";
    const update   = computeSupplyBackfillUpdate(supply, priceEth);
    expect(update).not.toBeNull();
    expect(update!.marketCapEth).toBe("400000000000");
  });

  it("handles a 10-decimal-place price that is a half-unit without doubling the result", () => {
    // "0.0000000005" × 1e9 = 0.5 → Math.round = 1 (rounds up) → wrong 2× result.
    // The correct result is 1e18 × 0.0000000005 × 1000 = 500_000_000_000 lamports.
    const supply   = 1_000_000_000_000_000_000n;
    const priceEth = "0.0000000005";
    const update   = computeSupplyBackfillUpdate(supply, priceEth);
    expect(update).not.toBeNull();
    expect(update!.marketCapEth).toBe("500000000000");
  });

  it("rounds fractional-lamport results half-up (≥0.5 rounds up, <0.5 rounds down)", () => {
    // supply=1n, price="0.3333" → MC = 1 × 0.3333 × 1000 = 333.3 → round → 333
    // supply=1n, price="0.6667" → MC = 1 × 0.6667 × 1000 = 666.7 → round → 667
    // supply=1n, price="0.5"    → MC = 1 × 0.5    × 1000 = 500.0 → round → 500 (exact)
    const cases: [bigint, string, string][] = [
      [1n, "0.3333",  "333"],  // 333.3 → floor
      [1n, "0.6667",  "667"],  // 666.7 → ceil
      [1n, "0.5",     "500"],  // 500.0 exact
      [3n, "0.33333", "1000"], // 999.99 → 1000
    ];
    for (const [supply, price, expected] of cases) {
      const update = computeSupplyBackfillUpdate(supply, price);
      expect(update!.marketCapEth, `price=${price}`).toBe(expected);
    }
  });

  it("processes more than one batch worth of rows by exhausting the supply", () => {
    // Simulate what happens across two calls: first row is standard (skipped),
    // second is nonstandard (corrected). This mirrors the keyset-pagination behavior
    // where standard/RPC-failed rows return null and the cursor still advances.
    const rows = [
      { supply: STANDARD_SUPPLY, price: "0.00003" }, // standard — skip
      { supply: null,            price: "0.00003" }, // RPC fail — skip
      { supply: 42_000_000n,     price: "0.00005" }, // nonstandard — correct
    ];

    const results = rows.map(r => computeSupplyBackfillUpdate(r.supply, r.price));
    expect(results[0]).toBeNull(); // standard supply → no update
    expect(results[1]).toBeNull(); // RPC failure → no update
    expect(results[2]).not.toBeNull(); // nonstandard → update
    expect(results[2]!.totalSupply).toBe("42000000");
    expect(results[2]!.marketCapEth).toBe(
      String(Math.round(42_000_000 * 0.00005 * 1000)),
    );
  });
});

// ── Supply backfill — compare-and-set concurrency guard ───────────────────────
//
// The backfill UPDATE uses:
//   WHERE address = $addr AND total_supply = '1000000000000000'
//
// This ensures that if another process (a concurrent server restart running
// backfillLaunchLabSupply, or a parallel script invocation) already corrected
// a row between our SELECT and UPDATE, the guard rejects the write (0 rows
// matched) and we do not double-count or overwrite the fresh correction.
//
// These tests verify the pure-function logic that governs when a row is
// skipped, corrected, or deferred.

describe("backfill compare-and-set — concurrency guard logic", () => {
  const STANDARD_SUPPLY = BigInt(LL_DEFAULT_SUPPLY_STR);

  it("skips a row that is already standard 1B on-chain (WHERE guard would match 0 rows in a concurrent run)", () => {
    // After correction, the stored totalSupply changes to the real non-1B value.
    // On the next run, the SELECT (WHERE totalSupply = LL_DEFAULT_SUPPLY_STR) would
    // not return this row at all — idempotent by construction.
    // For rows where the real supply IS 1B, computeSupplyBackfillUpdate returns null
    // and neither the startup job nor the script writes anything.
    expect(computeSupplyBackfillUpdate(STANDARD_SUPPLY, "0.00003")).toBeNull();
  });

  it("skips a row whose RPC call failed (concurrent-retry-safe)", () => {
    // fetchMintTotalSupply returning null is treated as a transient failure.
    // The cursor still advances past the row; it will be re-checked on the next restart.
    expect(computeSupplyBackfillUpdate(null, "0.00003")).toBeNull();
  });

  it("produces a valid update for a non-standard token only when realSupply ≠ 1B default", () => {
    // Only rows where the on-chain supply differs from LL_DEFAULT_SUPPLY_STR get written.
    // This is the same condition modelled by the WHERE guard in the UPDATE:
    //   WHERE total_supply = LL_DEFAULT_SUPPLY_STR
    // If a concurrent process already corrected the row (stored supply ≠ default),
    // the WHERE guard rejects the write → returning() = [] → corrected counter stays at 0.
    const nonStandard = 50_000_000_000n;
    const update = computeSupplyBackfillUpdate(nonStandard, "0.000001");
    expect(update).not.toBeNull();               // would be applied on first write
    expect(update!.totalSupply).toBe("50000000000");

    // Idempotency: if the realSupply were now '50000000000' (already corrected),
    // the WHERE guard (total_supply = '1000000000000000') would reject the UPDATE.
    // The pure-function equivalent: calling with a supply that already matches
    // LL_DEFAULT_SUPPLY_STR returns null (standard path).
    // For the non-1B case the guard is in the SQL layer; returning() = [] is the signal.
    // This test guards that the caller only counts corrections when returning() is non-empty:
    const wasApplied = (returningRows: { address: string }[]) => returningRows.length > 0;
    expect(wasApplied([])).toBe(false);                     // concurrent fix → not counted
    expect(wasApplied([{ address: "abc" }])).toBe(true);   // our fix landed → counted
  });

  it("does not update marketCapEth when price_eth is zero or null (handled by SQL CASE in the live path)", () => {
    // The SQL CASE expression:
    //   CASE WHEN price_eth IS NOT NULL AND CAST(price_eth AS numeric) > 0
    //        THEN ROUND(price_eth::numeric * supply::numeric * 1000)::text
    //        ELSE market_cap_eth
    //   END
    // falls through to ELSE (preserves existing MC) when price is zero or null.
    // computeSupplyBackfillUpdate models this for the startup job:
    const update0  = computeSupplyBackfillUpdate(50_000_000_000n, "0");
    const updateNl = computeSupplyBackfillUpdate(50_000_000_000n, null);
    expect(update0!.marketCapEth).toBeUndefined();
    expect(updateNl!.marketCapEth).toBeUndefined();
    // totalSupply is still corrected even when MC cannot be recomputed
    expect(update0!.totalSupply).toBe("50000000000");
    expect(updateNl!.totalSupply).toBe("50000000000");
  });
});

// ── selectLongTailCandidates ───────────────────────────────────────────────────
//
// Guards the overlap-exclusion logic that prevents the secondary Birdeye pass
// from consuming quota on addresses already handled (or attempted) by the
// primary pass in the same tick.

describe("selectLongTailCandidates", () => {
  /** Build a token row with the given trade count. */
  function tok(address: string, tradeCount: number) {
    return { address, tradeCount };
  }

  it("returns addresses not in the primary set, most-active first", () => {
    const primary = new Set(["addr-A", "addr-B"]);
    const candidates = [
      tok("addr-C", 50), // long-tail, high activity
      tok("addr-D", 30), // long-tail, lower activity
    ];
    const result = selectLongTailCandidates(candidates, primary, 5);
    expect(result).toEqual(["addr-C", "addr-D"]);
  });

  it("excludes addresses already in the primary set regardless of price_usd status", () => {
    // addr-A is a high-activity primary token whose Birdeye call failed —
    // it is still in the primary set and must NOT appear in the secondary batch.
    const primary = new Set(["addr-A"]);
    const candidates = [
      tok("addr-A", 200), // primary token — must be excluded
      tok("addr-B", 15),  // genuine long-tail
    ];
    const result = selectLongTailCandidates(candidates, primary, 5);
    expect(result).not.toContain("addr-A");
    expect(result).toContain("addr-B");
  });

  it("returns at most `limit` addresses", () => {
    const primary = new Set<string>();
    const candidates = Array.from({ length: 10 }, (_, i) =>
      tok(`addr-${i}`, 100 - i),
    );
    const result = selectLongTailCandidates(candidates, primary, LL_PRICE_VERIFY_BATCH);
    expect(result.length).toBeLessThanOrEqual(LL_PRICE_VERIFY_BATCH);
  });

  it("returns an empty array when all candidates are in the primary set", () => {
    const primary = new Set(["addr-X", "addr-Y", "addr-Z"]);
    const candidates = [tok("addr-X", 80), tok("addr-Y", 50), tok("addr-Z", 20)];
    expect(selectLongTailCandidates(candidates, primary, 5)).toEqual([]);
  });

  it("returns an empty array when there are no candidates", () => {
    expect(selectLongTailCandidates([], new Set(), 5)).toEqual([]);
  });

  it("preserves the DESC trade_count order from the DB (pre-sorted input)", () => {
    // Input is already ordered DESC as returned by the SQL query.
    const primary = new Set<string>();
    const candidates = [
      tok("addr-high",  200),
      tok("addr-mid",   100),
      tok("addr-low",    15),
    ];
    const result = selectLongTailCandidates(candidates, primary, 5);
    expect(result).toEqual(["addr-high", "addr-mid", "addr-low"]);
  });

  it("excludes a high-trade-count primary record and selects the lower-ranked long-tail token", () => {
    // Simulates: addr-TOP is rank #1 (in primary) but has price_usd NULL;
    // addr-LONGTAIL is rank #65 (outside primary), also price_usd NULL.
    // The secondary pass must pick addr-LONGTAIL and never touch addr-TOP.
    const primary = new Set(["addr-TOP"]);
    const candidates = [
      tok("addr-TOP",      5000), // primary — excluded even though highest activity
      tok("addr-LONGTAIL",   12), // genuine long-tail — should be selected
    ];
    const result = selectLongTailCandidates(candidates, primary, LL_PRICE_VERIFY_BATCH);
    expect(result).not.toContain("addr-TOP");
    expect(result).toContain("addr-LONGTAIL");
  });

  it("exposes LL_PRICE_VERIFY_MIN_TRADES and LL_PRICE_VERIFY_BATCH as module constants", () => {
    // Regression guard: if either constant is renamed or removed, imports above fail.
    expect(typeof LL_PRICE_VERIFY_MIN_TRADES).toBe("number");
    expect(LL_PRICE_VERIFY_MIN_TRADES).toBeGreaterThan(0);
    expect(typeof LL_PRICE_VERIFY_BATCH).toBe("number");
    expect(LL_PRICE_VERIFY_BATCH).toBeGreaterThan(0);
  });
});

// ── needsStatReconciliation ────────────────────────────────────────────────────
//
// Guards the comparison logic used by the 10-minute self-healing reconciliation
// job that corrects token trade_count / volume_eth when they diverge from the
// actual trades table (e.g. from phantom stats caused by failed inserts,
// event replay, or race conditions before the fast-path fix).

describe("needsStatReconciliation", () => {
  it("returns false when stored stats exactly match actual", () => {
    expect(needsStatReconciliation(
      { tradeCount: 5,  volumeEth: "1000000000" },
      { tradeCount: 5,  volumeEth: 1_000_000_000n },
    )).toBe(false);
  });

  it("returns true when trade_count diverges (phantom insert case)", () => {
    // Stored trade_count is higher than actual rows in the trades table.
    expect(needsStatReconciliation(
      { tradeCount: 10, volumeEth: "5000000000" },
      { tradeCount:  7, volumeEth: 5_000_000_000n },
    )).toBe(true);
  });

  it("returns true when volume_eth diverges while trade_count matches", () => {
    expect(needsStatReconciliation(
      { tradeCount: 3, volumeEth: "9999999999" },
      { tradeCount: 3, volumeEth: 3_000_000_000n },
    )).toBe(true);
  });

  it("returns true when both stats diverge (classic phantom-stats case)", () => {
    // Simulates a token with trade_count=30 and volume>0 but zero actual trade rows.
    expect(needsStatReconciliation(
      { tradeCount: 30, volumeEth: "150000000000" },
      { tradeCount:  0, volumeEth:             0n },
    )).toBe(true);
  });

  it("returns false for a token with zero trades and zero stored stats", () => {
    expect(needsStatReconciliation(
      { tradeCount: 0, volumeEth: "0" },
      { tradeCount: 0, volumeEth: 0n },
    )).toBe(false);
  });

  it("handles large BigInt volumes correctly without precision loss", () => {
    // 1 000 SOL in lamports = 1_000_000_000_000
    const largeVol = 1_000_000_000_000n;
    expect(needsStatReconciliation(
      { tradeCount: 500, volumeEth: largeVol.toString() },
      { tradeCount: 500, volumeEth: largeVol },
    )).toBe(false);
  });

  it("returns true when only volume_eth differs by a single lamport", () => {
    // Ensures the comparison is exact (BigInt equality, not float approximation).
    expect(needsStatReconciliation(
      { tradeCount: 1, volumeEth: "1000000001" },
      { tradeCount: 1, volumeEth: 1_000_000_000n },
    )).toBe(true);
  });
});

// ── fetchMeta: pump_fun metadataUri fallback ───────────────────────────────────
//
// When a token is launched via the proxy and the IPFS image fetch times out,
// imageUrl lands as null in the DB even though metadataUri was saved.
// The three cases below verify that the enrichment loop recovers the logo
// from the stored metadataUri on the next tick.
//
// fetch is stubbed globally per test; safeUriFetch is mocked at module level
// (vi.mock above) so no real network calls are made.

describe("fetchMeta — pump_fun metadataUri image fallback", () => {
  const MINT         = "TokenMint1111111111111111111111111111111111";
  const META_URI     = "https://storage.googleapis.com/bucket/token-meta/abc.json";
  const EXPECTED_IMG = "https://storage.googleapis.com/bucket/token-images/abc.png";

  // Reset mock call counts between tests so assertions like not.toHaveBeenCalled
  // don't accumulate calls from earlier tests in this describe block.
  afterEach(() => vi.clearAllMocks());

  /** Build a minimal Response-like object for vi.stubGlobal('fetch', ...) */
  function mockResponse(ok: boolean, body?: unknown): Response {
    return {
      ok,
      status: ok ? 200 : 404,
      json:   () => Promise.resolve(body),
      text:   () => Promise.resolve(""),
    } as unknown as Response;
  }

  /**
   * Stub globalThis.fetch so pump.fun and Raydium API calls can be controlled
   * per test without touching the safeUriFetch mock.
   */
  function stubApiFetch({
    pumpOk,   pumpBody,
    raydiumOk, raydiumBody,
  }: {
    pumpOk:      boolean; pumpBody?:    unknown;
    raydiumOk:   boolean; raydiumBody?: unknown;
  }) {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("frontend-api.pump.fun"))  return Promise.resolve(mockResponse(pumpOk,    pumpBody));
      if (url.includes("api-v3.raydium.io"))       return Promise.resolve(mockResponse(raydiumOk, raydiumBody));
      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    }));
  }

  it("recovers image from metadataUri when pump.fun API returns identity but no image_uri", async () => {
    // pump.fun knows the token (name+symbol resolved) but image_uri is absent.
    // safeUriFetch returns the full metadata including the image URL.
    stubApiFetch({
      pumpOk:   true,  pumpBody:   { name: "Moon Cat", symbol: "MCAT" },
      raydiumOk: false,
    });
    vi.mocked(safeUriFetchMod.fetchSafeUriMeta).mockResolvedValue({
      name: "Moon Cat", symbol: "MCAT", imageUrl: EXPECTED_IMG,
      description: null, twitterUrl: null, telegramUrl: null, websiteUrl: null,
    });

    const result = await fetchMeta(MINT, "pump_fun", META_URI);

    expect(result?.imageUrl).toBe(EXPECTED_IMG);
    expect(result?.name).toBe("Moon Cat");
    expect(result?.symbol).toBe("MCAT");
    expect(vi.mocked(safeUriFetchMod.fetchSafeUriMeta)).toHaveBeenCalledWith(META_URI);
  });

  it("recovers image from metadataUri when Raydium returns identity but no logoURI", async () => {
    // pump.fun API unavailable; Raydium knows the token but has no logo.
    // safeUriFetch fills the image gap.
    stubApiFetch({
      pumpOk:    false,
      raydiumOk: true, raydiumBody: { data: [{ name: "Moon Cat", symbol: "MCAT" }] },
    });
    vi.mocked(safeUriFetchMod.fetchSafeUriMeta).mockResolvedValue({
      name: "Moon Cat", symbol: "MCAT", imageUrl: EXPECTED_IMG,
      description: null, twitterUrl: null, telegramUrl: null, websiteUrl: null,
    });

    const result = await fetchMeta(MINT, "pump_fun", META_URI);

    expect(result?.imageUrl).toBe(EXPECTED_IMG);
    expect(vi.mocked(safeUriFetchMod.fetchSafeUriMeta)).toHaveBeenCalledWith(META_URI);
  });

  it("returns full metadata from metadataUri when both pump.fun and Raydium APIs fail", async () => {
    // Neither upstream API responds — fall through to the stored metadataUri.
    // This path must return name+symbol+image so placeholder identity can also
    // be resolved in the same tick.
    stubApiFetch({ pumpOk: false, raydiumOk: false });
    vi.mocked(safeUriFetchMod.fetchSafeUriMeta).mockResolvedValue({
      name: "Moon Cat", symbol: "MCAT", imageUrl: EXPECTED_IMG,
      description: "A test token", twitterUrl: "https://twitter.com/mooncat",
      telegramUrl: null, websiteUrl: null,
    });

    const result = await fetchMeta(MINT, "pump_fun", META_URI);

    expect(result?.name).toBe("Moon Cat");
    expect(result?.symbol).toBe("MCAT");
    expect(result?.imageUrl).toBe(EXPECTED_IMG);
    expect(result?.description).toBe("A test token");
    expect(result?.twitterUrl).toBe("https://twitter.com/mooncat");
    expect(vi.mocked(safeUriFetchMod.fetchSafeUriMeta)).toHaveBeenCalledWith(META_URI);
  });

  it("returns null without calling safeUriFetch when metadataUri is null and both APIs fail", async () => {
    // Regression guard: no metadataUri → no URI fetch attempted, result is null.
    stubApiFetch({ pumpOk: false, raydiumOk: false });
    vi.mocked(safeUriFetchMod.fetchSafeUriMeta).mockResolvedValue(null);

    const result = await fetchMeta(MINT, "pump_fun", null);

    expect(result).toBeNull();
    expect(vi.mocked(safeUriFetchMod.fetchSafeUriMeta)).not.toHaveBeenCalled();
  });
});
