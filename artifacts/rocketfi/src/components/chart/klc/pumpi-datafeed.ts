/**
 * pumpi-datafeed.ts
 *
 * Production datafeed for Pumpi — fetches OHLCV from our own API server.
 * subscribe() polls for live candle updates and also accepts external live
 * price pushes via pushLivePrice() for pump.fun SSE ticks.
 */

import type { KLineData } from 'klinecharts'
import type { Datafeed, SymbolInfo, Period, DatafeedSubscribeCallback } from '@klinecharts/pro'

// ── API base URL ──────────────────────────────────────────────────────────────
const API_BASE = (import.meta as any).env.BASE_URL?.replace(/\/$/, '') ?? ''

function apiUrl(path: string) { return `${API_BASE}/api${path}` }

// ── Period → our API timeframe string ────────────────────────────────────────

export function periodToTf(period: Period): string {
  const { multiplier: m, timespan: ts } = period
  if (ts === 'second') return '1m'
  if (ts === 'minute') {
    if (m <= 1)  return '1m'
    if (m <= 5)  return '5m'
    if (m <= 15) return '15m'
    return '15m'
  }
  if (ts === 'hour') {
    if (m <= 1)  return '1H'
    if (m <= 4)  return '4H'
    return '4H'
  }
  if (ts === 'day')   return '1D'
  if (ts === 'week')  return '1W'
  if (ts === 'month') return '1W'
  return '1m'
}

// ── Poll interval per timeframe ───────────────────────────────────────────────

function pollIntervalMs(tf: string): number {
  if (tf === '1m' || tf === '5m')   return 8_000
  if (tf === '15m' || tf === '1H')  return 15_000
  return 30_000
}

// ── OHLCV bar → KLineData ─────────────────────────────────────────────────────

interface OHLCVBar {
  time: number   // unix seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function barToKLine(b: OHLCVBar): KLineData {
  return {
    timestamp: b.time * 1000,         // KLineChart Pro needs milliseconds
    open:      b.open,
    high:      b.high,
    low:       b.low,
    close:     b.close,
    volume:    b.volume / 1e9,        // eth_amount is stored in lamports → convert to SOL
    turnover:  0,
  }
}

// ── PumpiDatafeed ─────────────────────────────────────────────────────────────

export class PumpiDatafeed implements Datafeed {
  /** Called by KLineChartProWrapper to update the OHLC header on every new candle */
  onLiveCandle?: (candle: KLineData) => void
  /** Called after initial history load with the number of bars returned */
  onHistoryLoaded?: (count: number) => void

  private _address: string = ''
  private _tf: string = '1m'
  private _bars: OHLCVBar[] = []
  private _callback: DatafeedSubscribeCallback | null = null
  private _pollId: ReturnType<typeof setInterval> | null = null
  private _historyLoaded = false

  // Track last pushed candle so we only call callback when something changed
  private _lastPushedTs: number = 0
  private _lastPushedClose: number = 0

  // ── symbol search (not used — we always load by address) ──────────────────
  async searchSymbols(): Promise<SymbolInfo[]> { return [] }

  // ── history ───────────────────────────────────────────────────────────────
  async getHistoryKLineData(
    symbol: SymbolInfo,
    period: Period,
    _from: number,
    _to: number,
  ): Promise<KLineData[]> {
    // First call: fetch full history from server
    if (!this._historyLoaded) {
      this._historyLoaded = true
      await this._fetchAndStore(symbol.ticker, periodToTf(period))
    } else {
      // Scrolled past oldest bar — no more data
      return []
    }

    const bars = this._bars
    if (!bars.length) {
      this.onHistoryLoaded?.(0)
      return []
    }

    // Emit latest candle to OHLC header
    const last = bars[bars.length - 1]
    this._emitLive(last)

    const result = bars.map(barToKLine)
    this.onHistoryLoaded?.(result.length)
    return result
  }

  // ── subscribe (live updates via polling) ──────────────────────────────────
  subscribe(symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void {
    this._callback    = callback
    this._address     = symbol.ticker
    this._tf          = periodToTf(period)
    this._historyLoaded = false   // reset for next getHistoryKLineData call
    this._lastPushedTs    = 0
    this._lastPushedClose = 0

    // Stop previous poll if any
    if (this._pollId) { clearInterval(this._pollId); this._pollId = null }

    // Poll at the rate appropriate for this timeframe
    const interval = pollIntervalMs(this._tf)
    this._pollId = setInterval(() => this._poll(), interval)
  }

  // ── unsubscribe ───────────────────────────────────────────────────────────
  unsubscribe(_symbol: SymbolInfo, _period: Period): void {
    this._callback = null
    if (this._pollId) { clearInterval(this._pollId); this._pollId = null }
  }

  // ── push a live price from SSE (called externally when a new trade arrives) ─
  //
  // Call this from the parent component whenever liveToken.priceEth updates.
  // It creates/updates the current-minute candle so the chart stays live without
  // waiting for the next poll cycle.
  pushLivePrice(priceEth: number, solAmount: number): void {
    if (!priceEth || !this._callback || !this._bars.length) return

    const nowSec = Math.floor(Date.now() / 1000)
    const bucketSec = this._bucketSeconds()
    const bucket = Math.floor(nowSec / bucketSec) * bucketSec

    const last = this._bars[this._bars.length - 1]
    let bar: OHLCVBar

    if (last && last.time === bucket) {
      // Update existing current candle
      bar = {
        ...last,
        close:  priceEth,
        high:   Math.max(last.high, priceEth),
        low:    Math.min(last.low,  priceEth),
        volume: last.volume + (solAmount || 0),
      }
      this._bars[this._bars.length - 1] = bar
    } else if (last) {
      // New candle — open at last close
      bar = { time: bucket, open: last.close, high: priceEth, low: priceEth, close: priceEth, volume: solAmount || 0 }
      this._bars.push(bar)
    } else {
      return
    }

    // Only push callback if something actually changed
    if (bar.close !== this._lastPushedClose || bar.time !== this._lastPushedTs) {
      this._lastPushedTs    = bar.time
      this._lastPushedClose = bar.close
      this._callback(barToKLine(bar))
      this._emitLive(bar)
    }
  }

  // ── internal: fetch from API and store ────────────────────────────────────
  private async _fetchAndStore(address: string, tf: string): Promise<void> {
    try {
      const res  = await fetch(apiUrl(`/tokens/${encodeURIComponent(address)}/ohlcv?tf=${tf}`))
      if (!res.ok) {
        console.warn(`[PumpiDatafeed] OHLCV fetch failed: ${res.status} ${res.statusText} (${address} ${tf})`)
        return
      }
      const data = await res.json() as { bars?: OHLCVBar[] }
      if (Array.isArray(data?.bars) && data.bars.length > 0) {
        this._bars = data.bars.sort((a, b) => a.time - b.time)
      }
    } catch {
      // Network error — keep existing bars
    }
  }

  // ── internal: poll for updates ────────────────────────────────────────────
  private async _poll(): Promise<void> {
    if (!this._address || !this._callback) return
    await this._fetchAndStore(this._address, this._tf)

    const bars = this._bars
    if (!bars.length) return

    const last = bars[bars.length - 1]

    // Push if candle time OR close price changed
    if (last.time !== this._lastPushedTs || last.close !== this._lastPushedClose) {
      this._lastPushedTs    = last.time
      this._lastPushedClose = last.close
      this._callback(barToKLine(last))
      this._emitLive(last)
    }
  }

  // ── internal: bucket size in seconds for current tf ───────────────────────
  private _bucketSeconds(): number {
    const map: Record<string, number> = {
      '1m': 60, '5m': 300, '15m': 900, '1H': 3600,
      '4H': 14400, '1D': 86400, '1W': 604800,
    }
    return map[this._tf] ?? 60
  }

  // ── internal: emit to OHLC header ─────────────────────────────────────────
  private _emitLive(bar: OHLCVBar): void {
    this.onLiveCandle?.(barToKLine(bar))
  }
}
