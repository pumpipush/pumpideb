/**
 * walletActionGuards — unit tests
 *
 * These tests guard against regressions to the wallet-state derivation logic
 * introduced to prevent "Connect Wallet to Launch/Trade" from flashing for
 * authenticated users whose wallet adapter hasn't auto-reconnected yet after a
 * page reload (common with Solflare, which injects publicKey asynchronously).
 *
 * All helpers are pure functions with no React dependencies, so they run in
 * the default node/vitest environment without jsdom or component rendering.
 *
 * Invariants under test:
 *
 *  deriveEffectiveWallet
 *   1.  adapterWallet takes priority — returned as-is when present.
 *   2.  wallet-auth user: socialUser.address used when adapter is null.
 *   3.  google/email-auth user: socialUser.linkedWallet used when adapter null.
 *   4.  google/email-auth user with no linked wallet → null.
 *   5.  No session (socialUser null) and no adapter → null.
 *   6.  adapterWallet wins over socialUser even when both are present.
 *
 *  getLaunchButtonLabel
 *   7.  Returns "Connect Wallet to Launch" when wallet is null.
 *   8.  Returns pump.fun label when wallet present + platform pumpfun.
 *   9.  Returns Raydium label when wallet present + platform raydium.
 *   10. Returns pump.fun label (not raydium) when wallet from auth session only.
 *
 *  getTradeButtonLabel
 *   11. Returns "Connect Wallet to Trade" when wallet is null.
 *   12. Returns "Place Buy" when wallet present + tradeMode buy.
 *   13. Returns "Place Sell" when wallet present + tradeMode sell.
 *   14. Trade label uses wallet value regardless of how it was derived.
 *
 *  resolveWalletAction (handleLaunch / handleTrade gate)
 *   15. wallet null + disconnected → "open_wallet_modal".
 *   16. wallet null + connected=true → "open_wallet_modal" (wallet wins).
 *   17. wallet set + connected=false → "open_wallet_modal" (adapter not live).
 *   18. wallet set + connected=true → "proceed".
 *
 *  End-to-end auth-session-fallback scenario
 *   19. Adapter not reconnected yet (adapterWallet=null, socialUser set):
 *       effectiveWallet is the auth address, button shows action label (not
 *       "Connect Wallet"), but resolveWalletAction → "open_wallet_modal"
 *       because connected=false — modal opens when user clicks.
 *   20. Adapter reconnected (adapterWallet set, connected=true):
 *       effectiveWallet is the adapter address, resolveWalletAction → "proceed".
 *   21. Not logged in (socialUser null, adapterWallet null, connected=false):
 *       effectiveWallet is null, button shows "Connect Wallet to Launch/Trade",
 *       resolveWalletAction → "open_wallet_modal".
 */

import { describe, it, expect } from "vitest";
import {
  deriveEffectiveWallet,
  getLaunchButtonLabel,
  getTradeButtonLabel,
  resolveWalletAction,
  type SocialUserLike,
} from "../walletActionGuards";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADAPTER_ADDR  = "PhantomAddr111111111111111111111111111111111";
const AUTH_ADDR     = "WalletAuthAddr22222222222222222222222222222";
const LINKED_ADDR   = "LinkedWallet333333333333333333333333333333";

function walletUser(overrides: Partial<SocialUserLike> = {}): SocialUserLike {
  return { address: AUTH_ADDR, authType: "wallet", linkedWallet: null, ...overrides };
}

function googleUser(linkedWallet: string | null = null): SocialUserLike {
  return { address: "google-uuid", authType: "google", linkedWallet };
}

// ── deriveEffectiveWallet ─────────────────────────────────────────────────────

describe("deriveEffectiveWallet — auth-session fallback for adapter reconnect delay", () => {

  it("1. returns adapterWallet directly when it is set (no auth session needed)", () => {
    expect(deriveEffectiveWallet(ADAPTER_ADDR, null)).toBe(ADAPTER_ADDR);
  });

  it("2. wallet-auth user: returns socialUser.address when adapter is null", () => {
    const result = deriveEffectiveWallet(null, walletUser());
    expect(result).toBe(AUTH_ADDR);
  });

  it("3. google/email-auth user: returns linkedWallet when adapter is null", () => {
    const result = deriveEffectiveWallet(null, googleUser(LINKED_ADDR));
    expect(result).toBe(LINKED_ADDR);
  });

  it("4. google/email-auth user with no linked wallet → null", () => {
    const result = deriveEffectiveWallet(null, googleUser(null));
    expect(result).toBeNull();
  });

  it("5. no session and no adapter → null (not logged in)", () => {
    expect(deriveEffectiveWallet(null, null)).toBeNull();
  });

  it("6. adapterWallet wins over socialUser.address when both are present", () => {
    // The adapter address is always used for signing — it must take priority.
    const result = deriveEffectiveWallet(ADAPTER_ADDR, walletUser());
    expect(result).toBe(ADAPTER_ADDR);
    expect(result).not.toBe(AUTH_ADDR);
  });
});

// ── getLaunchButtonLabel ──────────────────────────────────────────────────────

describe("getLaunchButtonLabel — launch button text based on wallet state", () => {

  it("7. shows 'Connect Wallet to Launch' when wallet is null", () => {
    expect(getLaunchButtonLabel(null, "pumpfun")).toBe("Connect Wallet to Launch");
    expect(getLaunchButtonLabel(null, "raydium")).toBe("Connect Wallet to Launch");
  });

  it("8. shows pump.fun label when wallet is set and platform is pumpfun", () => {
    expect(getLaunchButtonLabel(AUTH_ADDR, "pumpfun")).toBe("Launch on Pump.fun");
  });

  it("9. shows Raydium label when wallet is set and platform is raydium", () => {
    expect(getLaunchButtonLabel(AUTH_ADDR, "raydium")).toBe("Launch on Raydium LaunchLab");
  });

  it("10. auth-session wallet shows action label — not 'Connect Wallet'", () => {
    // When the adapter hasn't reconnected yet, the auth-session address is used.
    // The button must show an active CTA, not the "Connect Wallet" prompt.
    const effectiveWallet = deriveEffectiveWallet(null, walletUser());
    expect(getLaunchButtonLabel(effectiveWallet, "pumpfun")).toBe("Launch on Pump.fun");
  });
});

// ── getTradeButtonLabel ───────────────────────────────────────────────────────

describe("getTradeButtonLabel — trade button text based on wallet + mode", () => {

  it("11. shows 'Connect Wallet to Trade' when wallet is null", () => {
    expect(getTradeButtonLabel(null, "buy")).toBe("Connect Wallet to Trade");
    expect(getTradeButtonLabel(null, "sell")).toBe("Connect Wallet to Trade");
  });

  it("12. shows 'Place Buy' when wallet is set and mode is buy", () => {
    expect(getTradeButtonLabel(AUTH_ADDR, "buy")).toBe("Place Buy");
  });

  it("13. shows 'Place Sell' when wallet is set and mode is sell", () => {
    expect(getTradeButtonLabel(AUTH_ADDR, "sell")).toBe("Place Sell");
  });

  it("14. trade label works the same regardless of how wallet was derived", () => {
    // Auth-session wallet and adapter wallet both resolve to the same button label.
    const fromAdapter = deriveEffectiveWallet(ADAPTER_ADDR, null);
    const fromSession = deriveEffectiveWallet(null, walletUser());
    expect(getTradeButtonLabel(fromAdapter, "buy")).toBe("Place Buy");
    expect(getTradeButtonLabel(fromSession, "buy")).toBe("Place Buy");
  });
});

// ── resolveWalletAction ───────────────────────────────────────────────────────

describe("resolveWalletAction — handleLaunch / handleTrade gate decision", () => {

  it("15. wallet null + disconnected → open_wallet_modal", () => {
    expect(resolveWalletAction(null, false)).toBe("open_wallet_modal");
  });

  it("16. wallet null + connected true → open_wallet_modal (wallet check wins)", () => {
    // connected=true shouldn't matter when there is no wallet address at all.
    expect(resolveWalletAction(null, true)).toBe("open_wallet_modal");
  });

  it("17. wallet set + connected false → open_wallet_modal (adapter not live for signing)", () => {
    // Wallet address is known from auth session but adapter hasn't reconnected.
    // Opening the modal lets the user reconnect so they can sign.
    expect(resolveWalletAction(AUTH_ADDR, false)).toBe("open_wallet_modal");
  });

  it("18. wallet set + connected true → proceed", () => {
    expect(resolveWalletAction(AUTH_ADDR, true)).toBe("proceed");
    expect(resolveWalletAction(ADAPTER_ADDR, true)).toBe("proceed");
  });
});

// ── End-to-end auth-session-fallback scenarios ────────────────────────────────

describe("end-to-end: auth-session fallback prevents 'Connect Wallet' flash on reload", () => {

  it("19. adapter not reconnected yet — button shows action label, click opens modal", () => {
    // User is authenticated (wallet auth type), adapter hasn't reconnected yet.
    const adapterWallet = null;  // not reconnected
    const connected     = false; // adapter disconnected
    const socialUser    = walletUser();

    const effectiveWallet = deriveEffectiveWallet(adapterWallet, socialUser);

    // Button should NOT say "Connect Wallet to Launch" — user is logged in.
    expect(getLaunchButtonLabel(effectiveWallet, "pumpfun")).toBe("Launch on Pump.fun");
    expect(getTradeButtonLabel(effectiveWallet,  "buy")).toBe("Place Buy");

    // But clicking must not proceed to signing — adapter is not live.
    // The action handler opens the modal instead.
    expect(resolveWalletAction(effectiveWallet, connected)).toBe("open_wallet_modal");
  });

  it("19b. same scenario for google user with linked wallet", () => {
    const adapterWallet = null;
    const connected     = false;
    const socialUser    = googleUser(LINKED_ADDR);

    const effectiveWallet = deriveEffectiveWallet(adapterWallet, socialUser);

    expect(getLaunchButtonLabel(effectiveWallet, "pumpfun")).toBe("Launch on Pump.fun");
    expect(getTradeButtonLabel(effectiveWallet,  "sell")).toBe("Place Sell");
    expect(resolveWalletAction(effectiveWallet, connected)).toBe("open_wallet_modal");
  });

  it("20. adapter reconnected — button shows action label, click proceeds to sign", () => {
    // After Solflare finishes async inject or user connects manually.
    const adapterWallet = ADAPTER_ADDR;
    const connected     = true;
    const socialUser    = walletUser();

    const effectiveWallet = deriveEffectiveWallet(adapterWallet, socialUser);

    expect(effectiveWallet).toBe(ADAPTER_ADDR);
    expect(getLaunchButtonLabel(effectiveWallet, "pumpfun")).toBe("Launch on Pump.fun");
    expect(getTradeButtonLabel(effectiveWallet,  "buy")).toBe("Place Buy");
    expect(resolveWalletAction(effectiveWallet, connected)).toBe("proceed");
  });

  it("21. not logged in — button shows 'Connect Wallet', click opens modal", () => {
    const adapterWallet = null;
    const connected     = false;
    const socialUser    = null;

    const effectiveWallet = deriveEffectiveWallet(adapterWallet, socialUser);

    expect(effectiveWallet).toBeNull();
    expect(getLaunchButtonLabel(effectiveWallet, "pumpfun")).toBe("Connect Wallet to Launch");
    expect(getTradeButtonLabel(effectiveWallet,  "buy")).toBe("Connect Wallet to Trade");
    expect(resolveWalletAction(effectiveWallet, connected)).toBe("open_wallet_modal");
  });
});
