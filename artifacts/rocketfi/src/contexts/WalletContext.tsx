/**
 * WalletContext — central wallet state for the app.
 *
 * Bridges the window-injected Solana wallet APIs (Phantom, Backpack, Solflare)
 * with React. Consumers get a plain base58 address string and helpers to
 * connect/disconnect without needing to know which wallet is active.
 *
 * Usage:
 *   const { wallet, walletName, connectWallet, disconnect, openWalletModal } = useWallet();
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
import { WALLET_DESCRIPTORS } from "@/lib/solana";
import { WalletSelectModal } from "@/components/shared/WalletSelectModal";

const STORAGE_KEY = "mintix_last_wallet";

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
  /** Open the Connect Wallet modal from anywhere in the app */
  openWalletModal: () => void;
}

const WalletContext = createContext<WalletContextValue>({
  wallet: null,
  walletName: null,
  connected: false,
  connectWallet: async () => { throw new Error("WalletContext not mounted"); },
  disconnect: async () => {},
  openWalletModal: () => {},
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet]         = useState<string | null>(null);
  const [walletName, setWalletName] = useState<WalletName | null>(null);
  const [modalOpen, setModalOpen]   = useState(false);
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
    localStorage.removeItem(STORAGE_KEY);
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

    // Persist wallet choice so we can silently reconnect on next load
    localStorage.setItem(STORAGE_KEY, name);

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
    localStorage.removeItem(STORAGE_KEY);
  }, [handleDisconnect, handleAccountChanged]);

  // ── Auto-reconnect on mount (Task 24) ────────────────────────────────────
  // If the user previously connected a wallet, silently reconnect without
  // showing a popup — using onlyIfTrusted so the wallet approves automatically.

  useEffect(() => {
    const savedName = localStorage.getItem(STORAGE_KEY) as WalletName | null;
    if (!savedName) return;

    const descriptor = WALLET_DESCRIPTORS.find(d => d.name === savedName);
    if (!descriptor) return;

    const provider = descriptor.getProvider();
    if (!provider) return;

    // onlyIfTrusted: won't show a popup; resolves only if already trusted.
    // On failure we do NOT clear localStorage — the wallet may simply be locked.
    // Keeping the stored name means the next page load will silently reconnect
    // once the user unlocks their wallet. We only clear on explicit disconnect().
    provider.connect({ onlyIfTrusted: true })
      .then(result => {
        const address = result.publicKey.toBase58();
        try {
          provider.on("disconnect", handleDisconnect);
          provider.on("accountChanged", handleAccountChanged);
        } catch { /* ignore */ }
        providerRef.current = provider;
        setWallet(address);
        setWalletName(savedName);
      })
      .catch(() => {
        // Silent failure — wallet locked or permission revoked.
        // Do not clear localStorage so we can retry on next reload.
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openWalletModal = useCallback(() => setModalOpen(true), []);

  return (
    <WalletContext.Provider value={{
      wallet,
      walletName,
      connected: wallet !== null,
      connectWallet,
      disconnect,
      openWalletModal,
    }}>
      {children}
      {/* Global wallet modal — accessible from any component via openWalletModal() */}
      <WalletSelectModal open={modalOpen} onOpenChange={setModalOpen} />
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
