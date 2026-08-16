import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { 
  useCreateToken, 
  useGetToken, 
  useRecordTrade, 
  useUpdateToken,
  useTradeHistory,
  useGetTokenOhlcv,
  useListTokens,
  useGetTrendingTokens,
  useGetTopWallets,
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
import { useSolBalance } from "@/hooks/useSolBalance";
import { useTokenBalance } from "@/hooks/useTokenBalance";

import { ethers } from "ethers";
import { formatEth, formatAddress, parseEth, formatMC, formatMCUsd, formatUSD, formatTokenPrice, formatPct, cn, timeAgo } from "@/lib/utils";
import { TokenAvatar, tokenCardBackground } from "@/components/shared/TokenAvatar";
import { ShareModal } from "@/components/shared/ShareModal";
import { Search, ArrowRightLeft, Share2, Copy, Globe, Clock, Loader2, Users, ExternalLink, TrendingUp, CandlestickChart, Activity, FunctionSquare, Rocket, ShieldCheck, Zap, CheckCircle2, UploadCloud, Wallet, Eye, AlertCircle, Send, ChevronDown, ChevronUp } from "lucide-react";
import { ReconnectingChip } from "@/components/shared/ReconnectingChip";
const XIcon = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} style={style} aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.91-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>
);
import { SwapSettingsPopover } from "@/components/shared/SwapSettingsPopover";
import { useSwapSettings, formatSlippage, formatPriorityFee, getSwapSettings } from "@/stores/swapSettings";
import { useTxToast } from "@/hooks/useTxToast";
import { buildPumpFunBuyTx, buildPumpFunSellTx, waitForTxConfirmation } from "@/lib/pumpfun-swap";
import { buildLaunchLabBuyTx, buildLaunchLabSellTx } from "@/lib/launchlabSwap";
import {
  uploadToPumpFunIpfs,
  buildPumpFunCreateTx,
  buildPumpFunBuyTxViaPortal,
  buildPumpFunSellTxViaPortal,
} from "@/lib/pumpfunLauncher";
import {
  uploadToRaydiumIpfs,
  buildRaydiumLaunchTx,
  isRaydiumSdkCached,
  preloadRaydiumSdk,
  RAYDIUM_LAUNCH_COST_SOL,
} from "@/lib/raydiumLauncher";
import {
  getJupiterQuote, buildJupiterSwapTx, waitForJupiterTxConfirmation,
  WSOL_MINT, getRouteLabel, formatJupiterOutput,
  type JupiterQuoteResponse,
} from "@/lib/jupiter-swap";
import {
  getExternalToken, setExternalToken, ensureJupiterList, getJupiterTokenByAddress,
  type ExternalSolanaToken,
} from "@/lib/external-tokens";
import { computeSellPresetAmount } from "@/lib/tradePresets";
import { getConnection } from "@/lib/solanaConnection";
import { addFeeToVersionedTx, addFeeToLegacyTx } from "@/lib/platform-fee";
import { SEO } from "@/components/seo/SEO";
import { PlatformBadge, getPlatformUrl, type PlatformId } from "@/components/shared/PlatformBadge";
import { formatSol, formatTokenAmount, formatAtomicTokenAmount, atomicToDisplayTokens, computeHoldingRow } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useSolPrice } from "@/hooks/useSolPrice";
import { copyToClipboard as fireClipboard } from "@/components/shared/CopyToast";
import { useLocation, useSearch } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";


interface AppInterfaceProps {
  /** When rendered under /coin/:address, pass the address from route params.
   *  Falls back to the legacy ?token= query param for backward compatibility. */
  tokenAddress?: string;
}

export default function AppInterface({ tokenAddress: routeAddress }: AppInterfaceProps = {}) {
  const [, setLocation] = useLocation();
  // Use reactive wouter search so query-string changes (e.g. ?tab=portfolio) always trigger re-render
  const search = useSearch();
  const _params  = new URLSearchParams(search);
  // Route param (/coin/:address) takes priority; legacy ?token= is handled by AppRoute redirect
  const tokenParam = routeAddress ?? _params.get("token");
  const tabParam   = _params.get("tab"); // "portfolio" makes My Tokens deep-linkable

  const { wallet } = useWallet();
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(tokenParam);

  // Sync selectedTokenId to URL; scroll to top whenever a token is opened
  useEffect(() => {
    if (tokenParam) {
      setSelectedTokenId(tokenParam);
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
    }
  }, [tokenParam, tabParam]);

  const selectToken = (address: string) => {
    setSelectedTokenId(address);
    setLocation(`/coin/${address}`);
  };

  return (
    <div className="flex flex-col">
      {selectedTokenId ? (
        // ── Token trade view — full-bleed ──
        <div className="flex-1 min-h-0 overflow-x-auto">
          <TradeTab wallet={wallet} selectedAddress={selectedTokenId} onSelectToken={selectToken} />
        </div>
      ) : tabParam === "portfolio" ? (
        // ── My Coins ──
        <div className="max-w-[1200px] mx-auto px-3 md:px-6 py-3 md:py-5 min-w-[340px]">
          <PortfolioTab wallet={wallet} onSelectToken={selectToken} />
        </div>
      ) : (
        // ── Launch (default) ──
        <div className="max-w-[1200px] mx-auto px-3 md:px-6 py-3 md:py-5 min-w-[340px]">
          <LaunchTab wallet={wallet} onLaunch={(address) => selectToken(address)} />
        </div>
      )}
    </div>
  );
}

// --- TAB COMPONENTS ---

type LaunchStep = "idle" | "uploading" | "building" | "signing" | "confirming" | "done" | "error";


type LaunchPlatform = "pumpfun" | "raydium";

function LaunchTab({ wallet, onLaunch }: { wallet: string | null, onLaunch: (addr: string) => void }) {
  const [name,         setName]         = useState("");
  const [symbol,       setSymbol]       = useState("");
  const [desc,         setDesc]         = useState("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageFile,    setImageFile]    = useState<File | null>(null);
  const imageInputRef    = useRef<HTMLInputElement>(null);
  const imagePreviewUrl  = useRef<string | null>(null); // tracks blob URL for cleanup
  // Tracks the post-launch redirect timer so it can be cancelled on unmount.
  const launchTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
    if (imagePreviewUrl.current) URL.revokeObjectURL(imagePreviewUrl.current);
  }, []);

  // Platform selector
  const [platform, setPlatform] = useState<LaunchPlatform>("pumpfun");

  // Social links (optional)
  const [twitter,  setTwitter]  = useState("");
  const [telegram, setTelegram] = useState("");
  const [website,  setWebsite]  = useState("");
  const [showLinks, setShowLinks] = useState(false);

  // Raydium LaunchLab: initial buy amount in SOL (required by SDK, must be > 0)
  const [initialBuySOL, setInitialBuySOL] = useState("0.1");

  // Launch flow state
  const [launchStep,      setLaunchStep]      = useState<LaunchStep>("idle");
  const [launchError,     setLaunchError]     = useState<string | null>(null);
  const [mintAddress,     setMintAddress]     = useState<string | null>(null);
  // Sub-label shown under the "building" step while the Raydium SDK is downloading
  const [buildingSubLabel, setBuildingSubLabel] = useState<string | null>(null);
  // Progress detail shown under the "confirming" step — updated live by waitForTxConfirmation
  const [confirmingDetail, setConfirmingDetail] = useState<string | null>(null);
  // Snapshot of launch metadata shown in the success card (captured at launch time)
  const [launchInfo, setLaunchInfo] = useState<{
    name: string; symbol: string; imagePreview: string | null; imageUrl: string | null; mint: string;
  } | null>(null);
  // True once our indexer has picked up the newly-launched token
  const [indexReady, setIndexReady] = useState(false);

  const { toast } = useToast();
  const { openWalletModal, signAndSendTransaction } = useWallet();

  // ── Image handler ────────────────────────────────────────────────────────────

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid file", description: "Please upload an image file.", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Image must be under 5 MB.", variant: "destructive" });
      return;
    }
    if (imagePreviewUrl.current) URL.revokeObjectURL(imagePreviewUrl.current);
    const url = URL.createObjectURL(file);
    imagePreviewUrl.current = url;
    setImageFile(file);
    setImagePreview(url);
  };

  // ── Platform-specific launch ──────────────────────────────────────────────────

  const handleLaunch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!wallet) { openWalletModal(); return; }

    if (!name.trim() || !symbol.trim()) {
      toast({ title: "Required fields missing", description: "Name and ticker cannot be empty.", variant: "destructive" });
      return;
    }
    if (symbol.trim().length > 10) {
      toast({ title: "Ticker too long", description: "Ticker must be 10 characters or fewer.", variant: "destructive" });
      return;
    }
    if (!imageFile) {
      toast({ title: "Gambar diperlukan", description: "Token memerlukan gambar untuk tampilan di platform.", variant: "destructive" });
      return;
    }

    setLaunchError(null);
    setMintAddress(null);

    if (platform === "pumpfun") {
      await _launchPumpFun();
    } else {
      // Validate initial buy amount before kicking off the flow
      const parsedBuy = parseFloat(initialBuySOL);
      if (isNaN(parsedBuy) || parsedBuy < 0.001) {
        toast({ title: "Initial buy too low", description: "Minimum initial buy is 0.001 SOL (required by Raydium).", variant: "destructive" });
        return;
      }
      await _launchRaydium();
    }
  };

  // ── pump.fun flow ─────────────────────────────────────────────────────────────

  const _launchPumpFun = async () => {
    if (!wallet || !imageFile) return;
    try {
      // Step 1: Upload metadata + image ke pump.fun IPFS
      setLaunchStep("uploading");
      const { metadataUri, imageUrl: uploadedImageUrl } = await uploadToPumpFunIpfs({
        name:        name.trim(),
        symbol:      symbol.trim().toUpperCase(),
        description: desc.trim(),
        twitter:     twitter.trim() || undefined,
        telegram:    telegram.trim() || undefined,
        website:     website.trim() || undefined,
        image:       imageFile,
      });

      // Step 2+3: Build tx → sign. Retry up to 3x if blockhash expires before user signs.
      // IMPORTANT: We track the last signature separately so that if confirmation
      // times out / blockhash expires AFTER the wallet broadcast, we can check
      // getSignatureStatus before deciding to build a new coin (new mint).
      // Creating a new mint when the previous tx already confirmed = duplicate coin.
      const MAX_TX_ATTEMPTS = 3;
      let lastErr: unknown;
      for (let attempt = 0; attempt < MAX_TX_ATTEMPTS; attempt++) {
        setLaunchStep("building");
        const { transaction, mintAddress: newMint, blockhash, lastValidBlockHeight } =
          await buildPumpFunCreateTx(wallet, name.trim(), symbol.trim().toUpperCase(), metadataUri);

        let sig: string | null = null;
        try {
          setLaunchStep("signing");
          sig = await signAndSendTransaction(transaction);
          // tx was broadcast — now wait for confirmation
        } catch (signErr: unknown) {
          // Error came from the wallet before broadcasting (user rejected, or
          // blockhash expired in preflight). Safe to retry with a new transaction.
          const raw = signErr instanceof Error ? signErr.message : String(signErr);
          if (/block height exceeded|expired|Blockhash not found/i.test(raw) && attempt < MAX_TX_ATTEMPTS - 1) {
            lastErr = signErr;
            continue;
          }
          throw signErr;
        }

        try {
          // Step 4: Wait for on-chain confirmation
          setLaunchStep("confirming");
          setConfirmingDetail(null);
          await waitForTxConfirmation(sig, blockhash, lastValidBlockHeight, setConfirmingDetail);

          setLaunchStep("done");
          setMintAddress(newMint);
          setLaunchInfo({ name: name.trim(), symbol: symbol.trim().toUpperCase(), imagePreview, imageUrl: uploadedImageUrl, mint: newMint });
          setIndexReady(false);
          setExternalToken({ address: newMint, name: name.trim(), symbol: symbol.trim().toUpperCase(), logoURI: uploadedImageUrl ?? imagePreview, decimals: 6 });
          void _registerAndNavigate(newMint, sig!, metadataUri, uploadedImageUrl, "pump_fun");
          return; // success — card shows briefly; _registerAndNavigate navigates once DB insert confirms
        } catch (confirmErr: unknown) {
          // Confirmation failed — but the tx may have already landed on-chain.
          // Check the signature BEFORE building a new mint to avoid duplicates.
          try {
            const { value: status } = await getConnection().getSignatureStatus(sig, {
              searchTransactionHistory: true,
            });
            if (status && !status.err &&
                (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
              // The coin WAS created — treat as success.
              setLaunchStep("done");
              setMintAddress(newMint);
              setLaunchInfo({ name: name.trim(), symbol: symbol.trim().toUpperCase(), imagePreview, imageUrl: uploadedImageUrl, mint: newMint });
              setIndexReady(false);
              setExternalToken({ address: newMint, name: name.trim(), symbol: symbol.trim().toUpperCase(), logoURI: uploadedImageUrl ?? imagePreview, decimals: 6 });
              void _registerAndNavigate(newMint, sig!, metadataUri, uploadedImageUrl, "pump_fun");
              return;
            }
          } catch {
            // getSignatureStatus network error — proceed to decide on retry
          }

          const raw = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
          if (/block height exceeded|expired|Blockhash not found|timeout/i.test(raw) && attempt < MAX_TX_ATTEMPTS - 1) {
            // Tx truly expired (not confirmed) — safe to retry with a new mint
            lastErr = confirmErr;
            continue;
          }
          throw confirmErr;
        }
      }
      throw lastErr;

    } catch (err: unknown) {
      setLaunchStep("error");
      const raw = err instanceof Error ? err.message : String(err);
      if (/rejected|cancel|user denied/i.test(raw)) {
        setLaunchError("Transaction cancelled. Click Launch again to retry.");
      } else if (/ipfs|upload|fetch/i.test(raw)) {
        setLaunchError(`Metadata upload failed: ${raw}. Check your internet connection and try again.`);
      } else if (/timeout|not confirmed|Blockhash/i.test(raw)) {
        setLaunchError("Confirmation timeout. The transaction may have already succeeded — check your wallet before retrying.");
      } else {
        setLaunchError(raw);
      }
    }
  };

  // ── Raydium LaunchLab flow ────────────────────────────────────────────────────

  const _launchRaydium = async () => {
    if (!wallet || !imageFile) return;
    try {
      // Step 1: Upload metadata via Raydium IPFS (fallback: pump.fun IPFS)
      setLaunchStep("uploading");
      const { metadataUri, imageUrl: uploadedImageUrl } = await uploadToRaydiumIpfs({
        name:        name.trim(),
        symbol:      symbol.trim().toUpperCase(),
        description: desc.trim(),
        twitter:     twitter.trim() || undefined,
        telegram:    telegram.trim() || undefined,
        website:     website.trim() || undefined,
        image:       imageFile,
      });

      // Step 2: Build transactions (SDK loads lazily; returns MultiTxBuildData)
      // The SDK may return 1 or more transactions to send in sequence.
      // Each is already partial-signed by the mint keypair — do not add extra signing.
      setLaunchStep("building");
      // Show SDK-loading sub-label only when the module hasn't been cached yet.
      if (!isRaydiumSdkCached()) {
        setBuildingSubLabel("Preparing launch environment…");
      }
      // Convert user-entered SOL to lamports (BigInt, as expected by BN inside SDK wrapper)
      const buyLamports = BigInt(Math.round(parseFloat(initialBuySOL) * 1e9));

      const { transactions, mintAddress: newMint, blockhash, lastValidBlockHeight } =
        await buildRaydiumLaunchTx(
          wallet,
          name.trim(),
          symbol.trim().toUpperCase(),
          metadataUri,
          buyLamports,
          () => setBuildingSubLabel(null), // clear once SDK import resolves
        );

      // Step 3: User wallet signs and broadcasts each transaction in sequence.
      // Raydium may split the create flow into 2+ txs (e.g. create mint + init pool).
      setLaunchStep("signing");
      let lastSig = "";

      for (let i = 0; i < transactions.length; i++) {
        if (i > 0) {
          // Wait for prior tx to confirm before the next wallet approval
          setLaunchStep("confirming");
          setConfirmingDetail(null);
          await waitForTxConfirmation(lastSig, blockhash, lastValidBlockHeight, setConfirmingDetail);
          setLaunchStep("signing");
        }
        // Wallet adds its signature and broadcasts
        lastSig = await signAndSendTransaction(transactions[i]);
      }

      // Step 4: Wait for final transaction confirmation
      setLaunchStep("confirming");
      setConfirmingDetail(null);
      await waitForTxConfirmation(lastSig, blockhash, lastValidBlockHeight, setConfirmingDetail);

      setLaunchStep("done");
      setMintAddress(newMint);
      setLaunchInfo({ name: name.trim(), symbol: symbol.trim().toUpperCase(), imagePreview, imageUrl: uploadedImageUrl, mint: newMint });
      setIndexReady(false);
      setExternalToken({ address: newMint, name: name.trim(), symbol: symbol.trim().toUpperCase(), logoURI: uploadedImageUrl ?? imagePreview, decimals: 6 });
      void _registerAndNavigate(newMint, lastSig, metadataUri, uploadedImageUrl, "raydium_launchlab");

    } catch (err: unknown) {
      setLaunchStep("error");
      const raw = err instanceof Error ? err.message : String(err);
      if (/rejected|cancel|user denied/i.test(raw)) {
        setLaunchError("Transaction cancelled. Click Launch again to retry.");
      } else if (/upload|ipfs|fetch/i.test(raw)) {
        setLaunchError(`Metadata upload failed: ${raw}. Check your internet connection and try again.`);
      } else if (/timeout|not confirmed|Blockhash/i.test(raw)) {
        setLaunchError("Confirmation timeout. The transaction may have already succeeded — check your wallet before retrying.");
      } else if (/SDK tidak|config|launchpad/i.test(raw)) {
        setLaunchError(`Failed to connect to Raydium LaunchLab: ${raw}. Try again in a few seconds.`);
      } else {
        setLaunchError(raw);
      }
    }
  };

  const resetToIdle = () => {
    setLaunchStep("idle");
    setLaunchError(null);
    setBuildingSubLabel(null);
    setConfirmingDetail(null);
    setLaunchInfo(null);
    setIndexReady(false);
  };

  // ── Instant registration ─────────────────────────────────────────────────────
  // After the tx confirms, POST to /api/tokens/register-launch so the DB record
  // exists right away. On success, navigate to /coin/:address immediately.
  // On any failure the success card + background polling serve as the fallback.
  const _registerAndNavigate = async (
    mint: string,
    txSignature: string,
    metadataUri: string | null,
    imageUrl: string | null,
    launchPlatform: "pump_fun" | "raydium_launchlab" = "pump_fun",
  ) => {
    try {
      const r = await fetch("/api/tokens/register-launch", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          mint,
          txSignature,
          platform:       launchPlatform,
          name:           name.trim(),
          symbol:         symbol.trim().toUpperCase(),
          description:    desc.trim()     || undefined,
          imageUrl:       imageUrl        || undefined,
          metadataUri:    metadataUri     || undefined,
          twitter:        twitter.trim()  || undefined,
          telegram:       telegram.trim() || undefined,
          website:        website.trim()  || undefined,
          creatorAddress: wallet,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        onLaunch(mint); // token is in DB — full bonding-curve UI shows immediately
        return;
      }
      // 422 = not yet confirmed at RPC (should be rare) → fall through to polling
    } catch { /* network error → fall through to polling */ }
  };

  // Poll our API every 3 s until the newly-launched token appears in our DB.
  // Once indexed, reveal the "View on Pumpi →" button and stop polling.
  useEffect(() => {
    if (launchStep !== "done" || !mintAddress || indexReady) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/tokens/${mintAddress}`, { signal: AbortSignal.timeout(5_000) });
        if (res.ok && !cancelled) { setIndexReady(true); return; }
      } catch { /* network hiccup — keep polling */ }
      if (!cancelled) setTimeout(poll, 3_000);
    };
    // Small initial delay so the tx has time to propagate before first check
    const t = setTimeout(poll, 4_000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [launchStep, mintAddress, indexReady]);

  const isLaunching = launchStep !== "idle" && launchStep !== "done" && launchStep !== "error";

  return (
    <div className="flex flex-col lg:flex-row gap-6 lg:gap-10 max-w-[960px] mx-auto">

      {/* ── LEFT: Form ── */}
      <div className="flex-1 min-w-0 space-y-5">

        {/* Hero header */}
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)" }}>
            <Rocket className="h-4 w-4" style={{ color: "#e0e0e0" }} />
          </div>
          <h2 className="text-[20px] font-bold text-foreground tracking-tight">Create a Coin</h2>
        </div>

        {/* ── Platform selector ── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <span className="text-[14px] font-semibold text-white/80 shrink-0">Launch on:</span>
          <div className="p-1 rounded-xl flex gap-1 flex-1"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
            {/* Pump.fun */}
            <button
              type="button"
              disabled={isLaunching}
              onClick={() => setPlatform("pumpfun")}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg transition-all duration-150 whitespace-nowrap"
              style={platform === "pumpfun"
                ? { background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.20)", cursor: "default" }
                : { background: "transparent", border: "1px solid transparent", cursor: "pointer" }}
            >
              <img src="/pumpfun.png" alt="pump.fun" className="w-5 h-5 rounded-full object-cover shrink-0"
                style={{ opacity: platform === "pumpfun" ? 1 : 0.4 }} />
              <span className="text-[13px] font-semibold"
                style={{ color: platform === "pumpfun" ? "#f2f2f2" : "#b3b3b3" }}>Pump.fun</span>
            </button>
            {/* Raydium LaunchLab */}
            <button
              type="button"
              disabled={isLaunching}
              onClick={() => { setPlatform("raydium"); preloadRaydiumSdk(); }}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg transition-all duration-150 whitespace-nowrap"
              style={platform === "raydium"
                ? { background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.20)", cursor: "default" }
                : { background: "transparent", border: "1px solid transparent", cursor: "pointer" }}
            >
              <img src="/raydium-launchlab.png" alt="Raydium LaunchLab" className="w-6 h-6 rounded-md object-contain shrink-0"
                style={{ opacity: platform === "raydium" ? 1 : 0.4 }} />
              <span className="text-[13px] font-semibold"
                style={{ color: platform === "raydium" ? "#f2f2f2" : "#b3b3b3" }}>Raydium LaunchLab</span>
            </button>
          </div>
        </div>

        {/* Form card */}
        <form onSubmit={handleLaunch} className="space-y-0 rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.015)" }}>

          {/* ── Step 1: Identity ── */}
          <div className="px-5 pt-5 pb-5">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                style={{ background: "rgba(255,255,255,0.08)", color: "#bbbbbb", border: "1px solid rgba(255,255,255,0.18)" }}>1</span>
              <span className="text-[13px] font-semibold text-foreground">Coin Identity</span>
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
                  disabled={isLaunching}
                  className="h-10 rounded-lg bg-background/40 border-white/25 focus-visible:ring-white/20 text-[14px] placeholder:text-slate-600"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-muted-foreground">
                  Ticker <span className="text-destructive">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[14px] font-bold pointer-events-none"
                    style={{ color: "#b3b3b3" }}>$</span>
                  <Input
                    placeholder="DOGE"
                    value={symbol}
                    onChange={e => setSymbol(e.target.value.toUpperCase())}
                    disabled={isLaunching}
                    className="h-10 pl-7 rounded-lg bg-background/40 border-white/25 focus-visible:ring-white/20 font-mono uppercase tracking-widest text-[14px] placeholder:text-slate-600"
                    maxLength={10}
                    required
                  />
                </div>
                {symbol && (
                  <p className="text-[11px] tabular-nums" style={{ color: symbol.length >= 9 ? "#f87171" : "#b3b3b3" }}>
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
                style={{ background: "rgba(255,255,255,0.08)", color: "#bbbbbb", border: "1px solid rgba(255,255,255,0.18)" }}>2</span>
              <span className="text-[13px] font-semibold text-foreground">Coin Logo</span>
              <span className="ml-auto text-[11px]" style={{ color: "#b3b3b3" }}>PNG · JPG · GIF · Max 5MB</span>
            </div>
            <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageChange} />
            <div
              onClick={() => !isLaunching && imageInputRef.current?.click()}
              className={cn("rounded-xl transition-all duration-200 group", isLaunching ? "cursor-not-allowed opacity-60" : "cursor-pointer")}
              style={{
                border: imagePreview
                  ? "1px solid rgba(255,255,255,0.28)"
                  : "2px dashed rgba(255,255,255,0.25)",
                background: imagePreview ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.015)",
              }}
            >
              {imagePreview ? (
                <div className="flex items-center gap-4 p-3">
                  <img src={imagePreview} alt="Token" className="h-16 w-16 rounded-xl object-cover shrink-0"
                    style={{ border: "1px solid rgba(255,255,255,0.10)" }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-semibold text-foreground">Image ready</p>
                    <p className="text-[12px]" style={{ color: "#b3b3b3" }}>Click to change</p>
                  </div>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.20)" }}>
                    <CheckCircle2 className="h-4 w-4" style={{ color: "#e0e0e0" }} />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 gap-2">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-1 transition-colors group-hover:border-white/15"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <UploadCloud className="h-5 w-5" style={{ color: "#b3b3b3" }} />
                  </div>
                  <p className="text-[13px] font-medium" style={{ color: "#555555" }}>
                    Drop image here or <span style={{ color: "#e0e0e0" }}>browse</span>
                  </p>
                </div>
              )}
            </div>
          </div>

          <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

          {/* ── Step 3: Description ── */}
          <div className="px-5 pt-5 pb-5">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                style={{ background: "rgba(255,255,255,0.08)", color: "#bbbbbb", border: "1px solid rgba(255,255,255,0.18)" }}>3</span>
              <span className="text-[13px] font-semibold text-foreground">Description</span>
              <span className="ml-auto text-[11px] tabular-nums" style={{ color: desc.length >= 270 ? "#f87171" : "#b3b3b3" }}>
                {desc.length}/300
              </span>
            </div>
            <Textarea
              placeholder="Write a short description about your coin..."
              value={desc}
              onChange={e => setDesc(e.target.value.slice(0, 300))}
              disabled={isLaunching}
              className="rounded-lg bg-background/40 border-white/25 focus-visible:ring-white/20 min-h-[90px] resize-none text-[14px] placeholder:text-slate-600"
            />
          </div>

          <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />

          {/* ── Step 4: Social links (optional, collapsible) ── */}
          <div className="px-5 pt-4 pb-4">
            <button
              type="button"
              onClick={() => setShowLinks(v => !v)}
              className="flex items-center gap-2 w-full text-left"
            >
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                style={{ background: "rgba(255,255,255,0.08)", color: "#bbbbbb", border: "1px solid rgba(255,255,255,0.18)" }}>4</span>
              <span className="text-[13px] font-semibold text-foreground">Social Links</span>
              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)", color: "#b3b3b3" }}>
                Optional
              </span>
              <span className="ml-auto" style={{ color: "#b3b3b3" }}>
                {showLinks ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
            </button>
            {showLinks && (
              <div className="mt-4 space-y-3">
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium text-muted-foreground flex items-center gap-1.5">
                    <XIcon className="h-3 w-3" /> X (Twitter)
                  </label>
                  <Input
                    placeholder="https://twitter.com/yourtoken"
                    value={twitter}
                    onChange={e => setTwitter(e.target.value)}
                    disabled={isLaunching}
                    className="h-9 rounded-lg bg-background/40 border-white/25 focus-visible:ring-white/20 text-[13px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium text-muted-foreground flex items-center gap-1.5">
                    <Send className="h-3 w-3" /> Telegram
                  </label>
                  <Input
                    placeholder="https://t.me/yourtoken"
                    value={telegram}
                    onChange={e => setTelegram(e.target.value)}
                    disabled={isLaunching}
                    className="h-9 rounded-lg bg-background/40 border-white/25 focus-visible:ring-white/20 text-[13px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium text-muted-foreground flex items-center gap-1.5">
                    <Globe className="h-3 w-3" /> Website
                  </label>
                  <Input
                    placeholder="https://yourtoken.xyz"
                    value={website}
                    onChange={e => setWebsite(e.target.value)}
                    disabled={isLaunching}
                    className="h-9 rounded-lg bg-background/40 border-white/25 focus-visible:ring-white/20 text-[13px]"
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── Step 5: Initial Buy (Raydium only, required by SDK) ── */}
          {platform === "raydium" && (
            <>
              <div style={{ height: 1, background: "rgba(255,255,255,0.06)" }} />
              <div className="px-5 pt-4 pb-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                    style={{ background: "rgba(59,130,246,0.15)", color: "#93c5fd", border: "1px solid rgba(59,130,246,0.30)" }}>5</span>
                  <span className="text-[13px] font-semibold text-foreground">Initial Buy</span>
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(59,130,246,0.10)", color: "#60a5fa" }}>
                    Required by Raydium
                  </span>
                </div>
                <p className="text-[12px] mb-3" style={{ color: "#b3b3b3" }}>
                  Raydium LaunchLab requires buying a minimum amount of tokens at launch. This goes directly to your wallet.
                </p>
                <div className="relative">
                  <Input
                    type="number"
                    min="0.001"
                    step="0.01"
                    placeholder="0.1"
                    value={initialBuySOL}
                    onChange={e => setInitialBuySOL(e.target.value)}
                    disabled={isLaunching}
                    className="h-9 rounded-lg bg-background/40 border-white/25 focus-visible:ring-white/20 text-[13px] pr-12"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-medium pointer-events-none"
                    style={{ color: "#b3b3b3" }}>SOL</span>
                </div>
                <div className="flex gap-1.5 mt-2">
                  {["0.05", "0.1", "0.5", "1"].map(v => (
                    <button key={v} type="button"
                      onClick={() => setInitialBuySOL(v)}
                      disabled={isLaunching}
                      className="text-[11px] px-2 py-1 rounded-md transition-colors"
                      style={{
                        background: initialBuySOL === v ? "rgba(59,130,246,0.20)" : "rgba(255,255,255,0.05)",
                        color: initialBuySOL === v ? "#93c5fd" : "#b3b3b3",
                        border: `1px solid ${initialBuySOL === v ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.08)"}`,
                      }}>
                      {v} SOL
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── Submit / Progress / Done ── */}
          <div className="px-5 pt-5 pb-5 space-y-4">


            {/* Launch progress — simple two-state indicator */}
            {isLaunching && (
              <div className="flex items-center gap-3 py-2">
                {launchStep === "signing" ? (
                  <>
                    <Wallet className="w-4 h-4 shrink-0" style={{ color: "#93c5fd" }} />
                    <span className="text-[13px] font-semibold" style={{ color: "#93c5fd" }}>
                      Approve in your wallet…
                    </span>
                  </>
                ) : (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "#b3b3b3" }} />
                    <span className="text-[13px] font-semibold" style={{ color: "#b3b3b3" }}>
                      {launchStep === "confirming"
                        ? (confirmingDetail ?? "Confirming on-chain…")
                        : "Building…"}
                    </span>
                  </>
                )}
              </div>
            )}

            {/* Success state — rich card shown while indexing happens in background */}
            {launchStep === "done" && mintAddress && launchInfo && (
              <div className="rounded-xl p-4 space-y-3"
                style={{ background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.22)" }}>
                {/* Token identity row */}
                <div className="flex items-center gap-3">
                  {launchInfo.imagePreview ? (
                    <img src={launchInfo.imagePreview} alt="Token"
                      className="w-12 h-12 rounded-xl object-cover shrink-0"
                      style={{ border: "1px solid rgba(255,255,255,0.12)" }} />
                  ) : (
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                      style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)" }}>
                      <span className="text-[18px] font-bold" style={{ color: "#4ade80" }}>
                        {launchInfo.symbol.charAt(0)}
                      </span>
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: "#4ade80" }} />
                      <span className="text-[13px] font-bold" style={{ color: "#4ade80" }}>Coin launched! 🚀</span>
                    </div>
                    <div className="text-[14px] font-semibold truncate" style={{ color: "#e0e0e0" }}>
                      {launchInfo.name}{" "}
                      <span className="text-[12px] font-normal" style={{ color: "#888" }}>${launchInfo.symbol}</span>
                    </div>
                  </div>
                </div>

                {/* Mint address */}
                <div className="font-mono text-[10px] px-2 py-1.5 rounded-lg break-all"
                  style={{ background: "rgba(0,0,0,0.3)", color: "#666" }}>
                  {mintAddress}
                </div>

                {/* External links */}
                <div className="flex gap-2 flex-wrap">
                  <a href={`https://${platform === "raydium" ? "raydium.io/launchpad" : "pump.fun/coin"}/${mintAddress}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.06)", color: "#b3b3b3", border: "1px solid rgba(255,255,255,0.10)" }}>
                    {platform === "raydium" ? "Raydium ↗" : "Pump.fun ↗"}
                  </a>
                  <a href={`https://solscan.io/token/${mintAddress}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-opacity hover:opacity-80"
                    style={{ background: "rgba(255,255,255,0.06)", color: "#b3b3b3", border: "1px solid rgba(255,255,255,0.10)" }}>
                    Solscan ↗
                  </a>
                </div>

                {/* Indexing status / View on Pumpi button */}
                {indexReady ? (
                  <button
                    type="button"
                    onClick={() => onLaunch(mintAddress)}
                    className="w-full h-10 rounded-xl text-[13px] font-bold flex items-center justify-center gap-2 transition-all duration-150 active:scale-[0.98]"
                    style={{ background: "linear-gradient(135deg, #22c55e, #16a34a)", color: "#fff", border: "none" }}>
                    View on Pumpi →
                  </button>
                ) : (
                  <div className="flex items-center gap-2 py-0.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" style={{ color: "#4ade80" }} />
                    <span className="text-[11px]" style={{ color: "#888" }}>
                      Indexing on Pumpi… the page will be ready in a few seconds
                    </span>
                  </div>
                )}

                {/* Launch another coin */}
                <button
                  type="button"
                  onClick={resetToIdle}
                  className="text-[11px] font-medium transition-opacity hover:opacity-80"
                  style={{ color: "#555", background: "none", border: "none", padding: 0, cursor: "pointer" }}>
                  + Launch another coin
                </button>
              </div>
            )}

            {/* Error state */}
            {launchStep === "error" && launchError && (
              <div className="rounded-xl p-4 space-y-3"
                style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)" }}>
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" style={{ color: "#f87171" }} />
                  <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: "#fca5a5" }}>
                    {launchError}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={resetToIdle}
                  className="text-[12px] font-semibold px-4 py-2 rounded-lg transition-colors"
                  style={{ background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.30)" }}
                >
                  Try Again
                </button>
              </div>
            )}

            {/* Launch button (only when idle or error) */}
            {(launchStep === "idle" || launchStep === "error") && (
              <button
                type="submit"
                disabled={launchStep === "error"}
                className="w-full h-12 rounded-xl text-[15px] font-bold flex items-center justify-center gap-2 transition-all duration-150 active:scale-[0.98]"
                style={{
                  background: launchStep === "error"
                    ? "rgba(255,255,255,0.04)"
                    : !wallet
                    ? "hsl(var(--primary))"
                    : platform === "raydium"
                    ? "linear-gradient(135deg, #3b82f6, #2563eb)"
                    : "hsl(var(--primary))",
                  color: launchStep === "error" ? "#555555" : "hsl(var(--primary-foreground))",
                  border: "none",
                  boxShadow: launchStep === "error" ? "none" : !wallet ? "0 0 20px rgba(255,255,255,0.08)" : platform === "raydium" ? "0 0 20px rgba(59,130,246,0.20)" : "0 0 20px rgba(255,255,255,0.08)",
                  cursor: launchStep === "error" ? "not-allowed" : "pointer",
                }}
              >
                {!wallet ? (
                  <><Wallet className="w-4 h-4" /> Connect Wallet to Launch</>
                ) : platform === "raydium" ? (
                  <><Rocket className="w-4 h-4" /> Launch on Raydium LaunchLab</>
                ) : (
                  <><Rocket className="w-4 h-4" /> Launch on Pump.fun</>
                )}
              </button>
            )}
          </div>
        </form>
      </div>

      {/* ── RIGHT: Live Preview ── */}
      <div className="w-full lg:w-[290px] shrink-0">
        <div className="sticky top-4 space-y-4 mt-[52px]">

          {/* Header */}
          <div className="flex items-center gap-2 mb-1">
            <Eye className="h-3.5 w-3.5 shrink-0" style={{ color: "#555555" }} />
            <span className="text-[12px] font-medium" style={{ color: "#b3b3b3" }}>Live Preview</span>
            <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
          </div>

          {/* Token card preview */}
          <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.05)" }}>

            {/* Card header */}
            <div className="px-4 pt-4 pb-3 flex items-center gap-3">
              {imagePreview ? (
                <img src={imagePreview} alt="Token" className="w-11 h-11 rounded-xl object-cover shrink-0"
                  style={{ border: "1px solid rgba(255,255,255,0.15)" }} />
              ) : (
                <TokenAvatar symbol={symbol || "?"} size={44} shape="square" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate text-[14px] leading-tight">
                  {name
                    ? <span className="text-foreground">{name}</span>
                    : <span style={{ color: "#b3b3b3" }}>Coin Name</span>}
                </div>
                <div className="text-[11px] font-mono mt-0.5 truncate">
                  {symbol
                    ? <span style={{ color: "#b3b3b3" }}>${symbol.toUpperCase()}</span>
                    : <span style={{ color: "#b3b3b3" }}>$TICKER</span>}
                </div>
              </div>
            </div>

            <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "0 16px" }} />

            {/* Card body */}
            <div className="px-4 pt-3 pb-4 space-y-3">
              <p className="text-[12px] leading-relaxed line-clamp-3">
                {desc
                  ? <span style={{ color: "#bbbbbb" }}>{desc}</span>
                  : <span style={{ color: "#b3b3b3" }}>Your description will appear here. Tell the community what makes this coin unique.</span>}
              </p>

              {/* Mock stats */}
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { label: "Price",   value: "$0.000028" },
                  { label: "Mkt Cap", value: "$28K" },
                  { label: "Holders", value: "1" },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-lg px-2 py-2 text-center"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.10)" }}>
                    <div className="text-[9px] mb-1 font-medium" style={{ color: "#b3b3b3" }}>{label}</div>
                    <div className="text-[11px] font-mono font-semibold text-foreground">{value}</div>
                  </div>
                ))}
              </div>

              {/* Social links preview */}
              {(twitter || telegram || website) && (
                <div className="flex items-center gap-3 pt-1" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  {twitter  && <XIcon className="h-3 w-3"  style={{ color: "#b3b3b3" }} />}
                  {telegram && <Send    className="h-3 w-3"  style={{ color: "#b3b3b3" }} />}
                  {website  && <Globe   className="h-3 w-3"  style={{ color: "#b3b3b3" }} />}
                </div>
              )}

              {wallet && (
                <div className="text-[10px] font-mono flex items-center gap-1" style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10 }}>
                  <span style={{ color: "#b3b3b3" }}>by</span>
                  <span style={{ color: "#b3b3b3" }}>{formatAddress(wallet)}</span>
                </div>
              )}
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
      queryKey: ["getToken", selectedAddress],
      // Retry generously (2 s apart) so newly-launched tokens not yet indexed
      // are found automatically without a manual page refresh.
      retry: 5,
      retryDelay: 2000,
    },
  });

  // Derived early so useMemo below (ChartSection) can use it safely.
  // true = switching between two already-loaded tokens (stale data still visible).
  const isSwitching = loadingToken && !!token;
  
  const { data: history, refetch: refetchHistory, isLoading: loadingHistory, isError: historyError } = useTradeHistory(selectedAddress || "", {
    query: {
      enabled: !!selectedAddress,
      queryKey: ["tradeHistory", selectedAddress],
      // Poll every 5 s as a fallback for when the SSE connection is silently
      // dead. Responses are 304-cached at the server when no new trades arrive,
      // so this is cheap for quiet tokens and keeps the table live when SSE fails.
      refetchInterval: 5_000,
      staleTime: 4_000,
    }
  });

  // ── Top wallets P&L leaderboard ──────────────────────────────────────────────
  const { data: topWalletsData, isLoading: loadingTopWallets, isError: topWalletsError, refetch: refetchTopWallets } = useGetTopWallets(selectedAddress || "", {
    query: {
      enabled: !!selectedAddress,
      queryKey: ["topWallets", selectedAddress],
      refetchInterval: 15_000,
      staleTime: 12_000,
      // Keep showing last good data on 429 / any transient error — same pattern as holders
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      placeholderData: (prev: any) => prev,
    }
  });
  const topWallets = topWalletsData?.wallets ?? [];

  // ── Dev activity — creator wallet trade summary ──────────────────────────────
  const { data: devActivityData, isLoading: loadingDevActivity } = useQuery({
    queryKey: ["devActivity", selectedAddress],
    queryFn: async (): Promise<{
      creatorAddress: string | null;
      totalSolBought: string; totalSolSold: string;
      netBalance: string; totalBought: string;
      buyCount: number; sellCount: number;
      lastSellAt: string | null;
    } | null> => {
      if (!selectedAddress) return null;
      const res = await fetch(`/api/tokens/${selectedAddress}/dev-activity`);
      if (!res.ok) throw new Error(`dev-activity fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: !!selectedAddress,
    refetchInterval: 15_000,
    staleTime: 12_000,
    placeholderData: (prev) => prev,
  });

  // ── Snipers — wallets that bought within 5 min of launch ────────────────────
  const { data: snipersData, isLoading: loadingSnipers } = useQuery({
    queryKey: ["snipers", selectedAddress],
    queryFn: async (): Promise<{
      address: string; firstBuyAt: string; secondsAfterLaunch: number;
      totalSolIn: string; totalBought: string; netBalance: string;
      buyCount: number; sellCount: number;
    }[]> => {
      if (!selectedAddress) return [];
      const res = await fetch(`/api/tokens/${selectedAddress}/snipers`);
      if (!res.ok) throw new Error(`snipers fetch failed: ${res.status}`);
      const json = await res.json();
      return json.snipers ?? [];
    },
    enabled: !!selectedAddress,
    refetchInterval: 30_000,
    staleTime: 25_000,
    placeholderData: (prev) => prev,
  });
  const snipers = snipersData ?? [];

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
    refetchInterval: 8_000,
    staleTime: 6_000,
  });

  // ── Server-side holder list (SQL net balance across ALL trades — no 100-row cap) ────
  // Client-side computation from the 100-row history wildly undercounts high-volume
  // tokens. This endpoint aggregates every trade in the DB for this token.
  const { data: serverHolders, isLoading: loadingHolders, refetch: refetchHolders } = useQuery({
    queryKey: ["holders", selectedAddress],
    queryFn: async (): Promise<{ address: string; balance: string; txCount: number }[]> => {
      if (!selectedAddress) return [];
      const res = await fetch(`/api/tokens/${selectedAddress}/holders`);
      // Throw on error so React Query keeps the previous data instead of
      // clearing it to []. A 429 from heavyLimiter or any server error would
      // previously return [] and make the holder badge vanish.
      if (!res.ok) throw new Error(`holders fetch failed: ${res.status}`);
      const json = await res.json();
      return json.holders ?? [];
    },
    enabled: !!selectedAddress,
    refetchInterval: 15_000,   // 15 s is plenty — holders change slowly
    staleTime: 12_000,
    // Keep showing the last good data during any background refetch or error
    placeholderData: (prev: { address: string; balance: string; txCount: number }[] | undefined) => prev,
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
    refetchInterval: 15_000,
    staleTime: 12_000,
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
    refetchInterval: 12_000,
    staleTime: 10_000,
  });

  const recordTrade = useRecordTrade();
  const updateToken = useUpdateToken();
  const { toast } = useToast();
  const { submitTx } = useTxToast();
  const solPrice = useSolPrice();
  const { solBalance, refresh: refreshSolBalance } = useSolBalance(wallet);
  // SPL token balance for the currently-viewed token — drives sell preset buttons
  const { tokenBalance, atomicBalance, isLoading: balanceLoading, refresh: refreshTokenBalance, refreshAfterTrade } = useTokenBalance(wallet, selectedAddress);

  // After a trade, schedule portfolio query invalidation so My Coins + Profile Wallet
  // stay in sync. We stagger the timing: the on-chain RPC portfolio can refresh after
  // 3s (tx propagation), while DB-derived holdings need ~5-10s for the indexer.
  const queryClient = useQueryClient();
  // Track pending refresh timers so we can cancel them on unmount or before
  // scheduling a new batch — prevents stale-wallet invalidations after token
  // switch or component unmount.
  const refreshTimerIds = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    return () => {
      refreshTimerIds.current.forEach(clearTimeout);
      refreshTimerIds.current = [];
    };
  }, []);

  const schedulePortfolioRefresh = () => {
    // Cancel any previously scheduled timers before adding new ones.
    refreshTimerIds.current.forEach(clearTimeout);
    refreshTimerIds.current = [];
    const push = (fn: () => void, ms: number) => {
      refreshTimerIds.current.push(setTimeout(fn, ms));
    };
    // DB-derived "My Coins" holdings (trades table aggregate)
    push(() => queryClient.invalidateQueries({ queryKey: ["holdings", wallet] }), 5_000);
    push(() => queryClient.invalidateQueries({ queryKey: ["holdings", wallet] }), 10_000);
    // On-chain RPC portfolio (Profile Wallet tab)
    push(() => queryClient.invalidateQueries({ queryKey: ["wallet-portfolio", wallet] }), 3_000);
    // Wallet activity (Profile Activity tab)
    push(() => queryClient.invalidateQueries({ queryKey: ["wallet-activity", wallet] }), 6_000);
  };

  // Live SSE stream — real-time trade events
  const { liveTrades, liveToken, connected } = useTokenStream(selectedAddress);

  // Re-fetch position whenever a genuinely new live trade arrives.
  // We watch liveTrades[0]?.id instead of liveTrades.length because the stream
  // caps at ~200 events — after that, length never changes but the newest
  // trade ID keeps incrementing, so we still detect every arrival.
  //
  // NOTE: holders is intentionally NOT refetched here. For high-volume tokens
  // this effect fires dozens of times per minute and hits the heavyLimiter
  // (30 req/min), causing 429 responses that cleared the holder list.
  // The 15 s refetchInterval on the holders query is sufficient — holder
  // rankings change much more slowly than individual trades.
  const latestLiveTradeId = liveTrades[0]?.id ?? null;
  useEffect(() => {
    if (latestLiveTradeId != null) {
      if (wallet) refetchPosition();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestLiveTradeId]);

  const { openWalletModal, signAndSendTransaction, signVersionedTransaction } = useWallet();
  const [tradeMode, setTradeMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  /** True while a trade is in-flight (signing + broadcast + on-chain confirmation). */
  const [isTradePending, setIsTradePending] = useState(false);
  // ── Jupiter quote state (graduated tokens routed through Jupiter DEX) ─────
  const [jupiterQuote, setJupiterQuote]               = useState<JupiterQuoteResponse | null>(null);
  const [jupiterQuoteLoading, setJupiterQuoteLoading] = useState(false);
  const [jupiterQuoteError, setJupiterQuoteError]     = useState<string | null>(null);
  /** Unix ms timestamp of the most recently cached quote — used to skip the
   *  submit-time re-fetch when the cached quote is still fresh (< 5 s old). */
  const jupiterQuoteTimeRef = useRef<number>(0);

  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [shareOpen, setShareOpen] = useState(false);
  // Bug fix: React state for tx/holders sub-tab instead of imperative DOM manipulation
  const [activeSubTab, setActiveSubTab] = useState<"tx" | "holders" | "wallets" | "positions" | "snipers" | "dev">("tx");
  const [descExpanded, setDescExpanded] = useState(false);
  const [tradeDisplayLimit, setTradeDisplayLimit] = useState(50);

  // Reset per-token UI state whenever the viewed token changes
  useEffect(() => {
    setTradeMode("buy");
    setAmount("");
    setActiveSubTab("tx");
    setDescExpanded(false);
    setTradeDisplayLimit(50);
    // Reset Jupiter quote when switching tokens
    setJupiterQuote(null);
    setJupiterQuoteError(null);
  }, [selectedAddress]);

  // ── Jupiter quote auto-fetch for graduated tokens ─────────────────────────
  // Fetches a preview quote on amount / mode change (debounced 400ms) and then
  // auto-refreshes every 15 s so the displayed estimate stays fresh.
  // Runs for graduated tokens AND pumpswap tokens (always on-DEX, graduated flag may lag).
  useEffect(() => {
    const needsJupiter = token?.graduated || token?.platform === "pumpswap";
    if (!needsJupiter || !amount || parseFloat(amount) <= 0) {
      setJupiterQuote(null);
      setJupiterQuoteError(null);
      setJupiterQuoteLoading(false);
      return;
    }

    const { slippageBps } = getSwapSettings();

    let cancelled = false; // sequence guard: ignore results from superseded requests

    const fetchQuote = async () => {
      setJupiterQuoteLoading(true);
      setJupiterQuoteError(null);
      try {
        const numAmount = parseFloat(amount);
        // isFinite guard: parseFloat("Infinity") passes isNaN but BigInt(Infinity) throws RangeError
        if (!isFinite(numAmount) || isNaN(numAmount) || numAmount <= 0) {
          setJupiterQuoteLoading(false);
          return;
        }

        // Use the token's actual decimal count (default 6 — pump.fun / PumpSwap / LaunchLab all use 6)
        const tokenAtoms = Math.pow(10, token?.decimals ?? 6);
        const amountBaseUnits = tradeMode === "buy"
          ? BigInt(Math.round(numAmount * 1e9))      // SOL → lamports
          : BigInt(Math.round(numAmount * tokenAtoms)); // tokens → atomic units

        const inputMint  = tradeMode === "buy" ? WSOL_MINT : token.address;
        const outputMint = tradeMode === "buy" ? token.address : WSOL_MINT;

        const quote = await getJupiterQuote(inputMint, outputMint, amountBaseUnits, slippageBps);
        // Discard result if the effect was cleaned up (amount/token changed) while in-flight
        if (cancelled) return;
        setJupiterQuote(quote);
        jupiterQuoteTimeRef.current = Date.now();
      } catch (err) {
        if (cancelled) return;
        setJupiterQuoteError(err instanceof Error ? err.message.slice(0, 120) : "Quote unavailable");
        setJupiterQuote(null);
      } finally {
        if (!cancelled) setJupiterQuoteLoading(false);
      }
    };

    // Initial fetch (debounced so rapid typing doesn't spam the API)
    const debounceTimer = setTimeout(fetchQuote, 400);
    // Auto-refresh every 15 s — Jupiter quotes expire in ~30 s
    const refreshTimer  = setInterval(fetchQuote, 15_000);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
      clearInterval(refreshTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.graduated, token?.platform, token?.address, token?.decimals, amount, tradeMode]);

  // New chart state
  const [chartTf, setChartTf] = useState<ChartTimeframe>("1m");
  const [chartType, setChartType] = useState<ChartType>("candle");
  const [indicators, setIndicators] = useState<Indicator[]>([]);
  const [indOpen, setIndOpen] = useState(false);
  const [chartTypeOpen, setChartTypeOpen] = useState(false);

  // Server-side OHLCV: pre-aggregated over the full trade history (no 100-row limit).
  // Adaptive refetch: short timeframes need faster bar updates (a new 1-minute bar
  // opens every 60 s, so polling at 8 s means users see it within one tick).
  // Longer timeframes are less time-sensitive; 30 s is fine there.
  const ohlcvRefetchMs = chartTf === "1m" || chartTf === "5m" ? 8_000
    : chartTf === "15m" || chartTf === "1H"                   ? 15_000
    : 30_000;
  const { data: serverOhlcv, isLoading: ohlcvLoading } = useGetTokenOhlcv(
    selectedAddress || "",
    { tf: chartTf },
    {
      query: {
        enabled: !!selectedAddress,
        queryKey: ["ohlcv", selectedAddress, chartTf],
        refetchInterval: ohlcvRefetchMs,
        staleTime: ohlcvRefetchMs - 2_000,
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
    // For DEX tokens: token.priceEth in DB may be stale (set during backfill, not refreshed live).
    // The OHLCV route fetches current Birdeye price and appends a synthetic latest candle; use that
    // candle's close as currentPrice so the price panel stays in sync with the chart.
    const _isDexToken = ["pumpswap","raydium_launchlab"].includes(token?.platform ?? "");
    const dexOhlcvPrice = _isDexToken ? (serverOhlcv?.bars?.slice(-1)[0]?.close ?? null) : null;
    // DEX tokens: skip livePrice entirely — the adapter computes priceEth with a
    // pump.fun-specific /1000 decimal correction (assumes 6-decimal tokens).
    // DEX tokens can have any decimal count (e.g. WSOL has 9 → price comes out
    // 1000× too small).  Birdeye OHLCV is always correct for DEX tokens.
    const currentPrice = _isDexToken
      ? (dexOhlcvPrice ?? (token?.priceEth ? parseFloat(token.priceEth) : 0))
      : (livePrice ?? dexOhlcvPrice ?? (token?.priceEth ? parseFloat(token.priceEth) : 0));
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
      return { val: formatPct(diff), up: diff >= 0 };
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
  }, [liveToken, token?.priceEth, token?.platform, serverOhlcv, liveTrades, history, serverStats, serverPriceHistory]);

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
    // Show Market Cap (SOL/token × solPrice × 1B supply) — same convention as pump.fun
    const fmt = (n: number): string => {
      if (sp && n > 0) return formatUSD(n * sp * 1_000_000_000);
      return n < 0.00001 ? n.toExponential(3) : n.toPrecision(4);
    };
    el.innerHTML = `
      <span style="color:#b3b3b3">O <span style="color:#bbbbbb">${fmt(bar.open)}</span></span>
      <span style="color:#b3b3b3">H <span style="color:#4ade80">${fmt(bar.high)}</span></span>
      <span style="color:#b3b3b3">L <span style="color:#f87171">${fmt(bar.low)}</span></span>
      <span style="color:#b3b3b3">C <span style="color:#e0e0e0">${fmt(bar.close)}</span></span>
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

  // Effective market cap: stored value first, then derive from virtual reserves as fallback.
  // DEX tokens (raydium/orca/meteora/pumpswap) use pump.fun default virtual reserves which
  // produce a meaningless ~$229B number — skip the formula for those platforms.
  const DEX_PLATFORMS_SET = new Set(["pumpswap", "raydium_launchlab"]);
  const isDexToken = DEX_PLATFORMS_SET.has(token?.platform ?? "");
  const effectiveMcEth = useMemo(() => {
    // DEX tokens: skip liveToken.marketCapEth — the adapter computes it from
    // the same /1000-decimal formula used for priceEth, which is unreliable for
    // non-6-decimal tokens (same bug that caused WSOL price to show 1000× low).
    // Use DB marketCapEth instead (kept fresh by the Birdeye OHLCV async update).
    const raw = isDexToken
      ? token?.marketCapEth
      : (liveToken?.marketCapEth ?? token?.marketCapEth);

    if (raw && raw !== "0") return raw;

    // For DEX tokens: fallback to marketCapUsd converted to lamports (formatMCUsd ÷1e9 × solPrice)
    if (isDexToken) {
      const mcUsd = (token as { marketCapUsd?: number | null } | null)?.marketCapUsd;
      if (mcUsd && mcUsd > 0 && solPrice && solPrice > 0) {
        return String(Math.round((mcUsd / solPrice) * 1e9));
      }
      return null; // No market cap data → show "—", don't use virtual reserves
    }

    // pump.fun: derive from virtual reserves
    // (pump.fun stores MC as null until the first trade updates it via on-chain data;
    //  the bonding curve formula: MC_lamports = totalSupply × vSol_lamports / vTok_atomic)
    try {
      const vSolSol  = parseFloat(liveToken?.virtualEthReserves   ?? token?.virtualEthReserves   ?? "0");
      const vTokAtom = parseFloat(liveToken?.virtualTokenReserves ?? token?.virtualTokenReserves ?? "1");
      if (vSolSol <= 0 || vTokAtom <= 0) return null;
      // totalSupply_atomic(1e15) × vSolLamports(vSolSol×1e9) / vTokAtom
      const mc = Math.round(1e15 * (vSolSol * 1e9) / vTokAtom);
      return mc > 0 ? mc.toString() : null;
    } catch { return null; }
  }, [isDexToken, liveToken?.marketCapEth, token?.marketCapEth,
      liveToken?.virtualEthReserves, token?.virtualEthReserves,
      liveToken?.virtualTokenReserves, token?.virtualTokenReserves,
      solPrice]);

  // Memoized chart JSX — only re-renders when chart config state changes, not on crosshair moves
  const ChartSection = useMemo(() => {
    if (!token) return null;

    // Shared wrapper — matches real chart dimensions exactly to prevent layout jump.
    // Toolbar spacer (36px) + same responsive canvas height as the real ChartCanvas container.
    const ChartPlaceholder = ({ children }: { children: React.ReactNode }) => (
      <div className="border border-border/20 rounded-sm overflow-hidden mb-0" style={{ background: "#111111" }}>
        <div style={{ height: 36, background: "#0a0a0a", borderBottom: "1px solid rgba(255,255,255,0.08)" }} />
        <div className="h-[260px] sm:h-[340px] lg:h-[400px] xl:h-[440px] flex items-center justify-center">
          {children}
        </div>
      </div>
    );

    // Professional spinner — same SVG as ChartCanvas's internal ChartSkeleton.
    const ChartSpinner = () => (
      <svg width="36" height="36" viewBox="0 0 36 36"
        style={{ animation: "chartSpinnerRotate 0.9s linear infinite", flexShrink: 0 }}>
        <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
        <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(59,130,246,0.75)" strokeWidth="3"
          strokeLinecap="round" strokeDasharray="30 65" />
      </svg>
    );

    // OHLCV still in flight — spinner only, no text.
    if (chartBars.length === 0 && ohlcvLoading) {
      return <ChartPlaceholder><ChartSpinner /></ChartPlaceholder>;
    }

    // Empty state — only show after server has responded with zero bars.
    if (chartBars.length === 0) {
      return (
        <ChartPlaceholder>
          <div className="flex flex-col items-center gap-2 text-center px-8">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#3a3a3a" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <p className="text-sm font-medium" style={{ color: "#555555" }}>No trades yet</p>
            <p className="text-xs" style={{ color: "#3a3a3a" }}>Chart populates in real time as trades arrive</p>
          </div>
        </ChartPlaceholder>
      );
    }

    return (
      <div className="border border-border/20 rounded-sm overflow-hidden mb-0" style={{ background: "#111111" }}>
        {/* Toolbar */}
        <div className="flex items-stretch overflow-x-auto" style={{ background: "#0a0a0a", borderBottom: "1px solid rgba(255,255,255,0.08)", scrollbarWidth: "none" }}>
          {/* Candle / Line / Indicators — tab style */}
          <div className="flex items-center gap-1.5 px-2 shrink-0" style={{ borderRight: "1px solid rgba(255,255,255,0.08)" }}>

            {/* Mobile: icon-only chart type picker — native select overlaid for reliability */}
            <div className="relative sm:hidden flex items-center justify-center w-9 h-9 cursor-pointer"
              style={{ color: "#e0e0e0" }}>
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
                  color: chartType === type ? "#e0e0e0" : "#b3b3b3",
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
              style={{ color: indicators.length ? "#e0e0e0" : "#b3b3b3" }}>
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
                      ? { background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 20, color: "#e0e0e0" }
                      : { borderRadius: 20, border: "1px solid transparent", color: "#b3b3b3" })
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
                      ? { background: "rgba(255,255,255,0.10)", border: "1px solid transparent", borderRadius: 20, color: "#e0e0e0" }
                      : { borderRadius: 20, border: "1px solid transparent", color: "#b3b3b3" })
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
  }, [chartBars, chartType, chartTf, indicators, indOpen, connected, token?.address, token?.graduated, onCrosshairMove, solPrice, isSwitching]);

  const handleTrade = async () => {
    if (!wallet) {
      openWalletModal();
      return;
    }
    if (!token || !amount) return;
    // Prevent concurrent submissions: user must wait for signing + on-chain confirmation.
    if (isTradePending) return;

    // Read current swap settings at execution time
    const { slippageBps, priorityFee } = getSwapSettings();

    // Core trade logic — builds, signs, and sends a real pump.fun bonding curve tx.
    const doTrade = async (): Promise<string> => {
      const numAmount = parseFloat(amount);
      // isFinite guard: BigInt(Math.round(Infinity * 1e9)) throws RangeError
      if (!isFinite(numAmount) || isNaN(numAmount) || numAmount <= 0) throw new Error("Invalid amount");

      // ── Platform guard ────────────────────────────────────────────────────────
      // Supported paths:
      //   pump_fun (not graduated) → bonding curve (buildPumpFunBuyTx/SellTx)
      //   pump_fun (graduated)     → Jupiter DEX routing
      //   pumpswap                 → always graduated, Jupiter DEX routing
      //   raydium_launchlab (graduated) → Jupiter DEX routing
      //   anything else            → not yet supported
      const isTradeable =
        token.platform === "pump_fun" ||
        token.platform === "pumpswap" ||
        token.platform === "raydium_launchlab"; // graduated → Jupiter; bonding-curve → LaunchLab SDK

      if (!isTradeable) {
        throw new Error(
          `On-chain trading for ${token.platform ?? "this platform"} is coming soon.`
        );
      }
      // Settings are validated by the store; clamped [0, 9999] by sanitise().
      // Declared early so both the Jupiter path and the pump.fun path can use it.
      const safeBps = slippageBps;

      // pumpswap tokens are always on-DEX (no bonding curve) even if the graduated
      // flag wasn't set; treat them the same as graduated pump_fun tokens.
      if (token.graduated || token.platform === "pumpswap") {
        // ── Jupiter swap path for graduated / DEX tokens ─────────────────────
        // Token has left the bonding curve and is now tradeable on Raydium/PumpSwap.
        // Jupiter aggregator auto-routes to the best available pool.
        const numAmt = parseFloat(amount);
        if (!isFinite(numAmt) || isNaN(numAmt) || numAmt <= 0) throw new Error("Invalid amount");

        // Use the token's actual decimal count (default 6 — pump.fun / PumpSwap / LaunchLab all use 6)
        const tokenAtoms = Math.pow(10, token?.decimals ?? 6);
        const amtBaseUnits = tradeMode === "buy"
          ? BigInt(Math.round(numAmt * 1e9))         // SOL → lamports
          : BigInt(Math.round(numAmt * tokenAtoms));  // tokens → atomic units

        const inputMint  = tradeMode === "buy" ? WSOL_MINT : token.address;
        const outputMint = tradeMode === "buy" ? token.address : WSOL_MINT;

        // Reuse the background-cached quote if it is < 5 s old — this skips one
        // Jupiter API round-trip (~400-700 ms) on every trade.  The preview quote
        // always corresponds to the current amount/mode (the auto-fetch effect
        // resets it to null on any amount/mode change), so staleness is the only
        // risk; slippage protection in otherAmountThreshold still applies.
        const quoteAge = Date.now() - jupiterQuoteTimeRef.current;
        const freshQuote = (jupiterQuote && quoteAge < 5_000)
          ? jupiterQuote
          : await getJupiterQuote(inputMint, outputMint, amtBaseUnits, safeBps);

        const { transaction: jupTxRaw, lastValidBlockHeight: jupLastBlock } =
          await buildJupiterSwapTx(freshQuote, wallet);

        // Inject 1% platform fee into the transaction before the user signs.
        // Buy: 1% of SOL spent (inAmount in lamports).
        // Sell: 1% of SOL received (outAmount in lamports).
        const jupSolLamports = tradeMode === "buy"
          ? BigInt(freshQuote.inAmount)
          : BigInt(freshQuote.outAmount);
        const jupTx = await addFeeToVersionedTx(jupTxRaw, wallet, jupSolLamports, getConnection());

        // Sign via wallet, then broadcast through Alchemy's staked connections —
        // same pattern as the pump.fun portal path.  Alchemy has dedicated
        // validator connections and retries stalled txs; wallet default RPC does not.
        const signedJupTx = await signVersionedTransaction(jupTx);
        const jupSig = await getConnection().sendRawTransaction(signedJupTx.serialize(), {
          skipPreflight: true,
          maxRetries:    5,
        });

        // ── Optimistic release — same pattern as pump.fun path ────────────────
        // The tx is broadcast; release the spinner immediately so the user isn't
        // blocked for 30-90 s waiting for on-chain confirmation.
        // Confirm in the background and trigger a second refetch once settled.
        setAmount("");
        refetchToken();
        refetchHistory();
        // Retry balance several times to cover RPC propagation delay.
        refreshAfterTrade();
        schedulePortfolioRefresh();

        const jupBlockhash = jupTx.message.recentBlockhash;
        waitForJupiterTxConfirmation(jupSig, jupBlockhash, jupLastBlock)
          .then(() => { refetchToken(); refetchHistory(); refreshAfterTrade(); })
          .catch(err => console.warn("[jupiter] bg confirmation:", err));

        return jupSig;
      }

      // ── Raydium LaunchLab bonding-curve path (non-graduated) ─────────────────
      // Graduated LaunchLab tokens are already handled by the Jupiter block above.
      // Non-graduated tokens use the Raydium SDK's launchpad.buyToken / sellToken.
      // The SDK fetches live pool state from RPC, builds the instruction, and returns
      // a LEGACY transaction ready for the wallet to sign.
      if (token.platform === "raydium_launchlab") {
        const LAUNCHLAB_ATOMS = 1_000_000; // 6 decimal places, same as pump.fun

        let llSig: string;
        let llHash: string;
        let llHeight: number;

        if (tradeMode === "buy") {
          const solIn = BigInt(Math.round(numAmount * 1e9));
          const res = await buildLaunchLabBuyTx({
            mint:                      token.address,
            user:                      wallet,
            solLamports:               solIn,
            slippageBps:               safeBps,
            priorityFeeMicroLamports:  priorityFee,
          });
          // Inject 1% platform fee (SOL in) into the legacy transaction before signing.
          addFeeToLegacyTx(res.transaction, wallet, solIn);
          // Sign via wallet, broadcast via Alchemy (skipPreflight + 5 retries).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const signedLLBuyTx = await signVersionedTransaction(res.transaction as any);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          llSig = await getConnection().sendRawTransaction((signedLLBuyTx as any).serialize(), {
            skipPreflight: true,
            maxRetries:    5,
          });
          llHash = res.blockhash;
          llHeight = res.lastValidBlockHeight;
        } else {
          const tokenIn = BigInt(Math.round(numAmount * LAUNCHLAB_ATOMS));
          const res = await buildLaunchLabSellTx({
            mint:                      token.address,
            user:                      wallet,
            tokenAtoms:                tokenIn,
            slippageBps:               safeBps,
            priorityFeeMicroLamports:  priorityFee,
          });
          // Sign via wallet, broadcast via Alchemy (skipPreflight + 5 retries).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const signedLLSellTx = await signVersionedTransaction(res.transaction as any);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          llSig = await getConnection().sendRawTransaction((signedLLSellTx as any).serialize(), {
            skipPreflight: true,
            maxRetries:    5,
          });
          llHash = res.blockhash;
          llHeight = res.lastValidBlockHeight;
        }

        // Optimistic release — broadcast succeeded; clear spinner immediately.
        setAmount("");
        refetchToken();
        refetchHistory();
        refreshAfterTrade();
        schedulePortfolioRefresh();

        waitForTxConfirmation(llSig, llHash, llHeight)
          .then(() => { refetchToken(); refetchHistory(); refreshAfterTrade(); })
          .catch(err => console.warn("[launchlab] bg confirmation:", err));

        return llSig;
      }

      // ── Build via pumpportal.fun — always uses the current account layout ────────
      // Pump.fun upgraded their program in 2025 (added creatorVault account to buy/sell).
      // Our hand-built builder was missing it → Phantom preflight → "Internal error".
      // Pumpportal.fun tracks program updates and always returns a correct transaction.
      //
      // amount conventions:
      //   buy  → numAmount is SOL to spend (denominatedInSol: true)
      //   sell → numAmount is display-unit tokens to sell (denominatedInSol: false)
      const slippagePct = safeBps / 100;
      // Always enforce a minimum 0.001 SOL priority fee for pump.fun bonding-curve trades.
      // Without it, transactions routinely expire on the competitive pump.fun program
      // (~150 slots ≈ 60 s window) because they sit at the bottom of the fee queue.
      // 0.001 SOL is small enough to be negligible but large enough to land reliably.
      const PUMP_MIN_PRIORITY_SOL = 0.001;
      const computedPrioritySOL   = priorityFee > 0 ? (priorityFee * 200_000) / 1e15 : 0;
      const priorityFeeSOL        = Math.max(PUMP_MIN_PRIORITY_SOL, computedPrioritySOL);

      const { transaction: portalTxRaw, blockhash, lastValidBlockHeight } =
        tradeMode === "buy"
          ? await buildPumpFunBuyTxViaPortal(wallet, token.address, numAmount, slippagePct, priorityFeeSOL)
          : await buildPumpFunSellTxViaPortal(wallet, token.address, numAmount, slippagePct, priorityFeeSOL);

      // Inject 1% platform fee on buys (SOL-out for sells is unknown at build time).
      const portalSolLamports = tradeMode === "buy" ? BigInt(Math.round(numAmount * 1e9)) : 0n;
      const portalTx = await addFeeToVersionedTx(portalTxRaw, wallet, portalSolLamports, getConnection());

      // Sign via the wallet (shows Phantom popup), then submit through our Alchemy RPC.
      // Using sign-then-send (instead of signAndSendTransaction) lets us control the
      // submission endpoint: Alchemy has dedicated stake-weighted connections to validators
      // and retries stalled transactions, unlike the wallet's default free RPC endpoint.
      const signedPortalTx  = await signVersionedTransaction(portalTx);
      const conn            = getConnection();
      // Broadcast via Alchemy (fast stake-weighted connections, 5 auto-retries).
      // skipPreflight=true avoids the stale-state simulation error that fires when
      // price moves between pumpportal building the tx and the user approving it.
      const txSignature = await conn.sendRawTransaction(signedPortalTx.serialize(), {
        skipPreflight: true,
        maxRetries:    5,
      });

      // ── Optimistic release — same UX as pump.fun ──────────────────────────────
      // The tx is now in the network and Alchemy is retrying on our behalf.
      // Clear the input and trigger an immediate optimistic refetch so the UI
      // feels instant. We confirm in the background and do a second refetch once
      // the tx is finalized so any late-landing balance/reserve update is captured.
      setAmount("");
      refetchToken();
      refetchHistory();
      refreshAfterTrade();
      schedulePortfolioRefresh();

      waitForJupiterTxConfirmation(txSignature, blockhash, lastValidBlockHeight)
        .then(() => { refetchToken(); refetchHistory(); refreshAfterTrade(); })
        .catch(err => console.warn("[pumpfun] bg confirmation:", err));

      // Real Solana signature (≥60 chars) → useTxToast shows Solscan link.
      return txSignature;
    };

    // submitTx shows pending → confirmed/failed toast feedback.
    // isTradePending gates the trade button for the full lifecycle:
    //   build tx → wallet popup → broadcast → on-chain confirmation
    setIsTradePending(true);
    try {
      await submitTx(
        doTrade(),
        tradeMode === "buy" ? "Buy" : "Sell",
      );
    } finally {
      setIsTradePending(false);
      refreshSolBalance();
      // refreshAfterTrade is already scheduled from within doTrade (optimistic + bg
      // confirmation callbacks). Call it one more time here in case doTrade threw
      // before reaching the optimistic-release block (e.g. wallet rejection on sell).
      refreshTokenBalance();
    }
  };

  const copyToClipboard = (text: string, label?: string) => {
    fireClipboard(text, label);
  };

  if (!selectedAddress) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] border border-border/50 border-dashed rounded-sm p-8 bg-card max-w-2xl mx-auto mt-8 animate-slideDown">
        <Search className="h-10 w-10 text-muted-foreground mb-4 opacity-40" />
        <h2 className="text-lg font-bold mb-2 text-foreground">Search for a coin to trade</h2>
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

  if (loadingToken && !token) {
    return (
      <div className="flex flex-col md:flex-row w-full min-w-[320px] md:min-w-[680px]">
        {/* Left column — spinner only in the chart area */}
        <div className="flex-1 min-w-0 border-r border-border/20 px-3 pt-3 md:px-5 md:pt-4 pb-6 flex flex-col gap-4">
          <div className="border border-border/20 rounded-sm overflow-hidden" style={{ background: "#111111" }}>
            <div style={{ height: 36, background: "#0a0a0a", borderBottom: "1px solid rgba(255,255,255,0.08)" }} />
            <div className="h-[260px] sm:h-[340px] lg:h-[400px] xl:h-[440px] flex items-center justify-center">
              <svg width="36" height="36" viewBox="0 0 36 36"
                style={{ animation: "chartSpinnerRotate 0.9s linear infinite", flexShrink: 0 }}>
                <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(59,130,246,0.75)" strokeWidth="3"
                  strokeLinecap="round" strokeDasharray="30 65" />
              </svg>
            </div>
          </div>
        </div>
        {/* Right column — empty while token loads */}
        <div className="w-full md:w-[320px] xl:w-[360px] shrink-0" />
      </div>
    );
  }

  if (tokenError) {
    // Token not in our DB — render the external token page instead of an error.
    // ExternalTokenLoader resolves metadata from:
    //   1. Module-level cache (set when user clicked a search result)
    //   2. Client-side Jupiter strict list (handles direct URL / page reload)
    //   3. Generic error if still not found after list loads
    return <ExternalTokenLoader address={selectedAddress} wallet={wallet} />;
  }
  if (!token) return <div className="text-center py-20 text-muted-foreground font-mono">Token not found.</div>;

  // virtualEthReserves stores integer SOL (Pump.fun: starts with 30 virtual SOL, graduates at +85 real SOL)
  const vSolInt = parseFloat((liveToken?.virtualEthReserves ?? token.virtualEthReserves) || "0");
  const realSolInCurve = Math.max(0, vSolInt - 30);
  const progressPercent = Math.min(100, (realSolInCurve / 85) * 100);
  const isGraduated = token.graduated || progressPercent >= 100;

  // Prefer live snapshot identity (pushed by SSE on connect and after enrichment) over the
  // initial REST response, so name/symbol/image update in real time without a page refresh.
  const displayName     = (liveToken?.name   && !liveToken.name.endsWith("…")   && liveToken.name   !== "???" ? liveToken.name   : null) ?? token.name;
  const rawSymbol       = (liveToken?.symbol && liveToken.symbol !== "???"                                     ? liveToken.symbol : null) ?? token.symbol;
  // For unnamed LaunchLab placeholder tokens (symbol still "???"), derive a
  // readable symbol from the token address so the header/page-title are useful.
  const displaySymbol   = rawSymbol === "???" ? token.address.slice(0, 6).toUpperCase() : rawSymbol;
  const displayImageUrl = liveToken?.imageUrl ?? token.imageUrl;

  return (
    /* Full-bleed two-column layout — mirrors pump.fun */
    <div className="relative flex flex-col md:flex-row w-full animate-slideDown min-w-[320px] md:min-w-[680px]">
      <SEO
        fullTitle={`${displayName} ($${displaySymbol}) | Pumpi`}
        description={`Trade ${displayName} ($${displaySymbol}) on Pumpi — real-time chart, trade history, and one-click buy/sell on Solana.`}
        image={displayImageUrl}
        type="article"
        url={`${typeof window !== "undefined" ? window.location.origin : ""}/coin/${token.address}`}
        keywords={`${displaySymbol}, ${displayName}, solana memecoin, trade ${displaySymbol}`}
      />

      {/* ── LEFT: scrollable chart + info ── */}
      <div data-token-panel className="flex-1 min-w-0 border-r border-border/20 px-0 md:px-5 py-0 md:py-4 pb-20 md:pb-6">

        {/* Compact Token Header */}
        <div className="flex gap-3 items-start mb-2 px-3 pt-3 md:px-0 md:pt-0">
          <TokenAvatar symbol={displaySymbol} imageUrl={displayImageUrl} size={52} shape="square" className="border border-border/40 shadow-sm" />
          <div className="flex-1 min-w-0">
            <div className="flex flex-col leading-tight min-w-0">
              <h1 className="text-lg font-bold text-foreground truncate min-w-0">{displayName}</h1>
              <span className="text-[#b3b3b3] font-mono text-sm font-semibold tracking-wide">${displaySymbol}</span>
            </div>
            <div className="flex items-center gap-2 mt-2">
              {(token as any).twitterUrl && (
                <a href={(token as any).twitterUrl} target="_blank" rel="noopener noreferrer" className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground" title="X (Twitter)"><XIcon className="h-4 w-4" /></a>
              )}
              {(token as any).websiteUrl && (
                <a href={(token as any).websiteUrl} target="_blank" rel="noopener noreferrer" className="h-8 w-8 flex items-center justify-center rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground" title="Website"><Globe className="h-4 w-4" /></a>
              )}
              {/* Address pill with copy */}
              <button
                className="h-8 px-2.5 flex items-center gap-1.5 rounded border border-border/50 bg-muted/50 hover:bg-muted hover:text-foreground transition-colors text-muted-foreground font-mono text-[12px]"
                title={token.address}
                onClick={() => copyToClipboard(token.address)}
              >
                {token.address.slice(0, 4)}…{token.address.slice(-4)}
                <Copy className="h-3.5 w-3.5" />
              </button>
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
        {typeof token.description === "string" && token.description.length > 0 && (() => {
          const LIMIT = 120;
          const isLong = token.description.length > LIMIT;
          const displayText = isLong && !descExpanded
            ? token.description.slice(0, LIMIT).trimEnd() + "…"
            : token.description;

          // Linkify URLs so "discord.gg/xyz" and "https://..." are clickable
          const URL_RE = /https?:\/\/[^\s]+|(?:discord\.gg|t\.me|twitter\.com|x\.com|telegram\.me)\/[^\s]*/gi;
          const renderWithLinks = (text: string) => {
            const parts: React.ReactNode[] = [];
            let last = 0;
            let m: RegExpExecArray | null;
            URL_RE.lastIndex = 0;
            while ((m = URL_RE.exec(text)) !== null) {
              if (m.index > last) parts.push(text.slice(last, m.index));
              const raw = m[0];
              const href = raw.startsWith("http") ? raw : `https://${raw}`;
              parts.push(
                <a key={m.index} href={href} target="_blank" rel="noopener noreferrer"
                  className="underline underline-offset-2 transition-colors hover:text-slate-200"
                  style={{ color: "#60a5fa" }}>
                  {raw}
                </a>
              );
              last = m.index + raw.length;
            }
            if (last < text.length) parts.push(text.slice(last));
            return parts;
          };

          return (
            <div className="mb-2 px-3 md:px-0">
              <p className="text-[14px] leading-relaxed" style={{ color: "#b3b3b3" }}>
                {renderWithLinks(displayText)}
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
              <span className="text-[12px] font-medium mb-0.5" style={{ color: "#b3b3b3" }}>Market Cap</span>
              <span
                key={priceFlash.key}
                className={`text-[18px] font-bold text-foreground font-mono tabular-nums leading-tight${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
              >
                {formatMCUsd(effectiveMcEth, solPrice)}
              </span>
            </div>
            <div className="flex flex-col justify-center items-end">
              <span className="text-[12px] font-medium mb-0.5" style={{ color: "#b3b3b3" }}>Price</span>
              <span
                key={`price-${priceFlash.key}`}
                className={`text-[18px] font-bold font-mono tabular-nums leading-tight${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
                style={{ color: "#e0e0e0" }}
              >
                {priceStats.currentPrice > 0
                  ? formatTokenPrice(solPrice ? priceStats.currentPrice * solPrice : priceStats.currentPrice)
                  : "—"}
              </span>
            </div>
          </div>

          {/* ── MOBILE: Row 2 — Bonding Curve (pump.fun only) ── */}
          <div className="md:hidden">{token.platform !== "pump_fun" ? null : <div>
            <span className="text-[12px] font-medium mb-1 block" style={{ color: "#b3b3b3" }}>Bonding Curve</span>
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
                {token.graduatedAt && <span className="text-[10px]" style={{ color: "#b3b3b3" }}>· {timeAgo(token.graduatedAt)} ago</span>}
              </div>
            ) : (
              <div className="flex items-center justify-between mt-1">
                <span className="text-[12px] font-mono" style={{ color: "#bbbbbb" }}>
                  {realSolInCurve.toFixed(2)}<span className="ml-1" style={{ color: "#555555" }}>/ 85 SOL</span>
                  <span className="ml-1.5 text-[11px] font-bold" style={{ color: "#10b981" }}>· {progressPercent.toFixed(1)}%</span>
                </span>
                <span className="text-[12px]" style={{ color: "#b3b3b3" }}>
                  {(85 - realSolInCurve).toFixed(2)} SOL left
                </span>
              </div>
            )}
          </div>}</div>

          {/* ── MOBILE: Row 3 — Vol 24h + 5m / 1h / 6h / 24h % (scrollable) ── */}
          <div className="overflow-x-auto scrollbar-none mt-2 md:hidden">
            <div className="flex items-center gap-4 min-w-max">
              {/* Vol 24h */}
              <div className="shrink-0 flex flex-col justify-center pr-3" style={{ borderRight: "1px solid rgba(255,255,255,0.08)" }}>
                <span className="text-[12px] font-medium mb-0.5" style={{ color: "#b3b3b3" }}>Vol 24h</span>
                <span className="font-mono font-bold text-[18px] tabular-nums leading-tight" style={{ color: "#e0e0e0" }}>
                  {solPrice && priceStats.vol24h > 0 ? formatUSD(priceStats.vol24h * solPrice) : "—"}
                </span>
              </div>
              {/* % change stats */}
              {([
                { label: "5m",  data: priceStats.p5m },
                { label: "1h",  data: priceStats.p1h },
                { label: "6h",  data: priceStats.p6h },
                { label: "24h", data: priceStats.p24h },
              ] as { label: string; data: { val: string; up: boolean } | null }[]).map(({ label, data }) => (
                <div key={label} className="shrink-0 flex flex-col items-center">
                  <span className="text-[12px] font-medium mb-0.5" style={{ color: label === "24h" ? "#b3b3b3" : "#b3b3b3" }}>{label}</span>
                  <span
                    className="font-mono font-bold text-[14px] tabular-nums leading-tight"
                    style={{ color: data ? (data.up ? "#4ade80" : "#f87171") : "#555555" }}
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
              <span className="text-[14px] font-medium mb-0.5" style={{ color: "#b3b3b3" }}>Market Cap</span>
              <span
                key={priceFlash.key}
                className={`text-[20px] font-bold text-foreground font-mono tabular-nums leading-tight${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
              >
                {formatMCUsd(effectiveMcEth, solPrice)}
              </span>
            </div>
            {/* Bonding Curve — pump.fun only */}
            {token.platform !== "pump_fun" ? null : (
            <div className="w-[380px] shrink-0 flex flex-col justify-center">
              <span className="text-[14px] font-medium mb-1 block" style={{ color: "#b3b3b3" }}>Bonding Curve</span>
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
                  {token.graduatedAt && <span className="text-[10px]" style={{ color: "#b3b3b3" }}>· {timeAgo(token.graduatedAt)} ago</span>}
                </div>
              ) : (
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[12px] font-mono" style={{ color: "#bbbbbb" }}>
                    {realSolInCurve.toFixed(2)}<span className="ml-1" style={{ color: "#555555" }}>/ 85 SOL</span>
                    <span className="ml-1.5 text-[11px] font-bold" style={{ color: "#10b981" }}>· {progressPercent.toFixed(1)}%</span>
                  </span>
                  <span className="text-[12px]" style={{ color: "#b3b3b3" }}>
                    {(85 - realSolInCurve).toFixed(2)} SOL left
                  </span>
                </div>
              )}
            </div>
            )}
            {/* Price + 24h % */}
            <div className="flex-1 flex flex-col justify-center items-end">
              <span className="text-[12px] font-medium mb-0.5" style={{ color: "#b3b3b3" }}>Price USD</span>
              <span
                key={`price-${priceFlash.key}`}
                className={`text-[16px] font-bold font-mono tabular-nums leading-tight${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
                style={{ color: "#e0e0e0" }}
              >
                {priceStats.currentPrice > 0
                  ? formatTokenPrice(solPrice ? priceStats.currentPrice * solPrice : priceStats.currentPrice)
                  : "—"}
              </span>
              {priceStats.p24h && (
                <span
                  className="text-[12px] font-semibold font-mono tabular-nums mt-0.5"
                  style={{ color: priceStats.p24h.up ? "#4ade80" : "#f87171" }}
                >
                  {priceStats.p24h.up ? "▲" : "▼"} {priceStats.p24h.val} 24h
                </span>
              )}
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
              isPending={isTradePending}
              isGraduated={!!(token?.graduated || token?.platform === "pumpswap")}
              jupiterQuote={jupiterQuote}
              jupiterQuoteLoading={jupiterQuoteLoading}
              jupiterQuoteError={jupiterQuoteError}
              solBalance={solBalance}
              tokenBalance={tokenBalance}
              atomicBalance={atomicBalance}
              balanceLoading={balanceLoading}
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
          // Use on-chain total supply as denominator so % of supply is accurate.
          // token.totalSupply is in atomic units (pump.fun: 1e15 = 1B × 10^6).
          // Guard: some DB rows have 1e27 (DB migration bug, now repaired).
          // For pump_fun / pumpswap the supply is always 1B × 10^6 = 1e15.
          const PUMP_SUPPLY = 1_000_000_000_000_000;
          const isPumpPlatform = token?.platform === "pump_fun" || token?.platform === "pumpswap";
          const rawSupply = token?.totalSupply ? parseFloat(token.totalSupply) : 0;
          const onChainSupply = rawSupply > 0 && (!isPumpPlatform || rawSupply <= PUMP_SUPPLY)
            ? rawSupply
            : (isPumpPlatform ? PUMP_SUPPLY : 0);
          const totalSupply = onChainSupply > 0
            ? onChainSupply
            : (holders.reduce((s, h) => s + Math.max(0, parseFloat(h.balance) || 0), 0) || 1);

          return (
            <div className="mt-0 px-3 md:px-0">
              {/* Bug fix: React state-based sub-tabs (no more document.getElementById) */}
              <div className="flex items-center gap-2 mb-2">
              <div className="flex gap-2 overflow-x-auto pb-1 flex-1" style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
                <button
                  onClick={() => setActiveSubTab("tx")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all shrink-0"
                  style={{
                    background: activeSubTab === "tx" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "tx" ? "#e0e0e0" : "#b3b3b3",
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
                    color: activeSubTab === "holders" ? "#e0e0e0" : "#b3b3b3",
                    border: "1px solid " + (activeSubTab === "holders" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <Users className="h-3.5 w-3.5" /> Holders{holders.length > 0 && <span className="ml-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.08)", color: activeSubTab === "holders" ? "#e0e0e0" : "#b3b3b3" }}>{holders.length.toLocaleString()}</span>}
                </button>
                <button
                  onClick={() => setActiveSubTab("wallets")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all shrink-0"
                  style={{
                    background: activeSubTab === "wallets" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "wallets" ? "#e0e0e0" : "#b3b3b3",
                    border: "1px solid " + (activeSubTab === "wallets" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <Eye className="h-3.5 w-3.5" /> Top Wallets
                  
                </button>
                <button
                  onClick={() => setActiveSubTab("positions")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all shrink-0"
                  style={{
                    background: activeSubTab === "positions" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "positions" ? "#e0e0e0" : "#b3b3b3",
                    border: "1px solid " + (activeSubTab === "positions" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <TrendingUp className="h-3.5 w-3.5" /> Positions
                </button>
                <button
                  onClick={() => setActiveSubTab("dev")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all shrink-0"
                  style={{
                    background: activeSubTab === "dev" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "dev" ? "#e0e0e0" : "#b3b3b3",
                    border: "1px solid " + (activeSubTab === "dev" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> Dev
                </button>
                <button
                  onClick={() => setActiveSubTab("snipers")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-semibold transition-all shrink-0"
                  style={{
                    background: activeSubTab === "snipers" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)",
                    color: activeSubTab === "snipers" ? "#e0e0e0" : "#b3b3b3",
                    border: "1px solid " + (activeSubTab === "snipers" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)"),
                  }}
                >
                  <Zap className="h-3.5 w-3.5" /> Snipers
                  {snipers.length > 0 && (
                    <span className="ml-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full"
                      style={{ background: "rgba(255,255,255,0.08)", color: activeSubTab === "snipers" ? "#e0e0e0" : "#b3b3b3" }}>
                      {snipers.length}
                    </span>
                  )}
                </button>
              </div>
              {/* Reconnecting indicator — shown when per-token SSE stream is down */}
              {!connected && <ReconnectingChip />}
              </div>

              {/* Trades panel — premium redesign */}
              <div className={`overflow-hidden rounded-lg ${activeSubTab !== "tx" ? "hidden" : ""}`}
                style={{ border: "1px solid rgba(255,255,255,0.07)" }}>

                {/* Header */}
                <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                  <table style={{ minWidth: "560px", width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.025)" }}>
                        {/* Left strip column */}
                        <th style={{ width: 3, padding: 0 }} />
                        <th className="text-left px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>Time</th>
                        <th className="text-left px-2 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>Type</th>
                        <th className="text-right px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>USD</th>
                        <th className="text-right px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>{token.symbol}</th>
                        <th className="hidden md:table-cell text-right px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>SOL</th>
                        <th className="text-right px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>Price</th>
                        <th className="text-right px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>Maker</th>
                        <th style={{ width: 36 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {loadingHistory ? (
                        [...Array(5)].map((_, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                            <td style={{ width: 3, padding: 0 }}><div style={{ width: 3, height: 36, background: "rgba(255,255,255,0.06)" }} /></td>
                            <td className="px-3 py-2.5"><Skeleton className="h-3 w-8" /></td>
                            <td className="px-2 py-2.5"><Skeleton className="h-3.5 w-8" /></td>
                            <td className="px-3 py-2.5 text-right"><Skeleton className="h-3.5 w-14 ml-auto" /></td>
                            <td className="px-3 py-2.5 text-right"><Skeleton className="h-3 w-16 ml-auto" /></td>
                            <td className="hidden md:table-cell px-3 py-2.5 text-right"><Skeleton className="h-3 w-12 ml-auto" /></td>
                            <td className="px-3 py-2.5 text-right"><Skeleton className="h-3 w-14 ml-auto" /></td>
                            <td className="px-3 py-2.5 text-right"><Skeleton className="h-3 w-16 ml-auto" /></td>
                            <td />
                          </tr>
                        ))
                      ) : historyError ? (
                        <tr>
                          <td colSpan={9} className="px-4 py-12 text-center">
                            <div className="flex flex-col items-center gap-2">
                              <AlertCircle className="h-5 w-5" style={{ color: "#f87171" }} />
                              <span className="text-[13px]" style={{ color: "#f87171" }}>Failed to load trades.</span>
                              <button onClick={() => refetchHistory()} className="text-[12px] underline hover:opacity-80 transition-opacity" style={{ color: "#b3b3b3" }}>Retry</button>
                            </div>
                          </td>
                        </tr>
                      ) : (() => {
                        const historyTxHashes = new Set((history ?? []).map(t => t.txHash));
                        const dedupedLive = liveTrades.filter(lt => !historyTxHashes.has(lt.txHash));
                        const allTrades = [...dedupedLive, ...(history ?? [])];
                        const allRows = allTrades.slice(0, tradeDisplayLimit);
                        if (!allRows.length) {
                          return (
                            <tr>
                              <td colSpan={9} className="px-4 py-12 text-center">
                                <div className="flex flex-col items-center gap-2">
                                  <ArrowRightLeft className="h-5 w-5" style={{ color: "#3a3a3a" }} />
                                  <span className="text-[13px]" style={{ color: "#555555" }}>No trades recorded yet</span>
                                </div>
                              </td>
                            </tr>
                          );
                        }
                        return allRows.map((trade, idx) => {
                          const isLive = idx < dedupedLive.length;
                          const isBuy = trade.isBuy;
                          const solAmt = parseFloat(trade.ethAmount || "0") / 1e9;
                          const tokAmt = trade.tokenAmount || "0";
                          const usdVal = solPrice ? solAmt * solPrice : null;
                          const pricePerTokSol = trade.priceEth ? parseFloat(trade.priceEth) : null;
                          const pricePerTokUsd = pricePerTokSol && solPrice ? pricePerTokSol * solPrice : null;
                          const sideColor   = isBuy ? "#4ade80" : "#f87171";
                          const sideBgPill  = isBuy ? "rgba(74,222,128,0.12)"  : "rgba(248,113,113,0.12)";
                          const sideBdr     = isBuy ? "rgba(74,222,128,0.25)"  : "rgba(248,113,113,0.25)";
                          const stripColor  = isBuy ? "#4ade80" : "#f87171";
                          const liveBg      = isBuy ? "rgba(74,222,128,0.05)"  : "rgba(248,113,113,0.05)";

                          // Deterministic avatar color from address
                          const avatarHue = trade.traderAddress
                            ? (trade.traderAddress.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 360)
                            : 200;

                          const fmtUsd = usdVal != null
                            ? (usdVal >= 1000 ? `$${(usdVal / 1000).toFixed(1)}K` : usdVal >= 1 ? `$${usdVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${usdVal.toFixed(2)}`)
                            : "—";

                          return (
                            <tr
                              key={trade.txHash ?? trade.id}
                              className={isLive ? (isBuy ? "animate-trade-buy" : "animate-trade-sell") : ""}
                              style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: isLive ? liveBg : "transparent", transition: "background 0.2s" }}
                              onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                              onMouseLeave={e => (e.currentTarget.style.background = isLive ? liveBg : "transparent")}
                            >
                              {/* Colored left strip */}
                              <td style={{ width: 3, padding: 0 }}>
                                <div style={{ width: 3, height: "100%", minHeight: 36, background: stripColor, opacity: isLive ? 1 : 0.35 }} />
                              </td>

                              {/* Time */}
                              <td className="px-3 py-2.5 text-left font-mono text-[13px] whitespace-nowrap" style={{ color: "#b3b3b3" }}>
                                {timeAgo(trade.timestamp)}
                              </td>

                              {/* Type — plain text */}
                              <td className="px-2 py-2.5 text-left">
                                <span className="font-mono text-[13px] font-bold tracking-wide" style={{ color: sideColor }}>
                                  {isBuy ? "BUY" : "SELL"}
                                </span>
                              </td>

                              {/* USD — hero metric */}
                              <td className="px-3 py-2.5 text-right">
                                <span className="font-mono font-bold text-[13px]" style={{ color: sideColor }}>
                                  {fmtUsd}
                                </span>
                              </td>

                              {/* Token amount */}
                              <td className="px-3 py-2.5 text-right font-mono text-[13px]" style={{ color: "#bbbbbb" }}>
                                {formatAtomicTokenAmount(tokAmt)}
                              </td>

                              {/* SOL */}
                              <td className="hidden md:table-cell px-3 py-2.5 text-right font-mono text-[13px]" style={{ color: "#b3b3b3" }}>
                                {formatSol(trade.ethAmount)}
                              </td>

                              {/* Price */}
                              <td className="px-3 py-2.5 text-right font-mono text-[13px]" style={{ color: "#b3b3b3" }}>
                                {pricePerTokUsd != null ? formatTokenPrice(pricePerTokUsd) : pricePerTokSol != null ? `${pricePerTokSol.toPrecision(3)} SOL` : "—"}
                              </td>

                              {/* Maker — avatar + address */}
                              <td className="px-3 py-2.5 text-right">
                                {trade.traderAddress ? (
                                  <a
                                    href={`https://solscan.io/account/${trade.traderAddress}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 group/maker"
                                    title={trade.traderAddress}
                                  >
                                    <span className="w-4 h-4 rounded-full shrink-0 inline-block"
                                      style={{ background: `hsl(${avatarHue} 70% 45%)` }} />
                                    <span className="font-mono text-[13px] transition-colors group-hover/maker:text-slate-200"
                                      style={{ color: "#b3b3b3" }}>
                                      {trade.traderAddress.slice(0, 4)}…{trade.traderAddress.slice(-4)}
                                    </span>
                                  </a>
                                ) : <span style={{ color: "#3a3a3a" }}>—</span>}
                              </td>

                              {/* Txn link */}
                              <td className="pr-3 py-2.5 text-center" style={{ width: 36 }}>
                                {trade.txHash ? (
                                  <a
                                    href={`https://solscan.io/tx/${trade.txHash}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center justify-center w-7 h-7 rounded-md transition-all"
                                    style={{ background: "rgba(255,255,255,0.07)", color: "#b3b3b3" }}
                                    onMouseEnter={e => {
                                      (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.13)";
                                      (e.currentTarget as HTMLAnchorElement).style.color = "#bbbbbb";
                                    }}
                                    onMouseLeave={e => {
                                      (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.07)";
                                      (e.currentTarget as HTMLAnchorElement).style.color = "#b3b3b3";
                                    }}
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </a>
                                ) : null}
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>

                  {/* Load More */}
                  {(() => {
                    const historyTxHashes = new Set((history ?? []).map(t => t.txHash));
                    const dedupedLive = liveTrades.filter(lt => !historyTxHashes.has(lt.txHash));
                    const total = [...dedupedLive, ...(history ?? [])].length;
                    if (total <= tradeDisplayLimit) return null;
                    const remaining = total - tradeDisplayLimit;
                    return (
                      <div className="flex justify-center py-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
                        <button
                          onClick={() => setTradeDisplayLimit(n => n + 50)}
                          className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-all"
                          style={{ background: "rgba(255,255,255,0.05)", color: "#b3b3b3", border: "1px solid rgba(255,255,255,0.08)" }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.09)"; (e.currentTarget as HTMLButtonElement).style.color = "#e0e0e0"; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.05)"; (e.currentTarget as HTMLButtonElement).style.color = "#b3b3b3"; }}
                        >
                          Load {Math.min(remaining, 50)} more
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.07)", color: "#b3b3b3" }}>{remaining} remaining</span>
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Top Wallets panel */}
              {activeSubTab === "wallets" && (() => {
                const LAMPORTS = 1e9;
                const ATOMIC   = 1e6;
                const creatorAddress = (token as any).creatorAddress as string | undefined;
                const currentPriceSol = priceStats.currentPrice;
                const maxBalance = topWallets.length > 0 ? parseFloat(topWallets[0].balance) : 1;

                const rankColor = (i: number) =>
                  i === 0 ? "#f59e0b" : i === 1 ? "#b3b3b3" : i === 2 ? "#2dd4bf" : "#555555";

                return (
                  <div className="overflow-hidden rounded-lg" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>

                    {/* Summary bar */}
                    {!loadingTopWallets && topWallets.length > 0 && (
                      <div className="flex items-center justify-between px-4 py-2.5 border-b" style={{ borderColor: "rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
                        <div className="flex items-center gap-1.5">
                          <Users className="h-3.5 w-3.5" style={{ color: "#b3b3b3" }} />
                          <span className="text-[14px] font-semibold" style={{ color: "#e0e0e0" }}>
                            {topWallets.length} wallets tracked
                          </span>
                        </div>
                        {creatorAddress && topWallets.some(w => w.address === creatorAddress) && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                            style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.3)", color: "#c084fc" }}>
                            DEV still holding
                          </span>
                        )}
                      </div>
                    )}

                    <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                      <table style={{ minWidth: "560px", width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
                            <th style={{ width: 3, padding: 0 }} />
                            <th className="text-center px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3", width: 36 }}>#</th>
                            <th className="text-left   px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3", width: 140 }}>Wallet</th>
                            <th className="text-right  px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>Holdings</th>
                            <th className="hidden md:table-cell text-right px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>Avg Entry</th>
                            <th className="text-right  px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>P&amp;L</th>
                            <th className="hidden md:table-cell text-right px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>Trades</th>
                            <th className="hidden lg:table-cell text-right px-3 py-2.5 text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#b3b3b3" }}>Last</th>
                          </tr>
                        </thead>
                        <tbody>
                          {loadingTopWallets ? (
                            Array.from({ length: 8 }).map((_, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                                <td style={{ width: 3, padding: 0 }}><div style={{ width: 3, height: 40, background: "#141414" }} /></td>
                                <td className="px-3 py-3 text-center"><Skeleton className="h-3.5 w-5 mx-auto" /></td>
                                <td className="px-3 py-3"><div className="flex items-center gap-2"><Skeleton className="h-5 w-5 rounded-full" /><Skeleton className="h-3.5 w-24" /></div></td>
                                <td className="px-3 py-3 text-right"><Skeleton className="h-3.5 w-16 ml-auto" /></td>
                                <td className="hidden md:table-cell px-3 py-3 text-right"><Skeleton className="h-3 w-20 ml-auto" /></td>
                                <td className="px-3 py-3 text-right"><Skeleton className="h-3.5 w-16 ml-auto" /></td>
                                <td className="hidden md:table-cell px-3 py-3 text-right"><Skeleton className="h-3 w-12 ml-auto" /></td>
                                <td className="hidden lg:table-cell px-3 py-3 text-right"><Skeleton className="h-3 w-10 ml-auto" /></td>
                              </tr>
                            ))
                          ) : topWalletsError && topWallets.length === 0 ? (
                            <tr>
                              <td colSpan={8} className="px-4 py-12 text-center">
                                <div className="flex flex-col items-center gap-2">
                                  <AlertCircle className="h-5 w-5" style={{ color: "#f87171" }} />
                                  <span className="text-[13px]" style={{ color: "#f87171" }}>Failed to load wallet data.</span>
                                  <button onClick={() => refetchTopWallets()} className="text-[12px] underline hover:opacity-80" style={{ color: "#b3b3b3" }}>Retry</button>
                                </div>
                              </td>
                            </tr>
                          ) : topWallets.length === 0 ? (
                            <tr>
                              <td colSpan={8} className="px-4 py-14 text-center">
                                <div className="flex flex-col items-center gap-2">
                                  <Eye className="h-6 w-6" style={{ color: "#3a3a3a" }} />
                                  <span className="text-[14px] font-semibold" style={{ color: "#555555" }}>No wallet data yet</span>
                                  <span className="text-[12px]" style={{ color: "#3a3a3a" }}>Wallets appear once trades are recorded</span>
                                </div>
                              </td>
                            </tr>
                          ) : topWallets.map((w, idx) => {
                            const solIn          = parseFloat(w.totalSolIn)  / LAMPORTS;
                            const solOut         = parseFloat(w.totalSolOut) / LAMPORTS;
                            const rawBalance     = parseFloat(w.balance);
                            const displayBalance = rawBalance / ATOMIC;
                            const currentVal     = displayBalance * currentPriceSol;
                            const pnlSol         = (solOut + currentVal) - solIn;
                            const isProfit       = pnlSol >= 0;
                            const hasPnl         = solIn > 0;
                            const stripColor     = !hasPnl ? "#141414" : isProfit ? "#4ade80" : "#f87171";
                            const pnlColor       = isProfit ? "#4ade80" : "#f87171";

                            const avgEntryLam    = w.avgEntryLamportsPerToken ? parseFloat(w.avgEntryLamportsPerToken) : null;
                            const avgEntrySol    = avgEntryLam != null ? avgEntryLam / 1e3 : null;

                            const isCreator      = !!creatorAddress && w.address === creatorAddress;
                            const avatarHue      = (w.address.split("").reduce((a: number, c: string) => a + c.charCodeAt(0), 0) * 37) % 360;
                            const pct            = (rawBalance / maxBalance) * 100;

                            return (
                              <tr key={w.address}
                                style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "background 0.15s" }}
                                onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                              >
                                {/* Left strip */}
                                <td style={{ width: 3, padding: 0 }}>
                                  <div style={{ width: 3, minHeight: 44, background: stripColor, opacity: hasPnl ? 0.7 : 0.2 }} />
                                </td>

                                {/* Rank */}
                                <td className="px-3 py-3 text-center">
                                  <span className="font-mono text-[13px] font-bold" style={{ color: rankColor(idx) }}>
                                    {idx + 1}
                                  </span>
                                </td>

                                {/* Wallet */}
                                <td className="px-3 py-3" style={{ width: 140, maxWidth: 140 }}>
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="w-5 h-5 rounded-full shrink-0"
                                      style={{ background: `hsl(${avatarHue} 65% 45%)`, display: "inline-block" }} />
                                    <a
                                      href={`https://solscan.io/account/${w.address}`}
                                      target="_blank" rel="noopener noreferrer"
                                      className="font-mono text-[13px] hover:text-white transition-colors truncate"
                                      style={{ color: "#b3b3b3" }}
                                    >
                                      {w.address.slice(0, 4)}…{w.address.slice(-4)}
                                    </a>
                                    {isCreator && (
                                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                                        style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.3)", color: "#c084fc" }}>
                                        DEV
                                      </span>
                                    )}
                                  </div>
                                </td>

                                {/* Holdings + mini progress bar */}
                                <td className="px-3 py-3 text-right">
                                  <div className="flex flex-col items-end gap-1">
                                    <span className="font-mono text-[13px] font-semibold" style={{ color: "#e0e0e0" }}>
                                      {formatAtomicTokenAmount(w.balance)}
                                    </span>
                                    <div className="w-16 h-0.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                                      <div style={{ width: `${pct}%`, height: "100%", background: rankColor(idx), opacity: 0.7 }} />
                                    </div>
                                  </div>
                                </td>

                                {/* Avg Entry */}
                                <td className="hidden md:table-cell px-3 py-3 text-right">
                                  <span className="font-mono text-[13px]" style={{ color: "#b3b3b3" }}>
                                    {avgEntrySol != null
                                      ? (solPrice ? formatTokenPrice(avgEntrySol * solPrice) : avgEntrySol.toPrecision(3) + " SOL")
                                      : "—"}
                                  </span>
                                </td>

                                {/* P&L */}
                                <td className="px-3 py-3 text-right">
                                  {hasPnl ? (
                                    <div className="flex flex-col items-end">
                                      <span className="font-mono text-[13px] font-bold" style={{ color: pnlColor }}>
                                        {isProfit ? "+" : ""}{pnlSol.toFixed(3)} SOL
                                      </span>
                                      {solPrice && (
                                        <span className="font-mono text-[11px]" style={{ color: "#b3b3b3" }}>
                                          {isProfit ? "+" : "-"}{formatUSD(Math.abs(pnlSol) * solPrice)}
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span style={{ color: "#3a3a3a" }}>—</span>
                                  )}
                                </td>

                                {/* Trades */}
                                <td className="hidden md:table-cell px-3 py-3 text-right">
                                  <span className="font-mono text-[13px]" style={{ color: "#b3b3b3" }}>
                                    <span style={{ color: "#4ade80" }}>{w.buyCount}b</span>
                                    {" / "}
                                    <span style={{ color: "#f87171" }}>{w.sellCount}s</span>
                                  </span>
                                </td>

                                {/* Last active */}
                                <td className="hidden lg:table-cell px-3 py-3 text-right">
                                  <span className="font-mono text-[13px]" style={{ color: "#b3b3b3" }}>
                                    {timeAgo(w.lastActivity)}
                                  </span>
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

              {/* Positions panel */}
              {activeSubTab === "positions" && (() => {
                if (!wallet) {
                  return (
                    <div className="flex flex-col items-center justify-center py-14 gap-4 rounded-lg"
                      style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                        <Wallet className="h-5 w-5" style={{ color: "#555555" }} />
                      </div>
                      <div className="text-center space-y-1">
                        <p className="text-[14px] font-semibold" style={{ color: "#bbbbbb" }}>Connect your wallet</p>
                        <p className="text-[12px]" style={{ color: "#555555" }}>Track your position and PnL for this coin</p>
                      </div>
                      <button
                        onClick={() => openWalletModal()}
                        className="px-6 py-2 rounded-lg text-[13px] font-semibold tracking-wide transition-all hover:opacity-90 active:scale-95"
                        style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.25)", color: "#e0e0e0" }}
                      >
                        Connect Wallet
                      </button>
                    </div>
                  );
                }

                // Position tracking is accurate for pump.fun and pumpswap tokens.
                // Both use 6 decimals and the same SOL/token price convention.
                // PumpSwap tokens are pump.fun graduates — same decimal and price
                // normalisation, so P&L math is identical.
                // LetsBONK and Raydium LaunchLab have different decimal/price
                // conventions not yet stored in the DB, so we exclude them.
                const POSITION_SUPPORTED_PLATFORMS = new Set(["pump_fun", "pumpswap"]);
                if (!POSITION_SUPPORTED_PLATFORMS.has(token.platform ?? "")) {
                  return (
                    <div className="flex flex-col items-center justify-center py-14 gap-3 rounded-lg"
                      style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                      <Activity className="h-7 w-7" style={{ color: "#3a3a3a" }} />
                      <div className="text-center space-y-1">
                        <p className="text-[14px] font-semibold text-center" style={{ color: "#b3b3b3" }}>
                          P&L tracking coming for this platform
                        </p>
                        <p className="text-[12px]" style={{ color: "#555555" }}>Currently live for Pump.fun and PumpSwap tokens</p>
                      </div>
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
                      <TrendingUp className="h-8 w-8" style={{ color: "#3a3a3a" }} />
                      <div className="text-center space-y-1">
                        <p className="text-[14px] font-semibold" style={{ color: "#bbbbbb" }}>No position yet</p>
                        <p className="text-[12px]" style={{ color: "#555555" }}>Buy this coin to start tracking your P&L</p>
                      </div>
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
                        <p className="text-[12px] font-medium mb-0.5" style={{ color: "#b3b3b3" }}>Unrealized P&L</p>
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
                        <span className="text-[11px] font-medium mb-1" style={{ color: "#b3b3b3" }}>Return</span>
                        <span className="text-[20px] font-bold font-mono" style={{ color: pnlColor }}>
                          {formatPct(totalPnlPct)}
                        </span>
                      </div>
                    </div>
                    {/* Stats grid */}
                    {rows.map(({ label, value, sub }, i) => (
                      <div key={label} className="flex items-center justify-between px-4 py-2.5"
                        style={{ borderTop: i > 0 ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
                        <span className="text-[13px]" style={{ color: "#b3b3b3" }}>{label}</span>
                        <div className="text-right">
                          <span className="text-[13px] font-mono font-semibold" style={{ color: "#e0e0e0" }}>{value}</span>
                          {sub && sub !== token.symbol && (
                            <p className="text-[11px] font-mono" style={{ color: "#555555" }}>{sub}</p>
                          )}
                          {sub === token.symbol && (
                            <p className="text-[11px]" style={{ color: "#555555" }}>{sub}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Holders panel — DexScreener-style layout */}
              <div className={`rounded-lg overflow-hidden ${activeSubTab !== "holders" ? "hidden" : ""}`}
                style={{ border: "1px solid rgba(255,255,255,0.07)" }}>

                {/* Summary bar */}
                {holders.length > 0 && (() => {
                  const top10Pct = holders.slice(0, 10).reduce((s, h) => {
                    const b = Math.max(0, parseFloat(h.balance) || 0);
                    return s + (b / totalSupply) * 100;
                  }, 0);
                  const isConcentrated = top10Pct > 50;
                  return (
                    <div className="flex items-center justify-between px-4 py-2.5"
                      style={{ background: "rgba(255,255,255,0.025)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <div className="flex items-center gap-1.5">
                        <Users className="h-3.5 w-3.5" style={{ color: "#b3b3b3" }} />
                        <span className="text-[14px] font-semibold" style={{ color: "#e0e0e0" }}>
                          {holders.length.toLocaleString()} holders
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[12px]" style={{ color: "#b3b3b3" }}>Top 10 own</span>
                        <span className="text-[13px] font-bold font-mono"
                          style={{ color: isConcentrated ? "#f87171" : "#b3b3b3" }}>
                          {top10Pct.toFixed(1)}%
                        </span>
                        {isConcentrated && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                            style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.25)" }}>
                            CONCENTRATED
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Holder rows — DexScreener layout */}
                <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                  <table style={{ minWidth: "580px", width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.02)" }}>
                        <th className="text-center px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555", width: 40 }}>Rank</th>
                        <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555" }}>Address</th>
                        <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555", minWidth: 140 }}>%</th>
                        <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555" }}>Amount</th>
                        <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555" }}>Value</th>
                        <th style={{ width: 36 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {loadingHolders ? (
                        [...Array(8)].map((_, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                            <td className="px-3 py-3 text-center"><Skeleton className="h-3.5 w-5 mx-auto" /></td>
                            <td className="px-3 py-3"><Skeleton className="h-3.5 w-28" /></td>
                            <td className="px-3 py-3"><div className="flex items-center gap-2"><Skeleton className="h-2 w-24 rounded-full" /><Skeleton className="h-3 w-10" /></div></td>
                            <td className="px-3 py-3 text-right"><Skeleton className="h-3.5 w-16 ml-auto" /></td>
                            <td className="px-3 py-3 text-right"><Skeleton className="h-3.5 w-12 ml-auto" /></td>
                            <td style={{ width: 36 }} />
                          </tr>
                        ))
                      ) : holders.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-14 text-center">
                            <div className="flex flex-col items-center gap-2">
                              <Users className="h-5 w-5" style={{ color: "#3a3a3a" }} />
                              <p className="text-[13px] font-semibold" style={{ color: "#555555" }}>No holders yet</p>
                              <p className="text-[11px]" style={{ color: "#3a3a3a" }}>Appears once the first buy is made</p>
                            </div>
                          </td>
                        </tr>
                      ) : (() => {
                        // Max balance for normalising the progress bar (top holder = 100%)
                        const maxBal = Math.max(0, parseFloat(holders[0]?.balance ?? "0") || 0);
                        return holders.map(({ address: addr, balance, txCount }, idx) => {
                          const bal    = Math.max(0, parseFloat(balance) || 0);
                          const pct    = totalSupply > 0 ? (bal / totalSupply) * 100 : 0;
                          // Bar width relative to top holder so it always fills meaningfully
                          const barW   = maxBal > 0 ? (bal / maxBal) * 100 : 0;

                          // USD value: atomic balance → tokens → SOL → USD
                          const priceSol = priceStats.currentPrice ?? 0;
                          const valUsd   = (bal / 1e6) * priceSol * (solPrice ?? 0);
                          const fmtVal   = valUsd >= 1_000_000
                            ? `$${(valUsd / 1_000_000).toFixed(2)}M`
                            : valUsd >= 1_000
                            ? `$${(valUsd / 1_000).toFixed(1)}K`
                            : valUsd >= 1
                            ? `$${valUsd.toFixed(2)}`
                            : valUsd > 0 ? `$${valUsd.toFixed(4)}` : "—";

                          const rankColor = idx === 0 ? "#f59e0b" : idx === 1 ? "#b3b3b3" : idx === 2 ? "#2dd4bf" : "#555555";
                          const barColor  = idx === 0 ? "#4ade80" : idx < 3 ? "#22d3ee" : "#3b82f6";

                          return (
                            <tr key={addr}
                              className="group"
                              style={{ borderBottom: "1px solid rgba(255,255,255,0.035)", transition: "background 0.12s" }}
                              onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                            >
                              {/* Rank */}
                              <td className="px-3 py-2.5 text-center" style={{ width: 40 }}>
                                <span className="font-mono text-[13px] font-bold" style={{ color: rankColor }}>
                                  #{idx + 1}
                                </span>
                              </td>

                              {/* Address + copy */}
                              <td className="px-3 py-2.5">
                                <button
                                  className="flex items-center gap-1.5 min-w-0 group/addr"
                                  onClick={() => copyToClipboard(addr)}
                                  title={addr}
                                >
                                  <span className="font-mono text-[13px] transition-colors group-hover/addr:text-slate-200"
                                    style={{ color: "#b3b3b3" }}>
                                    {addr.slice(0, 6)}…{addr.slice(-4)}
                                  </span>
                                </button>
                              </td>

                              {/* % with progress bar */}
                              <td className="px-3 py-2.5" style={{ minWidth: 140 }}>
                                <div className="flex items-center gap-2">
                                  {/* Bar */}
                                  <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)", maxWidth: 80 }}>
                                    <div className="h-full rounded-full transition-all duration-500"
                                      style={{ width: `${barW}%`, background: barColor, opacity: 0.85 }} />
                                  </div>
                                  {/* Percentage text */}
                                  <span className="font-mono text-[12px] font-semibold shrink-0" style={{ color: "#e0e0e0" }}>
                                    {pct.toFixed(2)}%
                                  </span>
                                </div>
                              </td>

                              {/* Amount */}
                              <td className="px-3 py-2.5 text-right">
                                <span className="font-mono text-[13px]" style={{ color: "#bbbbbb" }}>
                                  {formatAtomicTokenAmount(String(bal))}
                                </span>
                              </td>

                              {/* Value USD */}
                              <td className="px-3 py-2.5 text-right">
                                <span className="font-mono text-[13px] font-semibold" style={{ color: valUsd > 0 ? "#e0e0e0" : "#3a3a3a" }}>
                                  {fmtVal}
                                </span>
                              </td>

                              {/* Explorer link */}
                              <td className="pr-3 py-2.5 text-center" style={{ width: 36 }}>
                                <a
                                  href={`https://solscan.io/account/${addr}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="View on Solscan"
                                  className="inline-flex items-center justify-center w-7 h-7 rounded-md transition-all"
                                  style={{ background: "rgba(255,255,255,0.06)", color: "#555555" }}
                                  onMouseEnter={e => {
                                    (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.12)";
                                    (e.currentTarget as HTMLAnchorElement).style.color = "#bbbbbb";
                                  }}
                                  onMouseLeave={e => {
                                    (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.06)";
                                    (e.currentTarget as HTMLAnchorElement).style.color = "#555555";
                                  }}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Dev activity panel */}
              {activeSubTab === "dev" && (() => {
                const LAMPORTS_PER_SOL = 1e9;
                const dev = devActivityData;
                const totalBought = Math.max(0, parseFloat(dev?.totalBought ?? "0") || 0);
                const netBalance  = Math.max(0, parseFloat(dev?.netBalance  ?? "0") || 0);
                const soldAmt     = Math.max(0, totalBought - netBalance);
                const soldPct     = totalBought > 0 ? (soldAmt / totalBought) * 100 : 0;
                const solBought   = (parseFloat(dev?.totalSolBought ?? "0") || 0) / LAMPORTS_PER_SOL;
                const solSold     = (parseFloat(dev?.totalSolSold   ?? "0") || 0) / LAMPORTS_PER_SOL;
                const netSol      = solSold - solBought;
                const isSoldOut   = soldPct >= 99;
                const isDumping   = soldPct >= 50;

                return (
                  <div className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-2.5"
                      style={{ background: "rgba(255,255,255,0.025)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <div className="flex items-center gap-2 min-w-0">
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0" style={{ color: "#f87171" }} />
                        <span className="text-[14px] font-semibold whitespace-nowrap" style={{ color: "#e0e0e0" }}>Dev Activity</span>
                        <span className="text-[12px] hidden sm:inline whitespace-nowrap" style={{ color: "#555555" }}>creator wallet</span>
                      </div>
                      {!loadingDevActivity && dev?.creatorAddress && isSoldOut && (
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap shrink-0"
                          style={{ background: "rgba(248,113,113,0.15)", color: "#f87171", border: "1px solid rgba(248,113,113,0.25)" }}>
                          🚨 DEV DUMPED
                        </span>
                      )}
                      {!loadingDevActivity && dev?.creatorAddress && isDumping && !isSoldOut && (
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap shrink-0"
                          style={{ background: "rgba(251,146,60,0.15)", color: "#fb923c", border: "1px solid rgba(251,146,60,0.25)" }}>
                          ⚠️ DEV SELLING
                        </span>
                      )}
                    </div>

                    {/* Content */}
                    {loadingDevActivity ? (
                      <div className="px-4 py-6 space-y-3">
                        {[...Array(4)].map((_, i) => (
                          <div key={i} className="flex items-center justify-between">
                            <Skeleton className="h-3.5 w-28" />
                            <Skeleton className="h-3.5 w-20" />
                          </div>
                        ))}
                      </div>
                    ) : !dev?.creatorAddress ? (
                      <div className="px-4 py-14 text-center">
                        <div className="flex flex-col items-center gap-2">
                          <ShieldCheck className="h-5 w-5" style={{ color: "#3a3a3a" }} />
                          <p className="text-[13px] font-semibold" style={{ color: "#555555" }}>No creator data</p>
                          <p className="text-[11px]" style={{ color: "#3a3a3a" }}>Creator address not recorded for this token</p>
                        </div>
                      </div>
                    ) : (
                      <div className="px-4 py-4 space-y-0">
                        {/* Creator address row */}
                        <div className="flex items-center justify-between py-3"
                          style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                          <span className="text-[12px] uppercase tracking-widest font-semibold" style={{ color: "#555555" }}>Creator</span>
                          <div className="flex items-center gap-2">
                            <button
                              className="flex items-center gap-1.5 group/addr"
                              onClick={() => { navigator.clipboard.writeText(dev.creatorAddress!); }}
                              title={dev.creatorAddress}
                            >
                              <span className="font-mono text-[13px] transition-colors hover:text-slate-200" style={{ color: "#b3b3b3" }}>
                                {dev.creatorAddress.slice(0, 6)}…{dev.creatorAddress.slice(-4)}
                              </span>
                            </button>
                            <a
                              href={`https://solscan.io/account/${dev.creatorAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="View on Solscan"
                              className="inline-flex items-center justify-center w-6 h-6 rounded-md transition-all"
                              style={{ background: "rgba(255,255,255,0.06)", color: "#555555" }}
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        </div>

                        {/* SOL bought */}
                        <div className="flex items-center justify-between py-3"
                          style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                          <span className="text-[12px] uppercase tracking-wider font-semibold whitespace-nowrap" style={{ color: "#555555" }}>SOL Spent</span>
                          <span className="font-mono text-[13px]" style={{ color: "#4ade80" }}>
                            {solBought < 0.001 ? "<0.001" : solBought.toFixed(3)} SOL
                          </span>
                        </div>

                        {/* SOL sold */}
                        <div className="flex items-center justify-between py-3"
                          style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                          <span className="text-[12px] uppercase tracking-wider font-semibold whitespace-nowrap" style={{ color: "#555555" }}>SOL Received</span>
                          <span className="font-mono text-[13px]" style={{ color: solSold > 0 ? "#f87171" : "#555555" }}>
                            {solSold < 0.001 && solSold > 0 ? "<0.001" : solSold.toFixed(3)} SOL
                          </span>
                        </div>

                        {/* Net P&L */}
                        <div className="flex items-center justify-between py-3"
                          style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                          <span className="text-[12px] uppercase tracking-widest font-semibold" style={{ color: "#555555" }}>Net P&L</span>
                          <span className="font-mono text-[13px] font-bold"
                            style={{ color: netSol >= 0 ? "#4ade80" : "#f87171" }}>
                            {netSol >= 0 ? "+" : ""}{netSol.toFixed(3)} SOL
                          </span>
                        </div>

                        {/* Still holding */}
                        <div className="flex items-center justify-between py-3"
                          style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                          <span className="text-[12px] uppercase tracking-widest font-semibold" style={{ color: "#555555" }}>Still Holding</span>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[13px]" style={{ color: "#bbbbbb" }}>
                              {formatAtomicTokenAmount(String(Math.round(netBalance)))}
                            </span>
                            {isSoldOut ? (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                                style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.25)" }}>
                                SOLD OUT
                              </span>
                            ) : isDumping ? (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                                style={{ background: "rgba(251,146,60,0.12)", color: "#fb923c", border: "1px solid rgba(251,146,60,0.25)" }}>
                                {soldPct.toFixed(0)}% SOLD
                              </span>
                            ) : (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                                style={{ background: "rgba(74,222,128,0.12)", color: "#4ade80", border: "1px solid rgba(74,222,128,0.25)" }}>
                                HOLDING
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Trade counts + last sell */}
                        <div className="flex items-center justify-between py-3">
                          <span className="text-[12px] uppercase tracking-widest font-semibold" style={{ color: "#555555" }}>Trades</span>
                          <div className="flex items-center gap-3">
                            <span className="text-[12px]" style={{ color: "#4ade80" }}>
                              {dev.buyCount} buy{dev.buyCount !== 1 ? "s" : ""}
                            </span>
                            <span className="text-[12px]" style={{ color: dev.sellCount > 0 ? "#f87171" : "#555555" }}>
                              {dev.sellCount} sell{dev.sellCount !== 1 ? "s" : ""}
                            </span>
                            {dev.lastSellAt && (
                              <span className="text-[11px]" style={{ color: "#555555" }}>
                                last sell {timeAgo(new Date(dev.lastSellAt).getTime())}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Snipers panel */}
              {activeSubTab === "snipers" && (() => {
                const LAMPORTS_PER_SOL = 1e9;
                return (
                  <div className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-2.5"
                      style={{ background: "rgba(255,255,255,0.025)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <div className="flex items-center gap-2">
                        <Zap className="h-3.5 w-3.5" style={{ color: "#fbbf24" }} />
                        <span className="text-[14px] font-semibold" style={{ color: "#e0e0e0" }}>
                          {snipers.length} sniper{snipers.length !== 1 ? "s" : ""}
                        </span>
                        <span className="text-[12px] hidden sm:inline whitespace-nowrap" style={{ color: "#555555" }}>first 5 min</span>
                      </div>
                      {snipers.length > 0 && (() => {
                        const sold = snipers.filter(s => {
                          const b = parseFloat(s.totalBought) || 0;
                          const n = parseFloat(s.netBalance)  || 0;
                          return b > 0 && (b - n) / b >= 0.99;
                        }).length;
                        return sold > 0 ? (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full"
                            style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.2)" }}>
                            {sold} sold out
                          </span>
                        ) : null;
                      })()}
                    </div>

                    {/* Shared row data builder */}
                    {(() => {
                      if (loadingSnipers) return (
                        <div className="px-4 py-4 space-y-3">
                          {[...Array(5)].map((_, i) => (
                            <div key={i} className="flex items-center justify-between gap-3">
                              <div className="flex flex-col gap-1.5 flex-1">
                                <Skeleton className="h-3.5 w-32" />
                                <Skeleton className="h-3 w-48" />
                              </div>
                              <Skeleton className="h-5 w-16 rounded-full shrink-0" />
                            </div>
                          ))}
                        </div>
                      );
                      if (snipers.length === 0) return (
                        <div className="px-4 py-14 text-center flex flex-col items-center gap-2">
                          <Zap className="h-5 w-5" style={{ color: "#3a3a3a" }} />
                          <p className="text-[13px] font-semibold" style={{ color: "#555555" }}>No snipers detected</p>
                          <p className="text-[11px]" style={{ color: "#3a3a3a" }}>No buys in the first 5 minutes</p>
                        </div>
                      );

                      const rows = snipers.map((s, idx) => {
                        const totalBought = Math.max(0, parseFloat(s.totalBought) || 0);
                        const netBalance  = Math.max(0, parseFloat(s.netBalance)  || 0);
                        const soldAmt     = Math.max(0, totalBought - netBalance);
                        const soldPct     = totalBought > 0 ? (soldAmt / totalBought) * 100 : 0;
                        const isSoldOut   = soldPct >= 99;
                        const isHolding   = soldPct < 1;
                        const solSpent    = parseFloat(s.totalSolIn) / LAMPORTS_PER_SOL;
                        const sec         = s.secondsAfterLaunch;
                        const fmtSpeed    = sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
                        const speedColor  = sec <= 10 ? "#f87171" : sec <= 30 ? "#fb923c" : sec <= 60 ? "#fbbf24" : "#b3b3b3";
                        const statusEl    = isSoldOut
                          ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: "rgba(248,113,113,0.12)", color: "#f87171", border: "1px solid rgba(248,113,113,0.25)" }}>SOLD OUT</span>
                          : isHolding
                          ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: "rgba(74,222,128,0.12)", color: "#4ade80", border: "1px solid rgba(74,222,128,0.25)" }}>HOLDING</span>
                          : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.25)" }}>{soldPct.toFixed(0)}% SOLD</span>;
                        return { s, idx, fmtSpeed, speedColor, solSpent, statusEl };
                      });

                      return (
                        <>
                          {/* ── Mobile list (< sm) ── */}
                          <div className="sm:hidden">
                            {rows.map(({ s, idx, fmtSpeed, speedColor, solSpent, statusEl }) => (
                              <div key={s.address}
                                className="flex items-start justify-between gap-2 px-3 py-2.5"
                                style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                              >
                                {/* Left: rank + address + meta */}
                                <div className="flex items-start gap-2 min-w-0">
                                  <span className="font-mono text-[12px] font-bold w-7 shrink-0 pt-0.5 text-right"
                                    style={{ color: idx < 3 ? "#fbbf24" : "#555555" }}>
                                    #{idx + 1}
                                  </span>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <button onClick={() => copyToClipboard(s.address)} title={s.address}>
                                        <span className="font-mono text-[13px]" style={{ color: "#b3b3b3" }}>
                                          {s.address.slice(0, 6)}…{s.address.slice(-4)}
                                        </span>
                                      </button>
                                      <a href={`https://solscan.io/account/${s.address}`} target="_blank" rel="noopener noreferrer"
                                        className="inline-flex items-center justify-center w-5 h-5 rounded transition-all"
                                        style={{ background: "rgba(255,255,255,0.06)", color: "#555555" }}>
                                        <ExternalLink className="h-3 w-3" />
                                      </a>
                                    </div>
                                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                      <span className="font-mono text-[12px] font-bold whitespace-nowrap" style={{ color: speedColor }}>⚡ {fmtSpeed}</span>
                                      <span style={{ color: "#141414" }}>·</span>
                                      <span className="font-mono text-[12px] whitespace-nowrap" style={{ color: "#bbbbbb" }}>{solSpent < 0.001 ? "<0.001" : solSpent.toFixed(3)} SOL</span>
                                      <span style={{ color: "#141414" }}>·</span>
                                      <span className="font-mono text-[12px] whitespace-nowrap" style={{ color: "#b3b3b3" }}>{formatAtomicTokenAmount(s.totalBought)}</span>
                                    </div>
                                  </div>
                                </div>
                                {/* Right: status */}
                                <div className="shrink-0 pt-0.5">{statusEl}</div>
                              </div>
                            ))}
                          </div>

                          {/* ── Desktop table (sm+) ── */}
                          <div className="hidden sm:block overflow-x-auto">
                            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "520px" }}>
                              <thead>
                                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.02)" }}>
                                  <th className="text-center px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555", width: 40 }}>#</th>
                                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555" }}>Address</th>
                                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555" }}>Speed</th>
                                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555" }}>SOL Spent</th>
                                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555" }}>Tokens</th>
                                  <th className="text-center px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "#555555" }}>Status</th>
                                  <th style={{ width: 36 }} />
                                </tr>
                              </thead>
                              <tbody>
                                {rows.map(({ s, idx, fmtSpeed, speedColor, solSpent, statusEl }) => (
                                  <tr key={s.address} className="group"
                                    style={{ borderBottom: "1px solid rgba(255,255,255,0.035)", transition: "background 0.12s" }}
                                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                                  >
                                    <td className="px-3 py-2.5 text-center" style={{ width: 40 }}>
                                      <span className="font-mono text-[13px] font-bold" style={{ color: idx < 3 ? "#fbbf24" : "#555555" }}>#{idx + 1}</span>
                                    </td>
                                    <td className="px-3 py-2.5">
                                      <button className="flex items-center gap-1.5" onClick={() => copyToClipboard(s.address)} title={s.address}>
                                        <span className="font-mono text-[13px] hover:text-slate-200 transition-colors" style={{ color: "#b3b3b3" }}>
                                          {s.address.slice(0, 6)}…{s.address.slice(-4)}
                                        </span>
                                      </button>
                                    </td>
                                    <td className="px-3 py-2.5 text-right">
                                      <span className="font-mono text-[12px] font-bold" style={{ color: speedColor }}>⚡ {fmtSpeed}</span>
                                    </td>
                                    <td className="px-3 py-2.5 text-right">
                                      <span className="font-mono text-[13px]" style={{ color: "#bbbbbb" }}>{solSpent < 0.001 ? "<0.001" : solSpent.toFixed(3)} SOL</span>
                                    </td>
                                    <td className="px-3 py-2.5 text-right">
                                      <span className="font-mono text-[13px]" style={{ color: "#b3b3b3" }}>{formatAtomicTokenAmount(s.totalBought)}</span>
                                    </td>
                                    <td className="px-3 py-2.5 text-center">{statusEl}</td>
                                    <td className="pr-3 py-2.5 text-center" style={{ width: 36 }}>
                                      <a href={`https://solscan.io/account/${s.address}`} target="_blank" rel="noopener noreferrer"
                                        className="inline-flex items-center justify-center w-7 h-7 rounded-md transition-all"
                                        style={{ background: "rgba(255,255,255,0.06)", color: "#555555" }}
                                        onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.12)"; (e.currentTarget as HTMLAnchorElement).style.color = "#bbbbbb"; }}
                                        onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.06)"; (e.currentTarget as HTMLAnchorElement).style.color = "#555555"; }}
                                      >
                                        <ExternalLink className="h-3.5 w-3.5" />
                                      </a>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                );
              })()}
            </div>
          );
        })()}
      </div>

      {/* ── RIGHT: sticky buy panel — hidden on mobile (buy/sell is inlined below chart) ── */}
      <div className="hidden md:flex md:flex-col w-full md:w-[280px] xl:w-[300px] shrink-0 px-3 py-3 md:px-4 md:py-4 space-y-3 md:sticky md:top-[60px] md:self-start md:max-h-[calc(100dvh-60px)] md:overflow-y-auto">

        {/* Stats: Price / Vol 24h / % changes */}
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}>
          {/* Price + Vol 24h */}
          <div className="grid grid-cols-2 divide-x divide-white/[0.08]" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="flex flex-col px-4 py-3">
              <span className="text-[13px] font-medium mb-1" style={{ color: "#b3b3b3" }}>Price</span>
              <span
                key={`price-${priceFlash.key}`}
                className={`font-mono font-bold text-[15px]${priceFlash.key > 0 ? (priceFlash.up ? " animate-price-up" : " animate-price-down") : ""}`}
                style={{ color: "#e0e0e0" }}
                dangerouslySetInnerHTML={{
                  __html: priceStats.currentPrice > 0
                    ? formatTokenPrice(solPrice ? priceStats.currentPrice * solPrice : priceStats.currentPrice)
                    : "—"
                }}
              />
            </div>
            <div className="flex flex-col px-4 py-3">
              <span className="text-[13px] font-medium mb-1" style={{ color: "#b3b3b3" }}>Vol 24h</span>
              <span className="font-mono font-bold text-[15px]" style={{ color: "#e0e0e0" }}>
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
                <span className="text-[12px] font-medium mb-1" style={{ color: "#b3b3b3" }}>{label}</span>
                <span
                  key={`${label}-${data?.val ?? "null"}-${priceFlash.key}`}
                  className={`font-mono font-bold text-[13px]${data && priceFlash.key > 0 ? (data.up ? " animate-stat-up" : " animate-stat-down") : ""}`}
                  style={{ color: data ? (data.up ? "#4ade80" : "#f87171") : "#555555" }}
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
                      <span className="text-[11px] font-medium mb-0.5" style={{ color: "#b3b3b3" }}>{label}</span>
                      <span className="text-[13px] font-mono font-bold" style={{ color: "#e0e0e0" }}>{total}</span>
                    </div>
                    {/* Buy */}
                    <div className="flex flex-col items-start pl-4">
                      <span className="text-[11px] font-medium mb-0.5" style={{ color: "#b3b3b3" }}>Buy</span>
                      <span className="text-[13px] font-mono font-bold" style={{ color: "#4ade80" }}>{buy}</span>
                    </div>
                    {/* Sell — right-aligned */}
                    <div className="flex flex-col items-end">
                      <span className="text-[11px] font-medium mb-0.5" style={{ color: "#b3b3b3" }}>Sell</span>
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
            isPending={isTradePending}
            isGraduated={!!(token?.graduated || token?.platform === "pumpswap")}
            jupiterQuote={jupiterQuote}
            jupiterQuoteLoading={jupiterQuoteLoading}
            jupiterQuoteError={jupiterQuoteError}
            solBalance={solBalance}
            tokenBalance={tokenBalance}
            atomicBalance={atomicBalance}
            balanceLoading={balanceLoading}
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
  token: { symbol: string; virtualTokenReserves?: string | null; address: string };
  wallet: string | null;
  handleTrade: () => Promise<void>;
  isPending: boolean;
  /** True when the token has graduated the bonding curve and trades via Jupiter DEX routing */
  isGraduated?: boolean;
  /** Current Jupiter quote (auto-refreshed every 15 s, only present when isGraduated + amount set) */
  jupiterQuote?: JupiterQuoteResponse | null;
  jupiterQuoteLoading?: boolean;
  jupiterQuoteError?: string | null;
  /**
   * SPL token decimal places used to format Jupiter output amounts.
   * Defaults to 6 (pump.fun standard). Pass the token's actual value for
   * external / non-pump.fun tokens (e.g. 9 for SOL, 6 for USDC, etc.).
   */
  tokenDecimals?: number;
  /** Native SOL balance of the connected wallet (in SOL, not lamports). Null when not connected. */
  solBalance?: number | null;
  /**
   * SPL token balance of the connected wallet for the currently-viewed token,
   * in display units (already divided by 10^decimals). Null when not connected
   * or still fetching. Drives sell preset buttons on graduated/DEX tokens.
   */
  tokenBalance?: number | null;
  /**
   * Raw atomic token balance string (tokenAmount.amount from RPC). Used with BigInt
   * arithmetic in sell presets to guarantee the amount never exceeds actual holdings.
   */
  atomicBalance?: string | null;
  /**
   * True while the RPC fetch for the current token's balance is in flight.
   * When true the balance row shows the previous token's value dimmed, rather
   * than flashing "–".
   */
  balanceLoading?: boolean;
}

function TradePanelForm({
  tradeMode, setTradeMode, amount, setAmount, token, wallet, handleTrade, isPending,
  isGraduated, jupiterQuote, jupiterQuoteLoading, jupiterQuoteError, tokenDecimals = 6,
  solBalance, tokenBalance, atomicBalance, balanceLoading,
}: TradePanelFormProps) {
  const swapSettings = useSwapSettings();
  const solPrice = useSolPrice();

  // ── USD / SOL input currency toggle (buy mode only) ──────────────────────
  const [inputCurrency, setInputCurrency] = useState<"USD" | "SOL">("USD");
  // rawInput = what the user actually typed (in inputCurrency units)
  // parent's `amount` is always kept in SOL (buy) or token units (sell)
  const [rawInput, setRawInput] = useState("");

  // Clear rawInput whenever parent resets amount (e.g. after a successful trade)
  useEffect(() => { if (!amount) setRawInput(""); }, [amount]);
  // Reset when switching buy ↔ sell
  useEffect(() => { setRawInput(""); }, [tradeMode]);

  // parent `amount` = SOL (buy) or token-units (sell) — never raw USD
  const handleRawChange = (v: string) => {
    setRawInput(v);
    const n = parseFloat(v);
    if (!v || !isFinite(n) || n <= 0) { setAmount(""); return; }
    if (tradeMode === "sell") { setAmount(v); return; }
    if (inputCurrency === "USD") {
      // guard: if solPrice not loaded yet, leave amount empty — prevents "25 SOL" mistake
      setAmount(solPrice ? String(n / solPrice) : "");
    } else {
      setAmount(v);
    }
  };

  const handleBuyPreset = (usd: number) => {
    if (inputCurrency === "USD") {
      setRawInput(String(usd));
      setAmount(solPrice ? String(usd / solPrice) : "");
    } else {
      const sol = solPrice ? (usd / solPrice).toFixed(4) : "";
      setRawInput(sol);
      setAmount(sol);
    }
  };

  // Toggle display only — parent `amount` (SOL) stays unchanged, rawInput re-expresses it
  const toggleCurrency = () => {
    const solAmt = parseFloat(amount); // parent always holds SOL for buy
    if (inputCurrency === "USD") {
      // switch to SOL display
      setRawInput(isFinite(solAmt) && solAmt > 0 ? solAmt.toFixed(4) : "");
      setInputCurrency("SOL");
    } else {
      // switch to USD display
      setRawInput(isFinite(solAmt) && solAmt > 0 && solPrice
        ? (solAmt * solPrice).toFixed(2) : "");
      setInputCurrency("USD");
    }
    // parent `amount` (SOL) does not change on toggle — only rawInput re-displays it
  };

  // Derived from parent's SOL amount for accuracy (not rawInput)
  const equivLabel = (() => {
    if (tradeMode !== "buy") return null;
    const sol = parseFloat(amount);
    if (!isFinite(sol) || sol <= 0 || !solPrice) return null;
    return inputCurrency === "USD"
      ? `≈ ${sol.toFixed(4)} SOL`
      : `≈ ${formatUSD(sol * solPrice)}`;
  })();

  return (
    <>
      {/* Mode tabs — sliding pill */}
      <div className="relative flex border-b border-border/40 p-1 gap-1 bg-muted/30">
        <div
          className={`absolute top-1 bottom-1 w-[calc(50%-6px)] rounded-[8px] transition-all duration-250 ease-out ${tradeMode === "buy" ? "left-1 bg-[#16a34a] shadow-[0_0_12px_rgba(22,163,74,0.45)]" : "left-[calc(50%+2px)] bg-destructive shadow-[0_0_12px_hsl(0_84%_60%/0.3)]"}`}
        />
        <button
          className={`relative flex-1 py-2 text-sm font-bold transition-colors duration-150 rounded-[8px] z-10 ${tradeMode === "buy" ? "text-white" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setTradeMode("buy")}
        >Buy</button>
        <button
          className={`relative flex-1 py-2 text-sm font-bold transition-colors duration-150 rounded-[8px] z-10 ${tradeMode === "sell" ? "text-white" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setTradeMode("sell")}
        >Sell</button>
      </div>

      <div className="px-4 pt-2 pb-4 space-y-3">
        {/* Settings row */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            Slippage&nbsp;<span className="text-foreground/70 font-mono">{formatSlippage(swapSettings.slippageBps)}</span>
            <span className="mx-1 opacity-30">·</span>
            <span className="text-foreground/70 font-mono">{formatPriorityFee(swapSettings.priorityFee)}</span>
          </span>
          <SwapSettingsPopover />
        </div>

        {/* ── Main amount display — pump.fun style ─────────────────────────── */}
        <div className="flex flex-col items-center py-3 gap-1.5">
          {/* Amount row: [$] [number] [CURRENCY ≡] — baseline aligned */}
          <div className="flex items-baseline gap-1.5">
            {/* $ prefix — USD buy mode only */}
            {tradeMode === "buy" && inputCurrency === "USD" && (
              <span className={`${rawInput.length > 9 ? "text-lg" : rawInput.length > 6 ? "text-2xl" : "text-3xl"} font-medium text-muted-foreground/40 select-none`}>$</span>
            )}
            {/* Auto-sizing transparent input — font scales down as value gets longer */}
            <input
              type="number"
              inputMode="decimal"
              placeholder="0"
              className={`${rawInput.length > 9 ? "text-lg" : rawInput.length > 6 ? "text-2xl" : "text-3xl"} font-medium bg-transparent border-none outline-none text-foreground text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
              style={{ width: rawInput ? `${Math.max(1.5, rawInput.replace(".", "").length + (rawInput.includes(".") ? 0.5 : 0) + 0.3)}ch` : "1.5ch" }}
              value={rawInput}
              onChange={e => handleRawChange(e.target.value)}
            />
            {/* Currency badge — clickable toggle (buy) or static label (sell) */}
            {tradeMode === "buy" ? (
              <button
                onClick={toggleCurrency}
                className="flex items-center gap-0.5 text-[11px] font-semibold text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors pb-0.5"
                title="Switch between SOL and USD"
              >
                {inputCurrency} <ArrowRightLeft className="w-2.5 h-2.5 ml-0.5" />
              </button>
            ) : (
              <span className="flex items-center gap-0.5 text-[11px] font-semibold text-muted-foreground/50 pb-0.5">
                {token.symbol} <ArrowRightLeft className="w-2.5 h-2.5 ml-0.5" />
              </span>
            )}
          </div>
          {/* Equiv conversion hint */}
          {equivLabel && (
            <span className="text-[11px] text-muted-foreground/40 font-mono">{equivLabel}</span>
          )}
        </div>

        {/* Sell: percentage presets */}
        {tradeMode === "sell" && (
          <div className="flex gap-1.5">
            {[{ label: "25%", pct: 0.25 }, { label: "50%", pct: 0.5 }, { label: "100%", pct: 1 }].map(({ label, pct }) => (
              <button
                key={label}
                disabled={!wallet || !!balanceLoading}
                className="flex-1 py-1.5 text-xs font-semibold text-muted-foreground rounded-md bg-muted/60 border border-border/40 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed hover:enabled:bg-white/10 hover:enabled:text-foreground active:enabled:scale-95"
                onClick={() => {
                  if (atomicBalance != null && !balanceLoading) {
                    const v = computeSellPresetAmount(BigInt(atomicBalance), pct, tokenDecimals);
                    setRawInput(v); setAmount(v);
                  }
                }}
              >{label}</button>
            ))}
          </div>
        )}

        {/* Buy: dollar presets */}
        {tradeMode === "buy" && (
          <div className="flex gap-1.5">
            {[{ label: "$25", usd: 25 }, { label: "$100", usd: 100 }, { label: "$250", usd: 250 }].map(({ label, usd }) => (
              <button
                key={label}
                className="flex-1 py-1.5 text-xs font-semibold text-muted-foreground rounded-md bg-muted/60 border border-border/40 transition-all duration-150 hover:bg-white/10 hover:text-foreground active:scale-95"
                onClick={() => handleBuyPreset(usd)}
              >{label}</button>
            ))}
          </div>
        )}

        {/* Balance row */}
        {tradeMode === "buy" && wallet && solBalance !== null && solBalance !== undefined && (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Balance</span>
            <span className="font-mono">
              {solBalance.toFixed(4)} SOL
              {solPrice && <span className="opacity-50 ml-1">({formatUSD(solBalance * solPrice)})</span>}
            </span>
          </div>
        )}
        {tradeMode === "sell" && wallet && (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{token.symbol} balance</span>
            <span className={`font-mono transition-opacity duration-200 ${balanceLoading ? "opacity-40" : ""}`}>
              {tokenBalance == null
                ? "–"
                : tokenBalance === 0
                  ? "0"
                  : tokenBalance >= 1
                    ? tokenBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })
                    : tokenBalance.toPrecision(4)
              }
            </span>
          </div>
        )}

        {/* Jupiter quote preview — graduated/DEX tokens only */}
        {isGraduated && amount && parseFloat(amount) > 0 && (
          <div className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-[11px]"
            style={{ background: "rgba(139,92,246,0.07)", border: "1px solid rgba(139,92,246,0.18)" }}>
            {jupiterQuoteLoading ? (
              <span className="flex items-center gap-1.5" style={{ color: "#b3b3b3" }}>
                <span className="w-2.5 h-2.5 border border-slate-500 border-t-purple-400 rounded-full animate-spin" />
                Fetching best price…
              </span>
            ) : jupiterQuoteError ? (
              <span style={{ color: "#b3b3b3" }}>Preview unavailable — live quote fetched at trade time</span>
            ) : jupiterQuote ? (
              <>
                <span style={{ color: "#b3b3b3" }}>
                  You receive&nbsp;≈&nbsp;
                  <span className="font-semibold font-mono" style={{ color: "#e0e0e0" }}>
                    {formatJupiterOutput(jupiterQuote, tradeMode, token.symbol, tokenDecimals)}
                  </span>
                </span>
                <span className="flex items-center gap-1" style={{ color: "#a78bfa" }}>
                  <Zap className="w-2.5 h-2.5" />
                  {getRouteLabel(jupiterQuote)}
                </span>
              </>
            ) : (
              <span style={{ color: "#b3b3b3" }}>Enter an amount for price estimate</span>
            )}
          </div>
        )}

        {/* Action button */}
        {!wallet ? (
          <button
            onClick={handleTrade}
            className="w-full h-11 text-sm font-bold rounded-[8px] bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-200 active:scale-[0.98] flex items-center justify-center gap-2"
          >
            <Wallet className="h-4 w-4" />
            Connect Wallet to Trade
          </button>
        ) : !amount || parseFloat(amount) <= 0 ? (
          <button
            disabled
            className={`w-full h-11 text-sm font-bold rounded-[8px] cursor-not-allowed opacity-40 text-white ${tradeMode === "buy" ? "bg-[#16a34a]" : "bg-destructive"}`}
          >
            {tradeMode === "buy" ? "Place Buy" : "Place Sell"}
          </button>
        ) : tradeMode === "buy" && solBalance != null && solBalance < 0.002 ? (
          <button
            disabled
            className="w-full h-11 text-sm font-bold rounded-[8px] cursor-not-allowed opacity-60 text-white"
            style={{ background: "hsl(0 84% 60%)" }}
          >
            Insufficient SOL for fees
          </button>
        ) : tradeMode === "buy" && solBalance != null && parseFloat(amount) + 0.002 > solBalance ? (
          <button
            disabled
            className="w-full h-11 text-sm font-bold rounded-[8px] cursor-not-allowed opacity-60 text-white"
            style={{ background: "hsl(0 84% 60%)" }}
          >
            Insufficient SOL
          </button>
        ) : tradeMode === "sell" && (
          tokenBalance === 0 || tokenBalance == null ||
          (parseFloat(amount) > 0 && tokenBalance != null && parseFloat(amount) > tokenBalance)
        ) ? (
          <button
            disabled
            className="w-full h-11 text-sm font-bold rounded-[8px] cursor-not-allowed opacity-60 text-white"
            style={{ background: "hsl(0 84% 60%)" }}
          >
            Insufficient {token.symbol}
          </button>
        ) : (
          <Button
            className={`w-full h-11 text-sm font-bold rounded-[8px] shadow-none transition-all duration-200 active:scale-[0.98] ${tradeMode === "buy" ? "bg-[#16a34a] hover:bg-[#15803d] hover:shadow-[0_0_16px_rgba(22,163,74,0.4)] text-white" : "bg-destructive hover:bg-destructive/90 hover:shadow-[0_0_16px_hsl(0_84%_60%/0.3)] text-white"}`}
            onClick={handleTrade}
            disabled={isPending}
          >
            {isPending
              ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /></span>
              : tradeMode === "buy" ? "Place Buy" : "Place Sell"}
          </Button>
        )}
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
      decimals: number;
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
          <Users className="h-8 w-8" style={{ color: "#3a3a3a" }} />
        </div>
        <div className="text-center space-y-1">
          <p className="text-[16px] font-semibold text-foreground">Connect your wallet</p>
          <p className="text-[13px]" style={{ color: "#b3b3b3" }}>See all tokens you hold across every trade</p>
        </div>
        <button
          onClick={() => openWalletModal()}
          className="px-8 py-2.5 rounded-xl text-[14px] font-bold transition-all hover:opacity-90 active:scale-95"
          style={{
            background: "hsl(var(--primary))",
            color: "hsl(var(--primary-foreground))",
            boxShadow: "0 0 16px rgba(255,255,255,0.06)",
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
      <div className="flex flex-col items-center justify-center py-20 gap-4 animate-slideDown">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center"
          style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="#f87171"/>
          </svg>
        </div>
        <div className="text-center space-y-1">
          <p className="text-[14px] font-semibold" style={{ color: "#f87171" }}>Couldn't load your portfolio</p>
          <p className="text-[12px]" style={{ color: "#b3b3b3" }}>Check your connection and try again</p>
        </div>
        <button onClick={() => refetch()} className="px-5 py-1.5 rounded-lg text-[13px] font-semibold transition-all hover:opacity-90 active:scale-95"
          style={{ background: "rgba(248,113,113,0.10)", border: "1px solid rgba(248,113,113,0.20)", color: "#f87171" }}>
          Try again
        </button>
      </div>
    );
  }

  const holdings = holdingsData ?? [];

  // ── Empty ──
  if (holdings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-5 animate-slideDown">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
          <TrendingUp className="h-7 w-7" style={{ color: "#3a3a3a" }} />
        </div>
        <div className="text-center space-y-1.5">
          <p className="text-[15px] font-semibold text-foreground">No tokens yet</p>
          <p className="text-[13px]" style={{ color: "#b3b3b3" }}>Your portfolio is empty — find your next trade on Explore</p>
        </div>
        <a href="/" className="px-6 py-2 rounded-lg text-[13px] font-semibold transition-all hover:opacity-90 active:scale-95"
          style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)", color: "#e0e0e0" }}>
          Explore tokens
        </a>
      </div>
    );
  }

  // ── Holdings list ──
  return (
    <div className="max-w-[800px] animate-slideDown">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[16px] font-bold text-foreground">
          My Coins
          <span className="ml-2 text-[12px] font-normal px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.07)", color: "#b3b3b3" }}>
            {holdings.length}
          </span>
        </h2>
        <span className="text-[12px] font-mono" style={{ color: "#555555" }}>{formatAddress(wallet)}</span>
      </div>

      <div className="space-y-2">
        {holdings.map((token, idx) => {
          // All display math (atomic→display, SOL value, USD value) is
          // encapsulated in computeHoldingRow — the sole calculation path for
          // this component and the target of the regression test in utils.test.ts.
          // token.decimals comes from the API (tokens.decimals column, default 6).
          const { formattedTokens, valueSol, valueUsd } =
            computeHoldingRow(token.balance, token.priceEth, solPrice, token.decimals);

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
              <span className="text-[12px] w-5 text-center shrink-0 tabular-nums" style={{ color: "#555555" }}>{idx + 1}</span>

              {/* Avatar */}
              <TokenAvatar symbol={token.symbol} imageUrl={token.imageUrl ?? undefined} size={40} shape="square" />

              {/* Name + symbol */}
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                  {token.name}
                </div>
                <div className="text-[12px] font-mono mt-0.5 text-[#b3b3b3] tracking-wide">${token.symbol}</div>
              </div>

              {/* Balance */}
              <div className="text-right shrink-0">
                <div className="text-[13px] font-mono text-foreground">{formattedTokens}</div>
                <div className="text-[11px] font-mono mt-0.5" style={{ color: "#b3b3b3" }}>
                  {valueUsd != null && valueUsd > 0 ? formatUSD(valueUsd) : valueSol > 0 ? valueSol.toFixed(4) + " SOL" : "—"}
                </div>
              </div>

              {/* Arrow */}
              <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" style={{ color: "#b3b3b3" }} />
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

// ── ExternalTokenLoader ─────────────────────────────────────────────────────
// Resolves external token metadata by address and renders the trading page.
// Handles three sources in order:
//   1. Module-level cache (populated when user clicked a search result)
//   2. Client-side Jupiter strict list (handles direct URL / page reload)
//   3. Generic error state if address is not in the Jupiter list at all

function ExternalTokenLoader({ address, wallet }: { address: string | null; wallet: string | null }) {
  const [extToken, setExtToken]     = useState<ExternalSolanaToken | null>(() =>
    address ? getExternalToken(address) : null
  );
  const [notFound, setNotFound]     = useState(false);
  // Whether we're polling our API waiting for a newly-created token to be indexed
  const [indexing, setIndexing]     = useState(false);
  const [pollCount, setPollCount]   = useState(0);

  useEffect(() => {
    if (!address) { setNotFound(true); return; }
    const cached = getExternalToken(address);
    if (cached) { setExtToken(cached); return; }

    let cancelled = false;
    ensureJupiterList().then(() => {
      if (cancelled) return;
      const found = getJupiterTokenByAddress(address);
      if (found) {
        setExternalToken(found);
        setExtToken(found);
      } else {
        // Not in Jupiter strict list — might be a freshly-launched coin.
        // Poll our own API: the indexer picks up new pump.fun tokens in ~10–30 s.
        setIndexing(true);
      }
    });
    return () => { cancelled = true; };
  }, [address]);

  // Poll our API every 6 s while indexing (up to ~2 min before giving up)
  useEffect(() => {
    if (!indexing || !address) return;
    const MAX_POLLS = 20;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/tokens/${address}`, { signal: AbortSignal.timeout(5_000) });
        if (cancelled) return;
        if (res.ok) {
          // Token now in DB — reload the page so the main query picks it up
          window.location.reload();
          return;
        }
      } catch { /* network error — keep polling */ }

      if (cancelled) return;
      setPollCount(c => {
        if (c + 1 >= MAX_POLLS) { setIndexing(false); setNotFound(true); }
        return c + 1;
      });
    };

    const id = setInterval(poll, 6_000);
    poll(); // run immediately too
    return () => { cancelled = true; clearInterval(id); };
  }, [indexing, address]);

  // Loading: Jupiter list resolving
  if (!extToken && !notFound && !indexing) return (
    <div className="flex items-center justify-center w-full" style={{ minHeight: 400 }}>
      <Loader2 className="w-9 h-9 animate-spin" style={{ color: "rgba(99,102,241,0.8)" }} />
    </div>
  );

  // Indexing: token was just created, waiting for our indexer to pick it up
  if (indexing) {
    const pumpUrl    = `https://pump.fun/coin/${address}`;
    const solscanUrl = `https://solscan.io/token/${address}`;
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center px-4">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.25)" }}>
          <Rocket className="w-7 h-7" style={{ color: "#4ade80" }} />
        </div>
        <div className="space-y-1">
          <p className="font-bold text-foreground text-[16px]">Coin launched! Indexing…</p>
          <p className="text-muted-foreground text-sm max-w-xs">
            Your coin is live on-chain. This page will refresh automatically once our indexer picks it up
            (usually within 30 seconds).
          </p>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: "#4ade80" }} />
          <span className="text-[12px]" style={{ color: "#4ade80" }}>
            Checking… ({pollCount + 1}/{20})
          </span>
        </div>
        <div className="flex gap-2 flex-wrap justify-center mt-2">
          <a href={pumpUrl} target="_blank" rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors"
            style={{ background: "rgba(168,85,247,0.15)", color: "#c084fc", border: "1px solid rgba(168,85,247,0.30)" }}>
            View on Pump.fun ↗
          </a>
          <a href={solscanUrl} target="_blank" rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors"
            style={{ background: "rgba(255,255,255,0.05)", color: "#b3b3b3", border: "1px solid rgba(255,255,255,0.10)" }}>
            View on Solscan ↗
          </a>
        </div>
        <p className="text-[10px] font-mono break-all max-w-xs" style={{ color: "#555555" }}>{address}</p>
      </div>
    );
  }

  if (notFound || !extToken) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
        <span className="text-3xl">🔍</span>
        <p className="font-bold text-foreground">Coin not found</p>
        <p className="text-muted-foreground font-mono text-sm max-w-xs">
          This address is not in our platform index or the Jupiter strict token list.
        </p>
        <p className="text-[11px] font-mono text-muted-foreground/50 break-all max-w-xs">{address}</p>
      </div>
    );
  }

  return <ExternalTokenTrade token={extToken} wallet={wallet} />;
}

// ── External token trading page (for Solana tokens not in our DB) ─────────────
// Shown when a user clicks a "All Solana Tokens" result in the search dialog.
// Token data comes from the ExternalTokenLoader above.
// Trading is always routed through Jupiter (same path as graduated tokens).

interface ExternalTokenTradeProps {
  token:  ExternalSolanaToken;
  wallet: string | null;
}

function ExternalTokenTrade({ token, wallet }: ExternalTokenTradeProps) {
  const { openWalletModal, signAndSendTransaction } = useWallet();
  const { submitTx } = useTxToast();
  const { solBalance, refresh: refreshSolBalance } = useSolBalance(wallet);
  const { tokenBalance, atomicBalance, isLoading: balanceLoading, refresh: refreshTokenBalance, refreshAfterTrade: refreshTokenBalanceAfterTrade } = useTokenBalance(wallet, token.address);
  const [tradeMode, setTradeMode]           = useState<"buy" | "sell">("buy");
  const [amount, setAmount]                 = useState("");
  const [isTradePending, setIsTradePending] = useState(false);
  const [jupiterQuote, setJupiterQuote]     = useState<JupiterQuoteResponse | null>(null);
  const [jupiterQuoteLoading, setJupiterQuoteLoading] = useState(false);
  const [jupiterQuoteError, setJupiterQuoteError]     = useState<string | null>(null);
  // Live reference price: SOL per token (derived from quoting 0.1 SOL → token)
  const [refPrice, setRefPrice] = useState<number | null>(null);

  // Reference price fetch — 0.1 SOL quote gives SOL/token rate without market impact
  useEffect(() => {
    let cancelled = false;
    getJupiterQuote(WSOL_MINT, token.address, BigInt(1e8), 100)
      .then((q) => {
        if (cancelled) return;
        const divisor = Math.pow(10, token.decimals);
        const tokensOut = Number(q.outAmount) / divisor;
        const solPerToken = tokensOut > 0 ? 0.1 / tokensOut : null;
        setRefPrice(solPerToken);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token.address, token.decimals]);

  // Quote auto-fetch for the trade panel (debounced + 15 s refresh)
  useEffect(() => {
    if (!amount || parseFloat(amount) <= 0) {
      setJupiterQuote(null); setJupiterQuoteError(null); setJupiterQuoteLoading(false);
      return;
    }
    const { slippageBps } = getSwapSettings();
    const fetchQuote = async () => {
      setJupiterQuoteLoading(true); setJupiterQuoteError(null);
      try {
        const numAmount    = parseFloat(amount);
        // isFinite guard: BigInt(Math.round(Infinity * 1e9)) throws RangeError
        if (!isFinite(numAmount) || numAmount <= 0) return;
        const amtBaseUnits = tradeMode === "buy"
          ? BigInt(Math.round(numAmount * 1e9))
          : BigInt(Math.round(numAmount * Math.pow(10, token.decimals)));
        const q = await getJupiterQuote(
          tradeMode === "buy" ? WSOL_MINT : token.address,
          tradeMode === "buy" ? token.address : WSOL_MINT,
          amtBaseUnits, slippageBps,
        );
        setJupiterQuote(q);
      } catch (err) {
        setJupiterQuoteError(err instanceof Error ? err.message.slice(0, 120) : "Quote unavailable");
        setJupiterQuote(null);
      } finally { setJupiterQuoteLoading(false); }
    };
    const d = setTimeout(fetchQuote, 400);
    const r = setInterval(fetchQuote, 15_000);
    return () => { clearTimeout(d); clearInterval(r); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.address, token.decimals, amount, tradeMode]);

  const handleTrade = async () => {
    if (!wallet) { openWalletModal(); return; }
    if (!amount || parseFloat(amount) <= 0) return;
    if (isTradePending) return;

    const doTrade = async (): Promise<string> => {
      const numAmount    = parseFloat(amount);
      // isFinite guard: BigInt(Math.round(Infinity * 1e9)) throws RangeError
      if (!isFinite(numAmount) || numAmount <= 0) throw new Error("Invalid amount");
      const { slippageBps } = getSwapSettings();
      const amtBaseUnits = tradeMode === "buy"
        ? BigInt(Math.round(numAmount * 1e9))
        : BigInt(Math.round(numAmount * Math.pow(10, token.decimals)));
      const freshQuote = await getJupiterQuote(
        tradeMode === "buy" ? WSOL_MINT : token.address,
        tradeMode === "buy" ? token.address : WSOL_MINT,
        amtBaseUnits, slippageBps,
      );
      const { transaction: extTxRaw, lastValidBlockHeight } = await buildJupiterSwapTx(freshQuote, wallet);

      // Inject 1% platform fee (SOL in for buy, SOL out for sell) before signing.
      const extSolLamports = tradeMode === "buy"
        ? BigInt(freshQuote.inAmount)
        : BigInt(freshQuote.outAmount);
      const transaction = await addFeeToVersionedTx(extTxRaw, wallet, extSolLamports, getConnection());

      const txSignature = await signAndSendTransaction(transaction);

      // Optimistic release — spinner clears as soon as the broadcast succeeds.
      setAmount("");
      refreshTokenBalanceAfterTrade();
      waitForJupiterTxConfirmation(txSignature, transaction.message.recentBlockhash, lastValidBlockHeight)
        .then(() => refreshTokenBalanceAfterTrade())
        .catch(err => console.warn("[external-jupiter] bg confirmation:", err));

      return txSignature;
    };

    setIsTradePending(true);
    try {
      await submitTx(doTrade(), tradeMode === "buy" ? "Buy" : "Sell");
    } finally {
      setIsTradePending(false);
      refreshSolBalance();
      refreshTokenBalance();
    }
  };

  return (
    <div className="flex flex-col md:flex-row w-full animate-slideDown min-w-[320px] md:min-w-[680px]">

      {/* ── LEFT: token info ── */}
      <div className="flex-1 min-w-0 border-r border-border/20 px-3 md:px-5 py-4 pb-20 md:pb-6">

        {/* Header */}
        <div className="flex gap-3 items-start mb-6">
          {token.logoURI ? (
            <img src={token.logoURI} alt={token.symbol}
              className="h-14 w-14 rounded-lg object-cover shrink-0 transition-opacity duration-300"
              style={{ border: "1px solid rgba(255,255,255,0.12)", opacity: 0 }}
              onLoad={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "1"; }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <TokenAvatar symbol={token.symbol} size={56} shape="square" className="border border-border/40" />
          )}
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-foreground leading-tight truncate">{token.name}</h1>
              <span className="font-mono text-sm text-primary shrink-0">${token.symbol}</span>
            </div>
            {refPrice != null && (
              <p className="text-sm font-mono mt-1" style={{ color: "#b3b3b3" }}>
                ≈ {refPrice < 0.0001
                  ? refPrice.toExponential(3)
                  : refPrice.toFixed(6)} SOL / {token.symbol}
              </p>
            )}
          </div>
        </div>

        {/* Info notice */}
        <div className="rounded-lg px-4 py-3 text-[12px] flex items-start gap-3"
          style={{ background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.2)" }}>
          <Globe className="h-4 w-4 shrink-0 mt-0.5" style={{ color: "#a78bfa" }} />
          <div style={{ color: "#b3b3b3" }}>
            <span className="font-semibold text-foreground">{token.name}</span> is a Solana coin not launched on our
            platform. Trading routes through <span className="font-semibold" style={{ color: "#a78bfa" }}>Jupiter DEX aggregator</span> for best execution.
            Historical charts are not available for external tokens.
          </div>
        </div>

        {/* Mint address */}
        <div className="mt-4 text-[11px] font-mono text-muted-foreground/50 break-all">
          Mint: {token.address}
        </div>
      </div>

      {/* ── RIGHT: trade panel ── */}
      <div className="w-full md:w-[340px] shrink-0 pl-0 md:pl-0 md:sticky top-6 self-start">
        <div className="md:pt-4 md:px-5">
          <div className="bg-card border border-border/60 rounded-sm overflow-hidden shadow-sm">
            <TradePanelForm
              tradeMode={tradeMode}
              setTradeMode={setTradeMode}
              amount={amount}
              setAmount={setAmount}
              token={{ symbol: token.symbol, address: token.address, virtualTokenReserves: null }}
              wallet={wallet}
              handleTrade={handleTrade}
              isPending={isTradePending}
              isGraduated={true}
              jupiterQuote={jupiterQuote}
              jupiterQuoteLoading={jupiterQuoteLoading}
              jupiterQuoteError={jupiterQuoteError}
              tokenDecimals={token.decimals}
              solBalance={solBalance}
              tokenBalance={tokenBalance}
              atomicBalance={atomicBalance}
              balanceLoading={balanceLoading}
            />
          </div>
        </div>
      </div>

    </div>
  );
}
