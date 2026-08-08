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

const MIN_R = 24;
const MAX_R = 88;
const GAP   = 5;           // min gap between bubbles
const SOL_PRICE_USD = 160; // fallback if no solPrice prop

// ─── Color helpers ────────────────────────────────────────────────────────────

type RGB = { r: number; g: number; b: number };

function pctToColors(pct: number): {
  center: RGB; mid: RGB; edge: RGB; glow: string; border: string; pctHex: string;
} {
  if (pct > 0.3) {
    const t = Math.min(pct / 20, 1);
    return {
      center: { r: lerp(40, 0, t),   g: lerp(160, 230, t), b: lerp(60, 50, t) },
      mid:    { r: lerp(15, 0, t),   g: lerp(80, 130, t),  b: lerp(25, 20, t) },
      edge:   { r: 0, g: lerp(40, 70, t), b: 5 },
      glow:   `rgba(0,${Math.round(lerp(180, 255, t))},40,${lerp(0.18, 0.40, t)})`,
      border: `rgba(0,${Math.round(lerp(140, 210, t))},50,0.6)`,
      pctHex: `#${toHex(lerp(100, 180, t))}${toHex(lerp(230, 255, t))}${toHex(lerp(100, 120, t))}`,
    };
  } else if (pct < -0.3) {
    const t = Math.min(-pct / 20, 1);
    return {
      center: { r: lerp(180, 240, t), g: lerp(30, 20, t),  b: lerp(30, 20, t) },
      mid:    { r: lerp(90, 140, t),  g: lerp(15, 10, t),  b: lerp(15, 10, t) },
      edge:   { r: lerp(50, 80, t), g: 0, b: 0 },
      glow:   `rgba(${Math.round(lerp(200, 255, t))},0,0,${lerp(0.18, 0.40, t)})`,
      border: `rgba(${Math.round(lerp(150, 220, t))},0,0,0.6)`,
      pctHex: `#${toHex(lerp(220, 255, t))}${toHex(lerp(80, 50, t))}${toHex(lerp(80, 50, t))}`,
    };
  } else {
    // near-zero: dark neutral
    return {
      center: { r: 35, g: 38, b: 55 },
      mid:    { r: 18, g: 20, b: 32 },
      edge:   { r: 10, g: 11, b: 20 },
      glow:   `rgba(80,80,120,0.10)`,
      border: `rgba(80,80,130,0.35)`,
      pctHex: "#6b7280",
    };
  }
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function toHex(n: number) { return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0"); }

// ─── Radius from market cap ───────────────────────────────────────────────────

function calcRadius(volSol: number, maxVolSol: number): number {
  if (maxVolSol <= 0 || volSol <= 0) return MIN_R;
  // Log scale: volume spans many orders of magnitude; log compresses without losing rank signal
  const logV   = Math.log1p(volSol);
  const logMax = Math.log1p(maxVolSol);
  const norm   = logV / logMax;
  return Math.max(MIN_R, Math.min(MAX_R, MIN_R + norm * (MAX_R - MIN_R)));
}

// ─── Force layout ─────────────────────────────────────────────────────────────
// Uses phyllotaxis (golden angle) initialization for even canvas coverage,
// then relaxes with center gravity + collision repulsion + soft boundary forces.

const GOLDEN_ANGLE = 2.39996; // radians — fills plane without clustering

function runLayout(bubbles: BubbleState[], W: number, H: number, steps = 450) {
  if (W <= 0 || H <= 0) return;
  const cx = W / 2;
  const cy = H / 2;
  const n  = bubbles.length;
  if (n === 0) return;

  // ── Phyllotaxis initialization ─────────────────────────────────────────────
  // Scale to ~80% of the shorter canvas dimension so bubbles start spread out
  const initR = Math.min(W, H) * 0.40;
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

function drawBubble(
  ctx: CanvasRenderingContext2D,
  b: BubbleState,
  isHovered: boolean,
  colors: ReturnType<typeof pctToColors>,
  dpr: number,
) {
  const x  = b.dispX;
  const y  = b.dispY;
  const r  = b.dispR;
  const cr = b.colorR, cg = b.colorG, cb = b.colorB;

  // --- Outer glow ---
  ctx.save();
  ctx.shadowBlur  = (isHovered ? 36 : 22) * dpr;
  ctx.shadowColor = colors.glow;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
  ctx.fill();
  ctx.restore();

  // --- Radial gradient body ---
  const grad = ctx.createRadialGradient(
    x - r * 0.28, y - r * 0.3, r * 0.05,
    x, y, r
  );
  grad.addColorStop(0,   `rgb(${colors.center.r},${colors.center.g},${colors.center.b})`);
  grad.addColorStop(0.45, `rgb(${colors.mid.r},${colors.mid.g},${colors.mid.b})`);
  grad.addColorStop(1,   `rgb(${colors.edge.r},${colors.edge.g},${colors.edge.b})`);

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // --- Specular highlight (top-left sheen) ---
  const shine = ctx.createRadialGradient(
    x - r * 0.3, y - r * 0.35, 0,
    x - r * 0.3, y - r * 0.35, r * 0.7
  );
  shine.addColorStop(0,   "rgba(255,255,255,0.14)");
  shine.addColorStop(0.5, "rgba(255,255,255,0.04)");
  shine.addColorStop(1,   "rgba(255,255,255,0)");
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = shine;
  ctx.fill();

  // --- Border ---
  ctx.beginPath();
  ctx.arc(x, y, r - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  // --- Logo ---
  if (b.img && b.imgLoaded && r >= 26) {
    const hasText = r >= 28;
    const logoR   = hasText ? r * 0.30 : r * 0.42;
    const logoY   = hasText ? y - r * 0.22 : y;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, logoY, logoR, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(b.img, x - logoR, logoY - logoR, logoR * 2, logoR * 2);
    ctx.restore();
  }

  // --- Symbol text ---
  if (r >= 22) {
    const hasLogo = b.img && b.imgLoaded && r >= 26;
    const symSize = Math.max(8, Math.min(r * 0.34, 17));
    ctx.save();
    ctx.font = `700 ${symSize}px Inter,'SF Pro Display',system-ui,sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.textAlign  = "center";
    ctx.textBaseline = "middle";
    ctx.shadowBlur  = 3;
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    const symY = hasLogo ? y + r * 0.12 : (r >= 32 ? y - r * 0.12 : y);
    const sym = b.symbol.replace(/^\$/, "").substring(0, 7);
    ctx.fillText(sym, x, symY);
    ctx.restore();
  }

  // --- % change text ---
  if (r >= 30) {
    const hasLogo = b.img && b.imgLoaded && r >= 26;
    const pctSize = Math.max(7, Math.min(r * 0.25, 13));
    const pctText = b.pctChange >= 0
      ? `+${b.pctChange.toFixed(1)}%`
      : `${b.pctChange.toFixed(1)}%`;
    ctx.save();
    ctx.font = `600 ${pctSize}px Inter,'SF Pro Display',system-ui,sans-serif`;
    ctx.fillStyle = colors.pctHex;
    ctx.textAlign  = "center";
    ctx.textBaseline = "middle";
    ctx.shadowBlur  = 2;
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    const pctY = hasLogo ? y + r * 0.40 : y + r * 0.28;
    ctx.fillText(pctText, x, pctY);
    ctx.restore();
  }
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

    const maxVolSol = Math.max(
      ...tokens.map(t => parseFloat(t.volumeEth ?? t.marketCapEth ?? "0") / 1e9)
    );

    const prevMap = new Map(bubblesRef.current.map(b => [b.address, b]));

    const newBubbles: BubbleState[] = tokens.map((t, i) => {
      const volSol = parseFloat(t.volumeEth ?? t.marketCapEth ?? "0") / 1e9;
      const mcSol  = parseFloat(t.marketCapEth ?? "0") / 1e9;
      const r      = calcRadius(volSol, maxVolSol);
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
        floatFreqX:  prev?.floatFreqX  ?? (0.00035 + Math.random() * 0.00055),
        floatFreqY:  prev?.floatFreqY  ?? (0.00030 + Math.random() * 0.00050),
        floatAmp:    prev?.floatAmp    ?? (3 + Math.random() * 6),
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

      // Lerp positions & colors — float offset applied to target so lerp smoothly follows the wave
      const now = performance.now();
      for (const b of bubbles) {
        const fx = b.floatAmp * Math.sin(now * b.floatFreqX + b.floatPhaseX);
        const fy = b.floatAmp * Math.cos(now * b.floatFreqY + b.floatPhaseY);
        b.dispX  += (b.x + fx - b.dispX) * 0.05;
        b.dispY  += (b.y + fy - b.dispY) * 0.05;
        b.colorR += (b.targetR - b.colorR) * 0.06;
        b.colorG += (b.targetG - b.colorG) * 0.06;
        b.colorB += (b.targetB - b.colorB) * 0.06;
      }

      // Draw non-hovered first, then hovered on top
      for (let i = 0; i < bubbles.length; i++) {
        if (i === hIdx) continue;
        const b   = bubbles[i];
        b.dispR  += (b.r - b.dispR) * 0.12;
        drawBubble(ctx, b, false, pctToColors(b.pctChange), dpr);
      }
      if (hIdx >= 0 && hIdx < bubbles.length) {
        const b = bubbles[hIdx];
        b.dispR += (b.r * 1.12 - b.dispR) * 0.18;
        drawBubble(ctx, b, true, pctToColors(b.pctChange), dpr);
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
