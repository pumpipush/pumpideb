/**
 * adapter-fk-guard.test.ts
 *
 * Integration guard for the FK-safe trade-before-create pattern across the
 * pump.fun, Meteora, and Orca adapters.
 *
 * Context
 * -------
 * Migration 0017 added `fk_trades_token` — a FK on trades.token_address
 * referencing tokens.address ON DELETE CASCADE.
 *
 * Each adapter was fixed to upsert a minimal placeholder token row before
 * every trade INSERT so a trade arriving before the create/pool event cannot
 * hit a FK violation and be silently dropped.
 *
 * handleCreate (pump.fun) and handleNewPool (Meteora / Orca) were fixed to
 * atomically upgrade that placeholder with real name/symbol/metadata via
 * onConflictDoUpdate — even when a race causes a placeholder to be inserted
 * DURING the Birdeye fetch (after the initial SELECT).
 *
 * How these tests work
 * --------------------
 * All tests drive the ACTUAL adapter class methods (not hand-rolled SQL) with
 * network/SSE dependencies mocked:
 *   - birdeye.js: fetchBirdeyeTokenMeta, getSolPriceUsd, usdToLamports
 *   - tradeEmitter: emitTrade, emitNewToken
 *
 * pump.fun tests construct binary Anchor event logs (TradeEvent / CreateEvent)
 * and pass them as LogEvent objects to the real handleTrade / handleCreate
 * private methods (accessed via `(instance as any)`).
 *
 * Meteora / Orca tests call handleTrade and handleNewPool private methods
 * directly with simple arguments.  The race test makes fetchBirdeyeTokenMeta
 * insert a placeholder during the "fetch" so the subsequent atomic upsert
 * must upgrade it.
 *
 * Assertions (3 per platform + 1 race per Meteora/Orca = 11 total)
 * -----------------------------------------------------------------
 *   1. Trade is saved (placeholder auto-created, no FK violation).
 *   2. Placeholder has the correct platform field.
 *   3. Subsequent create/pool event fills in real name and symbol.
 *  [4.] Race: placeholder inserted during Birdeye fetch is still upgraded.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────
// vi.mock is hoisted before all imports by vitest — these lines MUST come first.

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

vi.mock("../birdeye.js", () => ({
  fetchBirdeyeTokenMeta: vi.fn(),
  getSolPriceUsd:        vi.fn(),
  usdToLamports:         vi.fn(),
}));
// pump.fun imports tradeEmitter WITHOUT .js (both paths resolve to the same file
// via TypeScript's .js→.ts rewrite; include both to be safe with vitest).
vi.mock("../tradeEmitter",    () => ({ emitTrade: vi.fn(), emitNewToken: vi.fn() }));
vi.mock("../tradeEmitter.js", () => ({ emitTrade: vi.fn(), emitNewToken: vi.fn() }));

// ── Module imports (receive mocked or real versions as appropriate) ────────────

import { fetchBirdeyeTokenMeta, getSolPriceUsd, usdToLamports } from "../birdeye.js";
import { emitNewToken } from "../tradeEmitter.js"; // same path Meteora/Orca adapters use
import { eq, inArray } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";

// Real adapter classes — dependencies above are mocked, DB is real.
import { PumpFunChainIndexer } from "./pumpfun.js";
import { MeteoraIndexer } from "./meteora.js";
import { OrcaIndexer } from "./orca.js";

// ── Birdeye mock defaults ─────────────────────────────────────────────────────

const FAKE_META = {
  address:        "FakeBirdeyeTokenAddressForTestFixture111111",
  name:           "Test Token",
  symbol:         "TST",
  logoURI:        null as string | null,
  decimals:       9,
  priceUsd:       0.002,
  marketCapUsd:   200_000,
  v24hUSD:        5_000,
  liquidity:      80_000,
  priceChange24h: 1.5,
};

beforeEach(() => {
  vi.clearAllMocks(); // reset call counts before each test
  vi.mocked(getSolPriceUsd).mockResolvedValue(150);
  vi.mocked(usdToLamports).mockReturnValue("300000000"); // fake lamport string
  vi.mocked(fetchBirdeyeTokenMeta).mockResolvedValue({ ...FAKE_META });
});

// ── Address helpers ───────────────────────────────────────────────────────────

const TAG = `fkgd_${Date.now().toString(36)}`;

/** Deterministic 32-byte buffer for a given label. */
function mintBuf(label: string): Buffer {
  const b = Buffer.alloc(32, 0);
  Buffer.from(`${label}${TAG}`).copy(b);
  return b;
}

/** Minimal Base58 encoder (no external dep). */
const BS58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes: Buffer): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const c: string[] = [];
  while (n > 0n) { c.unshift(BS58[Number(n % 58n)]); n /= 58n; }
  let l = 0;
  for (const b of bytes) { if (b !== 0) break; l++; }
  return "1".repeat(l) + c.join("");
}

let txSeq = 0;
const nextSig = (prefix: string) =>
  `${prefix}Sig${TAG}${(++txSeq).toString().padStart(4, "0")}`;

const ALL_MINTS: string[] = [];

afterAll(async () => {
  if (!ALL_MINTS.length) return;
  await db.delete(tradesTable).where(inArray(tradesTable.tokenAddress, ALL_MINTS));
  await db.delete(tokensTable).where(inArray(tokensTable.address, ALL_MINTS));
});

// ── Binary Anchor event helpers (pump.fun only) ───────────────────────────────

/**
 * Build a valid 113-byte pump.fun TradeEvent log line.
 *
 * Layout (borsh):
 *   disc(8) mint(32) sol(8) tok(8) isBuy(1) trader(32) ts(8) vSol(8) vTok(8)
 */
function buildTradeLog(
  mint: Buffer, solLam: bigint, tokAmt: bigint, isBuy: boolean,
  trader: Buffer, vSol: bigint, vTok: bigint,
): string {
  const b = Buffer.allocUnsafe(113);
  Buffer.from("bddb7fd34ee661ee", "hex").copy(b, 0);
  mint.copy(b, 8);
  b.writeBigUInt64LE(solLam, 40);
  b.writeBigUInt64LE(tokAmt, 48);
  b[56] = isBuy ? 1 : 0;
  trader.copy(b, 57);
  b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 89);
  b.writeBigUInt64LE(vSol, 97);
  b.writeBigUInt64LE(vTok, 105);
  return `Program data: ${b.toString("base64")}`;
}

/**
 * Build a pump.fun CreateEvent log line.
 *
 * Layout (borsh): disc(8) name(str) symbol(str) uri(str) mint(32) bondingCurve(32) user(32)
 * Passes empty uri ("") so handleCreate skips the IPFS fetch entirely.
 */
function buildCreateLog(name: string, symbol: string, mint: Buffer, creator: Buffer): string {
  const nBuf = Buffer.from(name,   "utf8");
  const sBuf = Buffer.from(symbol, "utf8");
  const uBuf = Buffer.alloc(0);              // empty uri
  const size = 8 + 4 + nBuf.length + 4 + sBuf.length + 4 + uBuf.length + 96;
  const b = Buffer.allocUnsafe(size);
  Buffer.from("1b72a94ddeeb6376", "hex").copy(b, 0);
  let off = 8;
  b.writeUInt32LE(nBuf.length, off); off += 4;
  nBuf.copy(b, off); off += nBuf.length;
  b.writeUInt32LE(sBuf.length, off); off += 4;
  sBuf.copy(b, off); off += sBuf.length;
  b.writeUInt32LE(0, off); off += 4;        // uri length = 0
  mint.copy(b, off); off += 32;
  Buffer.alloc(32, 0xBB).copy(b, off); off += 32; // bondingCurve (filler)
  creator.copy(b, off);
  return `Program data: ${b.toString("base64")}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// pump.fun — FK guard via actual PumpFunChainIndexer
// ══════════════════════════════════════════════════════════════════════════════

describe("pump.fun adapter — FK guard (trade-before-create)", () => {
  const MINT_BUF     = mintBuf("pf");
  const CREATOR_BUF  = mintBuf("pfCr");
  const TRADER_BUF   = mintBuf("pfTr");
  const MINT         = bs58(MINT_BUF);
  const REAL_NAME    = "Pumpi Guard Token";
  const REAL_SYMBOL  = "PGT";

  let indexer: PumpFunChainIndexer;

  beforeAll(async () => {
    ALL_MINTS.push(MINT);
    indexer = new PumpFunChainIndexer();  // no start() — avoids WebSocket
  });

  it("1. handleTrade saves the trade without FK violation (placeholder auto-created)", async () => {
    const tradeLog = buildTradeLog(
      MINT_BUF,
      1_000_000_000n, // 1 SOL (above 10 000 lamport dust guard)
      50_000_000n,    // 50 M token atoms (above 1 000 dust guard)
      true,
      TRADER_BUF,
      31_000_000_000n,       // vSol post-trade
      1_023_000_191_045_000n, // vTok post-trade
    );

    // Call the real handleTrade private method (accesses actual adapter code)
    await (indexer as any).handleTrade({ signature: nextSig("pf"), logs: [tradeLog] });

    const [trade] = await db
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(eq(tradesTable.tokenAddress, MINT));

    expect(trade, "trade must be saved — FK violation would have thrown").toBeDefined();
  });

  it("2. placeholder token has platform=pump_fun", async () => {
    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(token, "placeholder token row must exist").toBeDefined();
    expect(token.platform).toBe("pump_fun");
    // Confirm it is still the placeholder — handleCreate has not run yet.
    expect(token.name).toBe(MINT.slice(0, 8));
    expect(token.symbol).toBe("???");
  });

  it("3. handleCreate fills in real name and symbol (placeholder upgraded)", async () => {
    const createLog = buildCreateLog(REAL_NAME, REAL_SYMBOL, MINT_BUF, CREATOR_BUF);

    // Call the real handleCreate private method
    await (indexer as any).handleCreate({
      signature: nextSig("pfC"),
      logs: [
        "Program log: Instruction: Create", // satisfies any log prefix checks
        createLog,
      ],
    });

    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(token.name,   "handleCreate must overwrite placeholder name").toBe(REAL_NAME);
    expect(token.symbol, "handleCreate must overwrite placeholder symbol").toBe(REAL_SYMBOL);
    expect(token.platform).toBe("pump_fun");
    // Trade data written by handleTrade must be preserved (tradeCount > 0).
    expect(Number(token.tradeCount)).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Meteora — FK guard via actual MeteoraIndexer
// ══════════════════════════════════════════════════════════════════════════════

describe("meteora adapter — FK guard (trade-before-create)", () => {
  const MINT      = bs58(mintBuf("mt"));
  const RACE_MINT = bs58(mintBuf("mtRace"));

  let adapter: MeteoraIndexer;

  beforeAll(async () => {
    ALL_MINTS.push(MINT, RACE_MINT);
    adapter = new MeteoraIndexer(); // no start() — avoids WebSocket
  });

  it("1. handleTrade saves the trade without FK violation (placeholder auto-created)", async () => {
    // Call the real handleTrade private method directly
    await (adapter as any).handleTrade(
      MINT, true, "500000000", "25000000",
      bs58(mintBuf("mtTr")), nextSig("mt"),
    );

    const [trade] = await db
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(eq(tradesTable.tokenAddress, MINT));

    expect(trade, "trade must be saved — FK violation would have thrown").toBeDefined();
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

  it("3. handleNewPool fills in real name and symbol (placeholder upgraded)", async () => {
    // fetchBirdeyeTokenMeta already mocked (beforeEach) to return FAKE_META
    await (adapter as any).handleNewPool(MINT);

    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(token.name,   "handleNewPool must overwrite placeholder name").toBe(FAKE_META.name);
    expect(token.symbol, "handleNewPool must overwrite placeholder symbol").toBe(FAKE_META.symbol);
    expect(token.platform).toBe("meteora");
    expect(token.graduated).toBe(true);
    expect(Number(token.tradeCount)).toBeGreaterThanOrEqual(1);
  });

  it("4. race: placeholder inserted during Birdeye fetch is still upgraded", async () => {
    // Configure the mock to simulate the TOCTOU race:
    //   handleNewPool SELECT → no row → begins Birdeye "fetch" →
    //   handleTrade inserts placeholder → Birdeye "fetch" returns →
    //   handleNewPool atomic upsert must upgrade the placeholder
    vi.mocked(fetchBirdeyeTokenMeta).mockImplementationOnce(async (mint) => {
      // Simulate a concurrent trade inserting a placeholder during the fetch
      await db.insert(tokensTable).values({
        address:        mint,
        name:           mint.slice(0, 8),
        symbol:         "???",
        creatorAddress: "unknown",
        platform:       "meteora",
        chain:          "solana",
      }).onConflictDoNothing();
      return { ...FAKE_META, name: "Race Token", symbol: "RCE", address: mint };
    });

    await (adapter as any).handleNewPool(RACE_MINT);

    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, RACE_MINT));

    expect(token, "token must exist after race scenario").toBeDefined();
    expect(token.name,   "race placeholder must be upgraded to real name").toBe("Race Token");
    expect(token.symbol, "race placeholder must be upgraded to real symbol").toBe("RCE");
    expect(token.platform).toBe("meteora");
  });

  it("5. concurrent pool handlers: exactly one broadcast, winning row preserved", async () => {
    const CONC_MINT = bs58(mintBuf("mtConc"));
    ALL_MINTS.push(CONC_MINT);

    // Simulate a concurrent handleNewPool that inserts a REAL row (not a
    // placeholder) during our Birdeye fetch. The DO UPDATE WHERE (symbol='???')
    // condition is false for this real row, so RETURNING is empty → no broadcast.
    vi.mocked(fetchBirdeyeTokenMeta).mockImplementationOnce(async (mint) => {
      await db.insert(tokensTable).values({
        address:        mint,
        name:           "Concurrent Winner",
        symbol:         "WIN",
        imageUrl:       null,
        creatorAddress: "unknown",
        platform:       "meteora",
        chain:          "solana",
        graduated:      true,
      }).onConflictDoNothing();
      return { ...FAKE_META, name: "Second Handler Token", symbol: "SHT", address: mint };
    });

    await (adapter as any).handleNewPool(CONC_MINT);

    // DO UPDATE WHERE (symbol='???') was false for the real row → skipped → no broadcast
    expect(vi.mocked(emitNewToken)).not.toHaveBeenCalled();

    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, CONC_MINT));

    expect(token.name,   "concurrent winner's name must not be overwritten").toBe("Concurrent Winner");
    expect(token.symbol, "concurrent winner's symbol must not be overwritten").toBe("WIN");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Orca — FK guard via actual OrcaIndexer
// ══════════════════════════════════════════════════════════════════════════════

describe("orca adapter — FK guard (trade-before-create)", () => {
  const MINT      = bs58(mintBuf("or"));
  const RACE_MINT = bs58(mintBuf("orRace"));

  let adapter: OrcaIndexer;

  beforeAll(async () => {
    ALL_MINTS.push(MINT, RACE_MINT);
    adapter = new OrcaIndexer(); // no start() — avoids WebSocket
  });

  it("1. handleTrade saves the trade without FK violation (placeholder auto-created)", async () => {
    await (adapter as any).handleTrade(
      MINT, false, "750000000", "10000000",
      bs58(mintBuf("orTr")), nextSig("or"),
    );

    const [trade] = await db
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(eq(tradesTable.tokenAddress, MINT));

    expect(trade, "trade must be saved — FK violation would have thrown").toBeDefined();
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

  it("3. handleNewPool fills in real name and symbol (placeholder upgraded)", async () => {
    await (adapter as any).handleNewPool(MINT);

    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, MINT));

    expect(token.name,   "handleNewPool must overwrite placeholder name").toBe(FAKE_META.name);
    expect(token.symbol, "handleNewPool must overwrite placeholder symbol").toBe(FAKE_META.symbol);
    expect(token.platform).toBe("orca");
    expect(token.graduated).toBe(true);
    expect(Number(token.tradeCount)).toBeGreaterThanOrEqual(1);
  });

  it("4. race: placeholder inserted during Birdeye fetch is still upgraded", async () => {
    vi.mocked(fetchBirdeyeTokenMeta).mockImplementationOnce(async (mint) => {
      await db.insert(tokensTable).values({
        address:        mint,
        name:           mint.slice(0, 8),
        symbol:         "???",
        creatorAddress: "unknown",
        platform:       "orca",
        chain:          "solana",
      }).onConflictDoNothing();
      return { ...FAKE_META, name: "Orca Race Token", symbol: "ORC", address: mint };
    });

    await (adapter as any).handleNewPool(RACE_MINT);

    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, RACE_MINT));

    expect(token, "token must exist after race scenario").toBeDefined();
    expect(token.name,   "race placeholder must be upgraded to real name").toBe("Orca Race Token");
    expect(token.symbol, "race placeholder must be upgraded to real symbol").toBe("ORC");
    expect(token.platform).toBe("orca");
  });

  it("5. concurrent pool handlers: exactly one broadcast, winning row preserved", async () => {
    const CONC_MINT = bs58(mintBuf("orConc"));
    ALL_MINTS.push(CONC_MINT);

    vi.mocked(fetchBirdeyeTokenMeta).mockImplementationOnce(async (mint) => {
      await db.insert(tokensTable).values({
        address:        mint,
        name:           "Orca Concurrent Winner",
        symbol:         "OCW",
        imageUrl:       null,
        creatorAddress: "unknown",
        platform:       "orca",
        chain:          "solana",
        graduated:      true,
      }).onConflictDoNothing();
      return { ...FAKE_META, name: "Second Orca Handler", symbol: "SOH", address: mint };
    });

    await (adapter as any).handleNewPool(CONC_MINT);

    expect(vi.mocked(emitNewToken)).not.toHaveBeenCalled();

    const [token] = await db
      .select()
      .from(tokensTable)
      .where(eq(tokensTable.address, CONC_MINT));

    expect(token.name,   "concurrent winner's name must not be overwritten").toBe("Orca Concurrent Winner");
    expect(token.symbol, "concurrent winner's symbol must not be overwritten").toBe("OCW");
  });
});
