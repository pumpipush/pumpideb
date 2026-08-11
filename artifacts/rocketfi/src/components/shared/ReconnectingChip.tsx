import { WifiOff } from "lucide-react";

/**
 * Shown on any page when its live SSE stream has dropped and is reconnecting.
 * Used by both Dashboard (global feed) and AppInterface (per-token stream)
 * so their styling is guaranteed to stay in sync.
 */
export function ReconnectingChip({ title = "Live stream disconnected — reconnecting…" }: { title?: string }) {
  return (
    <div
      className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-semibold whitespace-nowrap"
      style={{
        background:   "rgba(239,68,68,0.08)",
        borderColor:  "rgba(239,68,68,0.25)",
        color:        "#f87171",
      }}
      title={title}
    >
      <WifiOff className="w-3 h-3 shrink-0" />
      <span className="hidden sm:inline">Reconnecting…</span>
    </div>
  );
}
