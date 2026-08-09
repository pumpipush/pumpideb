import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetProfile,
  useUpdateProfile,
  useGetRecentActivity,
  getGetProfileQueryKey,
  getGetRecentActivityQueryKey,
  Profile,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { copyToClipboard } from "@/components/shared/CopyToast";
import { useWallet } from "@/contexts/WalletContext";
import { formatAddress, formatMC, formatEth, formatSol, timeAgo, cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Twitter,
  Globe,
  Copy,
  Share2,
  Edit2,
  X,
  Check,
  ArrowLeft,
  Camera,
  Coins,
  Activity,
  TrendingUp,
  ExternalLink,
  Loader2,
  Wallet,
  AlertCircle,
} from "lucide-react";

// ─── Auto-username generator (deterministic from address) ─────────────────────
const ADJECTIVES = [
  "Swift","Neon","Cyber","Lunar","Solar","Cosmic","Dark","Hyper","Turbo","Iron",
  "Laser","Void","Sonic","Alpha","Omega","Nova","Quantum","Pixel","Atomic","Prism",
  "Shadow","Blazing","Golden","Silver","Stealth","Nitro","Rapid","Apex","Ultra","Infra",
];
const NOUNS = [
  "Ape","Doge","Wolf","Fox","Bear","Eagle","Shark","Tiger","Panda","Hawk",
  "Bull","Lynx","Viper","Cobra","Raven","Drake","Sphinx","Phoenix","Dragon","Jaguar",
  "Falcon","Rhino","Manta","Bison","Badger","Gecko","Mantis","Panther","Raptor","Titan",
];

function generateUsername(address: string): string {
  // XOR first 8 + last 8 hex chars so each wallet gets a unique name
  const s1 = parseInt(address.slice(2, 10), 16) >>> 0;
  const s2 = parseInt(address.slice(-8), 16) >>> 0;
  const combined = (s1 ^ s2) >>> 0;
  const adj = ADJECTIVES[combined % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(combined / ADJECTIVES.length) % NOUNS.length];
  const num = ((s1 % 90) + (s2 % 910)); // 0–999
  return `${adj}${noun}${num}`;
}

// ─── Banner gradient from address ─────────────────────────────────────────────
function bannerGradient(address: string): string {
  const h1 = parseInt(address.slice(2, 6), 16) % 360;
  const h2 = (h1 + 140) % 360;
  return `linear-gradient(135deg, hsl(${h1},60%,18%) 0%, hsl(${h2},55%,12%) 100%)`;
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function AvatarDisplay({ profile, size = 80 }: { profile: Profile; size?: number }) {
  if (profile.avatarUrl) {
    return (
      <img
        src={profile.avatarUrl}
        alt={profile.username}
        className="rounded-full object-cover w-full h-full"
      />
    );
  }
  return (
    <TokenAvatar
      symbol={profile.username || profile.address.slice(2, 6)}
      size={size}
      shape="circle"
    />
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon: Icon }: { label: string; value: string | number; icon: React.ElementType }) {
  return (
    <div className="flex-1 flex flex-col items-center gap-1 py-4 px-2 bg-card border border-border/40 rounded-sm">
      <Icon className="w-4 h-4 text-muted-foreground mb-0.5" />
      <span className="text-lg font-bold text-foreground leading-none">{value}</span>
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function ProfileSkeleton() {
  return (
    <div className="max-w-3xl mx-auto pb-24">
      <Skeleton className="h-40 w-full" />
      <div className="px-5 -mt-12 mb-6">
        <Skeleton className="w-24 h-24 rounded-full border-4 border-background mb-4" />
        <Skeleton className="h-6 w-40 mb-2" />
        <Skeleton className="h-4 w-28 mb-4" />
        <div className="flex gap-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 flex-1 rounded-sm" />)}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
type Tab = "activity" | "wallet";

type WalletToken = {
  mint: string;
  balance: number;
  decimals: number;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  marketCapEth: string | null;
  priceSol: number | null;
  valueSol: number | null;
  inDb: boolean;
};
type WalletPortfolio = {
  solBalance: number;
  tokens: WalletToken[];
};

export default function ProfilePage() {
  const params = useParams<{ address: string }>();
  const address = params.address ?? "";
  const [, setLocation] = useLocation();
  const { wallet } = useWallet();
  const isOwner = wallet?.toLowerCase() === address.toLowerCase();

  const [activeTab, setActiveTab] = useState<Tab>("activity");

  // ── Wallet portfolio (on-chain balances) ──────────────────────────────────
  const { data: portfolio, isLoading: portfolioLoading, error: portfolioError } = useQuery<WalletPortfolio>({
    queryKey: ["wallet-portfolio", address],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/${address}/portfolio`);
      if (!res.ok) throw new Error("Failed to fetch portfolio");
      return res.json() as Promise<WalletPortfolio>;
    },
    enabled: activeTab === "wallet" && !!address,
    staleTime: 60_000,
    retry: 1,
  });
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<{
    username: string;
    bio: string;
    twitterHandle: string;
    websiteUrl: string;
    avatarUrl: string;
    avatarPreview: string;
  } | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data: profile, isLoading, refetch } = useGetProfile(address, {
    query: { enabled: !!address, retry: false, queryKey: getGetProfileQueryKey(address) },
  });

  const updateProfile = useUpdateProfile();

  const activityParams = { limit: 200 };
  const { data: allActivity } = useGetRecentActivity(activityParams, {
    query: { enabled: activeTab === "activity" && !!address, queryKey: getGetRecentActivityQueryKey(activityParams) },
  });
  // Bug fix: guard toLowerCase() against null/undefined traderAddress
  const history = allActivity?.filter(
    (a) => (a.traderAddress ?? "").toLowerCase() === address.toLowerCase()
  );

  // Derived stats
  const totalTrades = history?.length ?? 0;
  const totalVolume = history
    ? history.reduce((sum, t) => sum + (parseFloat(t.ethAmount) || 0), 0)
    : 0;

  // ── Edit helpers ──────────────────────────────────────────────────────────
  const openEdit = () => {
    if (!profile) return;
    const uname = profile.username ?? "";
    const autoName = uname.startsWith("user_")
      ? generateUsername(address)
      : uname;
    setEditForm({
      username: autoName,
      bio: profile.bio ?? "",
      twitterHandle: profile.twitterHandle ?? "",
      websiteUrl: profile.websiteUrl ?? "",
      avatarUrl: profile.avatarUrl ?? "",
      avatarPreview: profile.avatarUrl ?? "",
    });
    setEditOpen(true);
  };

  const closeEdit = () => {
    setEditOpen(false);
    setEditForm(null);
  };

  const handleAvatarFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    setAvatarUploading(true);

    // Resize + convert to base64
    const reader = new FileReader();
    reader.onerror = () => { setAvatarUploading(false); };
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => { setAvatarUploading(false); };
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const SIZE = 256;
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) { setAvatarUploading(false); return; }
        // Crop to square from center
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, SIZE, SIZE);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        setEditForm((f) => f && { ...f, avatarUrl: dataUrl, avatarPreview: dataUrl });
        setAvatarUploading(false);
      };
      img.src = e.target!.result as string;
    };
    reader.readAsDataURL(file);
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleAvatarFile(file);
    e.target.value = "";
  };

  // Bug fix: validate websiteUrl — only allow http/https to prevent javascript: XSS
  const sanitizeUrl = (url: string): string | undefined => {
    if (!url) return undefined;
    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      return parsed.toString();
    } catch {
      return undefined;
    }
  };

  const saveProfile = async () => {
    if (!editForm) return;
    try {
      await updateProfile.mutateAsync({
        address,
        data: {
          username: editForm.username || undefined,
          bio: editForm.bio || undefined,
          twitterHandle: editForm.twitterHandle.replace("@", "") || undefined,
          websiteUrl: sanitizeUrl(editForm.websiteUrl),
          avatarUrl: editForm.avatarUrl || undefined,
        },
      });
      setEditOpen(false);
      setEditForm(null);
      refetch();
      toast({ title: "Profile saved", description: "Your profile has been updated." });
    } catch (e: unknown) {
      // Profile save failed — keep modal open, show error
      const msg = e instanceof Error ? e.message : "Failed to save profile";
      toast({ title: "Save failed", description: msg, variant: "destructive" });
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (isLoading) return <ProfileSkeleton />;

  if (!profile) {
    return (
      <div className="max-w-3xl mx-auto px-4 pt-20 text-center">
        <Coins className="w-10 h-10 text-muted-foreground/30 mx-auto mb-4" />
        <p className="text-muted-foreground text-sm">Profile not found.</p>
        <p className="text-xs text-muted-foreground/60 mt-1 font-mono">{formatAddress(address)}</p>
        <Button variant="outline" size="sm" className="mt-6 rounded-sm" onClick={() => setLocation("/")}>
          Back to Explore
        </Button>
      </div>
    );
  }

  // Display username: if it looks auto-generated from old system, show a nicer one
  const displayUsername = (profile.username ?? "").startsWith("user_")
    ? generateUsername(address)
    : (profile.username ?? generateUsername(address));

  return (
    <div className="w-full max-w-3xl pb-16 md:pb-20">

      {/* ── Back ── */}
      {/* ── Banner ── */}
      <div
        className="relative mt-2 h-24 sm:h-36 w-full overflow-hidden"
        style={{ background: bannerGradient(address) }}
      >
        {/* subtle grid overlay */}
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.15) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.15) 1px,transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
      </div>

      {/* ── Avatar + header ── */}
      <div className="px-4 sm:px-6">
        <div className="flex items-end justify-between -mt-12 mb-4">
          {/* Avatar */}
          <div className="relative">
            <div className="w-24 h-24 rounded-full border-4 border-background overflow-hidden bg-card">
              <AvatarDisplay profile={{ ...profile, username: displayUsername }} size={96} />
            </div>
            {isOwner && (
              <button
                onClick={openEdit}
                className="absolute bottom-0 right-0 w-7 h-7 flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors border-2 border-background"
                title="Edit profile"
              >
                <Camera className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pb-2">
            <a
              href={`https://solscan.io/account/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="h-8 px-2.5 flex items-center gap-1.5 rounded-sm border border-border/50 bg-card hover:bg-muted transition-colors"
              title="View on Solscan"
            >
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium hidden sm:inline">Solscan</span>
            </a>
            <button
              onClick={() => copyToClipboard(window.location.href, "Link copied")}
              className="h-8 w-8 flex items-center justify-center rounded-sm border border-border/50 bg-card hover:bg-muted transition-colors"
              title="Share profile"
            >
              <Share2 className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            {isOwner && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs rounded-sm border-primary/50 text-primary hover:bg-primary/10"
                onClick={openEdit}
              >
                <Edit2 className="w-3 h-3 mr-1.5" /> Edit profile
              </Button>
            )}
          </div>
        </div>

        {/* Name + address */}
        <div className="mb-1">
          <h1 className="text-xl font-bold text-foreground leading-tight">{displayUsername}</h1>
          <button
            onClick={() => copyToClipboard(address)}
            className="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors mt-0.5"
          >
            {formatAddress(profile.address)}
            <Copy className="w-3 h-3" />
          </button>
        </div>

        {/* Bio */}
        {profile.bio && (
          <p className="text-sm text-muted-foreground leading-relaxed mb-3 max-w-xl">{profile.bio}</p>
        )}

        {/* Social links */}
        {(profile.twitterHandle || profile.websiteUrl) && (
          <div className="flex items-center gap-4 mb-4 flex-wrap">
            {profile.twitterHandle && (
              <a
                href={`https://x.com/${profile.twitterHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Twitter className="w-3.5 h-3.5" />
                @{profile.twitterHandle}
                <ExternalLink className="w-2.5 h-2.5 opacity-50" />
              </a>
            )}
            {profile.websiteUrl && /^https?:\/\//.test(profile.websiteUrl) && (
              <a
                href={profile.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Globe className="w-3.5 h-3.5" />
                Website
                <ExternalLink className="w-2.5 h-2.5 opacity-50" />
              </a>
            )}
          </div>
        )}

        {/* ── Stats row ── */}
        <div className="flex gap-2 sm:gap-3 mb-6">
          <StatCard label="Trades" value={totalTrades || "—"} icon={Activity} />
          <StatCard label="Volume" value={totalVolume > 0 ? formatSol(totalVolume.toFixed(0)) : "—"} icon={TrendingUp} />
        </div>

        {/* ── Tabs ── */}
        <div className="flex border-b border-border/50 mb-5 -mx-1">
          {(["activity", "wallet"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-5 py-3 text-sm font-medium border-b-2 capitalize transition-all duration-150",
                activeTab === tab
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab === "wallet" ? "Wallet" : "Activity"}
            </button>
          ))}
        </div>

        {/* ── Activity tab ── */}
        {activeTab === "activity" && (
          <div>
            {!history ? (
              <div className="flex flex-col gap-2">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 rounded-sm" />)}
              </div>
            ) : history.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground text-sm border border-border/30 border-dashed rounded-sm">
                No trade activity yet.
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-border/20">
                {history.map((trade) => (
                  <Link
                    key={trade.id}
                    href={`/app?token=${trade.tokenAddress}`}
                    className="flex items-center justify-between py-3 hover:bg-white/[0.02] transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "text-[10px] font-bold uppercase px-2 py-1 rounded-sm min-w-[40px] text-center",
                          trade.isBuy
                            ? "bg-primary/15 text-primary"
                            : "bg-destructive/15 text-destructive"
                        )}
                      >
                        {trade.isBuy ? "BUY" : "SELL"}
                      </span>
                      <div>
                        <div className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                          {trade.tokenSymbol ?? "???"}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {formatEth(trade.ethAmount)} ETH
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground font-mono tabular-nums">
                      {timeAgo(String(trade.timestamp))}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Wallet tab ── */}
        {activeTab === "wallet" && (() => {
          // derive totals
          const tokenTotalSol = portfolio?.tokens.reduce((s, t) => s + (t.valueSol ?? 0), 0) ?? 0;
          const totalSol = (portfolio?.solBalance ?? 0) + tokenTotalSol;

          // top holding: highest value item (SOL or a token)
          const solEntry = portfolio ? { symbol: "SOL", valueSol: portfolio.solBalance, pct: totalSol > 0 ? portfolio.solBalance / totalSol * 100 : 100 } : null;
          const topToken = portfolio?.tokens[0];
          const topHolding = topToken && topToken.valueSol !== null && topToken.valueSol > (portfolio?.solBalance ?? 0)
            ? { symbol: topToken.symbol ?? topToken.mint.slice(0, 4), valueSol: topToken.valueSol, pct: totalSol > 0 ? topToken.valueSol / totalSol * 100 : 0 }
            : solEntry;

          return (
            <div>
              {/* ── Loading state ── */}
              {portfolioLoading && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 rounded-sm" />)}
                  </div>
                  <Skeleton className="h-64 rounded-sm" />
                </div>
              )}

              {/* ── Error state ── */}
              {portfolioError && !portfolioLoading && (
                <div className="py-16 flex flex-col items-center gap-3 text-center border border-border/30 border-dashed rounded-sm">
                  <AlertCircle className="w-8 h-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">Could not load wallet data. RPC may be rate-limited.</p>
                </div>
              )}

              {/* ── Data ── */}
              {portfolio && !portfolioLoading && (
                <>
                  {/* Stats row */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
                    <div className="bg-card border border-border/50 rounded-sm p-4">
                      <p className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium mb-1">Total Value</p>
                      <p className="text-lg font-bold text-foreground font-mono">{totalSol.toFixed(4)} SOL</p>
                    </div>
                    <div className="bg-card border border-border/50 rounded-sm p-4">
                      <p className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium mb-1">Top Holding</p>
                      <p className="text-lg font-bold text-foreground">{topHolding?.symbol ?? "—"}</p>
                      {topHolding && totalSol > 0 && (
                        <p className="text-xs text-muted-foreground font-mono">{topHolding.pct.toFixed(1)}% of wallet</p>
                      )}
                    </div>
                    <div className="bg-card border border-border/50 rounded-sm p-4 col-span-2 sm:col-span-1">
                      <p className="text-[11px] text-muted-foreground uppercase tracking-wide font-medium mb-1">Tokens Held</p>
                      <p className="text-lg font-bold text-foreground">{portfolio.tokens.length}</p>
                      <p className="text-xs text-muted-foreground">SPL tokens</p>
                    </div>
                  </div>

                  {/* Balances table */}
                  <div className="border border-border/50 rounded-sm overflow-hidden">
                    <div className="bg-muted/30 px-4 py-2.5 border-b border-border/40">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Balances</p>
                    </div>

                    {/* Header */}
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-2 border-b border-border/20 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wide">
                      <span>Coin</span>
                      <span className="text-right w-24">Balance</span>
                      <span className="text-right w-24">Value (SOL)</span>
                      <span className="text-right w-24">Market Cap</span>
                    </div>

                    {/* SOL row */}
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-3 border-b border-border/10 items-center hover:bg-white/[0.02] transition-colors">
                      <div className="flex items-center gap-3 min-w-0">
                        <img
                          src="https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png"
                          alt="SOL"
                          className="w-8 h-8 rounded-full shrink-0 object-cover"
                          onError={(e) => {
                            const t = e.currentTarget;
                            t.style.display = "none";
                            const next = t.nextElementSibling as HTMLElement | null;
                            if (next) next.style.display = "flex";
                          }}
                        />
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195] items-center justify-center shrink-0 hidden">
                          <span className="text-[10px] font-bold text-white">SOL</span>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">Solana</p>
                          <p className="text-xs text-muted-foreground font-mono">SOL</p>
                        </div>
                      </div>
                      <span className="text-sm font-mono text-right w-24">{portfolio.solBalance.toFixed(4)}</span>
                      <span className="text-sm font-mono text-right w-24">{portfolio.solBalance.toFixed(4)}</span>
                      <span className="text-sm font-mono text-right w-24 text-muted-foreground">—</span>
                    </div>

                    {/* Token rows */}
                    {portfolio.tokens.length === 0 && (
                      <div className="py-10 text-center text-sm text-muted-foreground">No SPL token holdings found.</div>
                    )}
                    {portfolio.tokens.map((token) => (
                      <div
                        key={token.mint}
                        className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-3 border-b border-border/10 last:border-0 items-center hover:bg-white/[0.02] transition-colors cursor-pointer"
                        onClick={() => token.inDb && setLocation(`/app?token=${token.mint}`)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {token.imageUrl ? (
                            <img
                              src={token.imageUrl}
                              alt={token.symbol ?? ""}
                              className="w-8 h-8 rounded-full object-cover shrink-0"
                              onError={(e) => {
                                const t = e.currentTarget;
                                t.style.display = "none";
                                const next = t.nextElementSibling as HTMLElement | null;
                                if (next) next.style.display = "flex";
                              }}
                            />
                          ) : null}
                          <div className={`shrink-0 ${token.imageUrl ? "hidden" : ""}`}>
                            <TokenAvatar symbol={token.symbol ?? token.mint.slice(0, 4)} size={32} shape="circle" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-foreground truncate">{token.name ?? "Unknown Token"}</p>
                            <p className="text-xs text-muted-foreground font-mono truncate">{token.symbol ?? token.mint.slice(0, 8) + "…"}</p>
                          </div>
                        </div>
                        <span className="text-sm font-mono text-right w-24 tabular-nums">
                          {token.balance >= 1_000_000 ? `${(token.balance / 1_000_000).toFixed(2)}M`
                            : token.balance >= 1_000 ? `${(token.balance / 1_000).toFixed(2)}K`
                            : token.balance.toFixed(2)}
                        </span>
                        <span className="text-sm font-mono text-right w-24 tabular-nums">
                          {token.valueSol !== null ? token.valueSol.toFixed(4) : <span className="text-muted-foreground">—</span>}
                        </span>
                        <span className="text-sm font-mono text-right w-24 tabular-nums">
                          {token.marketCapEth ? formatSol((BigInt(token.marketCapEth) / BigInt(1e9)).toString()) : <span className="text-muted-foreground">—</span>}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Solscan link */}
                  <div className="mt-3 flex justify-end">
                    <a
                      href={`https://solscan.io/account/${address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ExternalLink className="w-3 h-3" />
                      View full history on Solscan
                    </a>
                  </div>
                </>
              )}
            </div>
          );
        })()}
      </div>

      {/* ══ Edit Profile Modal ══════════════════════════════════════════════════ */}
      {editOpen && editForm && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={(e) => e.target === e.currentTarget && closeEdit()}
        >
          {/* backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeEdit} />

          <div className="relative w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-sm shadow-2xl p-5 sm:p-6 z-10 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-foreground">Edit Profile</h2>
              <button onClick={closeEdit} className="text-muted-foreground hover:text-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ── Avatar upload ── */}
            <div className="flex items-center gap-4 mb-6">
              <div className="relative w-20 h-20 rounded-full overflow-hidden border-2 border-border bg-muted shrink-0">
                {editForm.avatarPreview ? (
                  <img src={editForm.avatarPreview} alt="avatar" className="w-full h-full object-cover" />
                ) : (
                  <TokenAvatar symbol={editForm.username || address.slice(2, 6)} size={80} shape="circle" />
                )}
                {avatarUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2 className="w-5 h-5 animate-spin text-white" />
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-sm h-8 text-xs"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={avatarUploading}
                >
                  <Camera className="w-3.5 h-3.5 mr-1.5" />
                  {editForm.avatarPreview ? "Change photo" : "Upload photo"}
                </Button>
                {editForm.avatarPreview && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors text-left"
                    onClick={() => setEditForm((f) => f && { ...f, avatarUrl: "", avatarPreview: "" })}
                  >
                    Remove photo
                  </button>
                )}
                <p className="text-[10px] text-muted-foreground leading-tight">
                  JPG, PNG, GIF — max 2 MB
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileInput}
              />
            </div>

            {/* ── Username ── */}
            <div className="space-y-1 mb-4">
              <label className="text-xs font-medium text-muted-foreground">Username</label>
              <Input
                value={editForm.username}
                onChange={(e) => setEditForm((f) => f && { ...f, username: e.target.value })}
                className="h-9 text-sm rounded-sm bg-background border-border/50"
                placeholder={generateUsername(address)}
                maxLength={32}
              />
              <p className="text-[10px] text-muted-foreground">
                Auto-generated: <span className="text-foreground/60">{generateUsername(address)}</span>
              </p>
            </div>

            {/* ── Bio ── */}
            <div className="space-y-1 mb-4">
              <label className="text-xs font-medium text-muted-foreground">Bio</label>
              <Textarea
                value={editForm.bio}
                onChange={(e) => setEditForm((f) => f && { ...f, bio: e.target.value })}
                className="text-sm rounded-sm bg-background border-border/50 resize-none"
                placeholder="Tell the community about yourself..."
                rows={3}
                maxLength={200}
              />
              <p className="text-[10px] text-muted-foreground text-right">{editForm.bio.length}/200</p>
            </div>

            {/* ── Social ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Twitter className="w-3 h-3" /> X / Twitter
                </label>
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">@</span>
                  <Input
                    value={editForm.twitterHandle}
                    onChange={(e) => setEditForm((f) => f && { ...f, twitterHandle: e.target.value.replace("@", "") })}
                    className="h-9 text-sm rounded-sm bg-background border-border/50 pl-7"
                    placeholder="username"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Globe className="w-3 h-3" /> Website
                </label>
                <Input
                  value={editForm.websiteUrl}
                  onChange={(e) => setEditForm((f) => f && { ...f, websiteUrl: e.target.value })}
                  className="h-9 text-sm rounded-sm bg-background border-border/50"
                  placeholder="https://..."
                />
              </div>
            </div>

            {/* ── Actions ── */}
            <div className="flex items-center gap-2">
              <Button
                className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-sm font-bold h-9 px-6 flex-1 sm:flex-none"
                onClick={saveProfile}
                disabled={updateProfile.isPending || avatarUploading}
              >
                {updateProfile.isPending ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Saving…</>
                ) : (
                  <><Check className="w-3.5 h-3.5 mr-1.5" /> Save changes</>
                )}
              </Button>
              <Button
                variant="ghost"
                className="rounded-sm h-9 text-muted-foreground hover:text-foreground"
                onClick={closeEdit}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
