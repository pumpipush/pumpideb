/**
 * DepositModal — Solana Pay deposit flow
 *
 * Flow:
 *   1. User picks an amount (presets or custom)
 *   2. "Generate QR" → POST /api/deposits/create → Solana Pay URL
 *   3. QR code shown; frontend polls GET /api/deposits/:reference/status every 3 s
 *   4. On confirmation: balance is credited, success screen shown
 */

import { useState, useEffect, useCallback, useRef } from "react";
import QRCode from "react-qr-code";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { ArrowDownToLine } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────
type Phase = "idle" | "creating" | "waiting" | "confirmed" | "expired" | "error";

interface DepositModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const PRESETS = [0.1, 0.5, 1, 5];
const POLL_MS = 3_000;

// ── Expiry countdown ───────────────────────────────────────────────────────────
function ExpiryCountdown({ expiresAt }: { expiresAt: Date }) {
  const [label, setLabel] = useState("");

  useEffect(() => {
    const tick = () => {
      const ms = expiresAt.getTime() - Date.now();
      if (ms <= 0) { setLabel("Expired"); return; }
      const m = Math.floor(ms / 60_000);
      const s = Math.floor((ms % 60_000) / 1_000);
      setLabel(`${m}:${s.toString().padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return (
    <p className="text-xs text-center text-muted-foreground">
      Expires in <span className="font-mono tabular-nums">{label}</span>
    </p>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export function DepositModal({ open, onOpenChange }: DepositModalProps) {
  const { authHeaders } = useAuth();
  const { toast } = useToast();

  const [preset, setPreset] = useState<number>(0.5);
  const [customAmt, setCustomAmt] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [reference, setReference] = useState<string | null>(null);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);

  const pollId = useRef<ReturnType<typeof setInterval> | null>(null);
  const jwtHeaders = authHeaders();
  const hasJwt = !!jwtHeaders.Authorization;

  // Effective SOL amount chosen by the user
  const effectiveAmt = useCustom ? parseFloat(customAmt || "0") : preset;

  const stopPolling = useCallback(() => {
    if (pollId.current) { clearInterval(pollId.current); pollId.current = null; }
  }, []);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  // Fetch in-app balance whenever the modal opens
  const fetchBalance = useCallback(async () => {
    if (!hasJwt) return;
    try {
      const res = await fetch("/api/deposits/balance", { headers: jwtHeaders });
      if (res.ok) {
        const data = await res.json() as { solBalance: string };
        setBalance(data.solBalance);
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasJwt]);

  useEffect(() => {
    if (open) fetchBalance();
  }, [open, fetchBalance]);

  const reset = useCallback(() => {
    stopPolling();
    setPhase("idle");
    setReference(null);
    setPayUrl(null);
    setExpiresAt(null);
    setTxSig(null);
  }, [stopPolling]);

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  // ── Create deposit session ─────────────────────────────────────────────────
  const createDeposit = async () => {
    if (!Number.isFinite(effectiveAmt) || effectiveAmt < 0.01) {
      toast({ title: "Invalid amount", description: "Minimum deposit is 0.01 SOL", variant: "destructive" });
      return;
    }
    if (!hasJwt) {
      toast({ title: "Sign in required", description: "Please sign in with Google to deposit", variant: "destructive" });
      return;
    }
    setPhase("creating");
    try {
      const res = await fetch("/api/deposits/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jwtHeaders },
        body: JSON.stringify({ amountSol: effectiveAmt }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to create deposit");
      }
      const data = await res.json() as { reference: string; solanaPayUrl: string; expiresAt: string };
      setReference(data.reference);
      setPayUrl(data.solanaPayUrl);
      setExpiresAt(new Date(data.expiresAt));
      setPhase("waiting");

      // ── Poll for confirmation ────────────────────────────────────────────
      const ref = data.reference;
      pollId.current = setInterval(async () => {
        try {
          const sr = await fetch(`/api/deposits/${ref}/status`, { headers: jwtHeaders });
          if (!sr.ok) return;
          const sd = await sr.json() as { status: string; txSignature?: string };

          if (sd.status === "confirmed") {
            stopPolling();
            setTxSig(sd.txSignature ?? null);
            setPhase("confirmed");
            await fetchBalance();
            toast({
              title: "Deposit confirmed ✓",
              description: `${effectiveAmt} SOL credited to your in-app balance`,
            });
          } else if (sd.status === "expired") {
            stopPolling();
            setPhase("expired");
          }
        } catch { /* RPC hiccup — retry next tick */ }
      }, POLL_MS);
    } catch (e) {
      setPhase("error");
      toast({
        title: "Deposit failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  // ── UI ─────────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowDownToLine className="w-4 h-4" />
            Deposit SOL
          </DialogTitle>
        </DialogHeader>

        {/* Balance display */}
        {balance !== null && (
          <p className="text-sm text-muted-foreground -mt-1">
            In-app balance:{" "}
            <span className="font-semibold text-foreground">{balance} SOL</span>
          </p>
        )}

        {/* ── Amount selection ── */}
        {(phase === "idle" || phase === "creating" || phase === "error") && (
          <div className="space-y-4">
            {!hasJwt && (
              <p className="text-sm text-amber-500 bg-amber-500/10 rounded-md px-3 py-2 border border-amber-500/20">
                Sign in with Google to enable deposits.
              </p>
            )}
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Select amount
              </p>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {PRESETS.map((a) => (
                  <Button
                    key={a}
                    size="sm"
                    variant={!useCustom && preset === a ? "default" : "outline"}
                    className="rounded-sm text-xs h-8"
                    onClick={() => { setPreset(a); setUseCustom(false); }}
                  >
                    {a} SOL
                  </Button>
                ))}
              </div>
              <div className="relative">
                <Input
                  className="pr-12"
                  placeholder="Custom"
                  value={customAmt}
                  type="number"
                  min="0.01"
                  step="0.01"
                  onChange={(e) => { setCustomAmt(e.target.value); setUseCustom(true); }}
                  onFocus={() => setUseCustom(true)}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                  SOL
                </span>
              </div>
            </div>
            <Button
              className="w-full rounded-sm"
              onClick={createDeposit}
              disabled={phase === "creating" || !hasJwt || !Number.isFinite(effectiveAmt) || effectiveAmt < 0.01}
            >
              {phase === "creating" ? "Generating…" : "Generate QR Code"}
            </Button>
          </div>
        )}

        {/* ── QR / waiting ── */}
        {phase === "waiting" && payUrl && (
          <div className="space-y-4">
            <p className="text-sm text-center text-muted-foreground">
              Scan with{" "}
              <span className="font-semibold text-foreground">Phantom</span> or{" "}
              <span className="font-semibold text-foreground">Solflare</span>{" "}
              to send{" "}
              <span className="font-semibold text-foreground">{effectiveAmt} SOL</span>
            </p>

            {/* QR code — white background required for scanner contrast */}
            <div className="flex justify-center p-4 bg-white rounded-xl shadow-sm">
              <QRCode value={payUrl} size={196} />
            </div>

            {/* Deep-link for mobile */}
            <a
              href={payUrl}
              className="block text-center text-[11px] text-muted-foreground break-all hover:text-foreground transition-colors"
              target="_blank"
              rel="noreferrer"
            >
              Open in wallet →
            </a>

            {expiresAt && <ExpiryCountdown expiresAt={expiresAt} />}

            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <span className="animate-pulse">●</span>
              Waiting for confirmation…
            </div>

            <Button variant="ghost" size="sm" className="w-full rounded-sm" onClick={reset}>
              Cancel
            </Button>
          </div>
        )}

        {/* ── Confirmed ── */}
        {phase === "confirmed" && (
          <div className="space-y-4 py-2 text-center">
            <div className="text-5xl">✅</div>
            <div>
              <p className="font-semibold text-lg">Deposit confirmed!</p>
              <p className="text-sm text-muted-foreground mt-1">
                {effectiveAmt} SOL has been added to your in-app balance.
              </p>
            </div>
            {txSig && (
              <a
                href={`https://solscan.io/tx/${txSig}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline"
              >
                View on Solscan ↗
              </a>
            )}
            {balance !== null && (
              <p className="text-sm font-medium">
                New balance: <span className="text-primary">{balance} SOL</span>
              </p>
            )}
            <Button className="w-full rounded-sm" onClick={() => handleOpenChange(false)}>
              Done
            </Button>
          </div>
        )}

        {/* ── Expired ── */}
        {phase === "expired" && (
          <div className="space-y-4 py-2 text-center">
            <div className="text-4xl">⏰</div>
            <div>
              <p className="font-semibold">QR code expired</p>
              <p className="text-sm text-muted-foreground mt-1">
                The 30-minute window has closed without a payment.
              </p>
            </div>
            <Button className="w-full rounded-sm" onClick={reset}>
              Try again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
