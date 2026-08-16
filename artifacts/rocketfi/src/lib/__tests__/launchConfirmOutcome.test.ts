import { describe, it, expect } from "vitest";
import { classifyLaunchConfirmOutcome } from "../launchConfirmOutcome";

const LVBH = 1_000;

describe("classifyLaunchConfirmOutcome", () => {
  it("confirmed / finalized status → confirmed", () => {
    expect(classifyLaunchConfirmOutcome({
      status: { err: null, confirmationStatus: "confirmed" },
      currentBlockHeight: 900, lastValidBlockHeight: LVBH,
    })).toBe("confirmed");
    expect(classifyLaunchConfirmOutcome({
      status: { err: null, confirmationStatus: "finalized" },
      currentBlockHeight: 2_000, lastValidBlockHeight: LVBH,
    })).toBe("confirmed");
  });

  it("on-chain error → not_landed (conclusive failure)", () => {
    expect(classifyLaunchConfirmOutcome({
      status: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" },
      currentBlockHeight: 900, lastValidBlockHeight: LVBH,
    })).toBe("not_landed");
  });

  it("null status with expired validity window → not_landed (conclusive expiry)", () => {
    expect(classifyLaunchConfirmOutcome({
      status: null, currentBlockHeight: LVBH + 1, lastValidBlockHeight: LVBH,
    })).toBe("not_landed");
  });

  it("null status with window still open → unknown", () => {
    expect(classifyLaunchConfirmOutcome({
      status: null, currentBlockHeight: LVBH - 10, lastValidBlockHeight: LVBH,
    })).toBe("unknown");
    expect(classifyLaunchConfirmOutcome({
      status: null, currentBlockHeight: LVBH, lastValidBlockHeight: LVBH,
    })).toBe("unknown");
  });

  it("null status but block-height lookup failed → unknown", () => {
    expect(classifyLaunchConfirmOutcome({
      status: null, currentBlockHeight: null, lastValidBlockHeight: LVBH,
    })).toBe("unknown");
  });

  it("processed status → unknown (may still confirm), even after window closes", () => {
    expect(classifyLaunchConfirmOutcome({
      status: { err: null, confirmationStatus: "processed" },
      currentBlockHeight: LVBH + 100, lastValidBlockHeight: LVBH,
    })).toBe("unknown");
  });

  it("status lookup failure (undefined) → unknown", () => {
    expect(classifyLaunchConfirmOutcome({
      status: undefined, currentBlockHeight: LVBH + 100, lastValidBlockHeight: LVBH,
    })).toBe("unknown");
  });

  it("missing confirmationStatus with no error → unknown", () => {
    expect(classifyLaunchConfirmOutcome({
      status: { err: null }, currentBlockHeight: LVBH + 100, lastValidBlockHeight: LVBH,
    })).toBe("unknown");
  });
});
