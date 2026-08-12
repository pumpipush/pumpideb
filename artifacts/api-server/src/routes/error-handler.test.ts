/**
 * error-handler.test.ts — Integration tests for the global error handler and asyncWrap.
 *
 * Verifies two key guarantees:
 *   1. asyncWrap forwards rejected async handlers to next(err).
 *   2. The global error handler returns a clean JSON 500 with no internal detail.
 *
 * Uses a minimal in-process Express app + supertest — no real DB required.
 */

import { describe, it, expect, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { asyncWrap } from "../lib/asyncHandler.js";
import { globalErrorHandler } from "../lib/errorHandler.js";

// ── asyncWrap unit tests ────────────────────────────────────────────────────

describe("asyncWrap", () => {
  it("calls next(err) when the async handler rejects", async () => {
    const boom = new Error("postgres: connection refused — internal detail");
    const next = vi.fn();
    const wrapped = asyncWrap(async () => {
      throw boom;
    });

    await wrapped({} as Request, {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(boom);
  });

  it("does not call next when the handler resolves normally", async () => {
    const next = vi.fn();
    const mockRes = { json: vi.fn() } as unknown as Response;
    const wrapped = asyncWrap(async (_req, res) => {
      res.json({ ok: true });
    });

    await wrapped({} as Request, mockRes, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalledWith({ ok: true });
  });
});

// ── globalErrorHandler integration tests ───────────────────────────────────

function makeTestApp() {
  const app = express();
  app.use(express.json());

  // A route that rejects — simulates a DB failure inside an asyncWrap handler.
  app.get(
    "/fail",
    asyncWrap(async () => {
      throw new Error("postgres: password authentication failed — secret host info");
    }),
  );

  // A route that explicitly calls next(err).
  app.get("/next-err", (_req: Request, _res: Response, next: NextFunction) => {
    next(new Error("internal RPC key: abc123"));
  });

  // A route where headers are already sent before the error — simulates an SSE
  // or streaming route that hits an error partway through.
  app.get("/already-sent", (req: Request, res: Response, next: NextFunction) => {
    res.status(200).end("partial response");
    // Emit the error after headers are sent.
    next(new Error("error after partial flush"));
  });

  app.use(globalErrorHandler);
  return app;
}

const testApp = makeTestApp();

describe("globalErrorHandler", () => {
  it("returns HTTP 500 with generic JSON when a route rejects", async () => {
    const res = await request(testApp).get("/fail");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });

  it("does not include any internal detail in the 500 body", async () => {
    const res = await request(testApp).get("/fail");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("postgres");
    expect(body).not.toContain("password");
    expect(body).not.toContain("secret");
    expect(res.body.detail).toBeUndefined();
    expect(res.body.message).toBeUndefined();
  });

  it("returns HTTP 500 with generic JSON when next(err) is called directly", async () => {
    const res = await request(testApp).get("/next-err");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("abc123");
  });

  it("does not attempt to write a second response when headers are already sent", async () => {
    // The handler calls next(err) after headers are flushed.
    // The error handler must call next(err) instead of trying to write a 500.
    // supertest receives the partial 200 sent before the error.
    const res = await request(testApp).get("/already-sent");
    expect(res.status).toBe(200);
  });
});
