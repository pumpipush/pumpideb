/**
 * useAutoProfile — silently creates or upgrades a profile for authenticated users.
 *
 * Runs once per session when the user is authenticated (JWT available via
 * authHeaders). Covers two cases:
 *
 *   1. No profile exists yet (404) — creates one with a generated username.
 *   2. Profile has an ugly auto-generated username (`wallet_` or `user_` prefix)
 *      from an older sign-up — upgrades it to the nicer adjective+noun format.
 *
 * Extension wallet users who sign in through the AuthModal already get a profile
 * created server-side via the wallet login flow.  This hook is the safety net for
 * social/email users and any gap cases.
 *
 * Retry behaviour: non-OK HTTP responses and network errors are retried up to
 * MAX_RETRIES times (3) with exponential backoff (1 s → 2 s → 4 s), giving
 * MAX_ATTEMPTS = 4 total PATCH calls.  The pending retry timer is cancelled and
 * in-flight fetches are aborted if the component unmounts mid-flight so no state
 * mutations fire after teardown.  After exhausting all retries, a console warning
 * is emitted so the failure is visible during debugging.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { generateUsername } from "@/lib/username";
import { getGetProfileQueryKey } from "@workspace/api-client-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
function apiUrl(path: string) { return `${API_BASE}/api${path}`; }

/** Number of retries after the initial attempt (total attempts = MAX_RETRIES + 1). */
const MAX_RETRIES = 3;
/** Base delay for exponential backoff: retry 1 → 1 s, retry 2 → 2 s, retry 3 → 4 s. */
const RETRY_BASE_MS = 1_000;

export function useAutoProfile() {
  const { socialUser, authHeaders } = useAuth();
  const queryClient = useQueryClient();
  const hasRun = useRef(false);

  useEffect(() => {
    // Only run once per session and only when authenticated via JWT.
    if (hasRun.current) return;
    if (!socialUser) return;
    const headers = authHeaders();
    if (!headers.Authorization) return;

    hasRun.current = true;

    const address = socialUser.address;
    const currentUsername = socialUser.username ?? "";

    // Check if the username needs to be upgraded:
    //   - empty / not set
    //   - old ugly auto-generated format: "wallet_*" or "user_*"
    const needsUpgrade =
      !currentUsername ||
      currentUsername.startsWith("wallet_") ||
      currentUsername.startsWith("user_");

    if (!needsUpgrade) return; // already has a good username

    const generatedUsername = generateUsername(address);

    // Effect-local state — set to true on unmount so in-flight .catch() callbacks
    // neither schedule new timers nor update the query cache after teardown.
    let cancelled = false;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Perform one PATCH attempt.
     * @param retriesLeft  How many retries remain after this attempt.
     */
    const doFetch = (retriesLeft: number) => {
      fetch(apiUrl(`/profiles/${encodeURIComponent(address)}`), {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ username: generatedUsername }),
        signal: controller.signal,
      })
        .then((r) => {
          // Treat non-OK HTTP status as a retryable failure so we don't silently
          // mark the session as done when the server returned an error.
          if (!r.ok) throw new Error(`Profile PATCH returned HTTP ${r.status}`);
          return r.json();
        })
        .then(() => {
          if (cancelled) return;
          // Refresh the cached profile so any component showing the username updates.
          queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey(address) });
        })
        .catch((err: unknown) => {
          // Ignore abort errors — they are intentional on unmount.
          if (cancelled) return;
          if (retriesLeft > 0) {
            // Exponential backoff: retry 1 → 1 s, retry 2 → 2 s, retry 3 → 4 s.
            const retryIndex = MAX_RETRIES - retriesLeft; // 0-based
            const delay = RETRY_BASE_MS * (2 ** retryIndex);
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (!cancelled) doFetch(retriesLeft - 1);
            }, delay);
          } else {
            // All retries exhausted — log so it's visible during debugging.
            // hasRun stays true; user can always set username manually.
            console.warn(
              `[useAutoProfile] PATCH failed after ${MAX_RETRIES + 1} attempts — profile may not be created`,
              err,
            );
          }
        });
    };

    doFetch(MAX_RETRIES);

    // Cancel any pending retry timer and abort the in-flight fetch if the
    // component unmounts before the operation completes.
    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      controller.abort();
    };
  }, [socialUser, authHeaders, queryClient]);
}
