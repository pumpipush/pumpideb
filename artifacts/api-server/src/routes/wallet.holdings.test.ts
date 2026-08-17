/**
 * wallet.holdings.test.ts — Contract guard for GET /api/wallet/:address/holdings
 *
 * THE UNIT CONTRACT (must never silently change):
 *   `balance` in every holdings item is the raw SUM of token_amount values from
 *   the trades table. pump.fun tokens have 6 on-chain decimal places, so
 *   1 whole display token = 1,000,000 atomic units in the DB.
 *
 *   The PortfolioTab in AppInterface.tsx relies on this contract to divide by 1e6:
 *     const displayTokens = balance / 1e6;   // whole tokens shown to the user
 *     const valueSol = price * displayTokens; // SOL value
 *
 *   If the API were ever changed to return display-unit balances (already ÷ 1e6),
 *   the frontend would show values 1,000,000× too small. This test catches that.
 *
 * WHAT IS TESTED:
 *   1. balance reflects raw atomic units — buying 1.5 tokens returns "1500000"
 *   2. sells subtract from balance correctly
 *   3. a fully-sold token is excluded (net balance ≤ 0 → HAVING clause filters it)
 *   4. a wallet with no trades returns { holdings: [], count: 0 }
 *   5. response shape matches what PortfolioTab destructures
 *   6. count matches holdings.length
 *
 * This is an integration test: real DB, real Express app, in-process HTTP server.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import app from "../app.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ── Unique fixture identifiers (avoid collisions with real data or parallel runs) ──
const TAG     = Date.now().toString(36);
const TOKEN_A = `HldTokA${TAG}${"1".repeat(37)}`.slice(0, 44); // has net balance
const TOKEN_B = `HldTokB${TAG}${"2".repeat(37)}`.slice(0, 44); // fully sold → excluded
const WALLET  = `HldWlt${TAG}${"W".repeat(38)}`.slice(0, 44);
const OTHER   = `HldOther${TAG}${"O".repeat(36)}`.slice(0, 44);  // no trades for WALLET

// txHash must be unique across the trades table
let txIdx = 0;
const nextTxHash = () => `holdingsTx${TAG}${(++txIdx).toString().padStart(4, "0")}`;

// ── Server lifecycle ────────────────────────────────────────────────────────────
let server: Server;
let base: string;

beforeAll(async () => {
  // Insert test tokens
  await db.insert(tokensTable).values([
    {
      address:        TOKEN_A,
      name:           "Holdings Test Token A",
      symbol:         "HLDA",
      creatorAddress: WALLET,
      platform:       "pump_fun",
      chain:          "solana",
      priceEth:       "0.000000130",    // 1.3e-7 SOL/token
      marketCapEth:   "27958988498",
      volumeEth:      "1000000000",
      imageUrl:       "https://example.com/a.png",
    },
    {
      address:        TOKEN_B,
      name:           "Holdings Test Token B",
      symbol:         "HLDB",
      creatorAddress: WALLET,
      platform:       "pump_fun",
      chain:          "solana",
    },
  ]).onConflictDoNothing();

  // Token A: buy 2,500,000 atomic (2.5 whole tokens) then sell 1,000,000 (1 whole token)
  //          → net = 1,500,000 atomic (1.5 whole tokens)
  await db.insert(tradesTable).values([
    {
      tokenAddress:  TOKEN_A,
      traderAddress: WALLET,
      isBuy:         true,
      ethAmount:     "325000",          // 0.000325 SOL (lamports)
      tokenAmount:   "2500000",         // 2.5 whole tokens in atomic units
      txHash:        nextTxHash(),
      platform:      "pump_fun",
    },
    {
      tokenAddress:  TOKEN_A,
      traderAddress: WALLET,
      isBuy:         false,
      ethAmount:     "130000",
      tokenAmount:   "1000000",         // sell 1 whole token
      txHash:        nextTxHash(),
      platform:      "pump_fun",
    },
  ]);

  // Token B: buy 500,000 then sell the exact same amount → net = 0 → excluded
  await db.insert(tradesTable).values([
    {
      tokenAddress:  TOKEN_B,
      traderAddress: WALLET,
      isBuy:         true,
      ethAmount:     "65000",
      tokenAmount:   "500000",
      txHash:        nextTxHash(),
      platform:      "pump_fun",
    },
    {
      tokenAddress:  TOKEN_B,
      traderAddress: WALLET,
      isBuy:         false,
      ethAmount:     "65000",
      tokenAmount:   "500000",
      txHash:        nextTxHash(),
      platform:      "pump_fun",
    },
  ]);

  // Another wallet buys TOKEN_A — should NOT appear in WALLET's holdings
  await db.insert(tradesTable).values({
    tokenAddress:  TOKEN_A,
    traderAddress: OTHER,
    isBuy:         true,
    ethAmount:     "130000",
    tokenAmount:   "1000000",
    txHash:        nextTxHash(),
    platform:      "pump_fun",
  });

  // Start in-process server on a random port
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  // Remove test trades then tokens (FK order)
  await db.delete(tradesTable).where(
    inArray(tradesTable.tokenAddress, [TOKEN_A, TOKEN_B])
  );
  await db.delete(tokensTable).where(
    inArray(tokensTable.address, [TOKEN_A, TOKEN_B])
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Helper ─────────────────────────────────────────────────────────────────────
async function getHoldings(wallet: string) {
  const res = await fetch(`${base}/wallet/${wallet}/holdings`);
  if (!res.ok) throw new Error(`GET /wallet/${wallet}/holdings returned ${res.status}`);
  return res.json() as Promise<{
    holdings: Array<{
      address:      string;
      balance:      string;
      name:         string;
      symbol:       string;
      imageUrl:     string | null;
      priceEth:     string | null;
      marketCapEth: string | null;
      volumeEth:    string | null;
      decimals:     number;
    }>;
    count: number;
  }>;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /wallet/:address/holdings — unit contract", () => {
  it("returns balance in raw atomic units (not display units)", async () => {
    const { holdings } = await getHoldings(WALLET);
    const a = holdings.find(h => h.address === TOKEN_A);
    expect(a, "TOKEN_A should be in holdings").toBeDefined();

    // 2,500,000 bought − 1,000,000 sold = 1,500,000 atomic units
    expect(a!.balance).toBe("1500000");

    // CRITICAL: if this were ÷1e6 the value would be "1.5" (a float string).
    // The frontend divides by 1e6 to get display tokens (1.5 whole tokens).
    // Confirm it is NOT already divided.
    const numeric = parseFloat(a!.balance);
    expect(numeric).toBeGreaterThan(1_000);  // definitely not display units
  });

  it("1 whole token bought = balance of 1,000,000 (6-decimal pump.fun convention)", async () => {
    // Insert a single 1-whole-token buy for a fresh address then clean up
    const ONE_TOKEN_ADDR = `HldOne${TAG}${"X".repeat(38)}`.slice(0, 44);
    const ONE_WALLET     = `HldWltOne${TAG}${"Y".repeat(35)}`.slice(0, 44);

    await db.insert(tokensTable).values({
      address:        ONE_TOKEN_ADDR,
      name:           "One Token Test",
      symbol:         "ONE",
      creatorAddress: ONE_WALLET,
      platform:       "pump_fun",
      chain:          "solana",
    }).onConflictDoNothing();

    await db.insert(tradesTable).values({
      tokenAddress:  ONE_TOKEN_ADDR,
      traderAddress: ONE_WALLET,
      isBuy:         true,
      ethAmount:     "130000",
      tokenAmount:   "1000000",   // exactly 1 whole token = 10^6 atomic units
      txHash:        nextTxHash(),
      platform:      "pump_fun",
    });

    try {
      const { holdings } = await getHoldings(ONE_WALLET);
      const item = holdings.find(h => h.address === ONE_TOKEN_ADDR);
      expect(item).toBeDefined();
      expect(item!.balance).toBe("1000000");  // 1 whole token = 1,000,000 atomic
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.tokenAddress, ONE_TOKEN_ADDR));
      await db.delete(tokensTable).where(eq(tokensTable.address, ONE_TOKEN_ADDR));
    }
  });

  it("sells reduce the atomic balance correctly", async () => {
    const { holdings } = await getHoldings(WALLET);
    const a = holdings.find(h => h.address === TOKEN_A);
    expect(a).toBeDefined();
    // Purchased 2.5 tokens (2,500,000 atomic), sold 1 token (1,000,000 atomic)
    // Net: 1,500,000 atomic = 1.5 display tokens when frontend divides by 1e6
    expect(parseFloat(a!.balance)).toBe(1_500_000);
  });

  it("fully sold tokens (net balance ≤ 0) are excluded", async () => {
    // TOKEN_B was bought and sold in equal amounts → net = 0 → HAVING clause drops it
    const { holdings } = await getHoldings(WALLET);
    const b = holdings.find(h => h.address === TOKEN_B);
    expect(b).toBeUndefined();
  });

  it("only includes trades for the requested wallet", async () => {
    // OTHER wallet has a buy of TOKEN_A but WALLET's balance should be independent
    const walletHoldings = await getHoldings(WALLET);
    const otherHoldings  = await getHoldings(OTHER);

    // WALLET sees 1,500,000 for TOKEN_A (its own trades)
    const walletA = walletHoldings.holdings.find(h => h.address === TOKEN_A);
    expect(walletA!.balance).toBe("1500000");

    // OTHER sees 1,000,000 for TOKEN_A (its own buy only)
    const otherA = otherHoldings.holdings.find(h => h.address === TOKEN_A);
    expect(otherA).toBeDefined();
    expect(otherA!.balance).toBe("1000000");
  });
});

describe("GET /wallet/:address/holdings — response shape (PortfolioTab contract)", () => {
  it("returns { holdings, count } at the top level", async () => {
    const data = await getHoldings(WALLET);
    expect(data).toHaveProperty("holdings");
    expect(data).toHaveProperty("count");
    expect(Array.isArray(data.holdings)).toBe(true);
    expect(data.count).toBe(data.holdings.length);
  });

  it("every item has all fields PortfolioTab destructures", async () => {
    const { holdings } = await getHoldings(WALLET);
    expect(holdings.length).toBeGreaterThan(0);

    for (const item of holdings) {
      // Required string fields
      expect(typeof item.address).toBe("string");
      expect(typeof item.balance).toBe("string");
      expect(typeof item.name).toBe("string");
      expect(typeof item.symbol).toBe("string");
      // Nullable fields must exist (even if null) — PortfolioTab reads them
      expect("imageUrl"     in item).toBe(true);
      expect("priceEth"     in item).toBe(true);
      expect("marketCapEth" in item).toBe(true);
      expect("volumeEth"    in item).toBe(true);
      // balance must be a valid numeric string (parseFloat used by frontend)
      expect(isNaN(parseFloat(item.balance))).toBe(false);
    }
  });

  it("enriches holdings with token metadata from the tokens table", async () => {
    const { holdings } = await getHoldings(WALLET);
    const a = holdings.find(h => h.address === TOKEN_A)!;
    expect(a.name).toBe("Holdings Test Token A");
    expect(a.symbol).toBe("HLDA");
    expect(a.imageUrl).toBe("https://example.com/a.png");
    expect(a.priceEth).toBe("0.000000130");
    expect(a.marketCapEth).toBe("27958988498");
  });

  // Skipped: migration 0017 added a FK constraint (fk_trades_token) that
  // prevents INSERT of trades with a non-existent token_address. The ghost-token
  // fallback code path still exists in the route for pre-FK historical orphans,
  // but it can no longer be exercised via a test INSERT.
  it.skip("falls back to address prefix for name when token is not in DB", async () => {
    const GHOST_ADDR   = `HldGhost${TAG}${"G".repeat(36)}`.slice(0, 44);
    const GHOST_WALLET = `HldGhostW${TAG}${"H".repeat(35)}`.slice(0, 44);
    await db.insert(tradesTable).values({
      tokenAddress:  GHOST_ADDR,
      traderAddress: GHOST_WALLET,
      isBuy:         true,
      ethAmount:     "130000",
      tokenAmount:   "1000000",
      txHash:        nextTxHash(),
      platform:      "pump_fun",
    });
    try {
      const { holdings } = await getHoldings(GHOST_WALLET);
      const item = holdings.find(h => h.address === GHOST_ADDR);
      expect(item).toBeDefined();
      expect(item!.name).toBe(GHOST_ADDR.slice(0, 8));
      expect(item!.symbol).toBe("???");
      expect(item!.priceEth).toBeNull();
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.tokenAddress, GHOST_ADDR));
    }
  });

  it("returns empty holdings for a wallet with no trades", async () => {
    const EMPTY_WALLET = `HldEmpty${TAG}${"E".repeat(36)}`.slice(0, 44);
    const data = await getHoldings(EMPTY_WALLET);
    expect(data.holdings).toHaveLength(0);
    expect(data.count).toBe(0);
  });
});

describe("GET /wallet/:address/holdings — decimals field and non-6-decimal tokens", () => {
  it("returns decimals = 6 for pump.fun tokens", async () => {
    const { holdings } = await getHoldings(WALLET);
    const a = holdings.find(h => h.address === TOKEN_A);
    expect(a).toBeDefined();
    expect(a!.decimals).toBe(6);
  });

  it("returns the stored decimals value for a 9-decimal token", async () => {
    // Insert a token with 9 on-chain decimals (e.g. wrapped SOL convention)
    const NINE_DEC_ADDR   = `HldNine${TAG}${"9".repeat(37)}`.slice(0, 44);
    const NINE_DEC_WALLET = `HldNineW${TAG}${"N".repeat(36)}`.slice(0, 44);

    await db.insert(tokensTable).values({
      address:        NINE_DEC_ADDR,
      name:           "Nine Decimal Token",
      symbol:         "9DEC",
      creatorAddress: NINE_DEC_WALLET,
      platform:       "raydium_launchlab",
      chain:          "solana",
      decimals:       9,
      priceEth:       "0.05",
    }).onConflictDoNothing();

    // Buy 1 whole token = 1,000,000,000 atomic units for a 9-decimal token
    await db.insert(tradesTable).values({
      tokenAddress:  NINE_DEC_ADDR,
      traderAddress: NINE_DEC_WALLET,
      isBuy:         true,
      ethAmount:     "50000000",  // 0.05 SOL in lamports
      tokenAmount:   "1000000000", // 1 whole token in 9-decimal atomic units
      txHash:        nextTxHash(),
      platform:      "raydium_launchlab",
    });

    try {
      const { holdings } = await getHoldings(NINE_DEC_WALLET);
      const item = holdings.find(h => h.address === NINE_DEC_ADDR);
      expect(item).toBeDefined();

      // balance is raw atomic (1 whole token for 9-decimal = 1,000,000,000 atomic)
      expect(item!.balance).toBe("1000000000");
      // decimals must be 9, not the default 6
      expect(item!.decimals).toBe(9);

      // The frontend's computeHoldingRow(balance, priceEth, solPrice, decimals)
      // uses atomicToDisplayTokens(balance, decimals). With decimals=9:
      //   1,000,000,000 / 10^9 = 1 display token (correct)
      //   1,000,000,000 / 10^6 = 1,000 display tokens (wrong — the old hardcoded bug)
      // That calculation is tested in utils.test.ts; here we confirm the API
      // returns the correct decimals value so the frontend can do it right.
      const displayTokensCorrect = parseFloat(item!.balance) / Math.pow(10, item!.decimals);
      const displayTokensBuggy   = parseFloat(item!.balance) / 1e6; // hardcoded 6
      expect(displayTokensCorrect).toBeCloseTo(1, 9);
      expect(displayTokensBuggy).toBeCloseTo(1000, 6); // 1,000× off without correct decimals
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.tokenAddress, NINE_DEC_ADDR));
      await db.delete(tokensTable).where(eq(tokensTable.address, NINE_DEC_ADDR));
    }
  });

  // Skipped: migration 0017 FK prevents INSERT of trades with non-existent
  // token_address. Ghost-token decimals fallback is preserved in the route
  // for pre-FK historical orphans but cannot be set up via a new test INSERT.
  it.skip("falls back to decimals=6 for ghost tokens not in DB", async () => {
    const GHOST2_ADDR   = `HldGhost2${TAG}${"Z".repeat(35)}`.slice(0, 44);
    const GHOST2_WALLET = `HldGhost2W${TAG}${"V".repeat(34)}`.slice(0, 44);

    await db.insert(tradesTable).values({
      tokenAddress:  GHOST2_ADDR,
      traderAddress: GHOST2_WALLET,
      isBuy:         true,
      ethAmount:     "130000",
      tokenAmount:   "1000000",
      txHash:        nextTxHash(),
      platform:      "pump_fun",
    });

    try {
      const { holdings } = await getHoldings(GHOST2_WALLET);
      const item = holdings.find(h => h.address === GHOST2_ADDR);
      expect(item).toBeDefined();
      expect(item!.decimals).toBe(6); // fallback for ghost tokens
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.tokenAddress, GHOST2_ADDR));
    }
  });
});

describe("GET /wallet/:address/holdings — frontend ÷1e6 integration contract", () => {
  it("balance / 1e6 equals the expected whole-token display amount", async () => {
    // This test explicitly documents the frontend transformation that must stay in sync.
    // PortfolioTab: const displayTokens = balance / 1e6;
    const { holdings } = await getHoldings(WALLET);
    const a = holdings.find(h => h.address === TOKEN_A)!;

    const atomicBalance   = parseFloat(a.balance);           // 1,500,000
    const displayTokens   = atomicBalance / 1e6;             // 1.5  (frontend computation)
    const priceSolPerTok  = parseFloat(a.priceEth ?? "0");   // 1.3e-7 SOL/token
    const valueSol        = priceSolPerTok * displayTokens;  // 1.95e-7 SOL

    expect(displayTokens).toBeCloseTo(1.5, 6);
    expect(valueSol).toBeCloseTo(1.95e-7, 12);

    // Sanity check: using raw atomic balance without ÷1e6 would give a wildly wrong value
    const wrongValueSol = priceSolPerTok * atomicBalance;    // 1.5e-7 * 1.5M ≈ 0.195 SOL
    expect(wrongValueSol).toBeGreaterThan(valueSol * 999_000); // 6 orders of magnitude off
  });
});
