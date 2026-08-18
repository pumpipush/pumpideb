import { useParams } from "wouter";
import { Link } from "wouter";
import { useGetWalletProfile, getGetWalletProfileQueryKey } from "@workspace/api-client-react";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { SEO } from "@/components/seo/SEO";
import { useSolPrice } from "@/hooks/useSolPrice";
import { ExternalLink, Copy, Check, ArrowUpRight, ArrowDownLeft, TrendingUp } from "lucide-react";
import { useState, useCallback } from "react";

/* ── helpers ──────────────────────────────────────────────────────────────── */
function shortAddr(a: string, len = 6) { return `${a.slice(0, len)}…${a.slice(-4)}`; }
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
  const abs = Math.abs(n);
  return {
    positive: n >= 0,
    sign: n >= 0 ? "+" : "−",
    usd: fmtUsd(abs, sol),
    sol: fmtSol(abs),
  };
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
  return { label: p,    color: "#94a3b8" };
}
function timeAgo(ts: string) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60)   return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/* ── sub-components ───────────────────────────────────────────────────────── */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);
  return (
    <button onClick={copy} title="Copy address"
      className="p-1.5 rounded-md transition-colors hover:bg-white/10"
      style={{ color: "rgba(148,163,184,0.6)" }}>
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function StatCard({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean }) {
  const color = positive === undefined ? "rgba(255,255,255,0.85)"
              : positive ? "#34d399" : "#f87171";
  return (
    <div className="flex flex-col gap-1 p-4 rounded-xl"
      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "rgba(148,163,184,0.5)" }}>{label}</span>
      <span className="text-lg font-extrabold leading-tight tabular-nums" style={{ color }}>{value}</span>
      {sub && <span className="text-[11px] font-mono" style={{ color: "rgba(148,163,184,0.4)" }}>{sub}</span>}
    </div>
  );
}

function PnlStatCard({ label, lamports, hasBothSides, sol }: { label: string; lamports: string; hasBothSides: boolean; sol: number | null }) {
  const { positive, sign, usd, sol: solStr } = fmtPnl(lamports, sol);
  const color = hasBothSides ? (positive ? "#34d399" : "#f87171") : "rgba(148,163,184,0.5)";
  const value = hasBothSides ? `${sign}${usd ?? solStr}` : "—";
  const sub   = hasBothSides && usd ? `${sign}${solStr}` : hasBothSides ? undefined : "Need buys & sells";
  return (
    <div className="flex flex-col gap-1 p-4 rounded-xl"
      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "rgba(148,163,184,0.5)" }}>{label}</span>
      <span className="text-lg font-extrabold leading-tight tabular-nums" style={{ color }}>{value}</span>
      {sub && <span className="text-[11px] font-mono" style={{ color: "rgba(148,163,184,0.4)" }}>{sub}</span>}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="p-4 rounded-xl" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <Skeleton className="h-3 w-16 mb-2" />
      <Skeleton className="h-6 w-24" />
    </div>
  );
}

/* ── page ─────────────────────────────────────────────────────────────────── */
export default function WalletProfile() {
  const { address } = useParams<{ address: string }>();
  const solPrice = useSolPrice();

  const { data, isLoading } = useGetWalletProfile(address ?? "", {
    query: {
      enabled: !!address && address.length >= 32,
      queryKey: getGetWalletProfileQueryKey(address ?? ""),
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
  });

  const short = address ? shortAddr(address) : "…";
  const solscanUrl = `https://solscan.io/account/${address}`;

  return (
    <div className="flex flex-col min-h-full bg-background text-foreground">
      <SEO title={`Wallet ${short}`} description={`Trade history and P&L for wallet ${address}`} />

      <div className="w-full max-w-[900px] mx-auto px-4 md:px-6 pt-6 pb-16">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-8">
          <div className="flex items-center gap-4">
            {/* Gradient avatar */}
            <div className="w-14 h-14 rounded-full flex items-center justify-center shrink-0 text-lg font-extrabold text-white shadow-lg"
              style={{ background: address ? walletGradient(address) : "#333" }}>
              {address ? address.slice(0, 2).toUpperCase() : "??"}
            </div>
            <div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-mono text-lg font-bold text-slate-200">{short}</span>
                <CopyButton text={address ?? ""} />
                <a href={solscanUrl} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md transition-colors hover:text-white"
                  style={{ color: "rgba(148,163,184,0.6)", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  Solscan <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <p className="text-xs mt-0.5 font-mono break-all" style={{ color: "rgba(148,163,184,0.4)" }}>{address}</p>
            </div>
          </div>
        </div>

        {/* ── Stats row ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
          ) : data ? (
            <>
              <PnlStatCard
                label="24h Net SOL Flow"
                lamports={data.summary.net_sol_flow_24h_lamports}
                hasBothSides={data.summary.has_both_sides_24h}
                sol={solPrice}
              />
              <PnlStatCard
                label="7d Net SOL Flow"
                lamports={data.summary.net_sol_flow_7d_lamports}
                hasBothSides={data.summary.has_both_sides_7d}
                sol={solPrice}
              />
              <StatCard
                label="Trades"
                value={data.summary.recent_trade_count.toLocaleString()}
                sub={data.summary.recent_trades_label}
              />
              <StatCard
                label="Volume"
                value={fmtUsd(data.summary.recent_volume_lamports, solPrice) ?? fmtSol(data.summary.recent_volume_lamports)}
                sub={solPrice ? `${fmtSol(data.summary.recent_volume_lamports)} · ${data.summary.recent_trades_label}` : data.summary.recent_trades_label}
              />
            </>
          ) : (
            <div className="col-span-4 py-8 text-center text-sm" style={{ color: "rgba(148,163,184,0.5)" }}>
              No data found for this wallet
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">

          {/* ── Top Tokens ────────────────────────────────────────────── */}
          <div>
            <div className="flex items-baseline gap-2 mb-3">
              <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: "rgba(148,163,184,0.5)" }}>
                Top Tokens
              </h2>
              {!isLoading && (data?.top_tokens ?? []).length > 0 && (
                <span className="text-[10px]" style={{ color: "rgba(148,163,184,0.3)" }}>last 50 trades</span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-xl"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <Skeleton className="w-8 h-8 rounded-full shrink-0" />
                    <div className="flex-1"><Skeleton className="h-3 w-16 mb-1" /><Skeleton className="h-2.5 w-12" /></div>
                    <Skeleton className="h-3 w-14 shrink-0" />
                  </div>
                ))
              ) : (data?.top_tokens ?? []).length === 0 ? (
                <p className="text-xs py-4 text-center" style={{ color: "rgba(148,163,184,0.4)" }}>No tokens yet</p>
              ) : (
                (data?.top_tokens ?? []).map((tok, i) => {
                  const plat = platformLabel(tok.platform);
                  const vol = fmtUsd(tok.volume_lamports, solPrice) ?? fmtSol(tok.volume_lamports);
                  return (
                    <Link key={tok.token_address} to={`/coin/${tok.token_address}`}
                      className="flex items-center gap-3 p-3 rounded-xl group transition-colors cursor-pointer"
                      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <span className="text-xs font-bold w-4 shrink-0 tabular-nums" style={{ color: "rgba(255,255,255,0.3)" }}>{i + 1}</span>
                      <TokenAvatar imageUrl={tok.token_image_url ?? null} symbol={tok.token_symbol} size={32} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-slate-200 group-hover:text-white truncate transition-colors">{tok.token_symbol}</div>
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                          style={{ background: `${plat.color}18`, color: plat.color }}>
                          {plat.label}
                        </span>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-bold text-white">{vol}</div>
                        <div className="text-[10px]" style={{ color: "rgba(148,163,184,0.4)" }}>{tok.trade_count} trades</div>
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
          </div>

          {/* ── Recent Trades ──────────────────────────────────────────── */}
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: "rgba(148,163,184,0.5)" }}>
              Recent Trades
            </h2>
            <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)", background: "#0a0a0a" }}>
              <table className="w-full">
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.02)" }}>
                    <th className="text-left py-2.5 px-4 text-[11px] font-semibold uppercase tracking-wider w-8"
                      style={{ color: "rgba(148,163,184,0.5)" }}>Side</th>
                    <th className="text-left py-2.5 px-4 text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: "rgba(148,163,184,0.5)" }}>Token</th>
                    <th className="text-right py-2.5 px-4 text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: "rgba(148,163,184,0.5)" }}>Amount</th>
                    <th className="text-right py-2.5 px-4 text-[11px] font-semibold uppercase tracking-wider hidden sm:table-cell"
                      style={{ color: "rgba(148,163,184,0.5)" }}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    Array.from({ length: 10 }).map((_, i) => (
                      <tr key={i}>
                        <td className="py-2.5 px-4"><Skeleton className="w-5 h-5 rounded" /></td>
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-2">
                            <Skeleton className="w-7 h-7 rounded-full shrink-0" />
                            <Skeleton className="h-3 w-20" />
                          </div>
                        </td>
                        <td className="py-2.5 px-4"><Skeleton className="h-3 w-16 ml-auto" /></td>
                        <td className="py-2.5 px-4 hidden sm:table-cell"><Skeleton className="h-3 w-12 ml-auto" /></td>
                      </tr>
                    ))
                  ) : (data?.recent_trades ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-12 text-center text-sm" style={{ color: "rgba(148,163,184,0.4)" }}>
                        No trades found
                      </td>
                    </tr>
                  ) : (
                    (data?.recent_trades ?? []).map((trade, i) => {
                      const sol = fmtSol(trade.eth_amount);
                      const usd = fmtUsd(trade.eth_amount, solPrice);
                      const isBuy = trade.is_buy;
                      const rows = data?.recent_trades ?? [];
                      return (
                        <tr key={trade.id}
                          className="group transition-colors hover:bg-white/[0.025]"
                          style={{ borderBottom: i < rows.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                          {/* Side icon */}
                          <td className="py-2.5 px-4">
                            <div className={`w-6 h-6 rounded flex items-center justify-center`}
                              style={{ background: isBuy ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)" }}>
                              {isBuy
                                ? <ArrowDownLeft className="w-3.5 h-3.5" style={{ color: "#34d399" }} />
                                : <ArrowUpRight  className="w-3.5 h-3.5" style={{ color: "#f87171" }} />}
                            </div>
                          </td>
                          {/* Token */}
                          <td className="py-2.5 px-4">
                            <Link to={`/coin/${trade.token_address}`}
                              className="flex items-center gap-2 group/link cursor-pointer">
                              <TokenAvatar imageUrl={trade.token_image_url ?? null} symbol={trade.token_symbol} size={28} />
                              <div>
                                <div className="text-sm font-bold text-slate-200 group-hover/link:text-white transition-colors">
                                  {trade.token_symbol}
                                </div>
                                <div className="text-[10px] truncate max-w-[120px]" style={{ color: "rgba(148,163,184,0.45)" }}>
                                  {trade.token_name}
                                </div>
                              </div>
                            </Link>
                          </td>
                          {/* Amount */}
                          <td className="py-2.5 px-4 text-right">
                            <div className="text-sm font-bold" style={{ color: isBuy ? "#34d399" : "#f87171" }}>
                              {isBuy ? "+" : "−"}{usd ?? sol}
                            </div>
                            {usd && (
                              <div className="text-[10px] font-mono" style={{ color: "rgba(148,163,184,0.4)" }}>
                                {isBuy ? "+" : "−"}{sol}
                              </div>
                            )}
                          </td>
                          {/* Time + tx link */}
                          <td className="py-2.5 px-4 text-right hidden sm:table-cell">
                            <a href={`https://solscan.io/tx/${trade.tx_hash}`} target="_blank" rel="noopener noreferrer"
                              className="text-[11px] transition-colors hover:text-white"
                              style={{ color: "rgba(148,163,184,0.5)" }}>
                              {timeAgo(trade.timestamp)}
                              <ExternalLink className="w-2.5 h-2.5 inline ml-1 opacity-50" />
                            </a>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Leaderboard back-link */}
            <div className="flex items-center justify-between mt-3 px-1">
              <Link to="/leaderboard"
                className="flex items-center gap-1 text-xs transition-colors hover:text-white"
                style={{ color: "rgba(148,163,184,0.45)" }}>
                <TrendingUp className="w-3 h-3" /> View Leaderboard
              </Link>
              <p className="text-[11px]" style={{ color: "rgba(148,163,184,0.3)" }}>
                Last 50 trades · updates every minute
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
