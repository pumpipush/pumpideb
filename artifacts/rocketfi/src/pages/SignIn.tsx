import { useState } from "react";
import { useLocation } from "wouter";
import { Eye, EyeOff, Wallet, Rocket, ArrowRight, Loader2 } from "lucide-react";
import { useWallet } from "@/contexts/WalletContext";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/* ─── tiny helpers ─────────────────────────────────────────────────────────── */
function isValidEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function fakeAddress(seed: string) {
  // deterministic-ish hex from email seed (demo only)
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return "0x" + Math.abs(h).toString(16).padStart(8, "0") + seed.replace(/\W/g, "").slice(0, 32).padEnd(32, "0");
}

/* ─── Social button ─────────────────────────────────────────────────────────── */
function SocialBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg border border-white/10 bg-white/[0.04] text-sm text-white/70 font-medium hover:bg-white/[0.08] hover:text-white hover:border-white/20 transition-all duration-150 active:scale-[0.98]"
    >
      {icon}
      {label}
    </button>
  );
}

/* ─── Input ─────────────────────────────────────────────────────────────────── */
function Field({
  label, id, type = "text", value, onChange, error, placeholder,
  suffix,
}: {
  label: string; id: string; type?: string; value: string;
  onChange: (v: string) => void; error?: string; placeholder?: string;
  suffix?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-semibold text-white/50 uppercase tracking-widest">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={id}
          className={cn(
            "w-full h-11 rounded-lg bg-white/[0.04] border px-3.5 text-sm text-white placeholder:text-white/20 outline-none transition-all duration-150",
            "focus:bg-white/[0.07] focus:shadow-[0_0_0_2px_rgba(59,130,246,0.35)]",
            error ? "border-red-500/60" : "border-white/10 focus:border-primary/50",
            suffix && "pr-11"
          )}
        />
        {suffix && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors">
            {suffix}
          </div>
        )}
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────────── */
export default function SignIn() {
  const [, navigate] = useLocation();
  const { connect } = useWallet();
  const { toast } = useToast();

  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [errors, setErrors]     = useState<{ email?: string; password?: string }>({});

  function validate() {
    const e: typeof errors = {};
    if (!email)               e.email    = "Email is required";
    else if (!isValidEmail(email)) e.email = "Enter a valid email address";
    if (!password)            e.password = "Password is required";
    else if (password.length < 6) e.password = "Password must be at least 6 characters";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    // Simulate network request (replace with real auth call)
    await new Promise((r) => setTimeout(r, 1100));
    connect(fakeAddress(email));
    toast({ title: "Welcome back!", description: "You're now signed in." });
    navigate("/");
  }

  function handleWallet() {
    const addr = `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    connect(addr);
    toast({ title: "Wallet connected", description: "Signed in with your wallet." });
    navigate("/");
  }

  function handleGoogle() {
    toast({ title: "Google Sign-In", description: "OAuth integration coming soon." });
  }

  return (
    <div className="min-h-[100dvh] flex bg-[#060d1a]">

      {/* ── Left branding panel (desktop only) ── */}
      <div className="hidden lg:flex lg:w-[480px] xl:w-[520px] shrink-0 flex-col relative overflow-hidden">
        {/* Background layers */}
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
              <span className="text-xs font-semibold text-primary">Live on Base Network</span>
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
              { label: "Total volume", value: "$4.8M" },
              { label: "Active traders", value: "38K" },
            ].map(({ label, value }) => (
              <div key={label} className="text-center">
                <div className="text-lg font-bold text-white">{value}</div>
                <div className="text-[11px] text-white/40 mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex-1 flex flex-col items-center justify-center p-5 sm:p-8 relative">
        {/* Subtle top glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[1px] bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

        {/* Mobile logo */}
        <div className="lg:hidden flex items-center gap-2.5 mb-8">
          <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center shadow-[0_0_16px_rgba(59,130,246,0.5)]">
            <Rocket className="w-4 h-4 text-white" />
          </div>
          <span className="text-lg font-bold text-white tracking-tight">Mintix <span className="text-primary">fun</span></span>
        </div>

        <div className="w-full max-w-[400px]">
          {/* Header */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white mb-1.5">Welcome back</h2>
            <p className="text-sm text-white/40">Sign in to your account to continue</p>
          </div>

          {/* Social buttons */}
          <div className="flex gap-3 mb-6">
            <SocialBtn
              label="Google"
              onClick={handleGoogle}
              icon={
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
              }
            />
            <SocialBtn
              label="GitHub"
              onClick={handleGoogle}
              icon={
                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-white/80">
                  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
                </svg>
              }
            />
          </div>

          {/* Divider */}
          <div className="relative flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-white/[0.08]" />
            <span className="text-[11px] text-white/30 font-medium uppercase tracking-widest shrink-0">or</span>
            <div className="flex-1 h-px bg-white/[0.08]" />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Field
              id="email" label="Email address" type="email"
              value={email} onChange={setEmail}
              placeholder="you@example.com" error={errors.email}
            />
            <Field
              id="current-password" label="Password" type={showPw ? "text" : "password"}
              value={password} onChange={setPassword}
              placeholder="••••••••" error={errors.password}
              suffix={
                <button type="button" onClick={() => setShowPw(!showPw)} className="p-0.5">
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              }
            />

            <div className="flex justify-end">
              <button type="button" className="text-xs text-primary/80 hover:text-primary transition-colors">
                Forgot password?
              </button>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 rounded-lg bg-primary text-white text-sm font-semibold flex items-center justify-center gap-2 hover:bg-primary/90 active:scale-[0.98] transition-all duration-150 shadow-[0_0_20px_rgba(59,130,246,0.25)] disabled:opacity-60 disabled:cursor-not-allowed mt-2"
            >
              {loading
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</>
                : <><span>Sign in</span><ArrowRight className="w-4 h-4" /></>
              }
            </button>
          </form>

          {/* Wallet divider */}
          <div className="relative flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-white/[0.06]" />
            <span className="text-[11px] text-white/20 font-medium uppercase tracking-widest shrink-0">or connect</span>
            <div className="flex-1 h-px bg-white/[0.06]" />
          </div>

          {/* Wallet button */}
          <button
            type="button"
            onClick={handleWallet}
            className="w-full h-11 rounded-lg border border-white/10 bg-white/[0.04] text-sm text-white/70 font-medium flex items-center justify-center gap-2.5 hover:bg-white/[0.08] hover:text-white hover:border-white/20 transition-all duration-150 active:scale-[0.98]"
          >
            <Wallet className="w-4 h-4 text-primary" />
            Connect Wallet
          </button>

          {/* Footer */}
          <p className="text-center text-sm text-white/30 mt-8">
            Don&apos;t have an account?{" "}
            <a href="/signup" className="text-primary hover:text-primary/80 font-semibold transition-colors">
              Create one
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
