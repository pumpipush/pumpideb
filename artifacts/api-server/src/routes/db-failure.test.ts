/**
 * db-failure.test.ts — Integration tests: DB failure → clean JSON 500, no hang.
 *
 * Simulates a database outage (both `pool.query` and `db.*` Drizzle calls)
 * on the key routes that the global error handler is meant to protect:
 *
 *   GET  /api/tokens
 *   GET  /api/tokens/:address/ohlcv
 *   GET  /api/tokens/:address/trades
 *   POST /api/tokens/:address/trades
 *
 * Each route must respond with HTTP 500 and `{ error: "Internal server error" }`
 * within 1 second — i.e. no hanging connections or leaked promises.
 *
 * Strategy:
 *   • `vi.mock("@workspace/db", …)` replaces the db module before any route
 *     module loads, so all Drizzle ORM calls and raw pool.query calls reject
 *     immediately with a connection-refused error.
 *   • The mock `db` object is a recursive "rejecting proxy": any chained method
 *     call (select, from, where, limit, insert, values, …) returns the same
 *     proxy, and awaiting it rejects with the DB error.
 *   • The mock `pool` has a `query` method that also rejects immediately.
 *   • The real `asyncWrap` + `globalErrorHandler` pipeline catches those
 *     rejections and must return a clean 500 before the 1 s deadline.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ── DB mock ──────────────────────────────────────────────────────────────────
// Must be declared before any import that transitively touches @workspace/db.
// vi.mock is hoisted to the top of the compiled output regardless of where it
// appears in source, so the factory runs before the real module resolves.

vi.mock("@workspace/db", () => {
  const DB_ERR = new Error("pg: could not connect to server — connection refused (INTERNAL)");

  /**
   * makeProxy() returns an object that:
   *   1. Behaves as a thenable (Promise-like) — awaiting it rejects with DB_ERR.
   *   2. Returns a fresh makeProxy() for every method call, enabling arbitrary
   *      Drizzle chaining: db.select().from(t).where(c).limit(1) → all reject.
   *   3. Returns undefined for Symbol properties so spread / toString don't break.
   */
  function makeProxy(): unknown {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        // Make the proxy awaitable: `await proxy` calls proxy.then(onFulfilled, onRejected)
        if (prop === "then") {
          return (_onFulfilled: unknown, onRejected: (err: unknown) => void) =>
            onRejected(DB_ERR);
        }
        // Allow .catch() chaining from callers that use it directly (e.g. background updates)
        if (prop === "catch") {
          return (fn: (e: unknown) => unknown) => Promise.reject(DB_ERR).catch(fn);
        }
        // Symbol properties (Symbol.toPrimitive, Symbol.iterator, …): don't interfere
        if (typeof prop === "symbol") return undefined;
        // Any named method: return a function that itself returns a new rejecting proxy
        return () => makeProxy();
      },
    };
    return new Proxy({} as object, handler);
  }

  return {
    db: makeProxy(),
    pool: {
      query: () => Promise.reject(DB_ERR),
    },
    // Drizzle table objects: only used to build SQL AST nodes (eq, and, …)
    // before the query hits the (mocked) db.  Empty objects are enough here
    // since the mock never executes a real query.
    tokensTable: {},
    tradesTable: {},
  };
});

// ── Import app AFTER the mock is declared ────────────────────────────────────
// ESM static imports are resolved after vi.mock hoisting, so this is safe.
import app from "../app.js";

// ── Server lifecycle ──────────────────────────────────────────────────────────
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// A syntactically valid Solana base58 transaction signature (88 chars, valid alphabet).
// Used for POST body validation so the txHash guard passes and we reach the DB call.
// Regex in the route: /^[1-9A-HJ-NP-Za-km-z]{87,88}$/
// "1" is in [1-9], so 88 repetitions form a valid (if nonsensical) signature.
const VALID_TX_SIG = "1".repeat(88);

const VALID_TOKEN_ADDR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC on Solana (format only)

/** Fetch with an explicit 2 s timeout so tests never hang forever. */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2_000);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DB failure → HTTP 500 with clean JSON (no hang)", () => {
  it("GET /tokens returns 500 with { error: 'Internal server error' }", async () => {
    const res = await fetchWithTimeout(`${base}/tokens`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });
  });

  it("GET /tokens response body contains no internal DB detail", async () => {
    const res = await fetchWithTimeout(`${base}/tokens`);
    const raw = await res.text();
    expect(raw).not.toContain("connection refused");
    expect(raw).not.toContain("INTERNAL");
    expect(raw).not.toContain("pg:");
    expect(raw).not.toContain("stack");
  });

  it("GET /tokens/:address/ohlcv returns 500 with { error: 'Internal server error' }", async () => {
    const res = await fetchWithTimeout(`${base}/tokens/${VALID_TOKEN_ADDR}/ohlcv?tf=15m`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });
  });

  it("GET /tokens/:address/ohlcv response body contains no internal DB detail", async () => {
    const res = await fetchWithTimeout(`${base}/tokens/${VALID_TOKEN_ADDR}/ohlcv?tf=15m`);
    const raw = await res.text();
    expect(raw).not.toContain("connection refused");
    expect(raw).not.toContain("INTERNAL");
    expect(raw).not.toContain("pg:");
  });

  it("GET /tokens/:address/trades returns 500 with { error: 'Internal server error' }", async () => {
    const res = await fetchWithTimeout(`${base}/tokens/${VALID_TOKEN_ADDR}/trades`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });
  });

  it("GET /tokens/:address/trades response body contains no internal DB detail", async () => {
    const res = await fetchWithTimeout(`${base}/tokens/${VALID_TOKEN_ADDR}/trades`);
    const raw = await res.text();
    expect(raw).not.toContain("connection refused");
    expect(raw).not.toContain("INTERNAL");
    expect(raw).not.toContain("pg:");
  });

  it("POST /tokens/:address/trades returns 500 with { error: 'Internal server error' }", async () => {
    const res = await fetchWithTimeout(`${base}/tokens/${VALID_TOKEN_ADDR}/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash:        VALID_TX_SIG,
        traderAddress: VALID_TOKEN_ADDR, // any valid-looking address
        isBuy:         true,
        ethAmount:     "1000000000",
        tokenAmount:   "1000000",
        priceEth:      "0.000001",
        timestamp:     new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });
  });

  it("POST /tokens/:address/trades response body contains no internal DB detail", async () => {
    const res = await fetchWithTimeout(`${base}/tokens/${VALID_TOKEN_ADDR}/trades`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash:        VALID_TX_SIG,
        traderAddress: VALID_TOKEN_ADDR,
        isBuy:         true,
        ethAmount:     "1000000000",
        tokenAmount:   "1000000",
        priceEth:      "0.000001",
        timestamp:     new Date().toISOString(),
      }),
    });
    const raw = await res.text();
    expect(raw).not.toContain("connection refused");
    expect(raw).not.toContain("INTERNAL");
    expect(raw).not.toContain("pg:");
  });

  it("all four DB-failure responses arrive within 1 second", async () => {
    const start = Date.now();

    await Promise.all([
      fetchWithTimeout(`${base}/tokens`),
      fetchWithTimeout(`${base}/tokens/${VALID_TOKEN_ADDR}/ohlcv?tf=15m`),
      fetchWithTimeout(`${base}/tokens/${VALID_TOKEN_ADDR}/trades`),
      fetchWithTimeout(`${base}/tokens/${VALID_TOKEN_ADDR}/trades`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash:        VALID_TX_SIG,
          traderAddress: VALID_TOKEN_ADDR,
          isBuy:         true,
          ethAmount:     "1000000000",
          tokenAmount:   "1000000",
          priceEth:      "0.000001",
          timestamp:     new Date().toISOString(),
        }),
      }),
    ]);

    const elapsed = Date.now() - start;
    // All four requests must complete (not hang) in under 1 s.
    expect(elapsed).toBeLessThan(1_000);
  });
});
