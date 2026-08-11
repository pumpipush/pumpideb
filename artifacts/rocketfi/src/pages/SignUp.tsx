import { useState } from "react";
import { useLocation } from "wouter";
import { Wallet, Rocket, Check } from "lucide-react";
import { WalletSelectModal } from "@/components/shared/WalletSelectModal";

/* ─── Page ───────────────────────────────────────────────────────────────────── */
export default function SignUp() {
  const [, navigate] = useLocation();
  const [walletModal, setWalletModal] = useState(false);

  return (
    <div className="min-h-[100dvh] w-full max-w-full overflow-x-hidden flex bg-[#060d1a]">

      {/* ── Left branding panel (desktop only) ── */}
      <div className="hidden lg:flex lg:w-[440px] xl:w-[480px] shrink-0 flex-col relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0a1628] via-[#060d1a] to-[#050b18]" />
        <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-violet-500/10 rounded-full blur-[100px] translate-x-1/3 -translate-y-1/3" />
        <div className="absolute bottom-0 left-0 w-[350px] h-[350px] bg-primary/10 rounded-full blur-[90px] -translate-x-1/4 translate-y-1/4" />
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImciIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSAwIDYwIEwgNjAgMCIgc3Ryb2tlPSJyZ2JhKDU5LDEzMCwyNDYsMC4wNCkiIHN0cm9rZS13aWR0aD0iMSIvPjwvcGF0dGVybj48L2RlZnM+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0idXJsKCNnKSIvPjwvc3ZnPg==')] opacity-50" />

        <div className="relative flex flex-col flex-1 p-10 xl:p-12">
          {/* Logo */}
          <div className="flex items-center gap-2.5 mb-auto">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-[0_0_20px_rgba(59,130,246,0.5)]">
              <Rocket className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold text-white tracking-tight">Pump<span className="text-primary">i</span></span>
          </div>

          {/* Feature list */}
          <div className="mt-auto mb-10 space-y-6">
            <div>
              <p className="text-white/40 text-xs font-semibold uppercase tracking-widest mb-4">Why join Pumpi?</p>
              {[
                { title: "Launch in seconds", desc: "Deploy a bonding curve token with one click — no presale, no team allocation." },
                { title: "Trade fairly",      desc: "Every token starts equal. Price is set by the curve, not insiders." },
                { title: "Earn from the curve", desc: "Creators earn fees when their token trades. Holders capture upside." },
              ].map(({ title, desc }) => (
                <div key={title} className="flex gap-3 py-3 border-b border-white/[0.06] last:border-0">
                  <div className="w-5 h-5 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 mt-0.5">
                    <Check className="w-3 h-3 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white/90">{title}</p>
                    <p className="text-xs text-white/40 mt-0.5 leading-relaxed">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Testimonial */}
          <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.03]">
            <p className="text-sm text-white/60 leading-relaxed italic mb-3">
              "Launched my first token in under 2 minutes. The bonding curve did exactly what it promised."
            </p>
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary to-violet-500 flex items-center justify-center text-xs font-bold text-white">A</div>
              <div>
                <p className="text-xs font-semibold text-white/80">0xAlex</p>
                <p className="text-[10px] text-white/30">Early adopter</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex-1 flex flex-col items-center justify-center p-5 sm:p-8 relative">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[1px] bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

        {/* Ambient glow */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-violet-500/[0.04] rounded-full blur-[120px]" />
        </div>

        {/* Mobile logo */}
        <div className="lg:hidden flex items-center gap-2.5 mb-10">
          <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center shadow-[0_0_16px_rgba(59,130,246,0.5)]">
            <Rocket className="w-4 h-4 text-white" />
          </div>
          <span className="text-lg font-bold text-white tracking-tight">Pump<span className="text-primary">i</span></span>
        </div>

        <div className="w-full max-w-[380px] relative">
          {/* Header */}
          <div className="mb-10 text-center">
            <h2 className="text-3xl font-bold text-white mb-3 tracking-tight">Start trading on Solana</h2>
            <p className="text-sm text-white/40 leading-relaxed">
              Connect your Solana wallet to launch tokens,<br className="hidden sm:block" /> trade the curve, and earn.
            </p>
          </div>

          {/* Connect Wallet button */}
          <button
            type="button"
            onClick={() => setWalletModal(true)}
            className="w-full h-14 rounded-2xl bg-primary text-white text-base font-semibold flex items-center justify-center gap-3 hover:bg-primary/90 active:scale-[0.98] transition-all duration-150 shadow-[0_0_32px_rgba(59,130,246,0.35)] mb-4"
          >
            <Wallet className="w-5 h-5" />
            Connect Wallet
          </button>

          {/* Supported wallets note */}
          <p className="text-center text-xs text-white/30">
            Supports Phantom, Solflare, and Backpack
          </p>

          {/* Divider */}
          <div className="my-8 h-px bg-white/[0.06]" />

          {/* Footer */}
          <p className="text-center text-sm text-white/30">
            Already have an account?{" "}
            <a href="/signin" className="text-primary hover:text-primary/80 font-semibold transition-colors">
              Sign in
            </a>
          </p>
        </div>
      </div>

      {/* Wallet selection modal */}
      <WalletSelectModal
        open={walletModal}
        onOpenChange={setWalletModal}
        onSuccess={() => navigate("/")}
      />
    </div>
  );
}
