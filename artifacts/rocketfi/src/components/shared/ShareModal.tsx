/**
 * ShareModal — professional share sheet for a token.
 * Shows a "signal card" preview + platform share buttons.
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  X, Copy, Twitter, Send, Link2, ExternalLink,
} from "lucide-react";
import { TokenAvatar, getGradient } from "@/components/shared/TokenAvatar";
import { formatMC, formatEth } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/components/shared/CopyToast";

interface ShareToken {
  name: string;
  symbol: string;
  address: string;
  imageUrl?: string | null;
  marketCapEth?: string | null;
  priceEth?: string | null;
  volumeEth?: string | null;
  description?: string | null;
  graduated?: boolean;
}

interface ShareModalProps {
  token: ShareToken;
  open: boolean;
  onClose: () => void;
}

export function ShareModal({ token, open, onClose }: ShareModalProps) {
  const url = `${window.location.origin}/app?token=${token.address}`;
  const tweetText = `🚀 Just found $${token.symbol} on Mintix fun!\n\nMC: ${formatMC(token.marketCapEth)} · ${token.graduated ? "Graduated ✓" : "Bonding curve"}\n\n${url}`;
  const telegramText = encodeURIComponent(`🔥 $${token.symbol} on Mintix fun — ${formatMC(token.marketCapEth)} MC\n${url}`);

  const [c1, c2] = getGradient(token.symbol);

  // Lock body scroll
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const modal = (
    <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center p-0 sm:p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className={cn(
          "relative z-10 w-full sm:max-w-md",
          "bg-[#111827] border border-border/60 shadow-2xl",
          "rounded-t-2xl sm:rounded-xl",
          "animate-slideUp sm:animate-slideDown",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <span className="text-sm font-bold text-foreground tracking-tight">Share token</span>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-full bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Signal Card Preview */}
        <div className="mx-5 mb-5 rounded-xl overflow-hidden border border-white/10 shadow-lg">
          {/* Card header — gradient from token color */}
          <div
            className="relative px-5 pt-5 pb-14"
            style={{ background: `linear-gradient(135deg, ${c1}dd, ${c2}99)` }}
          >
            {/* Dot pattern */}
            <div
              className="absolute inset-0 opacity-20"
              style={{
                backgroundImage: "radial-gradient(circle, white 1px, transparent 1px)",
                backgroundSize: "18px 18px",
              }}
            />
            {/* Shine */}
            <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-transparent" />

            <div className="relative flex items-center justify-between">
              <div className="flex items-center gap-3">
                <TokenAvatar symbol={token.symbol} imageUrl={token.imageUrl} size={44} shape="rounded" className="shadow-lg" />
                <div>
                  <div className="font-bold text-white text-base leading-tight">{token.name}</div>
                  <div className="text-white/70 text-sm font-mono font-semibold">${token.symbol}</div>
                </div>
              </div>
              {token.graduated && (
                <span className="px-2 py-1 bg-white/20 backdrop-blur-sm border border-white/30 text-white text-[10px] font-bold uppercase tracking-wider rounded-full">
                  Graduated
                </span>
              )}
            </div>

            {/* Mintix watermark */}
            <div className="absolute bottom-3 right-4 text-[10px] font-bold text-white/40 tracking-widest uppercase">
              mintix.fun
            </div>
          </div>

          {/* Card stats — dark base */}
          <div className="bg-[#0d1626] px-5 py-4 grid grid-cols-3 divide-x divide-white/10">
            {[
              { label: "Market Cap", value: formatMC(token.marketCapEth) },
              {
                label: "Price",
                value: (() => {
                  const p = token.priceEth ? parseFloat(token.priceEth) : 0;
                  if (!p) return "—";
                  if (p < 0.0001) return p.toExponential(3);
                  return p.toFixed(6);
                })(),
              },
              {
                label: "Vol 24h",
                value: token.volumeEth
                  ? `${parseFloat(formatEth(token.volumeEth)).toFixed(2)} SOL`
                  : "—",
              },
            ].map(({ label, value }) => (
              <div key={label} className="flex flex-col items-center gap-0.5 px-3">
                <span className="text-[9px] text-white/40 uppercase tracking-widest font-semibold">{label}</span>
                <span className="text-sm font-bold font-mono text-white">{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Share platform buttons */}
        <div className="px-5 mb-4">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold mb-3">Share to</p>
          <div className="grid grid-cols-3 gap-2">
            {/* Twitter/X */}
            <a
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-2 py-3 rounded-lg bg-muted/60 hover:bg-[#1DA1F2]/10 hover:border-[#1DA1F2]/30 border border-border/40 transition-all duration-150 group"
            >
              <div className="h-8 w-8 rounded-full bg-black flex items-center justify-center group-hover:scale-110 transition-transform">
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.261 5.633 5.903-5.633zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              </div>
              <span className="text-[11px] font-semibold text-muted-foreground group-hover:text-foreground">X / Twitter</span>
            </a>

            {/* Telegram */}
            <a
              href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${telegramText}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-2 py-3 rounded-lg bg-muted/60 hover:bg-[#2AABEE]/10 hover:border-[#2AABEE]/30 border border-border/40 transition-all duration-150 group"
            >
              <div className="h-8 w-8 rounded-full bg-[#2AABEE] flex items-center justify-center group-hover:scale-110 transition-transform">
                <Send className="h-4 w-4 text-white fill-white" />
              </div>
              <span className="text-[11px] font-semibold text-muted-foreground group-hover:text-foreground">Telegram</span>
            </a>

            {/* Warpcast / Farcaster */}
            <a
              href={`https://warpcast.com/~/compose?text=${encodeURIComponent(`🚀 $${token.symbol} on Mintix fun — ${formatMC(token.marketCapEth)} MC\n${url}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-2 py-3 rounded-lg bg-muted/60 hover:bg-[#7C65C1]/10 hover:border-[#7C65C1]/30 border border-border/40 transition-all duration-150 group"
            >
              <div className="h-8 w-8 rounded-full bg-[#7C65C1] flex items-center justify-center group-hover:scale-110 transition-transform">
                <svg viewBox="0 0 1000 1000" className="h-4 w-4 fill-white"><path d="M257.778 155.556H742.222V844.445H671.111V528.889H670.414C662.554 441.677 589.258 373.333 500 373.333C410.742 373.333 337.446 441.677 329.586 528.889H328.889V844.445H257.778V155.556Z"/><path d="M128.889 253.333L157.778 351.111H182.222V746.667C169.949 746.667 160 756.616 160 768.889V795.556H155.556C143.283 795.556 133.333 805.505 133.333 817.778V844.445H382.222V817.778C382.222 805.505 372.273 795.556 360 795.556H355.556V768.889C355.556 756.616 345.606 746.667 333.333 746.667H306.667V253.333H128.889Z"/><path d="M846.667 253.333H668.889V746.667C656.616 746.667 646.667 756.616 646.667 768.889V795.556H642.222C629.949 795.556 620 805.505 620 817.778V844.445H868.889V817.778C868.889 805.505 858.94 795.556 846.667 795.556H842.222V768.889C842.222 756.616 832.273 746.667 820 746.667V351.111H844.444L873.333 253.333H846.667Z"/></svg>
              </div>
              <span className="text-[11px] font-semibold text-muted-foreground group-hover:text-foreground">Farcaster</span>
            </a>
          </div>
        </div>

        {/* Copy section */}
        <div className="px-5 pb-5 space-y-2">
          {/* Copy link */}
          <button
            onClick={() => copyToClipboard(url, "Link copied")}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-muted/40 hover:bg-muted/80 border border-border/40 hover:border-border/70 transition-all duration-150 group"
          >
            <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-primary/10">
              <Link2 className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <div className="text-xs font-semibold text-foreground">Copy link</div>
              <div className="text-[10px] font-mono text-muted-foreground truncate">{url}</div>
            </div>
            <Copy className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
          </button>

          {/* Copy contract address */}
          <button
            onClick={() => copyToClipboard(token.address)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-muted/40 hover:bg-muted/80 border border-border/40 hover:border-border/70 transition-all duration-150 group"
          >
            <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-muted">
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <div className="text-xs font-semibold text-foreground">Contract address</div>
              <div className="text-[10px] font-mono text-muted-foreground truncate">{token.address}</div>
            </div>
            <Copy className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
          </button>
        </div>

        {/* Mobile drag handle */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-white/10 sm:hidden" />
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
