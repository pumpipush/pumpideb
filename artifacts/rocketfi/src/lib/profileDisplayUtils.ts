/**
 * Pure helpers extracted from AuthContext, Navbar, and ProfileEditModal.
 *
 * These functions contain zero React dependencies so they can be imported and
 * tested directly in a Node/Vitest environment without jsdom.
 *
 * Production files import them so the same logic is exercised both in the app
 * and in the test suite — a regression in this file will break the tests.
 */

// ── Shared shape mirrors ───────────────────────────────────────────────────────

export interface SocialUserSnapshot {
  address: string;
  username: string;
  avatarUrl: string | null;
  email: string | null;
  authType: "google" | "email";
  linkedWallet: string | null;
}

export interface ProfileSnapshot {
  username?: string | null;
  avatarUrl?: string | null;
}

// ── buildNavbarDisplayInfo ────────────────────────────────────────────────────

/**
 * Resolves the display name and avatar URL shown in the Navbar.
 *
 * Priority order (mirrors WalletButton in Navbar.tsx):
 *   1. Profile-query data  (most up-to-date server value)
 *   2. socialUser fallback (immediately updated by refreshSocialUser)
 *   3. walletFallback      (pre-computed by the caller with formatAddress/diceBearUrl)
 */
export function buildNavbarDisplayInfo(
  profile: ProfileSnapshot | null | undefined,
  socialUser: Pick<SocialUserSnapshot, "username" | "avatarUrl"> | null,
  walletFallback: { displayName: string; avatarUrl: string | null } | null,
): { displayName: string; avatarUrl: string | null } {
  const displayName =
    profile?.username ??
    socialUser?.username ??
    walletFallback?.displayName ??
    "";

  const avatarUrl =
    (profile?.avatarUrl ?? null) ||
    (socialUser?.avatarUrl ?? null) ||
    (walletFallback?.avatarUrl ?? null);

  return { displayName, avatarUrl };
}

// ── applyMeResponse ───────────────────────────────────────────────────────────

/**
 * Pure core of AuthContext.refreshSocialUser.
 *
 * Takes the current socialUser and the parsed /auth/me response body.
 * Returns an updated SocialUserSnapshot with username, avatarUrl, and
 * linkedWallet replaced by the server values.
 *
 * Returns `current` unchanged when `data` is null (non-ok response) so the
 * caller never silently wipes out the existing user.
 */
export function applyMeResponse(
  current: SocialUserSnapshot,
  data: {
    profile: {
      username: string;
      avatarUrl?: string | null;
      linkedWallet?: string | null;
    };
  } | null,
): SocialUserSnapshot {
  if (!data) return current;
  const p = data.profile;
  return {
    ...current,
    username:     p.username,
    avatarUrl:    p.avatarUrl ?? null,
    linkedWallet: p.linkedWallet ?? null,
  };
}

// ── performPostSave ───────────────────────────────────────────────────────────

/**
 * Pure async core of the post-save sequence in ProfileEditModal.saveProfile.
 *
 * 1. Invalidates the profile query for the address.
 * 2. Also invalidates by old username when it differs (handles slug renames).
 * 3. Calls refreshSocialUser only when a social user is active.
 *
 * All side-effecting dependencies (invalidateQuery, getQueryKey,
 * refreshSocialUser) are injected so this function is testable in isolation.
 */
export async function performPostSave(opts: {
  /** The canonical address of the profile that was just saved. */
  address: string;
  /** Previous username slug (if any) — needed to bust the old slug's cache. */
  oldUsername: string | undefined;
  /** Whether a social user (Google/email) is currently signed in. */
  hasSocialUser: boolean;
  /** Injected invalidation function (wraps queryClient.invalidateQueries). */
  invalidateQuery: (key: readonly string[]) => Promise<void>;
  /** Injected key builder (wraps getGetProfileQueryKey). */
  getQueryKey: (address: string) => readonly string[];
  /** Injected refresh function (wraps AuthContext.refreshSocialUser). */
  refreshSocialUser?: () => Promise<void>;
}): Promise<void> {
  const { address, oldUsername, hasSocialUser, invalidateQuery, getQueryKey, refreshSocialUser } =
    opts;

  // Invalidate by address first — always required
  await invalidateQuery(getQueryKey(address));

  // Invalidate by old username slug so stale cached data under the old key is evicted
  if (oldUsername && oldUsername !== address) {
    await invalidateQuery(getQueryKey(oldUsername));
  }

  // Sync AuthContext so navbar fallback values update immediately
  if (hasSocialUser && refreshSocialUser) {
    await refreshSocialUser();
  }
}
