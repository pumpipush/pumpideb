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

  // Validate URI shapes before using them on-chain (#138)
  _validateUploadUri(imageUri, "Raydium image upload");
  _validateUploadUri(uri, "Raydium metadata upload");

  // Best-effort check: fetch the metadata and verify required fields are present.
  // Fails-open on timeout/network errors (IPFS propagation can be slow).
  // Fails-closed only when the server responds with clearly malformed JSON.
  await _verifyMetadataReadable(uri);

  return uri;
}

// ── SDK module cache ──────────────────────────────────────────────────────────

/**
 * Module-level cache for the dynamically imported Raydium SDK.
 * Set to the resolved module after the first successful import so subsequent
 * calls skip the ~10 MB download.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cachedSdk: any | null = null;

/**
 * Returns true if the Raydium SDK has already been downloaded and cached in
 * this browser session. Callers can use this to decide whether to show a
 * "loading SDK…" indicator before calling buildRaydiumLaunchTx.
 */
export function isRaydiumSdkCached(): boolean {
  return _cachedSdk !== null;
}

/**
 * Pre-warms the Raydium SDK in the background without blocking. (#139)
 *
 * Call when the user selects "Raydium LaunchLab" so the ~10 MB download
 * starts immediately. By the time they fill the form and click Launch the
 * module is already cached — buildRaydiumLaunchTx will skip the download and
 * the SDK-loading sub-label will never appear.
 *
 * Silently swallows network errors — the actual launch will surface them.
 */
export function preloadRaydiumSdk(): void {
  if (_cachedSdk !== null) return;
  // Fire-and-forget: intentionally not awaited
  import("@raydium-io/raydium-sdk-v2")
    .then((mod) => { _cachedSdk = mod; })
    .catch(() => { /* ignore — buildRaydiumLaunchTx will retry */ });
}

// ── Metadata upload validation ─────────────────────────────────────────────────

/**
 * Validates the URI shape returned by an upload endpoint. (#138)
 * Throws early with a clear message rather than letting the on-chain
 * instruction fail with a cryptic AnchorError later.
 */
function _validateUploadUri(uri: string, label: string): void {
  if (!uri || typeof uri !== "string") {
    throw new Error(`${label}: server mengembalikan URI kosong`);
  }
  try {
    const url = new URL(uri);
    if (!["https:", "http:", "ipfs:"].includes(url.protocol)) {
      throw new Error(`protokol tidak dikenal: ${url.protocol}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: URI tidak valid — "${uri.slice(0, 80)}" (${msg})`);
  }
}

/**
 * Best-effort verification that the metadata URI returns parseable JSON
 * with the required name/symbol fields. (#138)
 *
 * Uses a short timeout and fails-open on network errors (IPFS propagation
 * can take a few seconds). Throws only when the server responds but the
 * content is actively malformed — so we surface a clear error before
 * calling createLaunchpad() with broken metadata.
 */
async function _verifyMetadataReadable(uri: string): Promise<void> {
  try {
    // _tryRaydiumUpload always yields HTTPS URLs from Raydium's CDN;
    // no ipfs:// resolution needed here.
    const res = await fetch(uri, {
      signal:  AbortSignal.timeout(8_000),
      headers: { "User-Agent": "RocketFi/1.0" },
    });
    if (!res.ok) return; // propagation delay — fail-open
    const json = await res.json() as Record<string, unknown>;
    // Fail-closed only when the content is reachable but missing required fields
    if (typeof json.name !== "string" || !json.name.trim()) {
      throw new Error("Metadata tidak valid: field 'name' kosong atau tidak ada");
    }
    if (typeof json.symbol !== "string" || !json.symbol.trim()) {
      throw new Error("Metadata tidak valid: field 'symbol' kosong atau tidak ada");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Re-throw explicit validation failures; swallow network / timeout errors
    if (msg.startsWith("Metadata tidak valid")) throw err;
    // IPFS propagation or network timeout — proceed and let the program decide
  }
}

// ── Transaction Builder ───────────────────────────────────────────────────────

// hint: Logic changed on both sides. Requires understanding intent of each change.
/**
 * Build the Raydium LaunchLab create-token transaction(s).
 *
 * The SDK (@raydium-io/raydium-sdk-v2) returns MultiTxBuildData:
 *   { transactions: Transaction[], signers: Signer[][] }
 * where signers[i] are the non-wallet keypairs required for transactions[i].
 *
 * This function:
 *  1. Fetches recentBlockhash from RPC and stamps each transaction (SDK does not set it)
 *  2. Partial-signs each transaction with its per-tx SDK signers + mintKeypair
 *  3. Returns all transactions for the caller to sign sequentially with user wallet
 *
 * @param onSdkLoaded - Optional callback fired immediately after the SDK
 *   dynamic-import resolves (i.e. once the ~10 MB download completes).
 *   Useful for updating UI ("SDK loaded, building tx…").
 */
export async function buildRaydiumLaunchTx(
  walletPublicKey: string,
  name:            string,
  symbol:          string,
  metadataUri:     string,
  onSdkLoaded?:   () => void,
): Promise<RaydiumLaunchTxResult> {
  if (symbol.length > 10) throw new Error("Ticker maksimal 10 karakter");

  const conn  = getConnection();
  const owner = new PublicKey(walletPublicKey);

  // ── Dynamic import — only downloads when first Raydium launch is attempted ──
  // Use module-level cache so the ~10 MB chunk is only fetched once per session.
  if (!_cachedSdk) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _cachedSdk = await import("@raydium-io/raydium-sdk-v2") as any;
  }
  // Notify the caller that the (potentially slow) download is complete.
  onSdkLoaded?.();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = _cachedSdk as any;
  const { Raydium, TxVersion } = sdk;

  // ── Init Raydium SDK ──────────────────────────────────────────────────────
  // owner must be a PublicKey, not a raw string.
  // disableLoadToken skips the 400 k-token list download (~30 MB), not needed for launchpad.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raydium = await (Raydium as any).load({
    connection:       conn,
    owner:            owner,           // PublicKey, not string
    cluster:          "mainnet" as const,
    disableLoadToken: true,
  });

  // ── Fetch launchpad configs to get configId ───────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configs: any[] = await raydium.api.fetchLaunchConfigs();
  if (!configs?.length) throw new Error("Tidak ada konfigurasi Raydium LaunchLab tersedia");

  // Prefer SOL-denominated config, fall back to first available.
  // Check both c.mintB and c.key?.mintB — API shape may vary across SDK versions.
  const solanaMint = "So11111111111111111111111111111111111111112";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configEntry = configs.find((c: any) =>
    c.mintB === solanaMint || c.key?.mintB === solanaMint
  ) ?? configs[0];
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

  // ── Fetch blockhash and stamp each transaction ────────────────────────────
  // TxVersion.LEGACY: the Raydium SDK returns transactions WITHOUT recentBlockhash
  // set (verified by smoke test against 0.2.60-alpha). We must fetch it from the
  // RPC and set it on every transaction before partial-signing — partialSign throws
  // "Transaction recentBlockhash required" otherwise.
  //
  // If the SDK ever starts setting the blockhash itself (future alpha update),
  // the `?? blockhash` fallback means we do not overwrite an existing value.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  // ── Partial-sign each transaction ─────────────────────────────────────────
  // For each tx: set blockhash (if missing), then sign with per-tx SDK signers
  // + mintKeypair. The user's wallet adds its signature separately via the caller.
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];

    // Set blockhash if the SDK left it unset (current behavior as of 0.2.60-alpha)
    if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Tolerate "already signed" — SDK may have pre-signed with this key.
        // Re-throw anything else so bugs surface early instead of silently failing.
        if (!msg.toLowerCase().includes("already") && !msg.toLowerCase().includes("duplicate")) {
          throw new Error(`Gagal partial-sign transaksi ${i}: ${msg}`);
        }
      }
    }
  }

  // ── Blockhash for confirmation tracking ──────────────────────────────────
  // Use the blockhash fetched above (already stamped onto each tx).
  const txBlockhash = txs[0].recentBlockhash ?? blockhash;

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
