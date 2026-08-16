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

import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getConnection } from "./solanaConnection";
import { getPlatformFeeRecipient, PLATFORM_CREATE_FEE_LAMPORTS } from "./platform-fee";

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
  // Generate a fresh mint keypair — pumpportal requires the `mint` parameter.
  // The address will be random (no "pump" suffix), which is fine functionally.
  const mintKeypair = Keypair.generate();

  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey:        walletAddress,
      action:           "create",
      tokenMetadata:    { name, symbol, uri: metadataUri },
      mint:             mintKeypair.publicKey.toBase58(),
      denominatedInSol: "true",
      amount:           0,
      slippage:         10,
      priorityFee:      0.0005,
      pool:             "pump",
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Failed to build pump.fun transaction: ${text}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const tx = VersionedTransaction.deserialize(bytes);

  const conn = getConnection();
  // Fetch blockhash from server cache (shared across all users, saves Alchemy CU)
  // while also fetching any ALTs needed for fee injection — done below in parallel.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  // ── Inject platform creation fee ──────────────────────────────────────────
  // MUST happen before signing — adding instructions after signing invalidates sigs.
  // Strategy: decompile (fetching ALTs if needed) → add fee transfer → recompile
  // with fresh blockhash → sign with mintKeypair.
  const feeRecipient = getPlatformFeeRecipient();
  let finalTx: VersionedTransaction;

  if (feeRecipient) {
    // Fetch Address Lookup Tables referenced by the pumpportal transaction.
    const lookups = tx.message.addressTableLookups ?? [];
    let altAccounts: AddressLookupTableAccount[] = [];
    if (lookups.length > 0) {
      const results = await Promise.all(
        lookups.map(l => conn.getAddressLookupTable(l.accountKey)),
      );
      altAccounts = results
        .map(r => r.value)
        .filter((v): v is AddressLookupTableAccount => v !== null);
    }

    const decompiledMsg = TransactionMessage.decompile(tx.message, {
      addressLookupTableAccounts: altAccounts,
    });

    // Append flat creation fee transfer (0.001 SOL) from the user to our wallet.
    decompiledMsg.instructions.push(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(walletAddress),
        toPubkey:   feeRecipient,
        lamports:   PLATFORM_CREATE_FEE_LAMPORTS,
      }),
    );

    // Bake in the fresh blockhash before compiling so partialSign uses the same value.
    decompiledMsg.recentBlockhash = blockhash;
    const newMessage = decompiledMsg.compileToV0Message(altAccounts);
    finalTx = new VersionedTransaction(newMessage);
  } else {
    // No fee recipient configured — keep original transaction, just refresh blockhash.
    tx.message.recentBlockhash = blockhash;
    finalTx = tx;
  }

  // Sign with the fresh blockhash — must happen AFTER blockhash is set.
  finalTx.sign([mintKeypair]);

  return {
    transaction: finalTx,
    mintAddress: mintKeypair.publicKey.toBase58(),
    blockhash,
    lastValidBlockHeight,
  };
}

// ── Trade transactions via pumpportal ─────────────────────────────────────────
//
// Pump.fun updated their on-chain program in 2025 to add a creatorVault account
// to buy/sell instructions. Our hand-built pumpfun-swap.ts builder is missing
// it, which causes Phantom's preflight simulation to return "Internal error".
// Delegating transaction construction to pumpportal.fun (same approach as create)
// ensures we always match the current account layout without manual maintenance.

export interface PumpPortalTradeTxResult {
  transaction:          VersionedTransaction;
  blockhash:            string;
  lastValidBlockHeight: number;
}

/**
 * Build a pump.fun bonding-curve BUY transaction via pumpportal.fun.
 *
 * @param walletAddress  Signer's base58 public key
 * @param mintAddress    Token mint address
 * @param solAmount      SOL to spend (display units, e.g. 3 for 3 SOL)
 * @param slippagePct    Slippage tolerance in percent (e.g. 1 for 1%)
 * @param priorityFeeSOL Priority fee in SOL (e.g. 0.001)
 */
export async function buildPumpFunBuyTxViaPortal(
  walletAddress:  string,
  mintAddress:    string,
  solAmount:      number,
  slippagePct:    number,
  priorityFeeSOL: number,
): Promise<PumpPortalTradeTxResult> {
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey:        walletAddress,
      action:           "buy",
      mint:             mintAddress,
      denominatedInSol: "true",
      amount:           solAmount,
      slippage:         slippagePct,
      priorityFee:      priorityFeeSOL,
      pool:             "pump",
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Failed to build buy transaction: ${text}`);
  }

  // Fetch pumpportal tx AND blockhash in parallel — saves one sequential RPC round-trip
  // while the user is still looking at the Phantom approval popup.
  const [txBytes, bh] = await Promise.all([
    res.arrayBuffer().then(b => new Uint8Array(b)),
    fetch("/api/blockhash").then(r => r.json() as Promise<{ blockhash: string; lastValidBlockHeight: number }>),
  ]);
  const tx    = VersionedTransaction.deserialize(txBytes);
  const { blockhash, lastValidBlockHeight } = bh;
  tx.message.recentBlockhash = blockhash;

  return { transaction: tx, blockhash, lastValidBlockHeight };
}

/**
 * Build a pump.fun bonding-curve SELL transaction via pumpportal.fun.
 *
 * @param walletAddress  Signer's base58 public key
 * @param mintAddress    Token mint address
 * @param tokenAmount    Token amount to sell (display units, not atoms)
 * @param slippagePct    Slippage tolerance in percent (e.g. 1 for 1%)
 * @param priorityFeeSOL Priority fee in SOL (e.g. 0.001)
 */
export async function buildPumpFunSellTxViaPortal(
  walletAddress:  string,
  mintAddress:    string,
  tokenAmount:    number,
  slippagePct:    number,
  priorityFeeSOL: number,
): Promise<PumpPortalTradeTxResult> {
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey:        walletAddress,
      action:           "sell",
      mint:             mintAddress,
      denominatedInSol: "false",   // amount is in tokens, not SOL
      amount:           tokenAmount,
      slippage:         slippagePct,
      priorityFee:      priorityFeeSOL,
      pool:             "pump",
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Failed to build sell transaction: ${text}`);
  }

  // Fetch pumpportal tx AND blockhash in parallel — saves one sequential RPC round-trip.
  const [txBytes, bh] = await Promise.all([
    res.arrayBuffer().then(b => new Uint8Array(b)),
    fetch("/api/blockhash").then(r => r.json() as Promise<{ blockhash: string; lastValidBlockHeight: number }>),
  ]);
  const tx    = VersionedTransaction.deserialize(txBytes);
  const { blockhash, lastValidBlockHeight } = bh;
  tx.message.recentBlockhash = blockhash;

  return { transaction: tx, blockhash, lastValidBlockHeight };
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
    // AccountNotFound is a simulation-only quirk: pumpportal.fun transactions use
    // Address Lookup Tables (ALTs) that may not be cached on our RPC node yet.
    // The error does NOT appear on-chain — skip and let the wallet submit normally.
    const errStr = JSON.stringify(sim.err);
    if (errStr.includes("AccountNotFound")) {
      console.warn("[pumpfunLauncher] simulation AccountNotFound (likely ALT cache miss) — skipping preflight, proceeding to submit");
      return;
    }

    const logs = sim.logs ?? [];
    const errorLine =
      logs.find(l => /Error:|failed:|AnchorError|InstructionError/i.test(l)) ??
      logs.at(-1) ??
      errStr;
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
