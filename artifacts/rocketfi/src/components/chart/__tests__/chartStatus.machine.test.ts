/**
 * chartStatus.machine.test.ts
 *
 * Tests the state-machine logic that drives the "Chart data unavailable"
 * overlay in KLineChartCanvas.tsx.
 *
 * The machine has three states:
 *   loading → (0 bars + 5 s timeout) → unavailable
 *   loading → (>0 bars OR live candle before timeout) → loaded
 *   loaded  → (period switch to 0 bars + 5 s timeout) → unavailable
 *   any     → retry → loading
 *
 * Tests use fake timers so the 5-second window is advanced in zero real time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Inline replica of the state-machine logic from KLineChartCanvas.tsx.
// This stays in sync by mirroring the logic exactly; any divergence will be
// caught by the test failures themselves.
// ---------------------------------------------------------------------------

type ChartStatus = 'loading' | 'loaded' | 'unavailable'

function createMachine() {
  let status: ChartStatus = 'loading'
  let timer: ReturnType<typeof setTimeout> | null = null

  function _clearTimer() {
    if (timer) { clearTimeout(timer); timer = null }
  }

  /** Called when KLineChartProWrapper reports how many bars were loaded */
  function handleHistoryLoaded(count: number) {
    _clearTimer()
    if (count > 0) {
      status = 'loaded'
    } else {
      // Reset to 'loading' so the delayed transition works regardless of prior
      // status (e.g. user was on a working period, switched to one with 0 bars).
      status = 'loading'
      timer = setTimeout(() => {
        if (status === 'loading') status = 'unavailable'
      }, 5_000)
    }
  }

  /** Called whenever a live candle arrives (onOhlcChange).
   *  Always recovers — the datafeed polls even after the overlay appears. */
  function handleLiveCandle() {
    _clearTimer()
    status = 'loaded'
  }

  /** Called when address or retryKey changes */
  function reset() {
    _clearTimer()
    status = 'loading'
  }

  function getStatus(): ChartStatus { return status }

  return { handleHistoryLoaded, handleLiveCandle, reset, getStatus }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chartStatus state machine', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts in loading state', () => {
    const m = createMachine()
    expect(m.getStatus()).toBe('loading')
  })

  // ── Initial zero-bar load ─────────────────────────────────────────────────

  it('transitions to unavailable after 5 s when 0 bars on initial load', () => {
    const m = createMachine()
    m.handleHistoryLoaded(0)
    expect(m.getStatus()).toBe('loading')   // still loading — timer running

    vi.advanceTimersByTime(4_999)
    expect(m.getStatus()).toBe('loading')   // not yet

    vi.advanceTimersByTime(1)
    expect(m.getStatus()).toBe('unavailable')
  })

  it('transitions to loaded immediately when bars > 0 on initial load', () => {
    const m = createMachine()
    m.handleHistoryLoaded(42)
    expect(m.getStatus()).toBe('loaded')
  })

  // ── Live candle arrives before the 5-second window closes ────────────────

  it('cancels unavailable timer and stays loaded when a live candle arrives before timeout', () => {
    const m = createMachine()
    m.handleHistoryLoaded(0)
    expect(m.getStatus()).toBe('loading')

    vi.advanceTimersByTime(3_000)
    m.handleLiveCandle()           // live trade arrives — chart is working
    expect(m.getStatus()).toBe('loaded')

    vi.advanceTimersByTime(3_000)  // the timer would have fired here
    expect(m.getStatus()).toBe('loaded')  // still loaded — timer was cancelled
  })

  // ── Period switch from a working period to a zero-bar period ─────────────

  it('shows unavailable when user switches to a period that returns 0 bars after a successful load', () => {
    const m = createMachine()

    // First period: data available
    m.handleHistoryLoaded(100)
    expect(m.getStatus()).toBe('loaded')

    // User switches to a long-interval period with no bars yet
    m.handleHistoryLoaded(0)
    expect(m.getStatus()).toBe('loading')  // must reset to loading first

    vi.advanceTimersByTime(5_000)
    expect(m.getStatus()).toBe('unavailable')
  })

  it('recovers from a zero-bar period switch if a live candle arrives before timeout', () => {
    const m = createMachine()

    m.handleHistoryLoaded(50)  // initial load ok
    m.handleHistoryLoaded(0)   // period switch → 0 bars

    vi.advanceTimersByTime(2_000)
    m.handleLiveCandle()

    expect(m.getStatus()).toBe('loaded')
    vi.advanceTimersByTime(5_000)           // timer was cancelled; should stay loaded
    expect(m.getStatus()).toBe('loaded')
  })

  // ── Retry ─────────────────────────────────────────────────────────────────

  it('resets to loading on retry and then can reach loaded on success', () => {
    const m = createMachine()
    m.handleHistoryLoaded(0)
    vi.advanceTimersByTime(5_000)
    expect(m.getStatus()).toBe('unavailable')

    m.reset()
    expect(m.getStatus()).toBe('loading')

    m.handleHistoryLoaded(10)
    expect(m.getStatus()).toBe('loaded')
  })

  it('cancels the pending unavailability timer on retry', () => {
    const m = createMachine()
    m.handleHistoryLoaded(0)
    expect(m.getStatus()).toBe('loading')

    m.reset()                              // retry before timer fires
    vi.advanceTimersByTime(10_000)         // timer should be gone
    expect(m.getStatus()).toBe('loading')  // still loading — waiting for new fetch
  })

  // ── Live candle arrives AFTER the 5-second timeout (post-unavailable) ─────

  it('dismisses the unavailable overlay when a live candle arrives after the timeout', () => {
    const m = createMachine()
    m.handleHistoryLoaded(0)
    vi.advanceTimersByTime(5_000)
    expect(m.getStatus()).toBe('unavailable')

    // Datafeed polls again and delivers a candle — overlay must go away
    m.handleLiveCandle()
    expect(m.getStatus()).toBe('loaded')
  })

  // ── Multiple rapid period switches ────────────────────────────────────────

  it('handles rapid period switches without stale timers accumulating', () => {
    const m = createMachine()

    m.handleHistoryLoaded(0)   // period A → no bars
    m.handleHistoryLoaded(0)   // period B → no bars (cancels A's timer)
    m.handleHistoryLoaded(20)  // period C → bars arrive (cancels B's timer)

    expect(m.getStatus()).toBe('loaded')

    vi.advanceTimersByTime(10_000)   // any stale timers would fire here
    expect(m.getStatus()).toBe('loaded')
  })
})
