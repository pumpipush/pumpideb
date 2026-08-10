import { Button } from "@/components/ui/button";
import { Search, Wallet } from "lucide-react";
import { useWallet } from "@/contexts/WalletContext";
import { useGetProfile, getGetProfileQueryKey } from "@workspace/api-client-react";
import { formatAddress, diceBearUrl } from "@/lib/utils";
import { TokenAvatar } from "@/components/shared/TokenAvatar";
import { Link, useLocation } from "wouter";
import { openSearch } from "@/components/shared/SearchDialog";
import { useState } from "react";
import { WalletSelectModal } from "@/components/shared/WalletSelectModal";
import { useToast } from "@/hooks/use-toast";

function WalletButton() {
  const { wallet, walletName, disconnect } = useWallet();
  const [walletModal, setWalletModal] = useState(false);
  const { toast } = useToast();

  async function handleDisconnect() {
    await disconnect();
    toast({ title: "Wallet disconnected", description: "See you next time." });
  }

  const { data: profile } = useGetProfile(wallet ?? "", {
    query: { enabled: !!wallet, retry: false, queryKey: getGetProfileQueryKey(wallet ?? "") },
  });

  if (!wallet) {
    return (
      <>
        {/* Mobile: icon only */}
        <button
          onClick={() => setWalletModal(true)}
          className="md:hidden flex items-center justify-center h-8 w-8 rounded-[8px] border border-primary/50 text-primary hover:bg-primary/10 transition-all duration-150 shrink-0"
          aria-label="Connect Wallet"
        >
          <Wallet className="h-4 w-4" />
        </button>

        {/* Desktop: text button */}
        <Button
          size="sm"
          onClick={() => setWalletModal(true)}
          className="hidden md:flex items-center gap-1.5 h-8 text-xs font-semibold rounded-[8px] bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-150 shrink-0"
        >
          <Wallet className="h-3.5 w-3.5" />
          Connect Wallet
        </Button>

        <WalletSelectModal
          open={walletModal}
          onOpenChange={setWalletModal}
          onSuccess={() => toast({ title: "Wallet connected", description: "You're ready to trade on Solana." })}
        />
      </>
    );
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      {/* Address pill — desktop only */}
      <div className="hidden sm:flex items-center gap-1.5 h-8 px-2.5 bg-card border border-border/50 rounded-sm" title={wallet}>
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs font-mono text-muted-foreground">{formatAddress(wallet)}</span>
        {walletName && (
          <span className="text-[10px] text-white/30 font-medium">{walletName}</span>
        )}
      </div>

      {/* Profile avatar — always visible */}
      <Link href={`/profile/${wallet}`}>
        <button className="relative h-8 w-8 rounded-full overflow-hidden border-2 border-border hover:border-primary/50 transition-colors shrink-0">
          <img
            src={profile?.avatarUrl || diceBearUrl(wallet)}
            alt={profile?.username ?? wallet}
            className="w-full h-full object-cover"
            style={{ imageRendering: profile?.avatarUrl ? "auto" : "pixelated" }}
          />
        </button>
      </Link>

      {/* Disconnect — desktop only */}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground transition-colors hidden sm:flex"
        onClick={() => void handleDisconnect()}
      >
        Disconnect
      </Button>
    </div>
  );
}

export function Navbar() {
  return (
    <nav className="h-[60px] fixed top-0 left-0 right-0 md:left-[220px] border-b border-border/30 bg-background/95 backdrop-blur-sm flex items-center px-4 md:px-6 gap-3 z-40">

      {/* Logo — mobile only (desktop logo lives in Sidebar) */}
      <Link href="/" className="md:hidden flex items-center gap-2 shrink-0 select-none">
        <div className="h-7 w-7 rounded-sm bg-primary flex items-center justify-center shrink-0">
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-white fill-current">
            <path d="M12 2.5c-1.5 3-4 4.5-4 8.5a4 4 0 008 0c0-4-2.5-5.5-4-8.5z"/>
            <path d="M10 19h4v2.5a.5.5 0 01-.5.5h-3a.5.5 0 01-.5-.5V19z" opacity=".7"/>
          </svg>
        </div>
        <span className="font-bold text-sm text-foreground tracking-tight">Mintix <span style={{ color: "hsl(28, 95%, 56%)" }}>fun</span></span>
      </Link>

      {/* Desktop: full search bar */}
      <button
        onClick={openSearch}
        className="hidden md:flex relative items-center w-full max-w-sm h-8 rounded-sm bg-card border border-white/[0.10] px-2.5 gap-2.5 text-left hover:border-white/20 hover:bg-card/80 transition-colors group"
      >
        <Search className="h-3.5 w-3.5 text-muted-foreground/90 shrink-0 group-hover:text-primary transition-colors" />
        <span className="flex-1 text-xs text-muted-foreground/75 truncate">Search coins…</span>
        <div className="flex items-center gap-0.5 shrink-0">
          <kbd className="h-5 px-1 border border-white/20 rounded text-[10px] font-mono text-muted-foreground/70 bg-muted/40">⌘</kbd>
          <kbd className="h-5 px-1 border border-white/20 rounded text-[10px] font-mono text-muted-foreground/70 bg-muted/40">K</kbd>
        </div>
      </button>

      {/* Right side: search icon (mobile) + wallet */}
      <div className="flex items-center gap-2 ml-auto">
        {/* Mobile: search icon */}
        <button
          onClick={openSearch}
          className="md:hidden flex items-center justify-center h-8 w-8 rounded-sm bg-card border border-border/50 hover:border-primary/40 transition-colors shrink-0"
          aria-label="Search"
        >
          <Search className="h-4 w-4 text-muted-foreground" />
        </button>

        <WalletButton />
      </div>
    </nav>
  );
}
