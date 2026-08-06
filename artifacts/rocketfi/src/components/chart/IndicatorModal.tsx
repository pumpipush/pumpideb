import { useState, useRef, useEffect } from "react";
import type { Indicator } from "./ChartCanvas";

interface IndicatorModalProps {
  open:     boolean;
  onClose:  () => void;
  active:   Indicator[];
  onToggle: (ind: Indicator) => void;
}

interface IndicatorDef {
  id:          Indicator;
  name:        string;
  shortLabel:  string;
  group:       string;
  color:       string;
  description: string;
}

const ALL_INDICATORS: IndicatorDef[] = [
  // Moving Averages
  { id: "MA20",  name: "Moving Average 20",       shortLabel: "MA 20",        group: "Moving Averages", color: "#fbbf24", description: "Simple moving average over 20 bars" },
  { id: "MA50",  name: "Moving Average 50",       shortLabel: "MA 50",        group: "Moving Averages", color: "#fb923c", description: "Simple moving average over 50 bars" },
  { id: "MA200", name: "Moving Average 200",      shortLabel: "MA 200",       group: "Moving Averages", color: "#a78bfa", description: "Simple moving average over 200 bars" },
  { id: "EMA9",  name: "Exponential MA 9",        shortLabel: "EMA 9",        group: "Moving Averages", color: "#22d3ee", description: "Exponential moving average over 9 bars" },
  { id: "EMA21", name: "Exponential MA 21",       shortLabel: "EMA 21",       group: "Moving Averages", color: "#60a5fa", description: "Exponential moving average over 21 bars" },
  // Overlays
  { id: "BB",    name: "Bollinger Bands",         shortLabel: "BB 20",        group: "Overlays",        color: "#94a3b8", description: "Volatility bands ±2σ around SMA 20" },
  { id: "VWAP",  name: "VWAP",                    shortLabel: "VWAP",         group: "Overlays",        color: "#f472b6", description: "Volume Weighted Average Price" },
  { id: "PSAR",  name: "Parabolic SAR",           shortLabel: "PSAR",         group: "Overlays",        color: "#34d399", description: "Parabolic stop-and-reverse dots" },
  // Oscillators
  { id: "RSI",   name: "Relative Strength Index", shortLabel: "RSI 14",       group: "Oscillators",     color: "#c084fc", description: "Momentum oscillator 0–100, 14-period" },
  { id: "MACD",  name: "MACD",                    shortLabel: "MACD 12,26,9", group: "Oscillators",     color: "#60a5fa", description: "Moving Average Convergence Divergence" },
  { id: "STOCH", name: "Stochastic",              shortLabel: "Stoch %K,%D",  group: "Oscillators",     color: "#22d3ee", description: "Stochastic oscillator, 14-period" },
];

const GROUPS = ["Moving Averages", "Overlays", "Oscillators"] as const;

export function IndicatorModal({ open, onClose, active, onToggle }: IndicatorModalProps) {
  const [query,   setQuery]   = useState("");
  const [hovered, setHovered] = useState<Indicator | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => searchRef.current?.focus(), 60);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? ALL_INDICATORS.filter(ind =>
        ind.name.toLowerCase().includes(q) ||
        ind.shortLabel.toLowerCase().includes(q) ||
        ind.group.toLowerCase().includes(q)
      )
    : ALL_INDICATORS;

  const hoveredDef = hovered ? ALL_INDICATORS.find(i => i.id === hovered) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" />

      {/* Panel */}
      <div
        className="relative flex flex-col w-full sm:w-[420px] rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl"
        style={{
          background:   "#111827",
          border:       "1px solid rgba(255,255,255,0.09)",
          maxHeight:    "min(560px, 85vh)",
          boxShadow:    "0 32px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.05)",
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div
          className="flex items-center justify-between px-5 py-4 shrink-0"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}
        >
          <span className="text-[15px] font-semibold text-white tracking-[-0.01em]">
            Indicators
          </span>
          <div className="flex items-center gap-3">
            {active.length > 0 && (
              <button
                onClick={() => active.forEach(i => onToggle(i))}
                className="text-[12px] text-slate-400 hover:text-red-400 transition-colors"
              >
                Clear all
              </button>
            )}
            <button
              onClick={onClose}
              className="flex items-center justify-center w-7 h-7 rounded-full text-slate-400 hover:text-white hover:bg-white/10 transition-all"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* ── Search ── */}
        <div className="px-4 py-3 shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-slate-500">
              <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search indicators…"
              className="flex-1 bg-transparent text-[13px] text-white placeholder-slate-500 outline-none"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-slate-500 hover:text-slate-300 transition-colors">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* ── List ── */}
        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.1) transparent" }}>
          {q ? (
            // Flat list when searching
            filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-slate-500">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" className="opacity-40">
                  <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M18 18l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <span className="text-[13px]">No results for "{query}"</span>
              </div>
            ) : (
              <div className="py-2">
                <ColumnHeader />
                {filtered.map(ind => (
                  <Row
                    key={ind.id}
                    def={ind}
                    isActive={active.includes(ind.id)}
                    isHovered={hovered === ind.id}
                    onToggle={onToggle}
                    onHover={setHovered}
                  />
                ))}
              </div>
            )
          ) : (
            // Grouped list
            <div className="py-2">
              <ColumnHeader />
              {GROUPS.map(group => {
                const items = ALL_INDICATORS.filter(i => i.group === group);
                return (
                  <div key={group}>
                    <div
                      className="px-5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-600 select-none"
                    >
                      {group}
                    </div>
                    {items.map(ind => (
                      <Row
                        key={ind.id}
                        def={ind}
                        isActive={active.includes(ind.id)}
                        isHovered={hovered === ind.id}
                        onToggle={onToggle}
                        onHover={setHovered}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Active count bar ── */}
        {active.length > 0 && (
          <div
            className="shrink-0 flex items-center justify-between px-5 py-2.5"
            style={{ borderTop: "1px solid rgba(255,255,255,0.07)", background: "rgba(0,0,0,0.2)" }}
          >
            <div className="flex items-center gap-2 flex-wrap">
              {active.map(id => {
                const def = ALL_INDICATORS.find(i => i.id === id)!;
                return (
                  <span
                    key={id}
                    className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium"
                    style={{ background: `${def.color}18`, color: def.color, border: `1px solid ${def.color}30` }}
                  >
                    {def.shortLabel}
                    <button
                      onClick={() => onToggle(id)}
                      className="opacity-60 hover:opacity-100 transition-opacity leading-none"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
            <span className="text-[11px] text-slate-500 ml-2 shrink-0">{active.length} active</span>
          </div>
        )}

        {/* ── Description tooltip (hover) ── */}
        {hoveredDef && (
          <div
            className="shrink-0 px-5 py-2.5 text-[12px] text-slate-400"
            style={{ borderTop: "1px solid rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.02)" }}
          >
            <span style={{ color: hoveredDef.color }} className="font-medium mr-1.5">{hoveredDef.shortLabel}</span>
            {hoveredDef.description}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ColumnHeader() {
  return (
    <div className="flex items-center px-5 py-1 mb-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-600 select-none">
        Indicator name
      </span>
    </div>
  );
}

function Row({
  def, isActive, isHovered, onToggle, onHover,
}: {
  def:      IndicatorDef;
  isActive: boolean;
  isHovered:boolean;
  onToggle: (id: Indicator) => void;
  onHover:  (id: Indicator | null) => void;
}) {
  return (
    <div
      className="group flex items-center justify-between px-5 py-2.5 cursor-pointer select-none transition-colors"
      style={{
        background: isHovered
          ? "rgba(255,255,255,0.05)"
          : isActive
          ? "rgba(59,130,246,0.06)"
          : "transparent",
      }}
      onClick={() => onToggle(def.id)}
      onMouseEnter={() => onHover(def.id)}
      onMouseLeave={() => onHover(null)}
    >
      {/* Left: color dot + name */}
      <div className="flex items-center gap-3">
        <span
          className="w-2 h-2 rounded-full shrink-0 transition-all"
          style={{
            background:  isActive ? def.color : "rgba(255,255,255,0.15)",
            boxShadow:   isActive ? `0 0 6px ${def.color}80` : "none",
          }}
        />
        <span
          className="text-[13px] transition-colors"
          style={{ color: isActive ? "#fff" : isHovered ? "#cbd5e1" : "#94a3b8" }}
        >
          {def.name}
        </span>
      </div>

      {/* Right: short label badge + checkmark */}
      <div className="flex items-center gap-2.5">
        <span
          className="text-[11px] font-mono transition-colors"
          style={{ color: isActive ? def.color : "rgba(255,255,255,0.2)" }}
        >
          {def.shortLabel}
        </span>
        <span
          className="flex items-center justify-center w-5 h-5 rounded transition-all"
          style={{
            background: isActive ? def.color : "transparent",
            border:     isActive ? `1px solid ${def.color}` : "1px solid rgba(255,255,255,0.12)",
            opacity:    isActive ? 1 : isHovered ? 0.6 : 0.3,
          }}
        >
          {isActive && (
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
              <path d="M1.5 4.5l2.5 2.5 4-5" stroke="#000" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </span>
      </div>
    </div>
  );
}
