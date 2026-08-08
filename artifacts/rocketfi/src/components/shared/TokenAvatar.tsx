/**
 * TokenAvatar — professional gradient placeholder for tokens without a logo.
 * Uses an SVG radial gradient derived from the symbol string so each token
 * gets a unique, consistent visual identity.
 */
import { cn, resolveImageUrl } from "@/lib/utils";
import { useState, useEffect } from "react";

interface TokenAvatarProps {
  symbol: string;
  imageUrl?: string | null;
  /** Pixel size — controls both width/height. Default 40. */
  size?: number;
  className?: string;
  /** Shape: "square" | "circle" | "rounded". Default "square" (rounded-sm). */
  shape?: "square" | "circle" | "rounded";
}

// 8 vivid gradient pairs — professional, crypto-native feel
export const GRADIENTS: [string, string, string][] = [
  ["#6366f1", "#8b5cf6", "#1e1b4b"], // indigo → violet
  ["#3b82f6", "#06b6d4", "#0c1a2e"], // blue → cyan
  ["#0ea5e9", "#a855f7", "#0a1628"], // sky → purple
  ["#10b981", "#3b82f6", "#0a1f18"], // emerald → blue
  ["#f59e0b", "#ef4444", "#1f1208"], // amber → red
  ["#ec4899", "#8b5cf6", "#1f0a1a"], // pink → violet
  ["#06b6d4", "#10b981", "#081a1f"], // cyan → emerald
  ["#a855f7", "#6366f1", "#150a1f"], // purple → indigo
];

export function hashSymbol(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
  return Math.abs(h);
}

export function getGradient(symbol: string): [string, string, string] {
  return GRADIENTS[hashSymbol(symbol) % GRADIENTS.length];
}

/**
 * Returns a CSS `background` value for full-bleed card placeholders
 * (when the token fills a whole card area rather than a fixed pixel box).
 */
export function tokenCardBackground(symbol: string): string {
  const [c1, c2, bg] = getGradient(symbol);
  return `radial-gradient(ellipse at 30% 25%, ${c1}cc, ${c2}99), ${bg}`;
}

export function TokenAvatar({ symbol, imageUrl, size = 40, className, shape = "square" }: TokenAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  // Reset both states when imageUrl changes so new URLs are retried
  useEffect(() => { setImgError(false); setImgLoaded(false); }, [imageUrl]);

  const shapeClass =
    shape === "circle"  ? "rounded-full" :
    shape === "rounded" ? "rounded-lg" :
    "rounded-sm";

  const letter = symbol ? symbol.replace(/^\$/, "").charAt(0).toUpperCase() : "?";
  const [c1, c2, bg] = getGradient(symbol ?? "?");
  const gradId = `g-${hashSymbol(symbol ?? "?") % 10000}`;

  // If we have a valid image URL, render the img immediately (no placeholder while loading).
  // The container stays invisible until onLoad fires, then fades in.
  const resolvedUrl = resolveImageUrl(imageUrl);
  if (resolvedUrl && !imgError) {
    return (
      <div
        className={cn("shrink-0 overflow-hidden", shapeClass, className)}
        style={{
          width: size,
          height: size,
          // No border / background until image is ready — avoids a blank bordered box
          border: imgLoaded ? "1px solid rgba(255,255,255,0.10)" : "none",
        }}
      >
        <img
          src={resolvedUrl}
          alt={symbol}
          className="w-full h-full object-cover"
          loading="eager"
          decoding="async"
          style={{ opacity: imgLoaded ? 1 : 0, transition: "opacity 0.12s ease" }}
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgError(true)}
        />
      </div>
    );
  }

  // Gradient SVG placeholder
  const fontSize = size * 0.42;
  const r = shape === "circle" ? size / 2 : 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0", shapeClass, className)}
      style={{ display: "block" }}
      aria-label={symbol}
    >
      <defs>
        <radialGradient id={`${gradId}-r`} cx="30%" cy="25%" r="80%">
          <stop offset="0%" stopColor={c1} stopOpacity="0.95" />
          <stop offset="100%" stopColor={c2} stopOpacity="0.85" />
        </radialGradient>
        <linearGradient id={`${gradId}-l`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={c1} />
          <stop offset="100%" stopColor={c2} />
        </linearGradient>
        <clipPath id={`${gradId}-clip`}>
          <rect width={size} height={size} rx={shape === "circle" ? r : shape === "rounded" ? size * 0.2 : size * 0.1} ry={shape === "circle" ? r : shape === "rounded" ? size * 0.2 : size * 0.1} />
        </clipPath>
      </defs>

      <g clipPath={`url(#${gradId}-clip)`}>
        {/* Base fill */}
        <rect width={size} height={size} fill={bg} />

        {/* Radial glow */}
        <rect width={size} height={size} fill={`url(#${gradId}-r)`} opacity="0.8" />

        {/* Subtle grid pattern */}
        <pattern id={`${gradId}-p`} x="0" y="0" width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="white" opacity="0.04" />
        </pattern>
        <rect width={size} height={size} fill={`url(#${gradId}-p)`} />

        {/* Shine highlight */}
        <ellipse cx={size * 0.35} cy={size * 0.25} rx={size * 0.4} ry={size * 0.3} fill="white" opacity="0.07" />

        {/* Letter */}
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={fontSize}
          fontWeight="700"
          fontFamily="'Plus Jakarta Sans', sans-serif"
          fill="white"
          opacity="0.95"
          style={{ letterSpacing: "-0.5px" }}
        >
          {letter}
        </text>

        {/* Subtle inner border */}
        <rect
          width={size - 1}
          height={size - 1}
          x="0.5"
          y="0.5"
          rx={shape === "circle" ? r - 0.5 : shape === "rounded" ? size * 0.2 : size * 0.1}
          ry={shape === "circle" ? r - 0.5 : shape === "rounded" ? size * 0.2 : size * 0.1}
          fill="none"
          stroke="white"
          strokeOpacity="0.08"
          strokeWidth="1"
        />
      </g>
    </svg>
  );
}
