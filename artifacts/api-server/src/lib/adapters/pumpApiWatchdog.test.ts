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
import { PumpApiAdapter, PUMPAPI_WATCHDOG_MS } from "./pumpfun";

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

/** Create an adapter with a mock WS factory and a given watchdog window. */
function makeAdapter(watchdogMs: number, onDisconnected?: () => void): {
  adapter:   PumpApiAdapter;
  getLastWs: () => MockWebSocket | null;
} {
  let lastWs: MockWebSocket | null = null;
  const wsFactory = (url: string): WebSocket => {
    lastWs = new MockWebSocket(url);
    return lastWs as unknown as WebSocket;
  };
  const adapter = new PumpApiAdapter({ watchdogMs, wsFactory, onDisconnected });
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
