import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ethers } from "ethers";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatAddress(address: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ── Internal BigInt helpers (used for trade arithmetic) ────────────────────────
// These use ethers 18-decimal parsing purely as a BigInt-safe integer codec.
// Not for display — use formatSol / formatMC for UI.

export function formatEth(amount: string) {
  try {
    const val = ethers.formatEther(amount);
    const num = parseFloat(val);
    if (num === 0) return "0.00";
    if (num < 0.0001) return "<0.0001";
    return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return "0.00";
  }
}

export function parseEth(amount: string) {
  try {
    return ethers.parseEther(amount).toString();
  } catch {
    return "0";
  }
}

// ── SOL display helpers ────────────────────────────────────────────────────────
// Pump.fun stores market cap, trade amounts, and volume in lamports (1 SOL = 1e9 lamports).
// virtualEthReserves is stored as integer SOL directly (not lamports).

function lamportsToSol(lamportStr: string | null | undefined): number {
  if (!lamportStr) return 0;
  const n = parseFloat(lamportStr);
  return Number.isFinite(n) ? n / 1_000_000_000 : 0;
}

/** Format market cap (stored as lamports) → "◎1.23K" / "◎4.56M" */
export function formatMC(lamportStr: string | null | undefined): string {
  const sol = lamportsToSol(lamportStr);
  if (sol <= 0) return "◎0";
  if (sol >= 1_000_000) return `◎${(sol / 1_000_000).toFixed(2)}M`;
  if (sol >= 1_000) return `◎${(sol / 1_000).toFixed(1)}K`;
  return `◎${sol.toFixed(2)}`;
}

/** Format a lamport amount as SOL — for trade ethAmount, volumeEth, etc. */
export function formatSol(lamportStr: string | null | undefined): string {
  const sol = lamportsToSol(lamportStr);
  if (sol === 0) return "0 SOL";
  if (sol < 0.000_1) return `${sol.toExponential(2)} SOL`;
  return `${sol.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
}

/** Format raw token amount (Pump.fun tokenAmount is in whole token units) */
export function formatTokenAmount(amt: string | null | undefined): string {
  const n = Math.round(parseFloat(amt ?? "0"));
  if (!n || !Number.isFinite(n)) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// ── General utilities ──────────────────────────────────────────────────────────

export function timeAgo(dateStr: string | number): string {
  if (!dateStr) return "just now";
  const ts = new Date(dateStr).getTime();
  if (!Number.isFinite(ts)) return "just now";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

export function symbolColor(symbol: string): string {
  if (!symbol) return '#1a2744';
  const colors = ['#1a2744','#1a2433','#1f2a1a','#2a1a1a','#2a2a1a','#1a1a2a'];
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) & 0xffffffff;
  return colors[Math.abs(h) % colors.length];
}
