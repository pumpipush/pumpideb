/**
 * Solana wallet window-API helpers.
 *
 * Phantom, Backpack, and Solflare each inject an object into the browser
 * window when their extension is installed. We talk to them directly through
 * these injected APIs — no @solana/web3.js or wallet-adapter packages needed.
 *
 * All three wallets implement a compatible subset:
 *   - .publicKey?.toBase58()   current address (null if not connected)
 *   - .connect()               triggers the wallet's connection popup
 *   - .disconnect()            disconnects
 *   - .on(event, handler)      subscribe to wallet events
 *   - .isConnected / .connected  whether the wallet is connected
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SolanaPublicKey {
  toBase58(): string;
  toString(): string;
}

export interface SolanaProvider {
  publicKey?: SolanaPublicKey | null;
  /** Phantom/Backpack use .connected; Solflare uses .isConnected */
  connected?: boolean;
  isConnected?: boolean;
  isPhantom?: boolean;
  isBackpack?: boolean;
  isSolflare?: boolean;
  // Phantom/Backpack return { publicKey } from connect(); Solflare may return
  // undefined or void — read provider.publicKey directly after connecting instead.
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: SolanaPublicKey } | undefined | void>;
  disconnect(): Promise<void>;
  on(event: "connect" | "disconnect" | "accountChanged", handler: (arg?: unknown) => void): void;
  off(event: "connect" | "disconnect" | "accountChanged", handler: (arg?: unknown) => void): void;
  /**
   * Sign a transaction and send it to the network via the wallet's RPC.
   * Supported by Phantom, Backpack, and Solflare.
   * `transaction` accepts a @solana/web3.js Transaction or VersionedTransaction.
   * Returns an object with a base58-encoded `signature`.
   */
  signAndSendTransaction?(
    transaction: unknown,
    options?: { skipPreflight?: boolean; preflightCommitment?: string; maxRetries?: number }
  ): Promise<{ signature: string }>;
  /**
   * Sign a transaction WITHOUT sending it.
   * Use this when additional local signers (e.g. a mint Keypair) must also sign
   * before broadcasting — sign with the wallet, then partialSign with local keys,
   * then send via connection.sendRawTransaction(tx.serialize()).
   *
   * Supported by Phantom, Backpack, and Solflare.
   * Returns the signed transaction (same type as input, but with wallet signature added).
   */
  signTransaction?(transaction: unknown): Promise<unknown>;
  /**
   * Sign an arbitrary message (raw UTF-8 bytes) with the wallet's private key.
   * Used for off-chain authentication challenges (Ed25519 sign, not a transaction).
   * Supported by Phantom, Backpack, and Solflare.
   * Returns an object whose `signature` property is the 64-byte Ed25519 signature.
   */
  /** Phantom/Backpack return { signature: Uint8Array }; Solflare returns Uint8Array directly. */
  signMessage?(message: Uint8Array): Promise<Uint8Array | { signature: Uint8Array }>;
}

export type WalletName = "Phantom" | "Backpack" | "Solflare";

export interface WalletDescriptor {
  name: WalletName;
  icon: string;          // SVG data URI
  installUrl: string;
  deepLinkBase?: string; // for mobile
  getProvider(): SolanaProvider | undefined;
}

// ── Window type augmentation ──────────────────────────────────────────────────

declare global {
  interface Window {
    solana?: SolanaProvider;
    phantom?: { solana?: SolanaProvider };
    backpack?: SolanaProvider;
    solflare?: SolanaProvider;
  }
}

// ── Provider accessors ────────────────────────────────────────────────────────

function getPhantomProvider(): SolanaProvider | undefined {
  // Prefer the namespaced window.phantom.solana over window.solana to avoid
  // conflicts with other wallets that also inject into window.solana
  if (typeof window === "undefined") return undefined;
  const p = window.phantom?.solana;
  if (p?.isPhantom) return p;
  if (window.solana?.isPhantom) return window.solana;
  return undefined;
}

function getBackpackProvider(): SolanaProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return window.backpack;
}

function getSolflareProvider(): SolanaProvider | undefined {
  if (typeof window === "undefined") return undefined;
  const sf = window.solflare;
  return sf?.isSolflare ? sf : undefined;
}

// ── Wallet descriptors ────────────────────────────────────────────────────────

// Phantom logo (official SVG simplified)
const PHANTOM_ICON = `data:image/svg+xml;base64,PHN2ZyBmaWxsPSJub25lIiBoZWlnaHQ9IjM0IiB3aWR0aD0iMzQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGxpbmVhckdyYWRpZW50IGlkPSJhIiB4MT0iLjUiIHgyPSIuNSIgeTE9IjAiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiM1MzRiYjEiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM1NTFiZjkiLz48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0iYiIgeDE9Ii41IiB4Mj0iLjUiIHkxPSIwIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjZmZmIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjZmZmIiBzdG9wLW9wYWNpdHk9Ii44MiIvPjwvbGluZWFyR3JhZGllbnQ+PHJlY3QgZmlsbD0idXJsKCNhKSIgaGVpZ2h0PSIzNCIgcng9IjgiIHdpZHRoPSIzNCIvPjxwYXRoIGQ9Ik0yOC40NTEgMTcuMTU0Yy0uNjMzIDMuMjYyLTMuMTQ3IDYuMjM1LTYuNDQzIDcuMjM1LTIuMzQ4LjcxNC01LjE1Ny4yMzgtNi45NTMtMS40NzZsLS44MDYuOTA1Yy0uNTU1LjYyMy0xLjM2OS44NjgtMi4xNDguNjU3TDkuNTIgMjMuOTVjLTEuMzI3LS4zODgtMS44MjMtMS45OTMtMS4wMi0zLjE1NWwxLjA2Mi0xLjU1MWMtLjQ0MS0uNjktLjY0OC0xLjUwMi0uNTg4LTIuMzEzbC4wMzMtLjQ0N2MuMDE5LS4yNTkuMTk1LS40ODIuNDQ1LS41NTVsMS4xMTctLjMzMWMuMjc4LS4wODIuNTcyLjA0LjcwOS4yOTRsLjY2OCAxLjI1NWMuMzQzLS4zNjMuNzE1LS42OTcgMS4xMTItLjk5N2wtLjQ2Mi0xLjUyM2MtLjA4Mi0uMjctLjAxNy0uNTYzLjE3LS43NzVsMS41NS0xLjc0MWMuMTY3LS4xODcuNDA3LS4yODcuNjUzLS4yNjdsMS4yNDEuMTA3Yy4yMDkuMDE4LjQwMy4xMTQuNTQ0LjI3MWwuNTc1LjY0M2MuNDQtLjA3MS44OC0uMTA2IDEuMzItLjEwNmguMDU0Yy40LS4wMDIuODAzLjAyNiAxLjIwMi4wODNsLjU5LS42MzljLjE0LS4xNTIuMzMyLS4yNDcuNTM4LS4yNjNsMS4yMzctLjA5M2MuMjQ2LS4wMTguNDg0LjA4NC42NDkuMjczIDAgMCAxLjYzIDEuODUyIDEuNjMgNC4xNzZsLS4wMDMuMDE3ek0xNy40MiAxOS40OWMwIC43OTMuNjQgMS40MzUgMS40MzMgMS40MzVzMS40MzMtLjY0MiAxLjQzMy0xLjQzNS0uNjQtMS40MzQtMS40MzMtMS40MzQtMS40MzMuNjQyLTEuNDMzIDEuNDM0em0tNC44NjggMGMwIC43OTMuNjQxIDEuNDM1IDEuNDMzIDEuNDM1czEuNDMzLS42NDIgMS40MzMtMS40MzUtLjY0LTEuNDM0LTEuNDMzLTEuNDM0LTEuNDMzLjY0Mi0xLjQzMyAxLjQzNHoiIGZpbGw9InVybCgjYikiLz48L3N2Zz4=`;

// Backpack logo
const BACKPACK_ICON = `data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzQiIGhlaWdodD0iMzQiIHZpZXdCb3g9IjAgMCAzNCAzNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzQiIGhlaWdodD0iMzQiIHJ4PSI4IiBmaWxsPSIjRTMzRDNEIi8+PHBhdGggZD0iTTExIDExaDEyYTIgMiAwIDAgMSAyIDJ2MTBhMiAyIDAgMCAxLTIgMkgxMWEyIDIgMCAwIDEtMi0yVjEzYTIgMiAwIDAgMSAyLTJ6IiBmaWxsPSJ3aGl0ZSIvPjxwYXRoIGQ9Ik0xNCA5aDZhMSAxIDAgMCAxIDEgMXYySDEzVjEwYTEgMSAwIDAgMSAxLTF6IiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==`;

// Solflare logo
const SOLFLARE_ICON = `data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzQiIGhlaWdodD0iMzQiIHZpZXdCb3g9IjAgMCAzNCAzNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzQiIGhlaWdodD0iMzQiIHJ4PSI4IiBmaWxsPSIjRkM2NTIxIi8+PHBhdGggZD0iTTE3IDhMMjYgMjZIOEwxNyA4WiIgZmlsbD0id2hpdGUiLz48L3N2Zz4=`;

export const WALLET_DESCRIPTORS: WalletDescriptor[] = [
  {
    name: "Phantom",
    icon: PHANTOM_ICON,
    installUrl: "https://phantom.app/",
    deepLinkBase: "https://phantom.app/ul/browse/",
    getProvider: getPhantomProvider,
  },
  {
    name: "Backpack",
    icon: BACKPACK_ICON,
    installUrl: "https://www.backpack.app/",
    deepLinkBase: "https://backpack.app/ul/browse/",
    getProvider: getBackpackProvider,
  },
  {
    name: "Solflare",
    icon: SOLFLARE_ICON,
    installUrl: "https://solflare.com/",
    deepLinkBase: "https://solflare.com/ul/v1/browse/",
    getProvider: getSolflareProvider,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if we're on a mobile device (no browser extension available) */
export function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** True if the browser has the given wallet extension installed */
export function isWalletInstalled(descriptor: WalletDescriptor): boolean {
  return descriptor.getProvider() !== undefined;
}

/** Shorten a base58 address for display: "ABC12…xyz98" */
export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
