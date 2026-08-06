/**
 * LetsBONK adapter — subscribes to Solana RPC `logsSubscribe` for the
 * LetsBONK program and ingests token launches and swap events in real time.
 *
 * Required env vars:
 *   SOLANA_RPC_URL  — wss://... or https://... endpoint (Helius, QuickNode, etc.)
 *                     The adapter infers the WSS URL automatically from the HTTP URL.
 *
 * Optional env vars:
 *   LETSBONK_PROGRAM_ID — Override the default program ID if LetsBONK deploys
 *                         to a new address. Default: LBUZKhRxPF3XUpBCjp4YzTKgLLjJfPswEmNxclZs1pe
 *
 * If SOLANA_RPC_URL is not set, the adapter logs a warning and exits silently.
 */

import { eq, sql } from "drizzle-orm";
import { db, tokensTable, tradesTable } from "@workspace/db";
import { logger } from "../logger";
import { emitTrade, emitNewToken } from "../tradeEmitter";

// Default LetsBONK program ID — update via env var if the program migrates
const DEFAULT_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLLjJfPswEmNxclZs1pe";
const PLATFORM = "letsbonk";
const CHAIN = "solana";
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 120_000;

// ── URL helpers ───────────────────────────────────────────────────────────────

function toWssUrl(rpcUrl: string): string {
  if (rpcUrl.startsWith("wss://") || rpcUrl.startsWith("ws://")) return rpcUrl;
  return rpcUrl.replace(/^https?:\/\//, (m) => (m === "https://" ? "wss://" : "ws://"));
}

function toHttpUrl(rpcUrl: string): string {
  if (rpcUrl.startsWith("http://") || rpcUrl.startsWith("https://")) return rpcUrl;
  return rpcUrl.replace(/^wss?:\/\//, (m) => (m === "wss://" ? "https://" : "http://"));
}

// ── Solana RPC helpers ────────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

interface ParsedInstruction {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

interface RpcTransactionResult {
  meta?: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    preBalances?: number[];
    postBalances?: number[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<{ pubkey?: string } | string>;
    };
  };
}

let _rpcIdCounter = 1;
function nextId(): number { return _rpcIdCounter++; }

async function rpcCall(httpUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const body: RpcRequest = { jsonrpc: "2.0", id: nextId(), method, params };
  const res = await fetch(httpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// ── Transaction parsing ───────────────────────────────────────────────────────

/**
 * Given a confirmed transaction, extract the primary mint address and
 * SOL/token amounts involved. Returns null if we can't determine the mint.
 */
function parseTransaction(tx: RpcTransactionResult, signature: string): {
  mint: string;
  isBuy: boolean;
  solLamports: string;
  tokenAmount: string;
  traderAddress: string;
} | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;

  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  const preBalances = meta.preBalances ?? [];
  const postBalances = meta.postBalances ?? [];

  // Find the mint that had the largest absolute token change
  const mintDeltas = new Map<string, bigint>();
  for (const pb of post) {
    const preEntry = pre.find(
      (p) => p.mint === pb.mint && p.accountIndex === pb.accountIndex
    );
    const preAmt = BigInt(preEntry?.uiTokenAmount.amount ?? "0");
    const postAmt = BigInt(pb.uiTokenAmount.amount);
    const delta = postAmt - preAmt;
    if (delta !== 0n) {
      mintDeltas.set(pb.mint, (mintDeltas.get(pb.mint) ?? 0n) + delta);
    }
  }

  if (mintDeltas.size === 0) return null;

  // Pick mint with largest absolute delta (primary token in the tx)
  const [mint, delta] = [...mintDeltas.entries()].reduce((best, cur) =>
    (cur[1] < 0n ? -cur[1] : cur[1]) > (best[1] < 0n ? -best[1] : best[1]) ? cur : best
  );

  // Determine buy vs sell by sign: positive delta means user received tokens (buy)
  const isBuy = delta > 0n;
  const tokenAmount = (delta < 0n ? -delta : delta).toString();

  // SOL delta for the fee payer (account 0): negative = SOL spent (buy), positive = SOL received (sell)
  const solDelta = (postBalances[0] ?? 0) - (preBalances[0] ?? 0);
  const solLamports = Math.abs(solDelta).toString();

  // Trader = account 0 (fee payer / signer)
  const accountKeys = tx.transaction?.message?.accountKeys ?? [];
  const firstKey = accountKeys[0];
  const traderAddress = typeof firstKey === "string"
    ? firstKey
    : (firstKey?.pubkey ?? "unknown");

  return { mint, isBuy, solLamports, tokenAmount, traderAddress };
}

// ── Detect instruction type from log lines ────────────────────────────────────

type InstructionType = "create" | "buy" | "sell" | "unknown";

function detectInstruction(logs: string[]): InstructionType {
  for (const line of logs) {
    if (/Instruction:\s*Create/i.test(line) || /Instruction:\s*InitializeMint/i.test(line)) return "create";
    if (/Instruction:\s*Buy/i.test(line)) return "buy";
    if (/Instruction:\s*Sell/i.test(line)) return "sell";
  }
  return "unknown";
}

// ── Process a single log notification ─────────────────────────────────────────

async function processLog(
  httpUrl: string,
  signature: string,
  logs: string[]
): Promise<void> {
  const instrType = detectInstruction(logs);
  if (instrType === "unknown") return;

  const log = logger.child({ adapter: "letsbonk", sig: signature, instr: instrType });

  try {
    const txResult = await rpcCall(httpUrl, "getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]) as RpcTransactionResult | null;

    if (!txResult) return;

    const parsed = parseTransaction(txResult, signature);
    if (!parsed) return;

    const { mint, isBuy, solLamports, tokenAmount, traderAddress } = parsed;

    if (instrType === "create") {
      // Token launch
      await db
        .insert(tokensTable)
        .values({
          address: mint,
          name: mint.slice(0, 8) + "...", // placeholder until metadata is fetched
          symbol: "???",
          description: null,
          imageUrl: null,
          creatorAddress: traderAddress,
          totalSupply: "1000000000000000",
          virtualTokenReserves: "1000000000000000",
          virtualEthReserves: "0",
          platform: PLATFORM,
          chain: CHAIN,
        })
        .onConflictDoNothing();

      log.info({ mint }, "letsbonk: new token detected");

      // Broadcast to global feed (placeholder name until metadata enrichment)
      emitNewToken({
        type: "newToken",
        token: {
          address: mint,
          name: mint.slice(0, 8) + "...",
          symbol: "???",
          imageUrl: null,
          priceEth: null,
          marketCapEth: null,
          platform: PLATFORM,
          chain: CHAIN,
          createdAt: new Date().toISOString(),
        },
      });
    } else {
      // Swap (buy or sell)
      const [trade] = await db
        .insert(tradesTable)
        .values({
          tokenAddress: mint,
          tokenName: null,
          tokenSymbol: null,
          traderAddress,
          isBuy,
          ethAmount: solLamports,
          tokenAmount,
          priceEth: tokenAmount !== "0"
            ? (Number(solLamports) / Number(tokenAmount)).toFixed(12)
            : null,
          txHash: signature,
          platform: PLATFORM,
          timestamp: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      if (!trade) return; // duplicate

      await db
        .update(tokensTable)
        .set({
          tradeCount: sql`${tokensTable.tradeCount} + 1`,
          volumeEth: sql`CAST(CAST(${tokensTable.volumeEth} AS NUMERIC) + ${solLamports} AS TEXT)`,
        })
        .where(eq(tokensTable.address, mint));

      log.debug({ mint, isBuy, sol: solLamports }, "letsbonk: trade ingested");

      emitTrade({
        type: "trade",
        trade: {
          id: trade.id,
          tokenAddress: trade.tokenAddress,
          traderAddress: trade.traderAddress,
          isBuy: trade.isBuy,
          ethAmount: trade.ethAmount,
          tokenAmount: trade.tokenAmount,
          priceEth: trade.priceEth,
          txHash: trade.txHash,
          platform: PLATFORM,
          timestamp: trade.timestamp.toISOString(),
        },
        token: {
          address: mint,
          name: null,
          symbol: null,
          priceEth: trade.priceEth,
          marketCapEth: null,
          volumeEth: solLamports,
          virtualEthReserves: "0",
          virtualTokenReserves: "0",
          tradeCount: 0,
          platform: PLATFORM,
          chain: CHAIN,
        },
      });
    }
  } catch (err) {
    logger.error({ adapter: "letsbonk", sig: signature, err }, "letsbonk: failed to process transaction");
  }
}

// ── WebSocket subscription ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export async function startLetsBonkAdapter(): Promise<void> {
  const rpcUrl = process.env["SOLANA_RPC_URL"];
  if (!rpcUrl) {
    logger.warn(
      { adapter: "letsbonk" },
      "letsbonk: SOLANA_RPC_URL not set — adapter disabled. " +
      "Set it to a Solana RPC WebSocket URL (e.g. Helius or QuickNode) to enable."
    );
    return;
  }

  const programId = process.env["LETSBONK_PROGRAM_ID"] ?? DEFAULT_PROGRAM_ID;
  const wssUrl = toWssUrl(rpcUrl);
  const httpUrl = toHttpUrl(rpcUrl);
  let delay = RECONNECT_DELAY_MS;

  function connect(): void {
    const ws = new WebSocket(wssUrl);
    logger.info({ adapter: "letsbonk", programId }, "letsbonk: connecting to Solana RPC...");

    ws.addEventListener("open", () => {
      delay = RECONNECT_DELAY_MS;
      logger.info({ adapter: "letsbonk", programId }, "letsbonk: connected — subscribing to program logs");

      const subscribeMsg = {
        jsonrpc: "2.0",
        id: nextId(),
        method: "logsSubscribe",
        params: [
          { mentions: [programId] },
          { commitment: "confirmed" },
        ],
      };
      ws.send(JSON.stringify(subscribeMsg));
    });

    ws.addEventListener("message", (event) => {
      let msg: JsonValue;
      try {
        msg = JSON.parse(event.data as string) as JsonValue;
      } catch { return; }

      // Handle subscription confirmation
      const m = msg as Record<string, JsonValue>;
      if (m["method"] !== "logsNotification") return;

      const params = m["params"] as Record<string, JsonValue> | undefined;
      const result = params?.["result"] as Record<string, JsonValue> | undefined;
      const value = result?.["value"] as Record<string, JsonValue> | undefined;

      if (!value) return;
      if (value["err"]) return; // failed tx, skip

      const signature = value["signature"] as string | undefined;
      const logs = value["logs"] as string[] | undefined;

      if (!signature || !Array.isArray(logs)) return;

      void processLog(httpUrl, signature, logs);
    });

    ws.addEventListener("error", (err) => {
      logger.error({ adapter: "letsbonk", err: String(err) }, "letsbonk: WebSocket error");
    });

    ws.addEventListener("close", () => {
      logger.warn({ adapter: "letsbonk", retryMs: delay }, "letsbonk: disconnected — reconnecting...");
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    });
  }

  connect();
}
