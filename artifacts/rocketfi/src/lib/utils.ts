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

/** Format a USD value → "$1.23", "$45.6K", "$4.56M" */
export function formatUSD(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(2)}B`;
  if (usd >= 1_000_000)     return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000)         return `$${(usd / 1_000).toFixed(1)}K`;
  if (usd >= 1)             return `$${usd.toFixed(2)}`;
  if (usd >= 0.01)          return `$${usd.toFixed(4)}`;
  return `$${usd.toExponential(3)}`;
}

/**
 * Normalise IPFS URLs to the ipfs.io public gateway.
 * cf-ipfs.com was shut down by Cloudflare — ipfs.io is the canonical fallback.
 */
export function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("ipfs://"))
    return "https://ipfs.io/ipfs/" + url.slice(7);
  if (url.includes("cf-ipfs.com/ipfs/"))
    return url.replace(/https?:\/\/cf-ipfs\.com\/ipfs\//, "https://ipfs.io/ipfs/");
  return url;
}

const SUBSCRIPT_DIGITS = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'] as const;
const toSub = (n: number) => String(n).split('').map(d => SUBSCRIPT_DIGITS[+d]).join('');

/**
 * Format a per-token USD price — like pump.fun / Dexscreener.
 * Tiny values use subscript-zero compression:  0.000002194 → "$0.0₄2194"
 * (subscript digit = count of zeros between "0.0" and the first sig digit)
 */
export function formatTokenPrice(priceUsd: number): string {
  if (!priceUsd || !Number.isFinite(priceUsd) || priceUsd <= 0) return "—";
  if (priceUsd >= 1_000_000) return `$${(priceUsd / 1_000_000).toFixed(2)}M`;
  if (priceUsd >= 1_000)     return `$${(priceUsd / 1_000).toFixed(1)}K`;
  if (priceUsd >= 1)         return `$${priceUsd.toFixed(2)}`;
  if (priceUsd >= 0.1)       return `$${priceUsd.toFixed(3)}`;
  if (priceUsd >= 0.01)      return `$${priceUsd.toFixed(4)}`;
  if (priceUsd >= 0.001)     return `$${priceUsd.toFixed(5)}`;

  // Subscript zero notation for very small prices
  const str = priceUsd.toFixed(20);
  const afterDot = str.slice(2); // digits after "0."
  let zeros = 0;
  while (zeros < afterDot.length && afterDot[zeros] === '0') zeros++;

  // Fewer than 4 leading zeros — plain decimal is still readable
  if (zeros < 4) return `$${priceUsd.toFixed(zeros + 4)}`;

  // e.g. 0.000002194 → zeros=5 → "$0.0₄2194"
  const sigStr = afterDot.slice(zeros, zeros + 4).padEnd(4, '0');
  return `$0.0${toSub(zeros - 1)}${sigStr}`;
}

/** Format market cap stored as lamports → USD given a SOL/USD price.
 *  Returns "—" when lamportStr is absent or zero (data not yet available). */
export function formatMCUsd(lamportStr: string | null | undefined, solPrice: number | null): string {
  if (!lamportStr || lamportStr === "0") return "—";
  if (!solPrice) return formatMC(lamportStr); // fallback to SOL while price loads
  const sol = lamportsToSol(lamportStr);
  if (sol <= 0) return "—";
  return formatUSD(sol * solPrice);
}

/** Format a lamport amount as SOL — for trade ethAmount, volumeEth, etc. */
export function formatSol(lamportStr: string | null | undefined): string {
  const sol = lamportsToSol(lamportStr);
  if (sol === 0) return "0 SOL";
  // Always use plain decimal — no scientific notation.
  let decimals: number;
  if      (sol >= 1)        decimals = 4;
  else if (sol >= 0.01)     decimals = 4;
  else if (sol >= 0.001)    decimals = 5;
  else if (sol >= 0.0001)   decimals = 6;
  else if (sol >= 0.000_01) decimals = 7;
  else                      decimals = 8;
  return `${sol.toFixed(decimals)} SOL`;
}

/**
 * Convert a raw atomic token amount (as stored in the DB / returned by the
 * holdings and holders API endpoints) to whole display tokens.
 *
 * pump.fun / PumpSwap / Raydium LaunchLab tokens all use 6 on-chain decimal
 * places, so 1 whole display token = 1,000,000 atomic units.
 *
 * IMPORTANT: the holdings endpoint (`GET /api/wallet/:address/holdings`) and
 * the holders endpoint (`GET /api/tokens/:address/holders`) both return
 * `balance` in atomic units. Every UI component that displays these values
 * MUST call this function before rendering, or values will appear 1,000,000×
 * too large.
 *
 * @param atomic  Raw atomic unit amount (numeric or numeric string)
 * @param decimals On-chain decimal places (default 6 for pump.fun tokens)
 */
export function atomicToDisplayTokens(
  atomic: number | string,
  decimals = 6,
): number {
  const n = typeof atomic === "string" ? parseFloat(atomic) : atomic;
  if (!Number.isFinite(n)) return 0;
  return n / 10 ** decimals;
}

/**
 * Compute all display values for a single row in the PortfolioTab (My Tokens).
 *
 * This is the **sole calculation path** for PortfolioTab balance rendering.
 * PortfolioTab must call this function and use its return values — never
 * perform the atomic→display math inline. This design makes the regression
 * test below the effective guard: if the atomic→display conversion is removed
 * or altered here, the test fails and the component breaks with it.
 *
 * @param rawBalance  Raw atomic balance string from GET /api/wallet/:w/holdings
 *                    (pump.fun = 6 on-chain decimals, 1 display token = 1,000,000 atomic)
 * @param priceEth    SOL per display token, or null if unknown
 * @param solPrice    SOL/USD price, or null if unknown
 */
export function computeHoldingRow(
  rawBalance: string,
  priceEth:   string | null,
  solPrice:   number | null,
  decimals:   number = 6,
): {
  displayTokens:  number;   // whole tokens (rawBalance ÷ 1e6)
  formattedTokens: string;  // human-readable token amount (e.g. "1.50" or "1.23m")
  valueSol:        number;   // SOL value (priceEth × displayTokens)
  valueUsd:        number | null; // USD value, or null if solPrice unknown
} {
  const displayTokens   = atomicToDisplayTokens(rawBalance, decimals);
  const price           = priceEth ? parseFloat(priceEth) : 0;
  const valueSol        = price * displayTokens;
  const valueUsd        = solPrice ? valueSol * solPrice : null;
  const formattedTokens = formatTokenAmountInternal(String(displayTokens));
  return { displayTokens, formattedTokens, valueSol, valueUsd };
}

/** Internal helper — call formatTokenAmount instead from outside this file. */
function formatTokenAmountInternal(amt: string | null | undefined): string {
  const n = parseFloat(amt ?? "0");
  if (!n || !Number.isFinite(n)) return "0";
  if (n >= 1e18) return `${(n / 1e18).toFixed(2)}q`;
  if (n >= 1e15) return `${(n / 1e15).toFixed(2)}q`;
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Format a token amount that is already in **display (whole-token) units**.
 *
 * Call this when the value has already been divided by 10^decimals.
 * If you have a raw atomic value from the DB or API, call
 * `formatAtomicTokenAmount` instead — it handles the division internally.
 */
export function formatTokenAmount(amt: string | null | undefined): string {
  const n = parseFloat(amt ?? "0");
  if (!n || !Number.isFinite(n)) return "0";
  if (n >= 1e18) return `${(n / 1e18).toFixed(2)}q`;
  if (n >= 1e15) return `${(n / 1e15).toFixed(2)}q`;
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Format a **raw atomic** token amount from the DB or a trade API response.
 *
 * This is the safe call site for `trade.tokenAmount`, `holders[].balance`,
 * and any other value stored in atomic units. It calls `atomicToDisplayTokens`
 * internally so callers cannot accidentally forget the ÷10^decimals step.
 *
 * @param raw      Raw atomic amount (numeric string or number, e.g. "1500000")
 * @param decimals On-chain decimal places (default 6 for pump.fun/PumpSwap/LaunchLab)
 *
 * @example
 *   formatAtomicTokenAmount("1500000")      // → "1.5"   (not "1.50m")
 *   formatAtomicTokenAmount("1000000000", 9) // → "1"     (wSOL convention)
 */
export function formatAtomicTokenAmount(
  raw: string | number | null | undefined,
  decimals = 6,
): string {
  const display = atomicToDisplayTokens(raw ?? 0, decimals);
  return formatTokenAmount(String(display));
}

// ── General utilities ──────────────────────────────────────────────────────────

export function timeAgo(dateStr: string | number): string {
  if (!dateStr) return "0s";
  const ts = new Date(dateStr).getTime();
  if (!Number.isFinite(ts)) return "0s";
  const diff = Date.now() - ts;
  if (diff < 0) return "0s";
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

export function symbolColor(symbol: string): string {
  if (!symbol) return '#1a2744';
  const colors = ['#1a2744','#1a2433','#1f2a1a','#2a1a1a','#2a2a1a','#1a1a2a'];
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) & 0xffffffff;
  return colors[(h >>> 0) % colors.length];
}

/** Generate a DiceBear pixel-art avatar URL. Seed is wallet address or any unique string. */
export function diceBearUrl(seed: string): string {
  return `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(seed)}`;
}
