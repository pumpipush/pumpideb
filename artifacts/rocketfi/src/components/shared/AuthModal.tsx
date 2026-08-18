/**
 * AuthModal — unified sign-in modal.
 *
 * Sign-in options:
 *   1. Google OAuth (one-tap popup via @react-oauth/google)
 *   2. Connect wallet directly (all installed wallets detected automatically)
 */

import { useState } from "react";
import { X, Loader2, Wallet, Mail, ArrowLeft } from "lucide-react";
import { useGoogleLogin } from "@react-oauth/google";
import { useAuth } from "@/contexts/AuthContext";
import { useWallet } from "@/contexts/WalletContext";
import { useToast } from "@/hooks/use-toast";
import { isWalletInstalled, isMobile, WALLET_DESCRIPTORS } from "@/lib/solana";

const LAST_WALLET_KEY = "pumpi_last_wallet";
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

/* ── Google button — only mounted when a client ID is configured ─────────── */

function GoogleSignInButton({
  loading,
  onLoading,
  onSuccess,
  onError,
}: {
  loading: boolean;
  onLoading: (v: boolean) => void;
  onSuccess: (accessToken: string) => void;
  onError: (msg: string) => void;
}) {
  const login = useGoogleLogin({
    prompt: "select_account",
    onSuccess: (r) => {
      const token = r.access_token;
      if (!token) {
        onError("No token received from Google — please try again");
        onLoading(false);
        return;
      }
      onSuccess(token);
    },
    onError: (e) => {
      onLoading(false);
      onError(e.error_description ?? e.error ?? "Google sign-in failed");
    },
    onNonOAuthError: () => {
      onLoading(false);
    },
  });

  return (
    <button
      onClick={() => { onLoading(true); login(); }}
      disabled={loading}
      className="w-full h-11 rounded-xl bg-white hover:bg-white/90 active:scale-[0.98] disabled:opacity-50 transition-all flex items-center justify-center gap-2.5 text-[13.5px] font-semibold text-gray-800"
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.47 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
      )}
      Continue with Google
    </button>
  );
}

/* ── types ──────────────────────────────────────────────────────────────── */

interface AuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultMode?: "signin" | "signup";
}

/* ── component ───────────────────────────────────────────────────────────── */

export function AuthModal({ open, onOpenChange }: AuthModalProps) {
  const { handleGoogleToken, loginOrLinkWallet, linkGoogle, mergeWallet, socialUser, loginWithEmailSend, loginWithEmailVerify } = useAuth();
  const { connectWallet, signMessage } = useWallet();
  const { toast } = useToast();

  const [loading, setLoading]       = useState<string | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [mergeNonce, setMergeNonce] = useState<string | null>(null);
  const [merging, setMerging]       = useState(false);
  const mobile = isMobile();

  // ── Email OTP state ────────────────────────────────────────────────────────
  const [emailView, setEmailView]   = useState<"input" | "otp">("input");
  const [emailVal, setEmailVal]     = useState("");
  const [otpVal, setOtpVal]         = useState("");

  const recentWallet = localStorage.getItem(LAST_WALLET_KEY);

  function close() { onOpenChange(false); }
  function reset() {
    setError(null); setLoading(null); setMergeNonce(null);
    setEmailView("input"); setEmailVal(""); setOtpVal("");
  }

  // ── Email flow handlers ────────────────────────────────────────────────────
  const handleEmailSend = async () => {
    if (!emailVal.trim() || loading) return;
    setLoading("email"); setError(null);
    try {
      await loginWithEmailSend(emailVal.trim());
      setEmailView("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send code");
    } finally {
      setLoading(null);
    }
  };

  const handleEmailVerify = async () => {
    if (!otpVal.trim() || loading) return;
    setLoading("email_verify"); setError(null);
    try {
      const { isNewAccount } = await loginWithEmailVerify(emailVal.trim(), otpVal.trim());
      reset(); close();
      toast({
        title: isNewAccount ? "Welcome to Pumpi! 🚀" : "Signed in",
        description: isNewAccount ? "Account created. Set a username in your profile." : `Signed in as ${emailVal}`,
        variant: "success" as never,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setLoading(null);
    }
  };

  // ── Google ─────────────────────────────────────────────────────────────────
  const handleGoogleSuccess = async (accessToken: string) => {
    setLoading("google");
    setError(null);
    try {
      if (socialUser?.authType === "wallet") {
        await linkGoogle(accessToken);
        reset();
        close();
        toast({
          title: "Google account linked",
          description: "Your Google account has been connected to your wallet profile.",
          variant: "success" as never,
        });
        return;
      }

      const { isNewAccount, wasLinked } = await handleGoogleToken(accessToken);
      reset();
      close();
      if (wasLinked) {
        toast({
          title: "Google account linked",
          description: "Your Google account has been connected to your existing profile.",
          variant: "success" as never,
        });
      } else if (isNewAccount) {
        toast({
          title: "Welcome to Pumpi! 🚀",
          description: "Your account is ready. Set a custom username in your profile.",
          variant: "success" as never,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/cancel|dismiss|closed|popup/i.test(msg)) {
        setError("Sign-in cancelled.");
      } else if (/network|fetch|timeout|offline/i.test(msg)) {
        setError("Connection failed — check your internet and try again.");
      } else {
        setError("Google sign-in failed. Please try again.");
      }
    } finally {
      setLoading(null);
    }
  };

  // ── Wallet connect ────────────────────────────────────────────────────────
  const handleWalletConnect = async (descriptorName: string) => {
    const descriptor = WALLET_DESCRIPTORS.find(d => d.name === descriptorName);
    if (!descriptor) return;
    if (mobile) {
      const dappUrl = encodeURIComponent(window.location.href);
      window.location.href = descriptor.deepLinkBase
        ? `${descriptor.deepLinkBase}${dappUrl}`
        : descriptor.installUrl;
      return;
    }
    const provider = descriptor.getProvider();
    if (!provider) { window.open(descriptor.installUrl, "_blank"); return; }
    setLoading(`wallet_${descriptorName}`); setError(null);
    try {
      const address = await connectWallet(provider, descriptor.name);
      try {
        const result = await loginOrLinkWallet(address, signMessage);
        if (result?.mergeNonce) {
          // Wallet already has its own account — surface merge confirmation inside this modal.
          setMergeNonce(result.mergeNonce);
          return; // keep modal open
        }
      } catch {
        // Non-fatal — wallet is connected even if sign/link fails (e.g. user dismissed).
      }
      reset();
      close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/reject|cancel|dismiss|denied/i.test(msg)) {
        setError("Connection cancelled.");
      } else if (/not installed|not found|no provider/i.test(msg)) {
        setError("Wallet extension not detected — please install it and try again.");
      } else {
        setError("Could not connect wallet — check your wallet extension and try again.");
      }
    } finally {
      setLoading(null);
    }
  };

  if (!open) return null;

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

            <div className="px-5 pt-6 pb-5 flex flex-col gap-4">

              {/* Header */}
              <div className="flex flex-col items-center gap-1 pb-1">
                <div className="w-12 h-12 rounded-2xl bg-white/[0.06] border border-white/[0.10] flex items-center justify-center mb-2 overflow-hidden">
                  <img src="/icon-192.png" alt="Pumpi" className="w-8 h-8 object-contain" />
                </div>
                <h2 className="text-[18px] font-bold text-white leading-tight">Welcome back</h2>
                <p className="text-[13px] text-white/40 text-center">Sign in to start trading.</p>
              </div>

              {/* Google */}
              {GOOGLE_CLIENT_ID && (
                <GoogleSignInButton
                  loading={loading === "google"}
                  onLoading={(v) => setLoading(v ? "google" : null)}
                  onSuccess={handleGoogleSuccess}
                  onError={(msg) => setError(msg)}
                />
              )}

              {/* Email — send step */}
              {emailView === "input" && (
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
                    <input
                      type="email"
                      placeholder="Email address"
                      value={emailVal}
                      onChange={(e) => setEmailVal(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleEmailSend()}
                      disabled={!!loading}
                      className="w-full h-11 rounded-xl bg-white/[0.06] border border-white/[0.08] pl-9 pr-3 text-[13.5px] text-white placeholder-white/30 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
                    />
                  </div>
                  <button
                    onClick={handleEmailSend}
                    disabled={!emailVal.trim() || !!loading}
                    className="h-11 px-4 rounded-xl text-[13px] font-semibold bg-white/[0.08] hover:bg-white/[0.13] active:bg-white/[0.16] disabled:opacity-40 transition-all text-white whitespace-nowrap flex items-center gap-1.5"
                  >
                    {loading === "email" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Send code"}
                  </button>
                </div>
              )}

              {/* Email — OTP step */}
              {emailView === "otp" && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-[12px] text-white/50">
                    <button onClick={() => { setEmailView("input"); setOtpVal(""); setError(null); }} className="hover:text-white/80 transition-colors">
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </button>
                    Code sent to <span className="text-white/70">{emailVal}</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="6-digit code"
                      value={otpVal}
                      onChange={(e) => setOtpVal(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      onKeyDown={(e) => e.key === "Enter" && handleEmailVerify()}
                      disabled={!!loading}
                      className="flex-1 h-11 rounded-xl bg-white/[0.06] border border-white/[0.08] px-3.5 text-[15px] text-white font-mono tracking-[0.2em] placeholder-white/30 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
                    />
                    <button
                      onClick={handleEmailVerify}
                      disabled={otpVal.length < 6 || !!loading}
                      className="h-11 px-4 rounded-xl text-[13px] font-semibold disabled:opacity-40 transition-all whitespace-nowrap flex items-center gap-1.5"
                      style={{ background: "#9aed2c", color: "#000" }}
                    >
                      {loading === "email_verify" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Verify"}
                    </button>
                  </div>
                </div>
              )}

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-white/[0.07]" />
                <span className="text-[11px] text-white/50 whitespace-nowrap">or connect a wallet</span>
                <div className="flex-1 h-px bg-white/[0.07]" />
              </div>

              {/* Wallet list */}
              <div className="flex flex-col gap-1">
                {WALLET_DESCRIPTORS.map((d) => {
                  const isRecent  = recentWallet === d.name;
                  const isLoading = loading === `wallet_${d.name}`;
                  const installed = mobile || isWalletInstalled(d);
                  return (
                    <button
                      key={d.name}
                      onClick={() => handleWalletConnect(d.name)}
                      disabled={!!loading}
                      className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-white/[0.05] active:bg-white/[0.08] transition-all disabled:opacity-60"
                    >
                      <img
                        src={`/wallets/${d.name.toLowerCase()}.jpeg`}
                        alt={d.name}
                        className="w-8 h-8 rounded-lg object-cover shrink-0"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                      />
                      <span className="flex-1 text-left text-[13.5px] font-medium text-white">
                        {d.name}
                      </span>
                      {isLoading && <Loader2 className="w-4 h-4 text-white/40 animate-spin shrink-0" />}
                      {!isLoading && installed && !isRecent && (
                        <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-md shrink-0">
                          Installed
                        </span>
                      )}
                      {!isLoading && isRecent && (
                        <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-md shrink-0">
                          Recent
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* ── Merge confirmation — wallet already has its own account ── */}
              {mergeNonce && (
                <div className="rounded-xl p-3.5 border border-white/10 bg-white/[0.04]">
                  <div className="flex items-center gap-2.5 mb-2">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(154,237,44,0.12)" }}>
                      <Wallet className="w-3.5 h-3.5" style={{ color: "#9aed2c" }} />
                    </div>
                    <p className="text-[13px] font-semibold text-white">Wallet has its own account</p>
                  </div>
                  <p className="text-[12px] text-white/50 leading-relaxed mb-3">
                    This wallet already has a separate Pumpi account. Merge to link it to your Google account — trade history stays intact.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        setMerging(true);
                        try {
                          await mergeWallet(mergeNonce);
                          reset();
                          close();
                          toast({ title: "Accounts merged", description: "Your wallet is now linked to your profile." });
                        } catch {
                          setError("Account merge failed. Please try again.");
                        } finally {
                          setMerging(false);
                        }
                      }}
                      disabled={merging}
                      className="flex-1 h-8 rounded-lg text-[12.5px] font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                      style={{ background: "#9aed2c", color: "#000" }}
                    >
                      {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : "Merge accounts"}
                    </button>
                    <button
                      onClick={() => { setMergeNonce(null); setError(null); }}
                      disabled={merging}
                      className="h-8 px-3 rounded-lg text-[12.5px] text-white/40 hover:text-white/70 border border-white/10 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <p className="text-[12px] text-red-400 text-center -mt-1">{error}</p>
              )}

              {/* Terms */}
              <p className="text-[10.5px] text-white/40 text-center -mt-1">
                By continuing you agree to our{" "}
                <a href="/terms" className="text-white/60 hover:text-white underline underline-offset-2 transition-colors">
                  Terms of Service
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
