import { useState, useEffect } from "react";

/** Returns a human-readable "Updated X min ago" string that ticks every 30s. */
export function useCacheAge(computedAt: number | undefined): string | null {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!computedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [computedAt]);

  if (!computedAt) return null;

  const ageMs = Date.now() - computedAt;
  const ageSec = Math.max(0, Math.floor(ageMs / 1000));

  if (ageSec < 60) return "Updated just now";
  const mins = Math.floor(ageSec / 60);
  return `Updated ${mins} min ago`;
}
