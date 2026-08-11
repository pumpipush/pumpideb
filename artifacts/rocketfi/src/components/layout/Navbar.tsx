import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Search, Wallet, UserCircle, Copy, LogOut, ExternalLink, ChevronDown, Pencil } from "lucide-react";
import { useWallet } from "@/contexts/WalletContext";
import { useGetProfile, getGetProfileQueryKey } from "@workspace/api-client-react";
import { formatAddress, diceBearUrl } from "@/lib/utils";
import { Link } from "wouter";
import { openSearch } from "@/components/shared/SearchDialog";
import { useState } from "react";
import { WalletSelectModal } from "@/components/shared/WalletSelectModal";
import { useToast } from "@/hooks/use-toast";
import { copyToClipboard } from "@/components/shared/CopyToast";
import { ProfileEditModal } from "@/components/shared/ProfileEditModal";

function WalletButton() {
  const { wallet, walletName, disconnect } = useWallet();
  const [walletModal, setWalletModal] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { toast } = useToast();

  async function handleLogout() {
    await disconnect();
    toast({ title: "Logged out", description: "See you next time." });
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

  const profileSlug = profile?.username ?? wallet;
  const displayName = profile?.username ?? formatAddress(wallet);

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 h-9 pl-1.5 pr-2.5 rounded-full border border-border/60 bg-card hover:border-border hover:bg-card/80 transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-primary/50 group shrink-0">
          {/* Avatar */}
          <div className="h-6 w-6 rounded-full overflow-hidden border border-border/80 shrink-0">
            <img
              src={profile?.avatarUrl || diceBearUrl(wallet)}
              alt={displayName}
              className="w-full h-full object-cover"
              style={{ imageRendering: profile?.avatarUrl ? "auto" : "pixelated" }}
            />
          </div>
          {/* Name + address — desktop */}
          <div className="hidden sm:flex flex-col items-start leading-none">
            <span className="text-[12px] font-semibold text-foreground">{displayName}</span>
            <span className="text-[10px] font-mono text-muted-foreground/70 mt-0.5">
              {walletName ? walletName : formatAddress(wallet)}
            </span>
          </div>
          <ChevronDown className="w-3 h-3 text-muted-foreground/60 group-data-[state=open]:rotate-180 transition-transform duration-200 hidden sm:block" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-60 p-0 rounded-xl border border-border/60 shadow-xl shadow-black/40 overflow-hidden"
      >
        {/* Profile header */}
        <div className="flex items-center gap-3 px-4 py-3.5 bg-card/60">
          <div className="h-10 w-10 rounded-full overflow-hidden border-2 border-border shrink-0">
            <img
              src={profile?.avatarUrl || diceBearUrl(wallet)}
              alt={displayName}
              className="w-full h-full object-cover"
              style={{ imageRendering: profile?.avatarUrl ? "auto" : "pixelated" }}
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{displayName}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
              <p className="text-[11px] font-mono text-muted-foreground truncate">{formatAddress(wallet)}</p>
            </div>
          </div>
        </div>

        <DropdownMenuSeparator className="my-0" />

        {/* Actions */}
        <div className="p-1.5 flex flex-col gap-0.5">
          <DropdownMenuItem asChild className="rounded-lg px-3 py-2.5 cursor-pointer gap-3 focus:bg-white/5">
            <Link href={`/profile/${profileSlug}`}>
              <UserCircle className="w-4 h-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-[13px] font-medium text-foreground">View Profile</p>
                <p className="text-[11px] text-muted-foreground">See your public page</p>
              </div>
            </Link>
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => setEditOpen(true)}
            className="rounded-lg px-3 py-2.5 cursor-pointer gap-3 focus:bg-white/5"
          >
            <Pencil className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[13px] font-medium text-foreground">Edit Profile</p>
              <p className="text-[11px] text-muted-foreground">Update name, bio & avatar</p>
            </div>
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => copyToClipboard(wallet, "Address copied")}
            className="rounded-lg px-3 py-2.5 cursor-pointer gap-3 focus:bg-white/5"
          >
            <Copy className="w-4 h-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-[13px] font-medium text-foreground">Copy Address</p>
              <p className="text-[11px] text-muted-foreground font-mono">{formatAddress(wallet)}</p>
            </div>
          </DropdownMenuItem>

          <DropdownMenuItem asChild className="rounded-lg px-3 py-2.5 cursor-pointer gap-3 focus:bg-white/5">
            <a
              href={`https://solscan.io/account/${wallet}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-[13px] font-medium text-foreground">View on Solscan</p>
                <p className="text-[11px] text-muted-foreground">Check on-chain activity</p>
              </div>
            </a>
          </DropdownMenuItem>
        </div>

        <DropdownMenuSeparator className="my-0" />

        <div className="p-1.5">
          <DropdownMenuItem
            onSelect={() => void handleLogout()}
            className="rounded-lg px-3 py-2.5 cursor-pointer gap-3 focus:bg-red-500/10 text-red-400 focus:text-red-400"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <div>
              <p className="text-[13px] font-medium">Log out</p>
              <p className="text-[11px] opacity-60">Disconnect your wallet</p>
            </div>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>

    <ProfileEditModal open={editOpen} onOpenChange={setEditOpen} />
    </>
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
        <span className="font-bold text-sm text-foreground tracking-tight">Pump<span style={{ color: "#4ade80" }}>i</span></span>
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
