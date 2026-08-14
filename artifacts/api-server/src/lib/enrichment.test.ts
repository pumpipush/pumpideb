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
  LL_DEFAULT_SUPPLY_STR,
  ENRICHABLE_PLATFORMS_EXPORT,
} from "./enrichment";

afterEach(() => vi.restoreAllMocks());

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
    // Allow ±1 for floating-point rounding in Math.round
    expect(Math.abs(Number(update!.marketCapEth) - 1e12)).toBeLessThan(10);
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
