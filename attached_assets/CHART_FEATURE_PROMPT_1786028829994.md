# AI Build Prompt — TradingView-style Token Chart (DexGems ChartCanvas)

Copy everything below the line into the Agent chat of your **other** Replit project to recreate the same candlestick/line chart with indicators, sub-panes, live updates, zoom controls, and a DexScreener-style toolbar that DexGems uses on its token detail page.

Adapt the two "ADAPT THIS" call-outs to your project's actual API/data source before pasting bars in — everything else can be used almost verbatim.

---

## PROMPT TO PASTE

Build a professional trading chart component for a token/asset detail page, matching this exact spec (React + TypeScript + Vite, Tailwind for layout, `lightweight-charts` v5 for rendering).

### 1. Dependencies

```bash
npm install lightweight-charts@^5.2.0 @tanstack/react-query@^5
```

### 2. Data contract

```ts
// types/token.ts
export interface OHLCVBar {
  time:   number; // unix seconds, one entry per candle bucket
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}
```

**ADAPT THIS** — your backend/API must expose an endpoint that returns `{ bars: OHLCVBar[] }` for a given `(chain/asset id, timeframe, countback)`. Timeframes supported: `1m 5m 15m 1H 4H 1D 1W`. If you don't have all buckets, at minimum support `5m`/`1H`/`1D`.

### 3. Data-fetching hook (React Query)

```ts
// hooks/useTokenChart.ts
import { useQuery } from "@tanstack/react-query";
import { fetchChart } from "@/lib/api"; // ADAPT THIS to your API client

const TF_COUNTBACK: Record<string, number> = {
  "1m": 200, "5m": 200, "15m": 200,
  "1H": 168,   // 1 week of hourly bars
  "4H": 180,   // 30 days of 4H bars
  "1D": 180,   // 6 months of daily bars
  "1W": 52,    // 1 year of weekly bars
};

const TF_REFETCH: Record<string, number> = {
  "1m": 15_000, "5m": 30_000, "15m": 30_000,
  "1H": 60_000, "4H": 120_000, "1D": 300_000, "1W": 600_000,
};

export function useTokenChart(chain: string, address: string, type = "5m") {
  const countback = TF_COUNTBACK[type] ?? 200;
  const refetch    = TF_REFETCH[type]  ?? 30_000;
  return useQuery({
    queryKey:        ["token-chart", chain, address, type],
    queryFn:         () => fetchChart(chain, address, type, countback),
    refetchInterval: refetch,
    staleTime:       refetch - 5_000,
    enabled:         !!chain && !!address,
  });
}
```

Client fetch + a defensive spike filter (drops bars whose high/low is a >50x outlier vs the median close — protects against a single corrupt/stale bar wrecking the chart's Y-axis scale):

```ts
// lib/api.ts
function _filterSpikeBars(bars: OHLCVBar[]): OHLCVBar[] {
  if (bars.length < 3) return bars;
  const sorted = [...bars.map(b => b.close)].filter(c => c > 0).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median <= 0) return bars;
  const MAX = 50;
  return bars.filter(b =>
    b.close > 0 && b.high <= median * MAX && b.low >= median / MAX,
  );
}

export async function fetchChart(chain: string, address: string, type = "5m", countback = 200): Promise<{ bars: OHLCVBar[] }> {
  const result: { bars: OHLCVBar[] } = await get(`/api/token/${chain}/${address}/chart?type=${type}&countback=${countback}`);
  return { ...result, bars: _filterSpikeBars(result.bars ?? []) };
}
```

### 4. The chart component itself

Create `components/chart/ChartCanvas.tsx` with **exactly** this implementation (lightweight-charts v5 API — note `chart.addSeries(SeriesTypeConstructor, options)`, not the v4 `chart.addCandlestickSeries()` style):

```tsx
/**
 * ChartCanvas — lightweight-charts v5
 * Main chart: candlestick + volume (or area line)
 * Overlay indicators: MA20/50/200, EMA9/21, BB, VWAP, PSAR
 * Sub-pane indicators: RSI, MACD, STOCH (separate synced chart instances)
 */
import { useEffect, useLayoutEffect, useRef, useState, useCallback, memo } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesOptions,
  type HistogramSeriesOptions,
  type LineSeriesOptions,
  type AreaSeriesOptions,
} from "lightweight-charts";
import type { OHLCVBar } from "@/types/token";

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
  bars:           OHLCVBar[];
  address?:       string;
  loading?:       boolean;
  chartType?:     ChartType;
  indicators?:    Indicator[];
  priceFormatter?: (price: number) => string;
  /** Called whenever the crosshair moves to a bar; null = crosshair left the chart */
  onCrosshairMove?: (bar: OHLCSnapshot | null) => void;
}

/* ── Constants ─────────────────────────────────────────────────────── */
const UP   = "#089981";
const DOWN = "#f23645";
const BG   = "#121212";   // matches page background — ColorType.Solid doesn't support "transparent"

const IND_COLOR: Record<string, string> = {
  MA20: "#fbbf24", MA50: "#fb923c", MA200: "#a78bfa",
  EMA9: "#22d3ee", EMA21: "#60a5fa",
  BB_UPPER: "#aaaaaa", BB_MIDDLE: "#999999", BB_LOWER: "#aaaaaa",
  VWAP: "#f472b6",
};

const PANE_H = 90; // px per sub-pane
const PRICE_SCALE_W = 58; // approx px taken by right price scale
const MIN_BAR_PX = 7;     // minimum pixels per candle for readability

/** How many bars to show based on container width */
function calcVisibleBars(containerWidth: number): number {
  const effective = Math.max(containerWidth - PRICE_SCALE_W, 120);
  return Math.max(20, Math.min(80, Math.floor(effective / MIN_BAR_PX)));
}

/* ── Math helpers ──────────────────────────────────────────────────── */
function smaArr(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += closes[j];
    return s / period;
  });
}

function emaArr(closes: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let val = 0;
  for (let i = 0; i < period; i++) val += closes[i];
  val /= period;
  out[period - 1] = val;
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
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
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].close;
    const mean = sum / period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) varSum += (bars[j].close - mean) ** 2;
    const std = Math.sqrt(varSum / period);
    const t = bars[i].time;
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
  let sar = bars[0].low;
  let ep = bars[0].high;
  let af = step;

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur  = bars[i];
    sar = sar + af * (ep - sar);

    if (bull) {
      if (cur.low < sar) {
        bull = false; sar = ep; ep = cur.low; af = step;
      } else {
        if (cur.high > ep) { ep = cur.high; af = Math.min(af + step, max); }
        sar = Math.min(sar, prev.low, i >= 2 ? bars[i - 2].low : prev.low);
      }
    } else {
      if (cur.high > sar) {
        bull = true; sar = ep; ep = cur.high; af = step;
      } else {
        if (cur.low < ep) { ep = cur.low; af = Math.min(af + step, max); }
        sar = Math.max(sar, prev.high, i >= 2 ? bars[i - 2].high : prev.high);
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
    const diff = bars[i].close - bars[i - 1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  pts.push({ time: bars[period].time, value: 100 - 100 / (1 + rs0) });

  for (let i = period + 1; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    pts.push({ time: bars[i].time, value: 100 - 100 / (1 + rs) });
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
    for (let i = 0; i < signal; i++) val += macdValid[i].v!;
    val /= signal;
    signalLine[macdValid[signal - 1].i] = val;
    for (let i = signal; i < macdValid.length; i++) {
      val = macdValid[i].v! * k + val * (1 - k);
      signalLine[macdValid[i].i] = val;
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
    const k = high === low ? 50 : ((bars[i].close - low) / (high - low)) * 100;
    kPts.push({ time: bars[i].time, value: k });
  }
  const kVals = kPts.map(p => p.value);
  const dPts: { time: number; value: number }[] = [];
  for (let i = dPeriod - 1; i < kPts.length; i++) {
    let sum = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) sum += kVals[j];
    dPts.push({ time: kPts[i].time, value: sum / dPeriod });
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
    layout: { background: { type: ColorType.Solid, color: BG }, textColor: "#cbd5e1", fontSize: 11, fontFamily: "'Trebuchet MS', sans-serif" },
    grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
    crosshair: {
      vertLine: { color: "rgba(0,255,136,0.25)", width: 1, style: 3 },
      horzLine: { color: "rgba(0,255,136,0.25)", width: 1, style: 3 },
    },
    rightPriceScale: { borderColor: "rgba(255,255,255,0.15)", minimumWidth: 48, visible: opts.rightScale ?? true },
    leftPriceScale:  { visible: false },
    timeScale: { borderColor: "rgba(255,255,255,0.15)", timeVisible: opts.timeVisible ?? false, secondsVisible: false },
    localization: opts.priceFormatter ? { priceFormatter: opts.priceFormatter } : {},
    handleScroll: true, handleScale: true,
    width: el.clientWidth, height: el.clientHeight,
  });
}

/* ── Sub-pane label overlay ────────────────────────────────────────── */
function SubPaneLabel({ label }: { label: string }) {
  return (
    <div className="absolute top-1 left-2 z-10 pointer-events-none"
      style={{ fontSize: 9, fontWeight: 600, color: "#334155", letterSpacing: "0.05em" }}>
      {label}
    </div>
  );
}

/* ── No-data overlay (TradingView-style) ────────────────────────── */
function ChartNoData({ visible }: { visible: boolean }) {
  return (
    <div
      className="absolute inset-0 z-10 pointer-events-none"
      style={{
        background: BG,
        opacity: visible ? 1 : 0,
        transition: "opacity 0.3s ease-out",
        backgroundImage: [
          "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)",
          "linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
        ].join(", "),
        backgroundSize: "60px 48px",
      }}
    >
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        gap: 10,
      }}>
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
        <span style={{
          fontSize: 13, fontWeight: 500,
          color: "rgba(255,255,255,0.32)",
          fontFamily: "'Inter', sans-serif",
          letterSpacing: "0.01em",
        }}>
          No chart data
        </span>
      </div>
    </div>
  );
}

/* ── Chart loading state ─────────────────────────────────────────── */
function ChartSkeleton({ visible }: { visible: boolean }) {
  return (
    <div
      className="absolute inset-0 z-10"
      style={{
        background: BG,
        opacity: visible ? 1 : 0,
        transition: "opacity 0.4s ease-out",
        pointerEvents: visible ? "all" : "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
      }}
    >
      <svg
        width="36" height="36" viewBox="0 0 36 36"
        style={{ animation: "chartSpinnerRotate 0.9s linear infinite", flexShrink: 0 }}
      >
        <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
        <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="3"
          strokeLinecap="round" strokeDasharray="30 65" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,0.85)", fontFamily: "'Inter', sans-serif", letterSpacing: "-0.01em" }}>
          Loading Data
        </span>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", fontFamily: "'Inter', sans-serif" }}>
          Please wait, we are loading chart data
        </span>
      </div>
    </div>
  );
}
/* NOTE: add this keyframes rule once, globally (e.g. in index.css):
@keyframes chartSpinnerRotate { to { transform: rotate(360deg); } }
*/

/* ── Main component ────────────────────────────────────────────────── */
export const ChartCanvas = memo(function ChartCanvas({
  bars, address, loading, chartType = "candle", indicators = [], priceFormatter, onCrosshairMove,
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
    if (!psarDnRef.current) psarDnRef.current = makePsarSeries("#00ff88");
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

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;

    const chart = makeChart(el, { timeVisible: true, rightScale: true, priceFormatter });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.10, bottom: 0.22 } });

    if (chartType === "candle") {
      candleRef.current = chart.addSeries(CandlestickSeries as unknown as typeof CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
      } as Partial<CandlestickSeriesOptions>);
      volRef.current = chart.addSeries(HistogramSeries as unknown as typeof HistogramSeries, {
        color: "rgba(8,153,129,0.5)", priceFormat: { type: "volume" }, priceScaleId: "vol",
        lastValueVisible: false, priceLineVisible: false,
      } as Partial<HistogramSeriesOptions>);
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    } else {
      lineRef.current = chart.addSeries(AreaSeries as unknown as typeof AreaSeries, {
        lineColor: UP, topColor: "rgba(0,255,136,0.18)", bottomColor: "rgba(0,255,136,0.0)", lineWidth: 2,
        priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
      } as Partial<AreaSeriesOptions>);
      chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.10, bottom: 0.08 } });
    }

    chartRef.current = chart;
    indSeriesRef.current.clear();
    psarUpRef.current = null;
    psarDnRef.current = null;

    chart.subscribeCrosshairMove(param => {
      const cb = onCrosshairMoveRef.current;
      if (!cb) return;
      if (!param.time) { cb(null); return; }
      if (candleRef.current) {
        const cd = param.seriesData.get(candleRef.current as never) as { open: number; high: number; low: number; close: number } | undefined;
        if (cd) {
          let vol: number | undefined;
          if (volRef.current) {
            const vd = param.seriesData.get(volRef.current as never) as { value: number } | undefined;
            if (vd) vol = vd.value;
          }
          cb({ open: cd.open, high: cd.high, low: cd.low, close: cd.close, volume: vol });
          return;
        }
      }
      if (lineRef.current) {
        const ld = param.seriesData.get(lineRef.current as never) as { value: number } | undefined;
        if (ld) cb({ open: ld.value, high: ld.value, low: ld.value, close: ld.value });
      }
    });

    const ro = new ResizeObserver(() => {
      if (!el) return;
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      const li = lastBarIdxRef.current;
      if (li >= 0) {
        const bars = calcVisibleBars(el.clientWidth);
        requestAnimationFrame(() => {
          chartRef.current?.timeScale().setVisibleLogicalRange({ from: li - bars + 1, to: li + 3 });
        });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      candleRef.current = lineRef.current = volRef.current = psarUpRef.current = psarDnRef.current = null;
      indSeriesRef.current.clear();
    };
  }, [chartType]);

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
      } catch { /* ignore if chart not ready */ }

      requestAnimationFrame(() => {
        const c = chartRef.current;
        const e = mainRef.current;
        if (!c || !e) return;
        const w2 = e.clientWidth || e.offsetWidth || window.innerWidth || 400;
        const vb2 = calcVisibleBars(w2);
        try { c.timeScale().setVisibleLogicalRange({ from: lastIdx - vb2 + 1, to: lastIdx + 3 }); } catch { /* ignore */ }
      });

      clearTimeout(loadTimeoutRef.current);
      requestAnimationFrame(() => readyAfterMin());

      lastBarRef.current = clean[clean.length - 1];
      if (clean.length >= 2) {
        barBucketSecRef.current = (clean[1]!.time - clean[0]!.time) || 60;
      }
    } catch (err) { console.warn("[ChartCanvas] setData:", err); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, chartType]);

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

  useEffect(() => {
    const el = rsiRef.current;
    if (!showRSI || !el) {
      if (rsiChart.current) { rsiChart.current.remove(); rsiChart.current = null; }
      return;
    }
    makeSubChart(el, rsiChart, chartRef.current);
    const chart = rsiChart.current!;

    const ob = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
      color: "rgba(248,113,113,0.3)", lineWidth: 1, lineStyle: LineStyle.Dashed,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    } as Partial<LineSeriesOptions>);
    const os = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
      color: "rgba(0,255,136,0.3)", lineWidth: 1, lineStyle: LineStyle.Dashed,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    } as Partial<LineSeriesOptions>);
    const rsiLine = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
      color: "#c084fc", lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      lastValueVisible: true, priceLineVisible: false,
    } as Partial<LineSeriesOptions>);

    const clean = cleanBars(bars);
    if (clean.length) {
      const pts = rsi(clean, 14);
      rsiLine.setData(pts.map(p => ({ time: p.time as never, value: p.value })));
      if (pts.length) {
        const times = [pts[0].time, pts[pts.length - 1].time] as never[];
        ob.setData([{ time: times[0], value: 70 }, { time: times[1], value: 70 }]);
        os.setData([{ time: times[0], value: 30 }, { time: times[1], value: 30 }]);
      }
    }
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: 48 });

    return () => { if (rsiChart.current) { rsiChart.current.remove(); rsiChart.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRSI, bars]);

  useEffect(() => {
    const el = macdRef.current;
    if (!showMACD || !el) {
      if (macdChart.current) { macdChart.current.remove(); macdChart.current = null; }
      return;
    }
    makeSubChart(el, macdChart, chartRef.current);
    const chart = macdChart.current!;

    const macdLine = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
      color: "#60a5fa", lineWidth: 1,
      priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
      lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
    } as Partial<LineSeriesOptions>);
    const sigLine = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
      color: "#f472b6", lineWidth: 1,
      priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
      lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
    } as Partial<LineSeriesOptions>);
    const hist = chart.addSeries(HistogramSeries as unknown as typeof HistogramSeries, {
      priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
      priceScaleId: "right",
    } as Partial<HistogramSeriesOptions>);

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

  useEffect(() => {
    const el = stochRef.current;
    if (!showStoch || !el) {
      if (stochChart.current) { stochChart.current.remove(); stochChart.current = null; }
      return;
    }
    makeSubChart(el, stochChart, chartRef.current);
    const chart = stochChart.current!;

    const kLine = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
      color: "#22d3ee", lineWidth: 1,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      lastValueVisible: true, priceLineVisible: false,
    } as Partial<LineSeriesOptions>);
    const dLine = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
      color: "#fb923c", lineWidth: 1,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
    } as Partial<LineSeriesOptions>);
    const ob = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
      color: "rgba(248,113,113,0.25)", lineWidth: 1, lineStyle: LineStyle.Dashed,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    } as Partial<LineSeriesOptions>);
    const os = chart.addSeries(LineSeries as unknown as typeof LineSeries, {
      color: "rgba(0,255,136,0.25)", lineWidth: 1, lineStyle: LineStyle.Dashed,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    } as Partial<LineSeriesOptions>);

    const clean = cleanBars(bars);
    if (clean.length) {
      const { kPts, dPts } = stoch(clean);
      kLine.setData(kPts.map(p => ({ time: p.time as never, value: p.value })));
      dLine.setData(dPts.map(p => ({ time: p.time as never, value: p.value })));
      if (kPts.length) {
        const t0 = kPts[0].time as never, t1 = kPts[kPts.length - 1].time as never;
        ob.setData([{ time: t0, value: 80 }, { time: t1, value: 80 }]);
        os.setData([{ time: t0, value: 20 }, { time: t1, value: 20 }]);
      }
    }
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: 48 });

    return () => { if (stochChart.current) { stochChart.current.remove(); stochChart.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStoch, bars]);

  /* ── Live price update ──────────────────────────────────────────── */
  /* ADAPT THIS: fires whenever your app receives a fresh live price
     (WebSocket, polling, whatever). Dispatch:
       window.dispatchEvent(new CustomEvent("app:price", { detail: { address, price } }))
     from your live-price hook — the chart listens for exactly this event
     and self-updates the last candle without a full re-fetch. */
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
        const newBar: OHLCVBar = {
          time:   nowBucket,
          open:   last.close,
          high:   Math.max(last.close, price),
          low:    Math.min(last.close, price),
          close:  price,
          volume: 0,
        };
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
    window.addEventListener("app:price", onPrice); // ADAPT event name to match your dispatcher
    return () => window.removeEventListener("app:price", onPrice);
  }, [address, chartType]);

  const paneCount = [showRSI, showMACD, showStoch].filter(Boolean).length;

  const [chartReady, setChartReady]       = useState(false);
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

  const [hovered, setHovered] = useState(false);

  const zoomIn = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const mid  = (range.from + range.to) / 2;
    const half = (range.to - range.from) / 2;
    const next = half * 0.75;
    ts.setVisibleLogicalRange({ from: mid - next, to: mid + next });
  }, []);

  const zoomOut = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const mid  = (range.from + range.to) / 2;
    const half = (range.to - range.from) / 2;
    const next = half * 1.35;
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

  return (
    <div
      className="relative w-full h-full flex flex-col"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <ChartSkeleton visible={!chartReady} />
      <ChartNoData visible={chartReady && !bars.length} />
      <div ref={mainRef} style={{ flex: 1, minHeight: 0 }} />

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
          { icon: "−", label: "Zoom out",          fn: zoomOut      },
          { icon: "+", label: "Zoom in",            fn: zoomIn       },
          { icon: "‹", label: "Scroll to the left", fn: scrollLeft   },
          { icon: "›", label: "Scroll to the right",fn: scrollRight  },
        ] as { icon: string; label: string; fn: () => void }[]).map(({ icon, label, fn }) => (
          <button
            key={label}
            title={label}
            onClick={fn}
            className="group relative flex items-center justify-center select-none"
            style={{
              width: 28, height: 28,
              background: "rgba(13,20,35,0.88)",
              border: "1px solid rgba(255,255,255,0.30)",
              borderRadius: 4,
              color: "#aaaaaa",
              fontSize: 17,
              fontWeight: 600,
              lineHeight: 1,
              cursor: "pointer",
              backdropFilter: "blur(6px)",
              transition: "background 0.1s, color 0.1s, border-color 0.1s",
            }}
            onMouseEnter={e => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background    = "rgba(255,255,255,0.20)";
              b.style.color         = "#ffffff";
              b.style.borderColor   = "rgba(0,255,136,0.45)";
            }}
            onMouseLeave={e => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background    = "rgba(13,20,35,0.88)";
              b.style.color         = "#aaaaaa";
              b.style.borderColor   = "rgba(255,255,255,0.30)";
            }}
          >
            {icon}
            <span
              className="pointer-events-none absolute bottom-full mb-1.5 left-1/2 whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                transform: "translateX(-50%)",
                background: "rgba(13,20,35,0.95)",
                border: "1px solid rgba(255,255,255,0.22)",
                color: "#cbd5e1",
                zIndex: 30,
              }}
            >
              {label}
            </span>
          </button>
        ))}
      </div>

      {showRSI && (
        <div className="relative shrink-0" style={{ height: PANE_H, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
          <SubPaneLabel label="RSI 14" />
          <div ref={rsiRef} className="w-full h-full" />
        </div>
      )}

      {showMACD && (
        <div className="relative shrink-0" style={{ height: PANE_H, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
          <SubPaneLabel label="MACD 12,26,9" />
          <div ref={macdRef} className="w-full h-full" />
        </div>
      )}

      {showStoch && (
        <div className="relative shrink-0" style={{ height: PANE_H, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
          <SubPaneLabel label="Stoch %K/%D" />
          <div ref={stochRef} className="w-full h-full" />
        </div>
      )}
    </div>
  );
});
```

### 5. Toolbar to mount above the chart

Render this directly above `<ChartCanvas />`, wired to local state `tf` (timeframe), `ct` (chart type), `indicators`, `chartMode`:

```tsx
type ChartType  = "candle" | "line";
type Timeframe  = "1m" | "5m" | "15m" | "1H" | "4H" | "1D" | "1W";
const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1H", "4H", "1D", "1W"];

// state in the parent page:
const [tf, setTf]               = useState<Timeframe>("15m");
const [ct, setCt]               = useState<ChartType>("candle");
const [chartMode, setChartMode] = useState<"price" | "mcap">("price");
const [indicators, setIndicators] = useState<Indicator[]>([]);
const [indOpen, setIndOpen]     = useState(false);

function toggleIndicator(ind: Indicator) {
  setIndicators(prev => prev.includes(ind) ? prev.filter(i => i !== ind) : [...prev, ind]);
}
```

Toolbar row (dark theme, pill-shaped active timeframe, sits directly above a fixed-height chart container — `h-[260px]` on mobile, `h-[480px]` on desktop):

```tsx
<div className="pt-2.5 pb-0 shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
  <div className="flex items-stretch overflow-x-auto" style={{ background: "#1a1a1a", scrollbarWidth: "none" }}>
    {/* Price / Mkt Cap toggle */}
    <div className="hidden md:flex items-stretch shrink-0" style={{ borderRight: "1px solid rgba(255,255,255,0.1)" }}>
      {(["price", "mcap"] as const).map((m, i, arr) => (
        <button key={m} onClick={() => setChartMode(m)}
          className="px-3 text-[11px] font-semibold transition-all whitespace-nowrap flex items-center"
          style={{ height: 36, background: chartMode === m ? "rgba(255,255,255,0.09)" : "transparent",
            color: chartMode === m ? "#fff" : "#aaa",
            borderRight: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
          {m === "price" ? "Price" : "Mkt Cap"}
        </button>
      ))}
    </div>

    {/* Candle / Line toggle */}
    <div className="hidden md:flex items-stretch shrink-0" style={{ borderRight: "1px solid rgba(255,255,255,0.1)" }}>
      {(["candle", "line"] as ChartType[]).map((type, i, arr) => (
        <button key={type} onClick={() => setCt(type)}
          className="px-2.5 flex items-center gap-1.5 text-[11px] font-medium transition-all"
          style={{ height: 36, background: ct === type ? "rgba(255,255,255,0.09)" : "transparent",
            color: ct === type ? "#fff" : "#aaa",
            borderRight: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
          {type === "candle" ? "Candle" : "Line"}
        </button>
      ))}
    </div>

    {/* Indicators picker trigger */}
    <button onClick={() => setIndOpen(true)}
      className="hidden md:flex px-3 items-center gap-1.5 text-[11px] font-medium transition-all shrink-0"
      style={{ height: 36, background: indicators.length ? "rgba(255,255,255,0.09)" : "transparent",
        color: indicators.length ? "#fff" : "#aaa", borderRight: "1px solid rgba(255,255,255,0.1)" }}>
      Indicators
      {indicators.length > 0 && (
        <span className="h-4 w-4 rounded-full text-[9px] font-bold flex items-center justify-center"
          style={{ background: "#00ff88", color: "#052e16" }}>{indicators.length}</span>
      )}
    </button>

    {/* Timeframe pill group — pushed right */}
    <div className="flex items-center ml-auto shrink-0 px-1" style={{ borderLeft: "1px solid rgba(255,255,255,0.1)" }}>
      <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 24, padding: 3, display: "flex", gap: 2 }}>
        {TIMEFRAMES.map(t => (
          <button key={t} onClick={() => setTf(t)}
            className="px-3 text-[12px] font-semibold transition-all shrink-0 whitespace-nowrap flex items-center"
            style={{ height: 30, ...(tf === t
              ? { background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 20, color: "#fff" }
              : { borderRadius: 20, border: "1px solid transparent", color: "#aaa" }) }}>
            {t}
          </button>
        ))}
      </div>
    </div>
  </div>

  {/* Fixed-height canvas container */}
  <div className="relative h-[260px] md:h-[480px]">
    <ChartCanvas
      bars={chartData?.bars ?? []}
      address={address}
      loading={chartLoad}
      chartType={ct}
      indicators={indicators}
      onCrosshairMove={setHoveredOHLC}
    />
  </div>
</div>
```

Add an indicator picker modal/sheet (checkbox list toggling `MA20 MA50 MA200 EMA9 EMA21 BB VWAP PSAR RSI MACD STOCH` via `toggleIndicator`) — any simple modal component works, this part isn't chart-specific.

### 6. Wiring it up in the page

```tsx
const { data: chartData, isLoading: chartLoad } = useTokenChart(chain, address, tf);
const [hoveredOHLC, setHoveredOHLC] = useState<OHLCSnapshot | null>(null);
```

### Key behavioral details to preserve (these are the parts that are easy to get subtly wrong)

1. **v5 API, not v4.** `chart.addSeries(CandlestickSeries, opts)` — series-type objects imported from `lightweight-charts`, not `chart.addCandlestickSeries(opts)`.
2. **Background must be a solid color**, not `"transparent"` — `ColorType.Solid` doesn't support it and the chart silently renders wrong.
3. **Adaptive visible-bar count** based on container width (`calcVisibleBars`) keeps candles readable instead of squished on narrow screens.
4. **Duplicate-timestamp guard + non-finite filter** (`cleanBars`) — upstream OHLCV data (especially from third-party/DEX aggregators) can return duplicate or NaN bars; lightweight-charts v5 throws a hard assertion error on duplicate timestamps if you don't dedupe first.
5. **Live-tick candle extension**: don't refetch the whole chart on every price tick. Track the last bar and its bucket size in refs; on a new price event, either extend the current bar's high/low/close (`update()`) or open a fresh bar when the wall-clock crosses into a new time bucket. This is what makes the current candle "breathe" in real time between polls.
6. **Minimum skeleton display time** (800ms) prevents a jarring flash when data resolves instantly from cache.
7. **Sub-panes (RSI/MACD/STOCH) are separate chart instances** synced to the main chart's time scale via `subscribeVisibleLogicalRangeChange` in both directions — not drawn on the main chart's price scale.
8. Indicator overlay series are added/removed incrementally (diffed against the previous `indicators` array) rather than recreating the whole chart on every toggle.

---

## Notes for the person pasting this prompt

- Swap the `app:price` custom event for whatever real-time price signal your other project already has (WebSocket message, polling result, etc.) — just dispatch it on `window` with `{ address, price }` in `detail`.
- The backend just needs to serve OHLCV bars per timeframe; how you source them (on-chain indexer, third-party API, your own DB) doesn't matter to this component.
- This chart assumes a dark UI (`#121212` background). Recolor `UP`/`DOWN`/`BG`/`IND_COLOR` constants to match a light theme if needed.
