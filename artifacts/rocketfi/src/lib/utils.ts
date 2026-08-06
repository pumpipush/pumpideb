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

export function formatEth(amount: string) {
  try {
    const val = ethers.formatEther(amount);
    // Display 4 decimal places max
    const num = parseFloat(val);
    if (num === 0) return "0.00";
    if (num < 0.0001) return "<0.0001";
    return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch (e) {
    return "0.00";
  }
}

export function parseEth(amount: string) {
  try {
    return ethers.parseEther(amount).toString();
  } catch (e) {
    return "0";
  }
}

export function formatMC(ethStr: string | null | undefined): string {
  if (!ethStr) return "$0";
  const eth = parseFloat(ethStr);
  if (!Number.isFinite(eth) || eth <= 0) return "$0";
  // rough ETH → USD at $3000/ETH
  const usd = eth * 3000;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

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
