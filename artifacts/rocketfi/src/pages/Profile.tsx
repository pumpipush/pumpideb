import { useState, useRef, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetProfile,
  useUpdateProfile,
  useListTokens,
  useGetRecentActivity,
  getGetProfileQueryKey,
  getListTokensQueryKey,
  getGetRecentActivityQueryKey,
  ListTokensSort,
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
import { TokenAvatar, tokenCardBackground } from "@/components/shared/TokenAvatar";
import { Link } from "wouter";
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
type Tab = "tokens" | "activity";

export default function ProfilePage() {
  const params = useParams<{ address: string }>();
  const address = params.address ?? "";
  const [, setLocation] = useLocation();
  const { wallet } = useWallet();
  const isOwner = wallet?.toLowerCase() === address.toLowerCase();

  const [activeTab, setActiveTab] = useState<Tab>("tokens");
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

  const tokenParams = { sort: ListTokensSort.newest, limit: 200 };
  const { data: allTokens } = useListTokens(tokenParams, {
    query: { enabled: activeTab === "tokens" && !!address, queryKey: getListTokensQueryKey(tokenParams) },
  });
  // Bug fix: guard toLowerCase() against null/undefined creatorAddress
  const tokens = allTokens?.filter(
    (t) => (t.creatorAddress ?? "").toLowerCase() === address.toLowerCase()
  );

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
    <div className="w-full max-w-3xl mx-auto pb-16 md:pb-20">

      {/* ── Back ── */}
      <button
        onClick={() => setLocation("/")}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-4 pt-4 pb-0"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Explore
      </button>

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
          <StatCard label="Tokens" value={tokens?.length ?? "—"} icon={Coins} />
          <StatCard label="Trades" value={totalTrades || "—"} icon={Activity} />
          <StatCard label="Volume" value={totalVolume > 0 ? formatSol(totalVolume.toFixed(0)) : "—"} icon={TrendingUp} />
        </div>

        {/* ── Tabs ── */}
        <div className="flex border-b border-border/50 mb-5 -mx-1">
          {(["tokens", "activity"] as Tab[]).map((tab) => (
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
              {tab === "tokens" ? `Tokens${tokens ? ` (${tokens.length})` : ""}` : "Activity"}
            </button>
          ))}
        </div>

        {/* ── Tokens tab ── */}
        {activeTab === "tokens" && (
          <div>
            {!tokens ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-36 rounded-sm" />)}
              </div>
            ) : tokens.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground text-sm border border-border/30 border-dashed rounded-sm">
                No tokens launched yet.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {tokens.map((token) => (
                  <Link
                    key={token.id}
                    href={`/app?token=${token.address}`}
                    className="group flex flex-col bg-card border border-border hover:border-primary/50 hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.25)] transition-all duration-200 rounded-sm overflow-hidden cursor-pointer"
                  >
                    <div className="aspect-square w-full overflow-hidden relative">
                      {token.imageUrl ? (
                        <img src={token.imageUrl} alt={token.symbol} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                      ) : (
                        <div
                          className="w-full h-full flex items-center justify-center text-5xl font-bold text-white/80"
                          style={{ background: tokenCardBackground(token.symbol) }}
                        >
                          {token.symbol.charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className="p-2.5">
                      <div className="font-bold text-foreground text-sm truncate">{token.name}</div>
                      <div className="flex justify-between items-center mt-0.5">
                        <span className="text-muted-foreground font-mono text-xs">${token.symbol}</span>
                        <span className="text-primary font-mono text-xs font-bold">{formatMC(token.marketCapEth)}</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

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
