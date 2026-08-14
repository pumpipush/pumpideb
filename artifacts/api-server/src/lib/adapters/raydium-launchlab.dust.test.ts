/**
 * raydium-launchlab.dust.test.ts
 *
 * Guards against the MIN_PRICE_ATOMS dust-trade filter being accidentally
 * removed or bypassed in the LaunchLab adapter.
 *
 * Covers two independent layers:
 *
 *   UNIT — parseTradeEventFromLogs boundary
 *     The parser itself only rejects tokenAmount = 0.  Values 1, 999, 1000
 *     and 1001 all come back as parsed events; the MIN_PRICE_ATOMS guard
 *     lives one level up in handleTrade.
 *
 *   INTEGRATION (DB-state) — handleTrade fast-path dust guard
 *     For tokenAmount < 1 000 the adapter must return early without
 *     incrementing tradeCount or inserting any row into trades.
 *     For tokenAmount ≥ 1 000 it must update tradeCount and insert the trade.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseTradeEventFromLogs } from "./raydium-launchlab.js";

// ── TradeEvent layout constants ──────────────────────────────────────────────

const DISC        = Buffer.from("bddb7fd34ee661ee", "hex");
const POOL_BYTES  = Buffer.alloc(32, 0xaa); // deterministic fake pool address
const MINT_BYTES  = Buffer.alloc(32, 0xbb); // deterministic fake token mint

// Base58 encoder (same algorithm as the adapter) ─────────────────────────────
const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes: Buffer | Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const chars: string[] = [];
  while (n > 0n) { chars.unshift(BS58_ALPHA[Number(n % 58n)]!); n /= 58n; }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + chars.join("");
}

const POOL_ADDRESS = bs58Encode(POOL_BYTES);
const MINT_ADDRESS = bs58Encode(MINT_BYTES);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a 147-byte LaunchLab TradeEvent binary and return it as a
 * "Program data: <base64>" log line.
 *
 *   [0..7]   discriminator  bddb7fd34ee661ee
 *   [8..39]  poolAddress    (32 bytes)
 *   [40..71] reserves       4 × u64 (zeroed in tests)
 *   [72..79] sol_amount     lamports (LE u64)
 *   [80..87] tok_amount     base units (LE u64)
 *   [88]     is_buy         1 = buy, 0 = sell
 *   [89..146] padding
 */
function makeLLTradeEventLog(
  solLamports: bigint,
  tokenAmount: bigint,
  isBuy = true,
): string {
  const buf = Buffer.alloc(147, 0);
  DISC.copy(buf, 0);
  POOL_BYTES.copy(buf, 8);
  // reserves [40..71] left as zero
  buf.writeBigUInt64LE(solLamports, 72);
  buf.writeBigUInt64LE(tokenAmount, 80);
  buf[88] = isBuy ? 1 : 0;
  return "Program data: " + buf.toString("base64");
}

/** Build a minimal logs array containing a BuyExactIn trade event. */
function makeBuyLogs(tokenAmount: bigint, solLamports = 195_000_000_000n): string[] {
  return [
    "Program LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj invoke [1]",
    "Instruction: BuyExactIn",
    makeLLTradeEventLog(solLamports, tokenAmount, true),
    "Program LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj success",
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT: parseTradeEventFromLogs — tokenAmount boundary
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseTradeEventFromLogs — tokenAmount zero / boundary", () => {
  it("returns null when tokenAmount = 0 (zero-amount early skip in parser)", () => {
    // The parser itself rejects tokenAmount = 0 via `tokenAmount === "0"` check.
    expect(parseTradeEventFromLogs(makeBuyLogs(0n))).toBeNull();
  });

  it("returns null when solLamports = 0 (zero-amount early skip in parser)", () => {
    // The parser rejects solLamports = 0 for symmetry even if tokenAmount > 0.
    const logs = [
      "Instruction: BuyExactIn",
      makeLLTradeEventLog(0n, 500_000n, true),
    ];
    expect(parseTradeEventFromLogs(logs)).toBeNull();
  });

  it("returns parsed event with tokenAmount '1' — dust, passes parser (MIN_PRICE_ATOMS guard is in handleTrade)", () => {
    const result = parseTradeEventFromLogs(makeBuyLogs(1n));
    expect(result).not.toBeNull();
    expect(result?.tokenAmount).toBe("1");
  });

  it("returns parsed event with tokenAmount '999' — just below MIN_PRICE_ATOMS threshold", () => {
    const result = parseTradeEventFromLogs(makeBuyLogs(999n));
    expect(result).not.toBeNull();
    expect(result?.tokenAmount).toBe("999");
  });

  it("returns parsed event with tokenAmount '1000' — exactly at MIN_PRICE_ATOMS threshold", () => {
    const result = parseTradeEventFromLogs(makeBuyLogs(1000n));
    expect(result).not.toBeNull();
    expect(result?.tokenAmount).toBe("1000");
  });

  it("returns parsed event with tokenAmount '1001' — above MIN_PRICE_ATOMS threshold", () => {
    const result = parseTradeEventFromLogs(makeBuyLogs(1001n));
    expect(result).not.toBeNull();
    expect(result?.tokenAmount).toBe("1001");
  });

  it("carries the correct isBuy flag for a sell instruction", () => {
    const logs = [
      "Instruction: SellExactIn",
      makeLLTradeEventLog(5_000_000_000n, 50_000_000n, false),
    ];
    const result = parseTradeEventFromLogs(logs);
    expect(result).not.toBeNull();
    expect(result?.isBuy).toBe(false);
  });

  it("returns null when logs contain no buy or sell instruction", () => {
    const logs = [
      "Instruction: createLaunchpad",
      makeLLTradeEventLog(1_000_000_000n, 1_000_000n, true),
    ];
    expect(parseTradeEventFromLogs(logs)).toBeNull();
  });

  it("skips log lines that are too short (<89 bytes after base64 decode)", () => {
    // A buffer that has the right discriminator but is only 50 bytes long.
    const short = Buffer.alloc(50, 0);
    DISC.copy(short, 0);
    const logs = [
      "Instruction: BuyExactIn",
      "Program data: " + short.toString("base64"),
    ];
    expect(parseTradeEventFromLogs(logs)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION (DB-state): handleTrade fast-path dust guard
//
// Strategy:
//   1. Mock @workspace/db so we can observe every db call.
//   2. Mock fetch so getMintForPool() resolves a deterministic pool→mint mapping
//      (the mint bytes live at offset 205 in the pool state account).
//   3. Instantiate RaydiumLaunchLabIndexer and call the private handleTrade()
//      via cast-to-any so we don't need a WebSocket connection.
//   4. Assert which db operations were / were not performed.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Build a fake pool state account (≥237 bytes) with MINT_BYTES at offset 205 ──
const POOL_MINT_OFFSET = 205;
const fakePoolData = Buffer.alloc(POOL_MINT_OFFSET + 32 + 10, 0x00);
MINT_BYTES.copy(fakePoolData, POOL_MINT_OFFSET);
const fakePoolData64 = fakePoolData.toString("base64");

/** Stub fetch so getMintForPool returns MINT_ADDRESS from POOL_ADDRESS. */
function stubFetchForPool(): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    json: async () => ({
      result: {
        value: { data: [fakePoolData64, "base64"] },
      },
    }),
  }));
}

// ── Drizzle mock builder ──────────────────────────────────────────────────────

/**
 * Build a minimal Drizzle-compatible mock that tracks calls.
 *
 *   db.select()   — returns [{id: 1}] (token already exists in DB)
 *   db.insert()   — tracked; onConflictDoNothing() returns []
 *   db.update()   — tracked; set().where() resolves to []
 */
interface DbMock {
  select:       ReturnType<typeof vi.fn>;
  insert:       ReturnType<typeof vi.fn>;
  update:       ReturnType<typeof vi.fn>;
  /** Convenience: all db.update().set() spy calls */
  updateSetSpy: ReturnType<typeof vi.fn>;
  /** Convenience: all db.insert().values() spy calls */
  insertValuesSpy: ReturnType<typeof vi.fn>;
}

function makeDbMock(tokenExists = true): DbMock {
  const updateWhere    = vi.fn().mockResolvedValue([]);
  const updateSet      = vi.fn().mockReturnValue({ where: updateWhere });
  const update         = vi.fn().mockReturnValue({ set: updateSet });

  const insertReturning         = vi.fn().mockResolvedValue([{ id: 99 }]);
  const insertOnConflict        = vi.fn().mockReturnValue({ returning: insertReturning });
  const insertOnConflictNothing = vi.fn().mockReturnValue({ returning: insertReturning });
  const insertValues            = vi.fn().mockReturnValue({
    onConflictDoNothing: insertOnConflictNothing,
    returning: insertReturning,
  });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  const selectLimit = vi.fn().mockResolvedValue(tokenExists ? [{ id: 1 }] : []);
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom  = vi.fn().mockReturnValue({ where: selectWhere });
  const select      = vi.fn().mockReturnValue({ from: selectFrom });

  return {
    select,
    insert,
    update,
    updateSetSpy:    updateSet,
    insertValuesSpy: insertValues,
  };
}

// ── Module mocks (declared at top level so vi.mock hoisting works) ────────────

vi.mock("@workspace/db", () => {
  // Provide a placeholder; each test replaces db via vi.mocked
  return {
    db:          null,   // overridden per-test via vi.doMock or module re-import
    tokensTable: { address: "address", tradeCount: "tradeCount" },
    tradesTable: {},
  };
});
vi.mock("../tradeEmitter",    () => ({ emitTrade: vi.fn(), emitNewToken: vi.fn() }));
vi.mock("../safeUriFetch",    () => ({ fetchSafeUriMeta: vi.fn() }));
vi.mock("../launchlabBackfill", () => ({ hotBackfillLaunchLabTokens: vi.fn() }));
vi.mock("../logger", () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      info:  vi.fn(),
      warn:  vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// ── Integration suite ─────────────────────────────────────────────────────────

describe("handleTrade fast-path — MIN_PRICE_ATOMS dust guard (DB-state)", () => {
  let dbMock:   DbMock;
  let indexer:  import("./raydium-launchlab.js").RaydiumLaunchLabIndexer;

  /** Helper: build a fake LogEvent with the given tokenAmount. */
  function makeEvent(tokenAmount: bigint, solLamports = 195_000_000_000n) {
    return {
      signature: "FAKESIG123",
      logs: makeBuyLogs(tokenAmount, solLamports),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    stubFetchForPool();

    // Wire a fresh db mock into the module for this test.
    dbMock = makeDbMock(/* tokenExists */ true);

    const dbModule = await import("@workspace/db");
    // Cast away readonly so we can inject our mock object.
    (dbModule as unknown as { db: unknown }).db = dbMock;

    // Import the indexer class under the mocked environment.
    // Dynamic import ensures we pick up the newly wired db mock.
    const mod = await import("./raydium-launchlab.js");
    indexer = new mod.RaydiumLaunchLabIndexer();

    // Seed the pool→mint cache so getMintForPool is instant and deterministic.
    // Access via cast-to-any since _poolMintCache is private.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (indexer as any)._poolMintCache.set(POOL_ADDRESS, MINT_ADDRESS);
  });

  // ── Dust: tokenAmount = 1 ──────────────────────────────────────────────────

  it("tokenAmount=1: does NOT increment tradeCount", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (indexer as any).handleTrade(makeEvent(1n));

    // db.update should never have been called (no tradeCount increment)
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("tokenAmount=1: does NOT insert any row into tradesTable", async () => {
    const { tradesTable } = await import("@workspace/db");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (indexer as any).handleTrade(makeEvent(1n));

    // If insert was called at all, it must have been only for tokensTable
    // auto-creation (token already exists in our mock, so even that shouldn't
    // happen).  Regardless, no insert with tradesTable as argument.
    const insertCalls = dbMock.insert.mock.calls;
    const tradeInserts = insertCalls.filter(([table]: [unknown]) => table === tradesTable);
    expect(tradeInserts).toHaveLength(0);
  });

  // ── Dust: tokenAmount = 999 ────────────────────────────────────────────────

  it("tokenAmount=999: does NOT increment tradeCount", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (indexer as any).handleTrade(makeEvent(999n));

    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("tokenAmount=999: does NOT insert any row into tradesTable", async () => {
    const { tradesTable } = await import("@workspace/db");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (indexer as any).handleTrade(makeEvent(999n));

    const insertCalls = dbMock.insert.mock.calls;
    const tradeInserts = insertCalls.filter(([table]: [unknown]) => table === tradesTable);
    expect(tradeInserts).toHaveLength(0);
  });

  // ── Boundary: tokenAmount = 1000 (not dust) ────────────────────────────────

  it("tokenAmount=1000: DOES increment tradeCount (not filtered)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (indexer as any).handleTrade(makeEvent(1000n));

    // db.update() is called to bump tradeCount
    expect(dbMock.update).toHaveBeenCalled();
  });

  it("tokenAmount=1000: sets are called with tradeCount increment expression", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (indexer as any).handleTrade(makeEvent(1000n));

    // The set() call receives an object that contains tradeCount; confirm
    // at least one update .set() happened (tradeCount is a sql`` template tag,
    // so we just confirm set was called at all).
    expect(dbMock.updateSetSpy).toHaveBeenCalled();
  });

  // ── Above boundary: tokenAmount = 1001 (not dust) ─────────────────────────

  it("tokenAmount=1001: DOES increment tradeCount", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (indexer as any).handleTrade(makeEvent(1001n));

    expect(dbMock.update).toHaveBeenCalled();
  });

  // ── Zero-solLamports event is dropped by parseTradeEventFromLogs ──────────
  // (this ensures a zero-sol trade cannot be injected at the handleTrade boundary)

  it("solLamports=0 with tokenAmount=5000: parseTradeEventFromLogs returns null → handleTrade is a no-op", async () => {
    const zeroSolLogs = [
      "Instruction: BuyExactIn",
      makeLLTradeEventLog(0n, 5_000n, true),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (indexer as any).handleTrade({ signature: "FAKESIG456", logs: zeroSolLogs });

    // No db operations should have occurred
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});
