/**
 * KLineChartCanvas.tsx
 *
 * Drop-in replacement for the old ChartCanvas — uses KLineChart Pro
 * (DEXScreener / TradingView Advanced Charts style).
 *
 * Completely self-contained:
 *  • Fetches OHLCV from the API server via PumpiDatafeed
 *  • Accepts live SSE price via livePrice prop for instant candle updates
 *  • Owns all toolbar / bottom-bar / OHLC-header state
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import KLineChartProWrapper, {
  type KLineChartRef,
  type OhlcData,
} from './klc/kline-chart-pro'
import {
  CustomToolbar,
  DEFAULT_PERIOD,
  type Period,
  type PriceMode,
  type CandleType,
} from './klc/custom-toolbar'
import { BottomBar, type YAxisMode, type RangeKey } from './klc/bottom-bar'
import { PumpiDatafeed } from './klc/pumpi-datafeed'

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtSolPrice(v: number): string {
  if (v === 0) return '—'
  if (v >= 1e9)  return `${(v / 1e9).toFixed(3)}B`
  if (v >= 1e6)  return `${(v / 1e6).toFixed(3)}M`
  if (v >= 1e3)  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (v >= 0.01) return v.toFixed(6)
  return v.toExponential(4)
}

function fmtUSD(v: number): string {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(3)}T`
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(3)}B`
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(3)}M`
  if (v >= 1e3)  return `$${(v / 1e3).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

function fmtMcap(priceEth: number, supply: number, solPrice: number | null): string {
  if (!solPrice || !priceEth) return ''
  return fmtUSD(priceEth * supply * solPrice)
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(3)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(3)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`
  return v.toFixed(4)
}

// ── OHLC Overlay (inside chart canvas, TradingView style) ─────────────────────

function OhlcOverlay({
  ticker,
  priceMode,
  period,
  ohlc,
  crosshairOhlc,
  supply,
  solPrice,
}: {
  ticker: string
  priceMode: PriceMode
  period: Period
  ohlc: OhlcData | null
  crosshairOhlc: OhlcData | null
  supply: number
  solPrice: number | null
}) {
  const data = crosshairOhlc ?? ohlc
  const fmt = priceMode === 'mcap'
    ? (v: number) => fmtMcap(v, supply, solPrice)
    : (v: number) => fmtSolPrice(v)

  if (!data) {
    return (
      <div className="klc-ohlc-overlay">
        <div className="klc-ohlc-row1">
          <span className="klc-ohlc-symbol">{ticker}</span>
          <span className="klc-ohlc-period">· {period.text}</span>
        </div>
      </div>
    )
  }

  const isBull = data.close >= data.open
  const changeColor = isBull ? '#26a69a' : '#ef5350'
  const pct = ohlc && ohlc.open > 0
    ? ((data.close - ohlc.open) / ohlc.open * 100).toFixed(2)
    : '0.00'

  return (
    <div className="klc-ohlc-overlay">
      <div className="klc-ohlc-row1">
        <span className="klc-ohlc-symbol">{ticker}</span>
        <span className="klc-ohlc-period">· {period.text}</span>
        <span className="klc-ohlc-values">
          <span style={{ color: '#787b86' }}>O</span>
          <b style={{ color: '#d1d4dc', fontWeight: 500 }}>{fmt(data.open)}</b>
          <span style={{ color: '#787b86', marginLeft: 4 }}>H</span>
          <b style={{ color: '#26a69a', fontWeight: 500 }}>{fmt(data.high)}</b>
          <span style={{ color: '#787b86', marginLeft: 4 }}>L</span>
          <b style={{ color: '#ef5350', fontWeight: 500 }}>{fmt(data.low)}</b>
          <span style={{ color: '#787b86', marginLeft: 4 }}>C</span>
          <b style={{ color: changeColor, fontWeight: 500 }}>{fmt(data.close)}</b>
          <b style={{ color: changeColor, marginLeft: 4, fontWeight: 500 }}>
            {isBull ? '▲' : '▼'} {pct}%
          </b>
        </span>
        <span className="klc-ohlc-vol">
          Vol <b style={{ color: '#787b86', fontWeight: 500 }}>{fmtVol(data.volume)}</b>
        </span>
      </div>
    </div>
  )
}

// ── Empty / Loading states ────────────────────────────────────────────────────

function ChartSkeleton({ loading }: { loading: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 12,
        background: '#080808',
      }}
    >
      {loading ? (
        <svg
          width="36"
          height="36"
          viewBox="0 0 36 36"
          style={{ animation: 'chartSpinnerRotate 0.9s linear infinite' }}
        >
          <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
          <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(41,98,255,0.75)" strokeWidth="3"
            strokeLinecap="round" strokeDasharray="30 65" />
        </svg>
      ) : (
        <>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
            stroke="#3f3f46" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <p style={{ fontSize: 14, color: '#52525b', margin: 0 }}>No trades yet — be the first</p>
          <p style={{ fontSize: 12, color: '#3f3f46', margin: 0 }}>Chart updates in real time as trades arrive</p>
        </>
      )}
    </div>
  )
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  /** Token mint address */
  address: string
  /** Token symbol (e.g. "PUMP") */
  symbol: string
  /** Token full name */
  name: string
  /** Platform slug — used to decide pricePrecision */
  platform?: string
  /** Live SOL/USD price for MCap calculations */
  solPrice: number | null
  /** Circulating supply (default 1 billion = 1e9) */
  supply?: number
  /** Live price from SSE — triggers instant candle update without waiting for poll */
  livePrice?: number | null
  /** Volume in SOL for the latest SSE trade — used to update candle volume */
  liveSolAmount?: number
}

// ── Component ─────────────────────────────────────────────────────────────────

export function KLineChartCanvas({
  address,
  symbol,
  name,
  platform,
  solPrice,
  supply = 1_000_000_000,
  livePrice,
  liveSolAmount = 0,
}: Props) {
  const chartRef = useRef<KLineChartRef>(null)

  // ── Toolbar state ─────────────────────────────────────────────────────────
  const [period,          setPeriod]         = useState<Period>(DEFAULT_PERIOD)
  const [priceMode,       setPriceMode]      = useState<PriceMode>('price')
  const [candleType,      setCandleType]     = useState<CandleType>('candle_solid')
  const [yAxisMode,       setYAxisMode]      = useState<YAxisMode>('normal')
  const [autoScale,       setAutoScale]      = useState(true)
  const [activeRange,     setActiveRange]    = useState<RangeKey | null>(null)
  const [drawingBarVisible, setDrawingBarVisible] = useState(false)

  // ── OHLC header data ──────────────────────────────────────────────────────
  const [ohlc,          setOhlc]          = useState<OhlcData | null>(null)
  const [crosshairOhlc, setCrosshairOhlc] = useState<OhlcData | null>(null)

  // ── Datafeed — recreated when address changes ──────────────────────────────
  const datafeed = useMemo(() => new PumpiDatafeed(), [address])

  // ── Symbol descriptor for the chart ───────────────────────────────────────
  const symbolInfo = useMemo(() => ({
    ticker:          address,
    name:            name || symbol,
    shortName:       `${symbol}/SOL`,
    market:          platform ?? 'pumpi',
    pricePrecision:  8,
    volumePrecision: 2,
  }), [address, name, symbol, platform])

  // ── Push live SSE price into the datafeed for instant candle updates ───────
  const prevLivePrice = useRef<number | null>(null)
  useEffect(() => {
    if (livePrice && livePrice > 0 && livePrice !== prevLivePrice.current) {
      prevLivePrice.current = livePrice
      datafeed.pushLivePrice(livePrice, liveSolAmount)
    }
  }, [livePrice, liveSolAmount, datafeed])

  // ── Toolbar handlers ──────────────────────────────────────────────────────
  const handlePriceModeChange = useCallback((mode: PriceMode) => {
    setPriceMode(mode)
    if (mode === 'mcap') {
      chartRef.current?.setYAxisFormatter(
        (price) => fmtMcap(price, supply, solPrice),
      )
    } else {
      chartRef.current?.setYAxisFormatter(null)
    }
  }, [supply, solPrice])

  const handleCandleTypeChange = useCallback((type: CandleType) => {
    setCandleType(type)
    chartRef.current?.setCandleType(type)
  }, [])

  const handleYAxisModeChange = useCallback((mode: YAxisMode) => {
    setYAxisMode(mode)
    chartRef.current?.setYAxisMode(mode)
  }, [])

  const handleDrawingBarToggle = useCallback(() => {
    const wasHidden = chartRef.current?.toggleDrawingBar()
    // toggleDrawingBar returns true when the bar WAS hidden (now visible)
    if (wasHidden !== undefined) setDrawingBarVisible(wasHidden)
  }, [])

  // ── Fullscreen support ────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const handleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      el.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }, [])

  // ── No address guard ──────────────────────────────────────────────────────
  if (!address) {
    return (
      <div
        style={{
          height: 520,
          background: '#131722',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ChartSkeleton loading={true} />
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: '#080808',
        // Responsive height: chart area + toolbars
        height: 'clamp(460px, 55vh, 620px)',
        minHeight: 460,
      }}
    >
      {/* ── Custom toolbar (top) ── */}
      <CustomToolbar
        period={period}
        onPeriodChange={setPeriod}
        priceMode={priceMode}
        onPriceModeChange={handlePriceModeChange}
        candleType={candleType}
        onCandleTypeChange={handleCandleTypeChange}
        onIndicatorClick={() => chartRef.current?.clickIndicator()}
        onSettingsClick={() => chartRef.current?.clickSettings()}
        onScreenshotClick={() => chartRef.current?.clickScreenshot()}
        onFullscreenClick={handleFullscreen}
      />

      {/* ── KLineChart Pro — fills remaining space ── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#080808' }}>

        {/* OHLC overlay — positioned inside chart canvas, top-left (TV style) */}
        <OhlcOverlay
          ticker={`${symbol}/SOL`}
          priceMode={priceMode}
          period={period}
          ohlc={ohlc}
          crosshairOhlc={crosshairOhlc}
          supply={supply}
          solPrice={solPrice}
        />

        <KLineChartProWrapper
          key={address}           // remount on token switch
          ref={chartRef}
          datafeed={datafeed}
          period={period}
          symbol={symbolInfo}
          timezone="Asia/Bangkok"
          onOhlcChange={setOhlc}
          onCrosshairOhlcChange={setCrosshairOhlc}
        />

        {/* Drawing bar chevron — TradingView-style left-edge toggle */}
        <button
          className="drawing-chevron"
          style={{ left: drawingBarVisible ? 45 : 0 }}
          onClick={handleDrawingBarToggle}
          title={drawingBarVisible ? 'Hide drawing tools' : 'Show drawing tools'}
        >
          {drawingBarVisible ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M6.5 2L3.5 5L6.5 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </div>

      {/* ── Bottom bar ── */}
      <BottomBar
        yAxisMode={yAxisMode}
        onYAxisModeChange={handleYAxisModeChange}
        autoScale={autoScale}
        onAutoScaleChange={setAutoScale}
        activeRange={activeRange}
        onRangeChange={setActiveRange}
      />
    </div>
  )
}
