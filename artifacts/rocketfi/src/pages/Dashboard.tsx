import { useState, useMemo, useEffect, useRef } from "react";
import { SEO } from "@/components/seo/SEO";
import {
  useListTokens,
  getListTokensQueryKey,
  ListTokensSort,
  type ListTokensPlatform,
} from "@workspace/api-client-react";

import { formatMC, formatMCUsd, formatTokenPrice, formatPct, cn, timeAgo, resolveImageUrl } from "@/lib/utils";
import BubbleMap, { type TokenBubbleInput } from "@/components/bubblemap/BubbleMap";
import { useSolPrice } from "@/hooks/useSolPrice";
import { TokenAvatar, tokenCardBackground } from "@/components/shared/TokenAvatar";
import { PlatformBadge, PlatformDot, type PlatformId } from "@/components/shared/PlatformBadge";
import { useFeedStream, type FeedToken, type FeedTradeStats } from "@/hooks/useFeedStream";
import { ReconnectingChip } from "@/components/shared/ReconnectingChip";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  LayoutGrid,
  List,
  Search,
  X,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Image as ImageIcon,
  GraduationCap,
  SlidersHorizontal,
  ArrowRight,
  Filter,
  Clock,
  Flame,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  Info,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────
type SortTab = "New" | "Trending" | "Volume" | "Graduated";
type ViewMode = "grid" | "table";
type TableSortKey = "rank" | "marketCap" | "price" | "age" | "name";
type TableSortDir = "asc" | "desc";

/** Minimal token shape shared by API tokens and live-feed tokens */
interface DisplayToken {
  id: number | string;
  address: string;
  name: string;
  symbol: string;
  imageUrl?: string | null;
  marketCapEth?: string | null;
  priceEth?: string | null;
  volumeEth?: string | null;
  graduatedAt?: string | null;
  createdAt: string | number;
  platform: string;
  graduated: boolean;
  /** True while the "NEW" badge is showing (live tokens only) */
  isLive?: boolean;
  /** Unix ms of last SSE trade event — drives activity pulse on cards */
  lastTradeAt?: number;
  /** All-time trade count from API */
  tradeCount?: number;
  /** Trades in the last 1 hour — only populated on Trending sort */
  trades1h?: number | null;
  /** 24-hour price change % — positive = green, negative = red */
  pctChange24h?: number | null;
}

// ─── Platform filter config ───────────────────────────────────────────────────
interface PlatformOption {
  id: string;
  label: string;
  emoji: string;
  logoUrl?: string;
}
const PLATFORM_OPTIONS: PlatformOption[] = [
  { id: "all",      label: "All",      emoji: "⚡" },
  { id: "pump_fun", label: "Pump.fun", emoji: "🐸", logoUrl: "/pumpfun.png" },
  { id: "pumpswap", label: "PumpSwap", emoji: "🚀", logoUrl: "/pumpswap.png" },
  { id: "raydium_launchlab", label: "LaunchLab", emoji: "⚡", logoUrl: "/raydium.jpg" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** True when a token has not yet been enriched with real name/symbol metadata */
function isPlaceholder(symbol: string | null | undefined): boolean {
  return !symbol || symbol === "???" || symbol === "?";
}

/** Display symbol — hides the "$" prefix for placeholder tokens */
function displaySymbol(symbol: string | null | undefined): string {
  if (isPlaceholder(symbol)) return "—";
  return `$${symbol}`;
}

/** Read / write the platform filter to the URL search params without navigation */
function getPlatformFromUrl(): string {
  return new URLSearchParams(window.location.search).get("platform") ?? "all";
}
function setPlatformInUrl(platform: string) {
  const params = new URLSearchParams(window.location.search);
  if (platform === "all") params.delete("platform");
  else params.set("platform", platform);
  const qs = params.toString();
  window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
}

/** Read / write the active tab to the URL search params.
 *  Trending is the default — its param is omitted so the homepage stays clean. */
const TAB_PARAM_MAP: Record<string, SortTab> = {
  new:       "New",
  volume:    "Volume",
  graduated: "Graduated",
};
const TAB_TO_PARAM: Partial<Record<SortTab, string>> = {
  New:       "new",
  Volume:    "volume",
  Graduated: "graduated",
  // Trending intentionally absent — it is the default and needs no param
};
function getTabFromUrl(): SortTab {
  const raw = new URLSearchParams(window.location.search).get("tab") ?? "";
  return TAB_PARAM_MAP[raw] ?? "Trending";
}
function setTabInUrl(tab: SortTab) {
  const params = new URLSearchParams(window.location.search);
  const param = TAB_TO_PARAM[tab];
  if (param) params.set("tab", param);
  else params.delete("tab"); // Trending → clean URL
  const qs = params.toString();
  window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
}

// ─── Token image with broken-URL fallback ────────────────────────────────────
function TokenImage({ imageUrl, symbol, className, textSize = "text-5xl" }: {
  imageUrl?: string | null;
  symbol: string;
  className?: string;
  textSize?: string;
}) {
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded]  = useState(false);
  // Reset states when imageUrl changes — enrichment can replace a bad URL
  useEffect(() => { setBroken(false); setLoaded(false); }, [imageUrl]);
  const src = resolveImageUrl(imageUrl ?? "") ?? "";
  if (!imageUrl || broken) {
    return (
      <div className={cn("w-full h-full flex items-center justify-center font-bold text-white/80", textSize, className)}
        style={{ background: tokenCardBackground(symbol) }}>
        {symbol.replace(/^\$/, "").charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={symbol}
      className={cn("w-full h-full object-cover transition-opacity duration-300", className)}
      style={{ opacity: loaded ? 1 : 0 }}
      loading="eager"
      onLoad={() => setLoaded(true)}
      onError={() => setBroken(true)}
    />
  );
}

// ─── Skeletons ────────────────────────────────────────────────────────────────
function TokenCardSkeleton() {
  return (
    <div className="flex flex-col bg-card border border-border rounded-sm overflow-hidden">
      <Skeleton className="aspect-square w-full rounded-none" />
      <div className="p-3 flex flex-col gap-2">
        <Skeleton className="h-4 w-2/3" />
        <div className="flex justify-between">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
    </div>
  );
}

function TableRowSkeleton() {
  return (
    <tr className="border-b border-border/[0.08]">
      <td className="px-4 py-3"><Skeleton className="h-3 w-5" /></td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-lg shrink-0" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-2.5 w-14" />
          </div>
        </div>
      </td>
      <td className="px-4 py-3 hidden md:table-cell"><Skeleton className="h-3.5 w-20 ml-auto" /></td>
      <td className="px-4 py-3 hidden sm:table-cell"><Skeleton className="h-3.5 w-16 ml-auto" /></td>
      <td className="px-4 py-3 hidden md:table-cell"><Skeleton className="h-5 w-14 rounded ml-auto" /></td>
      <td className="px-4 py-3 hidden lg:table-cell"><Skeleton className="h-3.5 w-16 ml-auto" /></td>
      <td className="px-4 py-3 hidden xl:table-cell"><Skeleton className="h-3.5 w-12 ml-auto" /></td>
      <td className="px-4 py-3 text-right"><Skeleton className="h-7 w-14 rounded inline-block" /></td>
    </tr>
  );
}

// ─── Table sort header ────────────────────────────────────────────────────────
function SortTh({
  col, label, active, dir, onSort, className, align = "left",
}: {
  col: TableSortKey; label: string; active: boolean; dir: TableSortDir;
  onSort: (k: TableSortKey) => void; className?: string; align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "px-4 py-3 text-[14px] font-medium tracking-[0.04em] cursor-pointer select-none transition-colors whitespace-nowrap",
        active ? "text-primary" : "text-muted-foreground/65 hover:text-muted-foreground/85",
        align === "right" ? "text-right" : "text-left",
        className
      )}
      onClick={() => onSort(col)}
    >
      <span className={cn("inline-flex items-center gap-1", align === "right" && "flex-row-reverse")}>
        {label}
        {active ? (
          dir === "desc" ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-25" />
        )}
      </span>
    </th>
  );
}

// ─── Activity mini-bar ────────────────────────────────────────────────────────
function ActivityBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  if (pct === 0) return <span className="text-muted-foreground/30 font-mono text-xs">—</span>;
  const fmtTrades = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
  return (
    <div className="flex items-center gap-2 justify-end">
      <span className="font-mono text-[12px] tabular-nums" style={{ color: pct > 60 ? "#f59e0b" : "#b3b3b3" }}>
        {fmtTrades(value)}
      </span>
      <div className="w-14 h-1.5 rounded-full bg-border/30 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${pct}%`,
            background: pct > 60
              ? "linear-gradient(90deg,#f59e0b,#ef4444)"
              : pct > 25
                ? "linear-gradient(90deg,#3b82f6,#06b6d4)"
                : "#3a3a3a",
          }}
        />
      </div>
    </div>
  );
}

// ─── Mobile list row ─────────────────────────────────────────────────────────
function MobileListRow({ token, rank, solPrice, isTrending, isVolume }: {
  token: DisplayToken; rank: number; solPrice: number | null;
  isTrending: boolean; isVolume: boolean;
}) {
  const price  = parseFloat(token.priceEth  ?? "0") || 0;
  const vol    = parseFloat(token.volumeEth ?? "0") || 0;
  const pct    = token.pctChange24h;
  const pctUp  = (pct ?? 0) >= 0;
  const isHot  = isTrending && rank <= 3;
  const isNew  = token.isLive;

  // right-column metric depends on active tab
  const metricLabel = isVolume ? "Vol" : "MC";
  const metricValue = isVolume
    ? (vol > 0 ? formatMCUsd(token.volumeEth, solPrice) : "—")
    : formatMCUsd(token.marketCapEth, solPrice);

  return (
    <Link
      href={`/coin/${token.address}`}
      className="flex items-center gap-2.5 px-3 py-2.5 active:bg-white/5 transition-colors"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.045)" }}
    >
      {/* Avatar */}
      <div className="relative shrink-0">
        <div className="w-9 h-9 rounded-lg overflow-hidden" style={{ outline: "1px solid rgba(255,255,255,0.08)" }}>
          {isPlaceholder(token.symbol) ? (
            <div className="w-full h-full flex items-center justify-center" style={{ background: tokenCardBackground(token.symbol) }}>
              <span className="flex gap-0.5">
                {[0,150,300].map(d => <span key={d} className="w-1 h-1 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
              </span>
            </div>
          ) : (
            <TokenImage imageUrl={token.imageUrl} symbol={token.symbol} textSize="text-base" />
          )}
        </div>
        <PlatformDot platform={token.platform as PlatformId} className="absolute -bottom-0.5 -right-0.5 w-3 h-3 ring-1 ring-black" />
      </div>

      {/* Name + ticker row */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-semibold text-[14px] leading-tight truncate" style={{ color: "#e0e0e0" }}>
            {token.name}
          </span>
          {isHot && <span className="shrink-0 text-[9px] font-black px-1 py-0.5 rounded leading-none" style={{ color: "#fbbf24", background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.22)" }}>HOT</span>}
          {isNew && !isHot && <span className="shrink-0 text-[9px] font-black px-1 py-0.5 rounded leading-none" style={{ color: "#34d399", background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.22)" }}>NEW</span>}
          {token.graduated && <span className="shrink-0 text-[9px] font-black px-1 py-0.5 rounded leading-none" style={{ color: "#60a5fa", background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.22)" }}>GRAD</span>}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[12px] font-mono" style={{ color: "#555555" }}>{displaySymbol(token.symbol)}</span>
          <span style={{ color: "#141414" }}>·</span>
          <span className="text-[11px]" style={{ color: "#3a3a3a" }}>{timeAgo(token.createdAt)}</span>
          {isTrending && (token.trades1h ?? 0) > 0 && (
            <>
              <span style={{ color: "#141414" }}>·</span>
              <span className="text-[11px] font-mono" style={{ color: "#f59e0b" }}>
                {token.trades1h! >= 1000 ? `${(token.trades1h! / 1000).toFixed(1)}K` : token.trades1h}/hr
              </span>
            </>
          )}
        </div>
      </div>

      {/* Right: MC/Vol + 24h% */}
      <div className="shrink-0 text-right flex flex-col items-end gap-0.5">
        <span className="font-mono text-[13px] font-bold tabular-nums leading-tight" style={{ color: "#f2f2f2" }}>
          {metricValue}
        </span>
        <div className="flex items-center gap-1">
          <span className="text-[10px]" style={{ color: "#3a3a3a" }}>{metricLabel}</span>
          {pct != null ? (
            <span
              className="font-mono text-[12px] font-bold tabular-nums"
              style={{ color: pctUp ? "#4ade80" : "#f87171" }}
            >
              {fmtPct(pct)}
            </span>
          ) : (
            <span style={{ color: "#3a3a3a" }} className="text-[12px]">—</span>
          )}
        </div>
      </div>
    </Link>
  );
}

// ─── Table view ───────────────────────────────────────────────────────────────
function TableView({ tokens, solPrice, activeTab, startRank }: {
  tokens: DisplayToken[];
  solPrice: number | null;
  activeTab: SortTab;
  startRank: number;
}) {
  const [sortKey, setSortKey] = useState<TableSortKey>("rank");
  const [sortDir, setSortDir] = useState<TableSortDir>("asc");

  const handleSort = (key: TableSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  };

  const sorted = useMemo(() => {
    if (sortKey === "rank") return tokens;
    const copy = [...tokens];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      switch (sortKey) {
        case "marketCap": return dir * ((parseFloat(a.marketCapEth ?? "0") || 0) - (parseFloat(b.marketCapEth ?? "0") || 0));
        case "price":     return dir * ((parseFloat(a.priceEth ?? "0") || 0) - (parseFloat(b.priceEth ?? "0") || 0));
        case "age":       return dir * (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        case "name":      return dir * a.name.localeCompare(b.name);
        default:          return 0;
      }
    });
    return copy;
  }, [tokens, sortKey, sortDir]);

  const th = (col: TableSortKey, label: string, cls?: string, align?: "left" | "right") => (
    <SortTh col={col} label={label} active={sortKey === col} dir={sortDir} onSort={handleSort} className={cls} align={align} />
  );

  const isTrending = activeTab === "Trending";
  const isVolume   = activeTab === "Volume";

  const maxTrades1h = useMemo(() =>
    Math.max(...tokens.map(t => t.trades1h ?? 0), 1),
    [tokens]
  );

  return (
    <div className="rounded-xl border border-white/[0.06] overflow-hidden" style={{ background: "rgba(10,12,18,0.85)", backdropFilter: "blur(8px)" }}>

      {/* ── Mobile list (< sm) ── */}
      <div className="sm:hidden">
        {/* Column header strip */}
        <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
          <span className="text-[11px] font-medium uppercase tracking-widest" style={{ color: "#3a3a3a" }}>Token</span>
          <span className="text-[11px] font-medium uppercase tracking-widest" style={{ color: "#3a3a3a" }}>{isVolume ? "Vol / 24h%" : "MC / 24h%"}</span>
        </div>
        {sorted.map((token, idx) => (
          <MobileListRow
            key={token.id}
            token={token}
            rank={startRank + idx}
            solPrice={solPrice}
            isTrending={isTrending}
            isVolume={isVolume}
          />
        ))}
      </div>

      {/* ── Desktop table (sm+) ── */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full border-collapse min-w-[640px]">
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.025)" }}>
              <th className="px-4 py-3 text-left text-[14px] font-medium tracking-[0.04em] text-muted-foreground/60 w-12">#</th>
              {th("name", "Token", "min-w-[200px]")}
              {th("price", "Price", "hidden md:table-cell", "right")}
              {th("marketCap", "Market Cap", "hidden sm:table-cell", "right")}
              <th className={cn(
                "px-4 py-3 text-[14px] font-medium tracking-[0.04em] whitespace-nowrap text-right hidden md:table-cell",
                "text-muted-foreground/65"
              )}>24h %</th>
              {isTrending && (
                <th className="px-4 py-3 text-[14px] font-medium tracking-[0.04em] text-muted-foreground/65 whitespace-nowrap text-right hidden lg:table-cell">
                  Trades/hr
                </th>
              )}
              {isVolume && (
                <th className="px-4 py-3 text-[14px] font-medium tracking-[0.04em] text-primary/80 whitespace-nowrap text-right hidden lg:table-cell">
                  Volume
                </th>
              )}
              <th className="px-4 py-3 text-[14px] font-medium tracking-[0.04em] text-muted-foreground/65 whitespace-nowrap text-right hidden xl:table-cell">Age</th>
              <th className="px-4 py-3 text-right text-[14px] font-medium tracking-[0.04em] text-muted-foreground/60 w-20">Trade</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((token, idx) => {
              const rank  = startRank + idx;
              const price = parseFloat(token.priceEth ?? "0") || 0;
              const vol   = parseFloat(token.volumeEth ?? "0") || 0;
              const pct   = token.pctChange24h;
              const pctUp = (pct ?? 0) >= 0;
              const isHot = isTrending && rank <= 3;
              const isNew = token.isLive;

              return (
                <tr
                  key={token.id}
                  className="group transition-colors duration-100"
                  style={{
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    background: isHot ? "rgba(245,158,11,0.025)" : isNew ? "rgba(52,211,153,0.02)" : "transparent",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.025)")}
                  onMouseLeave={e => (e.currentTarget.style.background = isHot ? "rgba(245,158,11,0.025)" : isNew ? "rgba(52,211,153,0.02)" : "transparent")}
                >
                  {/* # */}
                  <td className="px-4 py-3">
                    {isTrending && rank <= 3 ? (
                      <span
                        className="inline-flex items-center justify-center w-6 h-6 rounded-md text-[11px] font-black"
                        style={{
                          background: rank === 1 ? "linear-gradient(135deg,#f59e0b,#d97706)" : rank === 2 ? "linear-gradient(135deg,#b3b3b3,#b3b3b3)" : "linear-gradient(135deg,#b45309,#92400e)",
                          color: rank === 1 ? "#000" : rank === 2 ? "#fff" : "#fde68a",
                        }}
                      >{rank}</span>
                    ) : (
                      <span className="text-[12px] text-muted-foreground/60 font-mono tabular-nums">{rank}</span>
                    )}
                  </td>

                  {/* Token */}
                  <td className="px-4 py-3">
                    <Link href={`/coin/${token.address}`} className="flex items-center gap-3 min-w-0 group/row">
                      <div className="relative shrink-0">
                        <div className="w-9 h-9 rounded-lg overflow-hidden ring-1 ring-white/[0.08]">
                          {isPlaceholder(token.symbol) ? (
                            <div className="w-full h-full flex items-center justify-center" style={{ background: tokenCardBackground(token.symbol) }}>
                              <span className="flex gap-0.5">
                                {[0,150,300].map(d => <span key={d} className="w-1 h-1 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
                              </span>
                            </div>
                          ) : (
                            <TokenImage imageUrl={token.imageUrl} symbol={token.symbol} textSize="text-base" />
                          )}
                        </div>
                        <PlatformDot platform={token.platform as PlatformId} className="absolute -bottom-0.5 -right-0.5 w-3 h-3 ring-1 ring-black" />
                      </div>
                      <div className="min-w-0 flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[14px] text-foreground group-hover/row:text-primary transition-colors truncate max-w-[140px] leading-none">
                            {token.name}
                          </span>
                          {isHot && <span className="shrink-0 text-[9px] font-black text-amber-400 bg-amber-400/10 border border-amber-400/25 px-1 py-0.5 rounded leading-none">HOT</span>}
                          {isNew && !isHot && <span className="shrink-0 text-[9px] font-black text-emerald-400 bg-emerald-400/10 border border-emerald-400/25 px-1 py-0.5 rounded leading-none">NEW</span>}
                          {token.graduated && <span className="shrink-0 text-[9px] font-black text-primary bg-primary/10 border border-primary/25 px-1 py-0.5 rounded leading-none">GRAD</span>}
                        </div>
                        <span className="text-[12px] font-mono text-muted-foreground/75 leading-none">{displaySymbol(token.symbol)}</span>
                      </div>
                    </Link>
                  </td>

                  {/* Price */}
                  <td className="px-4 py-3 text-right hidden md:table-cell">
                    <span className="font-mono text-[13px] text-foreground/80 tabular-nums">
                      {solPrice && price > 0 ? formatTokenPrice(price * solPrice) : <span className="text-muted-foreground/30">—</span>}
                    </span>
                  </td>

                  {/* Market Cap */}
                  <td className="px-4 py-3 text-right hidden sm:table-cell">
                    <span className="font-mono text-[13px] font-semibold text-foreground tabular-nums">
                      {formatMCUsd(token.marketCapEth, solPrice)}
                    </span>
                  </td>

                  {/* 24h % */}
                  <td className="px-4 py-3 text-right hidden md:table-cell">
                    {pct != null ? (
                      <span
                        className="inline-block font-mono text-[12px] font-bold px-2 py-0.5 rounded"
                        style={{
                          color: pctUp ? "#4ade80" : "#f87171",
                          background: pctUp ? "rgba(74,222,128,0.08)" : "rgba(248,113,113,0.08)",
                          border: `1px solid ${pctUp ? "rgba(74,222,128,0.2)" : "rgba(248,113,113,0.2)"}`,
                        }}
                      >{fmtPct(pct)}</span>
                    ) : (
                      <span className="text-muted-foreground/25 text-xs">—</span>
                    )}
                  </td>

                  {/* Trades/hr */}
                  {isTrending && (
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <ActivityBar value={token.trades1h ?? 0} max={maxTrades1h} />
                    </td>
                  )}

                  {/* Volume */}
                  {isVolume && (
                    <td className="px-4 py-3 text-right hidden lg:table-cell">
                      <span className="font-mono text-[13px] font-semibold text-primary tabular-nums">
                        {vol > 0 ? formatMCUsd(token.volumeEth, solPrice) : <span className="text-muted-foreground/30">—</span>}
                      </span>
                    </td>
                  )}

                  {/* Age */}
                  <td className="px-4 py-3 text-right hidden xl:table-cell">
                    <span className="font-mono text-[12px]" style={{ color: "#4ade80" }}>{timeAgo(token.createdAt)}</span>
                  </td>

                  {/* Trade button */}
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/coin/${token.address}`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-bold transition-all duration-150"
                      style={{ background: "rgba(59,130,246,0.10)", color: "#60a5fa", border: "1px solid rgba(59,130,246,0.20)" }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(59,130,246,0.85)"; (e.currentTarget as HTMLElement).style.color = "#fff"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "rgba(59,130,246,0.10)"; (e.currentTarget as HTMLElement).style.color = "#60a5fa"; }}
                    >
                      Trade <ArrowRight className="w-3 h-3" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Rank badge config ────────────────────────────────────────────────────────
const RANK_STYLES: Record<number, { bg: string; text: string; border: string }> = {
  1: { bg: "linear-gradient(135deg,#f59e0b,#d97706)", text: "#000", border: "rgba(251,191,36,0.5)" },
  2: { bg: "linear-gradient(135deg,#b3b3b3,#b3b3b3)", text: "#fff", border: "rgba(136,136,136,0.4)" },
  3: { bg: "linear-gradient(135deg,#b45309,#92400e)", text: "#fde68a", border: "rgba(180,83,9,0.4)" },
};

// ─── Grid card ────────────────────────────────────────────────────────────────
/** Format a pct change number as "+1.23%", "-0.45%", "+1.5K%" for ≥ 1000% */
function fmtPct(pct: number | null | undefined): string | null {
  if (pct == null || !isFinite(pct)) return null;
  return formatPct(pct);
}

function TokenCard({ token, rank, solPrice, activeTab }: { token: DisplayToken; rank: number; solPrice: number | null; activeTab: SortTab }) {
  const rankStyle = RANK_STYLES[rank];
  const isTrending = activeTab === "Trending";
  const isVolume   = activeTab === "Volume";
  const isGraduated = activeTab === "Graduated";
  const isHot = isTrending && rank <= 3;
  const fmtTrades = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
  const vol = parseFloat(token.volumeEth ?? "0") || 0;

  // pctChange pill — show on Trending and Volume tabs
  const pctStr  = (isTrending || isVolume) ? fmtPct(token.pctChange24h) : null;
  const pctUp   = (token.pctChange24h ?? 0) >= 0;
  const pctColor = pctUp ? "#4ade80" : "#f87171";
  const pctBg   = pctUp ? "rgba(74,222,128,0.10)" : "rgba(248,113,113,0.10)";

  return (
    <Link
      href={`/coin/${token.address}`}
      className={cn(
        "flex flex-col bg-card border rounded-sm cursor-pointer group relative card-lift",
        isHot
          ? "border-amber-500/30 hover:border-amber-400/60 shadow-[0_0_14px_rgba(245,158,11,0.10)]"
          : token.graduated
            ? "border-primary/25 hover:border-primary/60"
            : token.isLive
              ? "border-emerald-500/30 hover:border-emerald-400/60 shadow-[0_0_12px_rgba(52,211,153,0.08)]"
              : "border-border/60 hover:border-primary/50"
      )}
    >
      <div className="aspect-square w-full bg-muted border-b border-border/50 relative overflow-hidden rounded-t-sm">
        {isPlaceholder(token.symbol) ? (
          <div className="w-full h-full flex items-center justify-center" style={{ background: tokenCardBackground(token.symbol) }}>
            <span className="flex gap-1.5 items-center">
              <span className="w-2.5 h-2.5 rounded-full bg-white/30 animate-bounce [animation-delay:0ms]" />
              <span className="w-2.5 h-2.5 rounded-full bg-white/30 animate-bounce [animation-delay:150ms]" />
              <span className="w-2.5 h-2.5 rounded-full bg-white/30 animate-bounce [animation-delay:300ms]" />
            </span>
          </div>
        ) : (
          <TokenImage imageUrl={token.imageUrl} symbol={token.symbol} textSize="text-5xl"
            className="group-hover:scale-[1.07] transition-transform duration-500 ease-out" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

        {/* Rank badge — top-left, Trending only */}
        {isTrending && (
          <div
            className="absolute top-2 left-2 min-w-[26px] h-[22px] flex items-center justify-center rounded-md text-[11px] font-black px-1.5 backdrop-blur-sm"
            style={{
              background: rankStyle?.bg ?? "rgba(0,0,0,0.55)",
              color: rankStyle?.text ?? "#b3b3b3",
              border: `1px solid ${rankStyle?.border ?? "rgba(255,255,255,0.12)"}`,
              textShadow: rank <= 3 ? "0 1px 2px rgba(0,0,0,0.4)" : "none",
            }}
          >
            #{rank}
          </div>
        )}

        {/* Top-right badges */}
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          {isHot && (
            <div className="flex items-center gap-0.5 bg-black/60 border border-amber-500/40 text-amber-400 text-[10px] font-bold px-1.5 py-0.5 rounded-sm backdrop-blur-md">
              <Flame className="w-2.5 h-2.5" />HOT
            </div>
          )}
          {token.graduated && (
            <div className="flex items-center gap-0.5 bg-primary/20 border border-primary/50 text-primary text-[10px] uppercase font-bold px-1.5 py-0.5 rounded-sm backdrop-blur-md animate-pulseGlow">
              <GraduationCap className="w-2.5 h-2.5" /> Grad
            </div>
          )}
        </div>
      </div>

      <div className="p-3 flex flex-col gap-1.5">
        <span className="font-semibold text-foreground text-[16px] truncate leading-tight group-hover:text-primary transition-colors duration-200">{token.name}</span>
        <div className="flex justify-between items-center gap-1">
          <span className="text-muted-foreground font-mono text-[14px] truncate">{displaySymbol(token.symbol)}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* pct change pill — Trending & Volume tabs */}
            {pctStr && (
              <span
                className="font-mono text-[12px] font-bold px-1.5 py-0.5 rounded-sm"
                style={{ color: pctColor, background: pctBg, border: `1px solid ${pctColor}30` }}
              >
                {pctStr}
              </span>
            )}
            <span className="text-foreground font-mono text-[16px] font-semibold">
              {formatMCUsd(token.marketCapEth, solPrice)} <span className="text-muted-foreground/60 font-normal text-[14px]">MC</span>
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          {/* Bottom-left: volume for Volume tab, age otherwise */}
          {isVolume ? (
            <span className="flex items-center gap-1 text-[13px] text-primary font-mono font-semibold">
              <BarChart2 className="w-3 h-3" />
              {vol > 0 ? formatMCUsd(token.volumeEth, solPrice) : "—"}
              <span className="text-muted-foreground/50 font-normal text-[11px]">vol</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[14px] text-emerald-400 font-mono">
              <Clock className="w-3 h-3 text-emerald-400" />
              {timeAgo(token.createdAt)}
            </span>
          )}
          {/* Bottom-right on Trending: trades/hr (amber) if hot, else all-time count */}
          {isTrending && (() => {
            const t1h = token.trades1h ?? 0;
            const fallback = token.tradeCount ?? 0;
            if (t1h > 0) return (
              <span className="flex items-center gap-1 text-[12px] font-mono" style={{ color: "#f59e0b" }}>
                <Flame className="w-3 h-3" />
                {fmtTrades(t1h)}<span className="text-muted-foreground/50 text-[10px]">/hr</span>
              </span>
            );
            if (fallback > 0) return (
              <span className="flex items-center gap-1 text-[12px] font-mono" style={{ color: "#b3b3b3" }}>
                <BarChart2 className="w-3 h-3" />
                {fmtTrades(fallback)}
              </span>
            );
            return null;
          })()}
        </div>
      </div>
    </Link>
  );
}

// ─── Platform filter strip ────────────────────────────────────────────────────
function PlatformFilterStrip({
  selected,
  onChange,
  liveCount,
  connected,
}: {
  selected: string;
  onChange: (p: string) => void;
  liveCount: number;
  connected: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex items-center gap-2 mb-2">
      {/* Scrollable tab strip */}
      <div
        ref={scrollRef}
        className="flex gap-1.5 overflow-x-auto scrollbar-hide snap-x flex-1 -mx-1 px-1"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {PLATFORM_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className={cn(
              "snap-start shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-normal border transition-all duration-150 whitespace-nowrap",
              selected === opt.id
                ? "bg-primary/15 border-primary/40 text-primary shadow-[0_0_8px_rgba(59,130,246,0.15)]"
                : "bg-card border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
            )}
          >
            {opt.logoUrl
              ? <img src={opt.logoUrl} alt={opt.label} className="w-4 h-4 rounded-sm object-cover" />
              : <span className="text-sm leading-none">{opt.emoji}</span>
            }
            <span>{opt.label}</span>
          </button>
        ))}
      </div>

      {/* Live feed status indicator — only visible when disconnected */}
      {!connected && <ReconnectingChip title="Live feed disconnected — reconnecting…" />}
    </div>
  );
}

// pump.fun bonding curve fills when ~85 SOL is raised.
// Market cap at that point (in lamports stored as marketCapEth) is ~85 SOL.
// We use this as a client-side proxy for "completed bonding curve."
const PUMP_GRADUATION_LAMPORTS = 85_000_000_000;

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const solPrice = useSolPrice();

  // ── Platform filter (URL-synced) ──────────────────────────────────────────
  const [platformFilter, setPlatformFilter] = useState<string>(getPlatformFromUrl);

  function handlePlatformChange(p: string) {
    setPlatformFilter(p);
    setPlatformInUrl(p);
    // Reset live token count display when switching platforms
    setSeenLiveAddresses(new Set());
  }

  function handleTabChange(tab: SortTab) {
    setActiveTab(tab);
    setPage(1);
    setTabInUrl(tab);
  }

  // Sync tab state with browser back / forward navigation
  useEffect(() => {
    const onPopState = () => setActiveTab(getTabFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // ── Mobile detection ─────────────────────────────────────────────────────
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── Sort / filter state (tab is URL-synced; Trending is the clean default) ─
  const [activeTab, setActiveTab]   = useState<SortTab>(getTabFromUrl);
  const [viewMode, setViewMode]     = useState<ViewMode>("grid");
  const [search, setSearch]         = useState("");
  const [minMcap, setMinMcap]       = useState("");
  const [onlyGraduated, setOnlyGraduated] = useState(false);
  const [onlyWithImage, setOnlyWithImage] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage]               = useState(1);
  const PAGE_SIZE     = isMobile ? 24 : 50;   // paginated tabs (Trending / Volume / Graduated)
  const NEW_PAGE_SIZE = isMobile ? 50 : 100;  // New tab: 100 per page with pagination

  // ── Live feed ─────────────────────────────────────────────────────────────
  const { liveTokens, liveTradeStats, connected } = useFeedStream();
  // Track which live token addresses have been seen since last platform switch
  const [seenLiveAddresses, setSeenLiveAddresses] = useState<Set<string>>(new Set());
  const [bubbleInfoOpen, setBubbleInfoOpen] = useState(false);

  useEffect(() => {
    if (liveTokens.length === 0) return;
    setSeenLiveAddresses((prev) => {
      const next = new Set(prev);
      liveTokens.forEach((t) => next.add(t.address));
      return next;
    });
  }, [liveTokens]);

  // ── API data ──────────────────────────────────────────────────────────────
  const sortMap: Record<SortTab, ListTokensSort> = {
    "New":       ListTokensSort.newest,
    "Trending":  ListTokensSort.trending,
    "Volume":    ListTokensSort.volume,
    "Graduated": ListTokensSort.marketcap,
  };

  // Reset to page 1 whenever any filter/tab/platform changes
  useEffect(() => { setPage(1); }, [activeTab, platformFilter, search, minMcap, onlyGraduated, onlyWithImage]);

  const isNewTab = activeTab === "New";
  const activePageSize = isNewTab ? NEW_PAGE_SIZE : PAGE_SIZE;
  const listParams = {
    sort: sortMap[activeTab],
    // Graduated tab uses client-side mcap threshold — no server-side flag needed
    graduated: undefined as boolean | undefined,
    limit: activePageSize,
    offset: (page - 1) * activePageSize,
    platform: platformFilter === "all" ? undefined : platformFilter as ListTokensPlatform,
  };
  const { data: rawTokens, isLoading: loadingTokens } = useListTokens(listParams, {
    // Re-fetch every 30 s so logos and market caps that resolved after the
    // initial load (via enrichment or IPFS fetch) appear without a manual refresh.
    query: { refetchInterval: 15_000, staleTime: 12_000, queryKey: getListTokensQueryKey(listParams) },
  });


  // Bubble map: top trending tokens by smart score (5m + 1h activity).
  // Poll every 30s — trending rankings shift faster than all-time volume.
  // staleTime=25s prevents redundant refetches on window-focus / tab switch.
  // refetchOnWindowFocus=false avoids hammering the API when the user alt-tabs.
  // Newest sort — bubbles reflect the latest launches so the map feels live.
  // 5 s poll matches the server-side cache TTL for sort=newest, so every tick
  // gets a genuinely fresh list without hammering the DB.
  const bubbleListParams = { sort: ListTokensSort.volume, limit: 30 };
  const { data: bubbleRawTokens, isError: bubbleError } = useListTokens(
    bubbleListParams,
    {
      query: {
        refetchInterval:      5_000,
        staleTime:            4_000,
        refetchOnWindowFocus: false,
        queryKey:             getListTokensQueryKey(bubbleListParams),
      },
    }
  );
  // NOTE: liveTradeStats is intentionally NOT in this dep array.
  // Adding it would recompute bubbleTokens on every incoming trade, producing a
  // new array reference → BubbleMap's layout useEffect fires → runLayout() runs
  // → all bubbles scatter on every tick. Live price/color updates reach BubbleMap
  // via the separate `liveUpdates` prop which updates colors without re-layout.
  const bubbleTokens = useMemo<TokenBubbleInput[]>(() => {
    if (!bubbleRawTokens) return [];
    return bubbleRawTokens.map(t => ({
      address:      t.address,
      symbol:       t.symbol,
      name:         t.name,
      imageUrl:     t.imageUrl,
      marketCapEth: t.marketCapEth,
      volumeEth:    t.volumeEth,
      priceEth:     t.priceEth,
      platform:     t.platform ?? "unknown",
      pctChange24h: t.pctChange24h ?? null,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubbleRawTokens]);

  // ── Merge live + API tokens ───────────────────────────────────────────────
  const tokens = useMemo<DisplayToken[] | undefined>(() => {
    // Filter live tokens by selected platform
    const filteredLive: FeedToken[] = platformFilter === "all"
      ? liveTokens
      : liveTokens.filter((t) =>
          platformFilter === "raydium_launchlab"
            ? (t.platform === "raydium_launchlab" || (t.platform === "pump_fun" && t.graduated))
            : t.platform === platformFilter
        );

    // Build a lookup: address → live FeedToken (for merging into API rows)
    const liveByAddress = new Map<string, FeedToken>(
      filteredLive.map((t) => [t.address, t])
    );

    // API tokens as DisplayToken, with live metadata merged in when present
    let apiDisplay: DisplayToken[] = (rawTokens ?? []).map((t): DisplayToken => {
      const live      = liveByAddress.get(t.address);
      const tradeSnap = liveTradeStats.get(t.address);
      return {
        id:           t.id,
        address:      t.address,
        name:         t.name,
        symbol:       t.symbol,
        imageUrl:     live?.imageUrl ?? t.imageUrl,
        // Overlay live trade stats when available — keeps cards current without polling
        marketCapEth: tradeSnap?.marketCapEth ?? t.marketCapEth,
        priceEth:     tradeSnap?.priceEth     ?? t.priceEth,
        volumeEth:    tradeSnap?.volumeEth    ?? t.volumeEth,
        graduatedAt:  t.graduatedAt,
        createdAt:    t.createdAt,
        platform:     t.platform ?? "unknown",
        graduated:    t.graduated,
        // Preserve isLive=true if feed still considers this token new
        isLive:       live?.isNew ?? false,
        lastTradeAt:  tradeSnap?.lastTradeAt,
        tradeCount:   t.tradeCount,
        trades1h:     t.trades1h ?? null,
        pctChange24h: t.pctChange24h ?? null,
      };
    });

    // Live tokens not yet in the API response (very recent launches)
    const apiAddresses = new Set((rawTokens ?? []).map((t) => t.address));
    const liveOnly: DisplayToken[] = filteredLive
      .filter((t) => !apiAddresses.has(t.address))
      .map((t): DisplayToken => {
        const tradeSnap = liveTradeStats.get(t.address);
        return {
          id:           `live-${t.address}`,
          address:      t.address,
          name:         t.name,
          symbol:       t.symbol,
          imageUrl:     t.imageUrl,
          marketCapEth: tradeSnap?.marketCapEth ?? t.marketCapEth,
          priceEth:     tradeSnap?.priceEth     ?? t.priceEth,
          // Pull volume + trade count from the live trade snapshot so cards
          // show real numbers from the first trade rather than blanks/zeros.
          volumeEth:    tradeSnap?.volumeEth    ?? "0",
          // Fall back to the token-level count carried in the SSE replay payload
          // so replayed tokens (already traded) aren't hidden by the tradeCount > 0 filter.
          tradeCount:   tradeSnap?.tradeCount   ?? t.tradeCount ?? 0,
          // 24h change and trades/hr have no history yet for brand-new tokens
          pctChange24h: null,
          trades1h:     null,
          createdAt:    t.createdAt,
          platform:     t.platform ?? "unknown",
          graduated:    false,
          isLive:       t.isNew,
          lastTradeAt:  tradeSnap?.lastTradeAt,
        };
      });

    // Apply client-side filters
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      apiDisplay = apiDisplay.filter(
        (t) => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q)
      );
    }
    // Skip onlyGraduated toggle on the Graduated tab — it already filters by mcap threshold below
    if (onlyGraduated && activeTab !== "Graduated") apiDisplay = apiDisplay.filter((t) => t.graduated);
    // "Has image" filter: never apply to the New tab — newly created tokens
    // take seconds→minutes to load IPFS metadata; hiding them defeats the point
    // of a "just launched" view. Show a placeholder image instead.
    if (onlyWithImage && activeTab !== "New") apiDisplay = apiDisplay.filter((t) => !!t.imageUrl);
    // Graduated tab: proxy for "bonding curve completed" — filter by pump.fun graduation mcap threshold
    if (activeTab === "Graduated") {
      apiDisplay = apiDisplay.filter((t) => (parseFloat(t.marketCapEth ?? "0") || 0) >= PUMP_GRADUATION_LAMPORTS);
    }
    if (minMcap.trim()) {
      const min = parseFloat(minMcap) || 0;
      apiDisplay = apiDisplay.filter((t) => (parseFloat(t.marketCapEth ?? "0") || 0) >= min);
    }
    if (!rawTokens) return undefined; // still loading

    // Trending tab: only show API tokens sorted by tradeCount — exclude live-feed
    // tokens (0s brand-new launches) which have zero trades and pollute the list.
    if (activeTab === "Trending") {
      return apiDisplay;
    }

    // Live SSE tokens only belong on tabs where "brand new coin" is relevant:
    //   • New      — always show live tokens (this is the point of the tab)
    //   • Trending — show on page 1 (a new coin can immediately be hot)
    //   • Volume   — NEVER: a coin just launched has zero 24h volume; showing it here
    //               contaminates the ranked list with unranked noise
    //   • Graduated — NEVER: brand-new launches haven't completed the bonding curve
    // Live SSE tokens on the New tab: always show regardless of tradeCount or
    // image — these are real-time events; filtering them defeats the feed's purpose.
    const showLive = activeTab === "New";
    const filteredLiveOnly = showLive ? liveOnly : [];
    const apiLive    = apiDisplay.filter((t) => t.isLive);
    const apiNonLive = apiDisplay.filter((t) => !t.isLive);
    const combined = [...filteredLiveOnly, ...apiLive, ...apiNonLive];
    // New tab: sort everything by creation time so live SSE tokens and API
    // tokens appear in a single newest-first order instead of live-first then API.
    if (activeTab === "New") {
      combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return combined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTokens, liveTokens, liveTradeStats, platformFilter, search, onlyGraduated, onlyWithImage, minMcap, activeTab, solPrice, page]);

  // How many live tokens visible for the current platform filter
  const visibleLiveCount = useMemo(() => {
    if (platformFilter === "all") return seenLiveAddresses.size;
    return liveTokens.filter((t) => t.platform === platformFilter && seenLiveAddresses.has(t.address)).length;
  }, [liveTokens, platformFilter, seenLiveAddresses]);

  const activeFilterCount = [
    !!search.trim(),
    onlyGraduated,
    onlyWithImage,
    !!minMcap.trim(),
  ].filter(Boolean).length;

  const clearFilters = () => {
    setSearch("");
    setMinMcap("");
    setOnlyGraduated(false);
    setOnlyWithImage(false);
    setPage(1);
  };

  const hasMore = (rawTokens?.length ?? 0) >= activePageSize;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-full bg-background text-foreground">
      <SEO
        title="Explore Solana Memecoins"
        description="Discover trending Solana memecoins in real time. Browse tokens launching on pump.fun, PumpSwap, and Raydium LaunchLab — track price, market cap, and volume all in one place."
        keywords="trending memecoins, solana tokens, bubble map, pump.fun explore, token discovery"
      />
      <div className="w-full max-w-[1400px] mx-auto pt-2 md:pt-4 px-3 md:px-5 flex-1">
        <div className="flex flex-col min-w-0">

          {/* ── Bubble Map — full width ── */}
          <section className="mb-3 md:mb-5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h2 className="text-[22px] font-extrabold text-foreground tracking-tight">Bubble Map</h2>
                <div className="relative group">
                  <Info
                    className="w-4 h-4 cursor-pointer transition-colors duration-150"
                    style={{ color: bubbleInfoOpen ? "#b3b3b3" : "rgba(136,136,136,0.75)" }}
                    onClick={() => setBubbleInfoOpen(v => !v)}
                  />
                  {/* Desktop: hover tooltip / Mobile: tap toggle */}
                  <div className={[
                    "absolute left-0 top-full mt-2 z-50 transition-opacity duration-150 w-64",
                    bubbleInfoOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto",
                  ].join(" ")}>
                    <div className="absolute left-3 -top-1.5 w-0 h-0"
                      style={{ borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderBottom: "6px solid #141414" }} />
                    <div className="rounded-lg px-3 py-2.5 text-xs leading-relaxed"
                      style={{ background: "#141414", border: "1px solid rgba(255,255,255,0.1)", color: "#bbbbbb", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                      Shows the hottest tokens right now — ranked by volume. Bubble size reflects rank. Green = price up, red = price down in the last 24h.
                    </div>
                  </div>
                  {/* Mobile backdrop — tap outside to close */}
                  {bubbleInfoOpen && (
                    <div className="fixed inset-0 z-40 md:hidden" onClick={() => setBubbleInfoOpen(false)} />
                  )}
                </div>
              </div>
            </div>
            <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>
              {bubbleTokens.length === 0 ? (
                <div className="flex items-center justify-center" style={{ height: 360, background: "#000000" }}>
                  {bubbleError ? (
                    <p className="text-sm text-muted-foreground">Failed to load bubble map — retrying…</p>
                  ) : (
                    <div className="flex gap-2.5 items-center">
                      <span className="w-2.5 h-2.5 rounded-full bg-primary/50 animate-bounce [animation-delay:0ms]" />
                      <span className="w-2.5 h-2.5 rounded-full bg-primary/50 animate-bounce [animation-delay:150ms]" />
                      <span className="w-2.5 h-2.5 rounded-full bg-primary/50 animate-bounce [animation-delay:300ms]" />
                    </div>
                  )}
                </div>
              ) : (
                <BubbleMap
                  tokens={isMobile ? bubbleTokens.slice(0, 15) : bubbleTokens}
                  liveUpdates={liveTradeStats}
                  solPrice={solPrice}
                  height={isMobile ? 240 : 380}
                  radiusScale={isMobile ? 0.55 : 1}
                />
              )}
            </div>
          </section>

          {/* ── Explore section ── */}
          <section className="flex flex-col gap-2">

            {/* Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-[22px] font-extrabold text-foreground tracking-tight">Explore coins</h2>
            </div>

            {/* Platform filter strip */}
            <PlatformFilterStrip
              selected={platformFilter}
              onChange={handlePlatformChange}
              liveCount={visibleLiveCount}
              connected={connected}
            />

            {/* Sort tabs + view controls */}
            <div className="flex items-center gap-2 justify-between overflow-x-auto scrollbar-none">
              {/* Sort tabs */}
              <div className="flex gap-1 bg-card border border-border/40 rounded-sm p-0.5">
                {(["Trending", "New", "Volume", "Graduated"] as SortTab[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => handleTabChange(tab)}
                    className={cn(
                      "px-3 py-1 text-[14px] rounded-[3px] transition-all duration-150",
                      activeTab === tab
                        ? "bg-primary text-black shadow-sm font-bold"
                        : "text-muted-foreground hover:text-foreground font-normal"
                    )}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              {/* Right controls: Filters + Grid/Table toggle */}
              <div className="flex items-center gap-2 shrink-0">
                {/* Filter toggle */}
                <button
                  onClick={() => setShowFilters((v) => !v)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border text-[14px] font-normal transition-all duration-150",
                    showFilters || activeFilterCount > 0
                      ? "bg-primary/10 border-primary/40 text-primary"
                      : "border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
                  )}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Filters
                  {activeFilterCount > 0 && (
                    <span className="bg-primary text-black text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">{activeFilterCount}</span>
                  )}
                </button>

                {/* Grid/Table toggle */}
                <div className="flex bg-card border border-border/40 rounded-sm p-0.5 gap-0.5">
                  <button
                    onClick={() => setViewMode("grid")}
                    className={cn("p-1.5 rounded-[3px] transition-all duration-150", viewMode === "grid" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}
                    title="Grid view"
                  >
                    <LayoutGrid className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setViewMode("table")}
                    className={cn("p-1.5 rounded-[3px] transition-all duration-150", viewMode === "table" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}
                    title="Table view"
                  >
                    <List className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Expandable filter panel */}
            {showFilters && (
              <div className="flex flex-wrap items-center gap-2 p-3 bg-card border border-border/40 rounded-sm animate-slideDown">
                {/* Search */}
                <div className="relative flex-1 min-w-[160px] max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name or ticker…"
                    className="pl-8 h-8 text-xs rounded-sm bg-background border-border/50"
                  />
                  {search && (
                    <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setSearch("")}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Min Market Cap */}
                <div className="relative min-w-[140px]">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs pointer-events-none">Min MC</span>
                  <Input
                    value={minMcap}
                    onChange={(e) => setMinMcap(e.target.value)}
                    placeholder=""
                    type="number"
                    min="0"
                    step="0.001"
                    className="pl-14 h-8 text-xs rounded-sm bg-background border-border/50 font-mono"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-[10px] pointer-events-none">SOL</span>
                </div>

                {/* Toggle: Graduated */}
                <button
                  onClick={() => setOnlyGraduated((v) => !v)}
                  className={cn(
                    "flex items-center gap-1.5 h-8 px-3 rounded-[8px] border text-xs font-medium transition-all duration-150",
                    onlyGraduated
                      ? "bg-primary/15 border-primary/50 text-primary"
                      : "border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
                  )}
                >
                  <GraduationCap className="w-3.5 h-3.5" />
                  Graduated
                </button>

                {/* Toggle: Has Image */}
                <button
                  onClick={() => setOnlyWithImage((v) => !v)}
                  className={cn(
                    "flex items-center gap-1.5 h-8 px-3 rounded-[8px] border text-xs font-medium transition-all duration-150",
                    onlyWithImage
                      ? "bg-primary/15 border-primary/50 text-primary"
                      : "border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
                  )}
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  Has image
                </button>

                {/* Clear */}
                {activeFilterCount > 0 && (
                  <button
                    onClick={clearFilters}
                    className="flex items-center gap-1 h-8 px-3 rounded-[8px] text-xs text-muted-foreground hover:text-destructive transition-colors ml-auto"
                  >
                    <X className="w-3.5 h-3.5" /> Clear all
                  </button>
                )}
              </div>
            )}


            {/* Token grid or table */}
            {loadingTokens ? (
              viewMode === "grid" ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2 md:gap-3 mt-1 stagger-grid">
                  {[...Array(10)].map((_, i) => <TokenCardSkeleton key={i} />)}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-white/[0.06] mt-1" style={{ background: "rgba(10,12,18,0.85)" }}>
                  <table className="w-full border-collapse min-w-[640px]">
                    <tbody>{[...Array(8)].map((_, i) => <TableRowSkeleton key={i} />)}</tbody>
                  </table>
                </div>
              )
            ) : !tokens || tokens.length === 0 ? (
              <div className="py-20 text-center text-muted-foreground border border-border/30 border-dashed rounded-sm bg-card/30 mt-1">
                <Search className="w-8 h-8 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No coins match your filters.</p>
                {activeFilterCount > 0 && (
                  <button onClick={clearFilters} className="mt-3 text-xs text-primary hover:underline">Clear filters</button>
                )}
              </div>
            ) : viewMode === "grid" ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2 md:gap-3 mt-1">
                {tokens.map((token, idx) => (
                  <TokenCard key={token.id} token={token} rank={idx + 1} solPrice={solPrice} activeTab={activeTab} />
                ))}
              </div>
            ) : (
              <div className="mt-1">
                <TableView tokens={tokens} solPrice={solPrice} activeTab={activeTab} startRank={(page - 1) * activePageSize + 1} />
              </div>
            )}

            {/* ── Pagination ── */}
            {!loadingTokens && tokens && tokens.length > 0 && (
              <div className="flex items-center justify-center gap-1.5 pt-4 pb-2">
                {/* Previous */}
                <button
                  disabled={page === 1}
                  onClick={() => { setPage(p => p - 1); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  className="flex items-center gap-1 h-8 px-3 rounded-[8px] text-[13px] font-medium border transition-all disabled:opacity-30 disabled:cursor-not-allowed border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Previous
                </button>

                {/* Page numbers */}
                {page > 2 && (
                  <>
                    <button onClick={() => { setPage(1); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                      className="h-8 w-8 rounded-[8px] text-[13px] font-medium border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-all">
                      1
                    </button>
                    {page > 3 && <span className="text-muted-foreground text-[13px] px-1">…</span>}
                  </>
                )}
                {page > 1 && (
                  <button onClick={() => { setPage(p => p - 1); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                    className="h-8 w-8 rounded-[8px] text-[13px] font-medium border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-all">
                    {page - 1}
                  </button>
                )}
                <button className="h-8 w-8 rounded-[8px] text-[13px] font-bold border border-primary bg-primary/15 text-primary cursor-default">
                  {page}
                </button>
                {hasMore && (
                  <button onClick={() => { setPage(p => p + 1); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                    className="h-8 w-8 rounded-[8px] text-[13px] font-medium border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-all">
                    {page + 1}
                  </button>
                )}

                {/* Next */}
                <button
                  disabled={!hasMore}
                  onClick={() => { setPage(p => p + 1); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  className="flex items-center gap-1 h-8 px-3 rounded-[8px] text-[13px] font-medium border transition-all disabled:opacity-30 disabled:cursor-not-allowed border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </section>

        </div>
      </div>
    </div>
  );
}
