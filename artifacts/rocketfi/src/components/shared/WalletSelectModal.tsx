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

const WALLET_ICON_OVERRIDES: Record<string, string> = {
  Phantom:  "/wallets/phantom.jpeg",
  Solflare: "/wallets/solflare.jpeg",
  Backpack: "/wallets/backpack.jpeg",
};

interface WalletSelectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

function getMobileDeepLink(descriptor: WalletDescriptor): string {
  const dappUrl = encodeURIComponent(window.location.href);
  return descriptor.deepLinkBase ? `${descriptor.deepLinkBase}${dappUrl}` : descriptor.installUrl;
}


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
            <div className="mb-2" />
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
                    <img
                      src={WALLET_ICON_OVERRIDES[descriptor.name] ?? descriptor.icon}
                      alt={descriptor.name}
                      className="w-9 h-9 rounded-xl shrink-0 object-cover transition-opacity duration-300"
                      style={{ opacity: 0 }}
                      onLoad={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "1"; }}
                    />
                    <span className="flex-1 text-[14px] font-semibold" style={{ color: "#e2e8f0" }}>{descriptor.name}</span>
                    {installed && !isConnecting && (
                      <span className="text-[12px] font-medium mr-1" style={{ color: "#4ade80" }}>
                        Installed
                      </span>
                    )}
                    {isConnecting
                      ? <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "#4ade80" }} />
                      : <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "#64748b" }} />
                    }
                  </button>
                );
              })}
            </div>
          </div>


          {/* Error */}
          {error && (
            <div className="mx-5 mb-3 px-3 py-2.5 rounded-xl" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)" }}>
              <p className="text-[12px]" style={{ color: "#f87171" }}>{error}</p>
            </div>
          )}

        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
