/**
 * tokens.filter.test.ts — Regression guard for the LaunchLab ??? token visibility rule.
 *
 * Contract (from task #161):
 *   • GET /tokens?platform=raydium_launchlab  → ??? tokens ARE included
 *   • GET /tokens                             → ??? tokens are NOT included
 *   • GET /tokens?platform=pump_fun           → ??? tokens are NOT included
 *
 * This is an integration test: it inserts a real token into the database,
 * makes HTTP requests against an in-process Express server, and cleans up
 * the token afterwards.  No external HTTP server is required.
 *
 * Covers both code paths in tokens.ts:
 *   • sort=newest  → Drizzle ORM conditions (the `conditions.push(...)` block)
 *   • sort=trending → raw SQL WHERE clause (the `where.push(...)` block)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, tokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../app.js";

// The trending-sort tests run a multi-table SQL join (smart score + 24h pct
// change). On a shared dev DB this can take up to ~10 s. Raise the per-test
// timeout for the whole file so we don't get false failures.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ── Test-token identity ────────────────────────────────────────────────────────
// Use a unique address so parallel test runs and leftover DB state don't collide.
const TEST_ADDR = `TstLL${"A".repeat(32)}${Date.now().toString(36)}`.slice(0, 44);

// ── Server lifecycle ───────────────────────────────────────────────────────────
let server: Server;
let base: string;

beforeAll(async () => {
  // 1. Insert the test token — raydium_launchlab with placeholder symbol ???
  //    Only required-without-default fields need to be provided; the rest use
  //    schema defaults (virtualTokenReserves, chain, platform, etc.).
  // Insert with tradeCount=1: in production, raydium_launchlab tokens with ???
  // symbol are always discovered via a trade event (tradeCount ≥ 1).  The
  // sort=newest filter now requires tradeCount > 0 to suppress untouched
  // scam launches — a test token with 0 trades would be incorrectly excluded.
  await db.insert(tokensTable).values({
    address:        TEST_ADDR,
    name:           "TestLaunchLabToken…",
    symbol:         "???",
    creatorAddress: "TestCreator11111111111111111111T",
    platform:       "raydium_launchlab",
    chain:          "solana",
    tradeCount:     "1",
  }).onConflictDoNothing();

  // 2. Start an in-process HTTP server on a random OS-assigned port.
  //    We cannot reuse port 8080 (the dev server might be running there),
  //    so `listen(0)` lets the OS pick a free port.
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  // Remove the test token so it doesn't pollute the real DB.
  await db.delete(tokensTable).where(eq(tokensTable.address, TEST_ADDR));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchTokens(params: Record<string, string>): Promise<Array<{ address: string; symbol: string }>> {
  const qs = new URLSearchParams({ sort: "newest", limit: "200", ...params }).toString();
  const res = await fetch(`${base}/tokens?${qs}`);
  if (!res.ok) throw new Error(`GET /tokens?${qs} returned ${res.status}`);
  return res.json() as Promise<Array<{ address: string; symbol: string }>>;
}

async function fetchTokensTrending(params: Record<string, string>): Promise<Array<{ address: string; symbol: string }>> {
  const qs = new URLSearchParams({ sort: "trending", limit: "200", ...params }).toString();
  const res = await fetch(`${base}/tokens?${qs}`);
  if (!res.ok) throw new Error(`GET /tokens?${qs} returned ${res.status}`);
  return res.json() as Promise<Array<{ address: string; symbol: string }>>;
}

function containsTestToken(tokens: Array<{ address: string }>): boolean {
  return tokens.some(t => t.address === TEST_ADDR);
}

// ── Tests: sort=newest (Drizzle ORM conditions path) ─────────────────────────

describe("GET /tokens — ??? visibility with sort=newest (Drizzle ORM path)", () => {
  it("includes ??? token when platform=raydium_launchlab", async () => {
    const tokens = await fetchTokens({ platform: "raydium_launchlab" });
    expect(
      containsTestToken(tokens),
      `Token ${TEST_ADDR} with symbol=??? should appear in platform=raydium_launchlab`,
    ).toBe(true);
    // Confirm the returned record really has ??? symbol
    const found = tokens.find(t => t.address === TEST_ADDR);
    expect(found?.symbol).toBe("???");
  });

  it("excludes ??? token when no platform filter is provided (all-platforms view)", async () => {
    const tokens = await fetchTokens({});
    expect(
      containsTestToken(tokens),
      `Token ${TEST_ADDR} with symbol=??? must NOT appear when no platform filter is set`,
    ).toBe(false);
  });

  it("excludes ??? token when platform=pump_fun", async () => {
    const tokens = await fetchTokens({ platform: "pump_fun" });
    expect(
      containsTestToken(tokens),
      `Token ${TEST_ADDR} with symbol=??? must NOT appear when platform=pump_fun`,
    ).toBe(false);
  });

  it("excludes ??? token when platform=pumpswap", async () => {
    const tokens = await fetchTokens({ platform: "pumpswap" });
    expect(
      containsTestToken(tokens),
      `Token ${TEST_ADDR} with symbol=??? must NOT appear when platform=pumpswap`,
    ).toBe(false);
  });
});

// ── Tests: sort=trending (raw SQL path) ───────────────────────────────────────
// The trending path uses a hand-written SQL WHERE clause instead of Drizzle
// conditions.  We test it separately to ensure both code paths enforce the rule.

describe("GET /tokens — ??? visibility with sort=trending (raw SQL path)", () => {
  it("includes ??? token when platform=raydium_launchlab", async () => {
    const tokens = await fetchTokensTrending({ platform: "raydium_launchlab" });
    // The test token has no trades so its smart_score = 0.
    // It will appear at the bottom of the result set but must still be present.
    expect(
      containsTestToken(tokens),
      `Token ${TEST_ADDR} with symbol=??? should appear in trending+platform=raydium_launchlab`,
    ).toBe(true);
  });

  it("excludes ??? token when no platform filter is provided (all-platforms view)", async () => {
    const tokens = await fetchTokensTrending({});
    expect(
      containsTestToken(tokens),
      `Token ${TEST_ADDR} with symbol=??? must NOT appear in trending without platform filter`,
    ).toBe(false);
  });

  it("excludes ??? token when platform=pump_fun", async () => {
    const tokens = await fetchTokensTrending({ platform: "pump_fun" });
    expect(
      containsTestToken(tokens),
      `Token ${TEST_ADDR} with symbol=??? must NOT appear in trending+platform=pump_fun`,
    ).toBe(false);
  });
});
