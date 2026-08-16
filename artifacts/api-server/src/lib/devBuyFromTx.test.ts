import { describe, it, expect } from "vitest";
// Minimal base58 codec (avoids adding a dependency just for tests)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const bs58 = {
  encode(buf: Buffer): string {
    let n = BigInt("0x" + (buf.toString("hex") || "0"));
    let out = "";
    while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    for (const b of buf) { if (b === 0) out = "1" + out; else break; }
    return out || "1";
  },
  decode(str: string): Uint8Array {
    let n = 0n;
    for (const c of str) n = n * 58n + BigInt(B58.indexOf(c));
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    let buf = Buffer.from(hex, "hex");
    let zeros = 0;
    for (const c of str) { if (c === "1") zeros++; else break; }
    const out = Buffer.alloc(32);
    Buffer.concat([Buffer.alloc(zeros), buf]).copy(out, 32 - zeros - buf.length + zeros);
    return out;
  },
};
import { extractDevBuyFromConfirmedTx, type ConfirmedTxJson } from "./devBuyFromTx.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const LAB_PROGRAM  = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const TRADE_DISC   = Buffer.from("bddb7fd34ee661ee", "hex");

// Deterministic fake base58 addresses (32 bytes each)
const MINT    = bs58.encode(Buffer.alloc(32, 7));
const CREATOR = bs58.encode(Buffer.alloc(32, 9));
const POOL    = bs58.encode(Buffer.alloc(32, 4));
const OTHER   = bs58.encode(Buffer.alloc(32, 5));

const SOL_LAMPORTS = 2_200_000_000n;      // exact 2.2 SOL dev buy
const TOKEN_BASE   = 73_310_559_006_211n; // exact tokens received

/** Build a pump.fun TradeEvent (113-byte layout) "Program data:" log line. */
function pumpTradeEventLog(opts?: { mint?: string; trader?: string; isBuy?: boolean }): string {
  const buf = Buffer.alloc(113);
  TRADE_DISC.copy(buf, 0);
  Buffer.from(bs58.decode(opts?.mint ?? MINT)).copy(buf, 8);
  buf.writeBigUInt64LE(SOL_LAMPORTS, 40);
  buf.writeBigUInt64LE(TOKEN_BASE, 48);
  buf[56] = (opts?.isBuy ?? true) ? 1 : 0;
  Buffer.from(bs58.decode(opts?.trader ?? CREATOR)).copy(buf, 57);
  buf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 89);
  buf.writeBigUInt64LE(32_200_000_000n, 97);        // virtual sol reserves
  buf.writeBigUInt64LE(999_689_440_993_789n, 105);  // virtual token reserves
  return `Program data: ${buf.toString("base64")}`;
}

/** Build a LaunchLab TradeEvent (147-byte layout) "Program data:" log line. */
function labTradeEventLog(opts?: { isBuy?: boolean }): string {
  const buf = Buffer.alloc(147);
  TRADE_DISC.copy(buf, 0);
  Buffer.from(bs58.decode(POOL)).copy(buf, 8);
  buf.writeBigUInt64LE(32_200_000_000n, 40); // post-trade vSol (in 30–200 SOL sanity range)
  buf.writeBigUInt64LE(999_000_000_000_000n, 48); // post-trade vTok
  buf.writeBigUInt64LE(SOL_LAMPORTS, 72);
  buf.writeBigUInt64LE(TOKEN_BASE, 80);
  buf[88] = (opts?.isBuy ?? true) ? 1 : 0;
  return `Program data: ${buf.toString("base64")}`;
}

function makeTx(opts: {
  logs: string[];
  err?: unknown;
  tokenDelta?: bigint;        // creator's token increase for MINT
  tokenOwner?: string;
}): ConfirmedTxJson {
  const delta = opts.tokenDelta ?? TOKEN_BASE;
  return {
    blockTime: 1_786_885_445,
    meta: {
      err: opts.err ?? null,
      logMessages: opts.logs,
      preTokenBalances: [],
      postTokenBalances: delta > 0n ? [{
        accountIndex: 3,
        mint: MINT,
        owner: opts.tokenOwner ?? CREATOR,
        uiTokenAmount: { amount: delta.toString(), decimals: 6 },
      }] : [],
    },
  };
}

const pumpInvoke = `Program ${PUMP_PROGRAM} invoke [1]`;
const labInvoke  = `Program ${LAB_PROGRAM} invoke [1]`;
// A launch tx always contains rent/account-creation system transfers — these
// logs (and their SOL costs) must never influence the derived amounts.
const rentNoise = [
  "Program 11111111111111111111111111111111 invoke [1]",
  "Program 11111111111111111111111111111111 success",
  "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1]",
  "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success",
];

// ── pump.fun ──────────────────────────────────────────────────────────────────

describe("extractDevBuyFromConfirmedTx — pump.fun", () => {
  it("extracts exact event amounts, ignoring rent/account-creation costs", () => {
    const tx = makeTx({ logs: [...rentNoise, pumpInvoke, pumpTradeEventLog()] });
    const out = extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun");
    expect(out).not.toBeNull();
    expect(out!.solLamports).toBe(SOL_LAMPORTS);       // exact swap amount, NOT wallet delta
    expect(out!.tokenBaseUnits).toBe(TOKEN_BASE);
    expect(out!.priceEth).toBe((Number(SOL_LAMPORTS) / Number(TOKEN_BASE) / 1000).toFixed(15));
    expect(out!.blockTime).toEqual(new Date(1_786_885_445 * 1000));
  });

  it("returns null when the tx has only rent/unrelated transfers (no TradeEvent)", () => {
    const tx = makeTx({ logs: [...rentNoise, pumpInvoke, `Program ${PUMP_PROGRAM} success`] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun")).toBeNull();
  });

  it("returns null when the pump.fun program was never invoked", () => {
    const tx = makeTx({ logs: [...rentNoise, pumpTradeEventLog()] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun")).toBeNull();
  });

  it("returns null when the event's mint does not match the registered mint", () => {
    const tx = makeTx({ logs: [pumpInvoke, pumpTradeEventLog({ mint: bs58.encode(Buffer.alloc(32, 1)) })] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun")).toBeNull();
  });

  it("returns null when the event's trader is not the creator", () => {
    const tx = makeTx({ logs: [pumpInvoke, pumpTradeEventLog({ trader: OTHER })] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun")).toBeNull();
  });

  it("returns null for a sell event", () => {
    const tx = makeTx({ logs: [pumpInvoke, pumpTradeEventLog({ isBuy: false })] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun")).toBeNull();
  });

  it("ignores a forged TradeEvent emitted by a foreign program in the same tx (provenance)", () => {
    const attacker = bs58.encode(Buffer.alloc(32, 2));
    // Attacker's program emits a perfectly-forged event (matching mint+trader,
    // arbitrary amounts) inside ITS OWN invocation scope; pump.fun is also
    // invoked in the same tx but emits no trade event (create-only launch).
    const tx = makeTx({ logs: [
      `Program ${attacker} invoke [1]`,
      pumpTradeEventLog(),                       // forged — outside pump.fun scope
      `Program ${attacker} success`,
      pumpInvoke,
      `Program ${PUMP_PROGRAM} success`,
    ] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun")).toBeNull();
  });

  it("still extracts the genuine event when a forged one precedes it", () => {
    const attacker = bs58.encode(Buffer.alloc(32, 2));
    const forged = Buffer.alloc(113);
    TRADE_DISC.copy(forged, 0);
    Buffer.from(bs58.decode(MINT)).copy(forged, 8);
    forged.writeBigUInt64LE(999_000_000_000n, 40); // inflated forged SOL amount
    forged.writeBigUInt64LE(1n, 48);
    forged[56] = 1;
    Buffer.from(bs58.decode(CREATOR)).copy(forged, 57);
    const tx = makeTx({ logs: [
      `Program ${attacker} invoke [1]`,
      `Program data: ${forged.toString("base64")}`,
      `Program ${attacker} success`,
      pumpInvoke,
      pumpTradeEventLog(),                       // genuine, inside pump.fun scope
      `Program ${PUMP_PROGRAM} success`,
    ] });
    const out = extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun");
    expect(out).not.toBeNull();
    expect(out!.solLamports).toBe(SOL_LAMPORTS); // genuine amount, not the forged one
  });

  it("ignores an event emitted by a program CPI-nested inside pump.fun's frame boundary", () => {
    const attacker = bs58.encode(Buffer.alloc(32, 2));
    const tx = makeTx({ logs: [
      pumpInvoke,
      `Program ${attacker} invoke [2]`,
      pumpTradeEventLog(),                       // emitted while attacker is active
      `Program ${attacker} success`,
      `Program ${PUMP_PROGRAM} success`,
    ] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun")).toBeNull();
  });

  it("returns null when the tx failed on-chain", () => {
    const tx = makeTx({ logs: [pumpInvoke, pumpTradeEventLog()], err: { InstructionError: [0, "Custom"] } });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "pump_fun")).toBeNull();
  });
});

// ── Raydium LaunchLab ─────────────────────────────────────────────────────────

describe("extractDevBuyFromConfirmedTx — raydium_launchlab", () => {
  const buyLogs = [labInvoke, "Program log: Instruction: BuyExactIn", labTradeEventLog()];

  it("extracts exact event amounts when the creator's token delta matches", () => {
    const tx = makeTx({ logs: [...rentNoise, ...buyLogs] });
    const out = extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "raydium_launchlab");
    expect(out).not.toBeNull();
    expect(out!.solLamports).toBe(SOL_LAMPORTS);
    expect(out!.tokenBaseUnits).toBe(TOKEN_BASE);
  });

  it("returns null when the event token amount does not match the creator's delta (event belongs to another pool/mint)", () => {
    const tx = makeTx({ logs: buyLogs, tokenDelta: TOKEN_BASE - 1n });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "raydium_launchlab")).toBeNull();
  });

  it("returns null when the tokens went to someone other than the creator", () => {
    const tx = makeTx({ logs: buyLogs, tokenOwner: OTHER });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "raydium_launchlab")).toBeNull();
  });

  it("returns null when the tx contains only the create (no buy instruction/event)", () => {
    const tx = makeTx({ logs: [...rentNoise, labInvoke, "Program log: Instruction: CreateLaunchpad"] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "raydium_launchlab")).toBeNull();
  });

  it("ignores forged event + instruction logs from a foreign program (provenance)", () => {
    const attacker = bs58.encode(Buffer.alloc(32, 2));
    // Attacker forges BOTH the BuyExactIn instruction log and a TradeEvent
    // whose token amount matches the creator's real token delta, inside its
    // own scope. LaunchLab is invoked too but only creates (no buy).
    const tx = makeTx({ logs: [
      `Program ${attacker} invoke [1]`,
      "Program log: Instruction: BuyExactIn",
      labTradeEventLog(),                        // forged — outside LaunchLab scope
      `Program ${attacker} success`,
      labInvoke,
      "Program log: Instruction: Initialize",
      `Program ${LAB_PROGRAM} success`,
    ] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "raydium_launchlab")).toBeNull();
  });

  it("returns null when the LaunchLab program was never invoked", () => {
    const tx = makeTx({ logs: ["Program log: Instruction: BuyExactIn", labTradeEventLog()] });
    expect(extractDevBuyFromConfirmedTx(tx, MINT, CREATOR, "raydium_launchlab")).toBeNull();
  });
});
