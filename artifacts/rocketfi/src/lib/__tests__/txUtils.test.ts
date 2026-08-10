/**
 * Unit tests for simulateAndSend (txUtils.ts)
 *
 * Key invariant: sendTransaction must NEVER be called when simulation
 * reports an error. Verifies this with multiple failure scenarios and
 * confirms the happy path does call sendTransaction exactly once.
 *
 * Run with: pnpm --filter @workspace/rocketfi test
 */

import { describe, it, expect, vi } from "vitest";
import { simulateAndSend, TransactionSimulationError } from "../txUtils";
import type { Connection, Transaction, Keypair } from "@solana/web3.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConnection(simErr: unknown, simLogs: string[], sendSig = "fake-sig") {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({
      context: { slot: 100 },
      value: { err: simErr, logs: simLogs },
    }),
    sendTransaction: vi.fn().mockResolvedValue(sendSig),
  } as unknown as Connection;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("simulateAndSend", () => {
  it("throws TransactionSimulationError and does NOT call sendTransaction when simulation fails", async () => {
    const conn = makeConnection(
      { InstructionError: [0, "Custom"] },
      [
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
        "Program log: Error: insufficient funds for rent",
        "Program failed to complete",
      ],
    );

    await expect(
      simulateAndSend(conn, {} as Transaction, [] as Keypair[]),
    ).rejects.toThrow(TransactionSimulationError);

    expect(conn.sendTransaction).not.toHaveBeenCalled();
  });

  it("error message includes the most descriptive log line", async () => {
    const conn = makeConnection(
      { InstructionError: [0, "Custom"] },
      [
        "Program log: Instruction: Buy",
        "Program log: AnchorError: InsufficientFundsForFees",
      ],
    );

    const err = await simulateAndSend(conn, {} as Transaction, [] as Keypair[])
      .catch(e => e as Error);

    expect(err).toBeInstanceOf(TransactionSimulationError);
    expect(err.message).toMatch(/InsufficientFundsForFees/);
  });

  it("falls back to the last log line when no recognizable error pattern exists", async () => {
    const conn = makeConnection(
      { AccountNotFound: {} },
      ["Program log: something unexpected"],
    );

    const err = await simulateAndSend(conn, {} as Transaction, [] as Keypair[])
      .catch(e => e as Error);

    expect(err.message).toMatch(/something unexpected/);
    expect(conn.sendTransaction).not.toHaveBeenCalled();
  });

  it("returns signature and calls sendTransaction exactly once on successful simulation", async () => {
    const EXPECTED_SIG = "5xABC123realSignatureHere";
    const conn = makeConnection(null, ["Program log: success"], EXPECTED_SIG);

    const sig = await simulateAndSend(conn, {} as Transaction, [] as Keypair[]);

    expect(sig).toBe(EXPECTED_SIG);
    expect(conn.simulateTransaction).toHaveBeenCalledOnce();
    expect(conn.sendTransaction).toHaveBeenCalledOnce();
  });

  it("exposes raw logs on TransactionSimulationError for debugging", async () => {
    const logs = ["log A", "log B: Error: bad state"];
    const conn = makeConnection({ InstructionError: [0, "Custom"] }, logs);

    const err = await simulateAndSend(conn, {} as Transaction, [] as Keypair[])
      .catch(e => e as TransactionSimulationError);

    expect(err).toBeInstanceOf(TransactionSimulationError);
    expect(err.logs).toEqual(logs);
  });
});
