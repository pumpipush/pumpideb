/**
 * BubbleMap — Production-quality Canvas2D crypto market bubble map.
 * - Force-directed layout with collision avoidance
 * - Radial gradients + glow for each bubble
 * - Real-time color updates from live price feed (no layout recalc on every tick)
 * - Hover tooltip, zoom/pan, click-to-navigate
 */
import { useEffect, useRef, useCallback, useState } from "react";
import { formatPct } from "@/lib/utils";
import { useLocation } from "wouter";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenBubbleInput {
  address: string;
  symbol: string;
  name: string;
  imageUrl?: string | null;
  marketCapEth?: string | null; // lamports as string
  volumeEth?: string | null;    // 24h volume in lamports
  priceEth?: string | null;
  platform: string;
  /** Pre-computed 24h price change from the API (null = no trades in window) */
  pctChange24h?: number | null;
}

export interface LivePriceUpdate {
  priceEth?: string | null;
  marketCapEth?: string | null;
  lastTradeAt?: number;
}

interface BubbleState {
  // data
  address: string;
  symbol: string;
  name: string;
  platform: string;
  marketCapSol: number;
  volumeSol: number;
  pctChange: number;
  // layout
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  // animation
  dispX: number; // current display position (lerped toward x + float offset)
  dispY: number;
  dispR: number; // current display radius (lerped for hover)
  colorR: number; colorG: number; colorB: number; // lerped color
  targetR: number; targetG: number; targetB: number;
  // floating bob (unique per bubble)
  floatPhaseX: number;
  floatPhaseY: number;
  floatFreqX:  number; // base frequency (rad/s)
  floatFreqY:  number; // = freqX * 1.5 → Lissajous 3:2 ratio = figure-8 paths
  floatAmp:    number; // pixels amplitude
  pulsePhase:  number; // for top-5 radius breathing
  pulseFreq:   number;
  // assets
  img?: HTMLImageElement;
  imgLoaded: boolean;
}

interface Transform { scale: number; ox: number; oy: number; }

interface TooltipState {
  visible: boolean;
  x: number; y: number;
  token: BubbleState | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_R      = 14;
const MAX_R      = 80;
const GAP        = 2;
const TOP_CIRCLES = 8;   // top N get a circle; rest = floating text label
const SOL_PRICE_USD = 160;  // fallback if no solPrice prop

// ─── Color helpers ────────────────────────────────────────────────────────────

type RGB = { r: number; g: number; b: number };

// Solid-fill colors — matches BirdEye/reference style:
//   vivid green / vivid red / very dark neutral
function pctToColors(pct: number): {
  center: RGB; mid: RGB; edge: RGB; glow: string; border: string; pctHex: string;
} {
  if (pct > 0.15) {
    const t = Math.min(pct / 20, 1);
    const g = Math.round(lerp(140, 210, t));
    return {
      center: { r: Math.round(lerp(25,15,t)),  g: Math.round(lerp(g, g+20, 0.3)), b: Math.round(lerp(45,35,t)) },
      mid:    { r: Math.round(lerp(10,6,t)),   g: Math.round(g * 0.60),            b: Math.round(lerp(22,18,t)) },
      edge:   { r: 3,                           g: Math.round(g * 0.28),            b: 8 },
      glow:   `rgba(15,${g},40,${lerp(0.30,0.60,t)})`,
      border: `rgba(20,${g},50,0.60)`,
      pctHex: "#ffffff",
    };
  } else if (pct < -0.15) {
    const t  = Math.min(-pct / 20, 1);
    const rv = Math.round(lerp(185, 240, t));
    return {
      center: { r: rv,                             g: Math.round(lerp(18,10,t)), b: Math.round(lerp(18,10,t)) },
      mid:    { r: Math.round(rv * 0.55),          g: 7,                         b: 7 },
      edge:   { r: Math.round(rv * 0.26),          g: 3,                         b: 3 },
      glow:   `rgba(${rv},10,10,${lerp(0.30,0.60,t)})`,
      border: `rgba(${rv},15,15,0.60)`,
      pctHex: "#ffffff",
    };
  } else {
    // Neutral — dark blue-gray, clearly visible on black background
    return {
      center: { r: 52, g: 58, b: 88 },
      mid:    { r: 32, g: 36, b: 58 },
      edge:   { r: 16, g: 18, b: 30 },
      glow:   "rgba(55,62,100,0.25)",
      border: "rgba(90,100,150,0.50)",
      pctHex: "#b3b3b3",
    };
  }
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function toHex(n: number) { return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0"); }

// ─── Radius by rank ───────────────────────────────────────────────────────────
// Rank-based sizing: position in volume-sorted list determines size.
// This guarantees dramatic visual spread even when all volumes are similar
// (e.g. all pump.fun tokens at bonding-curve start have nearly equal volumes).
// rank 0 = highest volume → MAX_R; rank n-1 = lowest → MIN_R.

function calcRadius(rank: number, _total: number): number {
  // Top 8 → explicit circle sizes; rest → uniform small for text-label layout
  const topSizes = [80, 70, 62, 56, 50, 46, 42, 38];
  if (rank < TOP_CIRCLES) return topSizes[rank] ?? 38;
  return 26; // text-label layout radius (no circle drawn)
}

// ─── Force layout — inflate-and-pack ─────────────────────────────────────────
// Bubbles start tiny at staggered grid positions across the whole canvas,
// then inflate to their target radius while collision + boundary forces resolve
// overlaps. No center gravity — bubbles fill ALL available space uniformly.

// ─── Halton quasi-random sequence ─────────────────────────────────────────────
// Produces uniformly-distributed points that always cover the full rectangle
// (unlike phyllotaxis which creates a circle, leaving corners empty).
function halton(idx: number, base: number): number {
  let f = 1, r = 0;
  while (idx > 0) { f /= base; r += f * (idx % base); idx = Math.floor(idx / base); }
  return r;
}

// ─── Force layout — inflate-and-pack ─────────────────────────────────────────
// 1. Init: place bubbles via Halton(2,3) — uniform rectangle coverage incl. corners
// 2. Inflate radii 0→target over simulation
// 3. Collision repulsion + hard boundary walls only (no gravity) → fills uniformly

function runLayout(bubbles: BubbleState[], W: number, H: number, steps = 460) {
  if (W <= 0 || H <= 0 || bubbles.length === 0) return;
  const n = bubbles.length;
  const targetR = bubbles.map(b => b.r);

  // ── Halton initialization — covers full W×H rectangle uniformly ───────────
  bubbles.forEach((b, i) => {
    const margin = MIN_R;
    b.x  = margin + halton(i + 1, 2) * (W - 2 * margin);
    b.y  = margin + halton(i + 1, 3) * (H - 2 * margin);
    b.vx = 0;
    b.vy = 0;
    b.r  = Math.max(2, targetR[i] * 0.07);
  });

  for (let step = 0; step < steps; step++) {
    const progress = step / steps;
    // Inflate: slow start, fast middle, settle at end
    const inflate = Math.pow(progress, 0.45);
    const damping = 0.78 + 0.10 * progress;  // 0.78 early (energetic), 0.88 late (settled)

    for (let i = 0; i < n; i++) {
      bubbles[i].r = Math.max(1, targetR[i] * inflate);
    }

    for (let i = 0; i < n; i++) {
      const a   = bubbles[i];
      const pad = a.r + GAP;

      // Collision repulsion — push apart when overlapping
      for (let j = i + 1; j < n; j++) {
        const b    = bubbles[j];
        const dx   = b.x - a.x;
        const dy   = b.y - a.y;
        const d    = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const minD = a.r + b.r + GAP;
        if (d < minD) {
          const push  = (minD - d) / minD * 0.70;
          const nx    = dx / d, ny = dy / d;
          const total = a.r + b.r;
          a.vx -= nx * push * (b.r / total);
          a.vy -= ny * push * (b.r / total);
          b.vx += nx * push * (a.r / total);
          b.vy += ny * push * (a.r / total);
        }
      }

      // Hard wall — strong elastic boundary, fills corners
      const wK = 0.60;
      if (a.x < pad)      a.vx += (pad - a.x)      * wK;
      if (a.x > W - pad)  a.vx += (W - pad - a.x)  * wK;
      if (a.y < pad)      a.vy += (pad - a.y)       * wK;
      if (a.y > H - pad)  a.vy += (H - pad - a.y)   * wK;

      a.vx *= damping;
      a.vy *= damping;
      a.x  += a.vx;
      a.y  += a.vy;
      a.x   = Math.max(pad, Math.min(W - pad, a.x));
      a.y   = Math.max(pad, Math.min(H - pad, a.y));
    }
  }

  // Restore exact target radii — dispX/dispY/dispR intentionally NOT synced
  // here so the render-loop lerp can animate the initial spread on first open.
  for (let i = 0; i < n; i++) bubbles[i].r = targetR[i];
}

// ─── Canvas renderer ──────────────────────────────────────────────────────────
// Two visual modes based on rank:
//
//  rank < TOP_CIRCLES  → transparent glass circle with vivid colored border
//                         (green border if pct↑, red if pct↓, gray neutral)
//  rank ≥ TOP_CIRCLES  → floating text label only (no circle shape)

// Helper: derive border / glow / fill-tint from raw pctChange
interface CircleStyle {
  border: string; glow: string; fill: string; text: string;
  fillCenter: string; fillMid: string; fillEdge: string;
  rimOuter: string;
}

function circleColors(pct: number): CircleStyle {
  if (pct > 0.15) {
    const t = Math.min(pct / 20, 1);
    const g = Math.round(lerp(155, 215, t));
    return {
      border:     `rgba(28,${g},72,${lerp(0.82,1.0,t)})`,
      rimOuter:   `rgba(18,${Math.round(g*0.55)},50,${lerp(0.30,0.55,t)})`,
      glow:       `rgba(15,${g},55,${lerp(0.38,0.68,t)})`,
      fill:       `rgba(18,${g},50,0.07)`,
      fillCenter: `rgba(6,${Math.round(g*0.18)},18,0.0)`,
      fillMid:    `rgba(10,${Math.round(g*0.28)},28,0.10)`,
      fillEdge:   `rgba(8,${Math.round(g*0.52)},32,0.32)`,
      text:       `rgb(90,${g},110)`,
    };
  } else if (pct < -0.15) {
    const t  = Math.min(-pct / 20, 1);
    const rv = Math.round(lerp(188, 245, t));
    return {
      border:     `rgba(${rv},20,20,${lerp(0.82,1.0,t)})`,
      rimOuter:   `rgba(${Math.round(rv*0.52)},10,10,${lerp(0.28,0.52,t)})`,
      glow:       `rgba(${rv},10,10,${lerp(0.38,0.68,t)})`,
      fill:       `rgba(${rv},14,14,0.07)`,
      fillCenter: `rgba(${Math.round(rv*0.22)},4,4,0.0)`,
      fillMid:    `rgba(${Math.round(rv*0.20)},5,5,0.10)`,
      fillEdge:   `rgba(${Math.round(rv*0.40)},7,7,0.32)`,
      text:       `rgb(${rv},85,85)`,
    };
  }
  return {
    border:     "rgba(100,120,200,0.90)",
    rimOuter:   "rgba(70,90,160,0.45)",
    glow:       "rgba(80,105,185,0.50)",
    fill:       "rgba(60,75,130,0.18)",
    fillCenter: "rgba(28,34,68,0.08)",
    fillMid:    "rgba(40,50,95,0.22)",
    fillEdge:   "rgba(65,80,145,0.48)",
    text:       "#b3b3b3",
  };
}

function drawBubble(
  ctx: CanvasRenderingContext2D,
  b: BubbleState,
  isHovered: boolean,
  _colors: ReturnType<typeof pctToColors>,
  dpr: number,
  rank: number,
) {
  const x = b.dispX, y = b.dispY, r = b.dispR;

  // Guard: NaN < 6 === false in JS, so the isFinite check MUST come first.
  // createRadialGradient throws if ANY argument is non-finite (NaN or ±Infinity).
  if (!isFinite(x) || !isFinite(y) || !isFinite(r) || r < 6) return;

  // Fade-in opacity driven by dispR growth (0 → r over ~3s on first open)
  const fadeAlpha = Math.min(1, r / Math.max(b.r, 1));
  if (fadeAlpha < 0.02) return;

  // ── MODE B: Small label (rank ≥ TOP_CIRCLES) — logo + name + % ───────────
  if (rank >= TOP_CIRCLES) {
    ctx.globalAlpha = fadeAlpha;
    const col     = circleColors(b.pctChange);
    const pct     = formatPct(b.pctChange);
    const name    = b.name.substring(0, 11);
    const logoR   = 7;
    const nameSz  = 8;
    const pctSz   = 10;
    const gap     = 2;

    // Total block height: logo + gap + name + gap + pct
    const blockH = logoR * 2 + gap + nameSz + gap + pctSz;
    let cy = y - blockH / 2;

    // Logo
    if (b.img && b.imgLoaded && b.img.naturalWidth > 0) {
      const lcy = cy + logoR;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, lcy, logoR, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(b.img, x - logoR, lcy - logoR, logoR * 2, logoR * 2);
      ctx.restore();
      // Subtle ring around logo
      ctx.beginPath();
      ctx.arc(x, lcy, logoR, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(160,170,210,0.25)";
      ctx.lineWidth = 0.6;
      ctx.stroke();
    } else {
      // Placeholder dot
      ctx.beginPath();
      ctx.arc(x, cy + logoR, logoR, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(80,90,130,0.55)";
      ctx.fill();
    }
    cy += logoR * 2 + gap;

    ctx.save();
    ctx.textAlign   = "center";
    ctx.shadowBlur  = 3;
    ctx.shadowColor = "rgba(0,0,0,0.92)";

    // Name
    ctx.font         = `500 ${nameSz}px Inter,'SF Pro Display',system-ui,sans-serif`;
    ctx.fillStyle    = isHovered ? "#ffffff" : "rgba(200,212,235,0.85)";
    ctx.textBaseline = "top";
    ctx.fillText(name, x, cy);
    cy += nameSz + gap;

    // % change — 10px
    ctx.font      = `700 ${pctSz}px Inter,'SF Pro Display',system-ui,sans-serif`;
    ctx.fillStyle = col.text;
    ctx.fillText(pct, x, cy);

    ctx.restore();
    ctx.globalAlpha = 1;
    return;
  }

  // ── MODE A: Professional circle (top 5) ──────────────────────────────────
  const col = circleColors(b.pctChange);
  const bw  = isHovered ? 2.2 : 1.6;

  ctx.globalAlpha = fadeAlpha;
  ctx.save();

  // 1. Radial fill — dark transparent center fading to colored tinted edge
  const fillGrad = ctx.createRadialGradient(x, y, 0, x, y, r);
  fillGrad.addColorStop(0,    col.fillCenter);
  fillGrad.addColorStop(0.55, col.fillMid);
  fillGrad.addColorStop(1,    col.fillEdge);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // 2. Outer diffuse rim (wide soft ring behind main border)
  ctx.shadowBlur  = (isHovered ? 48 : 30) * dpr;
  ctx.shadowColor = col.glow;
  ctx.beginPath();
  ctx.arc(x, y, r - bw / 2, 0, Math.PI * 2);
  ctx.strokeStyle = col.rimOuter;
  ctx.lineWidth   = bw + 4;
  ctx.stroke();

  // 3. Main crisp border ring
  ctx.shadowBlur  = (isHovered ? 18 : 10) * dpr;
  ctx.shadowColor = col.glow;
  ctx.beginPath();
  ctx.arc(x, y, r - bw / 2, 0, Math.PI * 2);
  ctx.strokeStyle = col.border;
  ctx.lineWidth   = bw;
  ctx.stroke();

  ctx.shadowBlur = 0;

  // 4. Inner thin ring (glass depth)
  ctx.beginPath();
  ctx.arc(x, y, r - bw - 1.8, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth   = 0.7;
  ctx.stroke();

  // 5. Bottom inner shadow — gives sphere depth
  const bottomShad = ctx.createRadialGradient(x, y + r * 0.28, r * 0.05, x, y + r * 0.55, r * 0.85);
  bottomShad.addColorStop(0, "rgba(0,0,0,0.28)");
  bottomShad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.arc(x, y, r - bw, 0, Math.PI * 2);
  ctx.fillStyle = bottomShad;
  ctx.fill();

  // 6. Top-left specular sheen — crisp highlight like a light source
  const shine = ctx.createRadialGradient(
    x - r * 0.30, y - r * 0.32, 0,
    x - r * 0.08, y - r * 0.10, r * 0.52,
  );
  shine.addColorStop(0,    "rgba(255,255,255,0.20)");
  shine.addColorStop(0.42, "rgba(255,255,255,0.04)");
  shine.addColorStop(1,    "rgba(255,255,255,0)");
  ctx.beginPath();
  ctx.arc(x, y, r - bw, 0, Math.PI * 2);
  ctx.fillStyle = shine;
  ctx.fill();

  ctx.restore();

  // ── Content inside circle ─────────────────────────────────────────────────
  const showLogo   = r >= 44 && b.img && b.imgLoaded && b.img.naturalWidth > 0;
  const showSymbol = r >= 32;
  const pctText    = formatPct(b.pctChange);
  const pctFontSz  = 10;
  const symFontSz  = Math.max(9,  Math.min(r * 0.18, 13));
  const logoR      = r * 0.25;
  const gap        = r * 0.08;

  let blockH = pctFontSz;
  if (showSymbol) blockH += symFontSz + gap;
  if (showLogo)   blockH += logoR * 2  + gap;
  let curY = y - blockH / 2;

  if (showLogo) {
    const lcy = curY + logoR;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, lcy, logoR, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(b.img!, x - logoR, lcy - logoR, logoR * 2, logoR * 2);
    ctx.restore();
    curY += logoR * 2 + gap;
  }

  if (showSymbol) {
    ctx.save();
    ctx.font         = `700 ${symFontSz}px Inter,'SF Pro Display',system-ui,sans-serif`;
    ctx.fillStyle    = "rgba(255,255,255,0.95)";
    ctx.textAlign    = "center";
    ctx.textBaseline = "top";
    ctx.shadowBlur   = 4;
    ctx.shadowColor  = "rgba(0,0,0,0.90)";
    ctx.fillText(b.symbol.replace(/^\$/, "").substring(0, 8), x, curY);
    ctx.restore();
    curY += symFontSz + gap;
  }

  ctx.save();
  ctx.font         = `800 ${pctFontSz}px Inter,'SF Pro Display',system-ui,sans-serif`;
  ctx.fillStyle    = col.text;
  ctx.textAlign    = "center";
  ctx.textBaseline = "top";
  ctx.shadowBlur   = 6;
  ctx.shadowColor  = "rgba(0,0,0,0.95)";
  ctx.fillText(pctText, x, curY);
  ctx.restore();
  ctx.globalAlpha = 1; // reset after fade-in applied
}

// ─── Image preloader ──────────────────────────────────────────────────────────

const imgCache = new Map<string, HTMLImageElement>();

function loadImage(url: string, onLoad: () => void): HTMLImageElement {
  if (imgCache.has(url)) {
    const cached = imgCache.get(url)!;
    if (cached.complete && cached.naturalWidth > 0) { onLoad(); }
    return cached;
  }
  const img = new Image();
  // No crossOrigin: allows images from CDNs without CORS headers.
  // Canvas will be "tainted" but we never call toDataURL/getImageData.
  img.onload  = onLoad;
  img.onerror = () => {}; // silent — bubble renders without logo
  img.src = url;
  imgCache.set(url, img);
  return img;
}

// ─── Main component ───────────────────────────────────────────────────────────

interface BubbleMapProps {
  tokens: TokenBubbleInput[];
  liveUpdates?: Map<string, LivePriceUpdate>;
  solPrice?: number | null;
  height?: number;
  radiusScale?: number; // 1.0 = default desktop sizes; 0.6 = mobile
}

export default function BubbleMap({ tokens, liveUpdates, solPrice, height = 420, radiusScale = 1 }: BubbleMapProps) {
  const [, navigate]  = useLocation();
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const containerRef  = useRef<HTMLDivElement>(null);
  const bubblesRef    = useRef<BubbleState[]>([]);
  const transformRef  = useRef<Transform>({ scale: 1, ox: 0, oy: 0 });
  const hoverIdxRef   = useRef<number>(-1);
  const rafRef        = useRef<number>(0);
  const initPricesRef = useRef<Map<string, number>>(new Map());
  const layoutTimeRef = useRef<number>(0); // perf.now() when last layout ran → drives fast-open lerp
  // drag + zoom intentionally disabled — map is static (no pan/zoom)

  const [tooltip, setTooltip] = useState<TooltipState>({ visible: false, x: 0, y: 0, token: null });

  // ── Initialize / re-layout when tokens change ──────────────────────────────
  useEffect(() => {
    if (!tokens || tokens.length === 0) {
      bubblesRef.current = [];
      hoverIdxRef.current = -1;
      setTooltip({ visible: false, x: 0, y: 0, token: null });
      return;
    }

    // Use container CSS dimensions (available before ResizeObserver fires)
    const W = containerRef.current?.offsetWidth ?? 600;
    const H = height;

    // tokens arrive pre-sorted by volume desc from the API
    const prevMap = new Map(bubblesRef.current.map(b => [b.address, b]));

    const newBubbles: BubbleState[] = tokens.map((t, i) => {
      const volSol = parseFloat(t.volumeEth ?? t.marketCapEth ?? "0") / 1e9;
      const mcSol  = parseFloat(t.marketCapEth ?? "0") / 1e9;
      // Rank-based sizing: index 0 = highest volume → MAX_R; scaled for mobile
      const r      = Math.round(calcRadius(i, tokens.length) * radiusScale);
      const prev   = prevMap.get(t.address);

      // Seed initPricesRef with the 24h open price so that live WebSocket
      // updates continue measuring change relative to the 24h open, not the
      // moment the page loaded.
      const currentPrice = parseFloat(t.priceEth ?? "0");
      if (!initPricesRef.current.has(t.address) && currentPrice > 0) {
        if (t.pctChange24h != null && t.pctChange24h !== 0) {
          // Back-calculate the 24h open price from the known pct change:
          //   currentPrice = openPrice * (1 + pctChange24h/100)
          // Guard: pctChange24h = -100 makes denominator = 0 → openPrice = Infinity.
          // isFinite check prevents Infinity from being stored as a reference price.
          const denom    = 1 + t.pctChange24h / 100;
          const openPrice = Math.abs(denom) > 1e-9 ? currentPrice / denom : currentPrice;
          if (isFinite(openPrice) && openPrice > 0) initPricesRef.current.set(t.address, openPrice);
          else initPricesRef.current.set(t.address, currentPrice);
        } else {
          initPricesRef.current.set(t.address, currentPrice);
        }
      }

      // Spread initial positions in a rough circle so layout converges faster
      const angle  = (i / tokens.length) * Math.PI * 2;
      const spread = Math.min(W, H) * 0.25;

      // Use API-provided 24h pct change as initial value (not 0) so bubbles
      // show meaningful colors immediately on page load.
      const pct  = prev?.pctChange ?? (t.pctChange24h ?? 0);
      const cols = pctToColors(pct);

      const bubble: BubbleState = {
        address:      t.address,
        symbol:       t.symbol,
        name:         t.name,
        platform:     t.platform,
        marketCapSol: mcSol,
        volumeSol:    volSol,
        pctChange:    pct,
        x:     prev?.x ?? W / 2 + Math.cos(angle) * spread,
        y:     prev?.y ?? H / 2 + Math.sin(angle) * spread,
        vx:    0,
        vy:    0,
        r,
        dispX: prev?.dispX ?? W / 2 + Math.cos(angle) * spread,
        dispY: prev?.dispY ?? H / 2 + Math.sin(angle) * spread,
        dispR: prev?.dispR ?? 0, // new bubbles grow from 0 → visible spread-in animation
        colorR: prev?.colorR ?? cols.center.r,
        colorG: prev?.colorG ?? cols.center.g,
        colorB: prev?.colorB ?? cols.center.b,
        targetR: cols.center.r,
        targetG: cols.center.g,
        targetB: cols.center.b,
        // Unique floating bob per bubble — keep existing if re-using prev
        floatPhaseX: prev?.floatPhaseX ?? Math.random() * Math.PI * 2,
        floatPhaseY: prev?.floatPhaseY ?? Math.random() * Math.PI * 2,
        // ── Circular orbit params (top-5 only) ───────────────────────────────
        // Circular orbit: X = amp·cos(ωt + φ), Y = amp·sin(ωt + φ)
        // Same ω for X and Y → perfect circle (no Lissajous reversal artifacts).
        // Each bubble gets a random phase so they orbit at different positions.
        // Period 22–38s → slow, majestic, clearly visible drift.
        // Amplitude is rank-based: biggest circle gets largest orbit.
        floatFreqX:  i < TOP_CIRCLES
          ? 0.000165 + Math.random() * 0.000121  // 22–38s period
          : 0,                                    // labels: no orbit
        floatFreqY:  i < TOP_CIRCLES              // same ω → circular (not ellipse)
          ? 0.000165 + Math.random() * 0.000121
          : 0,
        floatAmp:    i < TOP_CIRCLES
          ? ([9, 8, 7, 6.5, 6, 5.5, 5, 4.5][i] ?? 4) // rank-based, always regenerate
          : 0,
        pulsePhase:  prev?.pulsePhase ?? Math.random() * Math.PI * 2,
        pulseFreq:   0.00079 + Math.random() * 0.00047,
        imgLoaded: prev?.imgLoaded ?? false,
        img: prev?.img,
      };

      // Load logo
      const resolvedUrl = t.imageUrl
        ? (t.imageUrl.startsWith("http") ? t.imageUrl : `/api/proxy-image?url=${encodeURIComponent(t.imageUrl)}`)
        : null;
      if (resolvedUrl && !bubble.img) {
        bubble.img = loadImage(resolvedUrl, () => {
          const b = bubblesRef.current.find(x => x.address === t.address);
          if (b) { b.imgLoaded = true; }
        });
        bubble.imgLoaded = bubble.img.complete;
      }

      return bubble;
    });

    // Sort largest first — they go to center in layout
    newBubbles.sort((a, b) => b.r - a.r);
    bubblesRef.current = newBubbles;

    // Run layout synchronously — 300 steps balances quality vs blocking time
    runLayout(newBubbles, W, H, 300);
    layoutTimeRef.current = performance.now(); // mark layout time for fast-open lerp
  }, [tokens]);

  // ── Update colors when live prices come in (no layout recalc) ─────────────
  useEffect(() => {
    if (!liveUpdates) return;
    bubblesRef.current.forEach(b => {
      const update = liveUpdates.get(b.address);
      if (!update?.priceEth) return;

      const livePrice = parseFloat(update.priceEth);
      const initPrice = initPricesRef.current.get(b.address) ?? livePrice;
      if (initPrice <= 0) return;

      b.pctChange = ((livePrice - initPrice) / initPrice) * 100;
      const cols  = pctToColors(b.pctChange);
      b.targetR   = cols.center.r;
      b.targetG   = cols.center.g;
      b.targetB   = cols.center.b;
    });
  }, [liveUpdates]);

  // ── Animation loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    const render = () => {
      const W = canvas.width  / dpr;
      const H = canvas.height / dpr;
      const { scale, ox, oy } = transformRef.current;

      // Reset transform to identity, clear, then re-apply dpr scale
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Pure black background
      const bgGrad = ctx.createRadialGradient(
        canvas.width / 2, canvas.height / 2, 0,
        canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.7
      );
      bgGrad.addColorStop(0,   "#0a0a0a");
      bgGrad.addColorStop(1,   "#000000");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Apply dpr scale + pan/zoom in CSS space
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, ox * dpr, oy * dpr);
      ctx.save();

      const hIdx  = hoverIdxRef.current;
      const bubbles = bubblesRef.current;

      // ── Per-frame updates ────────────────────────────────────────────────────
      // Colors lerp toward target; top-N circles float with a gentle circular
      // orbit; text labels are static after initial layout spread.
      const now = performance.now();
      for (let i = 0; i < bubbles.length; i++) {
        const b = bubbles[i];
        if (!b) continue; // guard: bubblesRef may be replaced mid-frame by the 5s poll useEffect
        b.colorR += (b.targetR - b.colorR) * 0.04;
        b.colorG += (b.targetG - b.colorG) * 0.04;
        b.colorB += (b.targetB - b.colorB) * 0.04;
        // Top circles: gentle circular orbit
        const amp = (i < TOP_CIRCLES && b.floatAmp > 0 && b.floatFreqX > 0) ? b.floatAmp : 0;
        const floatX = amp ? amp * Math.cos(b.floatFreqX * now + b.floatPhaseX) : 0;
        const floatY = amp ? amp * Math.sin(b.floatFreqY * now + b.floatPhaseY) : 0;
        // Fast lerp for first 1.2s after layout (snappy open), slow float after
        const age = now - layoutTimeRef.current;
        const lerpXY = age < 1200 ? 0.075 : 0.018;
        b.dispX += (b.x + floatX - b.dispX) * lerpXY;
        b.dispY += (b.y + floatY - b.dispY) * lerpXY;
      }

      // Z-ordering: draw text labels first (back), then large circles on top.
      // bubbles[] is sorted largest-first → index 0–4 = top circles, 5+ = text labels.
      const hoveredBubble = hIdx >= 0 && hIdx < bubbles.length ? bubbles[hIdx] : null;

      // Lerp speed: fast during first 1.2s, slow float after
      const ageNow = now - layoutTimeRef.current;
      const lerpR  = ageNow < 1200 ? 0.075 : 0.018;

      // Pass 1: text labels (rank ≥ TOP_CIRCLES), back to front within that group
      for (let i = bubbles.length - 1; i >= TOP_CIRCLES; i--) {
        const b = bubbles[i];
        if (!b || b === hoveredBubble) continue;
        b.dispR += (b.r - b.dispR) * lerpR;
        drawBubble(ctx, b, false, pctToColors(b.pctChange), dpr, i);
      }

      // Pass 2: top circles (rank 0–4), smallest-first so rank 0 is on top
      for (let i = TOP_CIRCLES - 1; i >= 0; i--) {
        const b = bubbles[i];
        if (!b || b === hoveredBubble) continue;
        b.dispR += (b.r - b.dispR) * lerpR;
        drawBubble(ctx, b, false, pctToColors(b.pctChange), dpr, i);
      }

      // Pass 3: hovered bubble always on top
      if (hoveredBubble) {
        const hRank = bubbles.indexOf(hoveredBubble);
        hoveredBubble.dispR += (hoveredBubble.r * (hRank < TOP_CIRCLES ? 1.08 : 1) - hoveredBubble.dispR) * 0.16;
        drawBubble(ctx, hoveredBubble, true, pctToColors(hoveredBubble.pctChange), dpr, hRank);
      }

      ctx.restore();
    };

    const loop = () => { render(); rafRef.current = requestAnimationFrame(loop); };
    rafRef.current = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(rafRef.current); };
  }, []);

  // ── Resize observer ────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas    = canvasRef.current;
    if (!container || !canvas) return;

    const obs = new ResizeObserver(([entry]) => {
      const dpr = window.devicePixelRatio || 1;
      const w   = entry.contentRect.width;
      const h   = height;
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width  = `${w}px`;
      canvas.style.height = `${h}px`;
      // Re-run layout on resize
      if (bubblesRef.current.length > 0) {
        runLayout(bubblesRef.current, w, h);
      }
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, [height]);

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  const canvasToWorld = useCallback((cx: number, cy: number) => {
    const { scale, ox, oy } = transformRef.current;
    return { x: (cx - ox) / scale, y: (cy - oy) / scale };
  }, []);

  const findBubble = useCallback((wx: number, wy: number) => {
    const bs = bubblesRef.current;
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i];
      const dx = wx - b.dispX;
      const dy = wy - b.dispY;
      if (dx * dx + dy * dy <= b.dispR * b.dispR) return i;
    }
    return -1;
  }, []);

  const clientToCanvas = useCallback((e: MouseEvent | React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
  }, []);

  // ── Mouse / touch handlers ─────────────────────────────────────────────────
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const { cx, cy } = clientToCanvas(e);
    const { x, y }   = canvasToWorld(cx, cy);
    const idx         = findBubble(x, y);
    hoverIdxRef.current = idx;

    if (idx >= 0) {
      const b = bubblesRef.current[idx];
      canvasRef.current!.style.cursor = "pointer";
      const bScreenX = b.dispX * transformRef.current.scale + transformRef.current.ox;
      const bScreenY = b.dispY * transformRef.current.scale + transformRef.current.oy;
      setTooltip({ visible: true, x: bScreenX, y: bScreenY, token: b });
    } else {
      canvasRef.current!.style.cursor = "default";
      setTooltip(t => ({ ...t, visible: false }));
    }
  }, [canvasToWorld, clientToCanvas, findBubble]);

  const onClick = useCallback((e: React.MouseEvent) => {
    const { cx, cy } = clientToCanvas(e);
    const { x, y }   = canvasToWorld(cx, cy);
    const idx         = findBubble(x, y);
    if (idx >= 0) {
      const token = bubblesRef.current[idx];
      // Use SPA navigation (wouter) instead of a hard reload so the animation
      // doesn't abruptly stop and the browser doesn't flash a blank page.
      navigate(`/coin/${token.address}`);
    }
  }, [canvasToWorld, clientToCanvas, findBubble, navigate]);

  const onMouseLeave = useCallback(() => {
    hoverIdxRef.current = -1;
    setTooltip(t => ({ ...t, visible: false }));
  }, []);

  const solUsd = solPrice ?? SOL_PRICE_USD;

  return (
    <div className="relative w-full select-none" style={{ height }} ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="rounded-xl block"
        style={{ width: "100%", height, cursor: "default", background: "#000000" }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      />

      {/* Tooltip */}
      {tooltip.visible && tooltip.token && (() => {
        const b = tooltip.token;
        const pct = b.pctChange;
        const mcUsd = b.marketCapSol * solUsd;
        const fmtMc = mcUsd >= 1e9 ? `$${(mcUsd/1e9).toFixed(2)}B`
          : mcUsd >= 1e6 ? `$${(mcUsd/1e6).toFixed(2)}M`
          : mcUsd >= 1e3 ? `$${(mcUsd/1e3).toFixed(1)}K`
          : `$${mcUsd.toFixed(0)}`;
        const pctColor = pct > 0.3 ? "#4ade80" : pct < -0.3 ? "#f87171" : "#b3b3b3";
        return (
          <div
            className="pointer-events-none absolute z-50 px-3 py-2.5 rounded-xl text-[12px] font-medium"
            style={{
              left: Math.min(tooltip.x + 14, (containerRef.current?.offsetWidth ?? 400) - 160),
              top:  Math.max(tooltip.y - 80, 8),
              background: "rgba(0,0,0,0.92)",
              border: "1px solid rgba(255,255,255,0.10)",
              backdropFilter: "blur(12px)",
              minWidth: 140,
              boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
            }}
          >
            <div className="font-bold text-[14px] text-white mb-0.5">{b.symbol.replace(/^\$/, "")}</div>
            <div className="text-[11px] mb-2" style={{ color: "#b3b3b3" }}>{b.name}</div>
            <div className="flex justify-between gap-4">
              <span style={{ color: "#b3b3b3" }}>Mkt Cap</span>
              <span className="font-mono text-white">{fmtMc}</span>
            </div>
            <div className="flex justify-between gap-4 mt-0.5">
              <span style={{ color: "#b3b3b3" }}>Change</span>
              <span className="font-mono font-bold" style={{ color: pctColor }}>
                {formatPct(pct)}
              </span>
            </div>
            <div className="flex justify-between gap-4 mt-0.5">
              <span style={{ color: "#b3b3b3" }}>Chain</span>
              <span style={{ color: "#b3b3b3" }}>{b.platform}</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
