/**
 * WalletSelectModal — redesigned to match Dexcompass-style wallet picker.
 *
 * Sections: SOLANA (Phantom, Solflare, Backpack) + ETHEREUM / BSC (MetaMask, WalletConnect)
 * - Installed wallets show "INSTALLED" badge
 * - WalletConnect shows "QR CODE" badge
 * - Non-Solana wallets open install page
 */

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ChevronRight, Loader2 } from "lucide-react";
import {
  WALLET_DESCRIPTORS,
  isWalletInstalled,
  isMobile,
  type WalletDescriptor,
  type WalletName,
} from "@/lib/solana";
import { useWallet } from "@/contexts/WalletContext";
import { cn } from "@/lib/utils";

interface WalletSelectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

function getMobileDeepLink(descriptor: WalletDescriptor): string {
  const dappUrl = encodeURIComponent(window.location.href);
  return descriptor.deepLinkBase ? `${descriptor.deepLinkBase}${dappUrl}` : descriptor.installUrl;
}

// Simple inline SVG icons for EVM wallets
const METAMASK_ICON = `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#1c1c1c"/><path d="M73.8 18L51.5 34.3l4.2-9.9L73.8 18z" fill="#E2761B" stroke="#E2761B" stroke-linecap="round" stroke-linejoin="round"/><path d="M22.2 18l22.1 16.5-4-10L22.2 18zm42.1 41.6l-5.9 9.1 12.7 3.5 3.6-12.4-10.4-.2zm-54 .2l3.6 12.4 12.7-3.5-5.9-9.1-10.4.2z" fill="#E4761B" stroke="#E4761B" stroke-linecap="round" stroke-linejoin="round"/><path d="M37.8 41.5l-3.5 5.3 12.5.6-.4-13.5-8.6 7.6zm20.4 0l-8.7-7.8-.3 13.7 12.5-.6-3.5-5.3zm-20.9 27l7.5-3.7-6.5-5-1 8.7zm13.2-3.7l7.5 3.7-1-8.7-6.5 5z" fill="#E4761B" stroke="#E4761B" stroke-linecap="round" stroke-linejoin="round"/></svg>`)}`;

const WALLETCONNECT_ICON = `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#1c1c1c"/><path d="M28.5 38.6c10.8-10.6 28.2-10.6 39 0l1.3 1.3c.5.5.5 1.4 0 1.9l-4.4 4.3c-.3.3-.7.3-1 0l-1.8-1.7c-7.5-7.4-19.7-7.4-27.2 0l-1.9 1.9c-.3.3-.7.3-1 0L27 41.9c-.5-.5-.5-1.4 0-1.9l1.5-1.4zm48.1 9l3.9 3.8c.5.5.5 1.4 0 1.9L62.2 70.6c-.5.5-1.4.5-1.9 0L48 58.5 35.7 70.6c-.5.5-1.4.5-1.9 0L15.5 52.3c-.5-.5-.5-1.4 0-1.9l3.9-3.8c.5-.5 1.4-.5 1.9 0L33.7 58.7l12.3-12.1c.5-.5 1.4-.5 1.9 0l12.3 12.1 12.5-12.1c.5-.5 1.4-.5 1.9 0z" fill="#3B99FC"/></svg>`)}`;

interface EvmWallet {
  name: string;
  icon: string;
  installUrl: string;
  badge?: string;
}

const EVM_WALLETS: EvmWallet[] = [
  { name: "MetaMask",      icon: METAMASK_ICON,      installUrl: "https://metamask.io/download/" },
  { name: "WalletConnect", icon: WALLETCONNECT_ICON, installUrl: "https://walletconnect.com/",   badge: "QR CODE" },
];

export function WalletSelectModal({ open, onOpenChange, onSuccess }: WalletSelectModalProps) {
  const { connectWallet } = useWallet();
  const [connecting, setConnecting] = useState<WalletName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mobile = isMobile();

  async function handleSelect(descriptor: WalletDescriptor) {
    setError(null);
    if (mobile) { window.location.href = getMobileDeepLink(descriptor); return; }
    const provider = descriptor.getProvider();
    if (!provider) { window.open(descriptor.installUrl, "_blank", "noopener,noreferrer"); return; }
    setConnecting(descriptor.name);
    try {
      await connectWallet(provider, descriptor.name);
      onOpenChange(false);
      onSuccess?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.toLowerCase().includes("user rejected") || msg.toLowerCase().includes("cancelled")
        ? "Connection cancelled." : msg || "Failed to connect. Please try again.");
    } finally {
      setConnecting(null);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={v => { setError(null); onOpenChange(v); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-full max-w-[360px] rounded-2xl shadow-2xl outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
          style={{ background: "#141414", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-5 pt-5 pb-4">
            {/* Wallet icon */}
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="6" width="20" height="14" rx="3" stroke="#94a3b8" strokeWidth="1.8"/>
                <path d="M2 10h20" stroke="#94a3b8" strokeWidth="1.8"/>
                <circle cx="17" cy="15" r="1.5" fill="#94a3b8"/>
              </svg>
            </div>
            <Dialog.Title className="flex-1 text-[15px] font-semibold" style={{ color: "#f1f5f9" }}>
              Connect Wallet
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: "rgba(255,255,255,0.05)", color: "#64748b" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#e2e8f0")}
                onMouseLeave={e => (e.currentTarget.style.color = "#64748b")}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Choose a wallet to connect</Dialog.Description>

          {/* SOLANA section */}
          <div className="px-5 pb-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] font-semibold tracking-widest" style={{ color: "#475569" }}>SOLANA</span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: "rgba(255,255,255,0.07)", color: "#64748b" }}>
                {WALLET_DESCRIPTORS.length}+
              </span>
            </div>
            <div className="space-y-1">
              {WALLET_DESCRIPTORS.map((descriptor) => {
                const installed = mobile || isWalletInstalled(descriptor);
                const isConnecting = connecting === descriptor.name;
                return (
                  <button
                    key={descriptor.name}
                    onClick={() => void handleSelect(descriptor)}
                    disabled={isConnecting || connecting !== null}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{ background: "rgba(255,255,255,0.03)" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                  >
                    <img src={descriptor.icon} alt={descriptor.name} className="w-9 h-9 rounded-xl shrink-0" />
                    <span className="flex-1 text-[14px] font-semibold" style={{ color: "#e2e8f0" }}>{descriptor.name}</span>
                    {installed && !isConnecting && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md mr-1" style={{ background: "rgba(74,222,128,0.12)", color: "#4ade80", border: "1px solid rgba(74,222,128,0.2)" }}>
                        INSTALLED
                      </span>
                    )}
                    {isConnecting
                      ? <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "#4ade80" }} />
                      : <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "#334155" }} />
                    }
                  </button>
                );
              })}
            </div>
          </div>

          {/* ETHEREUM / BSC section */}
          <div className="px-5 pt-3 pb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] font-semibold tracking-widest" style={{ color: "#475569" }}>ETHEREUM / BSC</span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: "rgba(255,255,255,0.07)", color: "#64748b" }}>EVM</span>
            </div>
            <div className="space-y-1">
              {EVM_WALLETS.map((w) => (
                <button
                  key={w.name}
                  onClick={() => window.open(w.installUrl, "_blank", "noopener,noreferrer")}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                >
                  <img src={w.icon} alt={w.name} className="w-9 h-9 rounded-xl shrink-0" />
                  <span className="flex-1 text-[14px] font-semibold" style={{ color: "#e2e8f0" }}>{w.name}</span>
                  {w.badge && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-md mr-1" style={{ background: "rgba(255,255,255,0.07)", color: "#64748b", border: "1px solid rgba(255,255,255,0.10)" }}>
                      {w.badge}
                    </span>
                  )}
                  <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "#334155" }} />
                </button>
              ))}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mx-5 mb-3 px-3 py-2.5 rounded-xl" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)" }}>
              <p className="text-[12px]" style={{ color: "#f87171" }}>{error}</p>
            </div>
          )}

          {/* Footer */}
          <div className="px-5 pb-5 pt-1">
            <p className="text-[11px] text-center" style={{ color: "#334155" }}>
              Your wallet keys are never stored on our servers
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
