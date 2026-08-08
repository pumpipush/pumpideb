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

const MIN_R = 14;
const MAX_R = 80;
const GAP   = 1.5;
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
      pctHex: "#94a3b8",
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

  // Restore exact target radii and sync display
  for (let i = 0; i < n; i++) bubbles[i].r = targetR[i];
  for (const b of bubbles) { b.dispX = b.x; b.dispY = b.y; b.dispR = b.r; }
}

// ─── Canvas renderer ──────────────────────────────────────────────────────────
// Solid sphere style — matches BirdEye reference:
//   vivid color fill with radial gradient (lighter center, darker edge),
//   subtle top-left specular, thin dark border for definition.
//
// Text tiers:  r<16 → nothing | 16–26 → % only | 26–40 → sym+% | 40+ → logo+sym+%

function drawBubble(
  ctx: CanvasRenderingContext2D,
  b: BubbleState,
  isHovered: boolean,
  colors: ReturnType<typeof pctToColors>,
  dpr: number,
) {
  const x = b.dispX, y = b.dispY, r = b.dispR;
  const { center: c, mid: m, edge: e } = colors;

  ctx.save();

  // ── 1. Outer glow (softens edge, gives depth) ─────────────────────────────
  ctx.shadowBlur  = (isHovered ? 24 : 10) * dpr;
  ctx.shadowColor = colors.glow;

  // ── 2. Solid sphere body — off-center radial gradient (light from top-left)
  const grad = ctx.createRadialGradient(
    x - r * 0.30, y - r * 0.32, r * 0.02,  // light source
    x + r * 0.10, y + r * 0.10, r * 1.04,   // shadow side
  );
  grad.addColorStop(0.00, `rgb(${c.r},${c.g},${c.b})`);
  grad.addColorStop(0.45, `rgb(${Math.round(lerp(c.r,m.r,0.55))},${Math.round(lerp(c.g,m.g,0.55))},${Math.round(lerp(c.b,m.b,0.55))})`);
  grad.addColorStop(0.80, `rgb(${m.r},${m.g},${m.b})`);
  grad.addColorStop(1.00, `rgb(${e.r},${e.g},${e.b})`);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.shadowBlur = 0;

  // ── 3. Specular highlight — glass-like sheen top-left ─────────────────────
  const shine = ctx.createRadialGradient(
    x - r * 0.32, y - r * 0.36, 0,
    x - r * 0.14, y - r * 0.18, r * 0.72,
  );
  shine.addColorStop(0,    isHovered ? "rgba(255,255,255,0.30)" : "rgba(255,255,255,0.22)");
  shine.addColorStop(0.40, "rgba(255,255,255,0.07)");
  shine.addColorStop(1,    "rgba(255,255,255,0)");
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = shine;
  ctx.fill();

  // ── 4. Thin dark border — separates touching bubbles cleanly ──────────────
  ctx.beginPath();
  ctx.arc(x, y, r - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = isHovered ? "rgba(255,255,255,0.40)" : "rgba(0,0,0,0.50)";
  ctx.lineWidth   = isHovered ? 1.5 : 0.8;
  ctx.stroke();

  ctx.restore();

  if (r < 16) return;

  // ── Text layout ───────────────────────────────────────────────────────────
  const showLogo   = r >= 40 && b.img && b.imgLoaded && b.img.naturalWidth > 0;
  const showSymbol = r >= 26;
  const pctText    = (b.pctChange >= 0 ? "+" : "") + b.pctChange.toFixed(2) + "%";
  const pctFontSz  = Math.max(7,  Math.min(r * 0.30, 20));
  const symFontSz  = Math.max(6,  Math.min(r * 0.20, 13));
  const logoR      = r * 0.26;
  const gap        = r * 0.07;

  let blockH = pctFontSz;
  if (showSymbol) blockH += symFontSz + gap;
  if (showLogo)   blockH += logoR * 2  + gap;
  let curY = y - blockH / 2;

  // Logo — circular clip
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
    ctx.save();
    ctx.font = `700 ${symFontSz}px Inter,'SF Pro Display',system-ui,sans-serif`;
    ctx.fillStyle    = "rgba(255,255,255,0.95)";
    ctx.textAlign    = "center";
    ctx.textBaseline = "top";
    ctx.shadowBlur   = 4;
    ctx.shadowColor  = "rgba(0,0,0,0.90)";
    ctx.fillText(b.symbol.replace(/^\$/, "").substring(0, 8), x, curY);
    ctx.restore();
    curY += symFontSz + gap;
  }

  // % change — bold white (primary)
  ctx.save();
  ctx.font = `800 ${pctFontSz}px Inter,'SF Pro Display',system-ui,sans-serif`;
  ctx.fillStyle    = colors.pctHex;
  ctx.textAlign    = "center";
  ctx.textBaseline = "top";
  ctx.shadowBlur   = 6;
  ctx.shadowColor  = "rgba(0,0,0,0.95)";
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

      // Pure black background (like reference — gaps between bubbles show as black)
      ctx.fillStyle = "#000000";
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
