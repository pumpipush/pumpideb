import { useState } from "react";
import { useGetLeaderboard, getGetLeaderboardQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, BarChart2, Zap, ChevronRight } from "lucide-react";

type Tab = "pnl" | "volume" | "tokens";

interface Props {
  solPrice: number | null;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
function lamportsToSol(v: string | number) { return Number(v) / 1e9; }
function fmtSol(v: string | number) {
  const s = lamportsToSol(v);
  if (s >= 1_000_000) return `${(s / 1_000_000).toFixed(2)}M◎`;
  if (s >= 1000)      return `${(s / 1000).toFixed(1)}K◎`;
  if (s >= 1)         return `${s.toFixed(1)}◎`;
  return `${s.toFixed(3)}◎`;
}
function fmtUsd(v: string | number, sol: number | null) {
  if (!sol) return null;
  const u = lamportsToSol(v) * sol;
  if (u >= 1_000_000) return `$${(u / 1_000_000).toFixed(2)}M`;
  if (u >= 1_000)     return `$${(u / 1_000).toFixed(1)}K`;
  return `$${u.toFixed(0)}`;
}
function fmtPnl(v: string | number, sol: number | null) {
  const n = Number(v);
  return { sign: n >= 0 ? "+" : "−", usd: fmtUsd(Math.abs(n), sol), sol: fmtSol(Math.abs(n)), positive: n >= 0 };
}
function walletGradient(addr: string) {
  const h1 = addr.charCodeAt(0) * 137 % 360;
  const h2 = addr.charCodeAt(2) * 97  % 360;
  return `linear-gradient(135deg,hsl(${h1},70%,45%),hsl(${h2},65%,35%))`;
}

const MEDALS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };
function RankBadge({ rank }: { rank: number }) {
  if (MEDALS[rank]) return (
    <div className="w-6 flex items-center justify-center shrink-0 text-lg leading-none">{MEDALS[rank]}</div>
  );
  return (
    <div className="w-6 flex items-center justify-center shrink-0 text-xs font-bold"
      style={{ color: "rgba(255,255,255,0.5)" }}>{rank}</div>
  );
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "pnl",    label: "PnL",    icon: <TrendingUp className="w-3 h-3" /> },
  { id: "volume", label: "Volume", icon: <BarChart2  className="w-3 h-3" /> },
  { id: "tokens", label: "Tokens", icon: <Zap        className="w-3 h-3" /> },
];

export function LeaderboardWidget({ solPrice }: Props) {
  const [tab, setTab] = useState<Tab>("pnl");

  // Widget always shows 24h — full page has 7d/30d
  const { data, isLoading } = useGetLeaderboard("24h", {
    query: { refetchInterval: 60_000, staleTime: 60_000, queryKey: getGetLeaderboardQueryKey("24h") },
  });

  const volRows = data?.traders_volume ?? [];
  const pnlRows = data?.traders_pnl    ?? [];
  const tokRows = data?.tokens          ?? [];

  const rows = tab === "volume" ? volRows.slice(0, 10)
             : tab === "pnl"    ? pnlRows.slice(0, 10)
             : tokRows.slice(0, 10);

  const isEmpty = !isLoading && rows.length === 0;

  return (
    <div className="flex flex-col h-full overflow-hidden"
      style={{ borderRadius: "12px", border: "1px solid rgba(255,255,255,0.08)", background: "linear-gradient(180deg,#0e0e0e 0%,#0a0a0a 100%)" }}>

      {/* Tabs */}
      <div className="shrink-0 px-4 pt-2 pb-0">
        <div className="flex gap-0 border-b" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
          {TABS.map(({ id, label, icon }) => {
            const active = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)}
                className="relative flex items-center gap-1.5 px-3 py-2 text-xs font-semibold transition-all duration-150"
                style={{ color: active ? "#e2e8f0" : "rgba(148,163,184,0.5)" }}>
                <span>{icon}</span>{label}
                {active && <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full" style={{ background: "rgba(255,255,255,0.5)" }} />}
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col min-h-0">
        {isLoading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 py-2.5">
              <Skeleton className="w-6 h-6 rounded-full shrink-0" />
              <Skeleton className="w-7 h-7 rounded-full shrink-0" />
              <Skeleton className="flex-1 h-3" />
              <Skeleton className="w-14 h-3 shrink-0" />
            </div>
          ))
        ) : isEmpty ? (
          <div className="flex-1 flex items-center justify-center py-8 text-xs text-muted-foreground">No data yet</div>
        ) : tab === "volume" ? (
          volRows.slice(0, 10).map((row, i) => (
            <a key={row.address} href={`https://solscan.io/account/${row.address}`} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2.5 py-2 group"
              style={{ borderBottom: i < 9 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
              <RankBadge rank={i + 1} />
              <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-white"
                style={{ background: walletGradient(row.address) }}>{row.address.slice(0, 2).toUpperCase()}</div>
              <span className="flex-1 text-xs font-mono text-slate-200 group-hover:text-white transition-colors truncate">{shortAddr(row.address)}</span>
              <span className="text-xs font-bold text-white shrink-0">{fmtUsd(row.volume_lamports, solPrice) ?? fmtSol(row.volume_lamports)}</span>
            </a>
          ))
        ) : tab === "pnl" ? (
          pnlRows.slice(0, 10).map((row, i) => {
            const { sign, usd, sol, positive } = fmtPnl(row.pnl_lamports, solPrice);
            const color = positive ? "#34d399" : "#f87171";
            return (
              <a key={row.address} href={`https://solscan.io/account/${row.address}`} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2.5 py-2 group"
                style={{ borderBottom: i < 9 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                <RankBadge rank={i + 1} />
                <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-white"
                  style={{ background: walletGradient(row.address) }}>{row.address.slice(0, 2).toUpperCase()}</div>
                <span className="flex-1 text-xs font-mono text-slate-200 group-hover:text-white transition-colors truncate">{shortAddr(row.address)}</span>
                <span className="text-xs font-bold shrink-0" style={{ color }}>{sign}{usd ?? sol}</span>
              </a>
            );
          })
        ) : (
          tokRows.slice(0, 10).map((token, i) => (
            <Link key={token.address} to={`/coin/${token.address}`}
              className="flex items-center gap-2.5 py-2 group cursor-pointer"
              style={{ borderBottom: i < 9 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
              <RankBadge rank={i + 1} />
              <TokenAvatar imageUrl={token.imageUrl ?? null} symbol={token.symbol} size={28} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold text-slate-200 group-hover:text-white truncate">{token.symbol}</div>
                <div className="text-[10px] truncate" style={{ color: "rgba(148,163,184,0.5)" }}>{token.name}</div>
              </div>
              <span className="text-xs font-bold text-white shrink-0">{fmtUsd(token.volume_lamports, solPrice) ?? fmtSol(token.volume_lamports)}</span>
            </Link>
          ))
        )}
      </div>

      {/* View all */}
      <Link to="/leaderboard"
        className="shrink-0 flex items-center justify-center gap-1 py-2.5 text-xs font-semibold transition-colors hover:text-white"
        style={{ borderTop: "1px solid rgba(255,255,255,0.07)", color: "rgba(148,163,184,0.6)" }}>
        View all <ChevronRight className="w-3 h-3" />
      </Link>
    </div>
  );
}
