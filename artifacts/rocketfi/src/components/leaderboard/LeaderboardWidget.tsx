import { useState } from "react";
import { useGetLeaderboard } from "@workspace/api-client-react";
import { Link } from "wouter";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, TrendingUp, BarChart2, ExternalLink } from "lucide-react";

type Tab = "volume" | "pnl" | "tokens";

interface Props {
  solPrice: number | null;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function lamportsToSol(lamports: string | number): number {
  return Number(lamports) / 1e9;
}

function fmtSol(lamports: string | number): string {
  const sol = lamportsToSol(lamports);
  if (sol >= 1000) return `${(sol / 1000).toFixed(1)}K SOL`;
  if (sol >= 1)    return `${sol.toFixed(1)} SOL`;
  return `${sol.toFixed(3)} SOL`;
}

function fmtUsd(lamports: string | number, solPrice: number | null): string | null {
  if (!solPrice) return null;
  const usd = lamportsToSol(lamports) * solPrice;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

function fmtPnl(lamports: string | number, solPrice: number | null) {
  const n = Number(lamports);
  const sign = n >= 0 ? "+" : "";
  const sol = fmtSol(Math.abs(n));
  const usd = fmtUsd(Math.abs(n), solPrice);
  return { sign, sol, usd, positive: n >= 0 };
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "volume", label: "Volume",  icon: <BarChart2 className="w-3 h-3" /> },
  { id: "pnl",    label: "PnL",     icon: <TrendingUp className="w-3 h-3" /> },
  { id: "tokens", label: "Tokens",  icon: <Trophy className="w-3 h-3" /> },
];

const MEDAL = ["🥇", "🥈", "🥉"];

export function LeaderboardWidget({ solPrice }: Props) {
  const [tab, setTab] = useState<Tab>("pnl");

  const { data, isLoading } = useGetLeaderboard({
    query: {
      refetchInterval: 60_000,
      staleTime:       60_000,
    },
  });

  return (
    <div className="flex flex-col h-full rounded-xl overflow-hidden"
      style={{ border: "1px solid rgba(255,255,255,0.07)", background: "#0a0a0a" }}>

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "#0d0d0d" }}>
        <span className="text-sm font-bold text-foreground tracking-tight">Leaderboard</span>
        <span className="text-[10px] text-muted-foreground font-mono">24h</span>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 px-2 pt-2 gap-1">
        {TABS.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold transition-all duration-150"
            style={tab === id
              ? { background: "rgba(255,255,255,0.12)", color: "#f2f2f2" }
              : { color: "rgba(180,180,180,0.55)" }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 py-1.5 flex flex-col gap-0.5 min-h-0">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 px-1 py-1.5">
              <Skeleton className="w-5 h-3 rounded" />
              <Skeleton className="w-7 h-7 rounded-full shrink-0" />
              <div className="flex-1 flex flex-col gap-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2.5 w-16" />
              </div>
              <Skeleton className="h-3 w-14" />
            </div>
          ))
        ) : tab === "volume" ? (
          (data?.traders_volume ?? []).map((row, i) => {
            const usd = fmtUsd(row.volume_lamports, solPrice);
            return (
              <a
                key={row.address}
                href={`https://solscan.io/account/${row.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-1 py-1.5 rounded-lg transition-colors hover:bg-white/[0.04] group"
              >
                <span className="w-5 text-center text-xs shrink-0" style={{ color: "rgba(180,180,180,0.5)" }}>
                  {MEDAL[i] ?? <span className="font-mono">{i + 1}</span>}
                </span>
                <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                  style={{ background: "rgba(255,255,255,0.06)", color: "rgba(200,200,200,0.7)" }}>
                  {row.address.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-mono text-foreground truncate">{shortAddr(row.address)}</span>
                    <ExternalLink className="w-2.5 h-2.5 opacity-0 group-hover:opacity-40 shrink-0 transition-opacity" />
                  </div>
                  <span className="text-[10px]" style={{ color: "rgba(140,140,140,0.7)" }}>
                    {row.trade_count} trades
                  </span>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-semibold text-foreground">{usd ?? fmtSol(row.volume_lamports)}</div>
                  {usd && <div className="text-[10px] font-mono" style={{ color: "rgba(140,140,140,0.7)" }}>{fmtSol(row.volume_lamports)}</div>}
                </div>
              </a>
            );
          })
        ) : tab === "pnl" ? (
          (data?.traders_pnl ?? []).map((row, i) => {
            const { sign, sol, usd, positive } = fmtPnl(row.pnl_lamports, solPrice);
            const color = positive ? "#4ade80" : "#f87171";
            return (
              <a
                key={row.address}
                href={`https://solscan.io/account/${row.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-1 py-1.5 rounded-lg transition-colors hover:bg-white/[0.04] group"
              >
                <span className="w-5 text-center text-xs shrink-0" style={{ color: "rgba(180,180,180,0.5)" }}>
                  {MEDAL[i] ?? <span className="font-mono">{i + 1}</span>}
                </span>
                <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                  style={{ background: "rgba(255,255,255,0.06)", color: "rgba(200,200,200,0.7)" }}>
                  {row.address.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-mono text-foreground truncate">{shortAddr(row.address)}</span>
                    <ExternalLink className="w-2.5 h-2.5 opacity-0 group-hover:opacity-40 shrink-0 transition-opacity" />
                  </div>
                  <span className="text-[10px]" style={{ color: "rgba(140,140,140,0.7)" }}>
                    {row.trade_count} trades
                  </span>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-semibold" style={{ color }}>{sign}{usd ?? sol}</div>
                  {usd && <div className="text-[10px] font-mono" style={{ color: "rgba(140,140,140,0.7)" }}>{sign}{sol}</div>}
                </div>
              </a>
            );
          })
        ) : (
          // Tokens tab
          (data?.tokens ?? []).map((token, i) => {
            const usd = fmtUsd(token.volume_lamports, solPrice);
            return (
              <Link
                key={token.address}
                to={`/coin/${token.address}`}
                className="flex items-center gap-2 px-1 py-1.5 rounded-lg transition-colors hover:bg-white/[0.04] group cursor-pointer"
              >
                <span className="w-5 text-center text-xs shrink-0" style={{ color: "rgba(180,180,180,0.5)" }}>
                  {MEDAL[i] ?? <span className="font-mono">{i + 1}</span>}
                </span>
                <TokenAvatar imageUrl={token.imageUrl ?? null} symbol={token.symbol} size={28} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-foreground truncate">{token.symbol}</div>
                  <span className="text-[10px] truncate" style={{ color: "rgba(140,140,140,0.7)" }}>
                    {token.name}
                  </span>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-semibold text-foreground">{usd ?? fmtSol(token.volume_lamports)}</div>
                  {usd && <div className="text-[10px] font-mono" style={{ color: "rgba(140,140,140,0.7)" }}>{fmtSol(token.volume_lamports)}</div>}
                </div>
              </Link>
            );
          })
        )}

        {/* Empty state */}
        {!isLoading && (
          (tab === "volume" && (data?.traders_volume ?? []).length === 0) ||
          (tab === "pnl"    && (data?.traders_pnl    ?? []).length === 0) ||
          (tab === "tokens" && (data?.tokens         ?? []).length === 0)
        ) && (
          <div className="flex-1 flex items-center justify-center py-8 text-xs text-muted-foreground">
            No data yet
          </div>
        )}
      </div>
    </div>
  );
}
