import { Link, useLocation } from "wouter";
import { Flame, LayoutGrid, ArrowRightLeft, Plus, UserCircle2 } from "lucide-react";
import { cn, diceBearUrl } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { useGetProfile, getGetProfileQueryKey } from "@workspace/api-client-react";
import { formatAddress } from "@/lib/utils";

export function Sidebar() {
  const [location] = useLocation();
  const { wallet, walletName } = useWallet();

  const { data: profile } = useGetProfile(wallet ?? "", {
    query: { enabled: !!wallet, retry: false, queryKey: getGetProfileQueryKey(wallet ?? "") },
  });

  return (
    <div className="hidden md:flex fixed left-0 top-0 h-full w-[220px] border-r border-border bg-background flex-col z-50">
      <div className="p-4 flex flex-col gap-4">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight text-primary transition-all duration-150 cursor-pointer">
          <Flame className="h-5 w-5" />
          <span>Mintix <span className="text-white/50 font-normal">fun</span></span>
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
            href={`/profile/${wallet}`}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-all duration-200 rounded-sm group",
              location === `/profile/${wallet}`
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
          <Button className="w-full bg-primary text-white hover:bg-primary/90 rounded-sm font-bold text-sm h-9 transition-all duration-200 hover:shadow-[0_0_20px_hsl(142_100%_45%/0.35)] active:scale-[0.98]">
            Create
          </Button>
        </Link>
        <div className="text-center text-[10px] text-muted-foreground/40 font-mono">v1.0 beta</div>
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
        <div className="relative bg-primary rounded-full w-12 h-12 flex items-center justify-center shadow-[0_0_16px_hsl(142_100%_45%/0.4)] -mt-5 fab-ring animate-floatY transition-transform duration-150 active:scale-90">
          <Plus className="w-6 h-6 text-white" strokeWidth={2.5} />
        </div>
      </Link>

      {/* Profile tab (mobile) — shows avatar when connected, generic icon when not */}
      <Link
        href={wallet ? `/profile/${wallet}` : "/app"}
        className={cn(
          "flex-1 flex flex-col items-center justify-center gap-1 text-[10px] font-medium tracking-wide transition-all duration-200",
          wallet && location === `/profile/${wallet}` ? "text-primary" : "text-muted-foreground"
        )}
      >
        {wallet && profile?.avatarUrl ? (
          <img
            src={profile.avatarUrl}
            alt="avatar"
            className={cn(
              "w-5 h-5 rounded-full object-cover border",
              location === `/profile/${wallet}` ? "border-primary" : "border-border"
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
