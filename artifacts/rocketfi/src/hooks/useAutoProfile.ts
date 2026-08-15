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
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { generateUsername } from "@/lib/username";
import { getGetProfileQueryKey } from "@workspace/api-client-react";
const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
function apiUrl(path: string) { return `${API_BASE}/api${path}`; }

export function useAutoProfile() {
  const { socialUser, authHeaders } = useAuth();
  const queryClient = useQueryClient();
  const hasRun = useRef(false);

  useEffect(() => {
    // Only run once per session and only when authenticated via JWT
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

    // PATCH upserts — creates the profile row if it doesn't exist yet, or
    // updates the username if it has an ugly auto-generated prefix.
    fetch(apiUrl(`/profiles/${encodeURIComponent(address)}`), {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ username: generatedUsername }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((profile) => {
        if (!profile) return;
        // Refresh the cached profile so any component showing the username updates.
        queryClient.invalidateQueries({ queryKey: getGetProfileQueryKey(address) });
      })
      .catch(() => {
        // Silent failure — non-critical, user can always set username manually.
        hasRun.current = false; // allow retry on next render cycle
      });
  }, [socialUser, authHeaders, queryClient]);
}
