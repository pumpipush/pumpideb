/**
 * Candlestick chart using TradingView lightweight-charts v5.
 * Parent must supply a height via a wrapper div (e.g. h-[280px]).
 * v5 API: chart.addSeries(CandlestickSeries, options)
 */
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  IChartApi,
  ISeriesApi,
  CandlestickData,
} from "lightweight-charts";
import { cn } from "@/lib/utils";
import { Timeframe } from "@/lib/ohlcv";

interface TradingViewChartProps {
  candles: CandlestickData[];
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  loading?: boolean;
  live?: boolean;
  symbol?: string;
}

const TIMEFRAMES: Timeframe[] = ["15m", "1h", "6h", "24h"];
const UP   = "#22C55E";
const DOWN = "#EF4444";

/** Format price for toolbar readably */
function fmtPrice(n: number): string {
  if (!n || n <= 0) return "—";
  if (n < 0.000001)  return n.toExponential(3);
  if (n < 0.00001)   return n.toFixed(8);
  if (n < 0.0001)    return n.toFixed(7);
  if (n < 0.001)     return n.toFixed(6);
  if (n < 1)         return n.toFixed(5);
  return n.toFixed(4);
}

const TOOLBAR_H = 32; // px — matches h-8

export function TradingViewChart({
  candles,
  timeframe,
  onTimeframeChange,
  loading = false,
  live = false,
  symbol,
}: TradingViewChartProps) {
  const wrapperRef    = useRef<HTMLDivElement>(null);
  const chartAreaRef  = useRef<HTMLDivElement>(null);   // absolute-fill div for lw-charts
  const chartRef      = useRef<IChartApi | null>(null);
  const seriesRef     = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const rafRef        = useRef<number>(0);
  const [hoverClose, setHoverClose] = useState<number | null>(null);

  /* ── init chart — deferred one rAF so layout is settled ── */
  useEffect(() => {
    let ro: ResizeObserver | null = null;

    rafRef.current = requestAnimationFrame(() => {
      const wrapper = wrapperRef.current;
      const el      = chartAreaRef.current;
      if (!wrapper || !el) return;

      // Measure dimensions after layout
      const w = Math.max(wrapper.clientWidth  || 400, 80);
      const h = Math.max(wrapper.clientHeight || 280, 80) - TOOLBAR_H;

      const chart = createChart(el, {
        layout: {
          background:  { type: ColorType.Solid, color: "#0B1220" },
          textColor:   "#64748b",
          fontFamily:  "'Inter', 'Plus Jakarta Sans', sans-serif",
          fontSize:    10,
        },
        grid: {
          vertLines: { color: "#1a2540", style: 1 },
          horzLines: { color: "#1a2540", style: 1 },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "#3B82F6", width: 1, labelBackgroundColor: "#1e2d45" },
          horzLine: { color: "#3B82F6", width: 1, labelBackgroundColor: "#1e2d45" },
        },
        rightPriceScale: {
          borderColor:  "#1e2d45",
          textColor:    "#64748b",
          scaleMargins: { top: 0.08, bottom: 0.08 },
        },
        timeScale: {
          borderColor:    "#1e2d45",
          timeVisible:    true,
          secondsVisible: false,
          fixLeftEdge:    true,
          fixRightEdge:   true,
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
        handleScale:  { mouseWheel: true, pinch: true },
        width:  w,
        height: h,
      });

      const series = chart.addSeries(CandlestickSeries, {
        upColor:         UP,
        downColor:       DOWN,
        borderUpColor:   UP,
        borderDownColor: DOWN,
        wickUpColor:     "#16a34a",
        wickDownColor:   "#dc2626",
      });

      chart.subscribeCrosshairMove((param) => {
        const d = param.seriesData.get(series) as CandlestickData | undefined;
        setHoverClose(d ? d.close : null);
      });

      chartRef.current  = chart;
      seriesRef.current = series;

      ro = new ResizeObserver(() => {
        const wEl = wrapperRef.current;
        if (!wEl) return;
        const newW = Math.max(wEl.clientWidth || 400, 80);
        const newH = Math.max(wEl.clientHeight || 280, 80) - TOOLBAR_H;
        chart.applyOptions({ width: newW, height: newH });
      });
      ro.observe(wrapper);
    });

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro?.disconnect();
      chartRef.current?.remove();
      chartRef.current  = null;
      seriesRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── update candles whenever data changes ── */
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current || !candles.length) return;
    seriesRef.current.setData(candles);
    chartRef.current.timeScale().fitContent();
  }, [candles]);

  const last   = candles[candles.length - 1];
  const isUp   = last ? last.close >= last.open : true;
  const price  = hoverClose ?? (last ? last.close : null);

  return (
    <div ref={wrapperRef} className="relative w-full h-full bg-[#0B1220] border border-border/30 rounded-sm overflow-hidden flex flex-col">
      {/* ── Toolbar ── */}
      <div
        className="shrink-0 flex items-center px-2.5 gap-1 border-b border-border/20 bg-[#0B1220]"
        style={{ height: TOOLBAR_H }}
      >
        <div className="flex items-center gap-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              className={cn(
                "text-[11px] font-semibold px-2 py-0.5 rounded transition-colors",
                tf === timeframe
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
              onClick={() => onTimeframeChange(tf)}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto overflow-hidden">
          {price !== null && (
            <span className={cn(
              "text-[11px] font-mono font-bold shrink-0",
              isUp ? "text-[#22C55E]" : "text-destructive"
            )}>
              {fmtPrice(price)}
            </span>
          )}
          {symbol && (
            <span className="text-[10px] font-mono text-muted-foreground/60 truncate hidden sm:block">
              {symbol}/ETH
            </span>
          )}
          {live && (
            <span className="relative inline-flex items-center gap-1 text-[10px] font-bold text-primary shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-ping absolute" />
              <span className="w-1.5 h-1.5 rounded-full bg-primary relative" />
              <span className="ml-2">LIVE</span>
            </span>
          )}
          {!live && loading && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-pulse" />
              connecting…
            </span>
          )}
        </div>
      </div>

      {/* Chart area — absolutely fills remaining space below toolbar */}
      <div
        ref={chartAreaRef}
        className="absolute left-0 right-0 bottom-0"
        style={{ top: TOOLBAR_H }}
      >
        {candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground/40 font-mono pointer-events-none select-none z-10">
            {loading ? "Connecting…" : "No trade data yet"}
          </div>
        )}
      </div>
    </div>
  );
}
