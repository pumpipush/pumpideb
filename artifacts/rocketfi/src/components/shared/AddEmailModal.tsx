/**
 * AddEmailModal — lets wallet-only users link an email address or Google
 * account to their profile so they don't lose access if they switch wallets.
 *
 * Shows two tabs:
 *   1. Email OTP  — enter email → receive 6-digit code → save
 *   2. Google     — one-click OAuth via @react-oauth/google implicit flow
 */

import { useState } from "react";
import { X, Loader2, ArrowRight, Mail, CheckCircle2 } from "lucide-react";
import { useGoogleLogin } from "@react-oauth/google";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

/* ── Google button ───────────────────────────────────────────────────────── */

function GoogleLinkButton({
  loading,
  onLoading,
  onSuccess,
  onError,
}: {
  loading: boolean;
  onLoading: (v: boolean) => void;
  onSuccess: (token: string) => void;
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

/* ── types ───────────────────────────────────────────────────────────────── */

type Tab = "email" | "google";
type EmailStep = "enter" | "verify" | "done";

interface AddEmailModalProps {
  open: boolean;
  onClose: () => void;
}

/* ── Main modal ──────────────────────────────────────────────────────────── */

export function AddEmailModal({ open, onClose }: AddEmailModalProps) {
  const { linkEmailSend, linkEmailVerify, linkGoogle } = useAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>("email");

  // email OTP state
  const [email, setEmail]     = useState("");
  const [code, setCode]       = useState("");
  const [step, setStep]       = useState<EmailStep>("enter");
  const [emailLoading, setEmailLoading] = useState(false);

  // google state
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleDone, setGoogleDone]       = useState(false);

  if (!open) return null;

  function reset() {
    setEmail("");
    setCode("");
    setStep("enter");
    setEmailLoading(false);
    setGoogleLoading(false);
    setGoogleDone(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  // ── Email OTP flow ──────────────────────────────────────────────────────
  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || emailLoading) return;
    setEmailLoading(true);
    try {
      await linkEmailSend(email.trim());
      setStep("verify");
    } catch (err) {
      toast({ title: "Error", description: (err as Error).message, variant: "destructive" });
    } finally {
      setEmailLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || emailLoading) return;
    setEmailLoading(true);
    try {
      await linkEmailVerify(email.trim(), code.trim());
      setStep("done");
    } catch (err) {
      toast({ title: "Error", description: (err as Error).message, variant: "destructive" });
    } finally {
      setEmailLoading(false);
    }
  }

  // ── Google flow ──────────────────────────────────────────────────────────
  async function handleGoogleToken(accessToken: string) {
    try {
      await linkGoogle(accessToken);
      setGoogleDone(true);
      toast({ title: "Google account linked", description: "Your profile is now recoverable via Google." });
    } catch (err) {
      toast({ title: "Error", description: (err as Error).message, variant: "destructive" });
    } finally {
      setGoogleLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />

      {/* panel */}
      <div
        className="relative w-full sm:max-w-sm bg-[#0f1117] border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden"
        style={{ zIndex: 1 }}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-white/[0.06]">
          <div>
            <p className="text-[15px] font-semibold">Backup login</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Add a recovery method so you can access your account if you lose wallet access
            </p>
          </div>
          <button
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/[0.06] text-muted-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* tabs */}
        <div className="flex border-b border-white/[0.06] px-5">
          {(["email", "google"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); reset(); }}
              className={`py-3 px-4 text-sm font-medium capitalize border-b-2 transition-colors ${
                tab === t
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "email" ? "Email" : "Google"}
            </button>
          ))}
        </div>

        {/* body */}
        <div className="px-5 py-5">

          {/* ── Email tab ── */}
          {tab === "email" && step === "enter" && (
            <form onSubmit={handleSend} className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                We'll send a 6-digit code to verify your email address.
              </p>
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-10 px-3 rounded-lg bg-white/[0.05] border border-white/10 text-sm placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/60"
              />
              <button
                type="submit"
                disabled={emailLoading || !email.trim()}
                className="h-10 w-full rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
              >
                {emailLoading
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <><Mail className="w-4 h-4" /> Send code</>
                }
              </button>
            </form>
          )}

          {tab === "email" && step === "verify" && (
            <form onSubmit={handleVerify} className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Enter the 6-digit code sent to <strong className="text-foreground">{email}</strong>.
              </p>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                required
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full h-10 px-3 rounded-lg bg-white/[0.05] border border-white/10 text-sm text-center tracking-[0.4em] font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/60"
              />
              <button
                type="submit"
                disabled={emailLoading || code.length !== 6}
                className="h-10 w-full rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground text-sm font-semibold flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
              >
                {emailLoading
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <><ArrowRight className="w-4 h-4" /> Verify</>
                }
              </button>
              <button
                type="button"
                onClick={() => { setStep("enter"); setCode(""); }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors text-center"
              >
                Use a different email
              </button>
            </form>
          )}

          {tab === "email" && step === "done" && (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-400" />
              <p className="text-sm font-semibold">Email linked!</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                You can now sign in with <strong className="text-foreground">{email}</strong> if you ever lose wallet access.
              </p>
              <button
                onClick={handleClose}
                className="mt-1 h-9 px-6 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] text-sm font-medium transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {/* ── Google tab ── */}
          {tab === "google" && !googleDone && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Link your Google account as a backup login. One click, no password required.
              </p>
              {GOOGLE_CLIENT_ID ? (
                <GoogleLinkButton
                  loading={googleLoading}
                  onLoading={setGoogleLoading}
                  onSuccess={handleGoogleToken}
                  onError={(msg) => toast({ title: "Error", description: msg, variant: "destructive" })}
                />
              ) : (
                <p className="text-xs text-amber-400 text-center">
                  Google sign-in is not configured in this environment.
                </p>
              )}
            </div>
          )}

          {tab === "google" && googleDone && (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-400" />
              <p className="text-sm font-semibold">Google account linked!</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                You can now sign in with Google if you ever lose wallet access.
              </p>
              <button
                onClick={handleClose}
                className="mt-1 h-9 px-6 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] text-sm font-medium transition-colors"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
