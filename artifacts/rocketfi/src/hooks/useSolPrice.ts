/**
 * Fetches SOL/USD price.
 *
 * Primary source: /api/sol-price (our own server, Birdeye-backed, cached 60s).
 * Fallback: CoinGecko public API.
 *
 * Module-level cache so every component calling this hook shares one
 * request — no redundant fetches across the page.
 */

import { useState, useEffect } from "react";

const CACHE_TTL_MS = 60_000; // refresh every 60 s

let cachedPrice: number | null = null;
let cacheTs = 0;
let inflight: Promise<number | null> | null = null;
const listeners = new Set<(p: number) => void>();

async function fetchFromServer(): Promise<number | null> {
  try {
    const res = await fetch("/api/sol-price", { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.price === "number" && json.price > 0 ? json.price : null;
  } catch {
    return null;
  }
}

async function fetchFromCoinGecko(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const price = json?.solana?.usd;
    return typeof price === "number" && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function refresh() {
  if (inflight) return inflight;
  if (Date.now() - cacheTs < CACHE_TTL_MS && cachedPrice !== null) return cachedPrice;
  inflight = (async () => {
    // Try our own API server first (Birdeye-backed, reliable on VPS)
    const p = (await fetchFromServer()) ?? (await fetchFromCoinGecko());
    inflight = null;
    if (p !== null) {
      cachedPrice = p;
      cacheTs = Date.now();
      listeners.forEach(fn => fn(p));
    }
    return p;
  })();
  return inflight;
}

export function useSolPrice(): number | null {
  const [price, setPrice] = useState<number | null>(cachedPrice);

  useEffect(() => {
    let active = true;

    listeners.add(setPrice);
    refresh().then(p => { if (active && p !== null) setPrice(p); });

    const id = setInterval(() => {
      cacheTs = 0; // force refresh
      refresh().then(p => { if (active && p !== null) setPrice(p); });
    }, CACHE_TTL_MS);

    return () => {
      active = false;
      listeners.delete(setPrice);
      clearInterval(id);
    };
  }, []);

  return price;
}
