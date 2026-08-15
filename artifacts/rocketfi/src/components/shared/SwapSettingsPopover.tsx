/**
 * SwapSettingsPopover — slippage tolerance and priority fee settings.
 *
 * Rendered as a small ⚙️ trigger button that opens a Radix Popover.
 * Settings persist to localStorage via the swapSettings store.
 */

import { useState } from "react";
import { Settings2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useSwapSettings,
  setSwapSettings,
  SLIPPAGE_PRESETS,
  PRIORITY_PRESETS,
} from "@/stores/swapSettings";

// ── Preset slippage labels ────────────────────────────────────────────────────
const SLIPPAGE_LABELS: Record<number, string> = { 10: "0.1%", 50: "0.5%", 100: "1%" };

export function SwapSettingsPopover() {
  const settings = useSwapSettings();
  const [customSlippage, setCustomSlippage] = useState("");
  const [customFee, setCustomFee]           = useState("");

  const isCustomSlippage = !SLIPPAGE_PRESETS.includes(settings.slippageBps as typeof SLIPPAGE_PRESETS[number]);
  const isCustomFee      = !Object.values(PRIORITY_PRESETS).some((p) => p.microLamports === settings.priorityFee);

  const applyCustomSlippage = () => {
    const pct = parseFloat(customSlippage);
    if (!isNaN(pct) && pct > 0 && pct <= 50) {
      setSwapSettings({ slippageBps: Math.round(pct * 100) });
    }
    setCustomSlippage("");
  };

  const applyCustomFee = () => {
    const kMicro = parseFloat(customFee);
    if (!isNaN(kMicro) && kMicro >= 0) {
      setSwapSettings({ priorityFee: Math.round(kMicro * 1_000) });
    }
    setCustomFee("");
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 h-6 px-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors"
          title="Swap settings"
          aria-label="Swap settings"
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-72 p-0 rounded-xl overflow-hidden"
        style={{ border: "1px solid rgba(255,255,255,0.10)", background: "hsl(var(--popover))" }}
        align="end"
        sideOffset={6}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border/40 flex items-center gap-2">
          <Settings2 className="w-4 h-4 text-muted-foreground" />
          <span className="text-[14px] font-semibold text-foreground">Transaction Settings</span>
        </div>

        <div className="px-4 py-4 space-y-5">

          {/* ── Slippage ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-foreground">Slippage Tolerance</span>
              <span className="text-[12px] font-mono text-primary">
                {(settings.slippageBps / 100).toFixed(2)}%
              </span>
            </div>

            <div className="flex gap-1.5">
              {SLIPPAGE_PRESETS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  onClick={() => setSwapSettings({ slippageBps: bps })}
                  className="flex-1 py-1.5 rounded-lg text-[12px] font-bold transition-all duration-150 active:scale-95"
                  style={{
                    background: !isCustomSlippage && settings.slippageBps === bps
                      ? "hsl(var(--primary))"
                      : "rgba(255,255,255,0.06)",
                    color: !isCustomSlippage && settings.slippageBps === bps
                      ? "hsl(var(--primary-foreground))"
                      : "#888888",
                    border: "1px solid " + (!isCustomSlippage && settings.slippageBps === bps
                      ? "transparent"
                      : "rgba(255,255,255,0.08)"),
                  }}
                >
                  {SLIPPAGE_LABELS[bps]}
                </button>
              ))}
            </div>

            {/* Custom slippage input */}
            <div className="flex gap-1.5 items-center">
              <input
                type="number"
                min="0.01"
                max="50"
                step="0.1"
                placeholder="Custom %"
                value={customSlippage}
                onChange={(e) => setCustomSlippage(e.target.value)}
                onBlur={applyCustomSlippage}
                onKeyDown={(e) => e.key === "Enter" && applyCustomSlippage()}
                className="flex-1 h-8 px-2.5 rounded-lg text-[12px] font-mono bg-background/60 border text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-primary/40 transition"
                style={{
                  border: isCustomSlippage
                    ? "1px solid hsl(var(--primary))"
                    : "1px solid rgba(255,255,255,0.10)",
                }}
              />
              <span className="text-[11px] text-muted-foreground shrink-0 font-mono">%</span>
            </div>

            {settings.slippageBps > 300 && (
              <p className="text-[11px] text-yellow-400">⚠ High slippage — frontrun risk</p>
            )}
          </div>

          {/* ── Priority Fee ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-foreground">Priority Fee</span>
              <span className="text-[12px] text-muted-foreground">
                {settings.priorityFee === 0
                  ? "0 (Normal)"
                  : `${(settings.priorityFee / 1_000).toFixed(0)}K μL/CU`}
              </span>
            </div>

            <div className="flex gap-1.5">
              {Object.entries(PRIORITY_PRESETS).map(([key, preset]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSwapSettings({ priorityFee: preset.microLamports })}
                  className="flex-1 py-1.5 rounded-lg text-[12px] font-bold transition-all duration-150 active:scale-95"
                  style={{
                    background: !isCustomFee && settings.priorityFee === preset.microLamports
                      ? "hsl(var(--primary))"
                      : "rgba(255,255,255,0.06)",
                    color: !isCustomFee && settings.priorityFee === preset.microLamports
                      ? "hsl(var(--primary-foreground))"
                      : "#888888",
                    border: "1px solid " + (!isCustomFee && settings.priorityFee === preset.microLamports
                      ? "transparent"
                      : "rgba(255,255,255,0.08)"),
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Custom fee input (in thousands of micro-lamports) */}
            <div className="flex gap-1.5 items-center">
              <input
                type="number"
                min="0"
                step="100"
                placeholder="Custom"
                value={customFee}
                onChange={(e) => setCustomFee(e.target.value)}
                onBlur={applyCustomFee}
                onKeyDown={(e) => e.key === "Enter" && applyCustomFee()}
                className="flex-1 h-8 px-2.5 rounded-lg text-[12px] font-mono bg-background/60 border text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-primary/40 transition"
                style={{
                  border: isCustomFee
                    ? "1px solid hsl(var(--primary))"
                    : "1px solid rgba(255,255,255,0.10)",
                }}
              />
              <span className="text-[11px] text-muted-foreground shrink-0 font-mono">K μL/CU</span>
            </div>
          </div>

          {/* Footer note */}
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Slippage is enforced on every trade. Priority fee applies when on-chain swaps are enabled.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
