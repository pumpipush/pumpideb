/**
 * Navbar profile sync — Google user update flow
 *
 * Imports and tests the real production helpers extracted from:
 *   - AuthContext.tsx    → applyMeResponse
 *   - Navbar.tsx         → buildNavbarDisplayInfo
 *   - ProfileEditModal.tsx → performPostSave
 *
 * All three helpers are pure (no React dependencies) so they run in the
 * existing node/vitest environment. A bug in any of them will break
 * these tests — they exercise the real wiring, not local state-machine
 * reimplementations.
 *
 * Invariants under test:
 *  1.  applyMeResponse updates username + avatarUrl + linkedWallet.
 *  2.  applyMeResponse preserves untouched fields (email, authType, address).
 *  3.  applyMeResponse returns current unchanged when data is null.
 *  4.  applyMeResponse preserves avatarUrl as null when server omits it.
 *  5.  buildNavbarDisplayInfo prefers profile-query result over socialUser.
 *  6.  buildNavbarDisplayInfo falls back to socialUser when profile is null.
 *  7.  buildNavbarDisplayInfo falls back to walletFallback when both are null.
 *  8.  After applyMeResponse + fresh profile query, navbar shows new values.
 *  9.  performPostSave invalidates query key for the address.
 *  10. performPostSave invalidates query key for the old username slug.
 *  11. performPostSave skips old-slug invalidation when username equals address.
 *  12. performPostSave calls refreshSocialUser when hasSocialUser is true.
 *  13. performPostSave skips refreshSocialUser when hasSocialUser is false.
 */

import { describe, it, expect, vi } from "vitest";
import {
  applyMeResponse,
  buildNavbarDisplayInfo,
  performPostSave,
  type SocialUserSnapshot,
} from "../../lib/profileDisplayUtils";

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeGoogleUser(overrides: Partial<SocialUserSnapshot> = {}): SocialUserSnapshot {
  return {
    address:      "GOOGLE_ADDR",
    username:     "old_username",
    avatarUrl:    null,
    email:        "user@gmail.com",
    authType:     "google",
    linkedWallet: null,
    ...overrides,
  };
}

// Mirrors getGetProfileQueryKey from @workspace/api-client-react
function profileQueryKey(address: string): readonly string[] {
  return [`/api/profiles/${address}`] as const;
}

// ── applyMeResponse ───────────────────────────────────────────────────────────

describe("applyMeResponse — AuthContext.refreshSocialUser core", () => {

  it("updates username, avatarUrl, and linkedWallet from /auth/me response", () => {
    const user = makeGoogleUser();
    const result = applyMeResponse(user, {
      profile: {
        username:     "new_username",
        avatarUrl:    "https://cdn.example.com/avatar.jpg",
        linkedWallet: "WALLET_ADDR",
      },
    });

    expect(result.username).toBe("new_username");
    expect(result.avatarUrl).toBe("https://cdn.example.com/avatar.jpg");
    expect(result.linkedWallet).toBe("WALLET_ADDR");
  });

  it("preserves email, authType, and address — only allowed fields update", () => {
    const user = makeGoogleUser({ email: "user@gmail.com", authType: "google", address: "GOOGLE_ADDR" });
    const result = applyMeResponse(user, {
      profile: { username: "x", avatarUrl: null },
    });

    expect(result.email).toBe("user@gmail.com");
    expect(result.authType).toBe("google");
    expect(result.address).toBe("GOOGLE_ADDR");
  });

  it("returns current unchanged when data is null (non-ok /auth/me response)", () => {
    const user = makeGoogleUser({ username: "stable", avatarUrl: "https://cdn.example.com/old.jpg" });
    const result = applyMeResponse(user, null);

    expect(result).toBe(user); // same reference — nothing copied
    expect(result.username).toBe("stable");
    expect(result.avatarUrl).toBe("https://cdn.example.com/old.jpg");
  });

  it("sets avatarUrl to null when server response omits it", () => {
    const user = makeGoogleUser({ avatarUrl: "https://cdn.example.com/old.jpg" });
    const result = applyMeResponse(user, {
      profile: { username: "u", /* avatarUrl absent */ },
    });

    expect(result.avatarUrl).toBeNull();
  });
});

// ── buildNavbarDisplayInfo ────────────────────────────────────────────────────

describe("buildNavbarDisplayInfo — Navbar.WalletButton display resolution", () => {

  const socialUser = makeGoogleUser({
    username:  "google_fallback",
    avatarUrl: "https://google.com/photo.jpg",
  });

  it("prefers profile-query username and avatarUrl over socialUser", () => {
    const profile = { username: "custom_username", avatarUrl: "https://cdn.example.com/new.jpg" };
    const { displayName, avatarUrl } = buildNavbarDisplayInfo(profile, socialUser, null);

    expect(displayName).toBe("custom_username");
    expect(avatarUrl).toBe("https://cdn.example.com/new.jpg");
  });

  it("falls back to socialUser when profile query is null", () => {
    const { displayName, avatarUrl } = buildNavbarDisplayInfo(null, socialUser, null);

    expect(displayName).toBe("google_fallback");
    expect(avatarUrl).toBe("https://google.com/photo.jpg");
  });

  it("falls back to walletFallback when both profile and socialUser are null", () => {
    const walletFallback = { displayName: "6xkM…3rPq", avatarUrl: "https://dicebear.com/x.svg" };
    const { displayName, avatarUrl } = buildNavbarDisplayInfo(null, null, walletFallback);

    expect(displayName).toBe("6xkM…3rPq");
    expect(avatarUrl).toBe("https://dicebear.com/x.svg");
  });

  it("after save: navbar shows new values when profile query returns updated data and socialUser refreshed", () => {
    // Step 1: before save — profile query null, socialUser has stale values
    const beforeUser = makeGoogleUser({ username: "before_save", avatarUrl: null });
    const before = buildNavbarDisplayInfo(null, beforeUser, null);
    expect(before.displayName).toBe("before_save");
    expect(before.avatarUrl).toBeNull();

    // Step 2: refreshSocialUser fires → applyMeResponse returns updated user
    const afterUser = applyMeResponse(beforeUser, {
      profile: { username: "after_save", avatarUrl: "https://cdn.example.com/new.jpg" },
    });

    // Step 3: profile query also settled with fresh data
    const updatedProfile = { username: "after_save", avatarUrl: "https://cdn.example.com/new.jpg" };
    const after = buildNavbarDisplayInfo(updatedProfile, afterUser, null);

    expect(after.displayName).toBe("after_save");
    expect(after.avatarUrl).toBe("https://cdn.example.com/new.jpg");
  });

  it("socialUser fallback immediately reflects refreshSocialUser even before profile query re-fetches", () => {
    // Profile query is stale (null) but socialUser was already updated by refreshSocialUser
    const refreshedUser = applyMeResponse(makeGoogleUser({ username: "stale" }), {
      profile: { username: "fresh", avatarUrl: "https://cdn.example.com/fresh.jpg" },
    });
    const { displayName, avatarUrl } = buildNavbarDisplayInfo(null, refreshedUser, null);

    expect(displayName).toBe("fresh");
    expect(avatarUrl).toBe("https://cdn.example.com/fresh.jpg");
  });
});

// ── performPostSave ───────────────────────────────────────────────────────────

describe("performPostSave — ProfileEditModal post-save sequence", () => {

  it("invalidates the query key for the profile address", async () => {
    const invalidated: string[][] = [];
    await performPostSave({
      address:        "GOOGLE_ADDR",
      oldUsername:    undefined,
      hasSocialUser:  false,
      invalidateQuery: async (key) => { invalidated.push([...key]); },
      getQueryKey:    profileQueryKey,
    });

    expect(invalidated).toContainEqual(["/api/profiles/GOOGLE_ADDR"]);
  });

  it("also invalidates the old username slug so stale cached data is evicted", async () => {
    const invalidated: string[][] = [];
    await performPostSave({
      address:        "GOOGLE_ADDR",
      oldUsername:    "old_slug",
      hasSocialUser:  false,
      invalidateQuery: async (key) => { invalidated.push([...key]); },
      getQueryKey:    profileQueryKey,
    });

    expect(invalidated).toContainEqual(["/api/profiles/GOOGLE_ADDR"]);
    expect(invalidated).toContainEqual(["/api/profiles/old_slug"]);
  });

  it("skips old-slug invalidation when username equals address (no rename)", async () => {
    const invalidated: string[][] = [];
    await performPostSave({
      address:        "GOOGLE_ADDR",
      oldUsername:    "GOOGLE_ADDR", // same — no slug rename
      hasSocialUser:  false,
      invalidateQuery: async (key) => { invalidated.push([...key]); },
      getQueryKey:    profileQueryKey,
    });

    // Only the address key; slug key NOT duplicated
    expect(invalidated.filter((k) => k[0] === "/api/profiles/GOOGLE_ADDR")).toHaveLength(1);
  });

  it("calls refreshSocialUser when hasSocialUser is true", async () => {
    const refresh = vi.fn(async () => {});
    await performPostSave({
      address:          "GOOGLE_ADDR",
      oldUsername:      "old_slug",
      hasSocialUser:    true,
      invalidateQuery:  async () => {},
      getQueryKey:      profileQueryKey,
      refreshSocialUser: refresh,
    });

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does NOT call refreshSocialUser when hasSocialUser is false (wallet-only user)", async () => {
    const refresh = vi.fn(async () => {});
    await performPostSave({
      address:          "WALLET_ADDR",
      oldUsername:      undefined,
      hasSocialUser:    false,
      invalidateQuery:  async () => {},
      getQueryKey:      profileQueryKey,
      refreshSocialUser: refresh,
    });

    expect(refresh).not.toHaveBeenCalled();
  });
});
