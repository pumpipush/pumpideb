/**
 * kline-chart-pro.tsx
 *
 * Chart wrapper utama — DEXScreener / pump.fun style.
 * Menerima `datafeed` sebagai prop: pasang PumpiDatafeed dari pumpi-datafeed.ts
 * atau implementasi sendiri yang mengikuti @klinecharts/pro Datafeed interface.
 */

import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { KLineChartPro } from '@klinecharts/pro'
import { init as klcInit, registerYAxis } from 'klinecharts'
import type { Datafeed } from '@klinecharts/pro'
import '@klinecharts/pro/dist/klinecharts-pro.css'
import './tradingview-theme.css'
import type { Period } from './custom-toolbar'

// ── MCap Y-axis registration (module-level, runs once) ───────────────────────

let _activeMcapFmt: ((rawPrice: number) => string) | null = null

registerYAxis({
  name: 'mcap',
  createTicks: ({ defaultTicks }) => {
    const fmt = _activeMcapFmt
    if (!fmt) return defaultTicks
    return defaultTicks.map(tick => ({ ...tick, text: fmt(Number(tick.value)) }))
  },
})

// ── KLineChart instance retrieval ─────────────────────────────────────────────

function getKlcChart(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>('[k-line-chart-id]')
  if (!el) return null
  const chartId = el.getAttribute('k-line-chart-id')
  if (!chartId) return null
  const prevId = el.id
  el.id = chartId
  const chart = klcInit(el)
  el.id = prevId
  return chart
}

// ── TV-style dark theme ───────────────────────────────────────────────────────

const TV_STYLES = {
  // ── Chart canvas background ───────────────────────────────────────────────
  // KLineChart does not expose a direct `background` style key; the canvas bg
  // is inherited from the container div which is set to #131722 in CSS.

  // ── Grid ─────────────────────────────────────────────────────────────────
  grid: {
    horizontal: { color: 'rgba(42,46,57,0.5)', size: 1, style: 0, show: true },
    vertical:   { color: 'rgba(42,46,57,0.5)', size: 1, style: 0, show: true },
  },

  // ── Candlesticks ─────────────────────────────────────────────────────────
  candle: {
    type: 'candle_solid',
    bar: {
      // TV green: #26a69a   TV red: #ef5350
      upColor:   '#26a69a', downColor:   '#ef5350', noChangeColor: '#888888',
      upBorderColor: '#26a69a', downBorderColor: '#ef5350',
      upWickColor:   '#26a69a', downWickColor:   '#ef5350',
    },
    priceMark: {
      show: true,
      high: { show: false },
      low:  { show: false },
      last: {
        show: true,
        upColor: '#26a69a', downColor: '#ef5350', noChangeColor: '#888888',
        line: { show: true, style: 1, dashValue: [4, 4], size: 1 },
        text: {
          show: true, size: 11,
          family: "'Trebuchet MS', sans-serif",
          paddingLeft: 4, paddingTop: 2, paddingRight: 4, paddingBottom: 2,
          borderRadius: 2, color: '#ffffff',
        },
      },
    },
    tooltip: { showRule: 'none' },
  },

  // ── Indicators ───────────────────────────────────────────────────────────
  indicator: {
    ohlc: {
      upColor: 'rgba(38,166,154,0.70)',
      downColor: 'rgba(239,83,80,0.70)',
      noChangeColor: '#888888',
    },
    bars: [{
      border: false,
      upColor: 'rgba(38,166,154,0.50)',
      downColor: 'rgba(239,83,80,0.50)',
      noChangeColor: 'rgba(136,136,136,0.50)',
    }],
    lines: [
      { size: 1, style: 0, smooth: false, color: '#2962ff' },
      { size: 1, style: 0, smooth: false, color: '#f5a623' },
      { size: 1, style: 0, smooth: false, color: '#9c27b0' },
      { size: 1, style: 0, smooth: false, color: '#00bcd4' },
      { size: 1, style: 0, smooth: false, color: '#e91e63' },
    ],
    tooltip: {
      offsetTop: 6,
      text: {
        size: 11,
        family: "'Trebuchet MS', sans-serif",
        color: '#b2b5be',
        marginLeft: 8, marginTop: 6, marginRight: 8, marginBottom: 0,
      },
      rect: {
        position: 'fixed',
        paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 4,
        borderRadius: 0, borderSize: 0,
        borderColor: 'transparent', color: 'transparent',
        offsetLeft: 10, offsetTop: 56, offsetRight: 10,
      },
    },
  },

  // ── X axis (time) ────────────────────────────────────────────────────────
  xAxis: {
    show: true, size: 'auto',
    axisLine: { show: true, color: '#2a2e39', size: 1 },
    tickText: {
      show: true, color: '#5d606b', size: 11,
      family: "'Trebuchet MS', sans-serif",
    },
    tickLine: { show: false, size: 1, length: 3, color: '#2a2e39' },
  },

  // ── Y axis (price) ───────────────────────────────────────────────────────
  yAxis: {
    show: true, size: 'auto', position: 'right',
    axisLine: { show: false },
    tickText: {
      show: true, color: '#787b86', size: 11,
      family: "'Trebuchet MS', sans-serif",
    },
    tickLine: { show: false },
  },

  // ── Pane separator ───────────────────────────────────────────────────────
  separator: {
    size: 2,
    color: '#2a2e39',
    fill: true,
    activeBackgroundColor: 'rgba(41,98,255,0.10)',
  },

  // ── Crosshair ────────────────────────────────────────────────────────────
  crosshair: {
    show: true,
    horizontal: {
      show: true,
      line: { show: true, style: 1, dashValue: [4, 4], size: 1, color: 'rgba(149,152,161,0.6)' },
      text: {
        show: true, size: 11,
        family: "'Trebuchet MS', sans-serif",
        color: '#ffffff',
        paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3,
        borderRadius: 2, borderSize: 0,
        borderColor: 'transparent',
        backgroundColor: '#364156',
      },
    },
    vertical: {
      show: true,
      line: { show: true, style: 1, dashValue: [4, 4], size: 1, color: 'rgba(149,152,161,0.6)' },
      text: {
        show: true, size: 11,
        family: "'Trebuchet MS', sans-serif",
        color: '#ffffff',
        paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3,
        borderRadius: 2, borderSize: 0,
        borderColor: 'transparent',
        backgroundColor: '#364156',
      },
    },
  },

  // ── Drawing overlays ─────────────────────────────────────────────────────
  overlay: {
    point: {
      color: '#2962ff',
      borderColor: 'rgba(41,98,255,0.30)',
      borderSize: 1, radius: 4,
      activeColor: '#2962ff', activeRadius: 5,
      activeBorderSize: 2, activeBorderColor: 'rgba(41,98,255,0.50)',
    },
    line:    { style: 0, smooth: false, color: '#2962ff', size: 1, dashValue: [4, 4] },
    rect:    { color: 'rgba(41,98,255,0.08)', borderColor: '#2962ff', borderSize: 1, borderRadius: 0 },
    arc:     { style: 0, color: '#2962ff', size: 1 },
    polygon: { style: 0, color: 'rgba(41,98,255,0.08)', borderColor: '#2962ff', borderSize: 1 },
    text:    {
      style: 0, color: '#b2b5be', size: 12, borderRadius: 2, borderSize: 0,
      borderColor: 'transparent', paddingLeft: 0, paddingRight: 0,
      paddingTop: 0, paddingBottom: 0, backgroundColor: 'transparent',
    },
  },
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OhlcData {
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface KLineChartRef {
  clickIndicator:    () => void
  clickSettings:     () => void
  clickScreenshot:   () => void
  clickFullscreen:   () => void
  toggleDrawingBar:  () => boolean
  setYAxisMode:      (mode: 'normal' | 'percentage' | 'log') => void
  setCandleType:     (type: string) => void
  setYAxisFormatter: (fmt: ((val: number) => string) | null) => void
}

interface Props {
  datafeed: Datafeed & { onLiveCandle?: (candle: any) => void }
  period: Period
  symbol?: {
    ticker: string
    name: string
    shortName: string
    market: string
    pricePrecision: number
    volumePrecision: number
  }
  timezone?: string
  onOhlcChange?:          (data: OhlcData) => void
  onCrosshairOhlcChange?: (data: OhlcData | null) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

const KLineChartProWrapper = forwardRef<KLineChartRef, Props>(function KLineChartProWrapper(
  { datafeed, period, symbol, timezone = 'UTC', onOhlcChange, onCrosshairOhlcChange }, ref
) {
  const containerRef      = useRef<HTMLDivElement>(null)
  const chartRef          = useRef<KLineChartPro | null>(null)
  const hiddenBarRef      = useRef<HTMLDivElement>(null)
  const onOhlcRef         = useRef(onOhlcChange)
  const onCrosshairRef    = useRef(onCrosshairOhlcChange)
  const yAxisFormatterRef = useRef<((val: number) => string) | null>(null)
  onOhlcRef.current       = onOhlcChange
  onCrosshairRef.current  = onCrosshairOhlcChange

  useImperativeHandle(ref, () => ({
    clickIndicator:  () => clickHiddenTool(0),
    clickSettings:   () => clickHiddenTool(2),
    clickScreenshot: () => clickHiddenTool(3),
    clickFullscreen: () => clickHiddenTool(4),
    toggleDrawingBar: () => {
      if (!containerRef.current) return false
      const wasHidden = containerRef.current.classList.contains('klc-bar-hidden')
      containerRef.current.classList.toggle('klc-bar-hidden', !wasHidden)
      return wasHidden
    },
    setYAxisMode: (mode) => {
      chartRef.current?.setStyles?.({ yAxis: { type: mode } } as any)
    },
    setCandleType: (type) => {
      chartRef.current?.setStyles?.({ candle: { type } } as any)
    },
    setYAxisFormatter: (fmt) => {
      yAxisFormatterRef.current = fmt
      applyMcapAxis(fmt)
    },
  }))

  function clickHiddenTool(index: number) {
    const btns = hiddenBarRef.current?.querySelectorAll<HTMLElement>('.tools')
    btns?.[index]?.click()
  }

  function applyMcapAxis(fmt: ((val: number) => string) | null) {
    if (!containerRef.current) return
    const klcChart = getKlcChart(containerRef.current)
    if (!klcChart) return
    if (fmt) {
      _activeMcapFmt = fmt
      klcChart.setPaneOptions({ id: 'candle_pane', axisOptions: { name: 'mcap' } } as any)
      klcChart.setStyles({ crosshair: { horizontal: { text: { show: false } } } } as any)
    } else {
      _activeMcapFmt = null
      klcChart.setPaneOptions({ id: 'candle_pane', axisOptions: { name: 'default' } } as any)
      klcChart.setStyles({ crosshair: { horizontal: { text: { show: true } } } } as any)
    }
  }

  useEffect(() => {
    if (!containerRef.current) return

    const defaultSymbol = symbol ?? {
      ticker: 'TOKEN',
      name: 'Token',
      shortName: 'TOKEN/SOL',
      market: 'pumpi',
      pricePrecision: 8,
      volumePrecision: 2,
    }

    chartRef.current = new KLineChartPro({
      container: containerRef.current,
      theme: 'dark',
      locale: 'en-US',
      drawingBarVisible: true,
      styles: TV_STYLES as any,
      symbol: defaultSymbol,
      period,
      periods: [
        { multiplier: 1,  timespan: 'minute', text: '1m'  },
        { multiplier: 5,  timespan: 'minute', text: '5m'  },
        { multiplier: 15, timespan: 'minute', text: '15m' },
        { multiplier: 30, timespan: 'minute', text: '30m' },
        { multiplier: 1,  timespan: 'hour',   text: '1H'  },
        { multiplier: 4,  timespan: 'hour',   text: '4H'  },
        { multiplier: 1,  timespan: 'day',    text: 'D'   },
        { multiplier: 1,  timespan: 'week',   text: 'W'   },
        { multiplier: 1,  timespan: 'month',  text: 'M'   },
      ],
      timezone,
      mainIndicators: [],
      subIndicators: [],
      watermark: '',
      datafeed,
    })

    const hiddenEl = containerRef.current.querySelector<HTMLDivElement>('.klinecharts-pro-period-bar')
    if (hiddenEl) (hiddenBarRef as any).current = hiddenEl

    // Start with drawing bar hidden
    containerRef.current.classList.add('klc-bar-hidden')

    datafeed.onLiveCandle = (candle) => {
      onOhlcRef.current?.({
        open: candle.open, high: candle.high, low: candle.low,
        close: candle.close, volume: candle.volume ?? 0,
      })
    }

    if (yAxisFormatterRef.current) applyMcapAxis(yAxisFormatterRef.current)

    const klcChart = getKlcChart(containerRef.current)
    let unsubscribeCrosshair: (() => void) | undefined
    if (klcChart) {
      const handler = (data: any) => {
        const k = data?.kLineData
        if (k) {
          onCrosshairRef.current?.({
            open: k.open, high: k.high, low: k.low,
            close: k.close, volume: k.volume ?? 0,
          })
        } else {
          onCrosshairRef.current?.(null)
        }
      }
      klcChart.subscribeAction('onCrosshairChange', handler)
      unsubscribeCrosshair = () => klcChart.unsubscribeAction('onCrosshairChange', handler)
    }

    return () => {
      unsubscribeCrosshair?.()
      datafeed.onLiveCandle = undefined
      if (containerRef.current) containerRef.current.innerHTML = ''
      chartRef.current = null
    }
  }, [period.text])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
})

export default KLineChartProWrapper
