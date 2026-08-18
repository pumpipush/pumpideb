import { useState } from "react";
import { useGetLeaderboard, getGetLeaderboardQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, BarChart2, Zap } from "lucide-react";
import { useSolPrice } from "@/hooks/useSolPrice";
import { SEO } from "@/components/seo/SEO";

type Period = "24h" | "7d" | "30d";
type Tab    = "pnl" | "volume" | "tokens";

/* ── helpers ──────────────────────────────────────────────────────────── */
function shortAddr(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
function lamportsToSol(v: string | number) { return Number(v) / 1e9; }
function fmtSol(v: string | number) {
  const s = lamportsToSol(v);
  if (s >= 1_000_000) return `${(s / 1_000_000).toFixed(2)}M◎`;
  if (s >= 1_000)     return `${(s / 1_000).toFixed(2)}K◎`;
  if (s >= 1)         return `${s.toFixed(2)}◎`;
  return `${s.toFixed(4)}◎`;
}
function fmtUsd(v: string | number, sol: number | null) {
  if (!sol) return null;
  const u = lamportsToSol(v) * sol;
  if (u >= 1_000_000) return `$${(u / 1_000_000).toFixed(2)}M`;
  if (u >= 1_000)     return `$${(u / 1_000).toFixed(2)}K`;
  return `$${u.toFixed(2)}`;
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
function platformLabel(p: string) {
  if (p === "pump_fun")  return { label: "Pump.fun",  color: "#a78bfa" };
  if (p === "pumpswap")  return { label: "PumpSwap",  color: "#34d399" };
  if (p === "launchlab") return { label: "LaunchLab", color: "#f59e0b" };
  return { label: p, color: "#94a3b8" };
}

const MEDALS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };
function RankCell({ rank }: { rank: number }) {
  if (MEDALS[rank]) return <span className="text-xl leading-none">{MEDALS[rank]}</span>;
  return <span className="text-sm font-bold tabular-nums" style={{ color: "rgba(255,255,255,0.4)" }}>{rank}</span>;
}

const PERIODS: { id: Period; label: string }[] = [
  { id: "24h", label: "24H" },
  { id: "7d",  label: "7D"  },
  { id: "30d", label: "30D" },
];
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "pnl",    label: "Top PnL",    icon: <TrendingUp className="w-4 h-4" /> },
  { id: "volume", label: "Top Volume", icon: <BarChart2  className="w-4 h-4" /> },
  { id: "tokens", label: "Top Tokens", icon: <Zap        className="w-4 h-4" /> },
];

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 10 }).map((_, i) => (
        <tr key={i}>
          <td className="py-3 px-4"><Skeleton className="w-6 h-6 rounded" /></td>
          <td className="py-3 px-4">
            <div className="flex items-center gap-3">
              <Skeleton className="w-9 h-9 rounded-full shrink-0" />
              <Skeleton className="h-3 w-28" />
            </div>
          </td>
          <td className="py-3 px-4"><Skeleton className="h-3 w-20 ml-auto" /></td>
          <td className="py-3 px-4 hidden md:table-cell"><Skeleton className="h-3 w-16 ml-auto" /></td>
        </tr>
      ))}
    </>
  );
}

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("24h");
  const [tab,    setTab]    = useState<Tab>("pnl");
  const solPrice = useSolPrice();

  const { data, isLoading } = useGetLeaderboard(period, {
    query: { refetchInterval: 60_000, staleTime: 60_000, queryKey: getGetLeaderboardQueryKey(period) },
  });

  const volRows = data?.traders_volume ?? [];
  const pnlRows = data?.traders_pnl    ?? [];
  const tokRows = data?.tokens          ?? [];

  return (
    <div className="flex flex-col min-h-full bg-background text-foreground">
      <SEO title="Leaderboard" description="Top Solana memecoin traders and tokens ranked by PnL, volume, and activity." />

      <div className="w-full max-w-[900px] mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-16">

        {/* ── Page header ─────────────────────────────────────────────── */}
        <div className="flex items-end justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-foreground">Leaderboard</h1>
            <p className="text-sm text-muted-foreground mt-1">Top traders and tokens on Pumpi</p>
          </div>

          {/* Period selector */}
          <div className="flex items-center rounded-full p-0.5 shrink-0"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)" }}>
            {PERIODS.map(({ id, label }) => (
              <button key={id} onClick={() => setPeriod(id)}
                className="px-3.5 py-1.5 rounded-full text-xs font-bold transition-all duration-150"
                style={period === id
                  ? { background: "rgba(255,255,255,0.14)", color: "#f2f2f2" }
                  : { color: "rgba(180,180,180,0.55)" }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Category tabs ────────────────────────────────────────────── */}
        <div className="flex gap-1 mb-4">
          {TABS.map(({ id, label, icon }) => (
            <button key={id} onClick={() => setTab(id)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150"
              style={tab === id
                ? { background: "rgba(255,255,255,0.1)", color: "#f2f2f2", border: "1px solid rgba(255,255,255,0.12)" }
                : { color: "rgba(148,163,184,0.55)", border: "1px solid transparent" }}>
              {icon}{label}
            </button>
          ))}
        </div>

        {/* ── Table ────────────────────────────────────────────────────── */}
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)", background: "#0a0a0a" }}>
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.02)" }}>
                <th className="text-left py-3 px-4 text-[11px] font-semibold uppercase tracking-wider w-12"
                  style={{ color: "rgba(148,163,184,0.5)" }}>#</th>
                <th className="text-left py-3 px-4 text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: "rgba(148,163,184,0.5)" }}>
                  {tab === "tokens" ? "Token" : "Wallet"}
                </th>
                <th className="text-right py-3 px-4 text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: "rgba(148,163,184,0.5)" }}>
                  {tab === "pnl" ? "PnL" : "Volume"}
                </th>
                <th className="text-right py-3 px-4 text-[11px] font-semibold uppercase tracking-wider hidden md:table-cell"
                  style={{ color: "rgba(148,163,184,0.5)" }}>
                  {tab === "tokens" ? "Platform" : "SOL"}
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <SkeletonRows />
              ) : tab === "volume" ? (
                volRows.length === 0 ? (
                  <tr><td colSpan={4} className="py-16 text-center text-sm text-muted-foreground">No data yet</td></tr>
                ) : volRows.map((row, i) => {
                  const usd = fmtUsd(row.volume_lamports, solPrice);
                  return (
                    <tr key={row.address} className="group transition-colors hover:bg-white/[0.03]"
                      style={{ borderBottom: i < volRows.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                      <td className="py-3 px-4 w-12"><RankCell rank={i + 1} /></td>
                      <td className="py-3 px-4">
                        <a href={`https://solscan.io/account/${row.address}`} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-3 group/link">
                          <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold text-white"
                            style={{ background: walletGradient(row.address) }}>
                            {row.address.slice(0, 2).toUpperCase()}
                          </div>
                          <span className="font-mono text-sm text-slate-300 group-hover/link:text-white transition-colors">
                            {shortAddr(row.address)}
                          </span>
                        </a>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-bold text-white">{usd ?? fmtSol(row.volume_lamports)}</span>
                      </td>
                      <td className="py-3 px-4 text-right hidden md:table-cell">
                        <span className="text-xs font-mono" style={{ color: "rgba(148,163,184,0.55)" }}>{fmtSol(row.volume_lamports)}</span>
                      </td>
                    </tr>
                  );
                })
              ) : tab === "pnl" ? (
                pnlRows.length === 0 ? (
                  <tr><td colSpan={4} className="py-16 text-center text-sm text-muted-foreground">No data yet</td></tr>
                ) : pnlRows.map((row, i) => {
                  const { sign, usd, sol, positive } = fmtPnl(row.pnl_lamports, solPrice);
                  const color = positive ? "#34d399" : "#f87171";
                  return (
                    <tr key={row.address} className="group transition-colors hover:bg-white/[0.03]"
                      style={{ borderBottom: i < pnlRows.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                      <td className="py-3 px-4 w-12"><RankCell rank={i + 1} /></td>
                      <td className="py-3 px-4">
                        <a href={`https://solscan.io/account/${row.address}`} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-3 group/link">
                          <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold text-white"
                            style={{ background: walletGradient(row.address) }}>
                            {row.address.slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-mono text-sm text-slate-300 group-hover/link:text-white transition-colors">
                              {shortAddr(row.address)}
                            </div>
                            <div className="text-[11px]" style={{ color: "rgba(148,163,184,0.5)" }}>
                              {row.trade_count.toLocaleString()} trades
                            </div>
                          </div>
                        </a>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-bold" style={{ color }}>{sign}{usd ?? sol}</span>
                      </td>
                      <td className="py-3 px-4 text-right hidden md:table-cell">
                        <span className="text-xs font-mono" style={{ color: "rgba(148,163,184,0.55)" }}>{sign}{sol}</span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                tokRows.length === 0 ? (
                  <tr><td colSpan={4} className="py-16 text-center text-sm text-muted-foreground">No data yet</td></tr>
                ) : tokRows.map((token, i) => {
                  const usd = fmtUsd(token.volume_lamports, solPrice);
                  const plat = platformLabel(token.platform);
                  return (
                    <tr key={token.address} className="group transition-colors hover:bg-white/[0.03]"
                      style={{ borderBottom: i < tokRows.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                      <td className="py-3 px-4 w-12"><RankCell rank={i + 1} /></td>
                      <td className="py-3 px-4">
                        <Link to={`/coin/${token.address}`} className="flex items-center gap-3 group/link cursor-pointer">
                          <TokenAvatar imageUrl={token.imageUrl ?? null} symbol={token.symbol} size={36} />
                          <div>
                            <div className="text-sm font-bold text-slate-200 group-hover/link:text-white transition-colors">
                              {token.symbol}
                            </div>
                            <div className="text-[11px] truncate max-w-[160px]" style={{ color: "rgba(148,163,184,0.5)" }}>
                              {token.name}
                            </div>
                          </div>
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span className="text-sm font-bold text-white">{usd ?? fmtSol(token.volume_lamports)}</span>
                      </td>
                      <td className="py-3 px-4 text-right hidden md:table-cell">
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: `${plat.color}18`, color: plat.color, border: `1px solid ${plat.color}30` }}>
                          {plat.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="text-center text-xs mt-4" style={{ color: "rgba(148,163,184,0.35)" }}>
          Showing top 100 · Data refreshes every 4 minutes
        </p>
      </div>
    </div>
  );
}
