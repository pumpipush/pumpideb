import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { 
  useCreateToken, 
  useGetToken, 
  useRecordTrade, 
  useUpdateToken,
  useTradeHistory,
  useListTokens,
  useGetTrendingTokens,
  getListTokensQueryKey,
} from "@workspace/api-client-react";
import { useWallet } from "@/contexts/WalletContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ChartCanvas, type ChartType, type Indicator, type OHLCSnapshot } from "@/components/chart/ChartCanvas";
import { IndicatorModal } from "@/components/chart/IndicatorModal";
import { tradesFromLocalBars, syntheticBars, type ChartTimeframe } from "@/lib/ohlcv";
import { tradesFromLocal, syntheticCandles, Timeframe } from "@/lib/ohlcv";
import { useTokenStream } from "@/hooks/useTokenStream";

import { ethers } from "ethers";
import { formatEth, formatAddress, parseEth, formatMC, formatMCUsd, formatUSD, cn, timeAgo } from "@/lib/utils";
import { TokenAvatar, tokenCardBackground } from "@/components/shared/TokenAvatar";
import { ShareModal } from "@/components/shared/ShareModal";
import { Search, ArrowRightLeft, Share2, Copy, Twitter, Globe, Clock, Loader2, Users, ExternalLink } from "lucide-react";
import { PlatformBadge, getPlatformUrl, type PlatformId } from "@/components/shared/PlatformBadge";
import { formatSol, formatTokenAmount } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useSolPrice } from "@/hooks/useSolPrice";
import { copyToClipboard as fireClipboard } from "@/components/shared/CopyToast";
import { useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";

function TokenDetailSkeleton() {
  return (
    <div className="flex flex-col md:flex-row gap-0 w-full animate-slideDown">
      <div className="flex-1 min-w-0 pr-0 md:pr-8 md:border-r border-border/50 pb-8">
        <div className="flex gap-4 items-start mb-6">
          <Skeleton className="h-16 w-16 shrink-0 rounded-sm" />
          <div className="flex flex-col gap-2 pt-1 w-full max-w-sm">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-1/2 mt-1" />
          </div>
        </div>
        <div className="mb-6 flex gap-3">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
        <Skeleton className="w-full h-[340px] mb-3 rounded-sm" />
        <Skeleton className="w-full h-8 mb-10" />
        <div className="mb-10">
          <Skeleton className="h-4 w-full mb-3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <div className="w-full md:w-[350px] shrink-0 pl-0 md:pl-8 md:sticky top-6 self-start pt-8 md:pt-0 space-y-6">
        <div className="bg-card border border-border p-4 rounded-sm space-y-5">
          <div className="flex gap-2"><Skeleton className="h-10 flex-1" /><Skeleton className="h-10 flex-1" /></div>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
        <div className="bg-card border border-border p-4 rounded-sm space-y-4">
          <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-full" />
        </div>
      </div>
    </div>
  );
}

export default function AppInterface() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const tokenParam = searchParams.get("token");

  const { wallet } = useWallet();
  const [activeTab, setActiveTab] = useState<string>(tokenParam ? "trade" : "launch");
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(tokenParam);

  // Bug fix: always sync selectedTokenId to URL param — handles both A→B and token→null transitions
  useEffect(() => {
    if (tokenParam) {
      setActiveTab("trade");
      setSelectedTokenId(tokenParam);
    } else {
      setSelectedTokenId(null);
    }
  }, [tokenParam]);

  const selectToken = (address: string) => {
    setSelectedTokenId(address);
    setActiveTab("trade");
    setLocation(`/app?token=${address}`);
  };

  const TAB_TRIGGER = "rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-transparent px-5 py-2.5 text-sm text-muted-foreground hover:text-foreground transition-all duration-150 data-[state=active]:shadow-none";

  return (
    <div className="flex flex-col">

      {/* ── Tab strip ── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
        <div className="shrink-0 border-b border-border/30 px-4 md:px-5">
          <TabsList className="flex justify-start bg-transparent p-0 h-auto rounded-none gap-0">
            <TabsTrigger value="launch"    className={TAB_TRIGGER}>Launch Token</TabsTrigger>
            <TabsTrigger value="trade"     className={TAB_TRIGGER}>Trade</TabsTrigger>
            <TabsTrigger value="portfolio" className={TAB_TRIGGER}>My Tokens</TabsTrigger>
          </TabsList>
        </div>

        {/* ── Token trade view — full-bleed, no container ── */}
        <TabsContent value="trade" className="flex-1 mt-0 outline-none min-h-0">
          <TradeTab wallet={wallet} selectedAddress={selectedTokenId} onSelectToken={selectToken} />
        </TabsContent>

        {/* ── Other tabs — contained ── */}
        <TabsContent value="launch" className="mt-0 outline-none">
          <div className="max-w-[1200px] mx-auto px-3 md:px-6 py-3 md:py-5 flex flex-col lg:flex-row gap-4 md:gap-6">
            <div className="flex-1 min-w-0">
              <LaunchTab wallet={wallet} onLaunch={(address) => selectToken(address)} />
            </div>
            <div className="w-full lg:w-[300px] shrink-0">
              <TrendingSidebar onSelectToken={selectToken} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="portfolio" className="mt-0 outline-none">
          <div className="max-w-[1200px] mx-auto px-3 md:px-6 py-3 md:py-5 flex flex-col lg:flex-row gap-4 md:gap-6">
            <div className="flex-1 min-w-0">
              <PortfolioTab wallet={wallet} onSelectToken={selectToken} />
            </div>
            <div className="w-full lg:w-[300px] shrink-0">
              <TrendingSidebar onSelectToken={selectToken} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- TAB COMPONENTS ---

function LaunchTab({ wallet, onLaunch }: { wallet: string | null, onLaunch: (addr: string) => void }) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [desc, setDesc] = useState("");
  
  const createToken = useCreateToken();
  const { toast } = useToast();

  const handleLaunch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet) {
      toast({ title: "Wallet required", description: "Connect your wallet to launch a token.", variant: "destructive" });
      return;
    }
    
    if (!name.trim() || !symbol.trim()) {
      toast({ title: "Missing fields", description: "Token name and ticker cannot be blank.", variant: "destructive" });
      return;
    }
    if (symbol.trim().length > 10) {
      toast({ title: "Ticker too long", description: "Ticker symbol must be 10 characters or fewer.", variant: "destructive" });
      return;
    }

    try {
      const mockAddr = ethers.Wallet.createRandom().address;
      const initialSupply = parseEth("1000000000"); // 1B tokens
      
      const vEth = parseEth("3");
      const vToken = parseEth("1073000000");

      const res = await createToken.mutateAsync({
        data: {
          name,
          symbol: symbol.toUpperCase(),
          description: desc,
          address: mockAddr,
          creatorAddress: wallet,
          totalSupply: initialSupply,
          virtualEthReserves: vEth,
          virtualTokenReserves: vToken,
        }
      });

      toast({
        title: "Token launched! 🚀",
        description: `$${symbol.toUpperCase()} is live on the bonding curve.`,
      });
      
      onLaunch(res.address);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      toast({ title: "Launch failed", description: msg, variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-5 lg:gap-8 max-w-[900px] mx-auto">
      {/* Form Column */}
      <div className="flex-1 space-y-4">
        <div>
          <h2 className="text-lg font-bold text-foreground mb-0.5">Launch a new coin</h2>
          <p className="text-xs text-muted-foreground">Tokens are created instantly. No presale, no team allocation.</p>
        </div>
        
        <form onSubmit={handleLaunch} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">description</label>
            <Textarea placeholder="What is this token about?" value={desc} onChange={e => setDesc(e.target.value)} className="rounded-sm bg-card border-border min-h-[72px] focus-visible:ring-primary transition-all resize-none" />
          </div>
          
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">name <span className="text-destructive">*</span></label>
              <Input placeholder="Token Name" value={name} onChange={e => setName(e.target.value)} className="rounded-sm bg-card border-border h-9 focus-visible:ring-primary transition-all" required />
            </div>
            
            <div className="space-y-1">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">ticker <span className="text-destructive">*</span></label>
              <Input placeholder="TICKER" value={symbol} onChange={e => setSymbol(e.target.value)} className="rounded-sm bg-card border-border h-9 focus-visible:ring-primary uppercase transition-all" required />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">image</label>
            <div className="h-20 border border-dashed border-border/50 rounded-sm flex items-center justify-center text-muted-foreground text-sm hover:border-primary/50 hover:text-primary transition-colors cursor-pointer bg-card">
               drag and drop an image
            </div>
          </div>

          <div className="pt-2 border-t border-border/50">
             <Button type="submit" className="w-full h-10 text-sm font-bold rounded-sm bg-primary hover:bg-primary/90 text-white shadow-none transition-all duration-150" disabled={createToken.isPending}>
               {createToken.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "create coin"}
             </Button>
             <div className="text-center mt-2 text-xs font-mono text-muted-foreground">
               Cost to deploy: ~0.02 SOL
             </div>
          </div>
        </form>
      </div>

      {/* Preview Column */}
      <div className="w-full lg:w-[320px] shrink-0">
         <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Preview</div>
         <div className="p-4 border border-border/50 rounded-sm bg-card hover:border-primary/40 hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.3)] transition-all cursor-default group h-full">
           <div className="flex gap-4 mb-3">
              <TokenAvatar symbol={symbol || "?"} size={56} shape="square" className="border border-border/50" />
              <div className="min-w-0 flex-1 pt-1">
                <div className="font-bold text-foreground truncate leading-tight transition-colors">{name || "Token Name"}</div>
                <div className="text-xs font-mono text-primary mt-0.5 truncate">ticker: ${symbol ? symbol.toUpperCase() : "TICKER"}</div>
              </div>
           </div>
           <p className="text-sm text-muted-foreground line-clamp-4 leading-relaxed mb-4">
             {desc || "Token description will appear here. The community will see this when they view your token."}
           </p>
           <div className="text-[10px] font-mono text-muted-foreground border-t border-border/50 pt-3">Created by {wallet ? formatAddress(wallet) : "0x..."}</div>
         </div>
      </div>
    </div>
  );
}

function TradeTab({ wallet, selectedAddress, onSelectToken }: { wallet: string | null, selectedAddress: string | null, onSelectToken: (addr: string) => void }) {
  const [search, setSearch] = useState("");
  const { data: searchResults } = useListTokens({ search }, { query: { enabled: search.length > 1, queryKey: getListTokensQueryKey({ search }) } });
  
  const { data: token, refetch: refetchToken, isLoading: loadingToken, isError: tokenError } = useGetToken(selectedAddress || "", { 
    query: { 
      enabled: !!selectedAddress,
      queryKey: ["getToken", selectedAddress]
    } 
  });
  
  const { data: history, refetch: refetchHistory, isLoading: loadingHistory } = useTradeHistory(selectedAddress || "", {
    query: {
      enabled: !!selectedAddress,
      queryKey: ["tradeHistory", selectedAddress]
    }
  });

  const recordTrade = useRecordTrade();
  const updateToken = useUpdateToken();
  const { toast } = useToast();
  const solPrice = useSolPrice();

  // Live SSE stream — real-time trade events
  const { liveTrades, liveToken, connected } = useTokenStream(selectedAddress);

  const [tradeMode, setTradeMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [shareOpen, setShareOpen] = useState(false);
  // Bug fix: React state for tx/holders sub-tab instead of imperative DOM manipulation
  const [activeSubTab, setActiveSubTab] = useState<"tx" | "holders">("tx");

  // New chart state
  const [chartTf, setChartTf] = useState<ChartTimeframe>("15m");
  const [chartType, setChartType] = useState<ChartType>("candle");
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [indOpen, setIndOpen] = useState(false);
  const CHART_TIMEFRAMES: ChartTimeframe[] = ["1m", "5m", "15m", "1H", "4H", "1D", "1W"];
  const toggleIndicator = useCallback((ind: Indicator) => {
    setIndicators(prev => prev.includes(ind) ? prev.filter(i => i !== ind) : [...prev, ind]);
  }, []);

  // Keep a ref so the crosshair callback always reads the latest solPrice without re-creating
  const solPriceRef = useRef<number | null>(solPrice);
  solPriceRef.current = solPrice;

  // ── Price / Vol / % stats (used both above chart and removed from right panel) ──
  const priceStats = useMemo(() => {
    const now = Date.now();
    const livePrice = liveToken?.priceEth ? parseFloat(liveToken.priceEth) : null;
    const currentPrice = livePrice ?? (token?.priceEth ? parseFloat(token.priceEth) : 0);
    const allTradesForVol = [...liveTrades, ...(history ?? [])];
    const vol24h = allTradesForVol.reduce((acc, t) => {
      const ts = new Date(t.timestamp).getTime();
      if (!Number.isFinite(ts)) return acc;
      const amt = parseFloat(t.ethAmount ?? "0");
      return now - ts <= 86_400_000 ? acc + (Number.isFinite(amt) ? amt : 0) : acc;
    }, 0);
    const priceAt = (cutoffMs: number): number | null => {
      const cutoff = now - cutoffMs;
      const older = (history ?? [])
        .filter(t => { const ts = new Date(t.timestamp).getTime(); return Number.isFinite(ts) && ts <= cutoff; })
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      if (!older.length) return null;
      const p = parseFloat(older[0].priceEth ?? "0");
      return Number.isFinite(p) && p > 0 ? p : null;
    };
    const pct = (old: number | null): { val: string; up: boolean } | null => {
      if (!old || old === 0 || currentPrice === 0) return null;
      const diff = ((currentPrice - old) / old) * 100;
      return { val: (diff >= 0 ? "+" : "") + diff.toFixed(2) + "%", up: diff >= 0 };
    };
    // Buy / Sell breakdown for last 24h
    const trades24h = allTradesForVol.filter(t => {
      const ts = new Date(t.timestamp).getTime();
      return Number.isFinite(ts) && now - ts <= 86_400_000;
    });
    const vol24hBuy  = trades24h.filter(t => t.isBuy) .reduce((a, t) => a + (parseFloat(t.ethAmount ?? "0") || 0), 0);
    const vol24hSell = trades24h.filter(t => !t.isBuy).reduce((a, t) => a + (parseFloat(t.ethAmount ?? "0") || 0), 0);
    const txns24hBuy  = trades24h.filter(t => t.isBuy).length;
    const txns24hSell = trades24h.filter(t => !t.isBuy).length;

    return {
      currentPrice,
      vol24h,
      vol24hBuy,
      vol24hSell,
      txns24hBuy,
      txns24hSell,
      p5m:  pct(priceAt(5   * 60_000)),
      p1h:  pct(priceAt(60  * 60_000)),
      p6h:  pct(priceAt(360 * 60_000)),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveToken, token?.priceEth, liveTrades, history]);

  // OHLC crosshair display — written directly to DOM so mouse moves never trigger re-renders
  const ohlcDisplayRef = useRef<HTMLDivElement>(null);
  const onCrosshairMove = useCallback((bar: OHLCSnapshot | null) => {
    const el = ohlcDisplayRef.current;
    if (!el) return;
    if (!bar) { el.style.opacity = "0"; return; }
    el.style.opacity = "1";
    const sp = solPriceRef.current;
    const fmt = (n: number): string => {
      if (sp && n > 0) {
        const usd = n * sp;
        if (usd >= 1)       return `$${usd.toFixed(2)}`;
        if (usd >= 0.01)    return `$${usd.toFixed(4)}`;
        if (usd >= 0.0001)  return `$${usd.toFixed(6)}`;
        return `$${usd.toExponential(3)}`;
      }
      return n < 0.00001 ? n.toExponential(3) : n.toPrecision(4);
    };
    el.innerHTML = `
      <span style="color:#64748b">O <span style="color:#cbd5e1">${fmt(bar.open)}</span></span>
      <span style="color:#64748b">H <span style="color:#4ade80">${fmt(bar.high)}</span></span>
      <span style="color:#64748b">L <span style="color:#f87171">${fmt(bar.low)}</span></span>
      <span style="color:#64748b">C <span style="color:#e2e8f0">${fmt(bar.close)}</span></span>
    `;
  }, []);

  // Memoized bars — reference is stable until trades or timeframe actually change
  const chartBars = useMemo(() => {
    if (!token) return [];
    const liveAsHistory = liveTrades.map(lt => ({
      id: lt.id,
      tokenAddress: lt.tokenAddress,
      traderAddress: lt.traderAddress,
      isBuy: lt.isBuy,
      ethAmount: lt.ethAmount,
      tokenAmount: lt.tokenAmount,
      priceEth: lt.priceEth,
      txHash: lt.txHash,
      platform: lt.platform ?? "unknown",
      timestamp: lt.timestamp,
    }));
    const allTrades = [...liveAsHistory, ...(history ?? [])];
    const localBars = allTrades.length > 0 ? tradesFromLocalBars(allTrades, chartTf) : [];
    return localBars.length > 0
      ? localBars
      : syntheticBars(token.priceEth ? parseFloat(token.priceEth) : 0.00001, 48);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTrades, history, chartTf, token?.address]);

  // Memoized chart JSX — only re-renders when chart config state changes, not on crosshair moves
  const ChartSection = useMemo(() => {
    if (!token) return null;
    return (
      <div className="border border-border/20 rounded-sm overflow-hidden mb-0" style={{ background: "#0B1220" }}>
        {/* Toolbar */}
        <div className="flex items-stretch overflow-x-auto" style={{ background: "#0d1726", borderBottom: "1px solid rgba(255,255,255,0.08)", scrollbarWidth: "none" }}>
          {/* Candle / Line toggle */}
          <div className="hidden sm:flex items-stretch shrink-0" style={{ borderRight: "1px solid rgba(255,255,255,0.08)" }}>
            {(["candle", "line"] as ChartType[]).map((type, i, arr) => (
              <button key={type} onClick={() => setChartType(type)}
                className="px-3 flex items-center gap-1.5 text-[14px] font-semibold transition-all"
                style={{
                  height: 36,
                  background: chartType === type ? "rgba(255,255,255,0.08)" : "transparent",
                  color: chartType === type ? "#fff" : "#64748b",
                  borderRight: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.06)" : "none",
                }}>
                {type === "candle" ? "Candle" : "Line"}
              </button>
            ))}
          </div>

          {/* Indicators trigger */}
          <button onClick={() => setIndOpen(true)}
            className="hidden sm:flex px-3 items-center gap-1.5 text-[14px] font-semibold transition-all shrink-0"
            style={{
              height: 36,
              background: indicators.length ? "rgba(255,255,255,0.08)" : "transparent",
              color: indicators.length ? "#fff" : "#64748b",
              borderRight: "1px solid rgba(255,255,255,0.08)",
            }}>
            Indicators
            {indicators.length > 0 && (
              <span className="h-4 w-4 rounded-full text-[9px] font-bold flex items-center justify-center"
                style={{ background: "#3b82f6", color: "#fff" }}>{indicators.length}</span>
            )}
          </button>


          {/* Timeframe pills — pushed right */}
          <div className="flex items-center ml-auto shrink-0 px-2" style={{ borderLeft: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 24, padding: 3, display: "flex", gap: 2 }}>
              {CHART_TIMEFRAMES.map(t => (
                <button key={t} onClick={() => setChartTf(t)}
                  className="px-2.5 text-[14px] font-semibold transition-all shrink-0 whitespace-nowrap flex items-center"
                  style={{
                    height: 28,
                    ...(chartTf === t
                      ? { background: "rgba(255,255,255,0.10)", border: "1px solid transparent", borderRadius: 20, color: "#e2e8f0" }
                      : { borderRadius: 20, border: "1px solid transparent", color: "#64748b" })
                  }}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Canvas */}
        <div className="h-[260px] sm:h-[340px] lg:h-[400px] xl:h-[440px]">
          <ChartCanvas
            bars={chartBars}
            address={token.address}
            loading={!connected}
            chartType={chartType}
            indicators={indicators}
            solPrice={solPrice}
            symbol={token.symbol}
            onCrosshairMove={onCrosshairMove}
          />
        </div>
      </div>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartBars, chartType, chartTf, indicators, indOpen, connected, token?.address, onCrosshairMove, solPrice]);

  const handleTrade = async () => {
    if (!wallet) {
      toast({ title: "Wallet required", description: "Connect your wallet to trade.", variant: "destructive" });
      return;
    }
    if (!token || !amount) return;

    try {
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) throw new Error("Invalid amount");

      let ethAmt = "0";
      let tokenAmt = "0";
      
      const currentPrice = token.priceEth ? parseFloat(token.priceEth) : 0.00001;

      if (tradeMode === "buy") {
        ethAmt = parseEth(amount);
        tokenAmt = parseEth((numAmount / currentPrice).toString());
      } else {
        tokenAmt = parseEth(amount);
        ethAmt = parseEth((numAmount * currentPrice).toString());
      }

      await recordTrade.mutateAsync({
        address: token.address,
        data: {
          traderAddress: wallet,
          isBuy: tradeMode === "buy",
          ethAmount: ethAmt,
          tokenAmount: tokenAmt,
          txHash: ethers.Wallet.createRandom().address,
          timestamp: new Date().toISOString()
        }
      });

      // Guard: only accept non-negative integer strings (BigInt-safe)
      const safeBI = (v: string | null | undefined) => {
        if (!v) return BigInt(0);
        const clean = v.replace(/\..*/, ""); // strip decimals if any
        return /^\d+$/.test(clean) ? BigInt(clean) : BigInt(0);
      };
      const vt = safeBI(token.virtualTokenReserves);
      const ve = safeBI(token.virtualEthReserves);
      const ethAmtBI = safeBI(ethAmt);
      const tokenAmtBI = safeBI(tokenAmt);

      // Abort if reserves are insufficient — prevents invalid on-chain state
      if (tradeMode === "buy" && vt < tokenAmtBI) {
        throw new Error("Insufficient token reserves");
      }
      if (tradeMode === "sell" && ve < ethAmtBI) {
        throw new Error("Insufficient SOL reserves");
      }

      let newVt = vt;
      let newVe = ve;

      if (tradeMode === "buy") {
        newVe += ethAmtBI;
        newVt -= tokenAmtBI;
      } else {
        newVe -= ethAmtBI;
        newVt += tokenAmtBI;
      }

      await updateToken.mutateAsync({
        address: token.address,
        data: {
          virtualTokenReserves: newVt.toString(),
          virtualEthReserves: newVe.toString(),
          volumeEth: (safeBI(token.volumeEth) + ethAmtBI).toString(),
          tradeCount: (Number(token.tradeCount) || 0) + 1,
        }
      });

      toast({
        title: tradeMode === "buy" ? "Buy order filled" : "Sell order filled",
        description: `${amount} SOL ${tradeMode === "buy" ? "→" : "←"} ${token.symbol} executed on-chain.`,
      });

      setAmount("");
      refetchToken();
      refetchHistory();

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      toast({ title: "Trade failed", description: msg, variant: "destructive" });
    }
  };

  const copyToClipboard = (text: string, label?: string) => {
    fireClipboard(text, label);
  };

  if (!selectedAddress) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] border border-border/50 border-dashed rounded-sm p-8 bg-card max-w-2xl mx-auto mt-8 animate-slideDown">
        <Search className="h-10 w-10 text-muted-foreground mb-4 opacity-40" />
        <h2 className="text-lg font-bold mb-2 text-foreground">Search for a token to trade</h2>
        <div className="w-full max-w-md relative mt-2">
          <Input 
            placeholder="Search by name or symbol..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-10 rounded-sm bg-background border-border/50 h-12 focus-visible:ring-primary transition-all"
          />
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          
          {searchResults && searchResults.length > 0 && (
            <div className="absolute top-full left-0 w-full mt-2 bg-popover border border-border rounded-sm shadow-xl overflow-hidden z-10 animate-slideDown">
              {searchResults.map(res => (
                <button
                  key={res.id}
                  className="w-full text-left px-4 py-3 hover:bg-muted transition-colors flex items-center justify-between border-b border-border/50 last:border-0"
                  onClick={() => onSelectToken(res.address)}
                >
                  <span className="font-bold text-foreground text-sm">{res.name} <span className="text-muted-foreground font-normal ml-1">${res.symbol}</span></span>
                  <span className="text-xs font-mono text-primary">{formatAddress(res.address)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (loadingToken && !token) return <TokenDetailSkeleton />;
  if (tokenError) return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
      <span className="text-3xl">⚠️</span>
      <p className="text-muted-foreground font-mono text-sm">Failed to load token data.</p>
      <button
        onClick={() => refetchToken()}
        className="mt-1 px-4 py-1.5 rounded-sm bg-primary/10 text-primary text-xs font-bold border border-primary/20 hover:bg-primary hover:text-black transition-all"
      >
        Retry
      </button>
    </div>
  );
  if (!token) return <div className="text-center py-20 text-muted-foreground font-mono">Token not found.</div>;

  // virtualEthReserves stores integer SOL (Pump.fun: starts with 30 virtual SOL, graduates at +85 real SOL)
  const vSolInt = parseFloat((liveToken?.virtualEthReserves ?? token.virtualEthReserves) || "0");
  const realSolInCurve = Math.max(0, vSolInt - 30);
  const progressPercent = Math.min(100, (realSolInCurve / 85) * 100);
  const isGraduated = token.graduated || progressPercent >= 100;

  return (
    /* Full-bleed two-column layout — mirrors pump.fun */
    <div className="flex flex-col md:flex-row w-full animate-slideDown md:h-[calc(100dvh-96px)]">

      {/* ── LEFT: scrollable chart + info ── */}
      <div className="flex-1 min-w-0 overflow-y-auto border-r border-border/20 px-0 md:px-5 py-0 md:py-4 pb-20 md:pb-6">

        {/* Compact Token Header */}
        <div className="flex gap-3 items-start mb-2 px-3 pt-3 md:px-0 md:pt-0">
          <TokenAvatar symbol={token.symbol} imageUrl={token.imageUrl} size={52} shape="square" className="border border-border/40 shadow-sm" />
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-foreground leading-tight">{token.name}</h1>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-primary font-mono text-sm font-bold">${token.symbol}</span>
              <PlatformBadge
                platform={token.platform as PlatformId}
                size="md"
                href={getPlatformUrl(token.platform as PlatformId, token.address) ?? undefined}
              />
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap text-[11px] font-mono text-muted-foreground">
              <span>by</span>
              <span className="cursor-pointer hover:text-foreground transition-colors" onClick={() => copyToClipboard(token.creatorAddress)}>
                {formatAddress(token.creatorAddress)}
              </span>
              <span className="text-border">•</span>
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(token.createdAt || Date.now())}</span>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground" title="Twitter"><Twitter className="h-4 w-4" /></button>
              <button className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground" title="Website"><Globe className="h-4 w-4" /></button>
              <button className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground" title="Copy address" onClick={() => copyToClipboard(token.address)}><Copy className="h-4 w-4" /></button>
            </div>
          </div>
          {/* Share button — top-right, aligned with coin name */}
          <button
            className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground shrink-0"
            title="Share"
            onClick={() => setShareOpen(true)}
          >
            <Share2 className="h-4 w-4" />
          </button>
        </div>

        {/* Description */}
        {token.description && (
          <p className="text-[11px] text-muted-foreground leading-relaxed mb-2 line-clamp-2 px-3 md:px-0">{token.description}</p>
        )}

        {/* Market Cap Row */}
        <div className="flex items-center gap-2.5 mb-2 px-3 md:px-0">
          <span className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider">Market Cap</span>
          <span className="text-xl font-bold text-foreground font-mono tabular-nums">
            {formatMCUsd(liveToken?.marketCapEth ?? token.marketCapEth, solPrice)}
          </span>
          {liveToken && (
            <span className="flex items-center gap-1 text-[10px] text-primary font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse inline-block" />
              LIVE
            </span>
          )}
        </div>

        {/* Chart Area — DexGems-style with toolbar */}
        {/* bars is memoized — only recomputes when trades or timeframe change, never on crosshair moves */}
        {ChartSection}

        {/* Indicator picker modal */}
        <IndicatorModal
          open={indOpen}
          onClose={() => setIndOpen(false)}
          active={indicators}
          onToggle={toggleIndicator}
        />

        {/* Bonding Curve — thin bar immediately below chart */}
        <div className="py-2 px-3 md:px-0 border-b border-border/20 mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-muted-foreground">Bonding curve progress</span>
            <span className="text-[10px] font-mono font-bold text-primary">{progressPercent.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 w-full bg-muted/60 rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-all duration-500 rounded-full" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="mt-1 text-[10px] font-mono text-muted-foreground/70">
            {isGraduated
              ? <span className="text-primary font-bold">Graduated — liquidity added to Uniswap ✓</span>
              : <span>{realSolInCurve.toFixed(2)} / 85 SOL goal</span>
            }
          </div>
        </div>

        {/* Transactions + Holders tabs */}
        {(() => {
          // Compute holders from trade history (net token per address)
          const holderMap = new Map<string, number>();
          (history ?? []).forEach(t => {
            const amt = parseFloat(t.tokenAmount ?? "0");
            const prev = holderMap.get(t.traderAddress) ?? 0;
            holderMap.set(t.traderAddress, t.isBuy ? prev + amt : prev - amt);
          });
          const holders = Array.from(holderMap.entries())
            .filter(([, bal]) => bal > 0)
            .sort((a, b) => b[1] - a[1]);
          const totalSupply = holders.reduce((s, [, b]) => s + b, 0) || 1;

          return (
            <div className="mt-0 px-3 md:px-0">
              {/* Bug fix: React state-based sub-tabs (no more document.getElementById) */}
              <div className="flex gap-2 mb-2">
                <button
                  onClick={() => setActiveSubTab("tx")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all"
                  style={{
                    background: activeSubTab === "tx" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "tx" ? "#e2e8f0" : "#64748b",
                    border: "1px solid " + (activeSubTab === "tx" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <ArrowRightLeft className="h-3.5 w-3.5" /> Transactions
                </button>
                <button
                  onClick={() => setActiveSubTab("holders")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all"
                  style={{
                    background: activeSubTab === "holders" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "holders" ? "#e2e8f0" : "#64748b",
                    border: "1px solid " + (activeSubTab === "holders" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <Users className="h-3.5 w-3.5" /> Holders
                </button>
              </div>

              {/* Transactions panel */}
              <div className={`overflow-x-auto rounded-lg ${activeSubTab !== "tx" ? "hidden" : ""}`}
                style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                <table className="w-full text-[13px]">
                  <thead style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
                    <tr>
                      <th className="text-left px-3 py-2.5 font-medium text-[14px]" style={{ color: "#94a3b8" }}>Type</th>
                      <th className="text-right px-3 py-2.5 font-medium text-[14px]" style={{ color: "#94a3b8" }}>Amount SOL</th>
                      <th className="text-right px-3 py-2.5 font-medium text-[14px]" style={{ color: "#94a3b8" }}>{token.symbol}</th>
                      <th className="text-right px-3 py-2.5 font-medium text-[14px]" style={{ color: "#94a3b8" }}>Time</th>
                      <th className="text-right px-3 py-2.5 font-medium text-[14px]" style={{ color: "#94a3b8" }}>Txn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingHistory ? (
                      [...Array(4)].map((_, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                          <td colSpan={5} className="px-3 py-3"><Skeleton className="h-3.5 w-full" /></td>
                        </tr>
                      ))
                    ) : (() => {
                      const historyTxHashes = new Set((history ?? []).map(t => t.txHash));
                      const dedupedLive = liveTrades.filter(lt => !historyTxHashes.has(lt.txHash));
                      const allRows = [...dedupedLive, ...(history ?? [])];
                      if (!allRows.length) {
                        return (
                          <tr>
                            <td colSpan={5} className="px-3 py-10 text-center text-[13px]" style={{ color: "#475569" }}>
                              No trades recorded yet.
                            </td>
                          </tr>
                        );
                      }
                      return allRows.map((trade, idx) => {
                        const isLive = idx < dedupedLive.length;
                        const isBuy = trade.isBuy;
                        return (
                          <tr
                            key={trade.txHash ?? trade.id}
                            className="transition-colors"
                            style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.025)")}
                            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                          >
                            {/* Type */}
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-2">
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded text-[12px] font-semibold"
                                  style={{
                                    background: isBuy ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.12)",
                                    color: isBuy ? "#4ade80" : "#f87171",
                                  }}
                                >
                                  {isBuy ? "Buy" : "Sell"}
                                </span>
                                {isLive && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold"
                                    style={{ background: "rgba(59,130,246,0.15)", color: "#60a5fa", border: "1px solid rgba(59,130,246,0.25)" }}>
                                    New
                                  </span>
                                )}
                              </div>
                            </td>
                            {/* Amount SOL */}
                            <td className="px-3 py-2.5 text-right font-mono text-[13px]" style={{ color: "#e2e8f0" }}>
                              {formatSol(trade.ethAmount)}
                            </td>
                            {/* Token amount */}
                            <td className="px-3 py-2.5 text-right font-mono text-[13px]" style={{ color: "#94a3b8" }}>
                              {formatTokenAmount(trade.tokenAmount)}
                            </td>
                            {/* Time */}
                            <td className="px-3 py-2.5 text-right text-[12px]" style={{ color: "#64748b" }}>
                              {timeAgo(trade.timestamp)}
                            </td>
                            {/* Txn */}
                            <td className="px-3 py-2.5 text-right">
                              <a
                                href={`https://solscan.io/tx/${trade.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 font-mono text-[12px] transition-colors"
                                style={{ color: "#475569" }}
                                onMouseEnter={e => ((e.currentTarget as HTMLAnchorElement).style.color = "#94a3b8")}
                                onMouseLeave={e => ((e.currentTarget as HTMLAnchorElement).style.color = "#475569")}
                              >
                                {trade.txHash ? trade.txHash.slice(0, 6) + "…" : "—"}
                                {trade.txHash && <ExternalLink className="h-3 w-3" />}
                              </a>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>

              {/* Holders panel */}
              <div className={`overflow-x-auto rounded-b-sm border-x border-b border-border/40 ${activeSubTab !== "holders" ? "hidden" : ""}`}>
                <table className="w-full text-xs font-mono">
                  <thead className="text-muted-foreground border-b border-border/40 bg-muted/20 text-[10px]">
                    <tr>
                      <th className="text-left px-3 py-2 font-normal uppercase tracking-wider">#</th>
                      <th className="text-left px-3 py-2 font-normal uppercase tracking-wider">Address</th>
                      <th className="text-right px-3 py-2 font-normal uppercase tracking-wider">{token.symbol}</th>
                      <th className="text-right px-3 py-2 font-normal uppercase tracking-wider">Share</th>
                      <th className="px-3 py-2 w-24"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/20">
                    {loadingHistory ? (
                      [...Array(4)].map((_, i) => (
                        <tr key={i}><td colSpan={5} className="px-3 py-2.5"><Skeleton className="h-3.5 w-full" /></td></tr>
                      ))
                    ) : holders.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground/60 text-[11px]">No holders yet.</td>
                      </tr>
                    ) : holders.map(([addr, bal], idx) => {
                      const pct = (bal / totalSupply) * 100;
                      return (
                        <tr key={addr} className="hover:bg-white/[0.025] transition-colors">
                          <td className="px-3 py-2 text-muted-foreground/50">{idx + 1}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <TokenAvatar symbol={addr.slice(2, 6)} size={20} shape="circle" />
                              <span
                                className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                onClick={() => copyToClipboard(addr)}
                              >
                                {formatAddress(addr)}
                              </span>
                              {idx === 0 && (
                                <span className="text-[9px] px-1 py-0.5 rounded bg-primary/15 text-primary border border-primary/20 font-bold">TOP</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right text-foreground">{bal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td className="px-3 py-2 text-right text-primary font-bold">{pct.toFixed(1)}%</td>
                          <td className="px-3 py-2">
                            <div className="h-1.5 w-20 bg-muted/50 rounded-full overflow-hidden">
                              <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── RIGHT: sticky buy panel ── */}
      <div className="w-full md:w-[280px] xl:w-[300px] shrink-0 md:overflow-y-auto md:h-full px-3 py-3 md:px-4 md:py-4 space-y-3">

        {/* Stats: Price / Vol 24h / % changes */}
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}>
          {/* Price + Vol 24h */}
          <div className="grid grid-cols-2 divide-x" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", divideColor: "rgba(255,255,255,0.08)" }}>
            <div className="flex flex-col px-4 py-3">
              <span className="text-[13px] font-medium mb-1" style={{ color: "#94a3b8" }}>Price</span>
              <span className="font-mono font-bold text-[15px]" style={{ color: "#e2e8f0" }}>
                {solPrice && priceStats.currentPrice > 0 ? formatUSD(priceStats.currentPrice * solPrice) : priceStats.currentPrice > 0 ? priceStats.currentPrice.toExponential(4) : "—"}
              </span>
            </div>
            <div className="flex flex-col px-4 py-3">
              <span className="text-[13px] font-medium mb-1" style={{ color: "#94a3b8" }}>Vol 24h</span>
              <span className="font-mono font-bold text-[15px]" style={{ color: "#e2e8f0" }}>
                {solPrice && priceStats.vol24h > 0 ? formatUSD(priceStats.vol24h * solPrice) : priceStats.vol24h > 0 ? priceStats.vol24h.toFixed(4) : "—"}
              </span>
            </div>
          </div>
          {/* 5m / 1h / 6h */}
          <div className="grid grid-cols-3 divide-x" style={{ "--divider": "rgba(255,255,255,0.08)" } as React.CSSProperties}>
            {([
              { label: "5m", data: priceStats.p5m },
              { label: "1h", data: priceStats.p1h },
              { label: "6h", data: priceStats.p6h },
            ] as { label: string; data: { val: string; up: boolean } | null }[]).map(({ label, data }, i, arr) => (
              <div key={label} className="flex flex-col items-center px-2 py-2.5"
                style={{ borderRight: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
                <span className="text-[12px] font-medium mb-1" style={{ color: "#64748b" }}>{label}</span>
                <span className="font-mono font-bold text-[13px]" style={{ color: data ? (data.up ? "#4ade80" : "#f87171") : "#475569" }}>
                  {data?.val ?? "—"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Vol 24h + Txns breakdown card */}
        {(() => {
          const { vol24hBuy, vol24hSell, txns24hBuy, txns24hSell } = priceStats;
          const totalTxns = txns24hBuy + txns24hSell;
          const fmtV = (v: number) => solPrice && v > 0 ? formatUSD(v * solPrice) : v > 0 ? v.toFixed(3) : "—";
          const DIV = "1px solid rgba(255,255,255,0.07)";
          const rows = [
            { label: "24h Vol",  buy: fmtV(vol24hBuy),  sell: fmtV(vol24hSell) },
            { label: "24h Txns", buy: totalTxns > 0 ? txns24hBuy.toLocaleString() : "—", sell: totalTxns > 0 ? txns24hSell.toLocaleString() : "—" },
          ];
          return (
            <div className="rounded-xl overflow-hidden" style={{ border: DIV, background: "rgba(255,255,255,0.03)" }}>
              {/* Header */}
              <div className="grid grid-cols-3 px-3 py-2" style={{ borderBottom: DIV }}>
                <span className="text-[12px] font-medium" style={{ color: "#475569" }} />
                <span className="text-[12px] font-semibold text-center" style={{ color: "#4ade80" }}>Buy</span>
                <span className="text-[12px] font-semibold text-center" style={{ color: "#f87171" }}>Sell</span>
              </div>
              {rows.map(({ label, buy, sell }, i) => (
                <div key={label} className="grid grid-cols-3 items-center px-3 py-2.5"
                  style={{ borderTop: i > 0 ? DIV : "none" }}>
                  <span className="text-[13px] font-medium" style={{ color: "#94a3b8" }}>{label}</span>
                  <span className="text-[13px] font-mono font-semibold text-center" style={{ color: "#4ade80" }}>{buy}</span>
                  <span className="text-[13px] font-mono font-semibold text-center" style={{ color: "#f87171" }}>{sell}</span>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Buy/Sell Panel */}
        <div className="bg-card border border-border/60 rounded-sm overflow-hidden shadow-sm">
          {/* Mode tabs — sliding pill */}
          <div className="relative flex border-b border-border/40 p-1 gap-1 bg-muted/30">
            {/* Animated sliding background */}
            <div
              className={`absolute top-1 bottom-1 w-[calc(50%-6px)] rounded-sm transition-all duration-250 ease-out ${tradeMode === "buy" ? "left-1 bg-primary shadow-[0_0_12px_hsl(142_100%_45%/0.4)]" : "left-[calc(50%+2px)] bg-destructive shadow-[0_0_12px_hsl(0_84%_60%/0.3)]"}`}
            />
            <button
              className={`relative flex-1 py-2 text-sm font-bold transition-colors duration-150 rounded-sm z-10 ${tradeMode === "buy" ? "text-white" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTradeMode("buy")}
            >Buy</button>
            <button
              className={`relative flex-1 py-2 text-sm font-bold transition-colors duration-150 rounded-sm z-10 ${tradeMode === "sell" ? "text-white" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTradeMode("sell")}
            >Sell</button>
          </div>

          <div className="p-3 space-y-3">
            {/* Preset amounts */}
            <div className="flex gap-2">
              {[{ label: "$25", val: "0.008" }, { label: "$100", val: "0.033" }, { label: "$250", val: "0.083" }].map(({ label, val }) => (
                <button
                  key={label}
                  className="flex-1 py-1.5 bg-muted/60 rounded text-xs font-bold text-muted-foreground hover:bg-white/10 hover:text-foreground border border-border/40 transition-all duration-150 active:scale-95 press-feedback"
                  onClick={() => setAmount(val)}
                >{label}</button>
              ))}
            </div>

            {/* Amount input */}
            <div className="relative">
              <Input
                type="number"
                placeholder="0.0"
                className="w-full pl-3 pr-14 h-12 bg-background border-border/50 rounded-sm font-mono text-xl text-foreground focus-visible:ring-primary transition-all duration-200 focus-visible:shadow-[0_0_0_3px_hsl(142_100%_45%/0.15)]"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                <span className="font-bold text-muted-foreground font-mono text-sm transition-all duration-200">{tradeMode === "buy" ? "SOL" : token.symbol}</span>
              </div>
            </div>

            {/* Trade button */}
            <Button
              className={`w-full h-11 text-sm font-bold rounded-sm shadow-none transition-all duration-200 active:scale-[0.98] press-feedback ${tradeMode === "buy" ? "bg-primary hover:bg-primary/90 hover:shadow-[0_0_16px_hsl(142_100%_45%/0.35)] text-white" : "bg-destructive hover:bg-destructive/90 hover:shadow-[0_0_16px_hsl(0_84%_60%/0.3)] text-white"}`}
              onClick={handleTrade}
              disabled={recordTrade.isPending || updateToken.isPending}
            >
              {recordTrade.isPending || updateToken.isPending
                ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /></span>
                : !wallet ? "Connect wallet to trade" : "place trade"}
            </Button>
          </div>
        </div>

      </div>

      {/* Share Modal */}
      <ShareModal
        token={token}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />
    </div>
  );
}

function PortfolioTab({ wallet, onSelectToken }: { wallet: string | null, onSelectToken: (addr: string) => void }) {
  const { data: myTokens, isLoading } = useListTokens({}, { query: { enabled: !!wallet, queryKey: getListTokensQueryKey({}) } });
  const solPrice = useSolPrice();

  if (!wallet) {
    return <div className="text-center py-20 text-muted-foreground font-mono text-sm animate-slideDown">Connect wallet to view your tokens.</div>;
  }

  if (isLoading) {
    return <div className="text-center py-20 text-muted-foreground font-mono text-sm animate-slideDown">Loading portfolio...</div>;
  }

  return (
    <div className="max-w-[800px] animate-slideDown">
      <h2 className="text-lg font-bold mb-6 text-foreground">Your Created Tokens</h2>
      {!myTokens || myTokens.length === 0 ? (
        <div className="text-muted-foreground font-mono text-sm border border-border/50 border-dashed rounded-sm p-8 text-center bg-card/50">
          You haven't launched any tokens yet.
        </div>
      ) : (
        <div className="grid gap-3">
          {myTokens.map(token => (
            <div key={token.id} className="flex items-center justify-between p-3 bg-card border border-border/50 rounded-sm hover:border-primary/40 transition-colors cursor-pointer group" onClick={() => onSelectToken(token.address)}>
              <div className="flex items-center gap-4">
                <TokenAvatar symbol={token.symbol} imageUrl={token.imageUrl} size={40} shape="square" />
                <div>
                  <div className="font-bold text-sm text-foreground group-hover:text-primary transition-colors">{token.name}</div>
                  <div className="text-[10px] font-mono text-muted-foreground mt-0.5">MC: {formatMCUsd(token.marketCapEth, solPrice)}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-xs font-bold text-primary">${token.symbol}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">Vol: {formatSol(token.volumeEth)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TrendingSidebar({ onSelectToken }: { onSelectToken: (addr: string) => void }) {
  const { data: trending, isLoading } = useGetTrendingTokens({ limit: 5 });
  const solPrice = useSolPrice();
  
  return (
    <div className="bg-card border border-border/50 rounded-sm p-4 animate-slideDown shadow-sm">
      <h3 className="text-xs font-bold uppercase tracking-widest text-foreground mb-4">Trending Now</h3>
      <div className="flex flex-col gap-3">
        {isLoading ? (
          [...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-3"><Skeleton className="h-8 w-8 rounded-sm" /><div className="flex-1"><Skeleton className="h-3 w-1/2 mb-1" /><Skeleton className="h-2 w-1/3" /></div></div>
          ))
        ) : trending?.map((token, i) => (
          <div key={token.id} className="flex items-center gap-3 cursor-pointer group p-1 -mx-1 rounded-sm hover:bg-white/[0.02] transition-colors" onClick={() => onSelectToken(token.address)}>
            <div className="font-mono text-[10px] text-muted-foreground w-3 text-right">{i+1}</div>
            <TokenAvatar symbol={token.symbol} imageUrl={token.imageUrl} size={32} shape="square" className="group-hover:ring-1 group-hover:ring-primary/40 transition-all" />
            <div className="min-w-0 flex-1">
              <div className="font-bold text-xs text-foreground truncate group-hover:text-primary transition-colors">{token.name}</div>
              <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">${token.symbol} • {formatMCUsd(token.marketCapEth, solPrice)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
