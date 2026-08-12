import { Link } from "wouter";
import { TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RiskAcknowledgmentModalProps {
  open: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}

const RISK_BULLETS = [
  {
    heading: "Total loss of capital",
    body: "Memecoins and speculative tokens can lose 100% of their value in minutes. Only use funds you can afford to lose entirely.",
  },
  {
    heading: "Rug pulls & scams",
    body: "Token developers may abandon projects or drain liquidity at any time. Pumpi does not vet or endorse any token or its creators.",
  },
  {
    heading: "Not financial advice",
    body: "Nothing on this platform constitutes investment or financial advice. You are solely responsible for your trading decisions.",
  },
  {
    heading: "Transactions are irreversible",
    body: "On-chain trades cannot be cancelled or refunded once confirmed. Double-check amounts and addresses before submitting.",
  },
];

/** One-time risk acknowledgment modal shown before a user's first trade. */
export function RiskAcknowledgmentModal({ open, onConfirm, onDismiss }: RiskAcknowledgmentModalProps) {
  if (!open) return null;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      {/* Panel */}
      <div
        className="relative w-full max-w-md rounded-2xl flex flex-col gap-5 p-6"
        style={{
          background: "#0f1117",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
        }}
      >
        {/* Close button */}
        <button
          onClick={onDismiss}
          className="absolute top-4 right-4 p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
            <TriangleAlert className="w-4.5 h-4.5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-[17px] font-bold text-foreground leading-tight">
              Trading Risk Acknowledgment
            </h2>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              Please read before your first trade
            </p>
          </div>
        </div>

        {/* Risk bullets */}
        <ul className="space-y-3">
          {RISK_BULLETS.map((item) => (
            <li key={item.heading} className="flex gap-2.5">
              <span
                className="mt-[3px] w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: "#f59e0b" }}
              />
              <span className="text-[13px] leading-snug text-foreground/80">
                <strong className="text-foreground/95 font-semibold">{item.heading}. </strong>
                {item.body}
              </span>
            </li>
          ))}
        </ul>

        {/* Disclaimer link */}
        <p className="text-[12px] text-muted-foreground">
          Read the full{" "}
          <Link
            href="/disclaimer"
            className="text-primary underline underline-offset-2 hover:opacity-80 transition-opacity"
            onClick={onDismiss}
          >
            Disclaimer
          </Link>{" "}
          for complete risk disclosures.
        </p>

        {/* CTA */}
        <Button
          onClick={onConfirm}
          className="w-full h-11 font-semibold text-[14px] rounded-xl"
          style={{
            background: "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)",
            color: "#fff",
            border: "none",
          }}
        >
          I understand the risks — continue
        </Button>
      </div>
    </div>
  );
}

/** Returns the localStorage key used to store risk acknowledgment for a given wallet. */
export function getRiskAckKey(wallet: string): string {
  return `risk_ack_v1_${wallet}`;
}

/** Returns true if this wallet has already acknowledged trading risks. */
export function hasAcknowledgedRisks(wallet: string): boolean {
  try {
    return localStorage.getItem(getRiskAckKey(wallet)) === "1";
  } catch {
    return false;
  }
}

/** Persists risk acknowledgment for the given wallet. */
export function saveRiskAcknowledgment(wallet: string): void {
  try {
    localStorage.setItem(getRiskAckKey(wallet), "1");
  } catch {
    // localStorage unavailable — fail silently; user will be prompted again
  }
}
