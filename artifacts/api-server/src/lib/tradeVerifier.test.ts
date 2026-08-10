/**
 * tradeVerifier.test.ts
 *
 * Tests for the pump.fun Anchor TradeEvent-based trade verifier.
 *
 * Strategy: all economic fields come from the pump.fun program's own TradeEvent
 * log entry ("Program data: <base64>"), not from balance deltas.
 *
 * Every test constructs a deterministic RPC response that includes a correctly
 * formatted (or intentionally malformed) TradeEvent blob, and checks that
 * fetchAndParseTrade() rejects / accepts it accordingly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchAndParseTrade } from "./tradeVerifier.js";

// ── Base58 helper (inline copy — matches tradeVerifier.ts) ────────────────────

const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58Encode(bytes: Buffer | Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  const chars: string[] = [];
  while (n > 0n) { chars.unshift(BS58_ALPHA[Number(n % 58n)]); n /= 58n; }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + chars.join("");
}

// ── Deterministic test pubkeys ─────────────────────────────────────────────────
// Buffer.alloc(32, N) gives a 32-byte array of repeated byte N.
// bs58Encode produces a deterministic base58 address for each.

const TRADER_BYTES       = Buffer.alloc(32, 0x01);
const MINT_BYTES         = Buffer.alloc(32, 0x02);
const OTHER_MINT_BYTES   = Buffer.alloc(32, 0x03);
const OTHER_TRADER_BYTES = Buffer.alloc(32, 0x04);

const TRADER       = bs58Encode(TRADER_BYTES);
const MINT         = bs58Encode(MINT_BYTES);
const OTHER_MINT   = bs58Encode(OTHER_MINT_BYTES);
const OTHER_TRADER = bs58Encode(OTHER_TRADER_BYTES);

// ── pump.fun TradeEvent binary builder ────────────────────────────────────────

const TRADE_EVENT_DISC = Buffer.from("bddb7fd34ee661ee", "hex");

/**
 * Build a pump.fun TradeEvent binary (113 bytes) and return it as a
 * "Program data: <base64>" log line, ready to be placed in meta.logMessages.
 *
 * Layout (borsh):
 *   discriminator(8) + mint(32) + sol_amount(8) + token_amount(8) +
 *   is_buy(1) + user(32) + timestamp(8) + virtual_sol_reserves(8) +
 *   virtual_token_reserves(8) = 113 bytes
 */
function makeTradeEventLog(opts: {
  mintBytes?:    Buffer;
  traderBytes?:  Buffer;
  solLamports?:  bigint;
  tokenAmount?:  bigint;
  isBuy?:        boolean;
  truncateTo?:   number;   // if set, slice the buffer to this many bytes
}): string {
  const {
    mintBytes   = MINT_BYTES,
    traderBytes = TRADER_BYTES,
    solLamports = 500_000_000n,   // 0.5 SOL
    tokenAmount = 1_000_000n,     // 1M tokens
    isBuy       = true,
    truncateTo,
  } = opts;

  const buf = Buffer.alloc(113);
  let off = 0;

  // discriminator (8)
  TRADE_EVENT_DISC.copy(buf, off); off += 8;
  // mint (32)
  mintBytes.copy(buf, off); off += 32;
  // sol_amount (8, u64 LE)
  buf.writeBigUInt64LE(solLamports, off); off += 8;
  // token_amount (8, u64 LE)
  buf.writeBigUInt64LE(tokenAmount, off); off += 8;
  // is_buy (1)
  buf[off] = isBuy ? 1 : 0; off += 1;
  // user (32)
  traderBytes.copy(buf, off); off += 32;
  // timestamp (8, i64 LE)
  buf.writeBigInt64LE(1_700_000_000n, off); off += 8;
  // virtual_sol_reserves (8, u64 LE)
  buf.writeBigUInt64LE(30_000_000_000n, off); off += 8;
  // virtual_token_reserves (8, u64 LE)
  buf.writeBigUInt64LE(1_073_000_000_000n, off);

  const finalBuf = typeof truncateTo === "number" ? buf.subarray(0, truncateTo) : buf;
  return `Program data: ${finalBuf.toString("base64")}`;
}

// ── RPC response factory ──────────────────────────────────────────────────────

type MetaOverride = {
  err?: unknown;
  logMessages?: string[] | null | "ABSENT";
};

function makeRpcResponse(opts: {
  result?: null;                       // null = "not found"
  blockTime?: number | null;
  meta?: MetaOverride;
  feePayer?: string;
  logMessages?: string[];              // shorthand for meta.logMessages
}): object {
  if (opts.result === null) {
    return { result: null };
  }

  const logMessages =
    opts.logMessages != null
      ? opts.logMessages
      : (opts.meta?.logMessages === "ABSENT" ? undefined : opts.meta?.logMessages ?? []);

  const meta: Record<string, unknown> = {
    err: opts.meta?.err ?? null,
  };
  if (opts.meta?.logMessages !== "ABSENT") {
    meta["logMessages"] = logMessages;
  }

  return {
    result: {
      blockTime: opts.blockTime !== undefined ? opts.blockTime : 1_700_000_000,
      meta,
      transaction: {
        message: {
          accountKeys: [opts.feePayer ?? TRADER],
        },
      },
    },
  };
}

function okFetch(body: object, status = 200): Response {
  return {
    ok: status < 400,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("happy path — pump.fun TradeEvent parsing", () => {
  it("returns correct amounts for a valid buy", async () => {
    const log = makeTradeEventLog({ isBuy: true, solLamports: 500_000_000n, tokenAmount: 1_000_000n });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sig1", MINT, TRADER);
    expect(result).toMatchObject({
      ok:                true,
      isBuy:             true,
      solAmountLamports: "500000000",
      tokenAmountAtoms:  "1000000",
    });
  });

  it("returns correct amounts for a valid sell", async () => {
    const log = makeTradeEventLog({ isBuy: false, solLamports: 200_000_000n, tokenAmount: 500_000n });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sig2", MINT, TRADER);
    expect(result).toMatchObject({ ok: true, isBuy: false });
    if (result.ok) {
      expect(result.solAmountLamports).toBe("200000000");
      expect(result.tokenAmountAtoms).toBe("500000");
    }
  });

  it("computes priceEth as solLamports / tokenAmount / 1000", async () => {
    // 500_000_000 lamports / 1_000_000 atoms / 1000 = 0.5
    const log = makeTradeEventLog({ solLamports: 500_000_000n, tokenAmount: 1_000_000n });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sig3", MINT, TRADER);
    if (!result.ok) throw new Error("expected ok");
    expect(parseFloat(result.priceEth!)).toBeCloseTo(0.5, 5);
  });

  it("returns null priceEth when tokenAmount is 0", async () => {
    const log = makeTradeEventLog({ solLamports: 500_000_000n, tokenAmount: 0n });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sig4", MINT, TRADER);
    if (!result.ok) throw new Error("expected ok");
    expect(result.priceEth).toBeNull();
  });

  it("returns null priceEth when solLamports is 0", async () => {
    const log = makeTradeEventLog({ solLamports: 0n, tokenAmount: 1_000_000n });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sigX", MINT, TRADER);
    if (!result.ok) throw new Error("expected ok");
    expect(result.priceEth).toBeNull();
  });

  it("returns blockTime from RPC", async () => {
    const log = makeTradeEventLog({});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log], blockTime: 1_700_000_001 })),
    ));

    const result = await fetchAndParseTrade("sig5", MINT, TRADER);
    if (!result.ok) throw new Error("expected ok");
    expect(result.blockTime).toBe(1_700_000_001);
  });

  it("returns null blockTime when RPC omits it", async () => {
    const log = makeTradeEventLog({});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log], blockTime: null })),
    ));

    const result = await fetchAndParseTrade("sig6", MINT, TRADER);
    if (!result.ok) throw new Error("expected ok");
    expect(result.blockTime).toBeNull();
  });

  it("accepts the event when it appears after unrelated log lines", async () => {
    const log = makeTradeEventLog({});
    const logs = [
      "Program 11111111111111111111111111111111 invoke [1]",
      "Program 11111111111111111111111111111111 success",
      log,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: logs })),
    ));

    const result = await fetchAndParseTrade("sig7", MINT, TRADER);
    expect(result.ok).toBe(true);
  });

  it("uses finalized commitment in the RPC request", async () => {
    const log = makeTradeEventLog({});
    const mockFetch = vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log] })),
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchAndParseTrade("sigC", MINT, TRADER);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.params[1].commitment).toBe("finalized");
  });
});

// ── Authentication / signer checks ───────────────────────────────────────────

describe("authentication checks", () => {
  it("rejects (403) when fee payer ≠ claimedTrader", async () => {
    const log = makeTradeEventLog({});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ feePayer: OTHER_TRADER, logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sigA1", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("rejects (403) when TradeEvent user ≠ claimedTrader", async () => {
    // Fee payer matches, but TradeEvent user is a different address
    const log = makeTradeEventLog({ traderBytes: OTHER_TRADER_BYTES });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ feePayer: TRADER, logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sigA2", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});

// ── Wrong mint ────────────────────────────────────────────────────────────────

describe("wrong mint", () => {
  it("rejects (409) when TradeEvent mint ≠ expectedMint", async () => {
    const log = makeTradeEventLog({ mintBytes: OTHER_MINT_BYTES });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sigM1", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });
});

// ── No valid TradeEvent ───────────────────────────────────────────────────────

describe("no valid TradeEvent in logs", () => {
  it("rejects (409) when logMessages is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [] })),
    ));

    const result = await fetchAndParseTrade("sigE1", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("rejects (409) when logMessages contains only non-event lines", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({
        logMessages: [
          "Program 11111111111111111111111111111111 invoke [1]",
          "Program 11111111111111111111111111111111 success",
        ],
      })),
    ));

    const result = await fetchAndParseTrade("sigE2", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("rejects (409) when TradeEvent blob is too short (< 113 bytes)", async () => {
    const log = makeTradeEventLog({ truncateTo: 80 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sigE3", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("rejects (409) when 'Program data:' line has a non-TradeEvent discriminator", async () => {
    // Build a blob that looks like a CreateEvent (different discriminator)
    const buf = Buffer.alloc(113);
    Buffer.from("1b72a94ddeeb6376", "hex").copy(buf, 0); // CreateEvent discriminator
    const log = `Program data: ${buf.toString("base64")}`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ logMessages: [log] })),
    ));

    const result = await fetchAndParseTrade("sigE4", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("rejects (409) for a plain SPL transfer (no pump.fun program invoked)", async () => {
    // logMessages contains only SPL Token program logs, no "Program data:" line
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({
        logMessages: [
          "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]",
          "Program log: Instruction: Transfer",
          "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
        ],
      })),
    ));

    const result = await fetchAndParseTrade("sigE5", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("rejects (409) for a transaction with a real swap for a different program (no pump.fun TradeEvent)", async () => {
    // Raydium or Jupiter invoked — their logs don't emit a pump.fun TradeEvent
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({
        logMessages: [
          "Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK invoke [1]",
          "Program log: Instruction: Swap",
          "Program data: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
          "Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK success",
        ],
      })),
    ));

    const result = await fetchAndParseTrade("sigE6", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });
});

// ── Transaction-level errors ──────────────────────────────────────────────────

describe("transaction-level errors", () => {
  it("returns 404 when transaction is not found (result: null)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch({ result: null }),
    ));

    const result = await fetchAndParseTrade("sigNF", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("returns 422 when transaction was reverted (meta.err ≠ null)", async () => {
    const log = makeTradeEventLog({});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch(makeRpcResponse({ meta: { err: { InstructionError: [0, "Custom"] }, logMessages: [log] } })),
    ));

    const result = await fetchAndParseTrade("sigRev", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });
});

// ── RPC / malformed-response errors ──────────────────────────────────────────

describe("RPC and malformed response errors", () => {
  it("returns 503 when meta is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch({
        result: {
          blockTime: 1_700_000_000,
          meta: null,
          transaction: { message: { accountKeys: [TRADER] } },
        },
      }),
    ));

    const result = await fetchAndParseTrade("sigNull", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("returns 503 when accountKeys is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch({
        result: {
          blockTime: 1_700_000_000,
          meta: { err: null, logMessages: [] },
          transaction: { message: { accountKeys: [] } },
        },
      }),
    ));

    const result = await fetchAndParseTrade("sigNoKeys", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("returns 503 when meta.logMessages is absent from the RPC response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch({
        result: {
          blockTime: 1_700_000_000,
          meta: { err: null },  // no logMessages field
          transaction: { message: { accountKeys: [TRADER] } },
        },
      }),
    ));

    const result = await fetchAndParseTrade("sigNoLogs", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("returns 503 when all RPC endpoints throw (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await fetchAndParseTrade("sigNet", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("returns 503 when all RPC endpoints return HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okFetch({}, 500),
    ));

    const result = await fetchAndParseTrade("sigHTTP", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("falls back to secondary RPC when primary returns HTTP 500", async () => {
    const log = makeTradeEventLog({});
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.resolve(okFetch({}, 500));
      return Promise.resolve(okFetch(makeRpcResponse({ logMessages: [log] })));
    }));

    const result = await fetchAndParseTrade("sigFallback", MINT, TRADER);
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });

  it("falls back to secondary RPC when primary throws", async () => {
    const log = makeTradeEventLog({});
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("timeout"));
      return Promise.resolve(okFetch(makeRpcResponse({ logMessages: [log] })));
    }));

    const result = await fetchAndParseTrade("sigFallback2", MINT, TRADER);
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });

  it("returns 503 when primary returns RPC-level error and secondary throws", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.resolve(okFetch({ error: { code: -32005, message: "Rate limit" } }));
      return Promise.reject(new Error("timeout"));
    }));

    const result = await fetchAndParseTrade("sigRpcErr", MINT, TRADER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });
});
