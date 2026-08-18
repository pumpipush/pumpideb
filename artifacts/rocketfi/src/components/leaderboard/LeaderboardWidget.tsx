import { useState } from "react";
import { useGetLeaderboard } from "@workspace/api-client-react";
import { Link } from "wouter";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, BarChart2, Zap } from "lucide-react";

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
  if (sol >= 1_000_000) return `${(sol / 1_000_000).toFixed(2)}M◎`;
  if (sol >= 1000)      return `${(sol / 1000).toFixed(1)}K◎`;
  if (sol >= 1)         return `${sol.toFixed(1)}◎`;
  return `${sol.toFixed(3)}◎`;
}

function fmtUsd(lamports: string | number, solPrice: number | null): string | null {
  if (!solPrice) return null;
  const usd = lamportsToSol(lamports) * solPrice;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

function fmtPnl(lamports: string | number, solPrice: number | null) {
  const n = Number(lamports);
  const sign = n >= 0 ? "+" : "−";
  const sol = fmtSol(Math.abs(n));
  const usd = fmtUsd(Math.abs(n), solPrice);
  return { sign, sol, usd, positive: n >= 0 };
}

// Deterministic gradient from wallet address
function walletGradient(addr: string): string {
  const h1 = addr.charCodeAt(0) * 137 % 360;
  const h2 = addr.charCodeAt(2) * 97  % 360;
  return `linear-gradient(135deg, hsl(${h1},70%,45%), hsl(${h2},65%,35%))`;
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "pnl",    label: "PnL",    icon: <TrendingUp className="w-3 h-3" /> },
  { id: "volume", label: "Volume", icon: <BarChart2  className="w-3 h-3" /> },
  { id: "tokens", label: "Tokens", icon: <Zap        className="w-3 h-3" /> },
];

// Rank badge — top 3 get styled gold/silver/bronze, rest get plain number
function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return (
    <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-black"
      style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)", color: "#1a0f00", boxShadow: "0 0 8px rgba(245,158,11,0.4)" }}>
      1
    </div>
  );
  if (rank === 2) return (
    <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-black"
      style={{ background: "linear-gradient(135deg,#94a3b8,#64748b)", color: "#0a0a0a" }}>
      2
    </div>
  );
  if (rank === 3) return (
    <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-black"
      style={{ background: "linear-gradient(135deg,#cd7c4e,#92400e)", color: "#1a0800" }}>
      3
    </div>
  );
  return (
    <div className="w-6 h-6 flex items-center justify-center shrink-0 text-[10px] font-semibold"
      style={{ color: "rgba(150,150,150,0.5)" }}>
      {rank}
    </div>
  );
}


export function LeaderboardWidget({ solPrice }: Props) {
  const [tab, setTab] = useState<Tab>("pnl");

  const { data, isLoading } = useGetLeaderboard({
    query: { refetchInterval: 60_000, staleTime: 60_000 },
  });

  const volumeRows = data?.traders_volume ?? [];
  const pnlRows    = data?.traders_pnl    ?? [];
  const tokenRows  = data?.tokens          ?? [];

  const isEmpty =
    !isLoading && (
      (tab === "volume" && volumeRows.length === 0) ||
      (tab === "pnl"    && pnlRows.length    === 0) ||
      (tab === "tokens" && tokenRows.length  === 0)
    );

  return (
    <div className="flex flex-col h-full overflow-hidden"
      style={{
        borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.08)",
        background: "linear-gradient(180deg,#0e0e0e 0%,#0a0a0a 100%)",
      }}>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="shrink-0 px-4 pt-3 pb-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-4 rounded-full" style={{ background: "linear-gradient(180deg,#22d3ee,#0e7490)" }} />
            <span className="text-sm font-bold tracking-tight text-white">Leaderboard</span>
          </div>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
            style={{ background: "rgba(167,139,250,0.12)", color: "#22d3ee", border: "1px solid rgba(167,139,250,0.2)" }}>
            24h
          </span>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
          {TABS.map(({ id, label, icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className="relative flex items-center gap-1.5 px-3 py-2 text-xs font-semibold transition-all duration-150"
                style={{ color: active ? "#e2e8f0" : "rgba(148,163,184,0.5)" }}
              >
                <span style={{ color: active ? "#22d3ee" : "inherit" }}>{icon}</span>
                {label}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full"
                    style={{ background: "linear-gradient(90deg,#22d3ee,#0891b2)" }} />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── List ───────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col min-h-0">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 py-2.5">
              <Skeleton className="w-6 h-6 rounded-full shrink-0" />
              <Skeleton className="w-7 h-7 rounded-full shrink-0" />
              <div className="flex-1 flex flex-col gap-1.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="h-1.5 w-14" />
                <Skeleton className="h-[2px] w-full mt-0.5" />
              </div>
              <Skeleton className="h-3 w-14 shrink-0" />
            </div>
          ))
        ) : isEmpty ? (
          <div className="flex-1 flex flex-col items-center justify-center py-10 gap-2">
            <div className="text-2xl opacity-20">🏆</div>
            <p className="text-xs text-muted-foreground">No data yet</p>
          </div>
        ) : tab === "volume" ? (
          volumeRows.map((row, i) => {
            const usd = fmtUsd(row.volume_lamports, solPrice);
            return (
              <a key={row.address}
                href={`https://solscan.io/account/${row.address}`}
                target="_blank" rel="noopener noreferrer"
                className="flex items-start gap-2.5 py-2.5 group"
                style={{ borderBottom: i < volumeRows.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}
              >
                <RankBadge rank={i + 1} />
                <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-white"
                  style={{ background: walletGradient(row.address) }}>
                  {row.address.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-mono text-slate-200 group-hover:text-white transition-colors">
                    {shortAddr(row.address)}
                  </span>
                </div>
                <div className="text-right shrink-0 pt-0.5">
                  <div className="text-xs font-bold text-white">{usd ?? fmtSol(row.volume_lamports)}</div>
                </div>
              </a>
            );
          })
        ) : tab === "pnl" ? (
          pnlRows.map((row, i) => {
            const { sign, sol, usd, positive } = fmtPnl(row.pnl_lamports, solPrice);
            const color = positive ? "#34d399" : "#f87171";
            const barColor = positive ? "#34d399" : "#f87171";
            return (
              <a key={row.address}
                href={`https://solscan.io/account/${row.address}`}
                target="_blank" rel="noopener noreferrer"
                className="flex items-start gap-2.5 py-2.5 group"
                style={{ borderBottom: i < pnlRows.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}
              >
                <RankBadge rank={i + 1} />
                <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-white"
                  style={{ background: walletGradient(row.address) }}>
                  {row.address.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-mono text-slate-200 group-hover:text-white transition-colors">
                    {shortAddr(row.address)}
                  </span>
                </div>
                <div className="text-right shrink-0 pt-0.5">
                  <div className="text-xs font-bold" style={{ color }}>{sign}{usd ?? sol}</div>
                </div>
              </a>
            );
          })
        ) : (
          tokenRows.map((token, i) => {
            const usd = fmtUsd(token.volume_lamports, solPrice);
            return (
              <Link key={token.address} to={`/coin/${token.address}`}
                className="flex items-start gap-2.5 py-2.5 group cursor-pointer"
                style={{ borderBottom: i < tokenRows.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}
              >
                <RankBadge rank={i + 1} />
                <TokenAvatar imageUrl={token.imageUrl ?? null} symbol={token.symbol} size={28} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-slate-200 group-hover:text-white transition-colors truncate">
                    {token.symbol}
                  </div>
                  <span className="text-[10px] truncate" style={{ color: "rgba(148,163,184,0.5)" }}>
                    {token.name}
                  </span>
                </div>
                <div className="text-right shrink-0 pt-0.5">
                  <div className="text-xs font-bold text-white">{usd ?? fmtSol(token.volume_lamports)}</div>
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
