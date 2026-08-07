/**
 * ShareModal — professional share sheet for a token.
 * Card drawn via Canvas 2D API (no html2canvas, no CORS issues).
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Copy, Twitter, Send, Link2, ExternalLink, Download, Loader2 } from "lucide-react";
import { TokenAvatar, getGradient, GRADIENTS, hashSymbol } from "@/components/shared/TokenAvatar";
import { formatMCUsd, formatUSD } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/components/shared/CopyToast";

interface PctStat { val: string; up: boolean }

interface SharePriceStats {
  currentPrice: number;
  vol24h: number;
  vol24hBuy: number;
  vol24hSell: number;
  txns24hBuy: number;
  txns24hSell: number;
  p5m: PctStat | null;
  p1h: PctStat | null;
  p6h: PctStat | null;
  p24h: PctStat | null;
}

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
  solPrice?: number | null;
  priceStats?: SharePriceStats;
}

// ── Canvas helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.lineTo(x+w-r, y); ctx.arcTo(x+w, y, x+w, y+r, r);
  ctx.lineTo(x+w, y+h-r); ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
  ctx.lineTo(x+r, y+h); ctx.arcTo(x, y+h, x, y+h-r, r);
  ctx.lineTo(x, y+r); ctx.arcTo(x, y, x+r, y, r);
  ctx.closePath();
}

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (!src) return null;
  // Route through our proxy so the canvas never touches a cross-origin pixel
  const proxied = `/api/proxy-image?url=${encodeURIComponent(src)}`;
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = proxied;
  });
}

function drawAvatar(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  symbol: string,
  x: number, y: number, size: number, radius: number,
) {
  ctx.save();
  roundRect(ctx, x, y, size, size, radius);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    const idx = hashSymbol(symbol) % GRADIENTS.length;
    const [fa, fb] = GRADIENTS[idx];
    const [far, fag, fab] = hexToRgb(fa);
    const [fbr, fbg, fbb] = hexToRgb(fb);
    const g = ctx.createLinearGradient(x, y, x+size, y+size);
    g.addColorStop(0, `rgb(${far},${fag},${fab})`);
    g.addColorStop(1, `rgb(${fbr},${fbg},${fbb})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = `bold ${size*0.44}px -apple-system,BlinkMacSystemFont,sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((symbol[0] ?? "?").toUpperCase(), x+size/2, y+size/2+1);
  }
  ctx.restore();
  // border
  ctx.save();
  roundRect(ctx, x, y, size, size, radius);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

async function generateCardCanvas(
  token: ShareToken,
  solPrice: number | null,
  stats?: SharePriceStats,
): Promise<HTMLCanvasElement> {
  const S = 2;       // retina scale
  const W = 520;
  const H = 180;
  const R = 8;

  const canvas = document.createElement("canvas");
  canvas.width = W * S;
  canvas.height = H * S;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(S, S);

  const [c1, c2] = getGradient(token.symbol);
  const [r1,g1,b1] = hexToRgb(c1);
  const [r2,g2,b2] = hexToRgb(c2);

  // ── Card background ───────────────────────────────────────────────────────
  roundRect(ctx, 0, 0, W, H, R);
  ctx.fillStyle = "#080d1a";
  ctx.fill();

  // Subtle gradient wash from token colour
  roundRect(ctx, 0, 0, W, H, R);
  ctx.clip();

  const wash = ctx.createLinearGradient(0, 0, W, H*0.7);
  wash.addColorStop(0, `rgba(${r1},${g1},${b1},0.18)`);
  wash.addColorStop(0.5, `rgba(${r2},${g2},${b2},0.08)`);
  wash.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  // Fine dot grid
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  for (let dx = 12; dx < W; dx += 20)
    for (let dy = 12; dy < H; dy += 20) {
      ctx.beginPath(); ctx.arc(dx, dy, 0.8, 0, Math.PI*2); ctx.fill();
    }


  // ── Load avatar ───────────────────────────────────────────────────────────
  const avatarImg = token.imageUrl ? await loadImage(token.imageUrl) : null;

  // ── Header row ────────────────────────────────────────────────────────────
  const AV = 60, AX = 24, AY = 24;
  drawAvatar(ctx, avatarImg, token.symbol, AX, AY, AV, 12);

  // Token name + symbol
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 22px -apple-system,BlinkMacSystemFont,sans-serif`;
  ctx.fillText(token.name, AX+AV+16, AY+4);

  ctx.fillStyle = `rgba(${r1},${g1},${b1},1)`;
  ctx.font = `bold 14px "SFMono-Regular",Consolas,monospace`;
  ctx.fillText(`$${token.symbol}`, AX+AV+16, AY+32);

  // Graduated badge (top-right)
  if (token.graduated) {
    const bText = "✓ GRADUATED";
    ctx.font = `bold 10px -apple-system,BlinkMacSystemFont,sans-serif`;
    const bw = ctx.measureText(bText).width + 18;
    const bh = 22; const bx = W-24-bw; const by = AY+4;
    roundRect(ctx, bx, by, bw, bh, 11);
    ctx.fillStyle = `rgba(${r1},${g1},${b1},0.25)`;
    ctx.fill();
    roundRect(ctx, bx, by, bw, bh, 11);
    ctx.strokeStyle = `rgba(${r1},${g1},${b1},0.6)`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = `rgba(${r1},${g1},${b1},1)`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(bText, bx+bw/2, by+bh/2);
  }

  // ── Price + 1h change ─────────────────────────────────────────────────────
  const priceY = AY + AV + 20;
  const priceUsd = stats?.currentPrice && solPrice ? stats.currentPrice * solPrice : null;
  const priceStr = priceUsd
    ? (priceUsd < 0.0001 ? `$${priceUsd.toExponential(2)}` : formatUSD(priceUsd))
    : (token.priceEth ? parseFloat(token.priceEth).toExponential(4)+" SOL" : "—");

  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 32px -apple-system,BlinkMacSystemFont,sans-serif`;
  ctx.fillText(priceStr, 24, priceY);

  // 24h pill next to price
  const pct24 = stats?.p24h ?? null;
  if (pct24) {
    const pStr = pct24.val;
    const pColor = pct24.up ? "#22c55e" : "#f87171";
    const [pr,pg,pb] = hexToRgb(pct24.up ? "#16a34a" : "#dc2626");
    ctx.font = `bold 13px -apple-system,BlinkMacSystemFont,sans-serif`;
    const pw = ctx.measureText(pStr).width + 22;
    ctx.font = `bold 32px -apple-system,BlinkMacSystemFont,sans-serif`;
    const priceW = ctx.measureText(priceStr).width;
    ctx.font = `bold 13px -apple-system,BlinkMacSystemFont,sans-serif`;
    const pilX = 24 + priceW + 12;
    const pilY = priceY + 8;
    const pilH = 22;
    roundRect(ctx, pilX, pilY, pw, pilH, 6);
    ctx.fillStyle = `rgba(${pr},${pg},${pb},0.18)`; ctx.fill();
    roundRect(ctx, pilX, pilY, pw, pilH, 6);
    ctx.strokeStyle = `rgba(${pr},${pg},${pb},0.5)`; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = pColor;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(pStr, pilX+pw/2, pilY+pilH/2);
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const footerY = H - 20;
  // mintix logo mark (simple rocket emoji-style "⬆" replaced with text)
  ctx.fillStyle = `rgba(${r1},${g1},${b1},0.9)`;
  ctx.font = `bold 11px -apple-system,BlinkMacSystemFont,sans-serif`;
  ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  ctx.fillText("🚀 mintix.fun", 24, footerY);

  // address
  ctx.fillStyle = "rgba(255,255,255,0.20)";
  ctx.font = `500 9px "SFMono-Regular",Consolas,monospace`;
  ctx.textAlign = "right";
  const addr = token.address;
  const shortAddr = addr.length > 20 ? `${addr.slice(0,8)}...${addr.slice(-6)}` : addr;
  ctx.fillText(shortAddr, W-24, footerY);

  return canvas;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ShareModal({ token, open, onClose, solPrice, priceStats }: ShareModalProps) {
  const url = `${window.location.origin}/app?token=${token.address}`;
  const tweetText = `🚀 Just found $${token.symbol} on Mintix fun!\n\nMC: ${formatMCUsd(token.marketCapEth, solPrice ?? null)}${priceStats?.p24h ? ` · 24h ${priceStats.p24h.val}` : ""}\n\n${url}`;
  const telegramText = encodeURIComponent(`🔥 $${token.symbol} on Mintix fun — ${formatMCUsd(token.marketCapEth, solPrice ?? null)} MC\n${url}`);

  const [c1, c2] = getGradient(token.symbol);
  const [downloading, setDownloading] = useState(false);

  const priceUsd = priceStats?.currentPrice && solPrice ? priceStats.currentPrice * solPrice : null;
  const priceStr = priceUsd
    ? (priceUsd < 0.0001 ? `$${priceUsd.toExponential(2)}` : formatUSD(priceUsd))
    : token.priceEth ? parseFloat(token.priceEth).toExponential(4)+" SOL" : "—";

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const canvas = await generateCardCanvas(token, solPrice ?? null, priceStats);
      canvas.toBlob(blob => {
        if (!blob) return;
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl; a.download = `${token.symbol}-mintix.png`;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 200);
      }, "image/png");
    } catch (e) { console.error(e); }
    finally { setDownloading(false); }
  };

  if (!open) return null;

  const modal = (
    <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />

      <div className={cn(
        "relative z-10 w-full sm:max-w-md bg-[#0d1117] border border-white/10 shadow-2xl",
        "rounded-t-2xl sm:rounded-2xl animate-slideUp sm:animate-slideDown overflow-hidden",
      )}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/6">
          <span className="text-sm font-bold text-white/90">Share token</span>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-full bg-white/8 hover:bg-white/14 text-white/60 hover:text-white transition-colors">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* ── Signal Card Preview ── */}
        <div className="mx-4 mt-4 mb-3 rounded-xl overflow-hidden border border-white/8 shadow-xl" style={{ background: "#080d1a" }}>
          {/* Left accent */}
          <div className="relative">
            {/* Colour wash */}
            <div className="absolute inset-0 pointer-events-none" style={{
              background: `linear-gradient(135deg, ${c1}28 0%, ${c2}10 50%, transparent 100%)`,
            }} />

            <div className="relative px-4 pt-4 pb-3 space-y-3">
              {/* Token row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <TokenAvatar symbol={token.symbol} imageUrl={token.imageUrl} size={44} shape="rounded" />
                  <div>
                    <div className="font-bold text-white text-[15px] leading-tight">{token.name}</div>
                    <div className="text-sm font-mono font-bold" style={{ color: c1 }}>${token.symbol}</div>
                  </div>
                </div>
                {token.graduated && (
                  <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide rounded-full border"
                    style={{ color: c1, borderColor: `${c1}55`, background: `${c1}18` }}>
                    ✓ Graduated
                  </span>
                )}
              </div>

              {/* Price + 24h pill */}
              <div className="flex items-end gap-3">
                <div className="text-[28px] font-bold text-white leading-none">{priceStr}</div>
                {priceStats?.p24h && (
                  <div className="flex flex-col items-center mb-0.5">
                    <span className={cn("px-2 py-0.5 rounded text-xs font-bold", priceStats.p24h.up ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400")}>
                      {priceStats.p24h.val}
                    </span>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex justify-between items-center pt-0.5">
                <span className="text-[10px] font-bold" style={{ color: c1 }}>🚀 mintix.fun</span>
                <span className="text-[9px] font-mono text-white/20">
                  {token.address.slice(0,6)}...{token.address.slice(-4)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Download button */}
        <div className="px-4 mb-3">
          <button onClick={handleDownload} disabled={downloading}
            className="w-full flex items-center justify-center gap-2 h-10 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white text-sm font-semibold transition-all disabled:opacity-50">
            {downloading
              ? <><Loader2 className="h-4 w-4 animate-spin" />Generating...</>
              : <><Download className="h-4 w-4" />Download card</>}
          </button>
        </div>

        {/* Share platforms */}
        <div className="px-4 mb-3">
          <p className="text-[9px] text-white/30 uppercase tracking-widest font-semibold mb-2">Share to</p>
          <div className="grid grid-cols-3 gap-2">
            <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`}
              target="_blank" rel="noopener noreferrer"
              className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl bg-white/4 hover:bg-white/8 border border-white/6 hover:border-white/12 transition-all group">
              <div className="h-7 w-7 rounded-full bg-black flex items-center justify-center group-hover:scale-110 transition-transform">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.261 5.633 5.903-5.633zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              </div>
              <span className="text-[10px] font-semibold text-white/40 group-hover:text-white/70">X / Twitter</span>
            </a>

            <a href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${telegramText}`}
              target="_blank" rel="noopener noreferrer"
              className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl bg-white/4 hover:bg-[#2AABEE]/10 border border-white/6 hover:border-[#2AABEE]/25 transition-all group">
              <div className="h-7 w-7 rounded-full bg-[#2AABEE] flex items-center justify-center group-hover:scale-110 transition-transform">
                <Send className="h-3.5 w-3.5 text-white fill-white" />
              </div>
              <span className="text-[10px] font-semibold text-white/40 group-hover:text-white/70">Telegram</span>
            </a>

            <a href={`https://warpcast.com/~/compose?text=${encodeURIComponent(`🚀 $${token.symbol} on Mintix fun — ${formatMCUsd(token.marketCapEth, solPrice ?? null)} MC\n${url}`)}`}
              target="_blank" rel="noopener noreferrer"
              className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl bg-white/4 hover:bg-[#7C65C1]/10 border border-white/6 hover:border-[#7C65C1]/25 transition-all group">
              <div className="h-7 w-7 rounded-full bg-[#7C65C1] flex items-center justify-center group-hover:scale-110 transition-transform">
                <svg viewBox="0 0 1000 1000" className="h-3.5 w-3.5 fill-white"><path d="M257.778 155.556H742.222V844.445H671.111V528.889H670.414C662.554 441.677 589.258 373.333 500 373.333C410.742 373.333 337.446 441.677 329.586 528.889H328.889V844.445H257.778V155.556Z"/><path d="M128.889 253.333L157.778 351.111H182.222V746.667C169.949 746.667 160 756.616 160 768.889V795.556H155.556C143.283 795.556 133.333 805.505 133.333 817.778V844.445H382.222V817.778C382.222 805.505 372.273 795.556 360 795.556H355.556V768.889C355.556 756.616 345.606 746.667 333.333 746.667H306.667V253.333H128.889Z"/><path d="M846.667 253.333H668.889V746.667C656.616 746.667 646.667 756.616 646.667 768.889V795.556H642.222C629.949 795.556 620 805.505 620 817.778V844.445H868.889V817.778C868.889 805.505 858.94 795.556 846.667 795.556H842.222V768.889C842.222 756.616 832.273 746.667 820 746.667V351.111H844.444L873.333 253.333H846.667Z"/></svg>
              </div>
              <span className="text-[10px] font-semibold text-white/40 group-hover:text-white/70">Farcaster</span>
            </a>
          </div>
        </div>

        {/* Copy section */}
        <div className="px-4 pb-5 space-y-2">
          <button onClick={() => copyToClipboard(url, "Link copied")}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/4 hover:bg-white/8 border border-white/6 hover:border-white/12 transition-all group">
            <div className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0 bg-primary/15">
              <Link2 className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <div className="text-xs font-semibold text-white/80">Copy link</div>
              <div className="text-[10px] font-mono text-white/30 truncate">{url}</div>
            </div>
            <Copy className="h-3 w-3 text-white/20 shrink-0" />
          </button>

          <button onClick={() => copyToClipboard(token.address)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/4 hover:bg-white/8 border border-white/6 hover:border-white/12 transition-all group">
            <div className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0 bg-white/6">
              <ExternalLink className="h-3.5 w-3.5 text-white/40" />
            </div>
            <div className="flex-1 text-left min-w-0">
              <div className="text-xs font-semibold text-white/80">Contract address</div>
              <div className="text-[10px] font-mono text-white/30 truncate">{token.address}</div>
            </div>
            <Copy className="h-3 w-3 text-white/20 shrink-0" />
          </button>
        </div>

        {/* Mobile drag handle */}
        <div className="absolute top-2.5 left-1/2 -translate-x-1/2 w-9 h-1 rounded-full bg-white/10 sm:hidden" />
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
