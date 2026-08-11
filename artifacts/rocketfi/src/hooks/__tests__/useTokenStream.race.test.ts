/**
 * TokenStreamController — race-condition guard tests
 *
 * These tests import the PRODUCTION TokenStreamController class directly and
 * inject a mock EventSource constructor, so they exercise the real guard logic
 * rather than a hand-rolled mirror.
 *
 * Invariants under test:
 *  1. Switching addresses tears down the previous EventSource immediately.
 *  2. Stream-identity guard: stale EventSource callbacks (onopen / onmessage /
 *     onerror) return early if `esRef !== es`, so they cannot close a newer
 *     stream, flip `connected`, or inject old-token data after a switch.
 *  3. Switching away before a pending reconnect fires cancels that timer.
 *  4. Multiple rapid onerror calls on the same stream do NOT stack timers.
 *  5. `connected` is never stuck as `false` after a successful reconnect on the
 *     final stable address.
 *  6. Teardown is clean: no zombie timers or open sockets remain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenStreamController } from "../TokenStreamController.js";

// ── Mock EventSource ──────────────────────────────────────────────────────────

/** All instances created during a test, in creation order. */
let created: MockES[] = [];

class MockES {
  readonly url: string;
  closed = false;
  onopen:    (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror:   (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    created.push(this);
  }

  close() { this.closed = true; }

  // Test helpers to fire browser-managed callbacks
  fireOpen()              { this.onopen?.(); }
  fireError()             { this.onerror?.(); }
  fireMessage(data = "{}") { this.onmessage?.({ data }); }
}

// ── Callback tracker ──────────────────────────────────────────────────────────

type CallbackLog = {
  connected: boolean[];     // true=onConnected, false=onDisconnected
  messages: string[];
};

function makeCallbacks(): [ControllerCallbacks, CallbackLog] {
  const log: CallbackLog = { connected: [], messages: [] };
  const cbs: ControllerCallbacks = {
    onConnected:    () => log.connected.push(true),
    onDisconnected: () => log.connected.push(false),
    onLastEvent:    () => {},
    onMessage:      (d) => log.messages.push(d),
  };
  return [cbs, log];
}

// Import the callbacks type so we can annotate makeCallbacks
import type { ControllerCallbacks } from "../TokenStreamController.js";

// ── Factory: controller with injected mock EventSource ────────────────────────

function makeController(cbs: ControllerCallbacks): TokenStreamController {
  return new TokenStreamController(cbs, MockES as unknown as typeof EventSource);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TokenStreamController — rapid-switch & stale-callback guard", () => {
  beforeEach(() => {
    created = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Rapid switches: only one stream open ──────────────────────────────

  it("rapid switch A→B→C: exactly one stream is open, pointing at C", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    ctrl.setAddress("BBBB");
    ctrl.setAddress("CCCC");

    const stillOpen = created.filter(s => !s.closed);
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0].url).toContain("CCCC");
  });

  it("rapid switch A→B→C: previous streams are closed immediately", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    ctrl.setAddress("BBBB");
    ctrl.setAddress("CCCC");

    expect(created[0].url).toContain("AAAA");
    expect(created[0].closed).toBe(true);  // A closed when B opened

    expect(created[1].url).toContain("BBBB");
    expect(created[1].closed).toBe(true);  // B closed when C opened
  });

  // ── 2. Stale onerror guard: C's stream survives A's error ────────────────

  it("stale onerror from A does NOT close C's active stream", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    const streamA = created[0];

    ctrl.setAddress("CCCC");
    const streamC = created[1];

    // A's onerror fires late (e.g. proxy RST arrives after address switched)
    streamA.fireError();

    // C's stream must still be open
    expect(streamC.closed).toBe(false);
    expect(ctrl.activeStream).toBe(streamC);
  });

  it("stale onerror from A does NOT open a reconnect stream for A when on C", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    const streamA = created[0];
    ctrl.setAddress("CCCC");

    const totalBefore = created.length;

    streamA.fireError();
    vi.advanceTimersByTime(5_000); // past any backoff delay

    expect(created.length).toBe(totalBefore); // no reconnect for AAAA
  });

  it("stale onerror from A does NOT call onDisconnected when on C", () => {
    const [cbs, log] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    ctrl.setAddress("CCCC");

    const eventsBefore = log.connected.length;

    created[0].fireError(); // stale A error

    expect(log.connected.length).toBe(eventsBefore); // no new callback
  });

  it("rapid A→B→C: stale errors on A and B do not open reconnects for either", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    const streamA = created[0];

    ctrl.setAddress("BBBB");
    const streamB = created[1];

    ctrl.setAddress("CCCC");

    const countBefore = created.length; // 3

    streamA.fireError();
    streamB.fireError();
    vi.advanceTimersByTime(10_000);

    const newURLs = created.slice(countBefore).map(s => s.url);
    expect(newURLs.filter(u => u.includes("AAAA") || u.includes("BBBB"))).toHaveLength(0);
  });

  // ── 3. Stale onopen guard: C's connected state is not clobbered by A ────

  it("stale onopen from A does NOT call onConnected when already on C", () => {
    const [cbs, log] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    const streamA = created[0];

    ctrl.setAddress("CCCC");
    const eventsBefore = log.connected.length;

    streamA.fireOpen(); // stale open arrives late

    expect(log.connected.slice(eventsBefore)).not.toContain(true);
  });

  // ── 4. Stale onmessage guard: old-token data is not injected ────────────

  it("stale onmessage from A does NOT deliver data when already on C", () => {
    const [cbs, log] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    const streamA = created[0];

    ctrl.setAddress("CCCC");
    const messagesBefore = log.messages.length;

    streamA.fireMessage('{"type":"snapshot","token":{"address":"AAAA"}}');

    expect(log.messages.length).toBe(messagesBefore); // no injection
  });

  // ── 5. onerror on CURRENT address schedules a reconnect ─────────────────

  it("onerror on the active stream schedules a reconnect for the same address", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("CCCC");
    const countBefore = created.length;

    created[created.length - 1].fireError();
    vi.advanceTimersByTime(2_000);

    expect(created.length).toBeGreaterThan(countBefore);
    expect(created[created.length - 1].url).toContain("CCCC");
  });

  it("onerror on the active stream calls onDisconnected", () => {
    const [cbs, log] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("CCCC");
    created[created.length - 1].fireOpen(); // become connected

    const before = log.connected.length;
    created[created.length - 1].fireError();

    expect(log.connected[before]).toBe(false); // onDisconnected fired
  });

  // ── 6. Switching away cancels the pending reconnect timer ────────────────

  it("switching away before reconnect fires cancels the timer for the old address", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    created[0].fireError(); // pending reconnect for AAAA

    ctrl.setAddress("BBBB");           // cancels AAAA timer
    vi.advanceTimersByTime(10_000);    // timer would have fired

    const afterSwitch = created.slice(1);
    expect(afterSwitch.every(s => s.url.includes("BBBB"))).toBe(true);
    expect(afterSwitch.some(s => s.url.includes("AAAA"))).toBe(false);
  });

  it("switching to null cancels pending reconnect and closes stream", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    created[0].fireError();

    ctrl.setAddress(null);
    vi.advanceTimersByTime(10_000);

    expect(created.length).toBe(1); // no reconnect fired
    expect(ctrl.activeStream).toBeNull();
  });

  // ── 7. Multiple rapid onerror calls do NOT stack timers ─────────────────

  it("three rapid onerror calls on the same stream schedule at most one reconnect", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    const stream = created[0];

    // Browser / proxy can fire onerror multiple times in quick succession.
    stream.fireError();
    stream.fireError();
    stream.fireError();

    vi.advanceTimersByTime(5_000);

    // Original + at most 1 reconnect (each onerror cancels the previous timer).
    const aaaaStreams = created.filter(s => s.url.includes("AAAA"));
    expect(aaaaStreams.length).toBeLessThanOrEqual(2);
  });

  // ── 8. connected state correctness ──────────────────────────────────────

  it("onConnected fires after onopen on the settled stream", () => {
    const [cbs, log] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    ctrl.setAddress("BBBB");
    ctrl.setAddress("CCCC");

    created[created.length - 1].fireOpen();

    expect(log.connected[log.connected.length - 1]).toBe(true);
  });

  it("connected is not stuck false after rapid switches + successful reconnect", () => {
    const [cbs, log] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("T1");
    ctrl.setAddress("T2");
    ctrl.setAddress("T3");

    // Connection on T3 errors.
    created[created.length - 1].fireError();

    // Reconnect timer fires.
    vi.advanceTimersByTime(2_000);

    // Reconnected stream opens.
    created[created.length - 1].fireOpen();

    expect(log.connected[log.connected.length - 1]).toBe(true);
  });

  it("onDisconnected then onConnected cycle after error + reconnect", () => {
    const [cbs, log] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    created[0].fireOpen();
    const snapshot = log.connected.length;

    created[0].fireError();
    expect(log.connected[snapshot]).toBe(false); // disconnected

    vi.advanceTimersByTime(2_000);
    created[created.length - 1].fireOpen();
    expect(log.connected[log.connected.length - 1]).toBe(true); // reconnected
  });

  // ── 9. Teardown is clean ─────────────────────────────────────────────────

  it("teardown closes the active stream and cancels any pending reconnect", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    created[0].fireError(); // pending reconnect timer

    ctrl.teardown();
    vi.advanceTimersByTime(10_000); // timer would have fired

    expect(created.length).toBe(1);   // no reconnect
    expect(created[0].closed).toBe(true);
    expect(ctrl.activeStream).toBeNull();
  });

  it("teardown after a stable open connection clears the stream", () => {
    const [cbs, log] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");
    created[0].fireOpen();

    ctrl.teardown();

    expect(log.connected[log.connected.length - 1]).toBe(false);
    expect(created[0].closed).toBe(true);
  });

  // ── 10. Exponential backoff ──────────────────────────────────────────────

  it("consecutive failures on same address use increasing backoff", () => {
    const [cbs] = makeCallbacks();
    const ctrl = makeController(cbs);

    ctrl.setAddress("AAAA");

    // First failure — minimum delay is 1000ms (attempt 0, no jitter in isolation
    // but jitter ≤ 1000ms so advance by 2500ms to be safe).
    created[0].fireError();
    vi.advanceTimersByTime(2_500);
    expect(created.length).toBe(2); // reconnect fired

    // Second failure — minimum delay is 2000ms (attempt 1, advance 3500ms).
    created[1].fireError();
    vi.advanceTimersByTime(1_000); // advance just 1 s — still within window
    expect(created.length).toBe(2); // not yet

    vi.advanceTimersByTime(2_500); // now past worst-case 2000+1000ms
    expect(created.length).toBe(3); // second reconnect
  });
});
