/**
 * raydiumLauncher.unit.test.ts
 *
 * Unit tests for raydiumLauncher.ts — all SDK calls are mocked so these run
 * in normal CI without any network access or real wallets.
 *
 * PURPOSE
 * -------
 * @raydium-io/raydium-sdk-v2 is an alpha SDK pinned to an exact version in
 * package.json. The adapter in raydiumLauncher.ts handles several API shape
 * variants defensively. These tests verify that the fallback logic is correct
 * so regressions are caught before a user hits a cryptic "Config ID not found"
 * error after an SDK bump.
 *
 * WHAT IS TESTED
 * --------------
 * 1. Config shape fallback: key.pubKey → pubKey → id (all three variants)
 * 2. Transaction result shape: MultiTxBuildData (.transactions[]) vs TxBuildData (.transaction)
 * 3. disableLoadToken is passed to Raydium.load() — prevents 30 MB token-list download
 * 4. Signer shape: Signer[][] (multi-tx) and flat Signer[] (single-tx)
 * 5. Missing blockhash is stamped by caller — SDK returns txs without recentBlockhash
 * 6. SDK_VERIFIED_VERSION constant matches the pinned package.json version
 *
 * HOW TO RUN
 * ----------
 * Normal CI (always runs — no env var needed):
 *   pnpm --filter @workspace/rocketfi test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ── Constants ─────────────────────────────────────────────────────────────────

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const FAKE_PLATFORM_ID = "4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4";
const FAKE_METADATA_URI = "https://ipfs.io/ipfs/QmFakeTestCID";
const FAKE_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

// ── SDK Mock factory helpers ───────────────────────────────────────────────────

/**
 * Build a minimal mock of what Raydium.load() returns, parameterised so each
 * test can inject the exact config/tx shapes it wants to validate.
 */
function makeRaydiumInstance({
  configs,
  txResult,
  captureLoadArgs,
}: {
  configs: unknown[];
  txResult: unknown;
  captureLoadArgs?: (args: unknown) => void;
}) {
  const instance = {
    api: {
      fetchLaunchConfigs: vi.fn().mockResolvedValue(configs),
    },
    launchpad: {
      createLaunchpad: vi.fn().mockResolvedValue(txResult),
    },
  };

  const RaydiumClass = {
    load: vi.fn().mockImplementation((args: unknown) => {
      captureLoadArgs?.(args);
      return Promise.resolve(instance);
    }),
  };

  return { RaydiumClass, instance };
}

/**
 * Build a Transaction pre-stamped so partialSign doesn't need a real blockhash.
 */
function makeTx(feePayer: PublicKey, blockhash?: string): Transaction {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  if (blockhash) tx.recentBlockhash = blockhash;
  return tx;
}

// ── Mock @solana/web3.js Connection ──────────────────────────────────────────

vi.mock("../solanaConnection", () => ({
  getConnection: () => ({
    getLatestBlockhash: vi
      .fn()
      .mockResolvedValue({ blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 9999 }),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
  }),
}));

// ── Helper: run buildRaydiumLaunchTx with a mocked SDK module ────────────────

/**
 * Dynamically imports raydiumLauncher.ts with the SDK module replaced by our
 * mock. Uses vi.doMock so each test can inject a different mock without the
 * module cache keeping a stale version.
 */
async function runBuildWithMock(opts: {
  configs: unknown[];
  txResult: unknown;
  captureLoadArgs?: (args: unknown) => void;
}) {
  // Clear module cache so each call gets a fresh module instance
  vi.resetModules();

  const { RaydiumClass, instance } = makeRaydiumInstance(opts);

  // Mock the SDK before importing the launcher
  vi.doMock("@raydium-io/raydium-sdk-v2", () => ({
    Raydium: RaydiumClass,
    TxVersion: { LEGACY: 0 },
  }));

  const { buildRaydiumLaunchTx } = await import("../raydiumLauncher");
  const ownerKeypair = Keypair.generate();
  const walletPublicKey = ownerKeypair.publicKey.toBase58();

  const result = await buildRaydiumLaunchTx(
    walletPublicKey,
    "TestToken",
    "TEST",
    FAKE_METADATA_URI,
    1_000_000n, // 0.001 SOL initial buy — satisfies SDK > 0 requirement
  );

  return { result, RaydiumClass, instance, ownerKeypair };
}

// ── 1. SDK_VERIFIED_VERSION matches package.json pin ─────────────────────────
//
// WHY readFileSync instead of a dynamic import?
// The original test used:
//   import("../../../../../../artifacts/rocketfi/package.json").catch(() => null)
// That path resolved to /home/runner/artifacts/… (outside the workspace), so
// `pkg` was always null and the version check silently passed — the exact bug
// this test is meant to catch. readFileSync with fileURLToPath(import.meta.url)
// gives a reliable absolute path and throws loudly if the file is missing.

describe("SDK_VERIFIED_VERSION", () => {
  it("matches the pinned @raydium-io/raydium-sdk-v2 version in package.json (unconditional)", async () => {
    // Resolve package.json relative to this test file:
    //   __tests__/ → lib/ → src/ → artifacts/rocketfi/ → package.json
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = resolve(dirname(__filename), "../../../package.json");

    // readFileSync throws if the file is missing — no silent fallback allowed.
    const pkgJson = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };

    const pinned = pkgJson.dependencies?.["@raydium-io/raydium-sdk-v2"];

    // Both of these must hold — neither is conditional on the other.
    expect(
      pinned,
      "package.json must declare @raydium-io/raydium-sdk-v2 in dependencies",
    ).toBeTruthy();

    const { SDK_VERIFIED_VERSION } = await import("../raydiumLauncher");

    expect(
      SDK_VERIFIED_VERSION,
      `SDK_VERIFIED_VERSION ("${SDK_VERIFIED_VERSION}") must equal the pinned ` +
      `version in package.json ("${pinned}"). ` +
      "Update SDK_VERIFIED_VERSION in raydiumLauncher.ts after bumping the SDK " +
      "and running the upgrade checklist.",
    ).toBe(pinned);
  });
});

// ── 2. Raydium.load() receives disableLoadToken: true ─────────────────────────

describe("Raydium.load() init options", () => {
  it("passes disableLoadToken: true so the 30 MB token list is not downloaded", async () => {
    const ownerKeypair = Keypair.generate();
    const tx = makeTx(ownerKeypair.publicKey);

    let capturedArgs: unknown;
    await runBuildWithMock({
      configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
      txResult: { transactions: [tx], signers: [[]] },
      captureLoadArgs: (args) => { capturedArgs = args; },
    });

    expect(capturedArgs).toMatchObject({ disableLoadToken: true });
  });

  it("passes cluster: 'mainnet' to Raydium.load()", async () => {
    const ownerKeypair = Keypair.generate();
    const tx = makeTx(ownerKeypair.publicKey);

    let capturedArgs: unknown;
    await runBuildWithMock({
      configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
      txResult: { transactions: [tx], signers: [[]] },
      captureLoadArgs: (args) => { capturedArgs = args; },
    });

    expect(capturedArgs).toMatchObject({ cluster: "mainnet" });
  });

  it("passes owner as a PublicKey (not a string)", async () => {
    const ownerKeypair = Keypair.generate();
    const tx = makeTx(ownerKeypair.publicKey);

    let capturedArgs: unknown;
    await runBuildWithMock({
      configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
      txResult: { transactions: [tx], signers: [[]] },
      captureLoadArgs: (args) => { capturedArgs = args; },
    });

    // owner must be a PublicKey instance, not a raw string
    expect((capturedArgs as { owner: unknown }).owner).toBeInstanceOf(PublicKey);
  });
});

// ── 3. Config shape variants ───────────────────────────────────────────────────

describe("fetchLaunchConfigs() shape variants", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * Runs buildRaydiumLaunchTx with a mocked config, intercepts the configId
   * passed to createLaunchpad, and returns its base58 string.
   */
  async function extractConfigId(configs: unknown[]): Promise<string> {
    vi.resetModules();
    const ownerKeypair = Keypair.generate();
    const tx = makeTx(ownerKeypair.publicKey);

    let capturedConfigId: unknown;

    vi.doMock("@raydium-io/raydium-sdk-v2", () => ({
      Raydium: {
        load: vi.fn().mockResolvedValue({
          api: { fetchLaunchConfigs: vi.fn().mockResolvedValue(configs) },
          launchpad: {
            createLaunchpad: vi.fn().mockImplementation((args: { configId: PublicKey }) => {
              capturedConfigId = args.configId;
              return Promise.resolve({ transactions: [tx], signers: [[]] });
            }),
          },
        }),
      },
      TxVersion: { LEGACY: 0 },
    }));

    const { buildRaydiumLaunchTx } = await import("../raydiumLauncher");
    await buildRaydiumLaunchTx(
      ownerKeypair.publicKey.toBase58(),
      "TestToken",
      "TEST",
      FAKE_METADATA_URI,
      1_000_000n,
    );

    return (capturedConfigId as PublicKey).toBase58();
  }

  it("resolves configId from entry.key.pubKey (current 0.2.60-alpha shape)", async () => {
    const id = await extractConfigId([
      { key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } },
    ]);
    expect(id).toBe(FAKE_PLATFORM_ID);
  });

  it("resolves configId from entry.pubKey (earlier alpha shape)", async () => {
    const id = await extractConfigId([
      { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT },
    ]);
    expect(id).toBe(FAKE_PLATFORM_ID);
  });

  it("resolves configId from entry.id (pre-alpha shape)", async () => {
    const id = await extractConfigId([
      { id: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT },
    ]);
    expect(id).toBe(FAKE_PLATFORM_ID);
  });

  it("prefers the SOL-denominated config via c.mintB", async () => {
    const solId = new PublicKey(Keypair.generate().publicKey).toBase58();
    const otherId = new PublicKey(Keypair.generate().publicKey).toBase58();

    const id = await extractConfigId([
      { pubKey: otherId, mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, // USDC
      { pubKey: solId, mintB: WRAPPED_SOL_MINT },
    ]);
    expect(id).toBe(solId);
  });

  it("prefers the SOL-denominated config via c.key.mintB", async () => {
    const solId = new PublicKey(Keypair.generate().publicKey).toBase58();
    const otherId = new PublicKey(Keypair.generate().publicKey).toBase58();

    const id = await extractConfigId([
      { key: { pubKey: otherId, mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } },
      { key: { pubKey: solId, mintB: WRAPPED_SOL_MINT } },
    ]);
    expect(id).toBe(solId);
  });

  it("falls back to first config when no SOL-denominated entry is found", async () => {
    const firstId = new PublicKey(Keypair.generate().publicKey).toBase58();
    const secondId = new PublicKey(Keypair.generate().publicKey).toBase58();

    const id = await extractConfigId([
      { pubKey: firstId, mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      { pubKey: secondId, mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    ]);
    expect(id).toBe(firstId);
  });

  it("throws clearly when configs array is empty", async () => {
    vi.resetModules();
    const ownerKeypair = Keypair.generate();

    vi.doMock("@raydium-io/raydium-sdk-v2", () => ({
      Raydium: {
        load: vi.fn().mockResolvedValue({
          api: { fetchLaunchConfigs: vi.fn().mockResolvedValue([]) },
          launchpad: { createLaunchpad: vi.fn() },
        }),
      },
      TxVersion: { LEGACY: 0 },
    }));

    const { buildRaydiumLaunchTx } = await import("../raydiumLauncher");
    await expect(
      buildRaydiumLaunchTx(ownerKeypair.publicKey.toBase58(), "T", "T", FAKE_METADATA_URI, 1_000_000n),
    ).rejects.toThrow(/konfigurasi|LaunchLab|tersedia|config/i);
  });
});

// ── 4. Transaction result shape variants ──────────────────────────────────────

describe("createLaunchpad() transaction result shapes", () => {
  it("handles MultiTxBuildData: { transactions: Transaction[], signers: Signer[][] }", async () => {
    const ownerKeypair = Keypair.generate();
    const tx1 = makeTx(ownerKeypair.publicKey);
    const tx2 = makeTx(ownerKeypair.publicKey);

    const { result } = await runBuildWithMock({
      configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
      txResult: { transactions: [tx1, tx2], signers: [[], []] },
    });

    expect(result.transactions.length).toBe(2);
    expect(result.mintAddress).toBeTruthy();
    expect(result.blockhash).toBeTruthy();
  });

  it("handles TxBuildData: { transaction: Transaction, signers: Signer[] } (single-tx fallback)", async () => {
    const ownerKeypair = Keypair.generate();
    const tx = makeTx(ownerKeypair.publicKey);

    const { result } = await runBuildWithMock({
      configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
      txResult: { transaction: tx, signers: [] },
    });

    expect(result.transactions.length).toBe(1);
    expect(result.mintAddress).toBeTruthy();
  });

  it("throws clearly when SDK returns neither shape", async () => {
    vi.resetModules();
    const ownerKeypair = Keypair.generate();

    vi.doMock("@raydium-io/raydium-sdk-v2", () => ({
      Raydium: {
        load: vi.fn().mockResolvedValue({
          api: {
            fetchLaunchConfigs: vi.fn().mockResolvedValue([
              { key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } },
            ]),
          },
          launchpad: {
            createLaunchpad: vi.fn().mockResolvedValue({ unexpectedField: "oops" }),
          },
        }),
      },
      TxVersion: { LEGACY: 0 },
    }));

    const { buildRaydiumLaunchTx } = await import("../raydiumLauncher");
    await expect(
      buildRaydiumLaunchTx(ownerKeypair.publicKey.toBase58(), "T", "T", FAKE_METADATA_URI, 1_000_000n),
    ).rejects.toThrow(/transaksi|transaction/i);
  });
});

// ── 5. Blockhash stamping behavior ───────────────────────────────────────────

describe("recentBlockhash stamping", () => {
  it("stamps the RPC blockhash onto each transaction that lacks one", async () => {
    const ownerKeypair = Keypair.generate();
    // SDK returns txs WITHOUT recentBlockhash (current behavior)
    const tx = makeTx(ownerKeypair.publicKey /* no blockhash */);

    const { result } = await runBuildWithMock({
      configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
      txResult: { transactions: [tx], signers: [[]] },
    });

    // The caller must have stamped FAKE_BLOCKHASH from the mocked RPC
    expect(result.transactions[0].recentBlockhash).toBe(FAKE_BLOCKHASH);
    expect(result.blockhash).toBe(FAKE_BLOCKHASH);
  });

  it("does NOT overwrite an existing recentBlockhash if the SDK sets one", async () => {
    const ownerKeypair = Keypair.generate();
    // Valid base58 blockhash — distinct from FAKE_BLOCKHASH so we can confirm it is preserved
    const EXISTING_HASH = "9NjGpHpynpjDhCCrBWAKX1tPfWBwBxbEoJopBbk6KLPU";
    // Future SDK version that stamps its own blockhash
    const tx = makeTx(ownerKeypair.publicKey, EXISTING_HASH);

    const { result } = await runBuildWithMock({
      configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
      txResult: { transactions: [tx], signers: [[]] },
    });

    // Existing blockhash must be preserved — overwriting would invalidate SDK sigs
    expect(result.transactions[0].recentBlockhash).toBe(EXISTING_HASH);
  });
});

// ── 6. Signer shape variants ──────────────────────────────────────────────────

describe("per-tx signers shape variants", () => {
  it("handles Signer[][] (multi-tx, current shape)", async () => {
    const ownerKeypair = Keypair.generate();
    const mintKeypair = Keypair.generate();
    const tx = makeTx(ownerKeypair.publicKey);

    // Should not throw — mintKeypair auto-added, SDK signer included
    await expect(
      runBuildWithMock({
        configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
        txResult: { transactions: [tx], signers: [[mintKeypair]] },
      }),
    ).resolves.not.toThrow();
  });

  it("handles flat Signer[] (single-tx fallback shape)", async () => {
    const ownerKeypair = Keypair.generate();
    const tx = makeTx(ownerKeypair.publicKey);

    await expect(
      runBuildWithMock({
        configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
        txResult: { transaction: tx, signers: [] },
      }),
    ).resolves.not.toThrow();
  });

  it("handles empty signers array without throwing", async () => {
    const ownerKeypair = Keypair.generate();
    const tx = makeTx(ownerKeypair.publicKey);

    await expect(
      runBuildWithMock({
        configs: [{ key: { pubKey: FAKE_PLATFORM_ID, mintB: WRAPPED_SOL_MINT } }],
        txResult: { transactions: [tx], signers: [] },
      }),
    ).resolves.not.toThrow();
  });
});

// ── 7. Symbol length guard ────────────────────────────────────────────────────

describe("input validation", () => {
  it("throws when symbol exceeds 10 characters", async () => {
    vi.resetModules();
    vi.doMock("@raydium-io/raydium-sdk-v2", () => ({
      Raydium: { load: vi.fn() },
      TxVersion: { LEGACY: 0 },
    }));

    const { buildRaydiumLaunchTx } = await import("../raydiumLauncher");
    const ownerKeypair = Keypair.generate();

    await expect(
      buildRaydiumLaunchTx(
        ownerKeypair.publicKey.toBase58(),
        "TestToken",
        "TOOLONGTICKER",
        FAKE_METADATA_URI,
        1_000_000n,
      ),
    ).rejects.toThrow(/10/);
  });
});
