/**
 * Global search command palette — triggered by Navbar click or ⌘K / Ctrl+K.
 * Uses the built-in CommandDialog (cmdk + Radix Dialog) with live API search.
 */
import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  useListTokens,
  useGetTrendingTokens,
  getListTokensQueryKey,
  getGetTrendingTokensQueryKey,
  ListTokensSort,
} from "@workspace/api-client-react";
import {
  CommandDialog,
  CommandList,
} from "@/components/ui/command";
import { formatMC, formatAddress } from "@/lib/utils";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { Rocket, TrendingUp, Zap, Search, ArrowRight, User } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

/* ─────────────────────────────────────── shared open state (module-level) */
type Listener = (open: boolean) => void;
const listeners = new Set<Listener>();
let _open = false;

export function openSearch() {
  _open = true;
  listeners.forEach((fn) => fn(true));
}

export function useSearchOpen() {
  const [open, setOpen] = useState(_open);

  useEffect(() => {
    const handler: Listener = (v) => setOpen(v);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  const toggle = useCallback(() => {
    _open = !_open;
    listeners.forEach((fn) => fn(_open));
  }, []);

  const close = useCallback(() => {
    _open = false;
    listeners.forEach((fn) => fn(false));
  }, []);

  return { open, toggle, close };
}


/* ─────────────────────────────────────── main dialog */
export function SearchDialog() {
  const { open, close } = useSearchOpen();
  const [query, setQuery] = useState("");
  const [, setLocation] = useLocation();

  /* ── global ⌘K / Ctrl+K shortcut ── */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        _open = !_open;
        listeners.forEach((fn) => fn(_open));
      }
      if (e.key === "Escape") {
        _open = false;
        listeners.forEach((fn) => fn(false));
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  /* ── API queries ── */
  const searchParams = { search: query, limit: 12, sort: ListTokensSort.trending };
  const { data: searchResults, isFetching } = useListTokens(searchParams, {
    query: { enabled: query.length >= 1, queryKey: getListTokensQueryKey(searchParams) },
  });

  const trendingParams = { limit: 6 };
  const { data: trending } = useGetTrendingTokens(trendingParams, {
    query: { enabled: query.length === 0, queryKey: getGetTrendingTokensQueryKey(trendingParams) },
  });

  /* ── navigation helper ── */
  const go = useCallback(
    (href: string) => {
      close();
      setQuery("");
      setLocation(href);
    },
    [close, setLocation]
  );

  const showSearch   = query.length >= 1;
  const showTrending = query.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) { _open = false; listeners.forEach((fn) => fn(false)); setQuery(""); }
      }}
    >
      {/* Override default dialog styles for a larger, darker palette */}
      <style>{`
        [role="dialog"][data-state="open"] > div {
          max-width: 620px !important;
          border: 1px solid hsl(var(--border) / 0.5) !important;
          background: #0B1220 !important;
          box-shadow: 0 25px 60px rgba(0,0,0,0.6), 0 0 0 1px hsl(var(--primary)/0.15) !important;
        }
      `}</style>

      {/* Search input */}
      <div className="flex items-center border-b border-border/40 px-4 gap-3">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search coins by name or symbol…"
          className="flex-1 h-14 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60 font-mono"
          autoFocus
        />
        {isFetching && (
          <span className="text-[10px] text-muted-foreground/50 font-mono animate-pulse">searching…</span>
        )}
        <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-border/50 bg-muted/50 px-1.5 text-[10px] font-mono text-muted-foreground/50 pointer-events-none">
          Esc
        </kbd>
      </div>

      <CommandList className="max-h-[480px] overflow-y-auto overflow-x-hidden scrollbar-none p-0">

        {/* ── Search results ── */}
        {showSearch && (
          <>
            {searchResults && searchResults.length === 0 && !isFetching && (
              <div className="py-10 text-center">
                <Search className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No coins found for <span className="font-mono text-foreground">"{query}"</span></p>
              </div>
            )}

            {isFetching && !searchResults && (
              <div className="p-3 space-y-1">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-sm">
                    <Skeleton className="h-9 w-9 rounded shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-2.5 w-24" />
                    </div>
                    <Skeleton className="h-3 w-12" />
                  </div>
                ))}
              </div>
            )}

            {searchResults && searchResults.length > 0 && (
              <div className="p-2">
                <div className="px-2 py-1.5 text-[10px] uppercase tracking-widest font-bold text-muted-foreground/60">
                  Coins — {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
                </div>
                {searchResults.map((token) => (
                  <button
                    key={token.id}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-sm hover:bg-white/[0.05] transition-colors group text-left"
                    onClick={() => go(`/app?token=${token.address}`)}
                  >
                    <TokenAvatar symbol={token.symbol} imageUrl={token.imageUrl} size={36} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-foreground truncate">{token.name}</span>
                        <span className="text-xs font-mono text-primary shrink-0">${token.symbol}</span>
                        {token.graduated && (
                          <span className="text-[9px] uppercase font-bold text-amber-400 border border-amber-400/40 px-1 py-0.5 rounded shrink-0">grad</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] font-mono text-muted-foreground">
                          MC: <span className="text-foreground">{formatMC(token.marketCapEth)}</span>
                        </span>
                        <span className="text-muted-foreground/40">·</span>
                        <span className="text-[10px] font-mono text-muted-foreground">
                          {token.tradeCount.toLocaleString()} trades
                        </span>
                      </div>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-primary transition-colors shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Trending (empty state) ── */}
        {showTrending && (
          <>
            <div className="p-2">
              <div className="px-2 py-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold text-muted-foreground/60">
                <TrendingUp className="h-3 w-3" /> Trending now
              </div>
              {!trending
                ? [...Array(5)].map((_, i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-sm">
                      <Skeleton className="h-9 w-9 rounded shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-3.5 w-36" />
                        <Skeleton className="h-2.5 w-20" />
                      </div>
                      <Skeleton className="h-3 w-10" />
                    </div>
                  ))
                : trending.map((token, i) => (
                    <button
                      key={token.id}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-sm hover:bg-white/[0.05] transition-colors group text-left"
                      onClick={() => go(`/app?token=${token.address}`)}
                    >
                      <div className="text-[10px] font-mono text-muted-foreground/40 w-4 text-right shrink-0">{i + 1}</div>
                      <TokenAvatar symbol={token.symbol} imageUrl={token.imageUrl} size={36} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-foreground truncate">{token.name}</span>
                          <span className="text-xs font-mono text-primary shrink-0">${token.symbol}</span>
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                          MC: <span className="text-foreground">{formatMC(token.marketCapEth)}</span>
                          <span className="mx-1.5 text-muted-foreground/40">·</span>
                          {token.tradeCount.toLocaleString()} trades
                        </div>
                      </div>
                      <span className="text-xs font-mono font-bold text-primary shrink-0">{formatMC(token.marketCapEth)}</span>
                    </button>
                  ))}
            </div>

            <div className="border-t border-border/30 mx-2" />

            {/* Quick nav */}
            <div className="p-2">
              <div className="px-2 py-1.5 text-[10px] uppercase tracking-widest font-bold text-muted-foreground/60">
                Quick nav
              </div>
              <button
                className="w-full flex items-center gap-3 px-3 py-2 rounded-sm hover:bg-white/[0.05] transition-colors text-left"
                onClick={() => go("/")}
              >
                <div className="h-6 w-6 rounded bg-muted/60 flex items-center justify-center shrink-0">
                  <Zap className="h-3 w-3 text-primary" />
                </div>
                <span className="text-sm text-foreground">Explore coins</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 ml-auto shrink-0" />
              </button>
              <button
                className="w-full flex items-center gap-3 px-3 py-2 rounded-sm hover:bg-white/[0.05] transition-colors text-left"
                onClick={() => go("/app")}
              >
                <div className="h-6 w-6 rounded bg-muted/60 flex items-center justify-center shrink-0">
                  <Rocket className="h-3 w-3 text-primary" />
                </div>
                <span className="text-sm text-foreground">Launch a token</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 ml-auto shrink-0" />
              </button>
            </div>
          </>
        )}

        {/* Footer hint */}
        <div className="border-t border-border/30 px-4 py-2.5 flex items-center gap-4 bg-black/30">
          <span className="text-[10px] text-muted-foreground/40 font-mono flex items-center gap-1">
            <kbd className="border border-border/40 rounded px-1 bg-muted/30">↑↓</kbd> navigate
          </span>
          <span className="text-[10px] text-muted-foreground/40 font-mono flex items-center gap-1">
            <kbd className="border border-border/40 rounded px-1 bg-muted/30">↵</kbd> open
          </span>
          <span className="text-[10px] text-muted-foreground/40 font-mono flex items-center gap-1">
            <kbd className="border border-border/40 rounded px-1 bg-muted/30">Esc</kbd> close
          </span>
        </div>
      </CommandList>
    </CommandDialog>
  );
}
