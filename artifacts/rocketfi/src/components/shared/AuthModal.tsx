import { useState } from "react";
import { X, Rocket, Wallet } from "lucide-react";
import { useLocation } from "wouter";
import { WalletSelectModal } from "./WalletSelectModal";

interface AuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultMode?: "signin" | "signup"; // kept for API compat, ignored
}

export function AuthModal({ open, onOpenChange }: AuthModalProps) {
  const [, navigate] = useLocation();
  const [walletModal, setWalletModal] = useState(false);

  if (!open) return null;

  function close() {
    onOpenChange(false);
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
        onClick={close}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="relative w-full max-w-[360px] pointer-events-auto animate-in zoom-in-95 fade-in duration-200">
          <div className="relative rounded-2xl bg-[#0c1220] border border-white/[0.08] shadow-[0_24px_80px_rgba(0,0,0,0.7)] overflow-hidden">
            {/* Top accent */}
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

            {/* Close */}
            <button
              onClick={close}
              className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-full bg-white/[0.05] hover:bg-white/[0.1] text-white/40 hover:text-white/80 transition-all"
            >
              <X className="w-3.5 h-3.5" />
            </button>

            <div className="px-6 pt-8 pb-7 flex flex-col items-center text-center">
              {/* Icon */}
              <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center shadow-[0_0_32px_rgba(255,255,255,0.18)] mb-5">
                <Rocket className="w-7 h-7 text-black" />
              </div>

              {/* Heading */}
              <h2 className="text-[22px] font-bold text-white leading-tight mb-1.5">
                Connect your wallet
              </h2>
              <p className="text-sm text-white/40 mb-7 max-w-[260px] leading-relaxed">
                Connect a Solana wallet to start trading and launching tokens on Mintix.
              </p>

              {/* CTA */}
              <button
                type="button"
                onClick={() => setWalletModal(true)}
                className="w-full h-12 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2.5 hover:bg-primary/90 active:scale-[0.98] transition-all shadow-[0_0_24px_rgba(255,255,255,0.1)]"
              >
                <Wallet className="w-4 h-4" />
                Connect Wallet
              </button>

              <p className="text-[11px] text-white/20 mt-4 leading-relaxed">
                By connecting you agree to our Terms of Service
              </p>
            </div>
          </div>
        </div>
      </div>

      <WalletSelectModal
        open={walletModal}
        onOpenChange={setWalletModal}
        onSuccess={() => {
          setWalletModal(false);
          close();
          navigate("/");
        }}
      />
    </>
  );
}
