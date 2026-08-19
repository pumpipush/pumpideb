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
import {
  ChartSettingsModal,
  DEFAULT_CHART_SETTINGS,
  type ChartSettings,
} from './klc/chart-settings-modal'

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
  leftOffset = 10,
}: {
  ticker: string
  priceMode: PriceMode
  period: Period
  ohlc: OhlcData | null
  crosshairOhlc: OhlcData | null
  supply: number
  solPrice: number | null
  leftOffset?: number
}) {
  const [volVisible, setVolVisible] = useState(true)
  const data = crosshairOhlc ?? ohlc
  const fmt = priceMode === 'mcap'
    ? (v: number) => fmtMcap(v, supply, solPrice)
    : (v: number) => fmtSolPrice(v)

  const overlayStyle: React.CSSProperties = {
    left: leftOffset,
    transition: 'left 0.2s ease',
  }

  const isBull = data ? data.close >= data.open : true
  const changeColor = isBull ? '#26a69a' : '#ef5350'
  const pct = data && ohlc && ohlc.open > 0
    ? ((data.close - ohlc.open) / ohlc.open * 100).toFixed(2)
    : null

  return (
    <div className="klc-ohlc-overlay" style={overlayStyle}>
      {/* Row 1: ticker · period · O H L C % */}
      <div className="klc-ohlc-row1">
        <span className="klc-ohlc-symbol">{ticker}</span>
        <span className="klc-ohlc-period">· {period.text}</span>
        <span className="klc-ohlc-brand">· Pumpi.io</span>
        {data && (
          <span className="klc-ohlc-values">
            <span className="klc-ohlc-lbl">O</span>
            <b className="klc-ohlc-val">{fmt(data.open)}</b>
            <span className="klc-ohlc-lbl">H</span>
            <b className="klc-ohlc-val" style={{ color: '#26a69a' }}>{fmt(data.high)}</b>
            <span className="klc-ohlc-lbl">L</span>
            <b className="klc-ohlc-val" style={{ color: '#ef5350' }}>{fmt(data.low)}</b>
            <span className="klc-ohlc-lbl">C</span>
            <b className="klc-ohlc-val" style={{ color: changeColor }}>{fmt(data.close)}</b>
            {pct !== null && (
              <b className="klc-ohlc-change" style={{ color: changeColor }}>
                {isBull ? '▲' : '▼'} {pct}%
              </b>
            )}
          </span>
        )}
      </div>

      {/* Row 2: Volume — always rendered, hides via chevron */}
      {volVisible && (
        <div className="klc-ohlc-row2">
          <span className="klc-ohlc-vol-label">Volume</span>
          <span className="klc-ohlc-vol-value">
            {data && solPrice ? fmtUSD(data.volume * solPrice) : '—'}
          </span>
        </div>
      )}

      {/* Row 3: Chevron card — always visible, toggles row 2 */}
      <button
        className={`klc-ohlc-chevron-card${volVisible ? ' open' : ''}`}
        onClick={() => setVolVisible(v => !v)}
        title={volVisible ? 'Hide volume' : 'Show volume'}
      >
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
          {volVisible
            ? <path d="M1.5 5.5L4.5 2.5L7.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            : <path d="M1.5 3.5L4.5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          }
        </svg>
      </button>
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

// ── Chart unavailable overlay ─────────────────────────────────────────────────

function ChartUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#080808',
        zIndex: 10,
        gap: 14,
      }}
    >
      {/* Bar-chart icon with a cross to indicate unavailability */}
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none"
        stroke="#3f3f46" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4"  />
        <line x1="6"  y1="20" x2="6"  y2="14" />
        <line x1="2"  y1="2"  x2="22" y2="22" stroke="#ef5350" strokeWidth="1.6" />
      </svg>
      <p style={{ fontSize: 14, color: '#71717a', margin: 0, textAlign: 'center', lineHeight: 1.5 }}>
        Chart data unavailable
      </p>
      <p style={{ fontSize: 12, color: '#52525b', margin: 0, textAlign: 'center', lineHeight: 1.5 }}>
        No OHLCV data found for this token yet
      </p>
      <button
        onClick={onRetry}
        style={{
          marginTop: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 6,
          color: '#a1a1aa',
          fontSize: 12,
          cursor: 'pointer',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.09)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
      >
        {/* Refresh icon */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        Try again
      </button>
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
  const [priceMode,       setPriceMode]      = useState<PriceMode>('mcap')
  const [candleType,      setCandleType]     = useState<CandleType>('candle_solid')
  const [yAxisMode,       setYAxisMode]      = useState<YAxisMode>('normal')
  const [autoScale,       setAutoScale]      = useState(true)
  const [activeRange,     setActiveRange]    = useState<RangeKey | null>(null)
  const [drawingBarVisible, setDrawingBarVisible] = useState(false)
  const [showSettings,     setShowSettings]      = useState(false)
  const [chartSettings,    setChartSettings]     = useState<ChartSettings>(DEFAULT_CHART_SETTINGS)

  // ── OHLC header data ──────────────────────────────────────────────────────
  const [ohlc,          setOhlc]          = useState<OhlcData | null>(null)
  const [crosshairOhlc, setCrosshairOhlc] = useState<OhlcData | null>(null)

  // ── Chart status — tracks whether OHLCV data arrived ─────────────────────
  const [chartStatus, setChartStatus] = useState<'loading' | 'loaded' | 'unavailable'>('loading')
  const [retryKey,    setRetryKey]    = useState(0)
  const emptyTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Last-price label (colored Y-axis tag) — direct DOM, no React state ──────
  const lastPriceLabelRef = useRef<HTMLDivElement>(null)
  const ohlcRef           = useRef<OhlcData | null>(null)
  const axisUnsubRef      = useRef<(() => void) | null>(null)

  // ── Datafeed — recreated when address or retryKey changes ────────────────
  const datafeed = useMemo(() => new PumpiDatafeed(), [address, retryKey])

  // ── Symbol descriptor for the chart ───────────────────────────────────────
  const symbolInfo = useMemo(() => ({
    ticker:          address,
    name:            name || symbol,
    shortName:       `${symbol}/${priceMode === 'mcap' ? 'USD' : 'SOL'}`,
    market:          platform ?? 'pumpi',
    pricePrecision:  8,
    volumePrecision: 2,
  }), [address, name, symbol, platform, priceMode])

  // ── Stable refs so Y-axis formatter always reads latest values ──────────────
  // (avoids stale closures when solPrice or supply update after formatter set)
  const solPriceRef = useRef<number | null>(solPrice)
  const supplyRef   = useRef<number>(supply)
  solPriceRef.current = solPrice
  supplyRef.current   = supply

  // ── Sync last-price label to Y position of current close — direct DOM ───────
  // Called on every live candle, axis scroll/zoom, and mode switch.
  // Uses direct DOM manipulation to avoid triggering React re-renders at 60fps.
  const syncLastPriceLabel = useCallback(() => {
    const el  = lastPriceLabelRef.current
    if (!el) return
    const data = ohlcRef.current
    const fmt  = chartRef.current?.getMcapFmt?.()
    if (!data || !fmt) { el.style.display = 'none'; return }
    const y = chartRef.current?.getCloseYPixel?.(data.close)
    if (y == null || !isFinite(y)) { el.style.display = 'none'; return }
    // Clamp to chart pane bounds so the label stays visible even when the
    // current price has drifted outside the visible Y range (like pump.fun).
    const paneH = el.parentElement?.clientHeight ?? 0
    const clampedY = paneH > 0 ? Math.max(9, Math.min(paneH - 9, Math.round(y))) : Math.round(y)
    const color = data.close > data.open ? '#26a69a' : data.close < data.open ? '#ef5350' : '#888888'
    el.style.display         = 'flex'
    el.style.top             = `${clampedY}px`
    el.style.backgroundColor = color
    el.textContent           = fmt(data.close)
  }, [])

  // ── Apply / remove Y-axis formatter on mount and on mode switch ───────────
  // Runs after child effects (chart init), so chartRef is ready on first run.
  useEffect(() => {
    if (priceMode === 'mcap') {
      chartRef.current?.setYAxisFormatter(
        (price: number) => fmtMcap(price, supplyRef.current, solPriceRef.current),
      )
    } else {
      chartRef.current?.setYAxisFormatter(null)
    }
    // Re-sync label after formatter change (show/hide depending on mode).
    setTimeout(syncLastPriceLabel, 50)
  // address dep: KLineChartProWrapper remounts on token switch (key={address}),
  // resetting its internal yAxisFormatterRef — re-registering here ensures the
  // new wrapper instance gets the formatter on its first onHistoryLoaded call.
  }, [priceMode, address, syncLastPriceLabel])

  // ── Reset chart status when address or retry changes ─────────────────────
  useEffect(() => {
    setChartStatus('loading')
    setOhlc(null)
    ohlcRef.current = null
    setCrosshairOhlc(null)
    if (emptyTimerRef.current) {
      clearTimeout(emptyTimerRef.current)
      emptyTimerRef.current = null
    }
    // Unsubscribe old axis listener so the new chart instance gets a fresh one.
    axisUnsubRef.current?.()
    axisUnsubRef.current = null
    if (lastPriceLabelRef.current) lastPriceLabelRef.current.style.display = 'none'
  }, [address, retryKey])

  // Cleanup timer + axis subscription on unmount
  useEffect(() => {
    return () => {
      if (emptyTimerRef.current) {
        clearTimeout(emptyTimerRef.current)
        emptyTimerRef.current = null
      }
      axisUnsubRef.current?.()
      axisUnsubRef.current = null
    }
  }, [])

  // ── Called by KLineChartProWrapper after history fetch resolves ──────────
  const handleHistoryLoaded = useCallback((count: number) => {
    // Always clear any pending timer first — handles both initial load and
    // mid-session period switches where the previous period had data.
    if (emptyTimerRef.current) {
      clearTimeout(emptyTimerRef.current)
      emptyTimerRef.current = null
    }
    if (count > 0) {
      setChartStatus('loaded')
    } else {
      // Reset to 'loading' so the delayed transition works regardless of prior
      // status (e.g. user was on a working period, switched to one with 0 bars).
      setChartStatus('loading')
      emptyTimerRef.current = setTimeout(() => {
        setChartStatus(prev => prev === 'loading' ? 'unavailable' : prev)
      }, 5_000)
    }
    // Subscribe to scroll/zoom once so the label stays pinned after history loads.
    if (!axisUnsubRef.current) {
      axisUnsubRef.current = chartRef.current?.subscribeAxisChange?.(syncLastPriceLabel) ?? null
    }
    syncLastPriceLabel()
  }, [syncLastPriceLabel])

  // ── OHLC update — always recovers from any non-loaded state ─────────────
  // The datafeed polls even after the 'unavailable' overlay appears, so a
  // candle arriving *after* the 5-second timeout (e.g. Birdeye came back up)
  // must also dismiss the overlay.  We unconditionally set 'loaded' here and
  // clear any pending timer so both pre-timeout and post-timeout paths work.
  const handleOhlcChange = useCallback((data: OhlcData) => {
    ohlcRef.current = data
    setOhlc(data)
    if (emptyTimerRef.current) {
      clearTimeout(emptyTimerRef.current)
      emptyTimerRef.current = null
    }
    setChartStatus('loaded')
    syncLastPriceLabel()
  }, [syncLastPriceLabel])

  // ── Retry — bumps retryKey which recreates the datafeed + remounts chart ──
  const handleRetry = useCallback(() => {
    setRetryKey(k => k + 1)
  }, [])

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
    // priceMode state change triggers the useEffect above which applies formatter
  }, [])

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
    if (wasHidden !== undefined) setDrawingBarVisible(wasHidden)
  }, [])

  // Apply chart settings → KLC styles whenever settings change
  const handleSettingsChange = useCallback((s: ChartSettings) => {
    setChartSettings(s)
    chartRef.current?.setStyles?.({
      grid: {
        horizontal: { show: s.gridShow },
        vertical:   { show: s.gridShow },
      },
      candle: {
        priceMark: {
          high: { show: s.highPriceShow },
          low:  { show: s.lowPriceShow  },
          last: { show: s.lastPriceShow  },
        },
      },
      yAxis: {
        type:    s.priceAxisType,
        reverse: s.reverseCoordinate,
      },
    } as any)
  }, [])

  const handleRestoreDefaults = useCallback(() => {
    handleSettingsChange(DEFAULT_CHART_SETTINGS)
  }, [handleSettingsChange])

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
        onSettingsClick={() => setShowSettings(true)}
        onScreenshotClick={() => chartRef.current?.clickScreenshot()}
        onFullscreenClick={handleFullscreen}
      />

      {/* ── KLineChart Pro — fills remaining space ── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#080808' }}>

        {/* OHLC overlay — slides right when drawing bar is open */}
        <OhlcOverlay
          ticker={`${symbol}/${priceMode === 'mcap' ? 'USD' : 'SOL'}`}
          priceMode={priceMode}
          period={period}
          ohlc={ohlc}
          crosshairOhlc={crosshairOhlc}
          supply={supply}
          solPrice={solPrice}
          leftOffset={drawingBarVisible ? 55 : 10}
        />

        {/* Loading spinner overlay — shown while waiting for first bar after mount / period switch */}
        {chartStatus === 'loading' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#080808',
              zIndex: 10,
            }}
          >
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
          </div>
        )}

        {/* Chart unavailable overlay — shown when 0 bars and no live tick for 5s */}
        {chartStatus === 'unavailable' && (
          <ChartUnavailable onRetry={handleRetry} />
        )}

        {/* Colored last-price label — mcap value pinned to current price on Y-axis right edge.
            Mirrors pump.fun's green/red tag. Updated via direct DOM manipulation (no re-render). */}
        <div
          ref={lastPriceLabelRef}
          style={{
            position: 'absolute',
            right: 0,
            display: 'none',
            alignItems: 'center',
            transform: 'translateY(-50%)',
            color: '#ffffff',
            fontSize: 11,
            fontFamily: "'Trebuchet MS', sans-serif",
            padding: '2px 5px',
            borderRadius: '2px 0 0 2px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 12,
            lineHeight: '16px',
            minWidth: 44,
            letterSpacing: '0.01em',
          }}
        />

        <KLineChartProWrapper
          key={`${address}-${retryKey}`} // remount on token switch or retry
          ref={chartRef}
          datafeed={datafeed}
          period={period}
          symbol={symbolInfo}
          timezone="Asia/Bangkok"
          onOhlcChange={handleOhlcChange}
          onCrosshairOhlcChange={setCrosshairOhlc}
          onHistoryLoaded={handleHistoryLoaded}
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

      {/* ── Custom settings modal ── */}
      <ChartSettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        settings={chartSettings}
        onChange={handleSettingsChange}
        onRestoreDefaults={handleRestoreDefaults}
      />
    </div>
  )
}
