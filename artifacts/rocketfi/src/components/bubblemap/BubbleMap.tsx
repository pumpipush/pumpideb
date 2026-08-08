/**
 * BubbleMap — Production-quality Canvas2D crypto market bubble map.
 * - Force-directed layout with collision avoidance
 * - Radial gradients + glow for each bubble
 * - Real-time color updates from live price feed (no layout recalc on every tick)
 * - Hover tooltip, zoom/pan, click-to-navigate
 */
import { useEffect, useRef, useCallback, useState } from "react";

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
}

export interface LivePriceUpdate {
  priceEth?: string;
  marketCapEth?: string;
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
  floatPhaseX: number; // random 0–2π
  floatPhaseY: number;
  floatFreqX:  number; // radians/ms ≈ 0.0004–0.0009
  floatFreqY:  number;
  floatAmp:    number; // pixels
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

const MIN_R = 12;
const MAX_R = 72;
const GAP   = 2;
const SOL_PRICE_USD = 160;  // fallback if no solPrice prop

// ─── Color helpers ────────────────────────────────────────────────────────────

type RGB = { r: number; g: number; b: number };

// Returns colors for glass-bubble style:
//   center/mid/edge = very dark tint used at low alpha (transparent fill)
//   border = vivid stroke ring (the main visual identity)
//   glow   = outer shadow matching border
//   pctHex = text color
function pctToColors(pct: number): {
  center: RGB; mid: RGB; edge: RGB;
  glow: string; border: string; borderRgb: RGB;
  fillAlpha: number; pctHex: string;
} {
  if (pct > 0.15) {
    const t = Math.min(pct / 20, 1);
    const g = Math.round(lerp(160, 220, t));
    return {
      center:    { r: 20, g, b: 60 },
      mid:       { r: 8,  g: Math.round(g * 0.55), b: 25 },
      edge:      { r: 2,  g: Math.round(g * 0.25), b: 8  },
      border:    `rgba(30,${g},70,${lerp(0.75, 1.0, t)})`,
      borderRgb: { r: 30, g, b: 70 },
      glow:      `rgba(20,${g},55,${lerp(0.35, 0.65, t)})`,
      fillAlpha: lerp(0.06, 0.13, t),
      pctHex:    `rgb(${Math.round(lerp(100,180,t))},${g},${Math.round(lerp(110,140,t))})`,
    };
  } else if (pct < -0.15) {
    const t = Math.min(-pct / 20, 1);
    const r = Math.round(lerp(190, 245, t));
    return {
      center:    { r, g: 18, b: 18 },
      mid:       { r: Math.round(r * 0.55), g: 8, b: 8 },
      edge:      { r: Math.round(r * 0.25), g: 2, b: 2 },
      border:    `rgba(${r},22,22,${lerp(0.75, 1.0, t)})`,
      borderRgb: { r, g: 22, b: 22 },
      glow:      `rgba(${r},15,15,${lerp(0.35, 0.65, t)})`,
      fillAlpha: lerp(0.06, 0.13, t),
      pctHex:    `rgb(${r},${Math.round(lerp(80,50,t))},${Math.round(lerp(80,50,t))})`,
    };
  } else {
    // Neutral — subtle dark ring, barely visible so colorful ones pop
    return {
      center:    { r: 20, g: 22, b: 36 },
      mid:       { r: 10, g: 11, b: 20 },
      edge:      { r: 5,  g: 6,  b: 11 },
      border:    "rgba(90,100,140,0.22)",
      borderRgb: { r: 90, g: 100, b: 140 },
      glow:      "rgba(50,55,90,0.06)",
      fillAlpha: 0.50, // neutral: more opaque dark fill so bubble is visible
      pctHex:    "#64748b",
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

function calcRadius(rank: number, total: number): number {
  if (total <= 1) return MAX_R;
  const norm   = 1 - rank / (total - 1);          // 1.0 (rank 0) → 0.0 (rank n-1)
  // Exponent 2.2 = steep power curve: top 5 tokens are BIG, bottom 60 are small
  // rank 0 → 72px, rank 4 → ~65px, rank 24 → ~42px, rank 49 → ~24px, rank 74 → ~15px
  const curved = Math.pow(norm, 2.2);
  return Math.max(MIN_R, Math.min(MAX_R, MIN_R + curved * (MAX_R - MIN_R)));
}

// ─── Force layout ─────────────────────────────────────────────────────────────
// Uses phyllotaxis (golden angle) initialization for even canvas coverage,
// then relaxes with center gravity + collision repulsion + soft boundary forces.

const GOLDEN_ANGLE = 2.39996; // radians — fills plane without clustering

function runLayout(bubbles: BubbleState[], W: number, H: number, steps = 320) {
  if (W <= 0 || H <= 0) return;
  const cx = W / 2;
  const cy = H / 2;
  const n  = bubbles.length;
  if (n === 0) return;

  // ── Phyllotaxis initialization ─────────────────────────────────────────────
  // Scale to ~80% of the shorter canvas dimension so bubbles start spread out
  const initR = Math.min(W, H) * 0.46;
  bubbles.forEach((b, i) => {
    const t     = (i + 1) / (n + 1);
    const r     = Math.sqrt(t) * initR;
    const theta = i * GOLDEN_ANGLE;
    b.x  = cx + r * Math.cos(theta);
    b.y  = cy + r * Math.sin(theta);
    b.vx = 0;
    b.vy = 0;
  });

  // ── Iterative relaxation ───────────────────────────────────────────────────
  for (let step = 0; step < steps; step++) {
    const alpha = Math.pow(1 - step / steps, 1.2); // cooling

    for (let i = 0; i < n; i++) {
      const a = bubbles[i];

      // Weak center gravity — keeps bubbles roughly centered
      a.vx += (cx - a.x) * 0.005 * alpha;
      a.vy += (cy - a.y) * 0.005 * alpha;

      // Bubble-bubble repulsion (broader zone: 1.4× contact distance)
      for (let j = i + 1; j < n; j++) {
        const b   = bubbles[j];
        const dx  = b.x - a.x;
        const dy  = b.y - a.y;
        const d   = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const minD = a.r + b.r + GAP;
        if (d < minD * 1.4) {
          const overlap = (minD - d) / minD;
          const force   = (d < minD ? overlap * 0.75 : overlap * 0.15);
          const nx = dx / d;
          const ny = dy / d;
          const total = a.r + b.r;
          a.vx -= nx * force * (b.r / total);
          a.vy -= ny * force * (b.r / total);
          b.vx += nx * force * (a.r / total);
          b.vy += ny * force * (a.r / total);
        }
      }

      // Soft boundary forces (velocity-based — bubbles bounce back smoothly)
      const pad = a.r + GAP;
      if (a.x < pad)      a.vx += (pad - a.x)      * 0.4;
      if (a.x > W - pad)  a.vx += (W - pad - a.x)  * 0.4;
      if (a.y < pad)      a.vy += (pad - a.y)       * 0.4;
      if (a.y > H - pad)  a.vy += (H - pad - a.y)   * 0.4;

      // Damping + integrate
      a.vx *= 0.84;
      a.vy *= 0.84;
      a.x  += a.vx;
      a.y  += a.vy;

      // Hard boundary clamp (safety net)
      a.x = Math.max(pad, Math.min(W - pad, a.x));
      a.y = Math.max(pad, Math.min(H - pad, a.y));
    }
  }

  // Sync display positions
  for (const b of bubbles) {
    b.dispX = b.x;
    b.dispY = b.y;
    b.dispR = b.r;
  }
}

// ─── Canvas renderer ──────────────────────────────────────────────────────────
// Glass bubble style: transparent fill, vivid colored border ring, glow.
// Text tiers:  r<18 → nothing | 18–28 → % only | 28–44 → sym+% | 44+ → logo+sym+%

function drawBubble(
  ctx: CanvasRenderingContext2D,
  b: BubbleState,
  isHovered: boolean,
  colors: ReturnType<typeof pctToColors>,
  dpr: number,
) {
  const x = b.dispX, y = b.dispY, r = b.dispR;
  const { center: c, mid: m, borderRgb: br } = colors;
  const fa = isHovered ? Math.min(colors.fillAlpha * 1.6, 0.28) : colors.fillAlpha;
  const bw = isHovered ? 2.8 : 1.8;  // border width px

  ctx.save();

  // ── 1. Outer glow (shadow on border stroke) ───────────────────────────────
  ctx.shadowBlur  = (isHovered ? 28 : 16) * dpr;
  ctx.shadowColor = colors.glow;

  // ── 2. Transparent fill — very subtle color tint ──────────────────────────
  // For colored bubbles: near-transparent with color tint
  // For neutral: semi-dark so the circle shape is visible
  const fillGrad = ctx.createRadialGradient(x, y, 0, x, y, r);
  fillGrad.addColorStop(0,   `rgba(${c.r},${c.g},${c.b},${fa * 0.4})`);
  fillGrad.addColorStop(0.5, `rgba(${m.r},${m.g},${m.b},${fa * 0.7})`);
  fillGrad.addColorStop(1,   `rgba(${m.r},${m.g},${m.b},${fa})`);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // ── 3. Outer border ring (colored — the main identity) ────────────────────
  ctx.beginPath();
  ctx.arc(x, y, r - bw / 2, 0, Math.PI * 2);
  ctx.strokeStyle = isHovered
    ? `rgba(${br.r},${br.g},${br.b},1)`
    : colors.border;
  ctx.lineWidth = bw;
  ctx.stroke();

  ctx.shadowBlur = 0;

  // ── 4. Inner rim highlight (glass ring effect) ────────────────────────────
  ctx.beginPath();
  ctx.arc(x, y, r - bw - 1.5, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${br.r},${br.g},${br.b},0.10)`;
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // ── 5. Specular highlight (soap-bubble sheen, top-left arc) ───────────────
  if (r >= 20) {
    const shineGrad = ctx.createRadialGradient(
      x - r * 0.30, y - r * 0.38, 0,
      x - r * 0.10, y - r * 0.18, r * 0.65,
    );
    shineGrad.addColorStop(0,   "rgba(255,255,255,0.28)");
    shineGrad.addColorStop(0.4, "rgba(255,255,255,0.08)");
    shineGrad.addColorStop(1,   "rgba(255,255,255,0)");
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = shineGrad;
    ctx.fill();
  }

  ctx.restore();

  if (r < 18) return;

  // ── Text layout ───────────────────────────────────────────────────────────
  const showLogo   = r >= 44 && b.img && b.imgLoaded;
  const showSymbol = r >= 28;
  const pctText    = (b.pctChange >= 0 ? "+" : "") + b.pctChange.toFixed(2) + "%";
  const pctFontSz  = Math.max(6,  Math.min(r * 0.27, 18));
  const symFontSz  = Math.max(5,  Math.min(r * 0.19, 12));
  const logoR      = r * 0.27;
  const gap        = r * 0.07;

  let blockH = pctFontSz;
  if (showSymbol) blockH += symFontSz + gap;
  if (showLogo)   blockH += logoR * 2  + gap;
  let curY = y - blockH / 2;

  // Logo
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

  // Symbol
  if (showSymbol) {
    const sym = b.symbol.replace(/^\$/, "").substring(0, 8);
    ctx.save();
    ctx.font = `700 ${symFontSz}px Inter,'SF Pro Display',system-ui,sans-serif`;
    ctx.fillStyle    = "rgba(255,255,255,0.92)";
    ctx.textAlign    = "center";
    ctx.textBaseline = "top";
    ctx.shadowBlur   = 3;
    ctx.shadowColor  = "rgba(0,0,0,0.95)";
    ctx.fillText(sym, x, curY);
    ctx.restore();
    curY += symFontSz + gap;
  }

  // % change — primary, most vivid
  ctx.save();
  ctx.font = `800 ${pctFontSz}px Inter,'SF Pro Display',system-ui,sans-serif`;
  ctx.fillStyle    = colors.pctHex;
  ctx.textAlign    = "center";
  ctx.textBaseline = "top";
  ctx.shadowBlur   = 5;
  ctx.shadowColor  = "rgba(0,0,0,0.98)";
  ctx.fillText(pctText, x, curY);
  ctx.restore();
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
}

export default function BubbleMap({ tokens, liveUpdates, solPrice, height = 420 }: BubbleMapProps) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const containerRef  = useRef<HTMLDivElement>(null);
  const bubblesRef    = useRef<BubbleState[]>([]);
  const transformRef  = useRef<Transform>({ scale: 1, ox: 0, oy: 0 });
  const hoverIdxRef   = useRef<number>(-1);
  const rafRef        = useRef<number>(0);
  const initPricesRef = useRef<Map<string, number>>(new Map());
  const isDragging    = useRef(false);
  const dragStart     = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  const [tooltip, setTooltip] = useState<TooltipState>({ visible: false, x: 0, y: 0, token: null });

  // ── Initialize / re-layout when tokens change ──────────────────────────────
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;

    // Use container CSS dimensions (available before ResizeObserver fires)
    const W = containerRef.current?.offsetWidth ?? 600;
    const H = height;

    // tokens arrive pre-sorted by volume desc from the API
    const prevMap = new Map(bubblesRef.current.map(b => [b.address, b]));

    const newBubbles: BubbleState[] = tokens.map((t, i) => {
      const volSol = parseFloat(t.volumeEth ?? t.marketCapEth ?? "0") / 1e9;
      const mcSol  = parseFloat(t.marketCapEth ?? "0") / 1e9;
      // Rank-based sizing: index 0 = highest volume → MAX_R
      const r      = calcRadius(i, tokens.length);
      const prev   = prevMap.get(t.address);

      // Store initial price for % change tracking
      const initPrice = parseFloat(t.priceEth ?? "0");
      if (!initPricesRef.current.has(t.address) && initPrice > 0) {
        initPricesRef.current.set(t.address, initPrice);
      }

      // Spread initial positions in a rough circle so layout converges faster
      const angle  = (i / tokens.length) * Math.PI * 2;
      const spread = Math.min(W, H) * 0.25;

      const pct  = prev?.pctChange ?? 0;
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
        dispR: prev?.dispR ?? r,
        colorR: prev?.colorR ?? cols.center.r,
        colorG: prev?.colorG ?? cols.center.g,
        colorB: prev?.colorB ?? cols.center.b,
        targetR: cols.center.r,
        targetG: cols.center.g,
        targetB: cols.center.b,
        // Unique floating bob per bubble — keep existing if re-using prev
        floatPhaseX: prev?.floatPhaseX ?? Math.random() * Math.PI * 2,
        floatPhaseY: prev?.floatPhaseY ?? Math.random() * Math.PI * 2,
        floatFreqX:  prev?.floatFreqX  ?? (0.00025 + Math.random() * 0.00040),
        floatFreqY:  prev?.floatFreqY  ?? (0.00020 + Math.random() * 0.00038),
        floatAmp:    prev?.floatAmp    ?? (r * 0.10 + Math.random() * r * 0.08), // ~10–18% of radius
        imgLoaded: prev?.imgLoaded ?? false,
        img: prev?.img,
      };

      // Load logo
      const resolvedUrl = t.imageUrl
        ? (t.imageUrl.startsWith("http") ? t.imageUrl : `/api/image-proxy?url=${encodeURIComponent(t.imageUrl)}`)
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

    // Run layout synchronously (fast enough for ≤ 60 tokens)
    runLayout(newBubbles, W, H);
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

      // Background
      ctx.fillStyle = "#050508";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Subtle radial background glow (in physical pixels)
      const bg = ctx.createRadialGradient(
        canvas.width / 2, canvas.height / 2, 0,
        canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.6
      );
      bg.addColorStop(0,   "rgba(15,20,40,0.6)");
      bg.addColorStop(0.6, "rgba(8,10,20,0.3)");
      bg.addColorStop(1,   "rgba(0,0,0,0)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Apply dpr scale + pan/zoom in CSS space
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, ox * dpr, oy * dpr);
      ctx.save();

      const hIdx  = hoverIdxRef.current;
      const bubbles = bubblesRef.current;

      // Float + lerp — compound sine waves for organic non-repeating motion
      const T = performance.now() * 0.001; // seconds
      for (const b of bubbles) {
        // Primary wave + secondary wave at golden-ratio frequency (1.618×) for aperiodic feel
        const fx = b.floatAmp * (
          0.65 * Math.sin(T * b.floatFreqX + b.floatPhaseX) +
          0.35 * Math.sin(T * b.floatFreqX * 1.618 + b.floatPhaseX * 2.1)
        );
        const fy = b.floatAmp * (
          0.65 * Math.cos(T * b.floatFreqY + b.floatPhaseY) +
          0.35 * Math.cos(T * b.floatFreqY * 1.414 + b.floatPhaseY * 1.7)
        );
        // Smooth spring lerp toward (layout position + float offset)
        b.dispX  += (b.x + fx - b.dispX) * 0.04;
        b.dispY  += (b.y + fy - b.dispY) * 0.04;
        b.colorR += (b.targetR - b.colorR) * 0.04;
        b.colorG += (b.targetG - b.colorG) * 0.04;
        b.colorB += (b.targetB - b.colorB) * 0.04;
      }

      // Z-ordering: draw smallest → largest so big bubbles appear in front.
      // bubbles[] is already sorted largest-first, so iterate in reverse.
      const hoveredBubble = hIdx >= 0 && hIdx < bubbles.length ? bubbles[hIdx] : null;
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        if (b === hoveredBubble) continue; // draw hovered last (top of stack)
        b.dispR += (b.r - b.dispR) * 0.10;
        drawBubble(ctx, b, false, pctToColors(b.pctChange), dpr);
      }
      if (hoveredBubble) {
        hoveredBubble.dispR += (hoveredBubble.r * 1.10 - hoveredBubble.dispR) * 0.16;
        drawBubble(ctx, hoveredBubble, true, pctToColors(hoveredBubble.pctChange), dpr);
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

    if (isDragging.current) {
      const { x: sx, y: sy, ox, oy } = dragStart.current;
      transformRef.current.ox = ox + (e.clientX - sx);
      transformRef.current.oy = oy + (e.clientY - sy);
      setTooltip(t => ({ ...t, visible: false }));
      return;
    }

    if (idx >= 0) {
      const b = bubblesRef.current[idx];
      canvasRef.current!.style.cursor = "pointer";
      // Position tooltip near bubble
      const bScreenX = b.dispX * transformRef.current.scale + transformRef.current.ox;
      const bScreenY = b.dispY * transformRef.current.scale + transformRef.current.oy;
      setTooltip({ visible: true, x: bScreenX, y: bScreenY, token: b });
    } else {
      canvasRef.current!.style.cursor = isDragging.current ? "grabbing" : "grab";
      setTooltip(t => ({ ...t, visible: false }));
    }
  }, [canvasToWorld, clientToCanvas, findBubble]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStart.current  = {
      x: e.clientX, y: e.clientY,
      ox: transformRef.current.ox, oy: transformRef.current.oy,
    };
  }, []);

  const onMouseUp = useCallback(() => { isDragging.current = false; }, []);

  const onClick = useCallback((e: React.MouseEvent) => {
    const { cx, cy } = clientToCanvas(e);
    const { x, y }   = canvasToWorld(cx, cy);
    const idx         = findBubble(x, y);
    if (idx >= 0) {
      const token = bubblesRef.current[idx];
      window.location.href = `/app?token=${token.address}`;
    }
  }, [canvasToWorld, clientToCanvas, findBubble]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta  = e.deltaY > 0 ? 0.9 : 1.1;
    const { cx, cy } = clientToCanvas(e as unknown as React.MouseEvent);
    const t = transformRef.current;
    const newScale = Math.max(0.4, Math.min(4, t.scale * delta));
    // Zoom toward cursor
    t.ox = cx - (cx - t.ox) * (newScale / t.scale);
    t.oy = cy - (cy - t.oy) * (newScale / t.scale);
    t.scale = newScale;
  }, [clientToCanvas]);

  const resetView = useCallback(() => {
    transformRef.current = { scale: 1, ox: 0, oy: 0 };
  }, []);

  const onMouseLeave = useCallback(() => {
    hoverIdxRef.current = -1;
    isDragging.current  = false;
    setTooltip(t => ({ ...t, visible: false }));
  }, []);

  const solUsd = solPrice ?? SOL_PRICE_USD;

  return (
    <div className="relative w-full select-none" style={{ height }} ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="rounded-xl block"
        style={{ width: "100%", height, cursor: "grab", background: "#050508" }}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
        onWheel={onWheel}
      />

      {/* Reset view button */}
      <button
        onClick={resetView}
        className="absolute bottom-3 right-3 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md transition-all"
        style={{ background: "rgba(255,255,255,0.07)", color: "#64748b", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        Reset
      </button>

      {/* Tooltip */}
      {tooltip.visible && tooltip.token && (() => {
        const b = tooltip.token;
        const pct = b.pctChange;
        const mcUsd = b.marketCapSol * solUsd;
        const fmtMc = mcUsd >= 1e9 ? `$${(mcUsd/1e9).toFixed(2)}B`
          : mcUsd >= 1e6 ? `$${(mcUsd/1e6).toFixed(2)}M`
          : mcUsd >= 1e3 ? `$${(mcUsd/1e3).toFixed(1)}K`
          : `$${mcUsd.toFixed(0)}`;
        const pctColor = pct > 0.3 ? "#4ade80" : pct < -0.3 ? "#f87171" : "#94a3b8";
        return (
          <div
            className="pointer-events-none absolute z-50 px-3 py-2.5 rounded-xl text-[12px] font-medium"
            style={{
              left: Math.min(tooltip.x + 14, (containerRef.current?.offsetWidth ?? 400) - 160),
              top:  Math.max(tooltip.y - 80, 8),
              background: "rgba(8,10,20,0.92)",
              border: "1px solid rgba(255,255,255,0.10)",
              backdropFilter: "blur(12px)",
              minWidth: 140,
              boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
            }}
          >
            <div className="font-bold text-[14px] text-white mb-0.5">{b.symbol.replace(/^\$/, "")}</div>
            <div className="text-[11px] mb-2" style={{ color: "#64748b" }}>{b.name}</div>
            <div className="flex justify-between gap-4">
              <span style={{ color: "#94a3b8" }}>Mkt Cap</span>
              <span className="font-mono text-white">{fmtMc}</span>
            </div>
            <div className="flex justify-between gap-4 mt-0.5">
              <span style={{ color: "#94a3b8" }}>Change</span>
              <span className="font-mono font-bold" style={{ color: pctColor }}>
                {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-between gap-4 mt-0.5">
              <span style={{ color: "#94a3b8" }}>Chain</span>
              <span style={{ color: "#94a3b8" }}>{b.platform}</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
