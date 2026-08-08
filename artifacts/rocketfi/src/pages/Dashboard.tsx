import { useState, useMemo, useEffect, useRef } from "react";
import {
  useListTokens,
  useGetTrendingTokens,
  ListTokensSort,
  type ListTokensPlatform,
} from "@workspace/api-client-react";

import { formatMC, formatMCUsd, cn, timeAgo, resolveImageUrl } from "@/lib/utils";
import { useSolPrice } from "@/hooks/useSolPrice";
import { TokenAvatar, tokenCardBackground } from "@/components/shared/TokenAvatar";
import { PlatformBadge, PlatformDot, type PlatformId } from "@/components/shared/PlatformBadge";
import { useFeedStream, type FeedToken, type FeedTradeStats } from "@/hooks/useFeedStream";
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
  Wifi,
  WifiOff,
  Clock,
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
  createdAt: string | number;
  platform: string;
  graduated: boolean;
  /** True while the "NEW" badge is showing (live tokens only) */
  isLive?: boolean;
  /** Unix ms of last SSE trade event — drives activity pulse on cards */
  lastTradeAt?: number;
}

// ─── Platform filter config ───────────────────────────────────────────────────
interface PlatformOption {
  id: string;
  label: string;
  emoji: string;
  logoUrl?: string;
}
const PLATFORM_OPTIONS: PlatformOption[] = [
  { id: "all",       label: "All",       emoji: "⚡" },
  { id: "pump_fun",  label: "Pump.fun",  emoji: "🐸", logoUrl: "/pumpfun.png" },
  { id: "moonshot",  label: "Moonshot",  emoji: "🌙" },
  { id: "letsbonk",  label: "LetsBONK", emoji: "🔨" },
  { id: "daos_fun",          label: "Daos.fun",  emoji: "🏛️" },
  { id: "raydium_launchlab", label: "Raydium",   emoji: "⚡" },
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
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border/20">
      <Skeleton className="h-3 w-5 shrink-0" />
      <Skeleton className="h-8 w-8 rounded-sm shrink-0" />
      <div className="flex-1 flex flex-col gap-1">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-2.5 w-16" />
      </div>
      <Skeleton className="h-3.5 w-20 hidden sm:block" />
      <Skeleton className="h-3.5 w-16 hidden md:block" />
      <Skeleton className="h-3.5 w-14 hidden lg:block" />
      <Skeleton className="h-3.5 w-16 hidden xl:block" />
      <Skeleton className="h-6 w-12 rounded-sm" />
    </div>
  );
}

// ─── Table sort header ────────────────────────────────────────────────────────
function SortTh({
  col, label, active, dir, onSort, className,
}: {
  col: TableSortKey; label: string; active: boolean; dir: TableSortDir;
  onSort: (k: TableSortKey) => void; className?: string;
}) {
  return (
    <th
      className={cn(
        "px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap",
        className
      )}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          dir === "desc" ? <ChevronDown className="w-3 h-3 text-primary" /> : <ChevronUp className="w-3 h-3 text-primary" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-30" />
        )}
      </span>
    </th>
  );
}

// ─── Table view ───────────────────────────────────────────────────────────────
function TableView({ tokens, solPrice }: { tokens: DisplayToken[]; solPrice: number | null }) {
  const [sortKey, setSortKey] = useState<TableSortKey>("rank");
  const [sortDir, setSortDir] = useState<TableSortDir>("asc");

  const handleSort = (key: TableSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  };

  const sorted = useMemo(() => {
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

  const th = (col: TableSortKey, label: string, cls?: string) => (
    <SortTh col={col} label={label} active={sortKey === col} dir={sortDir} onSort={handleSort} className={cls} />
  );

  return (
    <div className="overflow-x-auto rounded-sm border border-border/40 bg-card">
      <table className="w-full border-collapse min-w-[640px]">
        <thead>
          <tr className="border-b border-border/40 bg-muted/30">
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground w-10">#</th>
            {th("name",      "Token",      "min-w-[160px]")}
            {th("marketCap", "Mkt Cap",    "hidden sm:table-cell")}
            {th("price",     "Price",      "hidden md:table-cell")}
            <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground hidden lg:table-cell">Platform</th>
            {th("age",       "Age",        "hidden xl:table-cell")}
            <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Action</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((token, idx) => {
            const mc = parseFloat(token.marketCapEth ?? "0") || 0;
            const price = parseFloat(token.priceEth ?? "0") || 0;
            return (
              <tr
                key={token.id}
                className={cn(
                  "border-b border-border/20 last:border-0 hover:bg-primary/[0.04] transition-all duration-150 group border-l-2",
                  token.isLive
                    ? "border-l-emerald-400/60 bg-emerald-500/[0.03]"
                    : "border-l-transparent hover:border-l-primary/40"
                )}
              >
                <td className="px-3 py-3 text-xs text-muted-foreground/50 font-mono tabular-nums">{idx + 1}</td>
                <td className="px-3 py-3">
                  <Link href={`/app?token=${token.address}`} className="flex items-center gap-2.5 min-w-0">
                    <div className="relative shrink-0">
                      <div className="w-9 h-9 rounded-sm overflow-hidden">
                        {token.imageUrl ? (
                          <img src={resolveImageUrl(token.imageUrl) ?? ""} alt={token.symbol} className="w-full h-full object-cover" loading="eager" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center font-bold text-base text-white/80" style={{ background: tokenCardBackground(token.symbol) }}>
                            {isPlaceholder(token.symbol) ? (
                              <span className="flex gap-0.5 items-center">
                                <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce [animation-delay:0ms]" />
                                <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce [animation-delay:150ms]" />
                                <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce [animation-delay:300ms]" />
                              </span>
                            ) : (
                              token.symbol.replace(/^\$/, "").charAt(0).toUpperCase()
                            )}
                          </div>
                        )}
                      </div>
                      {token.graduated && (
                        <div className="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-primary rounded-full flex items-center justify-center">
                          <GraduationCap className="w-2 h-2 text-black" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-foreground group-hover:text-primary transition-colors truncate max-w-[120px] flex items-center gap-1.5">
                        {token.name}
                      </div>
                      <div className="text-[11px] font-mono text-primary">{displaySymbol(token.symbol)}</div>
                    </div>
                  </Link>
                </td>
                <td className="px-3 py-3 hidden sm:table-cell">
                  <span className="text-sm font-bold text-foreground font-mono tabular-nums inline-flex items-center gap-1.5">
                    {token.lastTradeAt && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" title="Live trade activity" />
                    )}
                    {formatMCUsd(token.marketCapEth, solPrice)}
                  </span>
                </td>
                <td className="px-3 py-3 hidden md:table-cell">
                  <span className="text-xs font-mono text-muted-foreground tabular-nums">
                    {price < 1e-6 ? price.toExponential(2) : price < 0.001 ? price.toFixed(6) : price.toFixed(4)} SOL
                  </span>
                </td>
                <td className="px-3 py-3 hidden lg:table-cell">
                  <PlatformBadge platform={token.platform as PlatformId} size="sm" />
                </td>
                <td className="px-3 py-3 hidden xl:table-cell">
                  <span className="text-xs text-muted-foreground font-mono">{timeAgo(token.createdAt)}</span>
                </td>
                <td className="px-3 py-3 text-right">
                  <Link
                    href={`/app?token=${token.address}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-sm bg-primary/10 text-primary text-xs font-bold hover:bg-primary hover:text-black transition-all duration-150"
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
  );
}

// ─── Grid card ────────────────────────────────────────────────────────────────
function TokenCard({ token, rank, solPrice }: { token: DisplayToken; rank: number; solPrice: number | null }) {
  return (
    <Link
      href={`/app?token=${token.address}`}
      className={cn(
        "flex flex-col bg-card border rounded-sm cursor-pointer group relative card-lift",
        token.isLive
          ? "border-emerald-500/30 hover:border-emerald-400/60 shadow-[0_0_12px_rgba(52,211,153,0.08)]"
          : "border-border/60 hover:border-primary/50"
      )}
    >
      <div className="aspect-square w-full bg-muted border-b border-border/50 relative overflow-hidden rounded-t-sm">
        {token.imageUrl ? (
          <img src={resolveImageUrl(token.imageUrl) ?? ""} alt={token.symbol} className="w-full h-full object-cover group-hover:scale-[1.07] transition-transform duration-500 ease-out" loading="eager" />
        ) : (
          <div className="w-full h-full flex items-center justify-center font-bold text-5xl text-white/80 group-hover:scale-105 transition-transform duration-300" style={{ background: tokenCardBackground(token.symbol) }}>
            {isPlaceholder(token.symbol) ? (
              <span className="flex gap-1.5 items-center">
                <span className="w-2.5 h-2.5 rounded-full bg-white/30 animate-bounce [animation-delay:0ms]" />
                <span className="w-2.5 h-2.5 rounded-full bg-white/30 animate-bounce [animation-delay:150ms]" />
                <span className="w-2.5 h-2.5 rounded-full bg-white/30 animate-bounce [animation-delay:300ms]" />
              </span>
            ) : (
              token.symbol.replace(/^\$/, "").charAt(0).toUpperCase()
            )}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          {token.graduated && (
            <div className="bg-primary/20 border border-primary/50 text-primary text-[10px] uppercase font-bold px-1.5 py-0.5 rounded-sm backdrop-blur-md animate-pulseGlow">
              Grad
            </div>
          )}
        </div>
      </div>
      <div className="p-3 flex flex-col gap-1.5">
        <span className="font-semibold text-foreground text-[16px] truncate leading-tight group-hover:text-primary transition-colors duration-200">{token.name}</span>
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground font-mono text-[14px]">{displaySymbol(token.symbol)}</span>
          <span className="text-foreground font-mono text-[16px] font-semibold">
            {token.lastTradeAt && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-1 align-middle" title="Live trade activity" />
            )}
            {formatMCUsd(token.marketCapEth, solPrice)} <span className="text-muted-foreground/60 font-normal text-[14px]">MC</span>
          </span>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span className="flex items-center gap-1 text-[14px] text-emerald-400 font-mono">
            <Clock className="w-3 h-3 text-emerald-400" />
            {timeAgo(token.createdAt)}
          </span>
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
              "snap-start shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold border transition-all duration-150 whitespace-nowrap",
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

    </div>
  );
}

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

  // ── Sort / filter state ───────────────────────────────────────────────────
  const [activeTab, setActiveTab]   = useState<SortTab>("New");
  const [viewMode, setViewMode]     = useState<ViewMode>("grid");
  const [search, setSearch]         = useState("");
  const [minMcap, setMinMcap]       = useState("");
  const [onlyGraduated, setOnlyGraduated] = useState(false);
  const [onlyWithImage, setOnlyWithImage] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // ── Live feed ─────────────────────────────────────────────────────────────
  const { liveTokens, liveTradeStats, connected } = useFeedStream();
  // Track which live token addresses have been seen since last platform switch
  const [seenLiveAddresses, setSeenLiveAddresses] = useState<Set<string>>(new Set());

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
    "Graduated": ListTokensSort.newest,
  };

  const { data: rawTokens, isLoading: loadingTokens } = useListTokens({
    sort: sortMap[activeTab],
    graduated: activeTab === "Graduated" ? true : undefined,
    limit: 100,
    platform: platformFilter === "all" ? undefined : platformFilter as ListTokensPlatform,
  });

  const { data: trending, isLoading: loadingTrending } = useGetTrendingTokens({ limit: 4 });

  // ── Merge live + API tokens ───────────────────────────────────────────────
  const tokens = useMemo<DisplayToken[] | undefined>(() => {
    // Filter live tokens by selected platform
    const filteredLive: FeedToken[] = platformFilter === "all"
      ? liveTokens
      : liveTokens.filter((t) => t.platform === platformFilter);

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
        createdAt:    t.createdAt,
        platform:     t.platform ?? "unknown",
        graduated:    t.graduated,
        // Preserve isLive=true if feed still considers this token new
        isLive:       live?.isNew ?? false,
        lastTradeAt:  tradeSnap?.lastTradeAt,
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
    if (onlyGraduated) apiDisplay = apiDisplay.filter((t) => t.graduated);
    if (onlyWithImage)  apiDisplay = apiDisplay.filter((t) => !!t.imageUrl);
    if (minMcap.trim()) {
      const min = parseFloat(minMcap) || 0;
      apiDisplay = apiDisplay.filter((t) => (parseFloat(t.marketCapEth ?? "0") || 0) >= min);
    }

    if (!rawTokens) return undefined; // still loading
    // liveOnly tokens at the top; within apiDisplay, live (isNew) rows sort first
    const apiLive    = apiDisplay.filter((t) => t.isLive);
    const apiNonLive = apiDisplay.filter((t) => !t.isLive);
    return [...liveOnly, ...apiLive, ...apiNonLive];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTokens, liveTokens, liveTradeStats, platformFilter, search, onlyGraduated, onlyWithImage, minMcap]);

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
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-full bg-background text-foreground">
      <div className="w-full max-w-[1400px] mx-auto pt-2 md:pt-4 px-3 md:px-5 flex-1">
        <div className="flex flex-col min-w-0">

          {/* Trending strip */}
          <section className="mb-3 md:mb-5">
            <div className="flex items-center justify-between mb-2 md:mb-3">
              <h2 className="text-sm font-bold text-foreground uppercase tracking-widest">Trending now</h2>
              <Link href="/app" className="text-xs text-primary hover:underline transition-all">See all</Link>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 md:pb-2 scrollbar-hide snap-x -mx-3 px-3 md:mx-0 md:px-0">
              {loadingTrending ? (
                <>{[1,2,3,4].map(i => <Skeleton key={i} className="snap-start shrink-0 w-[220px] h-[160px] rounded-sm" />)}</>
              ) : trending?.slice(0, 4).map((token, i) => (
                <Link
                  key={token.id}
                  href={`/app?token=${token.address}`}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className="snap-start shrink-0 group relative w-[160px] h-[120px] md:w-[220px] md:h-[160px] rounded-sm overflow-hidden bg-muted border border-border/60 transition-all duration-300 animate-scaleIn hover:-translate-y-1 hover:border-primary/60 hover:shadow-[0_8px_24px_hsl(142_100%_45%/0.2)]"
                >
                  {token.imageUrl ? (
                    <img src={resolveImageUrl(token.imageUrl) ?? ""} alt={token.symbol} className="absolute inset-0 w-full h-full object-cover group-hover:scale-[1.06] transition-transform duration-500 ease-out" loading="eager" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center font-bold text-5xl text-white/80" style={{ background: tokenCardBackground(token.symbol) }}>
                      {isPlaceholder(token.symbol) ? (
                        <span className="flex gap-2 items-center">
                          <span className="w-3 h-3 rounded-full bg-white/30 animate-bounce [animation-delay:0ms]" />
                          <span className="w-3 h-3 rounded-full bg-white/30 animate-bounce [animation-delay:150ms]" />
                          <span className="w-3 h-3 rounded-full bg-white/30 animate-bounce [animation-delay:300ms]" />
                        </span>
                      ) : (
                        token.symbol.replace(/^\$/, "").charAt(0).toUpperCase()
                      )}
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                  <div className="absolute bottom-3 left-3 right-3">
                    <span className="text-white font-mono text-sm font-bold drop-shadow-md block">{formatMCUsd(token.marketCapEth, solPrice)}</span>
                    <span className="text-foreground/90 text-xs font-medium truncate block drop-shadow-md">{token.name}</span>
                  </div>
                  {/* Platform badge on trending cards */}
                  <div className="absolute top-2 left-2">
                    <PlatformBadge platform={token.platform as PlatformId} size="sm" iconOnly />
                  </div>
                  {token.graduated && (
                    <div className="absolute top-2 right-2 bg-primary/20 border border-primary/50 text-primary text-[10px] uppercase font-bold px-1.5 py-0.5 rounded-sm backdrop-blur-md animate-pulseGlow">
                      Grad
                    </div>
                  )}
                </Link>
              ))}
            </div>
          </section>

          {/* ── Explore section ── */}
          <section className="flex flex-col gap-2">

            {/* Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-[20px] font-medium text-foreground">Explore coins</h2>
            </div>

            {/* Platform filter strip */}
            <PlatformFilterStrip
              selected={platformFilter}
              onChange={handlePlatformChange}
              liveCount={visibleLiveCount}
              connected={connected}
            />

            {/* Sort tabs + view controls */}
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Sort tabs */}
                <div className="flex gap-1 bg-card border border-border/40 rounded-sm p-0.5">
                  {(["New", "Trending", "Volume", "Graduated"] as SortTab[]).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={cn(
                        "px-3 py-1 text-[14px] font-bold rounded-[3px] transition-all duration-150",
                        activeTab === tab
                          ? "bg-primary text-black shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Filter toggle */}
                <button
                  onClick={() => setShowFilters((v) => !v)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-sm border text-[14px] font-medium transition-all duration-150",
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
              </div>

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
                    "flex items-center gap-1.5 h-8 px-3 rounded-sm border text-xs font-medium transition-all duration-150",
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
                    "flex items-center gap-1.5 h-8 px-3 rounded-sm border text-xs font-medium transition-all duration-150",
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
                    className="flex items-center gap-1 h-8 px-3 rounded-sm text-xs text-muted-foreground hover:text-destructive transition-colors ml-auto"
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
                <div className="rounded-sm border border-border/40 bg-card overflow-hidden mt-1">
                  {[...Array(8)].map((_, i) => <TableRowSkeleton key={i} />)}
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
                  <TokenCard key={token.id} token={token} rank={idx + 1} solPrice={solPrice} />
                ))}
              </div>
            ) : (
              <div className="mt-1">
                <TableView tokens={tokens} solPrice={solPrice} />
              </div>
            )}
          </section>

        </div>
      </div>
    </div>
  );
}
