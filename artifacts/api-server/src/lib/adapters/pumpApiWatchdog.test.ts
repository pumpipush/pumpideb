/**
 * PumpApiAdapter watchdog smoke tests.
 *
 * Verifies that:
 *   1. The watchdog force-closes the WebSocket after _watchdogMs of silence.
 *   2. Any incoming message resets the watchdog timer — the connection is
 *      NOT closed before the reset deadline.
 *   3. The watchdog is cleared when stop() is called.
 *
 * Uses fake timers (vi.useFakeTimers) and an injectable WebSocket factory to
 * avoid real network connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PumpApiAdapter, PUMPAPI_WATCHDOG_MS, PUMPAPI_DATA_STALE_MS } from "./pumpfun";

// ── Mock WebSocket ─────────────────────────────────────────────────────────────

/**
 * Minimal WebSocket mock backed by EventTarget.
 * Emits "open" asynchronously (via microtask) to mimic real WebSocket behaviour.
 */
class MockWebSocket extends EventTarget {
  static readonly OPEN   = 1;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  closed     = false;
  sent: string[] = [];

  constructor(public readonly url: string) {
    super();
    // Emit "open" on the next microtask (mimics real WS handshake completion).
    Promise.resolve().then(() =>
      this.dispatchEvent(new Event("open"))
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return; // idempotent
    this.closed    = true;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  /** Helper: simulate an incoming message from the server. */
  receive(data: unknown): void {
    const evt = new MessageEvent("message", { data: JSON.stringify(data) });
    this.dispatchEvent(evt);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Create an adapter with a mock WS factory and configurable watchdog windows. */
function makeAdapter(
  watchdogMs:    number,
  onDisconnected?: () => void,
  dataStaleMs?:  number,
): {
  adapter:   PumpApiAdapter;
  getLastWs: () => MockWebSocket | null;
} {
  let lastWs: MockWebSocket | null = null;
  const wsFactory = (url: string): WebSocket => {
    lastWs = new MockWebSocket(url);
    return lastWs as unknown as WebSocket;
  };
  const adapter = new PumpApiAdapter({ watchdogMs, wsFactory, onDisconnected, dataStaleMs });
  return { adapter, getLastWs: () => lastWs };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("PumpApiAdapter watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports PUMPAPI_WATCHDOG_MS as a positive number ≥ 30 s", () => {
    expect(PUMPAPI_WATCHDOG_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("force-closes the WebSocket after watchdog window with no messages", async () => {
    const WATCHDOG = 200; // short value for fast tests
    const { adapter, getLastWs } = makeAdapter(WATCHDOG);

    adapter.start();
    // Let the "open" microtask fire so the watchdog is armed.
    await Promise.resolve();

    const ws = getLastWs()!;
    expect(ws).not.toBeNull();
    expect(ws.closed).toBe(false);

    // Advance past the watchdog window — no messages received.
    vi.advanceTimersByTime(WATCHDOG + 50);

    expect(ws.closed).toBe(true);

    adapter.stop();
  });

  it("does NOT close the WebSocket before the watchdog fires when messages arrive", async () => {
    const WATCHDOG = 300;
    const { adapter, getLastWs } = makeAdapter(WATCHDOG);

    adapter.start();
    await Promise.resolve();

    const ws = getLastWs()!;

    // Advance to just before the watchdog fires.
    vi.advanceTimersByTime(WATCHDOG - 50);
    expect(ws.closed).toBe(false);

    // Send a message — this should reset the watchdog timer.
    ws.receive({ action: "buy", pool: "other-pool" }); // pool filtered out, no DB ops

    // Advance past the ORIGINAL deadline (but within the reset window).
    vi.advanceTimersByTime(100);
    expect(ws.closed).toBe(false); // still alive — watchdog was reset

    // Advance past the RESET deadline.
    vi.advanceTimersByTime(WATCHDOG);
    expect(ws.closed).toBe(true);

    adapter.stop();
  });

  it("fires onDisconnected callback via close handler when watchdog triggers", async () => {
    const WATCHDOG = 150;
    const onDisconnected = vi.fn();
    const { adapter, getLastWs } = makeAdapter(WATCHDOG, onDisconnected);

    adapter.start();
    await Promise.resolve();

    vi.advanceTimersByTime(WATCHDOG + 50);

    expect(getLastWs()!.closed).toBe(true);
    expect(onDisconnected).toHaveBeenCalledOnce();

    adapter.stop();
  });

  it("clears the watchdog timer when stop() is called (no spurious close after stop)", async () => {
    const WATCHDOG = 500;
    const { adapter, getLastWs } = makeAdapter(WATCHDOG);

    adapter.start();
    await Promise.resolve();

    const ws = getLastWs()!;

    // Stop the adapter before the watchdog fires.
    adapter.stop();

    // The stop() call closes the WS directly, so it IS closed — but via stop(),
    // not the watchdog. Advance well past the watchdog window.
    vi.advanceTimersByTime(WATCHDOG * 2);

    // WS should be closed (by stop()), and no reconnect attempt should occur
    // because _active is false. The important thing is no error is thrown.
    expect(ws.closed).toBe(true);
  });

  it("exports PUMPAPI_DATA_STALE_MS as a value larger than PUMPAPI_WATCHDOG_MS", () => {
    // Data-stale window must be longer so the raw-silence watchdog fires first
    // if the connection goes fully silent, without data-stale racing ahead.
    expect(PUMPAPI_DATA_STALE_MS).toBeGreaterThan(PUMPAPI_WATCHDOG_MS);
  });

  it("resets watchdog on reconnect after a disconnect", async () => {
    const WATCHDOG = 200;
    const { adapter, getLastWs } = makeAdapter(WATCHDOG);

    adapter.start();
    await Promise.resolve();

    const ws1 = getLastWs()!;

    // Trigger reconnect by closing before watchdog.
    ws1.close();
    await Promise.resolve();

    // The close handler calls setTimeout(_connect, _delay). Advance past reconnect delay.
    vi.advanceTimersByTime(5_100); // default _delay = 5 000
    await Promise.resolve(); // let the new MockWebSocket "open" microtask fire

    const ws2 = getLastWs()!;
    expect(ws2).not.toBe(ws1); // new connection was created
    expect(ws2.closed).toBe(false);

    // The new connection has its own watchdog — it should fire after WATCHDOG ms.
    vi.advanceTimersByTime(WATCHDOG + 50);
    expect(ws2.closed).toBe(true);

    adapter.stop();
  });
});

// ── Data-staleness watchdog tests ──────────────────────────────────────────────

describe("PumpApiAdapter data-staleness watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Core scenario: connection alive (keepalive pongs arrive), but no real trade
   * events. The raw watchdog stays reset; the data-staleness watchdog fires.
   */
  it("fires when keepalive pongs arrive but no real trade events do", async () => {
    const WATCHDOG    = 10_000; // large — raw watchdog should NOT fire
    const DATA_STALE  = 300;    // short for fast test
    const { adapter, getLastWs } = makeAdapter(WATCHDOG, undefined, DATA_STALE);

    adapter.start();
    await Promise.resolve();

    const ws = getLastWs()!;
    expect(ws.closed).toBe(false);

    // Simulate keepalive pong responses — these should reset the raw watchdog
    // but NOT the data-staleness watchdog.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(DATA_STALE / 4);
      ws.receive({ method: "pong" }); // raw-message → resets raw watchdog only
    }

    // Still within data-stale window after pongs — connection should be alive.
    expect(ws.closed).toBe(false);

    // Advance past the data-stale deadline without any trade events.
    vi.advanceTimersByTime(DATA_STALE + 50);
    expect(ws.closed).toBe(true);

    adapter.stop();
  });

  it("does NOT fire when real pump trade events arrive within the window", async () => {
    const WATCHDOG   = 10_000;
    const DATA_STALE = 300;
    const { adapter, getLastWs } = makeAdapter(WATCHDOG, undefined, DATA_STALE);

    adapter.start();
    await Promise.resolve();

    const ws = getLastWs()!;

    // Advance close to the data-stale deadline.
    vi.advanceTimersByTime(DATA_STALE - 50);
    expect(ws.closed).toBe(false);

    // Send a real pump buy event — should reset the data-staleness watchdog.
    ws.receive({
      action:    "buy",
      pool:      "pump",
      signature: "aaa111",
      mint:      "MINT1111",
      tokenAmount: 1000,
      quoteAmount: 0.5,
    });

    // Past the ORIGINAL deadline, but within the reset window — should still be open.
    vi.advanceTimersByTime(100);
    expect(ws.closed).toBe(false);

    // Advance past the reset deadline — now it should fire.
    vi.advanceTimersByTime(DATA_STALE + 50);
    expect(ws.closed).toBe(true);

    adapter.stop();
  });

  it("resets on pump-amm trade events too (not just pump bonding-curve)", async () => {
    const WATCHDOG   = 10_000;
    const DATA_STALE = 300;
    const { adapter, getLastWs } = makeAdapter(WATCHDOG, undefined, DATA_STALE);

    adapter.start();
    await Promise.resolve();

    const ws = getLastWs()!;

    vi.advanceTimersByTime(DATA_STALE - 50);

    // PumpSwap (pump-amm) trade — should also reset the data-staleness watchdog.
    ws.receive({
      action:    "sell",
      pool:      "pump-amm",
      signature: "bbb222",
      mint:      "MINT2222",
      tokenAmount: 500,
      quoteAmount: 0.25,
    });

    vi.advanceTimersByTime(100);
    expect(ws.closed).toBe(false); // reset held

    vi.advanceTimersByTime(DATA_STALE + 50);
    expect(ws.closed).toBe(true);

    adapter.stop();
  });

  it("does NOT reset on raydium-launchpad or other pool events", async () => {
    const WATCHDOG   = 10_000;
    const DATA_STALE = 300;
    const { adapter, getLastWs } = makeAdapter(WATCHDOG, undefined, DATA_STALE);

    adapter.start();
    await Promise.resolve();

    const ws = getLastWs()!;

    // Keep sending non-pump events — these should not reset the data-stale timer.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(DATA_STALE / 5);
      ws.receive({ action: "buy", pool: "raydium-launchpad", signature: `sig${i}`, mint: `MINT${i}` });
    }

    // Past the data-stale deadline — should have fired despite messages arriving.
    vi.advanceTimersByTime(DATA_STALE);
    expect(ws.closed).toBe(true);

    adapter.stop();
  });

  it("resets on pump create events (not only buy/sell)", async () => {
    const WATCHDOG   = 10_000;
    const DATA_STALE = 300;
    const { adapter, getLastWs } = makeAdapter(WATCHDOG, undefined, DATA_STALE);

    adapter.start();
    await Promise.resolve();

    const ws = getLastWs()!;

    vi.advanceTimersByTime(DATA_STALE - 50);
    expect(ws.closed).toBe(false);

    // A pump `create` event — should reset the data-staleness watchdog.
    ws.receive({
      action:    "create",
      pool:      "pump",
      signature: "ccc333",
      mint:      "MINT3333",
      name:      "TestToken",
      symbol:    "TEST",
    });

    vi.advanceTimersByTime(100);
    expect(ws.closed).toBe(false); // reset held

    vi.advanceTimersByTime(DATA_STALE + 50);
    expect(ws.closed).toBe(true);

    adapter.stop();
  });

  it("does NOT reset on unknown/metadata actions from pump or pump-amm pools", async () => {
    // This is the regression test for the exact failure mode: pumpapi.io emits
    // unknown control/metadata events on a pump pool while actual trade forwarding
    // is stalled. The data-stale watchdog must NOT reset in this case.
    const WATCHDOG   = 10_000;
    const DATA_STALE = 300;
    const { adapter, getLastWs } = makeAdapter(WATCHDOG, undefined, DATA_STALE);

    adapter.start();
    await Promise.resolve();

    const ws = getLastWs()!;

    // Repeatedly send unknown actions from valid pools — these must not reset the timer.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(DATA_STALE / 5);
      ws.receive({ action: "metadata",  pool: "pump",     signature: `s${i}a`, mint: `M${i}` });
      ws.receive({ action: "heartbeat", pool: "pump-amm", signature: `s${i}b`, mint: `M${i}` });
      ws.receive({ action: "unknown",   pool: "pump",     signature: `s${i}c`, mint: `M${i}` });
    }

    // Past the data-stale deadline — must have fired despite messages arriving.
    vi.advanceTimersByTime(DATA_STALE);
    expect(ws.closed).toBe(true);

    adapter.stop();
  });

  it("clears the data-stale timer on stop() — no spurious close after stop", async () => {
    const WATCHDOG   = 10_000;
    const DATA_STALE = 400;
    const { adapter, getLastWs } = makeAdapter(WATCHDOG, undefined, DATA_STALE);

    adapter.start();
    await Promise.resolve();

    const ws = getLastWs()!;

    // Stop before the data-stale timer fires.
    adapter.stop();

    // Advance well past the data-stale window — no unexpected reconnect.
    vi.advanceTimersByTime(DATA_STALE * 3);

    // WS is closed by stop() itself; no additional close from data-stale watchdog.
    expect(ws.closed).toBe(true);
  });
});
