/**
 * pumpfunLauncher.ts — On-chain token creation for pump.fun bonding curve.
 *
 * Flow:
 *   1. uploadToPumpFunIpfs()     → POST image + metadata to our server → metadataUri
 *   2. buildPumpFunCreateTx()    → call pumpportal.fun to build the correct tx
 *   3. (caller) simulate tx      → connection.simulateTransaction(tx)
 *   4. (caller) signAndSendTransaction(tx) → wallet signs + broadcasts
 *   5. (caller) waitForConfirmation(sig)
 *
 * Why pumpportal.fun?
 *   Pump.fun upgraded their on-chain program (same program ID, new bytecode) in 2025.
 *   The new version uses Token-2022, a different global state account, 17 accounts per
 *   create instruction, and a completely different data layout — none of which matches
 *   the old hand-built approach. Pumpportal's /api/trade-local always builds transactions
 *   against the current pump.fun program, so we delegate transaction construction there.
 *
 * The mint keypair is generated client-side and injected into the pumpportal request so
 * the returned transaction already includes the mint's partial signature before the
 * user wallet adds its own signature.
 */

import { VersionedTransaction } from "@solana/web3.js";
import { getConnection } from "./solanaConnection";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PumpFunIpfsFields {
  name:        string;
  symbol:      string;
  description: string;
  twitter?:    string;
  telegram?:   string;
  website?:    string;
  image:       File;
}

export interface PumpFunCreateTxResult {
  transaction:          VersionedTransaction;
  mintAddress:          string;
  blockhash:            string;
  lastValidBlockHeight: number;
}

// ── IPFS Upload ───────────────────────────────────────────────────────────────

/**
 * Upload token metadata + image to our self-hosted metadata endpoint.
 *
 * pump.fun's /api/ipfs endpoint is blocked from Replit datacenter IPs (Cloudflare
 * 530) and rejects cross-origin browser requests. We avoid it entirely by hosting
 * the metadata ourselves via the API server's object storage.
 *
 * Flow:
 *   1. Encode the image as base64 in the browser (no binary/multipart complexity)
 *   2. POST JSON to /api/pump-ipfs-upload
 *   3. Server uploads image + metadata JSON to GCS public path
 *   4. Server returns an absolute HTTPS metadataUri
 *
 * pump.fun's on-chain program only stores the metadataUri string and accepts any
 * publicly reachable HTTPS URL — not exclusively IPFS URIs.
 */
export async function uploadToPumpFunIpfs(fields: PumpFunIpfsFields): Promise<string> {
  // Convert File → base64 using FileReader (browser-native, no Buffer polyfill needed)
  const imageBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // FileReader.readAsDataURL produces "data:<mime>;base64,<data>" — strip prefix
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(fields.image);
  });

  const attempt = async () => {
    const body: Record<string, string> = {
      name:        fields.name,
      symbol:      fields.symbol,
      description: fields.description,
      imageBase64,
      imageType:   fields.image.type || "image/png",
    };
    if (fields.twitter)  body.twitter  = fields.twitter;
    if (fields.telegram) body.telegram = fields.telegram;
    if (fields.website)  body.website  = fields.website;

    const res = await fetch("/api/pump-ipfs-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`pump.fun metadata upload failed (${res.status}): ${text}`);
    }

    const data = await res.json() as { metadataUri?: string };
    if (!data.metadataUri) {
      throw new Error("Metadata upload response did not include metadataUri");
    }
    return data.metadataUri;
  };

  try {
    return await attempt();
  } catch (firstErr) {
    // One retry on transient errors
    try {
      return await attempt();
    } catch {
      throw firstErr; // throw the original error for better diagnostics
    }
  }
}

// ── Transaction Builder ───────────────────────────────────────────────────────

/**
 * Build a pump.fun token CREATE transaction via pumpportal.fun's local tx builder.
 *
 * Pumpportal always generates transactions compatible with pump.fun's current
 * on-chain program version, so this stays correct across pump.fun upgrades.
 *
 * The mint Keypair is generated locally and injected into the request so pumpportal
 * includes the mint's partial signature in the returned transaction. The caller only
 * needs to pass the result straight to signAndSendTransaction — no additional
 * partialSign step needed.
 *
 * @param walletAddress  Signer's base58 public key
 * @param name           Token name
 * @param symbol         Ticker symbol (uppercased)
 * @param metadataUri    Public HTTPS URL to the token metadata JSON
 */
export async function buildPumpFunCreateTx(
  walletAddress:  string,
  name:           string,
  symbol:         string,
  metadataUri:    string,
): Promise<PumpFunCreateTxResult> {
  // We do NOT generate our own mint keypair.
  //
  // Pumpportal grinds keypairs server-side until it finds one ending in "pump"
  // (matching pump.fun's native address style). When `mint` is omitted from the
  // request, pumpportal generates and signs with that keypair itself — the returned
  // transaction already carries the mint's partial signature.
  //
  // Generating our own keypair and passing it here would bypass the grinding,
  // resulting in a random address with no "pump" suffix.

  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey:        walletAddress,
      action:           "create",
      tokenMetadata:    { name, symbol, uri: metadataUri },
      // mint intentionally omitted — pumpportal generates a "pump"-suffixed address
      denominatedInSol: "true",
      amount:           0,        // no forced initial buy
      slippage:         10,
      priorityFee:      0.0005,
      pool:             "pump",
    }),
    signal: AbortSignal.timeout(30_000), // grinding takes a few extra seconds
  });

  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Failed to build pump.fun transaction: ${text}`);
  }

  // Pumpportal returns raw bytes of a VersionedTransaction already signed by the mint keypair
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tx = VersionedTransaction.deserialize(bytes);

  // Recover the mint address: pumpportal always places the "pump"-suffixed key in the
  // static account list. The wallet public key is also there — find the one ending in "pump".
  const mintAddress =
    tx.message.staticAccountKeys.find(k => k.toBase58().endsWith("pump"))?.toBase58()
    // Fallback: first non-wallet non-system account (extremely unlikely to be needed)
    ?? tx.message.staticAccountKeys
        .map(k => k.toBase58())
        .find(a => a !== walletAddress);

  if (!mintAddress) {
    throw new Error("Could not determine mint address from pumpportal transaction");
  }

  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  return {
    transaction: tx,
    mintAddress,
    blockhash,
    lastValidBlockHeight,
  };
}

// ── Simulation ────────────────────────────────────────────────────────────────

/**
 * Simulate a pump.fun create VersionedTransaction without signature verification.
 *
 * Detects instruction-level errors (bad accounts, insufficient SOL, etc.)
 * before asking the user to approve in their wallet.
 *
 * @throws Error with a human-readable message extracted from program logs
 */
export async function simulatePumpFunCreate(tx: VersionedTransaction): Promise<void> {
  const conn = getConnection();
  const { value: sim } = await conn.simulateTransaction(tx, {
    // replaceRecentBlockhash lets the RPC use a fresh blockhash for the simulation
    // so it doesn't fail due to an expired blockhash from the pumpportal call
    replaceRecentBlockhash: true,
    sigVerify: false,
  });

  if (sim.err) {
    const logs = sim.logs ?? [];
    const errorLine =
      logs.find(l => /Error:|failed:|AnchorError|InstructionError/i.test(l)) ??
      logs.at(-1) ??
      JSON.stringify(sim.err);
    throw new Error(`Simulation failed: ${errorLine}`);
  }
}

// ── Estimated cost ────────────────────────────────────────────────────────────

/**
 * Approximate SOL cost to launch a pump.fun token:
 *   - Rent for Token-2022 mint + metadata extension: ~0.003 SOL
 *   - pump.fun protocol fee: ~0.015 SOL
 *   - Priority fee + transaction fee: ~0.001 SOL
 */
export const PUMP_FUN_LAUNCH_COST_SOL = 0.02;
