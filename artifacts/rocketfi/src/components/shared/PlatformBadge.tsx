/**
 * PlatformBadge — shows the source launchpad for a token.
 * Supports pump_fun, moonshot, letsbonk, and unknown.
 *
 * Usage:
 *   <PlatformBadge platform="pump_fun" />                // small chip
 *   <PlatformBadge platform="moonshot" size="md" />      // medium with icon+text
 *   <PlatformBadge platform="letsbonk" href="..." />     // clickable link
 */

import { cn } from "@/lib/utils";

export type PlatformId = "pump_fun" | "moonshot" | "letsbonk" | "unknown" | (string & {});

interface PlatformConfig {
  label: string;
  color: string;        // tailwind text color
  bg: string;           // tailwind bg color
  border: string;       // tailwind border color
  dot: string;          // fill color for indicator dot
  icon: React.ReactNode;
  sourceUrlTemplate?: string; // {address} placeholder
}

// Emoji icons work well here — crisp, no extra deps
const PLATFORM_CONFIGS: Record<string, PlatformConfig> = {
  pump_fun: {
    label: "Pump.fun",
    color: "text-emerald-300",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    dot: "#34d399",
    icon: <img src="/pumpfun.png" alt="pump.fun" className="w-4 h-4 rounded-sm object-cover" />,
    sourceUrlTemplate: "https://pump.fun/coin/{address}",
  },
  moonshot: {
    label: "Moonshot",
    color: "text-amber-300",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    dot: "#fbbf24",
    icon: <span role="img" aria-label="moonshot">🌙</span>,
    sourceUrlTemplate: "https://dexscreener.com/solana/{address}",
  },
  letsbonk: {
    label: "LetsBONK",
    color: "text-orange-300",
    bg: "bg-orange-500/10",
    border: "border-orange-500/20",
    dot: "#fb923c",
    icon: <span role="img" aria-label="letsbonk">🔨</span>,
    sourceUrlTemplate: "https://letsbonk.fun/token/{address}",
  },
  daos_fun: {
    label: "Daos.fun",
    color: "text-violet-300",
    bg: "bg-violet-500/10",
    border: "border-violet-500/20",
    dot: "#a78bfa",
    icon: <span role="img" aria-label="daos.fun">🏛️</span>,
    sourceUrlTemplate: "https://daos.fun/token/{address}",
  },
  raydium_launchlab: {
    label: "Raydium",
    color: "text-cyan-300",
    bg: "bg-cyan-500/10",
    border: "border-cyan-500/20",
    dot: "#67e8f9",
    icon: <span role="img" aria-label="raydium launchlab">⚡</span>,
    sourceUrlTemplate: "https://raydium.io/launchlab/{address}",
  },
  unknown: {
    label: "Unknown",
    color: "text-white/40",
    bg: "bg-white/5",
    border: "border-white/10",
    dot: "#6b7280",
    icon: <span role="img" aria-label="unknown">⬡</span>,
  },
};

function getConfig(platform: PlatformId): PlatformConfig {
  return PLATFORM_CONFIGS[platform] ?? PLATFORM_CONFIGS.unknown;
}

/** Returns the source platform URL for a given token address, or null */
export function getPlatformUrl(platform: PlatformId, address: string): string | null {
  const config = getConfig(platform);
  return config.sourceUrlTemplate
    ? config.sourceUrlTemplate.replace("{address}", address)
    : null;
}

interface PlatformBadgeProps {
  platform: PlatformId;
  /** "sm" = tiny chip (for cards), "md" = chip with icon (default), "lg" = pill with label */
  size?: "sm" | "md" | "lg";
  /** If provided, renders as an <a> tag linking to the source platform */
  href?: string;
  className?: string;
  /** Hide the text label, show only the icon + dot */
  iconOnly?: boolean;
}

export function PlatformBadge({
  platform,
  size = "md",
  href,
  className,
  iconOnly = false,
}: PlatformBadgeProps) {
  const cfg = getConfig(platform);

  const inner = (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-semibold border select-none shrink-0",
        size === "sm"  && "text-[9px]  px-1    py-0    rounded-[3px]",
        size === "md"  && "text-[10px] px-1.5  py-0.5  rounded-[4px]",
        size === "lg"  && "text-[11px] px-2    py-1    rounded-[5px]",
        cfg.bg, cfg.border, cfg.color,
        href && "hover:opacity-80 transition-opacity cursor-pointer",
        className
      )}
    >
      <span className="leading-none text-[0.9em]">{cfg.icon}</span>
      {!iconOnly && <span className="leading-none">{cfg.label}</span>}
    </span>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0">
        {inner}
      </a>
    );
  }

  return inner;
}

/** Dot-only indicator for compact spaces */
export function PlatformDot({ platform, className }: { platform: PlatformId; className?: string }) {
  const cfg = getConfig(platform);
  return (
    <span
      className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", className)}
      style={{ background: cfg.dot }}
      title={cfg.label}
    />
  );
}
