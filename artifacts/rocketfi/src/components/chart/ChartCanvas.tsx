/**
 * ChartCanvas — lightweight-charts v5
 * Main chart: candlestick + volume (or area line)
 * Overlay indicators: MA20/50/200, EMA9/21, BB, VWAP, PSAR
 * Sub-pane indicators: RSI, MACD, STOCH (separate synced chart instances)
 */
import { useEffect, useLayoutEffect, useRef, useState, useCallback, memo } from "react";
import { formatTokenPrice } from "@/lib/utils";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesType,
  type Time,
  type CandlestickSeriesOptions,
  type HistogramSeriesOptions,
  type LineSeriesOptions,
  type AreaSeriesOptions,
} from "lightweight-charts";
import type { OHLCVBar } from "@/lib/ohlcv";

export type ChartType = "candle" | "line";
export type Indicator =
  | "MA20" | "MA50" | "MA200"
  | "EMA9" | "EMA21"
  | "BB" | "VWAP" | "PSAR"
  | "RSI" | "MACD" | "STOCH";

export interface OHLCSnapshot {
  open: number; high: number; low: number; close: number; volume?: number;
}

interface ChartCanvasProps {
  bars:             OHLCVBar[];
  address?:         string;
  loading?:         boolean;
  chartType?:       ChartType;
  indicators?:      Indicator[];
  solPrice?:        number | null;
  symbol?:          string;
  graduated?:       boolean;
  graduatedAt?:     string | Date | null;
  priceFormatter?:  (price: number) => string;
  onCrosshairMove?: (bar: OHLCSnapshot | null) => void;
}

/** Build a USD price formatter for lightweight-charts axis labels */
function makeUsdFormatter(solPrice: number | null): (p: number) => string {
  return (p: number) => {
    if (!solPrice || !p || !Number.isFinite(p)) {
      return p < 0.0001 ? p.toExponential(3) : p.toPrecision(5);
    }
    return formatTokenPrice(p * solPrice);
  };
}

/* ── Constants ─────────────────────────────────────────────────────── */
const UP   = "#089981";
const DOWN = "#f23645";
const BG   = "#0B1220";

const IND_COLOR: Record<string, string> = {
  MA20: "#fbbf24", MA50: "#fb923c", MA200: "#a78bfa",
  EMA9: "#22d3ee", EMA21: "#60a5fa",
  BB_UPPER: "#aaaaaa", BB_MIDDLE: "#999999", BB_LOWER: "#aaaaaa",
  VWAP: "#f472b6",
};

const PANE_H = 90;
const PRICE_SCALE_W = 58;
const MIN_BAR_PX = 7;

function calcVisibleBars(containerWidth: number): number {
  const effective = Math.max(containerWidth - PRICE_SCALE_W, 120);
  return Math.max(20, Math.min(80, Math.floor(effective / MIN_BAR_PX)));
}

/* ── Math helpers ──────────────────────────────────────────────────── */
function smaArr(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += closes[j]!;
    return s / period;
  });
}

function emaArr(closes: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let val = 0;
  for (let i = 0; i < period; i++) val += closes[i]!;
  val /= period;
  out[period - 1] = val;
  for (let i = period; i < closes.length; i++) {
    val = closes[i]! * k + val * (1 - k);
    out[i] = val;
  }
  return out;
}

function sma(bars: OHLCVBar[], period: number) {
  const closes = bars.map(b => b.close);
  const vals = smaArr(closes, period);
  return bars.map((b, i) => vals[i] !== null ? { time: b.time, value: vals[i]! } : null)
    .filter(Boolean) as { time: number; value: number }[];
}

function ema(bars: OHLCVBar[], period: number) {
  const closes = bars.map(b => b.close);
  const vals = emaArr(closes, period);
  return bars.map((b, i) => vals[i] !== null ? { time: b.time, value: vals[i]! } : null)
    .filter(Boolean) as { time: number; value: number }[];
}

function bb(bars: OHLCVBar[], period = 20, mult = 2) {
  const upper: { time: number; value: number }[] = [];
  const mid:   { time: number; value: number }[] = [];
  const lower: { time: number; value: number }[] = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j]!.close;
    const mean = sum / period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) varSum += (bars[j]!.close - mean) ** 2;
    const std = Math.sqrt(varSum / period);
    const t = bars[i]!.time;
    upper.push({ time: t, value: mean + mult * std });
    mid.push({ time: t, value: mean });
    lower.push({ time: t, value: mean - mult * std });
  }
  return { upper, mid, lower };
}

function vwap(bars: OHLCVBar[]) {
  let cumTV = 0, cumV = 0;
  return bars.map(b => {
    const tp = (b.high + b.low + b.close) / 3;
    cumTV += tp * (b.volume || 0);
    cumV  += b.volume || 0;
    return { time: b.time, value: cumV > 0 ? cumTV / cumV : b.close };
  });
}

function psar(bars: OHLCVBar[], step = 0.02, max = 0.2) {
  if (bars.length < 2) return [] as { time: number; value: number; above: boolean }[];
  const out: { time: number; value: number; above: boolean }[] = [];
  let bull = true;
  let sar = bars[0]!.low;
  let ep = bars[0]!.high;
  let af = step;

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const cur  = bars[i]!;
    sar = sar + af * (ep - sar);
    if (bull) {
      if (cur.low < sar) {
        bull = false; sar = ep; ep = cur.low; af = step;
      } else {
        if (cur.high > ep) { ep = cur.high; af = Math.min(af + step, max); }
        sar = Math.min(sar, prev.low, i >= 2 ? bars[i - 2]!.low : prev.low);
      }
    } else {
      if (cur.high > sar) {
        bull = true; sar = ep; ep = cur.high; af = step;
      } else {
        if (cur.low < ep) { ep = cur.low; af = Math.min(af + step, max); }
        sar = Math.max(sar, prev.high, i >= 2 ? bars[i - 2]!.high : prev.high);
      }
    }
    out.push({ time: cur.time, value: sar, above: !bull });
  }
  return out;
}

function rsi(bars: OHLCVBar[], period = 14) {
  const pts: { time: number; value: number }[] = [];
  if (bars.length <= period) return pts;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = bars[i]!.close - bars[i - 1]!.close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  pts.push({ time: bars[period]!.time, value: 100 - 100 / (1 + rs0) });
  for (let i = period + 1; i < bars.length; i++) {
    const diff = bars[i]!.close - bars[i - 1]!.close;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    pts.push({ time: bars[i]!.time, value: 100 - 100 / (1 + rs) });
  }
  return pts;
}

function macd(bars: OHLCVBar[], fast = 12, slow = 26, signal = 9) {
  const closes = bars.map(b => b.close);
  const fastEma = emaArr(closes, fast);
  const slowEma = emaArr(closes, slow);
  const macdLine: (number | null)[] = closes.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null ? fastEma[i]! - slowEma[i]! : null
  );
  const signalLine: (number | null)[] = new Array(closes.length).fill(null);
  const macdValid = macdLine.map((v, i) => ({ v, i })).filter(x => x.v !== null);
  if (macdValid.length >= signal) {
    const k = 2 / (signal + 1);
    let val = 0;
    for (let i = 0; i < signal; i++) val += macdValid[i]!.v!;
    val /= signal;
    signalLine[macdValid[signal - 1]!.i] = val;
    for (let i = signal; i < macdValid.length; i++) {
      val = macdValid[i]!.v! * k + val * (1 - k);
      signalLine[macdValid[i]!.i] = val;
    }
  }
  const macdPts:   { time: number; value: number }[] = [];
  const signalPts: { time: number; value: number }[] = [];
  const histPts:   { time: number; value: number; color: string }[] = [];
  bars.forEach((b, i) => {
    if (macdLine[i] !== null)   macdPts.push({ time: b.time, value: macdLine[i]! });
    if (signalLine[i] !== null) signalPts.push({ time: b.time, value: signalLine[i]! });
    if (macdLine[i] !== null && signalLine[i] !== null) {
      const h = macdLine[i]! - signalLine[i]!;
      histPts.push({ time: b.time, value: h, color: h >= 0 ? "rgba(0,255,136,0.5)" : "rgba(255,68,68,0.5)" });
    }
  });
  return { macdPts, signalPts, histPts };
}

function stoch(bars: OHLCVBar[], kPeriod = 14, dPeriod = 3) {
  const kPts: { time: number; value: number }[] = [];
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const slice = bars.slice(i - kPeriod + 1, i + 1);
    const low  = Math.min(...slice.map(b => b.low));
    const high = Math.max(...slice.map(b => b.high));
    const k = high === low ? 50 : ((bars[i]!.close - low) / (high - low)) * 100;
    kPts.push({ time: bars[i]!.time, value: k });
  }
  const kVals = kPts.map(p => p.value);
  const dPts: { time: number; value: number }[] = [];
  for (let i = dPeriod - 1; i < kPts.length; i++) {
    let sum = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) sum += kVals[j]!;
    dPts.push({ time: kPts[i]!.time, value: sum / dPeriod });
  }
  return { kPts, dPts };
}

/* ── Overlay series key → data ─────────────────────────────────────── */
function expandIndicators(inds: Indicator[]): string[] {
  const out: string[] = [];
  for (const ind of inds) {
    if (ind === "BB") out.push("BB_UPPER", "BB_MIDDLE", "BB_LOWER");
    else if (!["RSI","MACD","STOCH","PSAR"].includes(ind)) out.push(ind);
  }
  return out;
}

function calcOverlay(key: string, clean: OHLCVBar[]): { time: number; value: number }[] {
  if (key === "MA20")      return sma(clean, 20);
  if (key === "MA50")      return sma(clean, 50);
  if (key === "MA200")     return sma(clean, 200);
  if (key === "EMA9")      return ema(clean, 9);
  if (key === "EMA21")     return ema(clean, 21);
  if (key === "VWAP")      return vwap(clean);
  const { upper, mid, lower } = bb(clean, 20, 2);
  if (key === "BB_UPPER")  return upper;
  if (key === "BB_MIDDLE") return mid;
  if (key === "BB_LOWER")  return lower;
  return [];
}

/* ── Chart factory ─────────────────────────────────────────────────── */
function makeChart(
  el: HTMLElement,
  opts: { timeVisible?: boolean; rightScale?: boolean; priceFormatter?: (p: number) => string } = {},
) {
  return createChart(el, {
    layout: { background: { type: ColorType.Solid, color: BG }, textColor: "#94a3b8", fontSize: 11, fontFamily: "'Inter', 'Plus Jakarta Sans', sans-serif" },
    grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
    crosshair: {
      vertLine: { color: "rgba(59,130,246,0.4)", width: 1, style: 3 },
      horzLine: { color: "rgba(59,130,246,0.4)", width: 1, style: 3 },
    },
    rightPriceScale: { borderColor: "rgba(255,255,255,0.1)", minimumWidth: 48, visible: opts.rightScale ?? true },
    leftPriceScale:  { visible: false },
    timeScale: { borderColor: "rgba(255,255,255,0.1)", timeVisible: opts.timeVisible ?? false, secondsVisible: false },
    localization: opts.priceFormatter ? { priceFormatter: opts.priceFormatter } : {},
    handleScroll: true, handleScale: true,
    width: el.clientWidth, height: el.clientHeight,
  });
}

/* ── Sub-pane label overlay ────────────────────────────────────────── */
function SubPaneLabel({ label }: { label: string }) {
  return (
    <div className="absolute top-1 left-2 z-10 pointer-events-none"
      style={{ fontSize: 9, fontWeight: 600, color: "#475569", letterSpacing: "0.05em" }}>
      {label}
    </div>
  );
}

/* ── No-data overlay ────────────────────────────────────────────────── */
function ChartNoData({ visible }: { visible: boolean }) {
  return (
    <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center flex-col gap-2"
      style={{
        background: BG,
        opacity: visible ? 1 : 0,
        transition: "opacity 0.3s ease-out",
      }}
    >
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
        <rect x="9.5"  y="4"  width="1.5" height="7"  rx="0.75" fill="rgba(255,255,255,0.18)" />
        <rect x="19.5" y="6"  width="1.5" height="5"  rx="0.75" fill="rgba(255,255,255,0.18)" />
        <rect x="29.5" y="5"  width="1.5" height="6"  rx="0.75" fill="rgba(255,255,255,0.18)" />
        <rect x="7"   y="11" width="6" height="11" rx="1" fill="rgba(255,255,255,0.14)" />
        <rect x="17"  y="11" width="6" height="8"  rx="1" fill="rgba(255,255,255,0.14)" />
        <rect x="27"  y="11" width="6" height="13" rx="1" fill="rgba(255,255,255,0.14)" />
        <rect x="9.5"  y="22" width="1.5" height="7"  rx="0.75" fill="rgba(255,255,255,0.18)" />
        <rect x="19.5" y="19" width="1.5" height="6"  rx="0.75" fill="rgba(255,255,255,0.18)" />
        <rect x="29.5" y="24" width="1.5" height="7"  rx="0.75" fill="rgba(255,255,255,0.18)" />
        <rect x="4" y="34" width="32" height="1" rx="0.5" fill="rgba(255,255,255,0.10)" />
      </svg>
      <span style={{ fontSize: 13, fontWeight: 500, color: "rgba(255,255,255,0.32)", fontFamily: "'Inter', sans-serif", letterSpacing: "0.01em" }}>
        No chart data
      </span>
    </div>
  );
}

/* ── Loading skeleton ───────────────────────────────────────────────── */
function ChartSkeleton({ visible }: { visible: boolean }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3"
      style={{
        background: BG,
        opacity: visible ? 1 : 0,
        transition: "opacity 0.4s ease-out",
        pointerEvents: visible ? "all" : "none",
      }}
    >
      <svg width="36" height="36" viewBox="0 0 36 36"
        style={{ animation: "chartSpinnerRotate 0.9s linear infinite", flexShrink: 0 }}>
        <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
        <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(59,130,246,0.75)" strokeWidth="3"
          strokeLinecap="round" strokeDasharray="30 65" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.8)", fontFamily: "'Inter', sans-serif" }}>
          Loading chart
        </span>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", fontFamily: "'Inter', sans-serif" }}>
          Please wait…
        </span>
      </div>
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────────── */
export const ChartCanvas = memo(function ChartCanvas({
  bars, address, loading, chartType = "candle", indicators = [], solPrice, symbol, graduated, graduatedAt, priceFormatter, onCrosshairMove,
}: ChartCanvasProps) {
  const mainRef    = useRef<HTMLDivElement>(null);
  const chartRef   = useRef<IChartApi | null>(null);
  const candleRef  = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef     = useRef<ISeriesApi<"Histogram">   | null>(null);
  const lineRef    = useRef<ISeriesApi<"Area">        | null>(null);
  const lastBarRef = useRef<OHLCVBar | null>(null);
  const barBucketSecRef = useRef<number>(60);
  const indSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const psarUpRef  = useRef<ISeriesApi<"Line"> | null>(null);
  const psarDnRef  = useRef<ISeriesApi<"Line"> | null>(null);
  const lastBarIdxRef = useRef<number>(-1);
  const onCrosshairMoveRef = useRef(onCrosshairMove);
  useEffect(() => { onCrosshairMoveRef.current = onCrosshairMove; }, [onCrosshairMove]);

  // Holds the lightweight-charts v5 series-markers plugin API for the main series.
  // Populated in useLayoutEffect after the series is created; nulled on cleanup.
  const seriesMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // Mutable refs so crosshair handler always reads latest values without closure staleness
  const solPriceRef = useRef<number | null>(solPrice ?? null);
  solPriceRef.current = solPrice ?? null;
  const symbolRef = useRef<string | undefined>(symbol);
  symbolRef.current = symbol;

  // In-chart OHLCV overlay — updated imperatively, zero re-renders
  const innerOhlcRef = useRef<HTMLDivElement>(null);

  // Stable writer — reads latest refs, callable from bars effect AND crosshair handler
  const writeInnerOhlc = useCallback((bar: { open: number; high: number; low: number; close: number } | null) => {
    const el = innerOhlcRef.current;
    if (!el) return;
    if (!bar) { el.style.opacity = "0"; return; }
    const sp = solPriceRef.current;
    const fmt = (n: number): string => {
      if (sp && n > 0) return formatTokenPrice(n * sp);
      return n < 0.00001 ? n.toExponential(3) : n.toPrecision(4);
    };
    const isUp = bar.close >= bar.open;
    const UP   = "#4ade80";
    const DN   = "#f87171";
    const VAL  = isUp ? UP : DN;
    el.style.opacity = "1";
    el.innerHTML =
      `<span style="color:#94a3b8">O</span><span style="color:${VAL}"> ${fmt(bar.open)}</span> ` +
      `<span style="color:#94a3b8">H</span><span style="color:${UP}"> ${fmt(bar.high)}</span> ` +
      `<span style="color:#94a3b8">L</span><span style="color:${DN}"> ${fmt(bar.low)}</span> ` +
      `<span style="color:#94a3b8">C</span><span style="color:${VAL}"> ${fmt(bar.close)}</span>`;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const writeInnerOhlcRef = useRef(writeInnerOhlc);
  useEffect(() => { writeInnerOhlcRef.current = writeInnerOhlc; }, [writeInnerOhlc]);

  // When solPrice loads or changes, update the chart's axis formatter in-place
  // (no chart recreation needed — applyOptions is cheap)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const fmt = priceFormatter ?? makeUsdFormatter(solPrice ?? null);
    chart.applyOptions({ localization: { priceFormatter: fmt } });
  }, [solPrice, priceFormatter]);

  const rsiRef   = useRef<HTMLDivElement>(null);
  const macdRef  = useRef<HTMLDivElement>(null);
  const stochRef = useRef<HTMLDivElement>(null);
  const rsiChart   = useRef<IChartApi | null>(null);
  const macdChart  = useRef<IChartApi | null>(null);
  const stochChart = useRef<IChartApi | null>(null);

  const showRSI   = indicators.includes("RSI");
  const showMACD  = indicators.includes("MACD");
  const showStoch = indicators.includes("STOCH");
  const showPSAR  = indicators.includes("PSAR");

  function cleanBars(raw: OHLCVBar[]) {
    const seen = new Set<number>();
    return raw
      .filter(b => {
        if (!isFinite(b.open) || !isFinite(b.close) || !isFinite(b.high) || !isFinite(b.low)) return false;
        if (seen.has(b.time)) return false;
        seen.add(b.time);
        return true;
      })
      .sort((a, b) => a.time - b.time);
  }

  function syncPSAR(chart: IChartApi, clean: OHLCVBar[], active: boolean) {
    if (!active) {
      if (psarUpRef.current) { try { chart.removeSeries(psarUpRef.current); } catch {} psarUpRef.current = null; }
      if (psarDnRef.current) { try { chart.removeSeries(psarDnRef.current); } catch {} psarDnRef.current = null; }
      return;
    }
    const pts = psar(clean);
    const upPts = pts.filter(p => p.above).map(p => ({ time: p.time as never, value: p.value }));
    const dnPts = pts.filter(p => !p.above).map(p => ({ time: p.time as never, value: p.value }));

    function makePsarSeries(color: string) {
      return chart.addSeries(LineSeries as unknown as typeof LineSeries, {
        color, lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        priceFormat:   { type: "price", precision: 8, minMove: 0.00000001 },
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: true,
        crosshairMarkerRadius: 3,
      } as Partial<LineSeriesOptions>);
    }

    if (!psarUpRef.current) psarUpRef.current = makePsarSeries("#ff4466");
    if (!psarDnRef.current) psarDnRef.current = makePsarSeries("#22c55e");
    psarUpRef.current.setData(upPts);
    psarDnRef.current.setData(dnPts);
  }

  function makeSubChart(
    el: HTMLElement | null,
    ref: React.MutableRefObject<IChartApi | null>,
    mainChartApi: IChartApi | null,
  ) {
    if (!el) return;
    if (ref.current) { ref.current.remove(); ref.current = null; }
    const c = makeChart(el, { timeVisible: true });
    ref.current = c;
    if (mainChartApi) {
      mainChartApi.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (range) c.timeScale().setVisibleLogicalRange(range);
      });
      c.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (range) mainChartApi.timeScale().setVisibleLogicalRange(range);
      });
    }
    const ro = new ResizeObserver(() => {
      if (el) c.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
  }

  /* ── Init main chart ─────────────────────────────────────────────── */
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;

    const chart = makeChart(el, { timeVisible: true, rightScale: true, priceFormatter: priceFormatter ?? makeUsdFormatter(solPrice ?? null) });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.10, bottom: 0.05 } });

    if (chartType === "candle") {
      candleRef.current = chart.addSeries(CandlestickSeries as unknown as typeof CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
      } as Partial<CandlestickSeriesOptions>);
      volRef.current = chart.addSeries(HistogramSeries as unknown as typeof HistogramSeries, {
        color: "rgba(8,153,129,0.5)", priceFormat: { type: "volume" }, priceScaleId: "left",
        lastValueVisible: false, priceLineVisible: false,
      } as Partial<HistogramSeriesOptions>);
      chart.priceScale("left").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
      // Attach the series-markers plugin to the candle series (v5 API)
      seriesMarkersRef.current = createSeriesMarkers(
        candleRef.current as unknown as ISeriesApi<SeriesType, Time>,
      );
    } else {
      lineRef.current = chart.addSeries(AreaSeries as unknown as typeof AreaSeries, {
        lineColor: UP, topColor: "rgba(8,153,129,0.18)", bottomColor: "rgba(8,153,129,0.0)", lineWidth: 2,
        priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
      } as Partial<AreaSeriesOptions>);
      chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.10, bottom: 0.08 } });
      // Attach the series-markers plugin to the area series (v5 API)
      seriesMarkersRef.current = createSeriesMarkers(
        lineRef.current as unknown as ISeriesApi<SeriesType, Time>,
      );
    }

    chartRef.current = chart;
    indSeriesRef.current.clear();
    psarUpRef.current = null;
    psarDnRef.current = null;

    chart.subscribeCrosshairMove(param => {
      const cb = onCrosshairMoveRef.current;

      const writeOhlc = writeInnerOhlcRef.current;

      if (!param.time) { cb?.(null); writeOhlc(lastBarRef.current); return; }
      if (candleRef.current) {
        const cd = param.seriesData.get(candleRef.current as never) as { open: number; high: number; low: number; close: number } | undefined;
        if (cd) {
          let vol: number | undefined;
          if (volRef.current) {
            const vd = param.seriesData.get(volRef.current as never) as { value: number } | undefined;
            if (vd) vol = vd.value;
          }
          cb?.({ open: cd.open, high: cd.high, low: cd.low, close: cd.close, volume: vol });
          writeOhlc(cd);
          return;
        }
      }
      if (lineRef.current) {
        const ld = param.seriesData.get(lineRef.current as never) as { value: number } | undefined;
        if (ld) {
          cb?.({ open: ld.value, high: ld.value, low: ld.value, close: ld.value });
          writeOhlc({ open: ld.value, high: ld.value, low: ld.value, close: ld.value });
        }
      }
    });

    const ro = new ResizeObserver(() => {
      if (!el) return;
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      const li = lastBarIdxRef.current;
      if (li >= 0) {
        const vb = calcVisibleBars(el.clientWidth);
        requestAnimationFrame(() => {
          chartRef.current?.timeScale().setVisibleLogicalRange({ from: li - vb + 1, to: li + 3 });
        });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      candleRef.current = lineRef.current = volRef.current = psarUpRef.current = psarDnRef.current = null;
      seriesMarkersRef.current = null;
      indSeriesRef.current.clear();
    };
  }, [chartType]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Update bars ─────────────────────────────────────────────────── */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!bars.length) {
      candleRef.current?.setData([]);
      volRef.current?.setData([]);
      lineRef.current?.setData([]);
      lastBarRef.current = null;
      return;
    }
    const clean = cleanBars(bars);
    if (!clean.length) return;
    try {
      if (chartType === "candle") {
        candleRef.current?.setData(clean.map(b => ({ time: b.time as never, open: b.open, high: b.high, low: b.low, close: b.close })));
        volRef.current?.setData(clean.map(b => ({
          time: b.time as never,
          value: isFinite(b.volume) ? Math.min(b.volume, 90_071_992_547_409) : 0,
          color: b.close >= b.open ? "rgba(8,153,129,0.5)" : "rgba(242,54,69,0.5)",
        })));
      } else {
        lineRef.current?.setData(clean.map(b => ({ time: b.time as never, value: b.close })));
      }

      for (const [key, series] of indSeriesRef.current) {
        series.setData(calcOverlay(key, clean).map(p => ({ time: p.time as never, value: p.value })));
      }
      syncPSAR(chart, clean, showPSAR);

      const lastIdx = clean.length - 1;
      lastBarIdxRef.current = lastIdx;

      const el = mainRef.current;
      if (el && chart) {
        const w = el.clientWidth || el.offsetWidth || window.innerWidth || 400;
        const h = el.clientHeight || el.offsetHeight || 300;
        chart.applyOptions({ width: w, height: h });
      }
      const containerW = el ? (el.clientWidth || el.offsetWidth || window.innerWidth || 400) : 400;
      const visibleBars = calcVisibleBars(containerW);
      try {
        chart.timeScale().setVisibleLogicalRange({ from: lastIdx - visibleBars + 1, to: lastIdx + 3 });
      } catch { /* ignore */ }

      requestAnimationFrame(() => {
        const c = chartRef.current;
        const e = mainRef.current;
        if (!c || !e) return;
        const w2 = e.clientWidth || e.offsetWidth || window.innerWidth || 400;
        const vb2 = calcVisibleBars(w2);
        try { c.timeScale().setVisibleLogicalRange({ from: lastIdx - vb2 + 1, to: lastIdx + 3 }); } catch { /* ignore */ }
        // Re-enable autoScale after every data update so the Y-axis always fits
        // visible candles even if the user previously dragged the price axis on
        // a different token (which disables autoScale for that chart instance).
        try { c.priceScale("right").applyOptions({ autoScale: true }); } catch { /* ignore */ }
      });

      clearTimeout(loadTimeoutRef.current);
      requestAnimationFrame(() => readyAfterMin());

      lastBarRef.current = clean[clean.length - 1]!;
      // Populate OHLC overlay immediately from the last bar (visible before any hover)
      requestAnimationFrame(() => writeInnerOhlcRef.current(clean[clean.length - 1]!));
      if (clean.length >= 2) {
        barBucketSecRef.current = (clean[1]!.time - clean[0]!.time) || 60;
      }

      // ── Graduation marker (lightweight-charts v5 plugin API) ──────────────
      // createSeriesMarkers() was called in useLayoutEffect; the plugin ref is
      // always attached to the current main series. Update its marker list here
      // so any change to bars OR graduatedAt causes the annotation to re-render.
      const markerPlugin = seriesMarkersRef.current;
      if (markerPlugin) {
        if (graduatedAt && clean.length > 0) {
          const gradTs = new Date(graduatedAt).getTime() / 1000; // unix seconds
          // Walk forward to find the last bar whose time ≤ graduatedAt
          let bestBar = clean[0]!;
          for (const b of clean) {
            if (b.time <= gradTs) bestBar = b;
            else break;
          }
          markerPlugin.setMarkers([{
            time: bestBar.time as Time,
            position: "aboveBar",
            color: "#a78bfa",
            shape: "arrowUp",
            text: "Raydium ↑",
          }]);
        } else {
          // No graduation timestamp — clear any stale marker
          markerPlugin.setMarkers([]);
        }
      }
    } catch (err) { console.warn("[ChartCanvas] setData:", err); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, chartType, graduatedAt]);

  /* ── Update indicators ──────────────────────────────────────────── */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const wanted  = new Set(expandIndicators(indicators));
    const current = indSeriesRef.current;
    for (const [key, series] of current) {
      if (!wanted.has(key)) { try { chart.removeSeries(series); } catch {} current.delete(key); }
    }
    const clean = cleanBars(bars);
    for (const key of wanted) {
      if (current.has(key)) continue;
      const color = IND_COLOR[key];
      if (!color) continue;
      try {
        const series = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
          color, lineWidth: 1,
          lineStyle: key.startsWith("BB") ? LineStyle.Dashed : LineStyle.Solid,
          priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
          lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
        } as Partial<LineSeriesOptions>);
        if (clean.length) series.setData(calcOverlay(key, clean).map(p => ({ time: p.time as never, value: p.value })));
        current.set(key, series);
      } catch (err) { console.warn(`[ChartCanvas] indicator ${key}:`, err); }
    }
    syncPSAR(chart, clean, showPSAR);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators, bars]);

  /* ── RSI sub-pane ───────────────────────────────────────────────── */
  useEffect(() => {
    const el = rsiRef.current;
    if (!showRSI || !el) {
      if (rsiChart.current) { rsiChart.current.remove(); rsiChart.current = null; }
      return;
    }
    makeSubChart(el, rsiChart, chartRef.current);
    const chart = rsiChart.current!;
    const ob = chart.addSeries(LineSeries as unknown as typeof LineSeries, { color: "rgba(248,113,113,0.3)", lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false } as Partial<LineSeriesOptions>);
    const os = chart.addSeries(LineSeries as unknown as typeof LineSeries, { color: "rgba(0,255,136,0.3)",  lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false } as Partial<LineSeriesOptions>);
    const rsiLine = chart.addSeries(LineSeries as unknown as typeof LineSeries, { color: "#c084fc", lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 }, lastValueVisible: true, priceLineVisible: false } as Partial<LineSeriesOptions>);
    const clean = cleanBars(bars);
    if (clean.length) {
      const pts = rsi(clean, 14);
      rsiLine.setData(pts.map(p => ({ time: p.time as never, value: p.value })));
      if (pts.length) {
        const times = [pts[0]!.time, pts[pts.length - 1]!.time] as never[];
        ob.setData([{ time: times[0]!, value: 70 }, { time: times[1]!, value: 70 }]);
        os.setData([{ time: times[0]!, value: 30 }, { time: times[1]!, value: 30 }]);
      }
    }
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: 48 });
    return () => { if (rsiChart.current) { rsiChart.current.remove(); rsiChart.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRSI, bars]);

  /* ── MACD sub-pane ──────────────────────────────────────────────── */
  useEffect(() => {
    const el = macdRef.current;
    if (!showMACD || !el) {
      if (macdChart.current) { macdChart.current.remove(); macdChart.current = null; }
      return;
    }
    makeSubChart(el, macdChart, chartRef.current);
    const chart = macdChart.current!;
    const macdLine = chart.addSeries(LineSeries as unknown as typeof LineSeries, { color: "#60a5fa", lineWidth: 1, priceFormat: { type: "price", precision: 6, minMove: 0.000001 }, lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false } as Partial<LineSeriesOptions>);
    const sigLine  = chart.addSeries(LineSeries as unknown as typeof LineSeries, { color: "#f472b6", lineWidth: 1, priceFormat: { type: "price", precision: 6, minMove: 0.000001 }, lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false } as Partial<LineSeriesOptions>);
    const hist     = chart.addSeries(HistogramSeries as unknown as typeof HistogramSeries, { priceFormat: { type: "price", precision: 6, minMove: 0.000001 }, priceScaleId: "right" } as Partial<HistogramSeriesOptions>);
    const clean = cleanBars(bars);
    if (clean.length) {
      const { macdPts, signalPts, histPts } = macd(clean);
      macdLine.setData(macdPts.map(p => ({ time: p.time as never, value: p.value })));
      sigLine.setData(signalPts.map(p => ({ time: p.time as never, value: p.value })));
      hist.setData(histPts.map(p => ({ time: p.time as never, value: p.value, color: p.color })));
    }
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 }, minimumWidth: 48 });
    return () => { if (macdChart.current) { macdChart.current.remove(); macdChart.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMACD, bars]);

  /* ── Stoch sub-pane ─────────────────────────────────────────────── */
  useEffect(() => {
    const el = stochRef.current;
    if (!showStoch || !el) {
      if (stochChart.current) { stochChart.current.remove(); stochChart.current = null; }
      return;
    }
    makeSubChart(el, stochChart, chartRef.current);
    const chart = stochChart.current!;
    const kLine = chart.addSeries(LineSeries as unknown as typeof LineSeries, { color: "#22d3ee", lineWidth: 1, priceFormat: { type: "price", precision: 2, minMove: 0.01 }, lastValueVisible: true, priceLineVisible: false } as Partial<LineSeriesOptions>);
    const dLine = chart.addSeries(LineSeries as unknown as typeof LineSeries, { color: "#fb923c", lineWidth: 1, priceFormat: { type: "price", precision: 2, minMove: 0.01 }, lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false } as Partial<LineSeriesOptions>);
    const ob = chart.addSeries(LineSeries as unknown as typeof LineSeries, { color: "rgba(248,113,113,0.25)", lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false } as Partial<LineSeriesOptions>);
    const os = chart.addSeries(LineSeries as unknown as typeof LineSeries, { color: "rgba(0,255,136,0.25)",  lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false } as Partial<LineSeriesOptions>);
    const clean = cleanBars(bars);
    if (clean.length) {
      const { kPts, dPts } = stoch(clean);
      kLine.setData(kPts.map(p => ({ time: p.time as never, value: p.value })));
      dLine.setData(dPts.map(p => ({ time: p.time as never, value: p.value })));
      if (kPts.length) {
        const t0 = kPts[0]!.time as never, t1 = kPts[kPts.length - 1]!.time as never;
        ob.setData([{ time: t0, value: 80 }, { time: t1, value: 80 }]);
        os.setData([{ time: t0, value: 20 }, { time: t1, value: 20 }]);
      }
    }
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: 48 });
    return () => { if (stochChart.current) { stochChart.current.remove(); stochChart.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStoch, bars]);

  /* ── Live price update via custom event ─────────────────────────── */
  useEffect(() => {
    if (!address) return;
    function onPrice(e: Event) {
      const { address: addr, price } = (e as CustomEvent<{ address: string; price: number }>).detail;
      if (addr.toLowerCase() !== address!.toLowerCase()) return;
      if (!price || price <= 0) return;
      const last = lastBarRef.current;
      if (!last) return;
      const bucketSec  = barBucketSecRef.current || 60;
      const nowBucket  = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;
      const lastBucket = last.time as number;
      if (nowBucket > lastBucket) {
        const newBar: OHLCVBar = { time: nowBucket, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 };
        lastBarRef.current = newBar;
        try {
          if (chartType === "candle" && candleRef.current) {
            candleRef.current.update({ time: newBar.time as never, open: newBar.open, high: newBar.high, low: newBar.low, close: newBar.close });
            volRef.current?.update({ time: newBar.time as never, value: 0, color: "rgba(8,153,129,0.5)" });
          } else if (lineRef.current) {
            lineRef.current.update({ time: newBar.time as never, value: newBar.close });
          }
        } catch { /* ignore */ }
      } else {
        const updated: OHLCVBar = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price };
        lastBarRef.current = updated;
        try {
          if (chartType === "candle" && candleRef.current) {
            candleRef.current.update({ time: updated.time as never, open: updated.open, high: updated.high, low: updated.low, close: updated.close });
          } else if (lineRef.current) {
            lineRef.current.update({ time: updated.time as never, value: updated.close });
          }
        } catch { /* ignore */ }
      }
    }
    window.addEventListener("app:price", onPrice);
    return () => window.removeEventListener("app:price", onPrice);
  }, [address, chartType]);

  /* ── Skeleton / ready state ─────────────────────────────────────── */
  const [chartReady, setChartReady]   = useState(false);
  const loadTimeoutRef  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prevAddressRef  = useRef<string | undefined>(address);
  const skeletonShownAt = useRef<number>(Date.now());
  const MIN_SKELETON_MS = 800;

  const readyAfterMin = useCallback(() => {
    const elapsed = Date.now() - skeletonShownAt.current;
    const remaining = MIN_SKELETON_MS - elapsed;
    if (remaining <= 0) {
      setChartReady(true);
    } else {
      loadTimeoutRef.current = setTimeout(() => setChartReady(true), remaining);
    }
  }, []);

  useEffect(() => {
    if (address !== prevAddressRef.current) {
      prevAddressRef.current = address;
      skeletonShownAt.current = Date.now();
      setChartReady(false);
      clearTimeout(loadTimeoutRef.current);
    }
  }, [address]);

  useEffect(() => {
    if (loading === false) {
      loadTimeoutRef.current = setTimeout(() => setChartReady(true), 3_000);
    }
    return () => clearTimeout(loadTimeoutRef.current);
  }, [loading]);

  /* ── Zoom controls ──────────────────────────────────────────────── */
  const [hovered, setHovered] = useState(false);

  const zoomIn = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const mid = (range.from + range.to) / 2;
    const next = (range.to - range.from) / 2 * 0.75;
    ts.setVisibleLogicalRange({ from: mid - next, to: mid + next });
  }, []);

  const zoomOut = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const mid = (range.from + range.to) / 2;
    const next = (range.to - range.from) / 2 * 1.35;
    ts.setVisibleLogicalRange({ from: mid - next, to: mid + next });
  }, []);

  const scrollLeft = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const step = (range.to - range.from) * 0.25;
    ts.setVisibleLogicalRange({ from: range.from - step, to: range.to - step });
  }, []);

  const scrollRight = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const step = (range.to - range.from) * 0.25;
    ts.setVisibleLogicalRange({ from: range.from + step, to: range.to + step });
  }, []);

  const paneCount = [showRSI, showMACD, showStoch].filter(Boolean).length;

  return (
    <div
      className="relative w-full h-full flex flex-col"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <ChartSkeleton visible={!chartReady} />
      <ChartNoData visible={chartReady && !bars.length} />
      <div ref={mainRef} style={{ flex: 1, minHeight: 0 }} />

      {/* ── Graduated badge — top-right, visible only for graduated tokens ── */}
      {graduated && (
        <div
          className="absolute top-2 right-2 z-20 select-none flex items-center gap-1.5 pointer-events-none"
          style={{
            background: "rgba(34,197,94,0.12)",
            border: "1px solid rgba(34,197,94,0.40)",
            borderRadius: 6,
            padding: "3px 8px",
            backdropFilter: "blur(6px)",
          }}
        >
          <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 700, letterSpacing: "0.05em" }}>
            🎓 GRADUATED TO RAYDIUM
          </span>
        </div>
      )}

      {/* ── In-chart symbol + OHLC overlay — single row ── */}
      <div
        className="absolute top-2 left-2 z-10 select-none flex items-center gap-3 pointer-events-none"
        style={{ maxWidth: "calc(100% - 160px)" }}
      >
        {/* Pair label — always visible, never scrolls away */}
        {symbol && (
          <span
            className="font-bold tracking-wide shrink-0"
            style={{ fontSize: 12, color: "#e2e8f0", letterSpacing: "0.03em" }}
          >
            {symbol.toUpperCase()}/USD
          </span>
        )}
        {/* OHLC — horizontally scrollable on mobile, pointer-events re-enabled for touch */}
        <div
          className="overflow-x-auto pointer-events-auto"
          style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
        >
          <div
            ref={innerOhlcRef}
            className="flex items-center gap-2 font-mono font-medium whitespace-nowrap"
            style={{ fontSize: 11, opacity: 1, transition: "opacity 0.12s" }}
          />
        </div>
      </div>

      {/* Zoom / scroll controls */}
      <div
        className="absolute z-20 flex items-center gap-px transition-all duration-150"
        style={{
          bottom: paneCount * PANE_H + 50,
          left: "50%",
          transform: "translateX(-50%)",
          opacity: hovered ? 1 : 0,
          pointerEvents: hovered ? "auto" : "none",
        }}
      >
        {([
          { icon: "−", label: "Zoom out",           fn: zoomOut    },
          { icon: "+", label: "Zoom in",             fn: zoomIn     },
          { icon: "‹", label: "Scroll left",         fn: scrollLeft  },
          { icon: "›", label: "Scroll right",        fn: scrollRight },
        ] as { icon: string; label: string; fn: () => void }[]).map(({ icon, label, fn }) => (
          <button
            key={label}
            title={label}
            onClick={fn}
            className="group relative flex items-center justify-center select-none"
            style={{
              width: 28, height: 28,
              background: "rgba(11,18,32,0.88)",
              border: "1px solid rgba(255,255,255,0.20)",
              borderRadius: 4,
              color: "#94a3b8",
              fontSize: 17,
              fontWeight: 600,
              lineHeight: 1,
              cursor: "pointer",
              backdropFilter: "blur(6px)",
              transition: "background 0.1s, color 0.1s, border-color 0.1s",
            }}
            onMouseEnter={e => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background  = "rgba(255,255,255,0.12)";
              b.style.color       = "#ffffff";
              b.style.borderColor = "rgba(59,130,246,0.5)";
            }}
            onMouseLeave={e => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background  = "rgba(11,18,32,0.88)";
              b.style.color       = "#94a3b8";
              b.style.borderColor = "rgba(255,255,255,0.20)";
            }}
          >
            {icon}
            <span
              className="pointer-events-none absolute bottom-full mb-1.5 left-1/2 whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                transform: "translateX(-50%)",
                background: "rgba(11,18,32,0.95)",
                border: "1px solid rgba(255,255,255,0.15)",
                color: "#cbd5e1",
                zIndex: 30,
              }}
            >
              {label}
            </span>
          </button>
        ))}
      </div>

      {/* Sub-panes */}
      {showRSI && (
        <div className="relative shrink-0" style={{ height: PANE_H, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <SubPaneLabel label="RSI 14" />
          <div ref={rsiRef} className="w-full h-full" />
        </div>
      )}
      {showMACD && (
        <div className="relative shrink-0" style={{ height: PANE_H, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <SubPaneLabel label="MACD 12,26,9" />
          <div ref={macdRef} className="w-full h-full" />
        </div>
      )}
      {showStoch && (
        <div className="relative shrink-0" style={{ height: PANE_H, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <SubPaneLabel label="Stoch %K/%D" />
          <div ref={stochRef} className="w-full h-full" />
        </div>
      )}
    </div>
  );
});
