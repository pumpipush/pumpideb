import { useState, useEffect, useRef, useCallback } from "react";
import { SEO } from "@/components/seo/SEO";
import {
  useGetProfile,
  getGetProfileQueryKey,
  Profile,
  useGetFollowStatus,
  getGetFollowStatusQueryKey,
  followProfile,
  unfollowProfile,
  getGetFollowersQueryKey,
  getGetFollowingQueryKey,
} from "@workspace/api-client-react";
import { ProfileEditModal } from "@/components/shared/ProfileEditModal";
import { AddEmailModal } from "@/components/shared/AddEmailModal";
import { FollowListModal } from "@/components/shared/FollowListModal";
import { generateUsername } from "@/lib/username";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { copyToClipboard } from "@/components/shared/CopyToast";
import { useWallet } from "@/contexts/WalletContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  formatAddress, formatSol, timeAgo, cn, diceBearUrl,
  resolveImageUrl, formatAtomicTokenAmount, formatMCUsd,
} from "@/lib/utils";
import { useSolPrice } from "@/hooks/useSolPrice";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation, useSearch } from "wouter";
import {
  Globe, Copy, Share2, Edit2, Camera, Coins,
  ExternalLink, AlertCircle,
  TrendingUp, TrendingDown, Wallet, Activity, Gift, Loader2,
  UserPlus, UserMinus,
} from "lucide-react";
import { useTxToast } from "@/hooks/useTxToast";
import { fetchClaimableLamports, buildCollectCreatorFeeTx } from "@/lib/pumpfun-creator-fees";

// Base58 encode for wallet signature (mirrors ProfileEditModal helper)
const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes: Uint8Array): string {
  let result = "", leading = 0;
  for (const b of bytes) { if (b === 0) leading++; else break; }
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return "1".repeat(leading) + digits.reverse().map(d => BASE58_CHARS[d]).join("");
}

const XIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.91-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>
);

// ─── Color helpers ────────────────────────────────────────────────────────────
function accentHue(address: string): number {
  let h = 0;
  for (let i = 0; i < Math.min(address.length, 8); i++) {
    h = (h * 31 + address.charCodeAt(i)) & 0xffff;
  }
  return h % 360;
}
function accentColor(address: string, l = 55) {
  return `hsl(${accentHue(address)},72%,${l}%)`;
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function AvatarDisplay({ profile }: { profile: Profile }) {
  const src = profile.avatarUrl || diceBearUrl(profile.address);
  return (
    <img
      src={src}
      alt={profile.username ?? profile.address}
      className="rounded-full object-cover w-full h-full"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────
type Tab = "activity" | "wallet" | "creator-fee";

type CreatedToken = {
  address:      string;
  name:         string;
  symbol:       string;
  imageUrl:     string | null;
  marketCapEth: string | null;
  tradeCount:   string | null;
  platform:     string;
  graduated:    boolean;
};

type ActivityTrade = {
  id: number;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenImageUrl: string | null;
  traderAddress: string;
  isBuy: boolean;
  ethAmount: string;
  tokenAmount: string;
  txHash: string;
  timestamp: string;
};

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

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function ProfileSkeleton() {
  return (
    <div className="max-w-2xl mx-auto pb-24">
      <Skeleton className="h-44 w-full rounded-none" />
      <div className="px-5 -mt-14 mb-6">
        <Skeleton className="w-28 h-28 rounded-full border-4 border-background mb-5" />
        <Skeleton className="h-7 w-44 mb-2" />
        <Skeleton className="h-4 w-28 mb-5" />
        <div className="flex gap-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 flex-1 rounded-xl" />)}
        </div>
      </div>
    </div>
  );
}

// ─── Stat chip ────────────────────────────────────────────────────────────────
function StatChip({
  label, value, sub, color,
}: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-3 px-3 min-w-0 relative">
      <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60 mb-1.5 font-medium">
        {label}
      </span>
      <span
        className="text-lg font-bold tabular-nums leading-none tracking-tight"
        style={{ color: color ?? "var(--foreground)" }}
      >
        {value}
      </span>
      {sub && (
        <span className="text-[11px] font-medium tabular-nums mt-0.5" style={{ color: color ?? "#b3b3b3" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? "";
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const { wallet, openWalletModal, signMessage, signAndSendTransaction } = useWallet();
  const { socialUser, unlinkWallet, getWalletLinkChallenge, linkWallet, mergeWallet, refreshSocialUser } = useAuth();
  const { toast } = useToast();
  const solPrice = useSolPrice();

  const looksLikeAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(slug);
  const editUsernameParam = new URLSearchParams(searchString).get("editUsername") === "1";

  const [activeTab, setActiveTab] = useState<Tab>("activity");
  const [editOpen, setEditOpen] = useState(false);
  const [addEmailOpen, setAddEmailOpen] = useState(false);
  const [claimLoading, setClaimLoading] = useState(false);
  const [unlinkLoading, setUnlinkLoading] = useState(false);
  const [linkingWallet, setLinkingWallet] = useState(false);
  const [mergeNonce, setMergeNonce] = useState<string | null>(null);
  const [mergingAccounts, setMergingAccounts] = useState(false);
  const [followModalOpen, setFollowModalOpen] = useState(false);
  const [followModalMode, setFollowModalMode] = useState<"followers" | "following">("followers");
  const [followLoading, setFollowLoading] = useState(false);
  // Optimistic follow state — null means "not yet loaded"
  const [localIsFollowing, setLocalIsFollowing] = useState<boolean | null>(null);
  const [localFollowersCount, setLocalFollowersCount] = useState<number | null>(null);
  const qc = useQueryClient();
  // Set to true when user clicks "Connect wallet" from the social-no-wallet CTA,
  // so we auto-run the link flow the moment the wallet extension connects.
  const pendingLinkRef = useRef(false);
  const { submitTx } = useTxToast();

  const { data: profile, isLoading, refetch } = useGetProfile(slug, {
    query: { enabled: !!slug, retry: false, queryKey: getGetProfileQueryKey(slug) },
  });

  // ── Viewer identity (derived from wallet/social; does NOT depend on profile) ──
  const IS_SOLANA_EARLY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const viewerAddress: string | null =
    socialUser?.address ?? (wallet && IS_SOLANA_EARLY.test(wallet) ? wallet : null);

  // ── Follow status ─────────────────────────────────────────────────────────
  // Fetch whether viewerAddress already follows this profile.
  const profileAddress = profile?.address ?? "";
  const followStatusEnabled = !!profileAddress && !!viewerAddress && profileAddress !== viewerAddress;
  const { data: followStatusData } = useGetFollowStatus(
    profileAddress,
    viewerAddress ?? "",
    {
      query: {
        enabled: followStatusEnabled,
        queryKey: getGetFollowStatusQueryKey(profileAddress, viewerAddress ?? ""),
      },
    },
  );
  // Sync server state into local optimistic state (only on first load)
  useEffect(() => {
    if (followStatusData !== undefined && localIsFollowing === null) {
      setLocalIsFollowing(followStatusData.isFollowing);
    }
  }, [followStatusData, localIsFollowing]);
  useEffect(() => {
    if (profile?.followersCount !== undefined && localFollowersCount === null) {
      setLocalFollowersCount(profile.followersCount);
    }
  }, [profile?.followersCount, localFollowersCount]);

  // ── Canonical URL redirect ────────────────────────────────────────────────
  // If the URL uses a wallet address or UUID instead of the profile username,
  // silently replace it so the browser always shows /profile/<username>.
  // This covers: direct navigation after wallet login, NudgeBanner links, etc.
  useEffect(() => {
    const username = profile?.username;
    if (!username || username === slug) return;
    // Preserve query params (e.g. ?editUsername=1)
    const qs = searchString ? `?${searchString}` : "";
    setLocation(`/profile/${username}${qs}`, { replace: true });
  }, [profile?.username, slug, searchString, setLocation]);

  const address = profile?.address ?? (looksLikeAddress ? slug : "");

  // Only valid Solana base58 addresses should link to Solscan.
  // Social (Google/email) users have an internal address — use their linkedWallet instead.
  // IS_SOLANA_EARLY was declared above (before hooks); alias it here for readability.
  const IS_SOLANA = IS_SOLANA_EARLY;
  const solanaAddress: string | null =
    IS_SOLANA.test(address) ? address
    : (socialUser?.linkedWallet && IS_SOLANA.test(socialUser.linkedWallet)) ? socialUser.linkedWallet
    : null;

  // Build the Authorization header to send with follow/unfollow requests.
  // Social users: Bearer JWT (from localStorage); wallet users: Wallet <address>.
  function getFollowAuthHeader(): string | null {
    const jwt = typeof window !== "undefined" ? localStorage.getItem("pumpi_auth_token") : null;
    if (jwt) return `Bearer ${jwt}`;
    if (wallet && IS_SOLANA.test(wallet)) return `Wallet ${wallet}`;
    return null;
  }

  const isOwner =
    (!!wallet && !!address && wallet.toLowerCase() === address.toLowerCase()) ||
    (!!socialUser && !!address && (
      socialUser.address === address ||
      (!!socialUser.linkedWallet && socialUser.linkedWallet.toLowerCase() === address.toLowerCase())
    ));

  // ── Seamless wallet link flow ─────────────────────────────────────────────
  // Called either directly (wallet already connected) or auto-triggered by
  // the useEffect below after the extension finishes connecting.
  const doWalletLink = useCallback(async (walletAddr: string) => {
    setLinkingWallet(true);
    try {
      const { message: challengeMsg } = await getWalletLinkChallenge(walletAddr);
      const msgBytes = new TextEncoder().encode(challengeMsg);
      const sigRaw = await signMessage(msgBytes);
      if (!(sigRaw instanceof Uint8Array) || sigRaw.length !== 64) {
        throw new Error("Wallet returned an invalid signature — please try again");
      }
      const signature = bs58Encode(sigRaw);
      const result = await linkWallet(walletAddr, signature, challengeMsg);
      if (result?.mergeNonce) {
        // Wallet already has its own account — surface a merge confirmation.
        setMergeNonce(result.mergeNonce);
        return; // don't clear linkingWallet yet — button stays loading until merge dialog shows
      }
      await refreshSocialUser();
      toast({ title: "Wallet linked", description: "Your wallet is now connected to your profile.", variant: "success" as never });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to link wallet";
      toast({ title: "Link failed", description: msg, variant: "destructive" });
    } finally {
      setLinkingWallet(false);
      pendingLinkRef.current = false;
    }
  }, [getWalletLinkChallenge, signMessage, linkWallet, refreshSocialUser, toast]);

  // When the user clicked "Connect wallet" but had no extension connected yet,
  // we set pendingLinkRef and open the wallet modal. As soon as the wallet
  // address lands in state, fire the link automatically — no second click needed.
  const prevWalletRef = useRef<string | null>(null);
  useEffect(() => {
    const hadWallet = prevWalletRef.current;
    prevWalletRef.current = wallet;
    if (!pendingLinkRef.current) return;
    if (!wallet || wallet === hadWallet) return;       // no new wallet
    if (socialUser?.linkedWallet === wallet) return;   // already linked
    void doWalletLink(wallet);
  }, [wallet, socialUser?.linkedWallet, doWalletLink]);

  // Called when user confirms the merge dialog.
  const handleMergeAccounts = useCallback(async () => {
    if (!mergeNonce) return;
    setMergingAccounts(true);
    try {
      await mergeWallet(mergeNonce);
      await refreshSocialUser();
      setMergeNonce(null);
      toast({ title: "Accounts merged", description: "Your wallet is now linked to your profile.", variant: "success" as never });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Merge failed";
      toast({ title: "Merge failed", description: msg, variant: "destructive" });
    } finally {
      setMergingAccounts(false);
    }
  }, [mergeNonce, mergeWallet, refreshSocialUser, toast]);

  // Shortcut used by both CTA buttons: connect first if needed, then link.
  const handleConnectAndLink = useCallback(() => {
    if (wallet) {
      // Wallet already connected — link immediately
      void doWalletLink(wallet);
    } else {
      // Open wallet picker; the effect above will finish the job
      pendingLinkRef.current = true;
      openWalletModal();
    }
  }, [wallet, doWalletLink, openWalletModal]);

  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!editUsernameParam || !isOwner || autoOpenedRef.current || isLoading) return;
    autoOpenedRef.current = true;
    setEditOpen(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editUsernameParam, isOwner, isLoading]);

  const { data: portfolio, isLoading: portfolioLoading, error: portfolioError } = useQuery<WalletPortfolio>({
    queryKey: ["wallet-portfolio", solanaAddress],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/${solanaAddress}/portfolio`);
      if (!res.ok) throw new Error("Failed to fetch portfolio");
      return res.json() as Promise<WalletPortfolio>;
    },
    // Only fetch for valid Solana addresses — UUIDs from social auth will 500
    enabled: !!solanaAddress,
    staleTime: 20_000,
    refetchOnWindowFocus: true,
    refetchInterval: activeTab === "wallet" ? 30_000 : false,
    retry: 1,
  });

  const { data: history } = useQuery<ActivityTrade[]>({
    queryKey: ["wallet-activity", address],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/${address}/activity?limit=100`);
      if (!res.ok) return [];
      return res.json() as Promise<ActivityTrade[]>;
    },
    // Activity is the default tab — prefetch immediately so it's ready on first render
    enabled: !!address,
    staleTime: 20_000,
    refetchInterval: activeTab === "activity" ? 30_000 : false,
  });

  // ── Creator fee balance (owner only) ─────────────────────────────────────
  const { data: claimableLamports = 0n, refetch: refetchFees } = useQuery<bigint>({
    queryKey: ["creator-fees", address],
    queryFn: () => fetchClaimableLamports(address),
    enabled: isOwner && !!address,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: isOwner ? 60_000 : false,
  });

  // ── Tokens created by this address ───────────────────────────────────────
  const { data: createdTokens, isLoading: createdLoading } = useQuery<CreatedToken[]>({
    queryKey: ["created-tokens", address],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/${address}/created-tokens`);
      if (!res.ok) return [];
      return res.json() as Promise<CreatedToken[]>;
    },
    enabled: activeTab === "creator-fee" && !!address,
    staleTime: 60_000,
    refetchInterval: activeTab === "creator-fee" ? 60_000 : false,
  });

  const handleClaimFees = async () => {
    if (!wallet || claimLoading) return;
    setClaimLoading(true);
    try {
      await submitTx(
        (async () => {
          const { transaction } = await buildCollectCreatorFeeTx(wallet);
          return signAndSendTransaction(transaction);
        })(),
        "Claim Creator Fees",
      );
      // Refresh balance after a few seconds so the user sees the updated amount
      setTimeout(() => { void refetchFees(); }, 4_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Claim failed";
      toast({ title: "Claim failed", description: msg, variant: "destructive" });
    } finally {
      setClaimLoading(false);
    }
  };

  const handleFollow = async () => {
    const authHeader = getFollowAuthHeader();
    if (!authHeader || !profileAddress || followLoading) return;

    const wasFollowing = localIsFollowing ?? false;
    // Optimistic update
    setLocalIsFollowing(!wasFollowing);
    setLocalFollowersCount((prev) =>
      prev === null ? null : wasFollowing ? Math.max(0, prev - 1) : prev + 1,
    );
    setFollowLoading(true);

    try {
      const result = wasFollowing
        ? await unfollowProfile(profileAddress, authHeader)
        : await followProfile(profileAddress, authHeader);

      // Sync server-confirmed count
      setLocalFollowersCount(result.followersCount);
      setLocalIsFollowing(result.isFollowing);

      // Invalidate profile + follow-list caches
      void qc.invalidateQueries({ queryKey: getGetProfileQueryKey(slug) });
      void qc.invalidateQueries({ queryKey: getGetFollowersQueryKey(profileAddress) });
      void qc.invalidateQueries({ queryKey: getGetFollowingQueryKey(profileAddress) });
    } catch (e) {
      // Revert optimistic update
      setLocalIsFollowing(wasFollowing);
      setLocalFollowersCount((prev) =>
        prev === null ? null : wasFollowing ? prev + 1 : Math.max(0, prev - 1),
      );
      const msg = e instanceof Error ? e.message : "Failed";
      toast({ title: wasFollowing ? "Unfollow failed" : "Follow failed", description: msg, variant: "destructive" });
    } finally {
      setFollowLoading(false);
    }
  };

  const handleUnlinkWallet = async () => {
    if (unlinkLoading) return;
    setUnlinkLoading(true);
    try {
      await unlinkWallet();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to unlink wallet";
      toast({ title: "Unlink failed", description: msg, variant: "destructive" });
    } finally {
      setUnlinkLoading(false);
    }
  };

  const historyArr = Array.isArray(history) ? history : [];
  const totalTrades = historyArr.length;
  const totalVolumeLamports = historyArr.reduce((s, t) => s + (parseFloat(t.ethAmount) || 0), 0);
  const realizedPnlLamports: number | null = history != null
    ? historyArr.reduce((s, t) => {
        const lam = parseFloat(t.ethAmount) || 0;
        return s + (t.isBuy ? -lam : lam);
      }, 0)
    : null;

  const hue = address ? accentHue(address) : 220;

  if (isLoading) return <ProfileSkeleton />;

  // ── Not found ──────────────────────────────────────────────────────────────
  if (!profile && !isOwner) {
    return (
      <div className="max-w-lg mx-auto px-4 pt-24 flex flex-col items-center gap-5 text-center">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <Coins className="w-9 h-9 text-muted-foreground/40" />
        </div>
        <div className="space-y-1.5">
          <p className="text-lg font-semibold">Wallet not found</p>
          <p className="text-sm text-muted-foreground">This address hasn't set up a profile yet.</p>
          <p className="text-xs font-mono text-muted-foreground/50 mt-1">{formatAddress(address)}</p>
        </div>
        <Button variant="outline" size="sm" className="rounded-lg" onClick={() => setLocation("/")}>
          Back to Explore
        </Button>
      </div>
    );
  }

  const displayUsername = profile
    ? ((profile.username ?? "").startsWith("user_")
        ? generateUsername(address)
        : (profile.username ?? generateUsername(address)))
    : generateUsername(address);

  const seoUsername = profile?.username ?? `Wallet ${formatAddress(address)}`;

  return (
    <div className="w-full max-w-2xl mx-auto pb-20">
      <SEO
        title={`@${seoUsername}`}
        description={`View ${seoUsername}'s token launches, trades, and Solana portfolio on Pumpi.`}
        url={typeof window !== "undefined" ? window.location.href : undefined}
      />

      {/* ── Owner empty-state ── */}
      {!profile && isOwner && (
        <div className="max-w-sm mx-auto px-4 pt-16 flex flex-col items-center text-center gap-5">
          <div
            className="w-28 h-28 rounded-full overflow-hidden"
            style={{
              padding: 3,
              background: `linear-gradient(135deg, hsl(${hue},72%,55%), hsl(${(hue+140)%360},72%,55%))`,
            }}
          >
            <div className="w-full h-full rounded-full overflow-hidden bg-background">
              <img src={diceBearUrl(address)} alt="" className="w-full h-full object-cover" style={{ imageRendering: "pixelated" }} />
            </div>
          </div>
          <div>
            <h2 className="text-xl font-bold">{displayUsername}</h2>
            {solanaAddress && (
              <p className="text-xs font-mono text-muted-foreground mt-1">{formatAddress(solanaAddress)}</p>
            )}
          </div>
          <p className="text-sm text-muted-foreground max-w-xs">
            Your profile isn't set up yet. Add a username and bio so the community knows who you are.
          </p>
          <Button className="rounded-lg px-6" onClick={() => setEditOpen(true)}>
            <Edit2 className="w-3.5 h-3.5 mr-2" /> Set up profile
          </Button>
        </div>
      )}

      {/* ── Full profile ── */}
      {profile && (
        <>
          {/* ══ BANNER ══════════════════════════════════════════════════════════ */}
          <div
            className="relative h-40 sm:h-52 w-full overflow-hidden"
            style={{
              background: `linear-gradient(135deg,
                hsl(${hue},65%,12%) 0%,
                hsl(${(hue+60)%360},55%,10%) 40%,
                hsl(${(hue+180)%360},50%,8%) 100%)`,
            }}
          >
            {/* large orb left */}
            <div
              className="absolute -left-16 -top-16 w-72 h-72 rounded-full blur-3xl opacity-30"
              style={{ background: `radial-gradient(circle, hsl(${hue},80%,55%) 0%, transparent 70%)` }}
            />
            {/* medium orb right */}
            <div
              className="absolute right-0 bottom-0 w-48 h-48 rounded-full blur-2xl opacity-20"
              style={{ background: `radial-gradient(circle, hsl(${(hue+180)%360},70%,55%) 0%, transparent 70%)` }}
            />
            {/* dot grid */}
            <div
              className="absolute inset-0 opacity-[0.06]"
              style={{
                backgroundImage: "radial-gradient(circle, rgba(255,255,255,.9) 1px, transparent 1px)",
                backgroundSize: "24px 24px",
              }}
            />
            {/* bottom fade */}
            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
          </div>

          {/* ══ AVATAR + ACTIONS ════════════════════════════════════════════════ */}
          <div className="px-4 sm:px-6">
            <div className="flex items-end justify-between -mt-14 mb-5">
              {/* Avatar with gradient ring */}
              <div className="relative">
                <div
                  className="rounded-full p-[3px] shrink-0"
                  style={{
                    background: `linear-gradient(135deg, hsl(${hue},72%,60%), hsl(${(hue+140)%360},72%,55%))`,
                    boxShadow: `0 0 28px hsl(${hue},70%,40%,0.5)`,
                  }}
                >
                  <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-full overflow-hidden border-4 border-background bg-card">
                    <AvatarDisplay profile={{ ...profile, username: displayUsername }} />
                  </div>
                </div>
                {isOwner && (
                  <button
                    onClick={() => setEditOpen(true)}
                    className="absolute bottom-1 right-1 w-7 h-7 flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors border-2 border-background shadow-lg"
                    title="Edit profile"
                  >
                    <Camera className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 pb-1">
                {solanaAddress && (
                  <a
                    href={`https://solscan.io/account/${solanaAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-8 px-3 flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] transition-colors text-xs text-muted-foreground font-medium"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Solscan</span>
                  </a>
                )}
                <button
                  onClick={() => copyToClipboard(window.location.href, "Link copied")}
                  className="h-8 w-8 flex items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] transition-colors text-muted-foreground"
                  title="Share profile"
                >
                  <Share2 className="w-3.5 h-3.5" />
                </button>
                {/* Follow button — visible to non-owners who have a wallet or social account */}
                {!isOwner && (wallet || socialUser) && profileAddress && (
                  <button
                    onClick={() => void handleFollow()}
                    disabled={followLoading || (!wallet && !socialUser)}
                    className={cn(
                      "h-8 px-3 flex items-center gap-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50",
                      localIsFollowing
                        ? "border border-white/20 text-muted-foreground hover:border-red-500/40 hover:text-red-400"
                        : "bg-primary text-primary-foreground hover:bg-primary/90",
                    )}
                  >
                    {followLoading
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : localIsFollowing
                        ? <><UserMinus className="w-3.5 h-3.5" /><span className="hidden sm:inline">Following</span></>
                        : <><UserPlus className="w-3.5 h-3.5" /><span className="hidden sm:inline">Follow</span></>
                    }
                  </button>
                )}
                {isOwner && (
                  <button
                    onClick={() => setEditOpen(true)}
                    className="h-8 px-3 flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] transition-colors text-xs text-muted-foreground font-medium"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Edit profile</span>
                  </button>
                )}
              </div>
            </div>

            {/* ══ IDENTITY ═══════════════════════════════════════════════════════ */}
            <div className="mb-4">
              <div className="flex items-center gap-2.5 flex-wrap mb-1">
                <h1 className="text-2xl font-bold tracking-tight">{displayUsername}</h1>
              </div>
              {/* Wallet address copy — only for valid Solana addresses, never for internal UUIDs */}
              {solanaAddress && (
                <button
                  onClick={() => copyToClipboard(solanaAddress)}
                  className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors group mb-2"
                >
                  {formatAddress(solanaAddress)}
                  <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
              {/* Followers / Following — inline text links (Twitter-style) */}
              <div className="flex items-center gap-4 mt-1">
                <button
                  onClick={() => { setFollowModalMode("followers"); setFollowModalOpen(true); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="font-bold text-foreground">
                    {localFollowersCount ?? profile?.followersCount ?? 0}
                  </span>
                  {" "}
                  <span>Followers</span>
                </button>
                <button
                  onClick={() => { setFollowModalMode("following"); setFollowModalOpen(true); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="font-bold text-foreground">
                    {profile?.followingCount ?? 0}
                  </span>
                  {" "}
                  <span>Following</span>
                </button>
              </div>
            </div>

            {/* Bio */}
            {profile.bio && (
              <p className="text-sm text-muted-foreground leading-relaxed mb-3 max-w-lg">{profile.bio}</p>
            )}

            {/* Social links */}
            {(profile.twitterHandle || profile.websiteUrl) && (
              <div className="flex items-center gap-4 mb-5 flex-wrap">
                {profile.twitterHandle && (
                  <a
                    href={`https://x.com/${profile.twitterHandle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                    @{profile.twitterHandle}
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
                    <ExternalLink className="w-2.5 h-2.5 opacity-40" />
                  </a>
                )}
              </div>
            )}

            {/* ══ STATS BAR ═══════════════════════════════════════════════════════ */}
            <div
              className="flex divide-x mb-7 rounded-xl overflow-hidden"
              style={{
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)",
                backdropFilter: "blur(12px)",
              }}
            >
              <StatChip
                label="Trades"
                value={totalTrades || "—"}
              />
              <StatChip
                label="Volume"
                value={totalVolumeLamports > 0 ? formatSol(totalVolumeLamports.toFixed(0)) : "—"}
                sub={totalVolumeLamports > 0 && solPrice
                  ? `$${((totalVolumeLamports / 1e9) * solPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                  : undefined}
              />
              {realizedPnlLamports !== null && (
                <div className="flex-1 flex flex-col items-center justify-center py-3 px-3 min-w-0">
                  <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60 mb-1.5 font-medium">
                    Realized PNL
                  </span>
                  <div className="flex items-center gap-1">
                    {realizedPnlLamports > 0
                      ? <TrendingUp className="w-4 h-4" style={{ color: "#22c55e" }} />
                      : realizedPnlLamports < 0
                        ? <TrendingDown className="w-4 h-4" style={{ color: "#ef4444" }} />
                        : null}
                    <span
                      className="text-lg font-bold tabular-nums leading-none tracking-tight"
                      style={{
                        color: realizedPnlLamports > 0 ? "#22c55e"
                          : realizedPnlLamports < 0 ? "#ef4444"
                          : undefined,
                      }}
                    >
                      {realizedPnlLamports > 0 ? "+" : ""}
                      {formatSol(realizedPnlLamports.toFixed(0))}
                    </span>
                  </div>
                  {solPrice && (
                    <span
                      className="text-[11px] font-medium tabular-nums mt-0.5"
                      style={{
                        color: realizedPnlLamports > 0 ? "#16a34a"
                          : realizedPnlLamports < 0 ? "#dc2626"
                          : "#b3b3b3",
                      }}
                    >
                      {realizedPnlLamports > 0 ? "+" : ""}
                      ${((realizedPnlLamports / 1e9) * solPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Creator fee badge — quick hint to switch to the tab */}
            {isOwner && claimableLamports > 1_000_000n && activeTab !== "creator-fee" && (
              <button
                onClick={() => setActiveTab("creator-fee")}
                className="flex items-center gap-2 px-3 py-2 rounded-xl mb-5 w-full text-left transition-opacity hover:opacity-80"
                style={{ background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.2)" }}
              >
                <Gift className="w-3.5 h-3.5 shrink-0" style={{ color: "#22c55e" }} />
                <span className="text-xs font-semibold" style={{ color: "#22c55e" }}>
                  {formatSol(String(claimableLamports))} in creator fees available
                </span>
                <span className="text-xs text-muted-foreground ml-auto">View →</span>
              </button>
            )}

            {/* ══ LINKED WALLET (social users only) ════════════════════════════════ */}
            {isOwner && socialUser && socialUser.authType !== "wallet" && (
              <div
                className="flex items-center gap-3 px-4 py-3.5 rounded-xl mb-5"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <Wallet className="w-4 h-4 shrink-0 text-muted-foreground/50" />
                <div className="min-w-0 flex-1">
                  {socialUser.linkedWallet ? (
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium mb-0.5">
                          Connected wallet
                        </p>
                        <button
                          onClick={() => copyToClipboard(socialUser.linkedWallet!, "Address copied")}
                          className="inline-flex items-center gap-1.5 text-xs font-mono text-foreground/80 hover:text-foreground transition-colors group"
                        >
                          {formatAddress(socialUser.linkedWallet)}
                          <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      </div>
                      <button
                        onClick={() => void handleUnlinkWallet()}
                        disabled={unlinkLoading}
                        className="shrink-0 text-xs text-muted-foreground/40 hover:text-red-400 transition-colors disabled:opacity-40"
                      >
                        {unlinkLoading ? "Unlinking…" : "Unlink"}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium mb-0.5">
                          Connected wallet
                        </p>
                        <p className="text-xs text-muted-foreground/40">No wallet linked</p>
                      </div>
                      <button
                        onClick={handleConnectAndLink}
                        disabled={linkingWallet}
                        className="shrink-0 text-xs font-medium text-primary/80 hover:text-primary transition-colors disabled:opacity-50"
                      >
                        {linkingWallet ? "Linking…" : wallet ? "Link wallet →" : "Connect wallet →"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ══ TABS ═════════════════════════════════════════════════════════════ */}
            <div
              className="flex gap-1 p-1 mb-6 rounded-xl overflow-x-auto scrollbar-none"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              {(["activity", "wallet", ...(isOwner ? ["creator-fee"] : [])] as Tab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    "flex shrink-0 items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all duration-200",
                    activeTab === tab
                      ? "bg-white/[0.08] text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab === "activity" && <Activity className="w-3.5 h-3.5" />}
                  {tab === "wallet"   && <Wallet   className="w-3.5 h-3.5" />}
                  {tab === "creator-fee" && (
                    <span className="relative">
                      <Gift className="w-3.5 h-3.5" />
                      {claimableLamports > 1_000_000n && (
                        <span
                          className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full"
                          style={{ background: "#22c55e" }}
                        />
                      )}
                    </span>
                  )}
                  {tab === "activity" ? "Activity" : tab === "wallet" ? "Wallet" : "Creator Fees"}
                </button>
              ))}
            </div>

            {/* ══ ACTIVITY TAB ═════════════════════════════════════════════════════ */}
            {activeTab === "activity" && (
              <div>
                {!history ? (
                  <div className="flex flex-col gap-2.5">
                    {[...Array(6)].map((_, i) => (
                      <Skeleton key={i} className="h-16 rounded-xl" />
                    ))}
                  </div>
                ) : historyArr.length === 0 ? (
                  <div
                    className="py-20 flex flex-col items-center gap-3 text-center rounded-xl"
                    style={{ background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.08)" }}
                  >
                    <Activity className="w-8 h-8 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">No trade activity yet</p>
                  </div>
                ) : (
                  <div
                    className="rounded-xl overflow-hidden"
                    style={{ border: "1px solid rgba(255,255,255,0.07)" }}
                  >
                    {historyArr.map((trade, idx) => {
                      const solAmt  = parseFloat(trade.ethAmount) / 1e9;
                      const usdAmt  = solPrice && solAmt ? solAmt * solPrice : null;
                      const tokAmt  = formatAtomicTokenAmount(trade.tokenAmount, 6);
                      const sign    = trade.isBuy ? "+" : "−";
                      const imgSrc  = resolveImageUrl(trade.tokenImageUrl);
                      const sym     = trade.tokenSymbol || trade.tokenName || "?";

                      return (
                        <div
                          key={trade.id}
                          className="flex items-center gap-3 px-4 py-3.5 hover:bg-white/[0.025] transition-colors"
                          style={{
                            borderBottom: idx < history.length - 1
                              ? "1px solid rgba(255,255,255,0.05)"
                              : undefined,
                          }}
                        >
                          {/* Token image */}
                          <Link href={`/coin/${trade.tokenAddress}`} className="shrink-0">
                            {imgSrc ? (
                              <img
                                src={imgSrc}
                                alt={sym}
                                className="w-10 h-10 rounded-full object-cover"
                                style={{ border: "1px solid rgba(255,255,255,0.1)" }}
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                              />
                            ) : (
                              <div
                                className="w-10 h-10 rounded-full flex items-center justify-center text-[11px] font-bold text-muted-foreground"
                                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
                              >
                                {sym.slice(0, 2).toUpperCase()}
                              </div>
                            )}
                          </Link>

                          {/* Coin name + SOL amount */}
                          <Link href={`/coin/${trade.tokenAddress}`} className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold truncate">{sym}</span>
                              <span
                                className={cn(
                                  "text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-md shrink-0",
                                  trade.isBuy
                                    ? "bg-emerald-500/15 text-emerald-400"
                                    : "bg-red-500/15 text-red-400"
                                )}
                              >
                                {trade.isBuy ? "BUY" : "SELL"}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground/60 mt-0.5 font-mono">
                              {formatSol(trade.ethAmount)}
                            </div>
                          </Link>

                          {/* Token amount + USD */}
                          <div className="text-right shrink-0">
                            <div className={cn(
                              "text-sm font-semibold tabular-nums",
                              trade.isBuy ? "text-emerald-400" : "text-red-400"
                            )}>
                              {sign}{tokAmt} <span className="text-xs opacity-70">{sym}</span>
                            </div>
                            <div className="text-xs text-muted-foreground/60 tabular-nums mt-0.5">
                              {usdAmt != null
                                ? `$${usdAmt < 0.01 ? usdAmt.toFixed(4) : usdAmt.toFixed(2)}`
                                : "—"}
                            </div>
                          </div>

                          {/* Time + Solscan */}
                          <div className="shrink-0 pl-3 flex flex-col items-end gap-1.5">
                            <span className="text-xs text-muted-foreground/50 tabular-nums whitespace-nowrap">
                              {timeAgo(String(trade.timestamp))}
                            </span>
                            {trade.txHash && (
                              <a
                                href={`https://solscan.io/tx/${trade.txHash}`}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors"
                                title="View on Solscan"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ══ WALLET TAB ═══════════════════════════════════════════════════════ */}
            {activeTab === "wallet" && (() => {
              const portfolioTokens = Array.isArray(portfolio?.tokens) ? portfolio!.tokens : [];
              const tokenTotalSol = portfolioTokens.reduce((s, t) => s + (t.valueSol ?? 0), 0);
              const totalSol = (portfolio?.solBalance ?? 0) + tokenTotalSol;
              const topToken = portfolioTokens[0];
              const solEntry = portfolio
                ? { symbol: "SOL", valueSol: portfolio.solBalance, pct: totalSol > 0 ? portfolio.solBalance / totalSol * 100 : 100 }
                : null;
              const topHolding =
                topToken && topToken.valueSol !== null && topToken.valueSol > (portfolio?.solBalance ?? 0)
                  ? { symbol: topToken.symbol ?? topToken.mint.slice(0, 4), valueSol: topToken.valueSol, pct: totalSol > 0 ? topToken.valueSol / totalSol * 100 : 0 }
                  : solEntry;

              // ── Social user on their own profile with no linked wallet ──────────
              // Show a helpful CTA rather than a confusing error/empty state.
              // Wallet-auth users: their address IS their wallet — no "link wallet" CTA needed.
              // Only show the CTA for social (Google/email) users who haven't linked a wallet yet.
              const isSocialNoWallet = isOwner && !!socialUser
                && socialUser.authType !== "wallet"
                && !socialUser.linkedWallet;

              return (
                <div className="space-y-4">

                  {/* Social user without linked wallet — CTA */}
                  {isSocialNoWallet && (
                    <div
                      className="py-14 flex flex-col items-center gap-4 text-center rounded-xl"
                      style={{ background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.08)" }}
                    >
                      <div
                        className="w-14 h-14 rounded-full flex items-center justify-center"
                        style={{ background: "rgba(255,255,255,0.05)" }}
                      >
                        <Wallet className="w-6 h-6 text-muted-foreground/50" />
                      </div>
                      <div className="space-y-1.5 max-w-xs">
                        <p className="text-sm font-semibold text-foreground">No wallet linked</p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Link a Solana wallet to your account to view your token holdings, SOL balance, and portfolio value.
                        </p>
                      </div>
                      <div className="flex flex-col sm:flex-row items-center gap-2 mt-1">
                        <Button
                          size="sm"
                          className="rounded-lg h-9 px-5 text-sm font-semibold"
                          disabled={linkingWallet}
                          onClick={handleConnectAndLink}
                        >
                          {linkingWallet
                            ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Linking…</>
                            : <><Wallet className="w-3.5 h-3.5 mr-1.5" />{wallet ? "Link Wallet" : "Connect Wallet"}</>
                          }
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="rounded-lg h-9 px-4 text-sm text-muted-foreground hover:text-foreground"
                          onClick={() => setEditOpen(true)}
                        >
                          <Edit2 className="w-3.5 h-3.5 mr-1.5" />
                          Edit profile to link
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Loading */}
                  {!isSocialNoWallet && portfolioLoading && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-3 gap-3">
                        {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
                      </div>
                      <Skeleton className="h-64 rounded-xl" />
                    </div>
                  )}

                  {/* Error */}
                  {!isSocialNoWallet && portfolioError && !portfolioLoading && (
                    <div
                      className="py-16 flex flex-col items-center gap-3 text-center rounded-xl"
                      style={{ background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.08)" }}
                    >
                      <AlertCircle className="w-8 h-8 text-muted-foreground/30" />
                      <p className="text-sm text-muted-foreground">Could not load wallet data. RPC may be rate-limited.</p>
                    </div>
                  )}

                  {/* Data */}
                  {!isSocialNoWallet && portfolio && !portfolioLoading && (
                    <>
                      {/* Summary cards */}
                      <div className="grid grid-cols-3 gap-3">
                        {/* Total Value */}
                        <div
                          className="rounded-xl p-4"
                          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
                        >
                          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-medium mb-2">Total Value</p>
                          <p className="text-lg font-bold tabular-nums leading-tight">{totalSol.toFixed(3)}</p>
                          <p className="text-xs text-muted-foreground/60 font-mono mt-0.5">
                            {solPrice ? `$${(totalSol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "SOL"}
                          </p>
                        </div>
                        {/* Top Holding */}
                        <div
                          className="rounded-xl p-4"
                          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
                        >
                          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-medium mb-2">Top Holding</p>
                          <p className="text-lg font-bold truncate">{topHolding?.symbol ?? "—"}</p>
                          {topHolding && totalSol > 0 && (
                            <div className="mt-1.5">
                              <div
                                className="h-1 rounded-full overflow-hidden"
                                style={{ background: "rgba(255,255,255,0.08)" }}
                              >
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${Math.min(topHolding.pct, 100)}%`,
                                    background: `hsl(${hue},65%,55%)`,
                                  }}
                                />
                              </div>
                              <p className="text-xs text-muted-foreground/60 mt-1">{topHolding.pct.toFixed(1)}%</p>
                            </div>
                          )}
                        </div>
                        {/* Tokens */}
                        <div
                          className="rounded-xl p-4"
                          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
                        >
                          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-medium mb-2">Tokens Held</p>
                          <p className="text-lg font-bold">{portfolioTokens.length}</p>
                          <p className="text-xs text-muted-foreground/60 mt-0.5">SPL tokens</p>
                        </div>
                      </div>

                      {/* Holdings table */}
                      <div
                        className="rounded-xl overflow-hidden"
                        style={{ border: "1px solid rgba(255,255,255,0.07)" }}
                      >
                        {/* Header */}
                        <div
                          className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-3"
                          style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
                        >
                          {["Coin", "Balance", "Value", "Mkt Cap"].map((h, i) => (
                            <span
                              key={h}
                              className={cn(
                                "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50",
                                i > 0 ? "text-right w-20 sm:w-24" : "",
                              )}
                            >
                              {h}
                            </span>
                          ))}
                        </div>

                        {/* SOL row */}
                        <div
                          className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-3.5 items-center hover:bg-white/[0.02] transition-colors"
                          style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <img
                              src="https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png"
                              alt="SOL"
                              className="w-8 h-8 rounded-full shrink-0"
                            />
                            <div className="min-w-0">
                              <p className="text-sm font-semibold">Solana</p>
                              <p className="text-xs text-muted-foreground/60 font-mono">SOL</p>
                            </div>
                          </div>
                          <span className="text-sm font-mono text-right w-20 sm:w-24 tabular-nums">
                            {portfolio.solBalance.toFixed(4)}
                          </span>
                          <span className="text-sm font-mono text-right w-20 sm:w-24 tabular-nums">
                            {portfolio.solBalance.toFixed(4)}
                            {solPrice && (
                              <span className="block text-xs text-muted-foreground/50">
                                ${(portfolio.solBalance * solPrice).toFixed(2)}
                              </span>
                            )}
                          </span>
                          <span className="text-sm text-right w-20 sm:w-24 text-muted-foreground/40">—</span>
                        </div>

                        {/* Token rows */}
                        {portfolioTokens.length === 0 && (
                          <div className="py-10 text-center text-sm text-muted-foreground/50">
                            No SPL token holdings found.
                          </div>
                        )}
                        {portfolioTokens.map((token, idx) => (
                          <div
                            key={token.mint}
                            className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-3.5 items-center hover:bg-white/[0.02] transition-colors cursor-pointer"
                            style={{
                              borderBottom: idx < portfolioTokens.length - 1
                                ? "1px solid rgba(255,255,255,0.04)"
                                : undefined,
                            }}
                            onClick={() => token.inDb && setLocation(`/coin/${token.mint}`)}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              {token.imageUrl ? (
                                <img
                                  src={token.imageUrl}
                                  alt={token.symbol ?? ""}
                                  className="w-8 h-8 rounded-full object-cover shrink-0"
                                  onError={(e) => {
                                    (e.currentTarget as HTMLImageElement).style.display = "none";
                                  }}
                                />
                              ) : (
                                <TokenAvatar symbol={token.symbol ?? token.mint.slice(0, 4)} size={32} shape="circle" />
                              )}
                              <div className="min-w-0">
                                {/* Name: if null/garbage, show short mint */}
                                <p className="text-sm font-semibold truncate">
                                  {token.name && token.name.length < 40
                                    ? token.name
                                    : `${token.mint.slice(0, 6)}…${token.mint.slice(-4)}`}
                                </p>
                                {/* Symbol: if null or looks like junk (??), show dash */}
                                <p className="text-xs text-muted-foreground/60 font-mono truncate">
                                  {token.symbol && !/^[?!*]+$/.test(token.symbol)
                                    ? token.symbol
                                    : <span className="text-muted-foreground/30 font-sans">Unknown</span>}
                                </p>
                              </div>
                            </div>
                            <span className="text-sm font-mono text-right w-20 sm:w-24 tabular-nums">
                              {token.balance >= 1_000_000
                                ? `${(token.balance / 1_000_000).toFixed(2)}M`
                                : token.balance >= 1_000
                                  ? `${(token.balance / 1_000).toFixed(2)}K`
                                  : token.balance.toFixed(2)}
                            </span>
                            <span className="text-sm font-mono text-right w-20 sm:w-24 tabular-nums">
                              {token.valueSol !== null ? (
                                <>
                                  {token.valueSol.toFixed(4)}
                                  {solPrice && (
                                    <span className="block text-xs text-muted-foreground/50">
                                      ${(token.valueSol * solPrice).toFixed(2)}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="text-muted-foreground/40">—</span>
                              )}
                            </span>
                            <span className="text-sm font-mono text-right w-20 sm:w-24 tabular-nums">
                              {formatMCUsd(token.marketCapEth, solPrice)}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* Solscan link — only shown when a valid Solana address is available */}
                      {solanaAddress && (
                        <div className="flex justify-end pt-1">
                          <a
                            href={`https://solscan.io/account/${solanaAddress}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                          >
                            <ExternalLink className="w-3 h-3" />
                            View on Solscan
                          </a>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* ══ CREATOR FEES TAB ═════════════════════════════════════════════ */}
            {activeTab === "creator-fee" && (
              <div className="space-y-5">
                {/* Balance card */}
                <div
                  className="rounded-xl p-5"
                  style={{ background: "rgba(34,197,94,0.05)", border: "1px solid rgba(34,197,94,0.18)" }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-muted-foreground/60 font-medium mb-2">Claimable balance</p>
                      {claimableLamports > 0n ? (
                        <>
                          <p className="text-3xl font-bold tabular-nums" style={{ color: "#22c55e" }}>
                            {formatSol(String(claimableLamports))}
                          </p>
                          {solPrice && (
                            <p className="text-sm text-muted-foreground mt-1">
                              ≈ ${((Number(claimableLamports) / 1e9) * solPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })} USD
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-2xl font-bold text-muted-foreground/40">0 SOL</p>
                      )}
                      <p className="text-xs text-muted-foreground/50 mt-2">
                        pump.fun creator vault — 1% fee from every trade on tokens you created
                      </p>
                    </div>
                    {claimableLamports > 1_000_000n && (
                      <button
                        onClick={() => void handleClaimFees()}
                        disabled={claimLoading}
                        className="flex items-center gap-2 px-4 h-10 rounded-xl text-sm font-semibold shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ background: "rgba(34,197,94,0.18)", color: "#22c55e" }}
                      >
                        {claimLoading
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Gift className="w-4 h-4" />}
                        {claimLoading ? "Claiming…" : "Claim All"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Created tokens list */}
                <div>
                  <p className="text-xs uppercase tracking-widest text-muted-foreground/60 font-medium mb-3">
                    Tokens created
                  </p>

                  {createdLoading && (
                    <div className="space-y-2">
                      {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}
                    </div>
                  )}

                  {!createdLoading && (!createdTokens || createdTokens.length === 0) && (
                    <div
                      className="py-14 flex flex-col items-center gap-3 text-center rounded-xl"
                      style={{ background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.08)" }}
                    >
                      <Gift className="w-8 h-8 text-muted-foreground/20" />
                      <p className="text-sm text-muted-foreground">No tokens created yet</p>
                      <p className="text-xs text-muted-foreground/50">Tokens you launch on pump.fun appear here</p>
                    </div>
                  )}

                  {!createdLoading && createdTokens && createdTokens.length > 0 && (
                    <div
                      className="rounded-xl overflow-hidden"
                      style={{ border: "1px solid rgba(255,255,255,0.07)" }}
                    >
                      {/* Header */}
                      <div
                        className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-3 text-[10px] uppercase tracking-wider font-medium text-muted-foreground/50"
                        style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
                      >
                        <span>Token</span>
                        <span className="w-16 text-right">Trades</span>
                        <span className="w-20 text-right">Mkt Cap</span>
                        <span className="w-20 text-right">Status</span>
                      </div>

                      {createdTokens.map((token, idx) => (
                        <div
                          key={token.address}
                          className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-3 items-center cursor-pointer hover:bg-white/[0.02] transition-colors"
                          style={{ borderBottom: idx < createdTokens.length - 1 ? "1px solid rgba(255,255,255,0.04)" : undefined }}
                          onClick={() => setLocation(`/coin/${token.address}`)}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            {token.imageUrl ? (
                              <img
                                src={resolveImageUrl(token.imageUrl) ?? token.imageUrl}
                                alt={token.symbol}
                                className="w-8 h-8 rounded-full object-cover shrink-0"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                              />
                            ) : (
                              <TokenAvatar symbol={token.symbol} size={32} shape="circle" />
                            )}
                            <div className="min-w-0">
                              <p className="text-sm font-semibold truncate">{token.name}</p>
                              <p className="text-xs text-muted-foreground/60 font-mono">{token.symbol}</p>
                            </div>
                          </div>
                          <span className="text-sm font-mono text-right w-16 tabular-nums text-muted-foreground">
                            {token.tradeCount ? Number(token.tradeCount).toLocaleString() : "0"}
                          </span>
                          <span className="text-sm font-mono text-right w-20 tabular-nums">
                            {formatMCUsd(token.marketCapEth, solPrice)}
                          </span>
                          <span className="w-20 text-right">
                            {token.graduated ? (
                              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(139,92,246,0.15)", color: "#a78bfa" }}>
                                Grad
                              </span>
                            ) : (
                              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(34,197,94,0.10)", color: "#4ade80" }}>
                                Live
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        </>
      )}

      <AddEmailModal open={addEmailOpen} onClose={() => setAddEmailOpen(false)} />

      {/* ── Merge accounts confirmation dialog ── */}
      {mergeNonce && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6"
            style={{ background: "#111", border: "1px solid rgba(255,255,255,0.1)" }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: "rgba(154,237,44,0.1)" }}
              >
                <Wallet className="w-5 h-5" style={{ color: "#9aed2c" }} />
              </div>
              <div>
                <p className="text-sm font-bold text-white">Wallet has its own account</p>
                <p className="text-xs text-muted-foreground">Merge to link it here</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed mb-5">
              This wallet already has a separate Pumpi account. Merging will link the wallet to your current Google account — your trade history will stay intact.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => void handleMergeAccounts()}
                disabled={mergingAccounts}
                className="flex-1 h-9 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                style={{ background: "#9aed2c", color: "#000" }}
              >
                {mergingAccounts
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Merging…</>
                  : "Merge accounts"}
              </button>
              <button
                onClick={() => { setMergeNonce(null); setLinkingWallet(false); }}
                disabled={mergingAccounts}
                className="h-9 px-4 rounded-lg text-sm text-muted-foreground hover:text-foreground transition-colors border border-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <ProfileEditModal
        open={editOpen}
        onOpenChange={setEditOpen}
        focusUsername={editUsernameParam}
        onSaved={(newUsername) => {
          if (newUsername && newUsername !== slug) {
            setLocation(`/profile/${newUsername}`);
          } else {
            refetch();
          }
        }}
      />

      {/* Follow list modal */}
      {profile && (
        <FollowListModal
          open={followModalOpen}
          onOpenChange={setFollowModalOpen}
          mode={followModalMode}
          address={profile.address}
          viewerAddress={viewerAddress ?? undefined}
          authHeader={getFollowAuthHeader() ?? undefined}
        />
      )}
    </div>
  );
}
