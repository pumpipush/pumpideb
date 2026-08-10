/**
 * raydiumLaunchLab.smoke.test.ts
 *
 * Mainnet smoke test for Raydium LaunchLab launch flow.
 *
 * WHY THIS EXISTS
 * ---------------
 * @raydium-io/raydium-sdk-v2 is an alpha package (0.2.60-alpha). The launcher
 * in raydiumLauncher.ts relies on several undocumented SDK behaviors:
 *   • Raydium.load() init options (cluster, owner)
 *   • fetchLaunchConfigs() response shape (configEntry.key.pubKey vs .pubKey vs .id)
 *   • createLaunchpad() result shape (MultiTxBuildData: .transactions[] vs .transaction)
 *   • Per-tx signers shape (Signer[][])
 *   • SDK-set recentBlockhash on each returned transaction
 *
 * Any of these can silently break on an alpha SDK bump. This test catches them
 * before real users hit a cryptic error.
 *
 * MAINNET, NOT DEVNET
 * -------------------
 * We use a mainnet RPC and mainnet SDK cluster because:
 *   • The Raydium LaunchLab program (LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj)
 *     and the default platform account (4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4)
 *     only exist on mainnet. The SDK fetches these accounts during createLaunchpad()
 *     to populate instruction data.
 *   • fetchLaunchConfigs() hits the Raydium API, which returns mainnet config entries.
 *   • NO TRANSACTIONS ARE SUBMITTED — we only call createLaunchpad() to verify
 *     the transaction builds without error, then inspect the resulting object.
 *     No SOL is spent and no state changes on-chain.
 *
 * HOW TO RUN
 * ----------
 * Full smoke run (hits real mainnet RPC + Raydium API — read-only):
 *   RUN_SMOKE_TESTS=1 pnpm --filter @workspace/rocketfi test
 *
 * Normal CI (skips this file, runs unit tests only):
 *   pnpm --filter @workspace/rocketfi test
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";

// ── Guard ─────────────────────────────────────────────────────────────────────
// Skip the entire suite unless RUN_SMOKE_TESTS=1 is set so normal CI is fast.
const RUN = process.env.RUN_SMOKE_TESTS === "1";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Mainnet RPC — mirrors the primary endpoint in solanaConnection.ts */
const MAINNET_RPC = "https://solana-rpc.publicnode.com";

/** Raydium LaunchLab on-chain program — mainnet only */
const LAUNCHPAD_PROGRAM_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

/** Default Raydium LaunchLab platform PDA — used in raydiumLauncher.ts */
const RAYDIUM_DEFAULT_PLATFORM_ID = "4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4";

/** SOL wrapped mint — used to select the SOL-denominated launchpad config */
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Fake IPFS URI — the SDK only needs a valid string; tx is never submitted */
const FAKE_METADATA_URI = "https://ipfs.io/ipfs/QmSmokeTestFakeCID123";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve configId from a config entry — mirrors raydiumLauncher.ts line 186 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveConfigId(entry: any): PublicKey {
  const pubKey: string = entry.key?.pubKey ?? entry.pubKey ?? entry.id;
  if (!pubKey) throw new Error("Config entry has no resolvable pubKey");
  return new PublicKey(pubKey);
}

/** Select the preferred config entry — mirrors raydiumLauncher.ts selector */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectConfigEntry(configs: any[]): any {
  return (
    configs.find(
      (c) => c.mintB === WRAPPED_SOL_MINT || c.key?.mintB === WRAPPED_SOL_MINT,
    ) ?? configs[0]
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe(
  "Raydium LaunchLab mainnet smoke test (read-only — no transactions submitted)",
  { timeout: 120_000 },
  () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raydium: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sdk: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let configs: any[];
    // Throwaway wallet — never funded, never used to sign
    let throwawayOwner: Keypair;

    beforeAll(async () => {
      if (!RUN) return;

      throwawayOwner = Keypair.generate();

      const conn = new Connection(MAINNET_RPC, "confirmed");

      // Dynamic import mirrors the lazy-load in raydiumLauncher.ts
      sdk = await import("@raydium-io/raydium-sdk-v2");
      const { Raydium } = sdk;

      // Exact call from raydiumLauncher.ts
      raydium = await Raydium.load({
        connection: conn,
        owner:      throwawayOwner.publicKey.toBase58(),
        cluster:    "mainnet" as const,
      });
    });

    // ── 1. SDK loads and exposes required API surface ─────────────────────────
    it("SDK initialises and exposes expected API surface", () => {
      if (!RUN) return;

      expect(raydium).toBeTruthy();
      expect(typeof raydium.api?.fetchLaunchConfigs).toBe(
        "function",
      );
      expect(typeof raydium.launchpad?.createLaunchpad).toBe(
        "function",
      );
    });

    it("TxVersion.LEGACY is defined", () => {
      if (!RUN) return;
      const { TxVersion } = sdk;
      expect(TxVersion).toBeDefined();
      expect(TxVersion.LEGACY).toBeDefined();
    });

    // ── 2. fetchLaunchConfigs response shape ──────────────────────────────────
    it("fetchLaunchConfigs() returns a non-empty array", async () => {
      if (!RUN) return;

      configs = await raydium.api.fetchLaunchConfigs();

      expect(Array.isArray(configs)).toBe(true);
      expect(configs.length).toBeGreaterThan(0);
    });

    it("each config entry has a resolvable pubKey at key.pubKey, .pubKey, or .id", () => {
      if (!RUN) return;

      // This mirrors the fallback chain in raydiumLauncher.ts line 186:
      //   entry.key?.pubKey ?? entry.pubKey ?? entry.id
      for (const entry of configs) {
        const pubKey = entry.key?.pubKey ?? entry.pubKey ?? entry.id;
        expect(pubKey, `config entry ${JSON.stringify(entry)} missing pubKey`).toBeTruthy();
        expect(() => new PublicKey(pubKey)).not.toThrow();
      }
    });

    it("at least one config entry references SOL as the quote mint", () => {
      if (!RUN) return;

      const solConfig = configs.find(
        (c) => c.mintB === WRAPPED_SOL_MINT || c.key?.mintB === WRAPPED_SOL_MINT,
      );
      expect(
        solConfig,
        `No SOL-denominated config found. Configs: ${JSON.stringify(configs.map(c => ({ mintB: c.mintB, keyMintB: c.key?.mintB })))}`,
      ).toBeTruthy();
    });

    it("preferred configEntry resolves to a valid PublicKey", () => {
      if (!RUN) return;

      const entry = selectConfigEntry(configs);
      expect(() => resolveConfigId(entry)).not.toThrow();
    });

    // ── 3. createLaunchpad() transaction build ────────────────────────────────
    // This is the main SDK behavior test — we call the exact same code path
    // as raydiumLauncher.ts and verify the returned object shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sdkResult: any;

    it("createLaunchpad() builds at least one transaction without throwing", async () => {
      if (!RUN) return;

      const { TxVersion } = sdk;
      const mintKeypair = Keypair.generate();
      const configId = resolveConfigId(selectConfigEntry(configs));

      sdkResult = await raydium.launchpad.createLaunchpad({
        mintA:        mintKeypair.publicKey,
        name:         "SmokeTest",
        symbol:       "SMOKE",
        uri:          FAKE_METADATA_URI,
        configId,
        platformId:   new PublicKey(RAYDIUM_DEFAULT_PLATFORM_ID),
        buyAmount:    new BN(0),
        migrateType:  "cpmm",
        txVersion:    TxVersion.LEGACY,
        createOnly:   true,
        feePayer:     throwawayOwner.publicKey,
        computeBudgetConfig: {
          units:         400_000,
          microLamports: 50_000,
        },
      });

      expect(sdkResult).toBeTruthy();
    });

    it("createLaunchpad() result has MultiTxBuildData (.transactions[]) or TxBuildData (.transaction) shape", () => {
      if (!RUN) return;

      const hasTxArray  = Array.isArray(sdkResult.transactions) && sdkResult.transactions.length > 0;
      const hasSingleTx = !hasTxArray && !!sdkResult.transaction;

      expect(
        hasTxArray || hasSingleTx,
        `sdkResult has neither .transactions[] nor .transaction. Keys: ${Object.keys(sdkResult)}`,
      ).toBe(true);
    });

    it("SDK does NOT set recentBlockhash on LEGACY transactions — caller must set it", () => {
      if (!RUN) return;

      // IMPORTANT SDK BEHAVIOR (verified against 0.2.60-alpha):
      // createLaunchpad() with TxVersion.LEGACY returns transactions WITHOUT
      // recentBlockhash set. The caller (raydiumLauncher.ts) must fetch it from
      // the RPC and set it before calling partialSign() — otherwise partialSign
      // throws "Transaction recentBlockhash required".
      //
      // If a future SDK version starts setting recentBlockhash, this assertion will
      // fire as a warning to re-evaluate raydiumLauncher.ts logic.
      const txs: Transaction[] = Array.isArray(sdkResult.transactions)
        ? sdkResult.transactions
        : [sdkResult.transaction];

      expect(txs.length).toBeGreaterThan(0);

      for (const tx of txs) {
        expect(tx).toBeInstanceOf(Transaction);
        // Caller must set recentBlockhash (SDK leaves it undefined in this version)
        expect(tx.recentBlockhash).toBeUndefined();
      }
    });

    it("transactions are serialisable after caller sets recentBlockhash from RPC", async () => {
      if (!RUN) return;

      const conn = new Connection(MAINNET_RPC, "confirmed");
      const { blockhash } = await conn.getLatestBlockhash("confirmed");

      const txs: Transaction[] = Array.isArray(sdkResult.transactions)
        ? sdkResult.transactions
        : [sdkResult.transaction];

      for (const tx of txs) {
        // Caller sets recentBlockhash + feePayer before partial-signing (mirrors raydiumLauncher.ts)
        tx.recentBlockhash = blockhash;
        if (!tx.feePayer) tx.feePayer = throwawayOwner.publicKey;
        // Basic well-formedness check
        expect(() => tx.serializeMessage()).not.toThrow();
      }
    });

    // ── 4. Per-tx signers shape ────────────────────────────────────────────────
    it("signers field is an array and each element is a Signer or Signer[]", () => {
      if (!RUN) return;

      const { signers } = sdkResult;
      if (signers === undefined || signers === null) return; // optional field

      expect(Array.isArray(signers)).toBe(true);

      for (const signerOrArr of signers) {
        if (Array.isArray(signerOrArr)) {
          // Signer[][] — one array of signers per tx
          for (const s of signerOrArr) {
            expect(s).toHaveProperty("publicKey");
            expect(s).toHaveProperty("secretKey");
          }
        } else if (signerOrArr != null) {
          // Signer[] (flat)
          expect(signerOrArr).toHaveProperty("publicKey");
        }
      }
    });

    // ── 5. partialSign with mintKeypair succeeds after blockhash is set ────────
    it("partialSign with mintKeypair succeeds once caller sets recentBlockhash", async () => {
      if (!RUN) return;

      const { TxVersion } = sdk;
      const mintKeypair = Keypair.generate();
      const configId    = resolveConfigId(selectConfigEntry(configs));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await raydium.launchpad.createLaunchpad({
        mintA:        mintKeypair.publicKey,
        name:         "SmokeSign",
        symbol:       "SGSN",
        uri:          FAKE_METADATA_URI,
        configId,
        platformId:   new PublicKey(RAYDIUM_DEFAULT_PLATFORM_ID),
        buyAmount:    new BN(0),
        migrateType:  "cpmm",
        txVersion:    TxVersion.LEGACY,
        createOnly:   true,
        feePayer:     throwawayOwner.publicKey,
        computeBudgetConfig: { units: 400_000, microLamports: 50_000 },
      });

      const conn = new Connection(MAINNET_RPC, "confirmed");
      const { blockhash } = await conn.getLatestBlockhash("confirmed");

      const txs: Transaction[] = Array.isArray(result.transactions)
        ? result.transactions
        : [result.transaction];

      for (const tx of txs) {
        // Caller must set both blockhash and feePayer before signing (SDK leaves these unset)
        if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;
        if (!tx.feePayer) tx.feePayer = throwawayOwner.publicKey;

        try {
          tx.partialSign(mintKeypair);
          // partialSign succeeded — mintKeypair signed this transaction
        } catch (err) {
          // The only acceptable reason to throw is "already signed"
          const msg = ((err as Error).message ?? "").toLowerCase();
          const isAlreadySigned =
            msg.includes("already") ||
            msg.includes("duplicate") ||
            msg.includes("signature");
          expect(
            isAlreadySigned,
            `partialSign threw unexpected error: ${(err as Error).message}`,
          ).toBe(true);
        }
      }
    });

    // ── Skip notice for normal CI ─────────────────────────────────────────────
    it("(tests above are skipped in normal CI — set RUN_SMOKE_TESTS=1 to run)", () => {
      if (RUN) return;
      // Passes immediately so the file is not flagged as empty in normal CI
      expect(true).toBe(true);
    });
  },
);
