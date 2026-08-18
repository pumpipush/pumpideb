/**
 * pumpiDatafeed.lifecycle.test.ts
 *
 * Integration tests for PumpiDatafeed that exercise the real datafeed code
 * (not a state-machine replica) against the period-switch lifecycle.
 *
 * Focus: the "loaded period → empty period" regression where stale _bars from
 * the first period were returned to onHistoryLoaded as a positive count, so
 * the "chart unavailable" overlay never appeared on the second period.
 *
 * All tests use vi.stubGlobal to control fetch responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PumpiDatafeed } from '../klc/pumpi-datafeed'

// ── Helpers ────────────────────────────────────────────────────────────────────

const FAKE_SYMBOL = {
  ticker:    'So11111111111111111111111111111111111111111',
  name:      'TestToken',
  shortName: 'TEST/SOL',
  market:    'pumpi',
  pricePrecision:  8,
  volumePrecision: 2,
}

const PERIOD_1M = { multiplier: 1, timespan: 'minute' as const, text: '1m' }
const PERIOD_1H = { multiplier: 1, timespan: 'hour'   as const, text: '1H' }

/** Fake bars that look like the API server's OHLCV response */
const SAMPLE_BARS = [
  { time: 1700000000, open: 1e-8, high: 1.2e-8, low: 0.9e-8, close: 1.1e-8, volume: 1e9 },
  { time: 1700000060, open: 1.1e-8, high: 1.3e-8, low: 1e-8,   close: 1.2e-8, volume: 2e9 },
]

function makeFetch(responseBody: object, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: () => Promise.resolve(responseBody),
  })
}

// Simulate the KLC Pro lifecycle for one period:
//   subscribe → getHistoryKLineData → capture onHistoryLoaded count
async function loadPeriod(
  feed: PumpiDatafeed,
  period: typeof PERIOD_1M | typeof PERIOD_1H,
): Promise<number> {
  let capturedCount = -1
  feed.onHistoryLoaded = (c) => { capturedCount = c }

  const noop = vi.fn()
  feed.subscribe(FAKE_SYMBOL, period, noop)

  await feed.getHistoryKLineData(FAKE_SYMBOL, period, 0, Date.now() / 1000)

  return capturedCount
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PumpiDatafeed – period-switch lifecycle', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reports count=0 when the first-ever history fetch returns an empty bars array', async () => {
    globalThis.fetch = makeFetch({ bars: [] }) as any

    const feed = new PumpiDatafeed()
    const count = await loadPeriod(feed, PERIOD_1M)

    expect(count).toBe(0)
  })

  it('reports count>0 when bars are returned', async () => {
    globalThis.fetch = makeFetch({ bars: SAMPLE_BARS }) as any

    const feed = new PumpiDatafeed()
    const count = await loadPeriod(feed, PERIOD_1M)

    expect(count).toBe(SAMPLE_BARS.length)
  })

  it('reports count=0 after switching from a loaded period to an empty one (the stale-bars regression)', async () => {
    // First fetch: 1m has bars
    // Second fetch: 1H has none
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++
      const bars = callCount === 1 ? SAMPLE_BARS : []
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ bars }),
      })
    }) as any

    const feed = new PumpiDatafeed()

    // Period 1: 1m with bars → should report loaded
    const count1 = await loadPeriod(feed, PERIOD_1M)
    expect(count1).toBe(SAMPLE_BARS.length)

    // Period 2: 1H with no bars — stale 1m bars must NOT bleed through
    const count2 = await loadPeriod(feed, PERIOD_1H)
    expect(count2).toBe(0)           // regression: was SAMPLE_BARS.length before fix
  })

  it('reports count=0 after switching from a loaded period to one with a failed fetch', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          ok: true, status: 200, statusText: 'OK',
          json: () => Promise.resolve({ bars: SAMPLE_BARS }),
        })
      }
      // Second fetch: server error
      return Promise.resolve({
        ok: false, status: 500, statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      })
    }) as any

    const feed = new PumpiDatafeed()

    const count1 = await loadPeriod(feed, PERIOD_1M)
    expect(count1).toBe(SAMPLE_BARS.length)

    // After a failed fetch the old bars must not persist
    const count2 = await loadPeriod(feed, PERIOD_1H)
    expect(count2).toBe(0)           // regression: was SAMPLE_BARS.length before fix
  })

  it('reports the correct count when the same period is retried after being cleared', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK',
        json: () => Promise.resolve({ bars: callCount === 1 ? [] : SAMPLE_BARS }),
      })
    }) as any

    const feed = new PumpiDatafeed()

    const count1 = await loadPeriod(feed, PERIOD_1M)
    expect(count1).toBe(0)

    // Simulate retry: same period, new datafeed instance (retryKey bump)
    // We use a fresh instance to replicate the component's retryKey behavior
    const feed2 = new PumpiDatafeed()
    const count2 = await loadPeriod(feed2, PERIOD_1M)
    expect(count2).toBe(SAMPLE_BARS.length)
  })
})
