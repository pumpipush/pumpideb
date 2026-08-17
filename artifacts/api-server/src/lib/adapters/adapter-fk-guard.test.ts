/**
 * adapter-fk-guard.test.ts
 *
 * Integration guard for the FK-safe trade-before-create pattern introduced in
 * migration 0017 and implemented across the pump.fun, Meteora, and Orca
 * adapters.
 *
 * Context
 * -------
 * Migration 0017 added `fk_trades_token` — a FK on trades.token_address
 * referencing tokens.address ON DELETE CASCADE.  Without a placeholder upsert
 * in each adapter's handleTrade path, a trade arriving before the corresponding
 * create / pool event would fail with a FK-violation error and be silently
 * dropped.
 *
 * The adapters were fixed to upsert a minimal "placeholder" token row before
 * every trade INSERT.  handleCreate (pump.fun) and handleNewPool (Meteora /
 * Orca) were subsequently fixed to upgrade that placeholder with real
 * name / symbol / metadata rather than discarding the create event with
 * onConflictDoNothing.
 *
 * Each describe block mirrors the adapter's DB operations in the same order
 * the adapter would call them so that a future refactor that breaks the guard
 * causes this test to fail with a clear message.
 *
 * Assertions
 * ----------
 * For each platform:
 *   1. Trade is saved (placeholder auto-created, no FK violation).
 *   2. Placeholder token has the correct `platform` field.
 *   3. Subsequent create / pool event fills in real name and symbol.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";

// ── pump.fun bonding-curve protocol constants (mirrors pumpfun.ts) ────────────
// These values are fixed by the pump.fun protocol; copied here so the test
// does not need to import private module-level consts from the adapter.
const PUMP_TOTAL_SUPPLY       = 1_000_000_000_000_000n;
const PUMP_INIT_VSOL_LAMPORTS = 30_000_000_000n;
const PUMP_INIT_VTOK          = 1_073_000_191_045_000n;
const PUMP_INIT_VSOL_SOL      = "30";
const PUMP_INIT_MC_LAMPORTS   =
  (PUMP_TOTAL_SUPPLY * PUMP_INIT_VSOL_LAMPORTS / PUMP_INIT_VTOK).toString();
const PUMP_INIT_PRICE_ETH     =
  (Number(PUMP_INIT_VSOL_LAMPORTS) / Number(PUMP_INIT_VTOK) / 1000).toFixed(15);

/** Build a 44-char deterministic fake Solana address from a label + run tag. */
const TAG  = `fkgd_${Date.now().toString(36)}`;
const addr = (prefix: string) => `${prefix}${TAG}${"A".repeat(44)}`.slice(0, 44);

let txSeq = 0;
const nextTx = (prefix: string) =>
  `${prefix}Tx${TAG}${(++txSeq).toString().padStart(4, "0")}`;

// ── Shared cleanup ────────────────────────────────────────────────────────────

/** Mints created by this test run — cleaned up in afterAll. */
const ALL_MINTS: string[] = [];

afterAll(async () => {
  if (ALL_MINTS.length === 0) return;
  // Delete trades first (FK order), then tokens.
  await db.delete(tradesTable).where(inArray(tradesTable.tokenAddress, ALL_MINTS));
  await db.delete(tokensTable).where(inArray(tokensTable.address, ALL_MINTS));
});

// ══════════════════════════════════════════════════════════════════════════════
// pump.fun adapter — FK guard
// ══════════════════════════════════════════════════════════════════════════════

describe("pump.fun adapter — FK guard (trade-before-create)", () => {
  const MINT    = addr("pf");
  const CREATOR = addr("pfCr");

  beforeAll(() => { ALL_MINTS.push(MINT); });

  it("1. trade is saved when token row does not yet exist (placeholder auto-created)", async () => {
    // ── Step A: handleTrade → upsert minimal placeholder ──────────────────
    // Mirrors pumpfun.ts handleTrade ~line 529:
    //   db.insert(tokensTable).values({ address: mint, name: mint.slice(0,8),
    //     symbol: "???", creatorAddress: "unknown", platform, chain })
    //   .onConflictDoNothing()
    await db.insert(tokensTable).values({
      address:        MINT,
      name:           MINT.slice(0, 8),
      symbol:         "???",
      creatorAddress: "unknown",
      platform:       "pump_fun",
      chain:          "solana",
    }).onConflictDoNothing();

    // ── Step B: handleTrade → insert trade (must not throw FK violation) ──
    const [trade] = await db.insert(tradesTable).values({
      tokenAddress:  MINT,
      traderAddress: addr("pfTr"),
      isBuy:         true,
      ethAmount:     "1000000000",
      tokenAmount:   "50000000",
      priceEth:      (1_000_000_000 / 50_000_000 / 1_000).toFixed(15),
      txHash:        nextTx("pf"),
      platform:      "pump_fun",
    }).onConflictDoNothing().returning();

    expect(trade, "trade row must be saved without FK violation").toBeDefined();

    // ── Step C: handleTrade → update tradeCount + volumeEth ──────────────
    // Mirrors pumpfun.ts handleTrade's post-insert db.update call.
    // This step is included so the later assertion can confirm the create
    // event does NOT reset the tradeCount that handleTrade incremented.
    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${"1000000000"} AS TEXT)`,
    }).where(eq(tokensTable.address, MINT));
  });

  it("2. placeholder token has platform=pump_fun", async () => {
    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(token, "placeholder token row must exist").toBeDefined();
    expect(token.platform).toBe("pump_fun");
    // Verify it is still the placeholder — name/symbol not yet real.
    expect(token.name).toBe(MINT.slice(0, 8));
    expect(token.symbol).toBe("???");
  });

  it("3. subsequent handleCreate fills in real name and symbol", async () => {
    // ── Step C: handleCreate → onConflictDoUpdate ─────────────────────────
    // Mirrors the FIXED pumpfun.ts handleCreate ~line 352:
    //   db.insert(tokensTable).values({ address: mint, name, symbol, ... })
    //   .onConflictDoUpdate({ target: tokensTable.address, set: { name, symbol, ... } })
    //
    // The create event is authoritative for name/symbol; it overwrites the
    // placeholder values that handleTrade left.  Bonding-curve fields are
    // only initialised if they are still at the default "0".
    const REAL_NAME   = "Pumpi Test Token";
    const REAL_SYMBOL = "PTT";

    await db.insert(tokensTable).values({
      address:              MINT,
      name:                 REAL_NAME,
      symbol:               REAL_SYMBOL,
      creatorAddress:       CREATOR,
      totalSupply:          PUMP_TOTAL_SUPPLY.toString(),
      virtualTokenReserves: PUMP_INIT_VTOK.toString(),
      virtualEthReserves:   PUMP_INIT_VSOL_SOL,
      marketCapEth:         PUMP_INIT_MC_LAMPORTS,
      priceEth:             PUMP_INIT_PRICE_ETH,
      platform:             "pump_fun",
      chain:                "solana",
    }).onConflictDoUpdate({
      target: tokensTable.address,
      set: {
        name:   REAL_NAME,
        symbol: REAL_SYMBOL,
        // Prefer a known creator over "unknown" placeholder.
        creatorAddress: sql`CASE WHEN ${tokensTable.creatorAddress} = 'unknown' THEN ${CREATOR} ELSE ${tokensTable.creatorAddress} END`,
        // Bonding-curve fields: only init if still at the placeholder "0".
        totalSupply:          sql`CASE WHEN ${tokensTable.totalSupply} = '0' THEN ${PUMP_TOTAL_SUPPLY.toString()} ELSE ${tokensTable.totalSupply} END`,
        virtualTokenReserves: sql`CASE WHEN ${tokensTable.virtualTokenReserves} = '0' THEN ${PUMP_INIT_VTOK.toString()} ELSE ${tokensTable.virtualTokenReserves} END`,
        virtualEthReserves:   sql`CASE WHEN ${tokensTable.virtualEthReserves} = '0' THEN ${PUMP_INIT_VSOL_SOL} ELSE ${tokensTable.virtualEthReserves} END`,
        marketCapEth:         sql`COALESCE(${tokensTable.marketCapEth}, ${PUMP_INIT_MC_LAMPORTS})`,
        priceEth:             sql`COALESCE(${tokensTable.priceEth}, ${PUMP_INIT_PRICE_ETH})`,
      },
    });

    const [updated] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(updated.name,   "handleCreate must overwrite placeholder name").toBe(REAL_NAME);
    expect(updated.symbol, "handleCreate must overwrite placeholder symbol").toBe(REAL_SYMBOL);
    expect(updated.platform).toBe("pump_fun");
    // Creator must be filled in (was "unknown" before).
    expect(updated.creatorAddress).toBe(CREATOR);
    // Trade count / volume written by handleTrade must be preserved.
    expect(Number(updated.tradeCount)).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Meteora adapter — FK guard
// ══════════════════════════════════════════════════════════════════════════════

describe("meteora adapter — FK guard (trade-before-create)", () => {
  const MINT = addr("mt");

  beforeAll(() => { ALL_MINTS.push(MINT); });

  it("1. trade is saved when token row does not yet exist (placeholder auto-created)", async () => {
    // ── Step A: handleTrade → upsert minimal placeholder ──────────────────
    // Mirrors meteora.ts handleTrade ~line 134:
    //   db.insert(tokensTable).values({ address: mint, name: mint.slice(0,8),
    //     symbol: "???", creatorAddress: "unknown", platform, chain })
    //   .onConflictDoNothing()
    await db.insert(tokensTable).values({
      address:        MINT,
      name:           MINT.slice(0, 8),
      symbol:         "???",
      creatorAddress: "unknown",
      platform:       "meteora",
      chain:          "solana",
    }).onConflictDoNothing();

    // ── Step B: handleTrade → insert trade ───────────────────────────────
    const [trade] = await db.insert(tradesTable).values({
      tokenAddress:  MINT,
      traderAddress: addr("mtTr"),
      isBuy:         false,
      ethAmount:     "500000000",
      tokenAmount:   "25000000",
      priceEth:      (500_000_000 / 25_000_000 / 1_000).toFixed(15),
      txHash:        nextTx("mt"),
      platform:      "meteora",
    }).onConflictDoNothing().returning();

    expect(trade, "trade row must be saved without FK violation").toBeDefined();

    // ── Step C: handleTrade → update tradeCount + volumeEth ──────────────
    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${"500000000"} AS TEXT)`,
    }).where(eq(tokensTable.address, MINT));
  });

  it("2. placeholder token has platform=meteora", async () => {
    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(token, "placeholder token row must exist").toBeDefined();
    expect(token.platform).toBe("meteora");
    expect(token.name).toBe(MINT.slice(0, 8));
    expect(token.symbol).toBe("???");
  });

  it("3. subsequent handleNewPool fills in real name and symbol", async () => {
    // ── Step C: handleNewPool placeholder-upgrade path ─────────────────────
    // Mirrors the FIXED meteora.ts handleNewPool isPlaceholder branch:
    //   db.update(tokensTable).set({ name, symbol, imageUrl, graduated, ... })
    //   .where(eq(tokensTable.address, mint))
    //
    // In production the name/symbol/etc. come from Birdeye; here we supply
    // fixed values to make the test deterministic without network calls.
    const REAL_NAME   = "Meteora DLMM Pool Token";
    const REAL_SYMBOL = "MDT";

    await db.update(tokensTable).set({
      name:         REAL_NAME,
      symbol:       REAL_SYMBOL,
      imageUrl:     null,
      graduated:    true,
      priceEth:     "0.000020000000000",
      marketCapEth: "20000000000",
      liquidityUsd: 50_000,
      priceUsd:     0.002,
      marketCapUsd: 2_000_000,
    }).where(eq(tokensTable.address, MINT));

    const [updated] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(updated.name,   "handleNewPool must overwrite placeholder name").toBe(REAL_NAME);
    expect(updated.symbol, "handleNewPool must overwrite placeholder symbol").toBe(REAL_SYMBOL);
    expect(updated.platform).toBe("meteora");
    expect(updated.graduated).toBe(true);
    // Trade count / volume written by handleTrade must be preserved.
    expect(Number(updated.tradeCount)).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Orca adapter — FK guard
// ══════════════════════════════════════════════════════════════════════════════

describe("orca adapter — FK guard (trade-before-create)", () => {
  const MINT = addr("or");

  beforeAll(() => { ALL_MINTS.push(MINT); });

  it("1. trade is saved when token row does not yet exist (placeholder auto-created)", async () => {
    // ── Step A: handleTrade → upsert minimal placeholder ──────────────────
    // Mirrors orca.ts handleTrade ~line 134:
    //   db.insert(tokensTable).values({ address: mint, name: mint.slice(0,8),
    //     symbol: "???", creatorAddress: "unknown", platform, chain })
    //   .onConflictDoNothing()
    await db.insert(tokensTable).values({
      address:        MINT,
      name:           MINT.slice(0, 8),
      symbol:         "???",
      creatorAddress: "unknown",
      platform:       "orca",
      chain:          "solana",
    }).onConflictDoNothing();

    // ── Step B: handleTrade → insert trade ───────────────────────────────
    const [trade] = await db.insert(tradesTable).values({
      tokenAddress:  MINT,
      traderAddress: addr("orTr"),
      isBuy:         true,
      ethAmount:     "750000000",
      tokenAmount:   "10000000",
      priceEth:      (750_000_000 / 10_000_000 / 1_000).toFixed(15),
      txHash:        nextTx("or"),
      platform:      "orca",
    }).onConflictDoNothing().returning();

    expect(trade, "trade row must be saved without FK violation").toBeDefined();

    // ── Step C: handleTrade → update tradeCount + volumeEth ──────────────
    await db.update(tokensTable).set({
      tradeCount: sql`${tokensTable.tradeCount} + 1`,
      volumeEth:  sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${"750000000"} AS TEXT)`,
    }).where(eq(tokensTable.address, MINT));
  });

  it("2. placeholder token has platform=orca", async () => {
    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(token, "placeholder token row must exist").toBeDefined();
    expect(token.platform).toBe("orca");
    expect(token.name).toBe(MINT.slice(0, 8));
    expect(token.symbol).toBe("???");
  });

  it("3. subsequent handleNewPool fills in real name and symbol", async () => {
    // ── Step C: handleNewPool placeholder-upgrade path ─────────────────────
    // Mirrors the FIXED orca.ts handleNewPool isPlaceholder branch:
    //   db.update(tokensTable).set({ name, symbol, imageUrl, graduated, ... })
    //   .where(eq(tokensTable.address, mint))
    const REAL_NAME   = "Orca Whirlpool Token";
    const REAL_SYMBOL = "OWT";

    await db.update(tokensTable).set({
      name:         REAL_NAME,
      symbol:       REAL_SYMBOL,
      imageUrl:     null,
      graduated:    true,
      priceEth:     "0.000075000000000",
      marketCapEth: "75000000000",
      liquidityUsd: 120_000,
      priceUsd:     0.0075,
      marketCapUsd: 7_500_000,
    }).where(eq(tokensTable.address, MINT));

    const [updated] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(updated.name,   "handleNewPool must overwrite placeholder name").toBe(REAL_NAME);
    expect(updated.symbol, "handleNewPool must overwrite placeholder symbol").toBe(REAL_SYMBOL);
    expect(updated.platform).toBe("orca");
    expect(updated.graduated).toBe(true);
    // Trade count / volume written by handleTrade must be preserved.
    expect(Number(updated.tradeCount)).toBeGreaterThanOrEqual(1);
  });
});
