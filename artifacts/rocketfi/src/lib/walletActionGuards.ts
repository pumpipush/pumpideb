/**
 * walletActionGuards — pure helpers for wallet-state-dependent UI logic.
 *
 * Extracted from AppInterface.tsx so the derivation rules and button-label
 * decisions can be unit-tested without mounting React components.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Problem being solved
 * ──────────────────────────────────────────────────────────────────────────────
 * Two independent wallet concepts coexist in the app:
 *
 *   adapterWallet — the address reported by WalletContext (the browser wallet
 *                   extension: Phantom, Backpack, Solflare).  This is null
 *                   when the adapter has not yet auto-reconnected after a page
 *                   reload — which can take 100-800 ms on Solflare.
 *
 *   socialUser    — the authenticated session from AuthContext.  If the user
 *                   logged in via wallet or linked one, the wallet address is
 *                   stored here and survives the adapter's reconnect delay.
 *
 * Because adapterWallet starts null for several hundred milliseconds, buttons
 * that depend solely on it flash "Connect Wallet to Launch/Trade" immediately
 * after page load even when the user is fully authenticated.
 *
 * Fix: derive an effectiveWallet that uses the auth session as a fallback while
 * the adapter reconnects.  The adapter address always takes priority because it
 * is needed for signing; the auth address is only used to avoid the flash.
 *
 * A connected guard inside each action handler ensures the adapter is live
 * before attempting to sign, opening the wallet modal if it is not.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** Minimal shape required from SocialUser for wallet derivation. */
export interface SocialUserLike {
  address: string;
  authType: "google" | "email" | "wallet";
  linkedWallet: string | null;
}

/**
 * Derive the effective wallet address for UI display.
 *
 * Priority order:
 *   1. adapterWallet — the live extension address (required for signing).
 *   2. socialUser.address — when authType is "wallet" (the user's primary wallet).
 *   3. socialUser.linkedWallet — when authType is "google" or "email" and the
 *      user has linked a wallet to their social profile.
 *   4. null — not authenticated and no wallet connected.
 *
 * A non-null result means the wallet address is known from the auth session,
 * so action buttons can show their active state (e.g. "Launch Token") instead
 * of "Connect Wallet to Launch".  Clicking the button will still trigger a
 * connected check; if the adapter has not yet reconnected, the wallet modal
 * opens so the user can reconnect for signing.
 */
export function deriveEffectiveWallet(
  adapterWallet: string | null,
  socialUser: SocialUserLike | null,
): string | null {
  if (adapterWallet) return adapterWallet;

  if (socialUser?.authType === "wallet") return socialUser.address;
  return socialUser?.linkedWallet ?? null;
}

// ── Button label helpers ───────────────────────────────────────────────────────
// These map directly to the JSX in AppInterface.tsx so any rename of the text
// must be reflected here (and in tests).

export type LaunchPlatform = "pumpfun" | "raydium";

/**
 * Returns the text label for the primary Launch button.
 *
 * When wallet is null the button prompts the user to connect.
 * When wallet is known (from adapter or auth session) the button shows the
 * platform-specific launch label so authenticated users see an active CTA
 * immediately, without waiting for the adapter to reconnect.
 */
export function getLaunchButtonLabel(
  wallet: string | null,
  platform: LaunchPlatform,
): string {
  if (!wallet) return "Connect Wallet to Launch";
  if (platform === "raydium") return "Launch on Raydium LaunchLab";
  return "Launch on Pump.fun";
}

export type TradeMode = "buy" | "sell";

/**
 * Returns the text label for the primary Trade (buy/sell) button.
 *
 * When wallet is null the button prompts the user to connect.
 * When wallet is known, returns the mode-specific action label.
 */
export function getTradeButtonLabel(
  wallet: string | null,
  tradeMode: TradeMode,
): string {
  if (!wallet) return "Connect Wallet to Trade";
  return tradeMode === "buy" ? "Place Buy" : "Place Sell";
}

// ── Action guard ───────────────────────────────────────────────────────────────

export type WalletActionOutcome =
  | "proceed"            // wallet known + adapter connected → go ahead
  | "open_wallet_modal"; // either not authenticated or adapter disconnected

/**
 * Determine what to do when the user clicks a wallet-gated action button.
 *
 * Returns "open_wallet_modal" when:
 *   • wallet is null — user is not authenticated at all; need to connect.
 *   • wallet is set but connected is false — address known from auth session
 *     but the adapter has not reconnected yet; open the modal to reconnect.
 *
 * Returns "proceed" when:
 *   • wallet is set AND connected is true — adapter is live and ready to sign.
 *
 * The caller is responsible for calling openWalletModal() when the outcome is
 * "open_wallet_modal", and for running the signing flow when it is "proceed".
 */
export function resolveWalletAction(
  wallet: string | null,
  connected: boolean,
): WalletActionOutcome {
  if (!wallet)     return "open_wallet_modal";
  if (!connected)  return "open_wallet_modal";
  return "proceed";
}
