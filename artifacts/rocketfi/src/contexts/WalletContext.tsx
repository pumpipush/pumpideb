/**
 * WalletContext — central wallet state for the app.
 *
 * Bridges the window-injected Solana wallet APIs (Phantom, Backpack, Solflare)
 * with React. Consumers get a plain base58 address string and helpers to
 * connect/disconnect without needing to know which wallet is active.
 *
 * Usage:
 *   const { wallet, walletName, connectWallet, disconnect } = useWallet();
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useCreateProfile } from "@workspace/api-client-react";
import type { SolanaProvider, WalletName } from "@/lib/solana";

interface WalletContextValue {
  /** Base58-encoded Solana public key, or null if not connected */
  wallet: string | null;
  /** Human-readable wallet name ("Phantom", "Backpack", "Solflare"), or null */
  walletName: WalletName | null;
  /** True while a wallet is connected */
  connected: boolean;
  /**
   * Connect using a specific provider (returned by WALLET_DESCRIPTORS[n].getProvider()).
   * Resolves with the base58 address on success.
   */
  connectWallet: (provider: SolanaProvider, name: WalletName) => Promise<string>;
  /** Disconnect from the current wallet */
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue>({
  wallet: null,
  walletName: null,
  connected: false,
  connectWallet: async () => { throw new Error("WalletContext not mounted"); },
  disconnect: async () => {},
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet]         = useState<string | null>(null);
  const [walletName, setWalletName] = useState<WalletName | null>(null);
  const providerRef = useRef<SolanaProvider | null>(null);
  const createProfile = useCreateProfile();

  // ── Auto-create profile when wallet connects ──────────────────────────────

  useEffect(() => {
    if (!wallet) return;
    createProfile.mutate(
      { data: { address: wallet } },
      { onError: (err) => console.warn("[WalletContext] profile upsert failed (non-fatal):", err) }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  // ── Listen for wallet events (disconnect, account change) ─────────────────

  const handleDisconnect = useCallback(() => {
    setWallet(null);
    setWalletName(null);
    providerRef.current = null;
  }, []);

  const handleAccountChanged = useCallback((publicKey: unknown) => {
    if (publicKey && typeof publicKey === "object" && "toBase58" in publicKey) {
      const addr = (publicKey as { toBase58(): string }).toBase58();
      setWallet(addr);
    } else {
      // Wallet locked or account removed
      handleDisconnect();
    }
  }, [handleDisconnect]);

  // ── Connect ───────────────────────────────────────────────────────────────

  const connectWallet = useCallback(async (
    provider: SolanaProvider,
    name: WalletName
  ): Promise<string> => {
    const result = await provider.connect();
    const address = result.publicKey.toBase58();

    // Clean up old provider listeners before switching
    if (providerRef.current && providerRef.current !== provider) {
      try {
        providerRef.current.off("disconnect", handleDisconnect);
        providerRef.current.off("accountChanged", handleAccountChanged);
      } catch { /* ignore */ }
    }

    // Attach listeners on the new provider
    try {
      provider.on("disconnect", handleDisconnect);
      provider.on("accountChanged", handleAccountChanged);
    } catch { /* some wallets may not support all events */ }

    providerRef.current = provider;
    setWallet(address);
    setWalletName(name);
    return address;
  }, [handleDisconnect, handleAccountChanged]);

  // ── Disconnect ────────────────────────────────────────────────────────────

  const disconnect = useCallback(async () => {
    if (providerRef.current) {
      try {
        providerRef.current.off("disconnect", handleDisconnect);
        providerRef.current.off("accountChanged", handleAccountChanged);
        await providerRef.current.disconnect();
      } catch { /* ignore errors on disconnect */ }
    }
    setWallet(null);
    setWalletName(null);
    providerRef.current = null;
  }, [handleDisconnect, handleAccountChanged]);

  return (
    <WalletContext.Provider value={{
      wallet,
      walletName,
      connected: wallet !== null,
      connectWallet,
      disconnect,
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
