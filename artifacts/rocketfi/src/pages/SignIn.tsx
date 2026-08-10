import { useState } from "react";
import { useLocation } from "wouter";
import { Wallet, Rocket } from "lucide-react";
import { WalletSelectModal } from "@/components/shared/WalletSelectModal";

/* ─── Page ───────────────────────────────────────────────────────────────────── */
export default function SignIn() {
  const [, navigate] = useLocation();
  const [walletModal, setWalletModal] = useState(false);

  return (
    <div className="min-h-[100dvh] w-full max-w-full overflow-x-hidden flex bg-[#060d1a]">

      {/* ── Left branding panel (desktop only) ── */}
      <div className="hidden lg:flex lg:w-[480px] xl:w-[520px] shrink-0 flex-col relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0a1628] via-[#060d1a] to-[#050b18]" />
        <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[120px] -translate-x-1/3 -translate-y-1/3" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-violet-500/8 rounded-full blur-[100px] translate-x-1/3 translate-y-1/3" />
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImciIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSAwIDYwIEwgNjAgMCIgc3Ryb2tlPSJyZ2JhKDU5LDEzMCwyNDYsMC4wNCkiIHN0cm9rZS13aWR0aD0iMSIvPjwvcGF0dGVybj48L2RlZnM+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0idXJsKCNnKSIvPjwvc3ZnPg==')] opacity-60" />

        <div className="relative flex flex-col flex-1 p-10 xl:p-14">
          {/* Logo */}
          <div className="flex items-center gap-2.5 mb-auto">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-[0_0_20px_rgba(59,130,246,0.5)]">
              <Rocket className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold text-white tracking-tight">Mintix <span className="text-primary">fun</span></span>
          </div>

          {/* Hero copy */}
          <div className="mt-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              <span className="text-xs font-semibold text-primary">Live on Solana</span>
            </div>
            <h1 className="text-4xl xl:text-5xl font-bold text-white leading-tight tracking-tight mb-4">
              Launch tokens.<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-violet-400">
                Trade instantly.
              </span>
            </h1>
            <p className="text-white/50 text-base leading-relaxed max-w-sm">
              No presales. No team allocations. Pure price discovery through the bonding curve.
            </p>
          </div>

          {/* Stats strip */}
          <div className="grid grid-cols-3 gap-4 p-5 rounded-2xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-sm">
            {[
              { label: "Tokens launched", value: "12,400+" },
              { label: "Total volume",    value: "$4.8M" },
              { label: "Active traders",  value: "38K" },
            ].map(({ label, value }) => (
              <div key={label} className="text-center">
                <div className="text-lg font-bold text-white">{value}</div>
                <div className="text-[11px] text-white/40 mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex-1 flex flex-col items-center justify-center p-5 sm:p-8 relative">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[1px] bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

        {/* Ambient glow */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/[0.04] rounded-full blur-[120px]" />
        </div>

        {/* Mobile logo */}
        <div className="lg:hidden flex items-center gap-2.5 mb-10">
          <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center shadow-[0_0_16px_rgba(59,130,246,0.5)]">
            <Rocket className="w-4 h-4 text-white" />
          </div>
          <span className="text-lg font-bold text-white tracking-tight">Mintix <span className="text-primary">fun</span></span>
        </div>

        <div className="w-full max-w-[380px] relative">
          {/* Header */}
          <div className="mb-10 text-center">
            <h2 className="text-3xl font-bold text-white mb-3 tracking-tight">Sign in to Mintix.fun</h2>
            <p className="text-sm text-white/40 leading-relaxed">
              Connect your Solana wallet to start trading<br className="hidden sm:block" /> and launching tokens.
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
            New to Mintix?{" "}
            <a href="/signup" className="text-primary hover:text-primary/80 font-semibold transition-colors">
              Get started
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
