import { useState } from "react";
import { X, Rocket, Wallet, ArrowRight } from "lucide-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { WalletSelectModal } from "./WalletSelectModal";

type Mode = "signin" | "signup";

interface AuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultMode?: Mode;
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0 fill-white/70">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844a9.59 9.59 0 012.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  );
}

function SocialBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 h-10 flex items-center justify-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] text-sm text-white/60 font-medium hover:bg-white/[0.08] hover:text-white transition-all active:scale-[0.97]"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export function AuthModal({ open, onOpenChange, defaultMode = "signin" }: AuthModalProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [walletModal, setWalletModal] = useState(false);
  const [email, setEmail] = useState("");

  if (!open) return null;

  function close() {
    onOpenChange(false);
  }

  function handleComingSoon() {
    toast({
      title: "Coming soon",
      description: "Use Connect Wallet to sign in now.",
    });
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
        <div className="relative w-full max-w-[400px] pointer-events-auto animate-in zoom-in-95 fade-in duration-200">
          {/* Card */}
          <div className="relative rounded-2xl bg-[#0c1220] border border-white/[0.08] shadow-[0_24px_80px_rgba(0,0,0,0.7)] overflow-hidden">
            {/* Top accent line */}
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

            {/* Close */}
            <button
              onClick={close}
              className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-full bg-white/[0.05] hover:bg-white/[0.1] text-white/40 hover:text-white/80 transition-all"
            >
              <X className="w-3.5 h-3.5" />
            </button>

            <div className="px-6 pt-8 pb-7">
              {/* App icon + heading */}
              <div className="flex flex-col items-center text-center mb-7">
                <div className="w-12 h-12 rounded-2xl bg-primary flex items-center justify-center shadow-[0_0_28px_rgba(59,130,246,0.45)] mb-4">
                  <Rocket className="w-6 h-6 text-white" />
                </div>
                <h2 className="text-[22px] font-bold text-white leading-tight">
                  {mode === "signin" ? "Welcome back" : "Create account"}
                </h2>
                <p className="text-sm text-white/40 mt-1">
                  {mode === "signin"
                    ? "Sign in to start trading"
                    : "Start trading and launching tokens today"}
                </p>
              </div>

              {/* Primary CTA */}
              <button
                type="button"
                onClick={() => setWalletModal(true)}
                className="w-full h-12 rounded-xl bg-primary text-white text-sm font-semibold flex items-center justify-center gap-2.5 hover:bg-primary/90 active:scale-[0.98] transition-all shadow-[0_0_24px_rgba(59,130,246,0.3)] mb-3"
              >
                <Wallet className="w-4 h-4" />
                Connect Wallet
              </button>

              {/* Social */}
              <div className="flex gap-2 mb-5">
                <SocialBtn icon={<GoogleIcon />} label="Google" onClick={handleComingSoon} />
                <SocialBtn icon={<GitHubIcon />} label="GitHub" onClick={handleComingSoon} />
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-white/[0.07]" />
                <span className="text-[10px] text-white/25 uppercase tracking-[0.12em] shrink-0">
                  or continue with email
                </span>
                <div className="flex-1 h-px bg-white/[0.07]" />
              </div>

              {/* Email input */}
              <div className="relative mb-5">
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleComingSoon()}
                  className="w-full h-11 rounded-lg bg-white/[0.04] border border-white/[0.08] px-3.5 pr-12 text-sm text-white placeholder:text-white/20 outline-none focus:border-primary/40 focus:bg-white/[0.06] transition-all"
                />
                <button
                  type="button"
                  onClick={handleComingSoon}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-white/40 hover:text-white/80 transition-all"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Toggle sign in / sign up */}
              <p className="text-center text-xs text-white/30">
                {mode === "signin" ? (
                  <>
                    Don&apos;t have an account?{" "}
                    <button
                      onClick={() => setMode("signup")}
                      className="text-primary hover:text-primary/80 font-semibold transition-colors"
                    >
                      Sign up
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{" "}
                    <button
                      onClick={() => setMode("signin")}
                      className="text-primary hover:text-primary/80 font-semibold transition-colors"
                    >
                      Sign in
                    </button>
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Wallet select nested modal */}
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
