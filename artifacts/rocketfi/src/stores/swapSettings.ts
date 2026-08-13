/**
 * Swap settings store — slippage tolerance and priority fee.
 *
 * Module-level singleton with localStorage persistence and a lightweight
 * pub-sub mechanism so any component can subscribe to changes without
 * needing a context provider or external state library.
 */

import { useState, useEffect } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SwapSettings {
  /** Slippage tolerance in basis points. 100 bps = 1%. Default: 100 */
  slippageBps: number;
  /**
   * Priority fee in micro-lamports per compute unit.
   * Normal = 0 (no priority fee)
   * Fast   = 100_000
   * Turbo  = 500_000
   */
  priorityFee: number;
}

export const PRIORITY_PRESETS = {
  normal: { label: "Normal", microLamports: 0 },
  fast:   { label: "Fast",   microLamports: 100_000 },
  turbo:  { label: "Turbo",  microLamports: 500_000 },
} as const;

export const SLIPPAGE_PRESETS = [10, 50, 100] as const; // 0.1%, 0.5%, 1%

// ── Singleton store ───────────────────────────────────────────────────────────

const STORAGE_KEY = "pumpi_swap_settings";

const DEFAULTS: SwapSettings = {
  slippageBps: 100,       // 1%
  priorityFee: 100_000,   // Fast — ensures tx lands quickly on mainnet
};

/** Clamp and validate a single settings value, returning the default on failure. */
function sanitize(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function loadFromStorage(): SwapSettings {
  try {
    if (typeof window === "undefined") return { ...DEFAULTS };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<SwapSettings>;
    return {
      slippageBps: sanitize(parsed.slippageBps, 0, 9_999, DEFAULTS.slippageBps),
      priorityFee: sanitize(parsed.priorityFee,  0, Number.MAX_SAFE_INTEGER, DEFAULTS.priorityFee),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let _current: SwapSettings = loadFromStorage();
const _listeners = new Set<() => void>();

/** Read the current settings snapshot (no re-render). */
export function getSwapSettings(): SwapSettings {
  return _current;
}

/** Update settings with validation, persist to localStorage. */
export function setSwapSettings(patch: Partial<SwapSettings>): void {
  const next: SwapSettings = {
    slippageBps: "slippageBps" in patch
      ? sanitize(patch.slippageBps, 0, 9_999, _current.slippageBps)
      : _current.slippageBps,
    priorityFee: "priorityFee" in patch
      ? sanitize(patch.priorityFee, 0, Number.MAX_SAFE_INTEGER, _current.priorityFee)
      : _current.priorityFee,
  };
  _current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_current));
  } catch {
    // ignore storage errors
  }
  _listeners.forEach((fn) => fn());
}

/**
 * React hook — returns current settings and re-renders whenever they change.
 * Can be called from any component without a provider.
 */
export function useSwapSettings(): SwapSettings {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const listener = () => forceRender((n) => n + 1);
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  }, []);

  return _current;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** "1.00%", "0.50%", etc. */
export function formatSlippage(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/** "Normal", "Fast", "Turbo", or "X μL" for custom. */
export function formatPriorityFee(microLamports: number): string {
  for (const p of Object.values(PRIORITY_PRESETS)) {
    if (p.microLamports === microLamports) return p.label;
  }
  return `${(microLamports / 1_000).toFixed(0)}K μL`;
}
