import type { Indicator } from "./ChartCanvas";

interface IndicatorModalProps {
  open:       boolean;
  onClose:    () => void;
  active:     Indicator[];
  onToggle:   (ind: Indicator) => void;
}

const GROUPS: { label: string; items: { id: Indicator; name: string; color: string }[] }[] = [
  {
    label: "Moving Averages",
    items: [
      { id: "MA20",  name: "MA 20",   color: "#fbbf24" },
      { id: "MA50",  name: "MA 50",   color: "#fb923c" },
      { id: "MA200", name: "MA 200",  color: "#a78bfa" },
      { id: "EMA9",  name: "EMA 9",   color: "#22d3ee" },
      { id: "EMA21", name: "EMA 21",  color: "#60a5fa" },
    ],
  },
  {
    label: "Overlays",
    items: [
      { id: "BB",   name: "Bollinger Bands", color: "#aaaaaa" },
      { id: "VWAP", name: "VWAP",            color: "#f472b6" },
      { id: "PSAR", name: "Parabolic SAR",   color: "#34d399" },
    ],
  },
  {
    label: "Sub-pane",
    items: [
      { id: "RSI",   name: "RSI 14",       color: "#c084fc" },
      { id: "MACD",  name: "MACD 12,26,9", color: "#60a5fa" },
      { id: "STOCH", name: "Stochastic",   color: "#22d3ee" },
    ],
  },
];

export function IndicatorModal({ open, onClose, active, onToggle }: IndicatorModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full sm:w-80 rounded-t-xl sm:rounded-xl overflow-hidden shadow-2xl"
        style={{ background: "#0f1929", border: "1px solid rgba(255,255,255,0.1)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span className="text-sm font-bold text-white tracking-wide">Indicators</span>
          {active.length > 0 && (
            <button
              onClick={() => active.forEach(i => onToggle(i))}
              className="text-[11px] text-red-400 hover:text-red-300 transition-colors"
            >
              Clear all
            </button>
          )}
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors ml-2 text-lg leading-none">×</button>
        </div>

        {/* Groups */}
        <div className="p-3 space-y-4 max-h-[60vh] overflow-y-auto">
          {GROUPS.map(group => (
            <div key={group.label}>
              <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2 px-1">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.items.map(item => {
                  const isActive = active.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      onClick={() => onToggle(item.id)}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-left"
                      style={{
                        background: isActive ? "rgba(59,130,246,0.12)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${isActive ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.06)"}`,
                      }}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ background: item.color, boxShadow: isActive ? `0 0 6px ${item.color}80` : "none" }}
                      />
                      <span className="text-[13px] font-medium" style={{ color: isActive ? "#fff" : "#94a3b8" }}>
                        {item.name}
                      </span>
                      {isActive && (
                        <span className="ml-auto text-[10px] font-bold text-blue-400">ON</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
