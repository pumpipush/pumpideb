import { Link, useLocation } from "wouter";
import { Rocket, LayoutGrid, ArrowRightLeft, Plus, UserCircle2 } from "lucide-react";
import { cn, diceBearUrl } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { useGetProfile, getGetProfileQueryKey } from "@workspace/api-client-react";
import { formatAddress } from "@/lib/utils";
import { useState } from "react";

function LaunchTokenButton() {
  const [hovered, setHovered] = useState(false);
  return (
    <Button
      className="w-full rounded-[8px] font-bold text-sm h-9 transition-all duration-200 active:scale-[0.98] flex items-center gap-2"
      style={{
        background: hovered ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.88)",
        color: "#0f172a",
        boxShadow: hovered ? "0 2px 12px rgba(0,0,0,0.3)" : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      Create New Coin
    </Button>
  );
}

export function Sidebar() {
  const [location] = useLocation();
  const { wallet, walletName } = useWallet();

  const { data: profile } = useGetProfile(wallet ?? "", {
    query: { enabled: !!wallet, retry: false, queryKey: getGetProfileQueryKey(wallet ?? "") },
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
            "flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-all duration-200 rounded-sm group",
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
            "flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-all duration-200 rounded-sm group",
            location === "/app"
              ? "bg-primary/15 text-foreground nav-active-bar"
              : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
          )}
        >
          <ArrowRightLeft className={cn("w-4 h-4 transition-transform duration-200", location === "/app" ? "text-primary" : "group-hover:scale-110")} />
          Trade
        </Link>

        {/* Profile link — only visible when wallet connected */}
        {wallet && (
          <Link
            href={`/profile/${profile?.username ?? wallet}`}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-all duration-200 rounded-sm group",
              location === `/profile/${profile?.username ?? wallet}`
                ? "bg-primary/15 text-foreground nav-active-bar"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
            )}
          >
            <img
              src={profile?.avatarUrl || diceBearUrl(wallet)}
              alt="avatar"
              className="w-4 h-4 rounded-full object-cover shrink-0"
              style={{ imageRendering: profile?.avatarUrl ? "auto" : "pixelated" }}
            />
            <span className="flex-1 truncate">
              {profile?.username ?? formatAddress(wallet)}
            </span>
          </Link>
        )}
      </nav>

      <div className="p-4 border-t border-border/50 flex flex-col gap-4">
        <Link href="/app" className="block w-full">
          <LaunchTokenButton />
        </Link>
        {/* Legal footer */}
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/privacy" className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors">
            Privacy
          </Link>
          <span className="text-[11px] text-muted-foreground/25">·</span>
          <Link href="/disclaimer" className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors">
            Disclaimer
          </Link>
        </div>
      </div>
    </div>
  );
}

export function BottomNav() {
  const [location] = useLocation();
  const { wallet } = useWallet();

  const { data: profile } = useGetProfile(wallet ?? "", {
    query: { enabled: !!wallet, retry: false, queryKey: getGetProfileQueryKey(wallet ?? "") },
  });

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-background border-t border-border/60 flex items-stretch h-16 safe-area-pb">
      <Link
        href="/"
        className={cn(
          "flex-1 flex flex-col items-center justify-center gap-1 text-[10px] font-medium tracking-wide transition-all duration-200",
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

      {/* Profile tab (mobile) — shows avatar when connected, generic icon when not */}
      <Link
        href={wallet ? `/profile/${profile?.username ?? wallet}` : "/app"}
        className={cn(
          "flex-1 flex flex-col items-center justify-center gap-1 text-[10px] font-medium tracking-wide transition-all duration-200",
          wallet && location === `/profile/${profile?.username ?? wallet}` ? "text-primary" : "text-muted-foreground"
        )}
      >
        {wallet && profile?.avatarUrl ? (
          <img
            src={profile.avatarUrl}
            alt="avatar"
            className={cn(
              "w-5 h-5 rounded-full object-cover border",
              location === `/profile/${profile?.username ?? wallet}` ? "border-primary" : "border-border"
            )}
          />
        ) : wallet ? (
          <TokenAvatar
            symbol={profile?.username || wallet.slice(0, 4)}
            size={20}
            shape="circle"
          />
        ) : (
          <UserCircle2 className="w-5 h-5" />
        )}
        Profile
      </Link>
    </div>
  );
}
