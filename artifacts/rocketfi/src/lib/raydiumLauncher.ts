/**
 * raydiumLauncher.ts — Raydium LaunchLab on-chain token creation
 *
 * Flow:
 *   1. uploadToRaydiumIpfs()    → upload image + metadata → metadataUri
 *   2. buildRaydiumLaunchTx()   → dynamic-import SDK, init Raydium, call createLaunchpad()
 *                                  SDK returns MultiTxBuildData:
 *                                    { transactions: Transaction[], signers: Signer[][] }
 *                                  For each tx: partial-sign with per-tx signers (excludes wallet)
 *                                  Do NOT overwrite SDK-set blockhash (would invalidate sigs)
 *   3. simulateRaydiumLaunch()  → connection.simulateTransaction on first tx, sigVerify: false
 *   4. (caller) for each tx: wallet signs + sends → wait confirmation before next
 *
 * Cost: ~0.02–0.04 SOL platform fee + rent for mint + metadata accounts
 *
 * @raydium-io/raydium-sdk-v2 is dynamically imported so the ~10 MB chunk
 * only downloads when the user first clicks "Launch on Raydium LaunchLab".
 */

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { uploadToPumpFunIpfs } from "./pumpfunLauncher";
import { getConnection } from "./solanaConnection";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Raydium LaunchLab on-chain program (mainnet) */
export const RAYDIUM_LAUNCHPAD_PROGRAM_ID =
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

/** Default Raydium LaunchLab platform PDA  */
const RAYDIUM_DEFAULT_PLATFORM_ID =
  "4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4";

/** Priority fee in microlamports — higher than pump.fun to stay competitive */
const RAYDIUM_PRIORITY_MICRO_LAMPORTS = 50_000;

/** Approximate SOL cost to create a Raydium LaunchLab token */
export const RAYDIUM_LAUNCH_COST_SOL = 0.04;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RaydiumUploadParams {
  name:        string;
  symbol:      string;
  description: string;
  twitter?:    string;
  telegram?:   string;
  website?:    string;
  image:       File;
}

/**
 * One or more transactions to send in order, each already partial-signed
 * by the mint keypair and any other SDK-required keypairs.
 * The caller's wallet must add its signature + broadcast each in sequence.
 *
 * blockhash / lastValidBlockHeight are read from the SDK-built state;
 * do NOT overwrite them — the SDK has already signed with those values.
 */
export interface RaydiumLaunchTxResult {
  transactions:        Transaction[];
  mintAddress:         string;
  blockhash:           string;          // from first tx, for confirmation tracking
  lastValidBlockHeight: number;         // approximate, from RPC call after build
}

// ── Metadata Upload ───────────────────────────────────────────────────────────

/**
 * Upload image + metadata for a Raydium LaunchLab token.
 *
 * Tries Raydium's own IPFS service first; falls back to pump.fun IPFS on
 * failure (both produce standard IPFS URIs that Raydium accepts).
 */
export async function uploadToRaydiumIpfs(
  params: RaydiumUploadParams,
): Promise<string> {
  try {
    return await _tryRaydiumUpload(params);
  } catch {
    return uploadToPumpFunIpfs({
      name:        params.name,
      symbol:      params.symbol,
      description: params.description,
      twitter:     params.twitter,
      telegram:    params.telegram,
      website:     params.website,
      image:       params.image,
    });
  }
}

async function _tryRaydiumUpload(params: RaydiumUploadParams): Promise<string> {
  // 1. Upload image
  const imgForm = new FormData();
  imgForm.append("file", params.image, params.image.name);

  const imgRes = await fetch("https://launch-mint-v1.raydium.io/upload", {
    method: "POST",
    body:   imgForm,
    signal: AbortSignal.timeout(15_000),
  });
  if (!imgRes.ok) throw new Error(`Raydium image upload: ${imgRes.status}`);
  const imgJson = await imgRes.json() as { uri?: string; url?: string };
  const imageUri = imgJson.uri ?? imgJson.url;
  if (!imageUri) throw new Error("Raydium image upload: missing uri in response");

  // 2. Upload metadata JSON
  const metadata: Record<string, string> = {
    name:        params.name,
    symbol:      params.symbol,
    description: params.description,
    image:       imageUri,
  };
  if (params.twitter)  metadata.twitter      = params.twitter;
  if (params.telegram) metadata.telegram     = params.telegram;
  if (params.website)  { metadata.website = params.website; metadata.external_url = params.website; }

  const metaBlob = new Blob([JSON.stringify(metadata)], { type: "application/json" });
  const metaForm = new FormData();
  metaForm.append("file", metaBlob, "metadata.json");

  const metaRes = await fetch("https://launch-mint-v1.raydium.io/upload", {
    method: "POST",
    body:   metaForm,
    signal: AbortSignal.timeout(15_000),
  });
  if (!metaRes.ok) throw new Error(`Raydium metadata upload: ${metaRes.status}`);
  const metaJson = await metaRes.json() as { uri?: string; url?: string };
  const uri = metaJson.uri ?? metaJson.url;
  if (!uri) throw new Error("Raydium metadata upload: missing uri in response");

  return uri;
}

// ── Transaction Builder ───────────────────────────────────────────────────────

/**
 * Build the Raydium LaunchLab create-token transaction(s).
 *
 * The SDK (@raydium-io/raydium-sdk-v2) returns MultiTxBuildData:
 *   { transactions: Transaction[], signers: Signer[][] }
 * where signers[i] are the non-wallet keypairs required for transactions[i].
 *
 * This function:
 *  1. Partial-signs each transaction with its per-tx SDK signers + mintKeypair
 *  2. Does NOT overwrite the SDK-set recentBlockhash (that would invalidate signatures)
 *  3. Returns all transactions for the caller to sign sequentially with user wallet
 */
export async function buildRaydiumLaunchTx(
  walletPublicKey: string,
  name:            string,
  symbol:          string,
  metadataUri:     string,
): Promise<RaydiumLaunchTxResult> {
  if (symbol.length > 10) throw new Error("Ticker maksimal 10 karakter");

  const conn  = getConnection();
  const owner = new PublicKey(walletPublicKey);

  // ── Dynamic import — only downloads when first Raydium launch is attempted ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = await import("@raydium-io/raydium-sdk-v2") as any;
  const { Raydium, TxVersion } = sdk;

  // ── Init Raydium SDK ──────────────────────────────────────────────────────
  // owner must be PublicKey | Keypair — not a raw string
  // disableLoadToken skips the 400 k-token list download (~30 MB), not needed for launchpad
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raydium = await (Raydium as any).load({
    connection:       conn,
    owner:            owner,          // PublicKey, not string
    cluster:          "mainnet" as const,
    disableLoadToken: true,
  });

  // ── Fetch launchpad configs to get configId ───────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configs: any[] = await raydium.api.fetchLaunchConfigs();
  if (!configs?.length) throw new Error("Tidak ada konfigurasi Raydium LaunchLab tersedia");

  // Prefer SOL-denominated config (mintB is always nested under .key per ApiLaunchConfig shape)
  const solanaMint = "So11111111111111111111111111111111111111112";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configEntry = configs.find((c: any) => c.key?.mintB === solanaMint) ?? configs[0];
  const configPubKey: string = configEntry.key?.pubKey ?? configEntry.pubKey ?? configEntry.id;
  if (!configPubKey) throw new Error("Config ID tidak ditemukan dari Raydium API");
  const configId = new PublicKey(configPubKey);

  // ── Generate fresh mint keypair ──────────────────────────────────────────
  const mintKeypair = Keypair.generate();

  // ── Call SDK to build transaction(s) ─────────────────────────────────────
  // createLaunchpad returns MultiTxBuildData<O>:
  //   { transactions: Transaction[], signers: Signer[][], execute, builder, extInfo }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkResult: any;
  try {
    sdkResult = await raydium.launchpad.createLaunchpad({
      mintA:        mintKeypair.publicKey,
      name,
      symbol,
      uri:          metadataUri,
      configId,
      platformId:   new PublicKey(RAYDIUM_DEFAULT_PLATFORM_ID),
      buyAmount:    new BN(0),
      migrateType:  "cpmm",
      txVersion:    TxVersion.LEGACY,
      feePayer:     owner,
      computeBudgetConfig: {
        units:         400_000,
        microLamports: RAYDIUM_PRIORITY_MICRO_LAMPORTS,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Gagal membangun transaksi Raydium: ${msg}`);
  }

  // ── Extract transactions + per-tx signers ─────────────────────────────────
  // SDK returns MultiTxBuildData: { transactions: Transaction[], signers: Signer[][] }
  // Defensive: also handle the single-tx TxBuildData shape { transaction, signers: Signer[] }
  let txs: Transaction[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let perTxSigners: any[][];

  if (Array.isArray(sdkResult.transactions)) {
    txs = sdkResult.transactions as Transaction[];
    // signers is Signer[][] — one array of signers per transaction
    perTxSigners = Array.isArray(sdkResult.signers?.[0])
      ? sdkResult.signers as unknown[][]
      : txs.map((_: Transaction, i: number) =>
          Array.isArray(sdkResult.signers) ? [sdkResult.signers[i]] : []
        );
  } else if (sdkResult.transaction) {
    // Fallback: TxBuildData shape with singular transaction
    txs = [sdkResult.transaction as Transaction];
    perTxSigners = [Array.isArray(sdkResult.signers) ? sdkResult.signers : []];
  } else {
    throw new Error("SDK tidak menghasilkan transaksi");
  }

  if (!txs.length) throw new Error("SDK tidak menghasilkan transaksi");

  // ── Partial-sign each transaction ─────────────────────────────────────────
  // IMPORTANT: The SDK has already set recentBlockhash on each transaction.
  // Do NOT overwrite it — that would invalidate any signatures already applied.
  //
  // For each tx: sign with per-tx SDK signers + mintKeypair (if not already signed).
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];

    // Ensure feePayer is set (SDK should have done this, but be defensive)
    if (!tx.feePayer) tx.feePayer = owner;

    // Collect all non-wallet signers for this transaction
    const txSignerSet = (perTxSigners[i] ?? []) as { publicKey: PublicKey; secretKey: Uint8Array }[];

    // Always include mintKeypair — it must sign the create instruction
    const candidates = [mintKeypair as { publicKey: PublicKey; secretKey: Uint8Array }, ...txSignerSet];

    // Deduplicate and exclude the user's wallet (they sign separately)
    const seen = new Set<string>();
    for (const signer of candidates) {
      const key = signer.publicKey.toBase58();
      if (seen.has(key) || key === walletPublicKey) continue;
      seen.add(key);
      try {
        tx.partialSign(signer);
      } catch {
        // May already be signed — ignore
      }
    }
  }

  // ── Collect blockhash for confirmation tracking ───────────────────────────
  // Read from the first SDK-built transaction (don't set a new one)
  const txBlockhash = txs[0].recentBlockhash ?? "";

  // Fetch lastValidBlockHeight separately — the SDK's blockhash was just fetched,
  // so this RPC call returns a very close estimate for the same epoch
  const { lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  return {
    transactions:        txs,
    mintAddress:         mintKeypair.publicKey.toBase58(),
    blockhash:           txBlockhash,
    lastValidBlockHeight,
  };
}

// ── Simulation ────────────────────────────────────────────────────────────────

/**
 * Simulate the first Raydium LaunchLab transaction without signature checks.
 * Surfaces instruction-level errors before prompting the user to approve in their wallet.
 */
export async function simulateRaydiumLaunch(tx: Transaction): Promise<void> {
  const conn = getConnection();
  // No signers arg → web3.js sends sigVerify: false to the RPC
  const { value: sim } = await conn.simulateTransaction(tx);

  if (sim.err) {
    const logs = sim.logs ?? [];
    const errorLine =
      logs.find(l => /Error:|failed:|AnchorError|InstructionError/i.test(l)) ??
      logs.at(-1) ??
      JSON.stringify(sim.err);
    throw new Error(`Simulasi gagal: ${errorLine}`);
  }
}
