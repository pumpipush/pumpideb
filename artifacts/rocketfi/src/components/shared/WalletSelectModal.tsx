/**
 * WalletSelectModal — custom wallet selection dialog.
 *
 * Lists Phantom, Backpack, and Solflare. Uses useWallet() internally so
 * consumers only need to pass open state and a success callback.
 *
 * - Extension installed → connects immediately, calls onSuccess()
 * - Extension not installed → opens install page in a new tab
 * - Mobile → deep-links to the wallet's in-app browser
 */

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ExternalLink, Loader2 } from "lucide-react";
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
  /** Called after the wallet is successfully connected */
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

    // Mobile: redirect to wallet deep-link
    if (mobile) {
      window.location.href = getMobileDeepLink(descriptor);
      return;
    }

    const provider = descriptor.getProvider();

    // Extension not installed: open install page
    if (!provider) {
      window.open(descriptor.installUrl, "_blank", "noopener,noreferrer");
      return;
    }

    setConnecting(descriptor.name);
    try {
      await connectWallet(provider, descriptor.name);
      onOpenChange(false);
      onSuccess?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("user rejected") || msg.toLowerCase().includes("cancelled")) {
        setError("Connection cancelled.");
      } else {
        setError(msg || "Failed to connect. Please try again.");
      }
    } finally {
      setConnecting(null);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-full max-w-sm bg-[#0e1726] border border-white/[0.08] rounded-2xl shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
            "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-white/[0.06]">
            <div>
              <Dialog.Title className="text-base font-semibold text-white">
                Connect Wallet
              </Dialog.Title>
              <Dialog.Description className="text-xs text-white/40 mt-0.5">
                Choose your Solana wallet to continue
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                className="h-7 w-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition-all"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          {/* Wallet list */}
          <div className="p-3 space-y-2">
            {WALLET_DESCRIPTORS.map((descriptor) => {
              const installed = mobile || isWalletInstalled(descriptor);
              const isConnecting = connecting === descriptor.name;

              return (
                <button
                  key={descriptor.name}
                  onClick={() => void handleSelect(descriptor)}
                  disabled={isConnecting || connecting !== null}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-150",
                    "border text-left",
                    installed
                      ? "border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.07] hover:border-primary/30 active:scale-[0.99]"
                      : "border-white/[0.04] bg-white/[0.01] hover:bg-white/[0.04] hover:border-white/[0.08]",
                    "disabled:opacity-60 disabled:cursor-not-allowed"
                  )}
                >
                  {/* Icon */}
                  <img
                    src={descriptor.icon}
                    alt={descriptor.name}
                    className="w-9 h-9 rounded-xl shrink-0"
                  />

                  {/* Label */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white">{descriptor.name}</div>
                    <div className="text-[11px] text-white/40 mt-0.5">
                      {mobile
                        ? "Open in wallet app"
                        : installed
                        ? "Ready to connect"
                        : "Click to install"}
                    </div>
                  </div>

                  {/* Right indicator */}
                  {isConnecting ? (
                    <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
                  ) : !installed && !mobile ? (
                    <ExternalLink className="w-3.5 h-3.5 text-white/20 shrink-0" />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Error */}
          {error && (
            <div className="mx-3 mb-3 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {/* Footer note */}
          <div className="px-5 pb-5 pt-2">
            <p className="text-[11px] text-white/25 text-center leading-relaxed">
              We never request your seed phrase or private key.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
