/**
 * TokenStreamController — stream lifecycle management extracted from useTokenStream.
 *
 * Extracted so it can be imported and unit-tested directly without React / jsdom.
 * useTokenStream.ts is a thin wrapper around this class.
 *
 * Key correctness invariant (stale-callback guard):
 *   Every EventSource callback (`onopen`, `onmessage`, `onerror`) checks
 *   `this.esRef === es` at the top. If the active stream has already been
 *   replaced (because the user switched tokens), the callback returns immediately
 *   and does NOT close the new stream, change connected state, or schedule a
 *   reconnect for the old address.
 */

/** ≤1 s random jitter added on top of exponential base to spread reconnect storms. */
export function reconnectDelayMs(attempt: number, maxMs = 30_000): number {
  const base = Math.min(1_000 * Math.pow(2, attempt), maxMs);
  return base + Math.random() * 1_000;
}

export type ControllerCallbacks = {
  /** Called when the SSE connection successfully opens. */
  onConnected: () => void;
  /** Called when the SSE connection closes or errors. */
  onDisconnected: () => void;
  /** Called with raw SSE frame data for the active token. */
  onMessage: (data: string) => void;
  /** Called whenever any event arrives; used to reset the watchdog timer. */
  onLastEvent: (ms: number) => void;
};

export class TokenStreamController {
  private esRef: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Shared with onerror closures so they can check the current token address. */
  private tokenAddressRef = { current: null as string | null };

  reconnectAttempts = 0;

  /**
   * @param callbacks  State hooks / side-effect handlers provided by the host.
   * @param ESSrc      EventSource constructor — injectable so tests can pass a mock.
   */
  constructor(
    private readonly callbacks: ControllerCallbacks,
    private readonly ESSrc: typeof EventSource = EventSource,
  ) {}

  // ── openStream ─────────────────────────────────────────────────────────────
  /**
   * Closes any existing stream + timer, then opens a fresh EventSource for
   * `address`. Called on every address change and on reconnect.
   */
  openStream(address: string): void {
    // Cancel any pending reconnect timer from a previous error.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Close the previous EventSource.
    if (this.esRef) {
      this.esRef.close();
      this.esRef = null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es: EventSource = new (this.ESSrc as any)(`/api/tokens/${address}/stream`);
    this.esRef = es;

    // ── onopen ──────────────────────────────────────────────────────────────
    es.onopen = () => {
      // Stale guard: if esRef has already moved on, this is a zombie callback.
      if (this.esRef !== es) return;
      this.callbacks.onConnected();
      this.reconnectAttempts = 0;
      this.callbacks.onLastEvent(Date.now());
    };

    // ── onmessage ───────────────────────────────────────────────────────────
    es.onmessage = (e: MessageEvent) => {
      // Stale guard: ignore messages from superseded streams.
      if (this.esRef !== es) return;
      this.callbacks.onLastEvent(Date.now());
      this.callbacks.onMessage(e.data);
    };

    // ── onerror ─────────────────────────────────────────────────────────────
    es.onerror = () => {
      // Stale guard: a stale EventSource MUST NOT close the current stream,
      // set connected=false, or schedule a reconnect for the wrong address.
      if (this.esRef !== es) return;

      this.callbacks.onDisconnected();
      // Close the dead socket — we manage reconnect ourselves.
      this.esRef.close();
      this.esRef = null;

      // Clear any previous pending timer before scheduling a new one —
      // multiple rapid onerror calls must not stack timers.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Reconnect with backoff — only if tokenAddress hasn't changed.
      const delay = reconnectDelayMs(this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => {
        if (this.tokenAddressRef.current === address) {
          this.openStream(address);
        }
      }, delay);
    };
  }

  // ── setAddress ─────────────────────────────────────────────────────────────
  /**
   * Called whenever the hook's `tokenAddress` prop changes.
   * Updates the shared ref used by onerror closures and opens a new stream.
   * Passing `null` tears everything down.
   */
  setAddress(address: string | null): void {
    this.tokenAddressRef.current = address;
    if (!address) {
      this.teardown();
      return;
    }
    this.reconnectAttempts = 0;
    this.openStream(address);
  }

  // ── watchdogTick ───────────────────────────────────────────────────────────
  /**
   * Called by the host's setInterval watchdog.
   * Forces a reconnect if the stream has been silent for too long — covers
   * proxy drops that never fire onerror.
   */
  watchdogTick(address: string, lastEventMs: number, silenceThresholdMs: number): void {
    if (
      this.tokenAddressRef.current === address &&
      Date.now() - lastEventMs > silenceThresholdMs
    ) {
      this.callbacks.onDisconnected();
      this.openStream(address);
    }
  }

  // ── teardown ───────────────────────────────────────────────────────────────
  /**
   * Full cleanup: cancels timers, closes the EventSource, notifies host.
   * Equivalent to the useEffect cleanup function.
   */
  teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.esRef) {
      this.esRef.close();
      this.esRef = null;
    }
    this.callbacks.onDisconnected();
  }

  /** Exposed for assertions in tests only. */
  get activeStream(): EventSource | null { return this.esRef; }
}
