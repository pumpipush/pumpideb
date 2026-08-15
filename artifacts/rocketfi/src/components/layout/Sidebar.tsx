import { Link, useLocation, useSearch } from "wouter";
import { Rocket, LayoutGrid, ArrowRightLeft, Plus, UserCircle2, Wallet } from "lucide-react";
import { cn, diceBearUrl } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useAuth } from "@/contexts/AuthContext";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { useGetProfile, getGetProfileQueryKey } from "@workspace/api-client-react";
import { formatAddress } from "@/lib/utils";
import { useState } from "react";

function LaunchTokenButton() {
  const [hovered, setHovered] = useState(false);
  return (
    <Button
      className="w-full rounded-[8px] font-medium text-sm h-9 transition-all duration-200 active:scale-[0.98] flex items-center gap-2"
      style={{
        background: hovered
          ? "linear-gradient(135deg, #7ecf1a 0%, #9aed2c 100%)"
          : "linear-gradient(135deg, #6ab515 0%, #7ecf1a 100%)",
        color: "#000000",
        boxShadow: hovered ? "0 0 16px rgba(22,163,74,0.45)" : "0 0 8px rgba(22,163,74,0.2)",
        border: "1px solid rgba(74,222,128,0.25)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Plus className="h-4 w-4 shrink-0" />
      Launch Token
    </Button>
  );
}

export function Sidebar() {
  const [location] = useLocation();
  const search = useSearch();
  const isPortfolio = location === "/app" && search.includes("tab=portfolio");
  const { wallet, walletName } = useWallet();
  const { socialUser } = useAuth();

  // Use extension wallet if available; fall back to social account address.
  const effectiveAddress = wallet ?? socialUser?.address ?? null;

  const { data: profile } = useGetProfile(effectiveAddress ?? "", {
    query: { enabled: !!effectiveAddress, retry: false, queryKey: getGetProfileQueryKey(effectiveAddress ?? "") },
  });

  return (
    <div className="hidden md:flex fixed left-0 top-0 h-full w-[220px] border-r border-border bg-background flex-col z-50">
      <div className="p-4 flex flex-col gap-4">
        <Link href="/" className="flex items-center transition-all duration-150 cursor-pointer">
          <img src="/pumpi-logo.png" alt="Pumpi" className="h-7 w-auto object-contain" />
        </Link>
        <div className="h-px w-full bg-border/50" />
      </div>

      <nav className="flex-1 px-3 py-2 flex flex-col gap-1">
        <Link
          href="/"
          className={cn(
            "flex items-center gap-3 px-3 py-2.5 text-sm font-normal transition-all duration-200 rounded-sm group",
            location === "/"
              ? "bg-primary/15 text-foreground nav-active-bar"
              : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
          )}
        >
          <LayoutGrid className={cn("w-4 h-4 transition-transform duration-200", location === "/" ? "text-primary" : "group-hover:scale-110")} />
          Explore
        </Link>
        <Link
          href="/app"
          className={cn(
            "flex items-center gap-3 px-3 py-2.5 text-sm font-normal transition-all duration-200 rounded-sm group",
            location === "/app" && !isPortfolio
              ? "bg-primary/15 text-foreground nav-active-bar"
              : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
          )}
        >
          <Rocket className={cn("w-4 h-4 transition-transform duration-200", location === "/app" ? "text-primary" : "group-hover:scale-110")} />
          Launch
        </Link>

        <Link
          href="/app?tab=portfolio"
          className={cn(
            "flex items-center gap-3 px-3 py-2.5 text-sm font-normal transition-all duration-200 rounded-sm group",
            isPortfolio
              ? "bg-primary/15 text-foreground nav-active-bar"
              : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
          )}
        >
          <Wallet className={cn("w-4 h-4 transition-transform duration-200", "group-hover:scale-110")} />
          My Coins
        </Link>

        {/* Profile link — visible when signed in */}
        {effectiveAddress && (
          <Link
            href={`/profile/${profile?.username ?? effectiveAddress}`}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 text-sm font-normal transition-all duration-200 rounded-sm group",
              location === `/profile/${profile?.username ?? effectiveAddress}`
                ? "bg-primary/15 text-foreground nav-active-bar"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
            )}
          >
            <img
              src={profile?.avatarUrl || diceBearUrl(effectiveAddress)}
              alt="avatar"
              className="w-4 h-4 rounded-full object-cover shrink-0"
              style={{ imageRendering: profile?.avatarUrl ? "auto" : "pixelated" }}
            />
            <span className="flex-1 truncate">Profile</span>
          </Link>
        )}
      </nav>

      <div className="p-4 border-t border-border/50 flex flex-col gap-3">
        <Link href="/app" className="block w-full">
          <LaunchTokenButton />
        </Link>
        <span className="text-center text-[11px] text-muted-foreground">v1.0 beta</span>
      </div>
    </div>
  );
}

export function BottomNav() {
  const [location] = useLocation();
  const { wallet } = useWallet();
  const { socialUser } = useAuth();

  // Use extension wallet if available; fall back to social account address.
  const effectiveAddress = wallet ?? socialUser?.address ?? null;

  const { data: profile } = useGetProfile(effectiveAddress ?? "", {
    query: { enabled: !!effectiveAddress, retry: false, queryKey: getGetProfileQueryKey(effectiveAddress ?? "") },
  });

  const profileHref = effectiveAddress ? `/profile/${profile?.username ?? effectiveAddress}` : null;
  const isProfileActive = !!effectiveAddress && location === `/profile/${profile?.username ?? effectiveAddress}`;

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-background border-t border-border/60 flex flex-col safe-area-pb">

      {/* Nav icons row */}
      <div className="flex items-stretch h-16">
        <Link
          href="/"
          className={cn(
            "flex-1 flex flex-col items-center justify-center gap-1 text-[10px] font-normal tracking-wide transition-all duration-200",
            location === "/" ? "text-primary" : "text-muted-foreground"
          )}
        >
          <LayoutGrid className={cn("w-5 h-5 transition-transform duration-200", location === "/" ? "text-primary scale-110" : "")} />
          Explore
        </Link>

        <Link
          href="/app"
          className="flex-1 flex flex-col items-center justify-center"
        >
          <div className="relative bg-primary rounded-full w-12 h-12 flex items-center justify-center shadow-[0_0_16px_rgba(255,255,255,0.2)] -mt-5 fab-ring animate-floatY transition-transform duration-150 active:scale-90">
            <Plus className="w-6 h-6 text-primary-foreground" strokeWidth={2.5} />
          </div>
        </Link>

        {/* Profile tab — navigates to profile when connected, opens wallet modal when not */}
        {profileHref ? (
          <Link
            href={profileHref}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-1 text-[10px] font-normal tracking-wide transition-all duration-200",
              isProfileActive ? "text-primary" : "text-muted-foreground"
            )}
          >
            {profile?.avatarUrl ? (
              <img
                src={profile.avatarUrl}
                alt="avatar"
                className={cn(
                  "w-5 h-5 rounded-full object-cover border",
                  isProfileActive ? "border-primary" : "border-border"
                )}
              />
            ) : (
              <TokenAvatar symbol={profile?.username || effectiveAddress!.slice(0, 4)} size={20} shape="circle" />
            )}
            Profile
          </Link>
        ) : (
          <Link
            href="/signin"
            className="flex-1 flex flex-col items-center justify-center gap-1 text-[10px] font-normal tracking-wide text-muted-foreground transition-all duration-200"
          >
            <UserCircle2 className="w-5 h-5" />
            Profile
          </Link>
        )}
      </div>
    </div>
  );
}
