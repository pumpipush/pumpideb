import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { 
  useCreateToken, 
  useGetToken, 
  useRecordTrade, 
  useUpdateToken,
  useTradeHistory,
  useGetTokenOhlcv,
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
import { formatEth, formatAddress, parseEth, formatMC, formatMCUsd, formatUSD, formatTokenPrice, cn, timeAgo } from "@/lib/utils";
import { TokenAvatar, tokenCardBackground } from "@/components/shared/TokenAvatar";
import { ShareModal } from "@/components/shared/ShareModal";
import { Search, ArrowRightLeft, Share2, Copy, Twitter, Globe, Clock, Loader2, Users, ExternalLink, TrendingUp, CandlestickChart, Activity, FunctionSquare, Rocket, ShieldCheck, Zap, CheckCircle2, UploadCloud } from "lucide-react";
import { PlatformBadge, getPlatformUrl, type PlatformId } from "@/components/shared/PlatformBadge";
import { formatSol, formatTokenAmount } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useSolPrice } from "@/hooks/useSolPrice";
import { copyToClipboard as fireClipboard } from "@/components/shared/CopyToast";
import { useLocation, useSearch } from "wouter";
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
  // Use reactive wouter search so query-string changes (e.g. ?token=abc) always trigger re-render
  const search = useSearch();
  const _params  = new URLSearchParams(search);
  const tokenParam = _params.get("token");
  const tabParam   = _params.get("tab"); // "portfolio" makes My Tokens deep-linkable

  const { wallet } = useWallet();
  const [activeTab, setActiveTab] = useState<string>(
    tokenParam ? "trade" : (tabParam === "portfolio" ? "portfolio" : "launch")
  );
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(tokenParam);

  // Sync selectedTokenId to URL param; reset per-token state on every address change
  useEffect(() => {
    if (tokenParam) {
      setActiveTab("trade");
      setSelectedTokenId(tokenParam);
      // Double-rAF: first rAF fires after React's paint; second fires after the
      // browser has laid out and scrolled to any auto-focused/rendered element,
      // ensuring our reset wins on mobile.
      const scrollToTop = () => {
        window.scrollTo({ top: 0, behavior: "instant" });
        document.documentElement.scrollTo({ top: 0, behavior: "instant" });
        document.body.scrollTo({ top: 0, behavior: "instant" });
        document.querySelector("main")?.scrollTo({ top: 0, behavior: "instant" });
        document.querySelector("[data-token-panel]")?.scrollTo({ top: 0, behavior: "instant" });
      };
      requestAnimationFrame(() => requestAnimationFrame(scrollToTop));
    } else {
      setSelectedTokenId(null);
      // Respect ?tab=portfolio deep-link; otherwise fall back to launch
      setActiveTab(tabParam === "portfolio" ? "portfolio" : "launch");
    }
  }, [tokenParam, tabParam]);

  // Keep tabs in sync with URL so they are deep-linkable and survive refresh
  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    if (tab === "portfolio") setLocation("/app?tab=portfolio");
    else if (tab === "launch") setLocation("/app");
    // "trade" is token-scoped — URL already carries ?token=
  };

  const selectToken = (address: string) => {
    setSelectedTokenId(address);
    setActiveTab("trade");
    setLocation(`/app?token=${address}`);
  };

  const TAB_TRIGGER = "rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-transparent px-5 py-2.5 text-sm text-muted-foreground hover:text-foreground transition-all duration-150 data-[state=active]:shadow-none";

  return (
    <div className="flex flex-col">

      {/* ── Tab strip ── */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col flex-1 min-h-0">
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
          <div className="max-w-[1200px] mx-auto px-3 md:px-6 py-3 md:py-5">
            <LaunchTab wallet={wallet} onLaunch={(address) => selectToken(address)} />
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
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const createToken = useCreateToken();
  const { toast } = useToast();
  const { openWalletModal } = useWallet();

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid file", description: "Please upload an image file.", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Image must be 5 MB or smaller.", variant: "destructive" });
      return;
    }
    setImageFile(file);
    const url = URL.createObjectURL(file);
    setImagePreview(url);
  };

  const uploadImage = async (file: File): Promise<string | null> => {
    const contentType = file.type || "image/jpeg";

    // Step 1: Request a presigned upload URL from the server
    const urlRes = await fetch("/api/storage/uploads/request-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, contentType }),
    });
    if (!urlRes.ok) {
      const body = await urlRes.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? "Failed to get upload URL");
    }
    const { uploadURL, objectPath } = await urlRes.json() as { uploadURL: string; objectPath: string };

    // Step 2: PUT file bytes directly to GCS via the presigned URL
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": contentType },
    });
    if (!putRes.ok) {
      throw new Error("Failed to upload image to storage");
    }

    // Step 3: Confirm the upload — server verifies GCS object exists,
    // checks actual size, and sets a public ACL so the serving URL works.
    const confirmRes = await fetch("/api/storage/uploads/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectPath, contentType }),
    });
    if (!confirmRes.ok) {
      const body = await confirmRes.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? "Failed to confirm image upload");
    }
    const { servingUrl } = await confirmRes.json() as { servingUrl: string };
    return servingUrl;
  };

  const handleLaunch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet) {
      openWalletModal();
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
      let imageUrl: string | undefined;

      if (imageFile) {
        setIsUploading(true);
        try {
          imageUrl = await uploadImage(imageFile) ?? undefined;
        } catch (uploadErr) {
          toast({ title: "Image upload failed", description: "Could not upload the image. Launching without it.", variant: "destructive" });
        } finally {
          setIsUploading(false);
        }
      }

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
          imageUrl,
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
    <div className="flex flex-col lg:flex-row gap-6 lg:gap-10 max-w-[960px] mx-auto">

      {/* ── LEFT: Form ── */}
      <div className="flex-1 min-w-0 space-y-5">

        {/* Hero header */}
        <div>
          <div className="flex items-center gap-2.5 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.25)" }}>
              <Rocket className="h-4 w-4" style={{ color: "#4ade80" }} />
            </div>
            <h2 className="text-[20px] font-bold text-foreground tracking-tight">Launch a Token</h2>
          </div>
        </div>

        {/* Form card */}
        <form onSubmit={handleLaunch} className="space-y-0 rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.015)" }}>

          {/* ── Step 1: Identity ── */}
          <div className="px-5 pt-5 pb-5">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                style={{ background: "rgba(34,197,94,0.15)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.30)" }}>1</span>
              <span className="text-[13px] font-semibold text-foreground">Token Identity</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-muted-foreground">
                  Name <span className="text-destructive">*</span>
                </label>
                <Input
                  placeholder="e.g. Doge on Solana"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="h-10 rounded-lg bg-background/40 border-white/10 focus-visible:ring-green-500/30 text-[14px]"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-muted-foreground">
                  Ticker <span className="text-destructive">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[14px] font-bold pointer-events-none"
                    style={{ color: "#4ade80" }}>$</span>
                  <Input
                    placeholder="DOGE"
                    value={symbol}
                    onChange={e => setSymbol(e.target.value.toUpperCase())}
                    className="h-10 pl-7 rounded-lg bg-background/40 border-white/10 focus-visible:ring-green-500/30 font-mono uppercase tracking-widest text-[14px]"
                    maxLength={10}
                    required
                  />
                </div>
                {symbol && (
                  <p className="text-[11px] tabular-nums" style={{ color: symbol.length >= 9 ? "#f87171" : "#64748b" }}>
                    {symbol.length}/10
                  </p>
                )}
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

          {/* ── Step 2: Image ── */}
          <div className="px-5 pt-5 pb-5">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                style={{ background: "rgba(34,197,94,0.15)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.30)" }}>2</span>
              <span className="text-[13px] font-semibold text-foreground">Token Logo</span>
              <span className="ml-auto text-[11px]" style={{ color: "#94a3b8" }}>PNG · JPG · GIF · Max 5MB</span>
            </div>
            <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageChange} />
            <div
              onClick={() => imageInputRef.current?.click()}
              className="cursor-pointer rounded-xl transition-all duration-200 group"
              style={{
                border: imagePreview
                  ? "1px solid rgba(34,197,94,0.35)"
                  : "2px dashed rgba(255,255,255,0.09)",
                background: imagePreview ? "rgba(34,197,94,0.04)" : "rgba(255,255,255,0.015)",
              }}
            >
              {imagePreview ? (
                <div className="flex items-center gap-4 p-3">
                  <img src={imagePreview} alt="Token" className="h-16 w-16 rounded-xl object-cover shrink-0"
                    style={{ border: "1px solid rgba(255,255,255,0.10)" }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-semibold text-foreground">Image ready</p>
                    <p className="text-[12px]" style={{ color: "#64748b" }}>Click to change</p>
                  </div>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: "rgba(74,222,128,0.15)", border: "1px solid rgba(74,222,128,0.30)" }}>
                    <CheckCircle2 className="h-4 w-4" style={{ color: "#4ade80" }} />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 gap-2">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-1 transition-colors group-hover:border-white/15"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <UploadCloud className="h-5 w-5" style={{ color: "#64748b" }} />
                  </div>
                  <p className="text-[13px] font-medium" style={{ color: "#94a3b8" }}>
                    Drop image here or <span style={{ color: "#4ade80" }}>browse</span>
                  </p>
                  <p className="text-[11px]" style={{ color: "#94a3b8" }}>Recommended: 500 × 500 px</p>
                </div>
              )}
            </div>
          </div>

          <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

          {/* ── Step 3: Description ── */}
          <div className="px-5 pt-5 pb-5">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                style={{ background: "rgba(34,197,94,0.15)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.30)" }}>3</span>
              <span className="text-[13px] font-semibold text-foreground">Description</span>
              <span className="ml-auto text-[11px] tabular-nums" style={{ color: desc.length >= 270 ? "#f87171" : "#94a3b8" }}>
                {desc.length}/300
              </span>
            </div>
            <Textarea
              placeholder="Tell the community what makes this token special — lore, utility, meme origin, anything..."
              value={desc}
              onChange={e => setDesc(e.target.value.slice(0, 300))}
              className="rounded-lg bg-background/40 border-white/10 focus-visible:ring-green-500/30 min-h-[90px] resize-none text-[14px]"
            />
          </div>

          <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

          {/* ── Submit ── */}
          <div className="px-5 pt-5 pb-5 space-y-3">
            <button
              type="submit"
              disabled={isUploading || createToken.isPending}
              className="w-full h-12 rounded-xl text-[15px] font-bold flex items-center justify-center gap-2 transition-all duration-150 active:scale-[0.98]"
              style={{
                background: (isUploading || createToken.isPending)
                  ? "rgba(255,255,255,0.06)"
                  : "linear-gradient(135deg, #16a34a 0%, #22c55e 60%, #4ade80 100%)",
                color: (isUploading || createToken.isPending) ? "#475569" : "#fff",
                border: "none",
                boxShadow: (isUploading || createToken.isPending) ? "none" : "0 0 28px rgba(34,197,94,0.28)",
                cursor: (isUploading || createToken.isPending) ? "not-allowed" : "pointer",
              }}
            >
              {isUploading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Uploading image...</>
              ) : createToken.isPending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Deploying on-chain...</>
              ) : (
                <><Rocket className="w-4 h-4" /> Launch Token</>
              )}
            </button>

          </div>
        </form>
      </div>

      {/* ── RIGHT: Live Preview ── */}
      <div className="w-full lg:w-[290px] shrink-0">
        <div className="sticky top-4 space-y-4">

          {/* Header */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "#64748b" }}>Live Preview</span>
            <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
          </div>

          {/* Token card preview */}
          <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.09)", background: "rgba(255,255,255,0.02)" }}>

            {/* Card header */}
            <div className="p-4 flex items-center gap-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              {imagePreview ? (
                <img src={imagePreview} alt="Token" className="w-12 h-12 rounded-xl object-cover shrink-0"
                  style={{ border: "1px solid rgba(255,255,255,0.10)" }} />
              ) : (
                <TokenAvatar symbol={symbol || "?"} size={48} shape="square" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-bold text-foreground truncate text-[15px] leading-tight">
                  {name || <span style={{ color: "#475569" }}>Token Name</span>}
                </div>
                <div className="text-[12px] font-mono mt-0.5 truncate" style={{ color: "#4ade80" }}>
                  ${symbol ? symbol.toUpperCase() : <span style={{ color: "#475569" }}>TICKER</span>}
                </div>
              </div>
              <div className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold"
                style={{ background: "rgba(74,222,128,0.10)", color: "#4ade80", border: "1px solid rgba(74,222,128,0.22)" }}>
                NEW
              </div>
            </div>

            {/* Card body */}
            <div className="p-4 space-y-4">
              <p className="text-[13px] leading-relaxed line-clamp-4" style={{ color: "#64748b" }}>
                {desc || "Your description will appear here. Tell the community what makes this token unique."}
              </p>

              {/* Mock stats */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Price",   value: "$0.000028" },
                  { label: "Mkt Cap", value: "$28K" },
                  { label: "Holders", value: "1" },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-lg p-2 text-center"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <div className="text-[10px] mb-0.5" style={{ color: "#94a3b8" }}>{label}</div>
                    <div className="text-[12px] font-mono font-semibold text-foreground">{value}</div>
                  </div>
                ))}
              </div>

              <div className="text-[11px] font-mono pt-1" style={{ color: "#64748b", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
                Created by {wallet ? formatAddress(wallet) : "— connect wallet"}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

function TradeTab({ wallet, selectedAddress, onSelectToken }: { wallet: string | null, selectedAddress: string | null, onSelectToken: (addr: string) => void }) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Debounce: only fire API after 300ms idle — prevents a request per keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const { data: searchResults } = useListTokens({ search: debouncedSearch }, { query: { enabled: debouncedSearch.length > 1, queryKey: getListTokensQueryKey({ search: debouncedSearch }) } });
  
  const { data: token, refetch: refetchToken, isLoading: loadingToken, isError: tokenError } = useGetToken(selectedAddress || "", { 
    query: { 
      enabled: !!selectedAddress,
      queryKey: ["getToken", selectedAddress]
    } 
  });
  
  const { data: history, refetch: refetchHistory, isLoading: loadingHistory, isError: historyError } = useTradeHistory(selectedAddress || "", {
    query: {
      enabled: !!selectedAddress,
      queryKey: ["tradeHistory", selectedAddress],
      // Poll every 10 s as a fallback for when the SSE connection is silently
      // dead. Responses are 304-cached at the server when no new trades arrive,
      // so this is cheap for quiet tokens and keeps the table live when SSE fails.
      refetchInterval: 10_000,
      staleTime: 8_000,
    }
  });

  // ── Server-side reference prices for % change (SQL — no 100-row cap) ────────
  // High-volume tokens exhaust the 100-row history in < 2 min, so we query DB
  // directly for the closest valid price before each cutoff.
  const { data: serverPriceHistory } = useQuery({
    queryKey: ["priceHistory", selectedAddress],
    queryFn: async (): Promise<{
      p5m: number | null; p1h: number | null; p6h: number | null; p24h: number | null;
    } | null> => {
      if (!selectedAddress) return null;
      const res = await fetch(`/api/tokens/${selectedAddress}/price-history`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!selectedAddress,
    refetchInterval: 15_000,
    staleTime: 12_000,
  });

  // ── Server-side holder list (SQL net balance across ALL trades — no 100-row cap) ────
  // Client-side computation from the 100-row history wildly undercounts high-volume
  // tokens. This endpoint aggregates every trade in the DB for this token.
  const { data: serverHolders, isLoading: loadingHolders, refetch: refetchHolders } = useQuery({
    queryKey: ["holders", selectedAddress],
    queryFn: async (): Promise<{ address: string; balance: string }[]> => {
      if (!selectedAddress) return [];
      const res = await fetch(`/api/tokens/${selectedAddress}/holders`);
      if (!res.ok) return [];
      const json = await res.json();
      return json.holders ?? [];
    },
    enabled: !!selectedAddress,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  // ── Server-side position (SQL aggregate across ALL trades — no 100-row cap) ─
  // Client-side position from liveTrades+history misses trades older than the
  // 100-row history window. This endpoint aggregates every trade in the DB.
  const { data: serverPosition, isLoading: loadingPosition, refetch: refetchPosition } = useQuery({
    queryKey: ["position", selectedAddress, wallet],
    queryFn: async (): Promise<{
      tokensBought: number; tokensSold: number;
      solSpent: number; solReceived: number;
      tradeCount: number; maxTradeId: number;
    } | null> => {
      if (!selectedAddress || !wallet) return null;
      const res = await fetch(`/api/tokens/${selectedAddress}/position?wallet=${encodeURIComponent(wallet)}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!selectedAddress && !!wallet,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  // ── Server-side 24h stats (SQL aggregate — no 100-row cap) ────────────────
  // Refreshed every 30 s so Vol 24h stays accurate and real-time.
  const { data: serverStats } = useQuery({
    queryKey: ["tokenStats", selectedAddress],
    queryFn: async (): Promise<{
      vol24hSol: number; vol24hBuySol: number; vol24hSellSol: number;
      txns24hBuy: number; txns24hSell: number;
    } | null> => {
      if (!selectedAddress) return null;
      const res = await fetch(`/api/tokens/${selectedAddress}/stats`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!selectedAddress,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const recordTrade = useRecordTrade();
  const updateToken = useUpdateToken();
  const { toast } = useToast();
  const solPrice = useSolPrice();

  // Live SSE stream — real-time trade events
  const { liveTrades, liveToken, connected } = useTokenStream(selectedAddress);

  // Re-fetch holders + position whenever a genuinely new live trade arrives.
  // We watch liveTrades[0]?.id instead of liveTrades.length because the stream
  // caps at ~200 events — after that, length never changes but the newest
  // trade ID keeps incrementing, so we still detect every arrival.
  const latestLiveTradeId = liveTrades[0]?.id ?? null;
  useEffect(() => {
    if (latestLiveTradeId != null) {
      refetchHolders();
      if (wallet) refetchPosition();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestLiveTradeId]);

  const { openWalletModal } = useWallet();
  const [tradeMode, setTradeMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [shareOpen, setShareOpen] = useState(false);
  // Bug fix: React state for tx/holders sub-tab instead of imperative DOM manipulation
  const [activeSubTab, setActiveSubTab] = useState<"tx" | "holders" | "positions">("tx");
  const [descExpanded, setDescExpanded] = useState(false);

  // Reset per-token UI state whenever the viewed token changes
  useEffect(() => {
    setTradeMode("buy");
    setAmount("");
    setActiveSubTab("tx");
    setDescExpanded(false);
  }, [selectedAddress]);

  // New chart state
  const [chartTf, setChartTf] = useState<ChartTimeframe>("1m");
  const [chartType, setChartType] = useState<ChartType>("candle");
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [indOpen, setIndOpen] = useState(false);
  const [chartTypeOpen, setChartTypeOpen] = useState(false);

  // Server-side OHLCV: pre-aggregated over the full trade history (no 100-row limit).
  // Re-fetched every 30 s so new trades reconcile with the live SSE overlay.
  // Returns { bars, maxTradeId } — maxTradeId gates which SSE events to overlay.
  const { data: serverOhlcv, isLoading: ohlcvLoading } = useGetTokenOhlcv(
    selectedAddress || "",
    { tf: chartTf },
    {
      query: {
        enabled: !!selectedAddress,
        queryKey: ["ohlcv", selectedAddress, chartTf],
        refetchInterval: 30_000,
        staleTime: 25_000,
      }
    }
  );

  const CHART_TIMEFRAMES: ChartTimeframe[] = ["1m", "5m", "15m", "1H", "4H", "1D", "1W"];
  const toggleIndicator = useCallback((ind: Indicator) => {
    setIndicators(prev => prev.includes(ind) ? prev.filter(i => i !== ind) : [...prev, ind]);
  }, []);

  // Keep a ref so the crosshair callback always reads the latest solPrice without re-creating
  const solPriceRef = useRef<number | null>(solPrice);
  solPriceRef.current = solPrice;

  // ── Price flash animation state (declared before priceStats, effect registered after) ──
  const prevPriceRef  = useRef<number>(0);
  const [priceFlash, setPriceFlash] = useState<{ key: number; up: boolean }>({ key: 0, up: true });

  // ── Price / Vol / % stats (used both above chart and removed from right panel) ──
  const priceStats = useMemo(() => {
    const now = Date.now();
    const livePrice = liveToken?.priceEth ? parseFloat(liveToken.priceEth) : null;
    const currentPrice = livePrice ?? (token?.priceEth ? parseFloat(token.priceEth) : 0);
    const allTradesForVol = [...liveTrades, ...(history ?? [])];

    // ── Client-side fallback (limited to 100-row history + live SSE trades) ──
    const clientVol24h = allTradesForVol.reduce((acc, t) => {
      const ts = new Date(t.timestamp).getTime();
      if (!Number.isFinite(ts)) return acc;
      const amt = parseFloat(t.ethAmount ?? "0") / 1e9;
      return now - ts <= 86_400_000 ? acc + (Number.isFinite(amt) ? amt : 0) : acc;
    }, 0);
    const trades24h = allTradesForVol.filter(t => {
      const ts = new Date(t.timestamp).getTime();
      return Number.isFinite(ts) && now - ts <= 86_400_000;
    });
    const clientVol24hBuy  = trades24h.filter(t =>  t.isBuy).reduce((a, t) => a + ((parseFloat(t.ethAmount ?? "0") || 0) / 1e9), 0);
    const clientVol24hSell = trades24h.filter(t => !t.isBuy).reduce((a, t) => a + ((parseFloat(t.ethAmount ?? "0") || 0) / 1e9), 0);
    const clientTxns24hBuy  = trades24h.filter(t =>  t.isBuy).length;
    const clientTxns24hSell = trades24h.filter(t => !t.isBuy).length;

    // ── Server stats override when available (SQL SUM over full 24 h, no row cap) ──
    // Server refreshes every 30 s; client fallback covers the initial load gap.
    const vol24h     = serverStats?.vol24hSol    ?? clientVol24h;
    const vol24hBuy  = serverStats?.vol24hBuySol  ?? clientVol24hBuy;
    const vol24hSell = serverStats?.vol24hSellSol ?? clientVol24hSell;
    const txns24hBuy  = serverStats?.txns24hBuy  ?? clientTxns24hBuy;
    const txns24hSell = serverStats?.txns24hSell ?? clientTxns24hSell;

    // ── % change helpers ──────────────────────────────────────────────────────
    // priceAt: fallback for when serverPriceHistory hasn't loaded yet.
    // Uses the 100-row history; works for low-volume tokens where 100 rows
    // cover more than 5 m. Skips null/zero priceEth rows from old heal path.
    const priceAtFromHistory = (cutoffMs: number): number | null => {
      const cutoff = now - cutoffMs;
      const older = (history ?? [])
        .filter(t => { const ts = new Date(t.timestamp).getTime(); return Number.isFinite(ts) && ts <= cutoff; })
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      for (const t of older) {
        const p = parseFloat(t.priceEth ?? "0");
        if (Number.isFinite(p) && p > 0) return p;
      }
      return null;
    };
    // Server prices override the history fallback (accurate for high-volume tokens).
    const refP5m  = serverPriceHistory?.p5m  ?? priceAtFromHistory(5    * 60_000);
    const refP1h  = serverPriceHistory?.p1h  ?? priceAtFromHistory(60   * 60_000);
    const refP6h  = serverPriceHistory?.p6h  ?? priceAtFromHistory(360  * 60_000);
    const refP24h = serverPriceHistory?.p24h ?? priceAtFromHistory(1440 * 60_000);

    const pct = (old: number | null): { val: string; up: boolean } | null => {
      if (!old || old === 0 || currentPrice === 0) return null;
      const diff = ((currentPrice - old) / old) * 100;
      const abs = Math.abs(diff);
      const fmt = abs >= 10_000 ? (abs / 1000).toFixed(1) + "K"
                : abs >= 1_000  ? (abs / 1000).toFixed(2) + "K"
                : abs.toFixed(2);
      return { val: (diff >= 0 ? "+" : "-") + fmt + "%", up: diff >= 0 };
    };

    return {
      currentPrice,
      vol24h,
      vol24hBuy,
      vol24hSell,
      txns24hBuy,
      txns24hSell,
      p5m:  pct(refP5m),
      p1h:  pct(refP1h),
      p6h:  pct(refP6h),
      p24h: pct(refP24h),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveToken, token?.priceEth, liveTrades, history, serverStats, serverPriceHistory]);

  // ── Price flash effect — runs after priceStats is declared ──
  useEffect(() => {
    const p = priceStats.currentPrice;
    if (p > 0 && prevPriceRef.current > 0 && p !== prevPriceRef.current) {
      setPriceFlash(f => ({ key: f.key + 1, up: p >= prevPriceRef.current }));
    }
    if (p > 0) prevPriceRef.current = p;
  }, [priceStats.currentPrice]);

  // OHLC crosshair display — written directly to DOM so mouse moves never trigger re-renders
  const ohlcDisplayRef = useRef<HTMLDivElement>(null);
  const onCrosshairMove = useCallback((bar: OHLCSnapshot | null) => {
    const el = ohlcDisplayRef.current;
    if (!el) return;
    if (!bar) { el.style.opacity = "0"; return; }
    el.style.opacity = "1";
    const sp = solPriceRef.current;
    const fmt = (n: number): string => {
      if (sp && n > 0) return formatTokenPrice(n * sp);
      return n < 0.00001 ? n.toExponential(3) : n.toPrecision(4);
    };
    el.innerHTML = `
      <span style="color:#64748b">O <span style="color:#cbd5e1">${fmt(bar.open)}</span></span>
      <span style="color:#64748b">H <span style="color:#4ade80">${fmt(bar.high)}</span></span>
      <span style="color:#64748b">L <span style="color:#f87171">${fmt(bar.low)}</span></span>
      <span style="color:#64748b">C <span style="color:#e2e8f0">${fmt(bar.close)}</span></span>
    `;
  }, []);

  // Memoized bars — reference is stable until trades or timeframe actually change.
  // Uses server-side OHLCV (full history, no 100-row cap) merged with real-time
  // SSE trade ticks so the last candle stays live between server refetches.
  const chartBars = useMemo(() => {
    if (!token) return [];

    // serverOhlcv now returns { bars, maxTradeId }.
    // maxTradeId is the highest trade ID the server aggregate already includes.
    const base  = (serverOhlcv?.bars ?? []) as import("@/lib/ohlcv").OHLCVBar[];
    const maxId = serverOhlcv?.maxTradeId ?? 0;

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

    // ── Anti-double-count: ID-based cursor ────────────────────────────────────
    // The server aggregate includes every trade with id <= maxTradeId.
    // Adding all SSE trades on top re-counts those same rows on every 30-s
    // refetch, inflating the current candle's volume each poll cycle.
    //
    // Fix: only overlay SSE trades whose database id is strictly greater than
    // maxTradeId — those are genuinely new rows the server hasn't seen yet.
    // When maxId = 0 (no server data loaded yet), all SSE trades are new.
    const freshLiveTrades = maxId > 0
      ? liveAsHistory.filter(lt => (lt.id ?? 0) > maxId)
      : liveAsHistory;

    const liveBars = freshLiveTrades.length > 0
      ? tradesFromLocalBars(freshLiveTrades, chartTf)
      : [];

    if (liveBars.length === 0) return base;
    if (base.length === 0) return liveBars;

    // Merge: fresh live bars update the matching server bar (or append new ones).
    // Volume addition is safe here — freshLiveTrades are id > maxTradeId so
    // they are not yet present in any server bar.
    const merged = new Map<number, import("@/lib/ohlcv").OHLCVBar>();
    for (const b of base) merged.set(b.time, { ...b });
    for (const lb of liveBars) {
      const existing = merged.get(lb.time);
      if (existing) {
        existing.high   = Math.max(existing.high, lb.high);
        existing.low    = Math.min(existing.low,  lb.low);
        existing.close  = lb.close;
        existing.volume += lb.volume;
      } else {
        merged.set(lb.time, lb);
      }
    }
    return Array.from(merged.values()).sort((a, b) => a.time - b.time);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverOhlcv, liveTrades, chartTf, token?.address]);

  // Effective market cap: stored value first, then derive from virtual reserves as fallback
  // (pump.fun stores MC as null until the first trade updates it via on-chain data;
  //  the bonding curve formula: MC_lamports = totalSupply × vSol_lamports / vTok_atomic)
  const effectiveMcEth = useMemo(() => {
    const raw = liveToken?.marketCapEth ?? token?.marketCapEth;
    if (raw && raw !== "0") return raw;
    try {
      const vSolSol  = parseFloat(liveToken?.virtualEthReserves   ?? token?.virtualEthReserves   ?? "0");
      const vTokAtom = parseFloat(liveToken?.virtualTokenReserves ?? token?.virtualTokenReserves ?? "1");
      if (vSolSol <= 0 || vTokAtom <= 0) return null;
      // totalSupply_atomic(1e15) × vSolLamports(vSolSol×1e9) / vTokAtom
      const mc = Math.round(1e15 * (vSolSol * 1e9) / vTokAtom);
      return mc > 0 ? mc.toString() : null;
    } catch { return null; }
  }, [liveToken?.marketCapEth, token?.marketCapEth,
      liveToken?.virtualEthReserves, token?.virtualEthReserves,
      liveToken?.virtualTokenReserves, token?.virtualTokenReserves]);

  // Memoized chart JSX — only re-renders when chart config state changes, not on crosshair moves
  const ChartSection = useMemo(() => {
    if (!token) return null;

    // Still loading from server — show skeleton, not "No trades yet"
    if (chartBars.length === 0 && ohlcvLoading) {
      return (
        <div className="border border-border/20 rounded-sm overflow-hidden mb-0 animate-pulse"
          style={{ height: 280, background: "#0B1220" }}>
          <div className="flex flex-col justify-end h-full gap-1 p-4">
            {/* fake candle bars at varying heights */}
            <div className="flex items-end gap-[3px] h-40">
              {[40,65,30,80,55,70,45,90,60,75,35,85,50,95,42,68,38,78,52,88].map((h, i) => (
                <div key={i} className="flex-1 rounded-sm" style={{ height: `${h}%`, background: "rgba(255,255,255,0.06)" }} />
              ))}
            </div>
          </div>
        </div>
      );
    }

    // Empty state — only show after server has responded with zero bars
    if (chartBars.length === 0) {
      return (
        <div className="border border-border/20 rounded-sm flex items-center justify-center mb-0"
          style={{ height: 280, background: "#0B1220" }}>
          <div className="flex flex-col items-center gap-2 text-center px-8">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <p className="text-sm font-medium" style={{ color: "#475569" }}>No trades yet</p>
            <p className="text-xs" style={{ color: "#334155" }}>Chart populates in real time as trades arrive</p>
          </div>
        </div>
      );
    }

    return (
      <div className="border border-border/20 rounded-sm overflow-hidden mb-0" style={{ background: "#0B1220" }}>
        {/* Toolbar */}
        <div className="flex items-stretch overflow-x-auto" style={{ background: "#0d1726", borderBottom: "1px solid rgba(255,255,255,0.08)", scrollbarWidth: "none" }}>
          {/* Candle / Line / Indicators — tab style */}
          <div className="flex items-center gap-1.5 px-2 shrink-0" style={{ borderRight: "1px solid rgba(255,255,255,0.08)" }}>

            {/* Mobile: icon-only chart type picker — native select overlaid for reliability */}
            <div className="relative sm:hidden flex items-center justify-center w-9 h-9 cursor-pointer"
              style={{ color: "#e2e8f0" }}>
              {chartType === "candle"
                ? <svg width="18" height="18" viewBox="0 0 14 14" fill="none" style={{ pointerEvents: "none" }}>
                    <line x1="3" y1="1" x2="3" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    <rect x="1.5" y="3.5" width="3" height="5" rx="0.4" stroke="currentColor" strokeWidth="1.2"/>
                    <line x1="10" y1="1" x2="10" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    <rect x="8.5" y="6" width="3" height="5" rx="0.4" stroke="currentColor" strokeWidth="1.2"/>
                  </svg>
                : <svg width="18" height="18" viewBox="0 0 14 14" fill="none" style={{ pointerEvents: "none" }}>
                    <polyline points="1,11 4,6 7,8 10,3 13,5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    <polygon points="1,11 4,6 7,8 10,3 13,5 13,12 1,12" fill="currentColor" fillOpacity="0.18"/>
                  </svg>
              }
              <select
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                value={chartType}
                onChange={e => setChartType(e.target.value as ChartType)}
              >
                <option value="candle">Candle</option>
                <option value="line">Line</option>
              </select>
            </div>

            {/* Desktop: separate Candle + Line buttons */}
            {(["candle", "line"] as ChartType[]).map((type) => (
              <button key={type} onClick={() => setChartType(type)}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all"
                style={{
                  background: chartType === type ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                  color: chartType === type ? "#e2e8f0" : "#64748b",
                  border: "1px solid " + (chartType === type ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                }}>
                {type === "candle" ? <>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <line x1="3" y1="1" x2="3" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    <rect x="1.5" y="3.5" width="3" height="5" rx="0.4" stroke="currentColor" strokeWidth="1.2"/>
                    <line x1="10" y1="1" x2="10" y2="13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    <rect x="8.5" y="6" width="3" height="5" rx="0.4" stroke="currentColor" strokeWidth="1.2"/>
                  </svg>
                  Candle
                </> : <>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <polyline points="1,11 4,6 7,8 10,3 13,5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    <polygon points="1,11 4,6 7,8 10,3 13,5 13,12 1,12" fill="currentColor" fillOpacity="0.18"/>
                  </svg>
                  Line
                </>}
              </button>
            ))}

            {/* Indicators — icon+text on desktop, icon-only bare on mobile */}
            <button onClick={() => setIndOpen(true)} className="flex items-center gap-1.5 transition-all"
              style={{ color: indicators.length ? "#e2e8f0" : "#64748b" }}>
              {/* desktop: full tab button */}
              <span className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold"
                style={{
                  background: indicators.length ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                  border: "1px solid " + (indicators.length ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M3 19a2 2 0 0 0 2 2c2 0 2 -4 3 -9s1 -9 3 -9a2 2 0 0 1 2 2"/><path d="M5 12h6"/><path d="M15 12l6 6"/><path d="M15 18l6 -6"/>
                </svg>
                Indicators
                {indicators.length > 0 && (
                  <span className="h-4 w-4 rounded-full text-[9px] font-bold flex items-center justify-center"
                    style={{ background: "#3b82f6", color: "#fff" }}>{indicators.length}</span>
                )}
              </span>
              {/* mobile: bare icon only */}
              <span className="sm:hidden flex items-center justify-center w-8 h-8 relative">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M3 19a2 2 0 0 0 2 2c2 0 2 -4 3 -9s1 -9 3 -9a2 2 0 0 1 2 2"/><path d="M5 12h6"/><path d="M15 12l6 6"/><path d="M15 18l6 -6"/>
                </svg>
                {indicators.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full text-[8px] font-bold flex items-center justify-center"
                    style={{ background: "#3b82f6", color: "#fff" }}>{indicators.length}</span>
                )}
              </span>
            </button>
          </div>


          {/* Timeframe — horizontal pills on mobile (no 1W), pills on desktop */}
          <div className="flex items-center ml-auto shrink-0" style={{ borderLeft: "1px solid rgba(255,255,255,0.08)" }}>
            {/* Mobile: horizontal scrollable, hide 1W */}
            <div className="sm:hidden flex items-center overflow-x-auto px-1.5" style={{ gap: 2, scrollbarWidth: "none" }}>
              {CHART_TIMEFRAMES.filter(t => t !== "1W").map(t => (
                <button key={t} onClick={() => setChartTf(t)}
                  className="px-2 text-[13px] font-semibold transition-all shrink-0 whitespace-nowrap flex items-center"
                  style={{
                    height: 28,
                    ...(chartTf === t
                      ? { background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 20, color: "#e2e8f0" }
                      : { borderRadius: 20, border: "1px solid transparent", color: "#64748b" })
                  }}>
                  {t}
                </button>
              ))}
            </div>
            {/* Desktop pills */}
            <div className="hidden sm:flex px-2" style={{ background: "rgba(255,255,255,0.03)", borderRadius: 24, padding: 3, gap: 2 }}>
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
            loading={false}
            chartType={chartType}
            indicators={indicators}
            solPrice={solPrice}
            symbol={token.symbol}
            graduated={token.graduated}
            graduatedAt={token.graduatedAt ?? null}
            onCrosshairMove={onCrosshairMove}
          />
        </div>
      </div>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartBars, chartType, chartTf, indicators, indOpen, connected, token?.address, token?.graduated, onCrosshairMove, solPrice]);

  const handleTrade = async () => {
    if (!wallet) {
      openWalletModal();
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
        description: tradeMode === "buy"
          ? `${amount} SOL → ${token.symbol} executed on-chain.`
          : `${amount} ${token.symbol} → SOL executed on-chain.`,
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

  // Prefer live snapshot identity (pushed by SSE on connect and after enrichment) over the
  // initial REST response, so name/symbol/image update in real time without a page refresh.
  const displayName     = (liveToken?.name   && !liveToken.name.endsWith("…")   && liveToken.name   !== "???" ? liveToken.name   : null) ?? token.name;
  const displaySymbol   = (liveToken?.symbol && liveToken.symbol !== "???"                                     ? liveToken.symbol : null) ?? token.symbol;
  const displayImageUrl = liveToken?.imageUrl ?? token.imageUrl;

  return (
    /* Full-bleed two-column layout — mirrors pump.fun */
    <div className="flex flex-col md:flex-row w-full animate-slideDown md:h-[calc(100dvh-96px)]">

      {/* ── LEFT: scrollable chart + info ── */}
      <div data-token-panel className="flex-1 min-w-0 overflow-y-auto border-r border-border/20 px-0 md:px-5 py-0 md:py-4 pb-20 md:pb-6">

        {/* Compact Token Header */}
        <div className="flex gap-3 items-start mb-2 px-3 pt-3 md:px-0 md:pt-0">
          <TokenAvatar symbol={displaySymbol} imageUrl={displayImageUrl} size={52} shape="square" className="border border-border/40 shadow-sm" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap leading-tight">
              <h1 className="text-lg font-bold text-foreground">{displayName}</h1>
              <span className="text-primary font-mono text-sm font-bold whitespace-nowrap">${displaySymbol}</span>
            </div>
            <div className="flex items-center gap-2 mt-2">
              {(token as any).twitterUrl && (
                <a href={(token as any).twitterUrl} target="_blank" rel="noopener noreferrer" className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground" title="Twitter"><Twitter className="h-4 w-4" /></a>
              )}
              {(token as any).websiteUrl && (
                <a href={(token as any).websiteUrl} target="_blank" rel="noopener noreferrer" className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground" title="Website"><Globe className="h-4 w-4" /></a>
              )}
              {/* Platform source link — always visible so users can verify on the origin launchpad */}
              {getPlatformUrl(token.platform as PlatformId, token.address) && (
                <a
                  href={getPlatformUrl(token.platform as PlatformId, token.address)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-8 px-2.5 flex items-center gap-1.5 rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground text-[11px] font-semibold"
                  title={`View on ${token.platform}`}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {token.platform === "pump_fun" ? "Pump.fun" :
                   token.platform === "moonshot" ? "Moonshot" :
                   token.platform === "letsbonk" ? "LetsBONK" :
                   token.platform === "daos_fun" ? "Daos.fun" :
                   token.platform === "raydium_launchlab" ? "Raydium" : "Source"}
                </a>
              )}
              <button className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground" title="Copy address" onClick={() => copyToClipboard(token.address)}><Copy className="h-4 w-4" /></button>
            </div>
          </div>
          {/* Share button — top-right, aligned with coin name */}
          <button
            className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground shrink-0"
            title="Share"
            onClick={() => setShareOpen(true)}
          >
            <Share2 className="h-5 w-5" />
          </button>
        </div>

        {/* Description */}
        {token.description && (() => {
          const LIMIT = 120;
          const isLong = token.description.length > LIMIT;
          return (
            <div className="mb-2 px-3 md:px-0">
              <p className="text-[14px] text-muted-foreground leading-relaxed">
                {isLong && !descExpanded
                  ? token.description.slice(0, LIMIT).trimEnd() + "…"
                  : token.description}
              </p>
              {isLong && (
                <button
                  onClick={() => setDescExpanded(v => !v)}
                  className="text-[13px] font-semibold mt-0.5 transition-colors"
                  style={{ color: "#4ade80" }}
                >
                  {descExpanded ? "Show less" : "Read more"}
                </button>
              )}
            </div>
          );
        })()}

        {/* ── Info strip above chart ── */}
        <div className="mb-2 px-3 md:px-0">

          {/* ── MOBILE: Row 1 — MC (left) + Price (right) ── */}
          <div className="flex items-start justify-between mb-2 md:hidden">
            <div className="flex flex-col justify-center">
              <span className="text-[12px] font-medium mb-0.5" style={{ color: "#94a3b8" }}>Market Cap</span>
              <span
                key={priceFlash.key}
                className={`text-[18px] font-bold text-foreground font-mono tabular-nums leading-tight${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
              >
                {formatMCUsd(effectiveMcEth, solPrice)}
              </span>
            </div>
            <div className="flex flex-col justify-center items-end">
              <span className="text-[12px] font-medium mb-0.5" style={{ color: "#94a3b8" }}>Price</span>
              <span
                key={`price-${priceFlash.key}`}
                className={`text-[18px] font-bold font-mono tabular-nums leading-tight${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
                style={{ color: "#e2e8f0" }}
              >
                {priceStats.currentPrice > 0
                  ? formatTokenPrice(solPrice ? priceStats.currentPrice * solPrice : priceStats.currentPrice)
                  : "—"}
              </span>
            </div>
          </div>

          {/* ── MOBILE: Row 2 — Bonding Curve full width ── */}
          <div className="md:hidden">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-medium" style={{ color: "#94a3b8" }}>Bonding Curve</span>
              <span
                className="text-[11px] font-bold font-mono px-1.5 py-0.5 rounded-full"
                style={{
                  background: isGraduated ? "rgba(34,197,94,0.12)" : "rgba(16,185,129,0.10)",
                  color: isGraduated ? "#22c55e" : "#10b981",
                  border: `1px solid ${isGraduated ? "rgba(34,197,94,0.28)" : "rgba(16,185,129,0.22)"}`,
                }}
              >
                {progressPercent >= 100 ? "100%" : `${progressPercent.toFixed(1)}%`}
              </span>
            </div>
            <div className="relative h-2 w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
              {[25, 50, 75].map(m => (
                <div key={m} className="absolute top-0 h-full w-px pointer-events-none" style={{ left: `${m}%`, background: "rgba(0,0,0,0.45)", zIndex: 2 }} />
              ))}
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min(progressPercent, 100)}%`,
                  background: isGraduated
                    ? "linear-gradient(90deg, #16a34a 0%, #22c55e 55%, #4ade80 100%)"
                    : "linear-gradient(90deg, #059669 0%, #10b981 55%, #34d399 100%)",
                  boxShadow: isGraduated ? "0 0 8px rgba(34,197,94,0.40)" : "0 0 7px rgba(16,185,129,0.38)",
                }}
              />
            </div>
            {isGraduated ? (
              <div className="flex items-center gap-1.5 mt-1">
                <span style={{ fontSize: 9, color: "#22c55e" }}>✓</span>
                <span className="text-[11px] font-semibold" style={{ color: "#22c55e" }}>Graduated to Raydium</span>
                {token.graduatedAt && <span className="text-[10px]" style={{ color: "#64748b" }}>· {timeAgo(token.graduatedAt)} ago</span>}
              </div>
            ) : (
              <div className="flex items-center justify-between mt-1">
                <span className="text-[12px] font-mono text-foreground">
                  {realSolInCurve.toFixed(2)}<span className="text-muted-foreground ml-1">/ 85 SOL</span>
                </span>
                <span className="text-[12px] font-medium" style={{ color: "#94a3b8" }}>
                  {(85 - realSolInCurve).toFixed(2)} SOL left
                </span>
              </div>
            )}
          </div>

          {/* ── MOBILE: Row 3 — Vol 24h (left) + 5m / 1h / 6h % (right) ── */}
          <div className="flex items-center justify-between mt-2 md:hidden">
            <div className="flex flex-col justify-center">
              <span className="text-[12px] font-medium mb-0.5" style={{ color: "#94a3b8" }}>Vol 24h</span>
              <span className="font-mono font-bold text-[18px] tabular-nums leading-tight" style={{ color: "#e2e8f0" }}>
                {solPrice && priceStats.vol24h > 0 ? formatUSD(priceStats.vol24h * solPrice) : "—"}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {([
                { label: "5m", data: priceStats.p5m },
                { label: "1h", data: priceStats.p1h },
                { label: "6h", data: priceStats.p6h },
              ] as { label: string; data: { val: string; up: boolean } | null }[]).map(({ label, data }) => (
                <div key={label} className="flex flex-col items-center">
                  <span className="text-[12px] font-medium mb-0.5" style={{ color: "#64748b" }}>{label}</span>
                  <span
                    className="font-mono font-bold text-[14px] tabular-nums leading-tight"
                    style={{ color: data ? (data.up ? "#4ade80" : "#f87171") : "#475569" }}
                  >
                    {data?.val ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── DESKTOP (md+): original 3-column horizontal ── */}
          <div className="hidden md:flex items-center gap-3">
            {/* Market Cap */}
            <div className="flex-1 flex flex-col justify-center">
              <span className="text-[14px] font-medium mb-0.5" style={{ color: "#94a3b8" }}>Market Cap</span>
              <span
                key={priceFlash.key}
                className={`text-[20px] font-bold text-foreground font-mono tabular-nums leading-tight${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
              >
                {formatMCUsd(effectiveMcEth, solPrice)}
              </span>
            </div>
            {/* Bonding Curve */}
            <div className="w-[380px] shrink-0 flex flex-col justify-center">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[14px] font-medium" style={{ color: "#94a3b8" }}>Bonding Curve</span>
                <span
                  className="text-[12px] font-bold font-mono px-1.5 py-0.5 rounded-full"
                  style={{
                    background: isGraduated ? "rgba(34,197,94,0.12)" : "rgba(16,185,129,0.10)",
                    color: isGraduated ? "#22c55e" : "#10b981",
                    border: `1px solid ${isGraduated ? "rgba(34,197,94,0.28)" : "rgba(16,185,129,0.22)"}`,
                  }}
                >
                  {progressPercent >= 100 ? "100%" : `${progressPercent.toFixed(1)}%`}
                </span>
              </div>
              <div className="relative h-2 w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                {[25, 50, 75].map(m => (
                  <div key={m} className="absolute top-0 h-full w-px pointer-events-none" style={{ left: `${m}%`, background: "rgba(0,0,0,0.45)", zIndex: 2 }} />
                ))}
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${Math.min(progressPercent, 100)}%`,
                    background: isGraduated
                      ? "linear-gradient(90deg, #16a34a 0%, #22c55e 55%, #4ade80 100%)"
                      : "linear-gradient(90deg, #059669 0%, #10b981 55%, #34d399 100%)",
                    boxShadow: isGraduated ? "0 0 8px rgba(34,197,94,0.40)" : "0 0 7px rgba(16,185,129,0.38)",
                  }}
                />
              </div>
              {isGraduated ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <span style={{ fontSize: 9, color: "#22c55e" }}>✓</span>
                  <span className="text-[11px] font-semibold" style={{ color: "#22c55e" }}>Graduated to Raydium</span>
                  {token.graduatedAt && <span className="text-[10px]" style={{ color: "#64748b" }}>· {timeAgo(token.graduatedAt)} ago</span>}
                </div>
              ) : (
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[12px] font-mono text-foreground">
                    {realSolInCurve.toFixed(2)}<span className="text-muted-foreground ml-1">/ 85 SOL</span>
                  </span>
                  <span className="text-[12px] font-medium" style={{ color: "#94a3b8" }}>
                    {(85 - realSolInCurve).toFixed(2)} SOL left
                  </span>
                </div>
              )}
            </div>
            {/* Price */}
            <div className="flex-1 flex flex-col justify-center items-end">
              <span className="text-[12px] font-medium mb-0.5" style={{ color: "#94a3b8" }}>Price USD</span>
              <span
                key={`price-${priceFlash.key}`}
                className={`text-[16px] font-bold font-mono tabular-nums leading-tight${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
                style={{ color: "#e2e8f0" }}
              >
                {priceStats.currentPrice > 0
                  ? formatTokenPrice(solPrice ? priceStats.currentPrice * solPrice : priceStats.currentPrice)
                  : "—"}
              </span>
            </div>
          </div>

        </div>

        {/* Chart Area */}
        {ChartSection}

        {/* ── MOBILE ONLY: Buy/Sell form below chart ── */}
        <div className="md:hidden px-3 pt-3 pb-1">
          <div className="bg-card border border-border/60 rounded-sm overflow-hidden shadow-sm">
            <TradePanelForm
              tradeMode={tradeMode}
              setTradeMode={setTradeMode}
              amount={amount}
              setAmount={setAmount}
              token={token}
              wallet={wallet}
              handleTrade={handleTrade}
              isPending={recordTrade.isPending || updateToken.isPending}
            />
          </div>
        </div>

        {/* Indicator picker modal */}
        <IndicatorModal
          open={indOpen}
          onClose={() => setIndOpen(false)}
          active={indicators}
          onToggle={toggleIndicator}
        />


        {/* Transactions + Holders tabs */}
        {(() => {
          // Server-side holder list — aggregated over the FULL trade history in DB.
          // The old client-side approach used the 100-row history cap, which wildly
          // underestimates holders for high-volume tokens (e.g. 34 instead of 265).
          const holders = serverHolders ?? [];
          const totalSupply = holders.reduce(
            (s, h) => s + Math.max(0, parseFloat(h.balance) || 0), 0
          ) || 1;

          return (
            <div className="mt-0 px-3 md:px-0">
              {/* Bug fix: React state-based sub-tabs (no more document.getElementById) */}
              <div className="flex gap-2 mb-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
                <button
                  onClick={() => setActiveSubTab("tx")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all shrink-0"
                  style={{
                    background: activeSubTab === "tx" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "tx" ? "#e2e8f0" : "#64748b",
                    border: "1px solid " + (activeSubTab === "tx" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <ArrowRightLeft className="h-3.5 w-3.5" /> Trades
                </button>
                <button
                  onClick={() => setActiveSubTab("holders")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all shrink-0"
                  style={{
                    background: activeSubTab === "holders" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "holders" ? "#e2e8f0" : "#64748b",
                    border: "1px solid " + (activeSubTab === "holders" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <Users className="h-3.5 w-3.5" /> Holders{holders.length > 0 && <span className="ml-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.08)", color: activeSubTab === "holders" ? "#e2e8f0" : "#94a3b8" }}>{holders.length.toLocaleString()}</span>}
                </button>
                <button
                  onClick={() => setActiveSubTab("positions")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all shrink-0"
                  style={{
                    background: activeSubTab === "positions" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "positions" ? "#e2e8f0" : "#64748b",
                    border: "1px solid " + (activeSubTab === "positions" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <TrendingUp className="h-3.5 w-3.5" /> Positions
                </button>
              </div>

              {/* Trades panel */}
              <div className={`overflow-x-auto rounded-lg ${activeSubTab !== "tx" ? "hidden" : ""}`}
                style={{ border: "1px solid rgba(255,255,255,0.06)", WebkitOverflowScrolling: "touch" }}>
                <table className="text-[14px]" style={{ minWidth: "520px", width: "100%" }}>
                  <thead style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
                    <tr>
                      <th className="text-left px-3 py-2.5 font-normal text-[14px]" style={{ color: "#94a3b8" }}>Type</th>
                      <th className="text-right px-3 py-2.5 font-normal text-[14px]" style={{ color: "#94a3b8" }}>Amount SOL</th>
                      <th className="text-right px-3 py-2.5 font-normal text-[14px]" style={{ color: "#94a3b8" }}>{token.symbol}</th>
                      <th className="text-right px-3 py-2.5 font-normal text-[14px]" style={{ color: "#94a3b8" }}>Time</th>
                      <th className="text-right px-3 py-2.5 font-normal text-[14px]" style={{ color: "#94a3b8" }}>Txn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingHistory ? (
                      [...Array(4)].map((_, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                          <td colSpan={5} className="px-3 py-3"><Skeleton className="h-3.5 w-full" /></td>
                        </tr>
                      ))
                    ) : historyError ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-10 text-center text-[13px]" style={{ color: "#f87171" }}>
                          Failed to load trades.{" "}
                          <button onClick={() => refetchHistory()} className="underline hover:opacity-80 transition-opacity">Retry</button>
                        </td>
                      </tr>
                    ) : (() => {
                      const historyTxHashes = new Set((history ?? []).map(t => t.txHash));
                      const dedupedLive = liveTrades.filter(lt => !historyTxHashes.has(lt.txHash));
                      const allRows = [...dedupedLive, ...(history ?? [])].slice(0, 50);
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
                            className={isLive ? (isBuy ? "animate-trade-buy" : "animate-trade-sell") : "transition-colors"}
                            style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.025)")}
                            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                          >
                            {/* Type */}
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-2">
                                <span className="text-[14px] font-normal"
                                  style={{ color: isBuy ? "#4ade80" : "#f87171" }}>
                                  {isBuy ? "Buy" : "Sell"}
                                </span>
                              </div>
                            </td>
                            {/* Amount SOL */}
                            <td className="px-3 py-2.5 text-right font-mono text-[14px]" style={{ color: "#e2e8f0" }}>
                              {formatSol(trade.ethAmount)}
                            </td>
                            {/* Token amount */}
                            <td className="px-3 py-2.5 text-right font-mono text-[14px]" style={{ color: "#94a3b8" }}>
                              {formatTokenAmount(trade.tokenAmount)}
                            </td>
                            {/* Time */}
                            <td className="px-3 py-2.5 text-right text-[14px]" style={{ color: "#94a3b8" }}>
                              {timeAgo(trade.timestamp)}
                            </td>
                            {/* Txn */}
                            <td className="px-3 py-2.5 text-right">
                              {trade.txHash ? (
                                <a
                                  href={`https://solscan.io/tx/${trade.txHash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 font-mono text-[12px] transition-colors"
                                  style={{ color: "#94a3b8" }}
                                  onMouseEnter={e => ((e.currentTarget as HTMLAnchorElement).style.color = "#cbd5e1")}
                                  onMouseLeave={e => ((e.currentTarget as HTMLAnchorElement).style.color = "#94a3b8")}
                                >
                                  {trade.txHash.slice(0, 6)}…
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : (
                                <span className="font-mono text-[12px]" style={{ color: "#475569" }}>—</span>
                              )}
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>

              {/* Positions panel */}
              {activeSubTab === "positions" && (() => {
                if (!wallet) {
                  return (
                    <div className="flex flex-col items-center justify-center py-16 gap-4 rounded-lg"
                      style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                      <button
                        onClick={() => openWalletModal()}
                        className="px-8 py-2.5 rounded-md text-[14px] font-semibold tracking-wide transition-all hover:opacity-90 active:scale-95"
                        style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.18)", color: "#e2e8f0" }}
                      >
                        CONNECT WALLET
                      </button>
                    </div>
                  );
                }

                // Position tracking is only accurate for pump.fun tokens.
                // pump.fun mints always use 6 decimals and emit price_eth in
                // SOL/token. LetsBONK and Raydium mint decimals and price
                // normalisation differ per adapter and are not yet stored in DB,
                // so we explicitly scope this feature to avoid showing inflated /
                // incorrect PnL for those platforms.
                if (token.platform !== "pump_fun") {
                  return (
                    <div className="flex flex-col items-center justify-center py-14 gap-3 rounded-lg"
                      style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                      <Activity className="h-7 w-7" style={{ color: "#334155" }} />
                      <p className="text-[14px] font-medium text-center" style={{ color: "#64748b" }}>
                        Position tracking is only available for Pump.fun tokens
                      </p>
                    </div>
                  );
                }

                // Loading skeleton while server fetches full trade history
                if (loadingPosition) {
                  return (
                    <div className="rounded-lg overflow-hidden space-y-px animate-pulse"
                      style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div className="px-4 py-4" style={{ background: "rgba(255,255,255,0.03)" }}>
                        <div className="h-3 w-24 rounded bg-white/[0.06] mb-2" />
                        <div className="h-7 w-40 rounded bg-white/[0.06] mb-1" />
                        <div className="h-4 w-28 rounded bg-white/[0.05]" />
                      </div>
                      {[...Array(5)].map((_, i) => (
                        <div key={i} className="flex justify-between px-4 py-2.5" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                          <div className="h-3.5 w-24 rounded bg-white/[0.05]" />
                          <div className="h-3.5 w-20 rounded bg-white/[0.05]" />
                        </div>
                      ))}
                    </div>
                  );
                }

                // ── Server-side base + live SSE overlay (id-gated, no double-count) ──
                // serverPosition aggregates ALL trades in DB for this wallet+token.
                // freshLiveTrades overlays only SSE trades with id > maxTradeId so
                // trades already baked into the server aggregate are never counted twice.
                //
                // UNIT CONVENTIONS (must be consistent throughout this block):
                //   solSpent / solReceived   → SOL  (server returns lamports → ÷1e9)
                //   tokensBought / tokensSold → display tokens (server returns atomic → ÷1e6)
                //   priceStats.currentPrice  → SOL per display token (already correct)
                //   ethAmount in SSE trades  → lamports → ÷1e9
                //   tokenAmount in SSE trades → atomic   → ÷1e6
                //   pump.fun tokens are always 6 decimals (1e6 atomic = 1 display token)
                const LAMPORTS_PER_SOL = 1e9;
                const ATOMIC_PER_DISPLAY = 1e6; // pump.fun fixed 6 decimals

                const maxId = serverPosition?.maxTradeId ?? 0;
                const freshLiveTrades = liveTrades.filter(
                  lt => lt.traderAddress === wallet && (lt.id ?? 0) > maxId
                );

                // Server values: convert from raw DB units to display units
                let tokensBought = (serverPosition?.tokensBought ?? 0) / ATOMIC_PER_DISPLAY;
                let tokensSold   = (serverPosition?.tokensSold   ?? 0) / ATOMIC_PER_DISPLAY;
                let solSpent     = (serverPosition?.solSpent     ?? 0) / LAMPORTS_PER_SOL;
                let solReceived  = (serverPosition?.solReceived  ?? 0) / LAMPORTS_PER_SOL;

                // Live overlay: same conversions so units stay consistent
                freshLiveTrades.forEach(t => {
                  const tok = (parseFloat(t.tokenAmount ?? "0") || 0) / ATOMIC_PER_DISPLAY;
                  const sol = (parseFloat(t.ethAmount   ?? "0") || 0) / LAMPORTS_PER_SOL;
                  if (t.isBuy) { tokensBought += tok; solSpent    += sol; }
                  else          { tokensSold   += tok; solReceived += sol; }
                });

                const hasAnyTrades = (serverPosition?.tradeCount ?? 0) > 0 || freshLiveTrades.length > 0;

                if (!hasAnyTrades) {
                  return (
                    <div className="flex flex-col items-center justify-center py-14 gap-3 rounded-lg"
                      style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                      <TrendingUp className="h-8 w-8" style={{ color: "#334155" }} />
                      <p className="text-[14px] font-medium" style={{ color: "#64748b" }}>No position in this token</p>
                    </div>
                  );
                }

                const netTokens      = Math.max(0, tokensBought - tokensSold);
                const avgBuyPriceSol = tokensBought > 0 ? solSpent / tokensBought : 0;
                const currentPriceSol = priceStats.currentPrice;
                const currentValueSol = netTokens * currentPriceSol;
                const totalPnlSol     = (solReceived + currentValueSol) - solSpent;
                const totalPnlPct     = solSpent > 0 ? (totalPnlSol / solSpent) * 100 : 0;
                const isProfit        = totalPnlSol >= 0;

                const fmtSol = (v: number) => v.toFixed(4) + " SOL";
                const fmtUsd = (v: number) => solPrice ? formatUSD(v * solPrice) : null;
                const pnlColor = isProfit ? "#4ade80" : "#f87171";

                const rows: { label: string; value: string; sub?: string | null }[] = [
                  { label: "Tokens Held",   value: netTokens > 0 ? netTokens.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0", sub: token.symbol },
                  { label: "Avg Buy Price", value: avgBuyPriceSol > 0 ? (solPrice ? formatTokenPrice(avgBuyPriceSol * solPrice) : avgBuyPriceSol.toPrecision(4) + " SOL") : "—", sub: null },
                  { label: "Current Price", value: currentPriceSol > 0 ? (solPrice ? formatTokenPrice(currentPriceSol * solPrice) : currentPriceSol.toPrecision(4) + " SOL") : "—", sub: null },
                  { label: "Current Value", value: fmtSol(currentValueSol), sub: fmtUsd(currentValueSol) },
                  { label: "SOL Spent",     value: fmtSol(solSpent),     sub: fmtUsd(solSpent) },
                  { label: "SOL Received",  value: fmtSol(solReceived),  sub: fmtUsd(solReceived) },
                ];

                return (
                  <div className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                    {/* P&L Hero */}
                    <div className="flex items-center justify-between px-4 py-4"
                      style={{ background: isProfit ? "rgba(74,222,128,0.06)" : "rgba(248,113,113,0.06)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <div>
                        <p className="text-[12px] font-medium mb-0.5" style={{ color: "#64748b" }}>Unrealized P&L</p>
                        <p className="text-[22px] font-bold font-mono" style={{ color: pnlColor }}>
                          {isProfit ? "+" : ""}{fmtSol(totalPnlSol)}
                        </p>
                        {fmtUsd(totalPnlSol) && (
                          <p className="text-[13px] font-mono" style={{ color: pnlColor }}>
                            {isProfit ? "+" : ""}{fmtUsd(totalPnlSol)}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end">
                        <span className="text-[11px] font-medium mb-1" style={{ color: "#64748b" }}>Return</span>
                        <span className="text-[20px] font-bold font-mono" style={{ color: pnlColor }}>
                          {isProfit ? "+" : ""}{totalPnlPct.toFixed(2)}%
                        </span>
                      </div>
                    </div>
                    {/* Stats grid */}
                    {rows.map(({ label, value, sub }, i) => (
                      <div key={label} className="flex items-center justify-between px-4 py-2.5"
                        style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
                        <span className="text-[13px]" style={{ color: "#64748b" }}>{label}</span>
                        <div className="text-right">
                          <span className="text-[13px] font-mono font-semibold" style={{ color: "#e2e8f0" }}>{value}</span>
                          {sub && sub !== token.symbol && (
                            <p className="text-[11px] font-mono" style={{ color: "#475569" }}>{sub}</p>
                          )}
                          {sub === token.symbol && (
                            <p className="text-[11px]" style={{ color: "#475569" }}>{sub}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Holders panel */}
              <div className={`overflow-x-auto rounded-b-sm border-x border-b border-border/40 ${activeSubTab !== "holders" ? "hidden" : ""}`}>
                <table className="w-full text-[14px] font-mono">
                  <thead className="text-muted-foreground border-b border-border/40 bg-muted/20 text-[14px]">
                    <tr>
                      <th className="text-left px-3 py-2.5 font-medium" style={{ color: "#94a3b8" }}>#</th>
                      <th className="text-left px-3 py-2.5 font-medium" style={{ color: "#94a3b8" }}>Address</th>
                      <th className="text-right px-3 py-2.5 font-medium" style={{ color: "#94a3b8" }}>{token.symbol}</th>
                      <th className="text-right px-3 py-2.5 font-medium" style={{ color: "#94a3b8" }}>Share</th>
                      <th className="px-3 py-2.5 w-24"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/20">
                    {loadingHolders ? (
                      [...Array(4)].map((_, i) => (
                        <tr key={i}><td colSpan={5} className="px-3 py-2.5"><Skeleton className="h-3.5 w-full" /></td></tr>
                      ))
                    ) : holders.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground/60 text-[11px]">No holders yet.</td>
                      </tr>
                    ) : holders.map(({ address: addr, balance }, idx) => {
                      const bal = Math.max(0, parseFloat(balance) || 0);
                      const pct = (bal / totalSupply) * 100;
                      return (
                        <tr key={addr} className="hover:bg-white/[0.025] transition-colors">
                          <td className="px-3 py-2.5 text-[14px]" style={{ color: "#64748b" }}>{idx + 1}</td>
                          <td className="px-3 py-2.5 text-[14px]">
                            <div className="flex items-center gap-2">
                              <TokenAvatar symbol={addr.slice(0, 4)} size={20} shape="circle" />
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
                          <td className="px-3 py-2.5 text-right text-[14px] text-foreground">{formatTokenAmount(balance)}</td>
                          <td className="px-3 py-2.5 text-right text-[14px] text-primary font-bold">{pct.toFixed(1)}%</td>
                          <td className="px-3 py-2.5">
                            <div className="h-1.5 w-20 bg-muted/50 rounded-full overflow-hidden">
                              <div className="h-full bg-primary rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
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

      {/* ── RIGHT: sticky buy panel — hidden on mobile (buy/sell is inlined below chart) ── */}
      <div className="hidden md:flex md:flex-col w-full md:w-[280px] xl:w-[300px] shrink-0 md:overflow-y-auto md:h-full px-3 py-3 md:px-4 md:py-4 space-y-3">

        {/* Stats: Price / Vol 24h / % changes */}
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}>
          {/* Price + Vol 24h */}
          <div className="grid grid-cols-2 divide-x divide-white/[0.08]" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="flex flex-col px-4 py-3">
              <span className="text-[13px] font-medium mb-1" style={{ color: "#94a3b8" }}>Price</span>
              <span
                key={`price-${priceFlash.key}`}
                className={`font-mono font-bold text-[15px]${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
                style={{ color: "#e2e8f0" }}
                dangerouslySetInnerHTML={{
                  __html: priceStats.currentPrice > 0
                    ? formatTokenPrice(solPrice ? priceStats.currentPrice * solPrice : priceStats.currentPrice)
                    : "—"
                }}
              />
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
                <span
                  key={`${label}-${data?.val ?? "null"}-${priceFlash.key}`}
                  className={`font-mono font-bold text-[13px]${data && priceFlash.key > 0 ? (data.up ? " animate-stat-up" : " animate-stat-down") : ""}`}
                  style={{ color: data ? (data.up ? "#4ade80" : "#f87171") : "#475569" }}
                >
                  {data?.val ?? "—"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 24h Vol + Txns card — Birdeye style */}
        {(() => {
          const { vol24hBuy, vol24hSell, txns24hBuy, txns24hSell } = priceStats;
          const totalTxns = txns24hBuy + txns24hSell;
          const sp = solPrice ?? 0;

          // Short-format: $1.23M, $57K, 153K, etc.
          const shortUsd = (sol: number) => {
            const u = sol * sp;
            if (!sp || u === 0) return "—";
            if (u >= 1_000_000) return `$${(u / 1_000_000).toFixed(2)}M`;
            if (u >= 1_000)     return `$${Math.round(u / 1_000)}K`;
            return `$${u.toFixed(2)}`;
          };
          const shortNum = (n: number) => {
            if (n === 0) return "—";
            if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
            if (n >= 1_000)     return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
            return `${n}`;
          };
          const signedUsd = (sol: number) => {
            const u = sol * sp;
            if (!sp) return "—";
            const abs = Math.abs(u);
            const sign = u >= 0 ? "+" : "-";
            if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
            if (abs >= 1_000)     return `${sign}$${Math.round(abs / 1_000)}K`;
            return `${sign}$${abs.toFixed(2)}`;
          };
          const signedNum = (n: number) => {
            if (n === 0) return "—";
            const sign = n >= 0 ? "+" : "-";
            const abs = Math.abs(n);
            if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
            if (abs >= 1_000)     return `${sign}${Math.round(abs / 1_000)}K`;
            return `${sign}${abs}`;
          };

          const DIV = "1px solid rgba(255,255,255,0.07)";

          const rows = [
            {
              label: "24h Vol",
              total: shortUsd(vol24hBuy + vol24hSell),
              buy:   shortUsd(vol24hBuy),
              sell:  shortUsd(vol24hSell),
              net:   signedUsd(vol24hBuy - vol24hSell),
              netUp: vol24hBuy >= vol24hSell,
              buyPct: (vol24hBuy + vol24hSell) > 0 ? (vol24hBuy / (vol24hBuy + vol24hSell)) * 100 : 50,
            },
            {
              label: "24h Txns",
              total: shortNum(txns24hBuy + txns24hSell),
              buy:   shortNum(txns24hBuy),
              sell:  shortNum(txns24hSell),
              net:   signedNum(txns24hBuy - txns24hSell),
              netUp: txns24hBuy >= txns24hSell,
              buyPct: totalTxns > 0 ? (txns24hBuy / totalTxns) * 100 : 50,
            },
          ];

          return (
            <div className="rounded-xl overflow-hidden" style={{ border: DIV, background: "rgba(255,255,255,0.03)" }}>
              {rows.map(({ label, total, buy, sell, net, netUp, buyPct }, i) => (
                <div key={label} style={{ borderTop: i > 0 ? DIV : "none" }}>
                  <div className="grid grid-cols-3 items-start px-3 pt-2.5 pb-1.5 gap-1">
                    {/* Label + total */}
                    <div className="flex flex-col">
                      <span className="text-[11px] font-medium mb-0.5" style={{ color: "#64748b" }}>{label}</span>
                      <span className="text-[13px] font-mono font-bold" style={{ color: "#e2e8f0" }}>{total}</span>
                    </div>
                    {/* Buy */}
                    <div className="flex flex-col items-start pl-4">
                      <span className="text-[11px] font-medium mb-0.5" style={{ color: "#64748b" }}>Buy</span>
                      <span className="text-[13px] font-mono font-bold" style={{ color: "#4ade80" }}>{buy}</span>
                    </div>
                    {/* Sell — right-aligned */}
                    <div className="flex flex-col items-end">
                      <span className="text-[11px] font-medium mb-0.5" style={{ color: "#64748b" }}>Sell</span>
                      <span className="text-[13px] font-mono font-bold" style={{ color: "#f87171" }}>{sell}</span>
                    </div>
                  </div>
                  {/* Buy/Sell progress bar */}
                  <div
                    key={`bar-${label}-${Math.round(buyPct)}`}
                    className="animate-bar-pulse flex h-1 mx-3 mb-2.5 rounded-full overflow-hidden"
                    style={{ background: "#f6583c" }}
                  >
                    <div className="h-full transition-all duration-700" style={{ width: `${buyPct}%`, background: "#4ade80" }} />
                  </div>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Buy/Sell Panel */}
        <div className="bg-card border border-border/60 rounded-sm overflow-hidden shadow-sm">
          <TradePanelForm
            tradeMode={tradeMode}
            setTradeMode={setTradeMode}
            amount={amount}
            setAmount={setAmount}
            token={token}
            wallet={wallet}
            handleTrade={handleTrade}
            isPending={recordTrade.isPending || updateToken.isPending}
          />
        </div>

      </div>

      {/* Share Modal */}
      <ShareModal
        token={token}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        solPrice={solPrice}
        priceStats={{
          currentPrice: priceStats.currentPrice,
          vol24h: priceStats.vol24h,
          vol24hBuy: priceStats.vol24hBuy,
          vol24hSell: priceStats.vol24hSell,
          txns24hBuy: priceStats.txns24hBuy,
          txns24hSell: priceStats.txns24hSell,
          p5m: priceStats.p5m,
          p1h: priceStats.p1h,
          p6h: priceStats.p6h,
          p24h: (priceStats as any).p24h ?? null,
        }}
      />
    </div>
  );
}

// ── Shared buy/sell form used in both desktop side-panel and mobile drawer ────

interface TradePanelFormProps {
  tradeMode: "buy" | "sell";
  setTradeMode: (m: "buy" | "sell") => void;
  amount: string;
  setAmount: (v: string) => void;
  token: { symbol: string; virtualTokenReserves?: string | null };
  wallet: string | null;
  handleTrade: () => Promise<void>;
  isPending: boolean;
}

function TradePanelForm({
  tradeMode, setTradeMode, amount, setAmount, token, wallet, handleTrade, isPending,
}: TradePanelFormProps) {
  return (
    <>
      {/* Mode tabs — sliding pill */}
      <div className="relative flex border-b border-border/40 p-1 gap-1 bg-muted/30">
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
          {tradeMode === "buy"
            ? [{ label: "$25", val: "0.008" }, { label: "$100", val: "0.033" }, { label: "$250", val: "0.083" }].map(({ label, val }) => (
              <button
                key={label}
                className="flex-1 py-1.5 bg-muted/60 rounded text-xs font-bold text-muted-foreground hover:bg-white/10 hover:text-foreground border border-border/40 transition-all duration-150 active:scale-95"
                onClick={() => setAmount(val)}
              >{label}</button>
            ))
            : [{ label: "25%", pct: 0.25 }, { label: "50%", pct: 0.5 }, { label: "100%", pct: 1 }].map(({ label, pct }) => (
              <button
                key={label}
                className="flex-1 py-1.5 bg-muted/60 rounded text-xs font-bold text-muted-foreground hover:bg-white/10 hover:text-foreground border border-border/40 transition-all duration-150 active:scale-95"
                onClick={() => {
                  const reserves = token.virtualTokenReserves ? parseFloat(token.virtualTokenReserves) : 0;
                  setAmount((reserves * pct * 0.0001).toFixed(2));
                }}
              >{label}</button>
            ))
          }
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
            <span className="font-bold text-muted-foreground font-mono text-sm">{tradeMode === "buy" ? "SOL" : token.symbol}</span>
          </div>
        </div>

        {/* Trade button */}
        <Button
          className={`w-full h-11 text-sm font-bold rounded-sm shadow-none transition-all duration-200 active:scale-[0.98] ${tradeMode === "buy" ? "bg-primary hover:bg-primary/90 hover:shadow-[0_0_16px_hsl(142_100%_45%/0.35)] text-white" : "bg-destructive hover:bg-destructive/90 hover:shadow-[0_0_16px_hsl(0_84%_60%/0.3)] text-white"}`}
          onClick={handleTrade}
          disabled={isPending}
        >
          {isPending
            ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /></span>
            : !wallet ? "Connect wallet to trade" : "place trade"}
        </Button>
      </div>
    </>
  );
}

function PortfolioTab({ wallet, onSelectToken }: { wallet: string | null, onSelectToken: (addr: string) => void }) {
  const { openWalletModal } = useWallet();
  const solPrice = useSolPrice();

  // Holdings: tokens this wallet has a positive net balance in (all trades in DB)
  const { data: holdingsData, isLoading, isError, refetch } = useQuery({
    queryKey: ["holdings", wallet],
    queryFn: async (): Promise<{
      address: string; balance: string; name: string; symbol: string;
      imageUrl: string | null; priceEth: string | null; marketCapEth: string | null; volumeEth: string | null;
    }[]> => {
      if (!wallet) return [];
      const res = await fetch(`/api/wallet/${wallet}/holdings`);
      if (!res.ok) return [];
      const json = await res.json();
      return json.holdings ?? [];
    },
    enabled: !!wallet,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  // ── No wallet: full-page connect prompt ──
  if (!wallet) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-5 animate-slideDown">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)" }}>
          <Users className="h-8 w-8" style={{ color: "#334155" }} />
        </div>
        <div className="text-center space-y-1">
          <p className="text-[16px] font-semibold text-foreground">Connect your wallet</p>
          <p className="text-[13px]" style={{ color: "#64748b" }}>See all tokens you hold across every trade</p>
        </div>
        <button
          onClick={() => openWalletModal()}
          className="px-8 py-2.5 rounded-xl text-[14px] font-bold transition-all hover:opacity-90 active:scale-95"
          style={{
            background: "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)",
            color: "#fff",
            boxShadow: "0 0 20px rgba(34,197,94,0.25)",
          }}
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  // ── Loading ──
  if (isLoading) {
    return (
      <div className="max-w-[800px] animate-slideDown space-y-3">
        <div className="flex items-center justify-between mb-4">
          <div className="h-6 w-32 rounded-lg bg-white/[0.06] animate-pulse" />
        </div>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 p-4 rounded-xl" style={{ border: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
            <div className="w-10 h-10 rounded-lg bg-white/[0.06] animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-28 rounded bg-white/[0.06] animate-pulse" />
              <div className="h-3 w-20 rounded bg-white/[0.04] animate-pulse" />
            </div>
            <div className="h-4 w-16 rounded bg-white/[0.06] animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  // ── Error ──
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 animate-slideDown">
        <p className="text-[14px]" style={{ color: "#f87171" }}>Failed to load holdings.</p>
        <button onClick={() => refetch()} className="text-[13px] text-primary underline hover:opacity-80 transition-opacity">Retry</button>
      </div>
    );
  }

  const holdings = holdingsData ?? [];

  // ── Empty ──
  if (holdings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 animate-slideDown">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
          <TrendingUp className="h-7 w-7" style={{ color: "#334155" }} />
        </div>
        <div className="text-center space-y-1">
          <p className="text-[15px] font-semibold text-foreground">No tokens found</p>
          <p className="text-[13px]" style={{ color: "#64748b" }}>Buy some tokens and they'll appear here</p>
        </div>
      </div>
    );
  }

  // ── Holdings list ──
  return (
    <div className="max-w-[800px] animate-slideDown">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[16px] font-bold text-foreground">
          My Tokens
          <span className="ml-2 text-[12px] font-normal px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.07)", color: "#94a3b8" }}>
            {holdings.length}
          </span>
        </h2>
        <span className="text-[12px] font-mono" style={{ color: "#475569" }}>{formatAddress(wallet)}</span>
      </div>

      <div className="space-y-2">
        {holdings.map((token, idx) => {
          const price = token.priceEth ? parseFloat(token.priceEth) : 0;
          const balance = parseFloat(token.balance) || 0;
          const valueEth = price * balance;           // in lamports
          const valueSol = valueEth / 1e9;
          const valueUsd = solPrice ? valueSol * solPrice : null;

          return (
            <div
              key={token.address}
              onClick={() => onSelectToken(token.address)}
              className="flex items-center gap-4 p-3.5 rounded-xl cursor-pointer group transition-all"
              style={{ border: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.02)" }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.04)";
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.12)";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.02)";
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.07)";
              }}
            >
              {/* Rank */}
              <span className="text-[12px] w-5 text-center shrink-0 tabular-nums" style={{ color: "#475569" }}>{idx + 1}</span>

              {/* Avatar */}
              <TokenAvatar symbol={token.symbol} imageUrl={token.imageUrl ?? undefined} size={40} shape="square" />

              {/* Name + symbol */}
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                  {token.name}
                </div>
                <div className="text-[12px] font-mono mt-0.5" style={{ color: "#4ade80" }}>${token.symbol}</div>
              </div>

              {/* Balance */}
              <div className="text-right shrink-0">
                <div className="text-[13px] font-mono text-foreground">{formatTokenAmount(token.balance)}</div>
                <div className="text-[11px] font-mono mt-0.5" style={{ color: "#64748b" }}>
                  {valueUsd != null && valueUsd > 0 ? formatUSD(valueUsd) : valueSol > 0 ? valueSol.toFixed(4) + " SOL" : "—"}
                </div>
              </div>

              {/* Arrow */}
              <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" style={{ color: "#94a3b8" }} />
            </div>
          );
        })}
      </div>
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
