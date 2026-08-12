/**
 * AuthModal — pump.fun-style unified sign-in modal.
 *
 * Sign-in options:
 *   1. Google (via Google Identity Services)
 *   2. Apple / GitHub / X  (UI shown, marked "coming soon")
 *   3. Email OTP (fully functional — code sent via Resend or logged to console in dev)
 *   4. Connect wallet directly (Solflare, Phantom, more)
 *
 * Users who sign in via Google/email can browse and create a profile without
 * ever connecting a wallet. Wallet is only required for on-chain actions (trading).
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { X, ArrowRight, ChevronRight, Loader2 } from "lucide-react";
import { SiApple, SiGithub, SiX } from "react-icons/si";
import { useAuth } from "@/contexts/AuthContext";
import { useWallet } from "@/contexts/WalletContext";
import { WalletSelectModal } from "./WalletSelectModal";
import { isWalletInstalled, WALLET_DESCRIPTORS } from "@/lib/solana";
import { cn } from "@/lib/utils";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const LAST_WALLET_KEY = "pumpi_last_wallet";

/* ── types ──────────────────────────────────────────────────────────────── */

interface AuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultMode?: "signin" | "signup";
}

type Step = "main" | "otp";

/* ── component ───────────────────────────────────────────────────────────── */

export function AuthModal({ open, onOpenChange }: AuthModalProps) {
  const { signInWithGoogle, sendEmailOTP, verifyEmailOTP } = useAuth();
  const { connectWallet } = useWallet();

  const [step, setStep]           = useState<Step>("main");
  const [email, setEmail]         = useState("");
  const [otp, setOtp]             = useState("");
  const [loading, setLoading]     = useState<string | null>(null); // which button is loading
  const [error, setError]         = useState<string | null>(null);
  const [moreWallets, setMoreWallets] = useState(false);
  const gsiContainerRef           = useRef<HTMLDivElement>(null);
  const gsiInitialized            = useRef(false);

  const recentWallet = localStorage.getItem(LAST_WALLET_KEY);

  function close() { onOpenChange(false); }
  function reset() { setStep("main"); setEmail(""); setOtp(""); setError(null); setLoading(null); }

  // ── Google Identity Services ──────────────────────────────────────────────

  const handleGoogleCredential = useCallback(async (credential: string) => {
    setLoading("google");
    setError(null);
    try {
      await signInWithGoogle(credential);
      reset();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Google sign-in failed");
    } finally {
      setLoading(null);
    }
  }, [signInWithGoogle]);

  useEffect(() => {
    if (!open || !GOOGLE_CLIENT_ID || gsiInitialized.current) return;

    const initGSI = () => {
      if (!window.google || !gsiContainerRef.current) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (r: { credential: string }) => handleGoogleCredential(r.credential),
        ux_mode: "popup",
        auto_select: false,
      });
      window.google.accounts.id.renderButton(gsiContainerRef.current, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "continue_with",
      });
      gsiInitialized.current = true;
    };

    if (window.google) {
      initGSI();
    } else {
      const existing = document.querySelector('script[src*="accounts.google.com/gsi"]');
      if (!existing) {
        const s = document.createElement("script");
        s.src = "https://accounts.google.com/gsi/client";
        s.async = true;
        s.defer = true;
        s.onload = initGSI;
        document.head.appendChild(s);
      } else {
        existing.addEventListener("load", initGSI);
      }
    }
  }, [open, handleGoogleCredential]);

  const handleGoogleClick = () => {
    if (!GOOGLE_CLIENT_ID) {
      setError("Google sign-in is not configured yet.");
      return;
    }
    const inner = gsiContainerRef.current?.querySelector("div[role='button']") as HTMLElement | null;
    inner?.click();
  };

  // ── Email OTP ─────────────────────────────────────────────────────────────

  const handleEmailSend = async () => {
    if (!email || !email.includes("@")) { setError("Enter a valid email address"); return; }
    setLoading("email"); setError(null);
    try {
      await sendEmailOTP(email);
      setStep("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send code");
    } finally {
      setLoading(null);
    }
  };

  const handleOTPVerify = async () => {
    if (otp.length < 6) { setError("Enter the 6-digit code"); return; }
    setLoading("otp"); setError(null);
    try {
      await verifyEmailOTP(email, otp);
      reset();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setLoading(null);
    }
  };

  // ── Wallet connect ────────────────────────────────────────────────────────

  const handleWalletConnect = async (descriptorName: string) => {
    const descriptor = WALLET_DESCRIPTORS.find(d => d.name === descriptorName);
    if (!descriptor) return;
    const provider = descriptor.getProvider();
    if (!provider) { window.open(descriptor.installUrl, "_blank"); return; }
    setLoading(`wallet_${descriptorName}`); setError(null);
    try {
      await connectWallet(provider, descriptor.name);
      reset();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed");
    } finally {
      setLoading(null);
    }
  };

  if (!open) return null;

  // ── Top 2 wallets to show inline ──────────────────────────────────────────
  const topWallets = WALLET_DESCRIPTORS.filter(d =>
    ["Phantom", "Solflare"].includes(d.name)
  );

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
        onClick={close}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="relative w-full max-w-[360px] pointer-events-auto animate-in zoom-in-95 fade-in duration-200">
          <div className="relative rounded-2xl bg-[#13141a] border border-white/[0.07] shadow-[0_24px_80px_rgba(0,0,0,0.8)] overflow-hidden">

            {/* Close */}
            <button
              onClick={close}
              className="absolute top-3.5 right-3.5 z-10 w-7 h-7 flex items-center justify-center rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-white/40 hover:text-white/80 transition-all"
            >
              <X className="w-3.5 h-3.5" />
            </button>

            {/* ── Hidden GSI container (invisible, used for click forwarding) ── */}
            <div
              ref={gsiContainerRef}
              className="absolute opacity-0 pointer-events-none top-0 left-0"
              aria-hidden
            />

            <div className="px-5 pt-6 pb-5 flex flex-col gap-4">

              {/* Header */}
              <div className="flex flex-col items-center gap-1 pb-1">
                <h2 className="text-[18px] font-bold text-white leading-tight">
                  {step === "otp" ? "Check your email" : "Welcome back"}
                </h2>
                <p className="text-[13px] text-white/40 text-center">
                  {step === "otp"
                    ? `We sent a 6-digit code to ${email}`
                    : "Sign in to start trading."}
                </p>
              </div>

              {step === "main" ? (
                <>
                  {/* ── Google ── */}
                  <button
                    onClick={handleGoogleClick}
                    disabled={loading === "google"}
                    className="w-full h-11 rounded-xl bg-white hover:bg-white/90 active:scale-[0.98] transition-all flex items-center justify-center gap-2.5 font-medium text-[13.5px] text-[#1f1f1f] shadow-sm disabled:opacity-60"
                  >
                    {loading === "google" ? (
                      <Loader2 className="w-4 h-4 animate-spin text-gray-600" />
                    ) : (
                      <img
                        src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
                        alt="Google"
                        className="w-4.5 h-4.5"
                        style={{ width: 18, height: 18 }}
                      />
                    )}
                    Continue with Google
                  </button>

                  {/* ── Apple / GitHub / X ── */}
                  <div className="flex items-center gap-2">
                    {[
                      { icon: <SiApple className="w-[18px] h-[18px]" />, label: "Apple" },
                      { icon: <SiGithub className="w-[18px] h-[18px]" />, label: "GitHub" },
                      { icon: <SiX className="w-[16px] h-[16px]" />, label: "X" },
                    ].map(({ icon, label }) => (
                      <button
                        key={label}
                        title={`${label} — coming soon`}
                        disabled
                        className="flex-1 h-11 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white/50 cursor-not-allowed opacity-50 transition-all"
                      >
                        {icon}
                      </button>
                    ))}
                  </div>

                  {/* ── Email ── */}
                  <div className="relative flex items-center">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); setError(null); }}
                      onKeyDown={(e) => e.key === "Enter" && handleEmailSend()}
                      placeholder="you@example.com"
                      className="w-full h-11 rounded-xl bg-white/[0.06] border border-white/[0.08] pl-3.5 pr-11 text-[13.5px] text-white placeholder:text-white/25 outline-none focus:border-white/20 focus:bg-white/[0.08] transition-all"
                    />
                    <button
                      onClick={handleEmailSend}
                      disabled={loading === "email" || !email}
                      className="absolute right-1.5 w-8 h-8 rounded-lg bg-primary/90 hover:bg-primary disabled:opacity-40 flex items-center justify-center transition-all active:scale-90"
                    >
                      {loading === "email"
                        ? <Loader2 className="w-3.5 h-3.5 text-black animate-spin" />
                        : <ArrowRight className="w-3.5 h-3.5 text-black" />}
                    </button>
                  </div>

                  {/* ── Divider ── */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-white/[0.07]" />
                    <span className="text-[11px] text-white/30 whitespace-nowrap">or connect a wallet</span>
                    <div className="flex-1 h-px bg-white/[0.07]" />
                  </div>

                  {/* ── Wallet list ── */}
                  <div className="flex flex-col gap-1">
                    {topWallets.map((d) => {
                      const isRecent   = recentWallet === d.name;
                      const isLoading  = loading === `wallet_${d.name}`;
                      const imgSrc = `/wallets/${d.name.toLowerCase()}.jpeg`;
                      return (
                        <button
                          key={d.name}
                          onClick={() => handleWalletConnect(d.name)}
                          disabled={!!loading}
                          className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-white/[0.05] active:bg-white/[0.08] transition-all disabled:opacity-60"
                        >
                          <img
                            src={imgSrc}
                            alt={d.name}
                            className="w-8 h-8 rounded-lg object-cover shrink-0"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                          />
                          <span className="flex-1 text-left text-[13.5px] font-medium text-white">
                            {d.name}
                          </span>
                          {isLoading && <Loader2 className="w-4 h-4 text-white/40 animate-spin shrink-0" />}
                          {isRecent && !isLoading && (
                            <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-md shrink-0">
                              RECENT
                            </span>
                          )}
                        </button>
                      );
                    })}

                    {/* More wallets */}
                    <button
                      onClick={() => setMoreWallets(true)}
                      className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-white/[0.05] transition-all"
                    >
                      <div className="w-8 h-8 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center shrink-0">
                        <ChevronRight className="w-4 h-4 text-white/40" />
                      </div>
                      <span className="flex-1 text-left text-[13.5px] font-medium text-white/70">
                        More wallets
                      </span>
                      <ChevronRight className="w-4 h-4 text-white/30 shrink-0" />
                    </button>
                  </div>
                </>
              ) : (
                /* ── OTP step ── */
                <>
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={otp}
                      onChange={(e) => { setOtp(e.target.value.replace(/\D/g, "")); setError(null); }}
                      onKeyDown={(e) => e.key === "Enter" && handleOTPVerify()}
                      placeholder="Enter 6-digit code"
                      autoFocus
                      className="w-full h-12 rounded-xl bg-white/[0.06] border border-white/[0.08] px-4 text-[15px] text-white placeholder:text-white/25 text-center tracking-[6px] outline-none focus:border-white/20 focus:bg-white/[0.08] transition-all"
                    />
                  </div>

                  <button
                    onClick={handleOTPVerify}
                    disabled={loading === "otp" || otp.length < 6}
                    className="w-full h-11 rounded-xl bg-primary text-primary-foreground text-[13.5px] font-semibold flex items-center justify-center gap-2 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50"
                  >
                    {loading === "otp" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Verify Code"}
                  </button>

                  <button
                    onClick={() => { setStep("main"); setOtp(""); setError(null); }}
                    className="text-[12px] text-white/30 hover:text-white/60 transition-colors text-center"
                  >
                    ← Back · Resend code
                  </button>
                </>
              )}

              {/* Error */}
              {error && (
                <p className="text-[12px] text-red-400 text-center -mt-1">{error}</p>
              )}

              {/* Terms */}
              <p className="text-[10.5px] text-white/20 text-center -mt-1">
                By continuing you agree to our{" "}
                <span className="text-white/35 hover:text-white/50 cursor-pointer transition-colors">
                  Terms of Service
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Full wallet picker (opened via "More wallets") */}
      <WalletSelectModal
        open={moreWallets}
        onOpenChange={setMoreWallets}
        onSuccess={() => { setMoreWallets(false); reset(); close(); }}
      />
    </>
  );
}
