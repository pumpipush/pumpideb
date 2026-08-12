/**
 * Unit tests for decodeLabCreateParamsRaw.
 *
 * Covers:
 *   - Known-good payloads at each primary offset (40, 8, 72) decode correctly
 *   - Control characters, Unicode replacement char, and over-length strings are rejected
 *   - All-zero buffer returns null (no false positive on empty strings)
 *   - Empty / whitespace-only name or symbol returns null
 *   - Buffer too short for any probed offset returns null
 *   - Name and symbol are trimmed before validation
 */

import { describe, it, expect } from "vitest";
import { decodeLabCreateParamsRaw } from "./launchlabDecode";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Borsh-encode a UTF-8 string: 4-byte LE length prefix + raw bytes. */
function borshStr(s: string): Buffer {
  const bytes  = Buffer.from(s, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

/**
 * Build a payload with valid Borsh strings starting at `startOff`.
 *
 * Prefix bytes are set to 0xFF so any earlier-probed offset reads a length of
 * 0xFFFFFFFF (4 294 967 295) which exceeds the buffer size → RangeError →
 * caught → that offset is skipped automatically.  This isolates each test to
 * exactly one target offset without relying on the order of the probe list.
 */
function makeAt(startOff: number, name: string, symbol: string, uri: string): Uint8Array {
  const prefix  = Buffer.alloc(startOff, 0xff);
  const strings = Buffer.concat([borshStr(name), borshStr(symbol), borshStr(uri)]);
  return new Uint8Array(Buffer.concat([prefix, strings]));
}

// ── Offset probing ────────────────────────────────────────────────────────────

describe("decodeLabCreateParamsRaw — offset probing", () => {
  it("decodes a valid payload at offset 40 (most common IDL layout)", () => {
    const buf = makeAt(40, "RocketToken", "RCKT", "https://arweave.net/abc123");
    expect(decodeLabCreateParamsRaw(buf)).toEqual({
      name:   "RocketToken",
      symbol: "RCKT",
      uri:    "https://arweave.net/abc123",
    });
  });

  it("decodes a valid payload at offset 8 (second IDL layout)", () => {
    // At offset 40 the string content bytes produce a huge LE length → RangeError.
    const buf = makeAt(8, "MoonCoin", "MOON", "https://ipfs.io/Qmxyz");
    expect(decodeLabCreateParamsRaw(buf)).toEqual({
      name:   "MoonCoin",
      symbol: "MOON",
      uri:    "https://ipfs.io/Qmxyz",
    });
  });

  it("decodes a valid payload at offset 72 (third IDL layout)", () => {
    // 72 bytes of 0xFF → every probed offset below 72 throws RangeError.
    const buf = makeAt(72, "SolarFlare", "SOLAR", "https://cdn.example.com/meta.json");
    expect(decodeLabCreateParamsRaw(buf)).toEqual({
      name:   "SolarFlare",
      symbol: "SOLAR",
      uri:    "https://cdn.example.com/meta.json",
    });
  });

  it("trims surrounding whitespace from name and symbol before returning", () => {
    const buf = makeAt(40, "  SpaceCoin  ", "  SPCN  ", "https://uri.example.com");
    const result = decodeLabCreateParamsRaw(buf);
    expect(result?.name).toBe("SpaceCoin");
    expect(result?.symbol).toBe("SPCN");
  });

  it("returns the uri field even when it is empty (uri is not validated)", () => {
    const buf = makeAt(40, "ValidName", "SYM", "");
    const result = decodeLabCreateParamsRaw(buf);
    expect(result).not.toBeNull();
    expect(result?.uri).toBe("");
  });
});

// ── Rejection: empty / whitespace strings ─────────────────────────────────────

describe("decodeLabCreateParamsRaw — empty / whitespace rejection", () => {
  it("returns null for an all-zero buffer (every offset reads length 0 → empty name)", () => {
    // At every probed offset the LE length is 0 → name/symbol = "" → skipped.
    expect(decodeLabCreateParamsRaw(new Uint8Array(200))).toBeNull();
  });

  it("returns null when name is a zero-length Borsh string", () => {
    const buf = makeAt(40, "", "SYM", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("returns null when symbol is a zero-length Borsh string", () => {
    const buf = makeAt(40, "ValidName", "", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("returns null when name is whitespace-only (trims to empty)", () => {
    const buf = makeAt(40, "   ", "SYM", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("returns null for a buffer too short for any probed offset (< 8 bytes headroom)", () => {
    expect(decodeLabCreateParamsRaw(new Uint8Array(4))).toBeNull();
  });
});

// ── Rejection: control characters ────────────────────────────────────────────

describe("decodeLabCreateParamsRaw — control character rejection", () => {
  it("returns null when name contains a low control character (\\x01)", () => {
    const buf = makeAt(40, "Bad\x01Name", "SYM", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("returns null when name contains the NUL byte (\\x00)", () => {
    const buf = makeAt(40, "Na\x00me", "SYM", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("returns null when name contains the DEL control character (\\x7F)", () => {
    const buf = makeAt(40, "Name\x7F", "SYM", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("returns null when name contains the Unicode replacement character (U+FFFD)", () => {
    // U+FFFD is produced by lossy UTF-8 decoding of arbitrary binary bytes
    const buf = makeAt(40, "Bad\uFFFDName", "SYM", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("returns null when symbol contains a control character (\\x0F)", () => {
    const buf = makeAt(40, "GoodName", "BA\x0FD", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("returns null when symbol contains a shift-out character (\\x0E)", () => {
    // \x0E is in the rejected range \x0E-\x1F; \x0C (form-feed) is intentionally allowed
    const buf = makeAt(40, "GoodName", "SY\x0EM", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });
});

// ── Rejection: length limits ──────────────────────────────────────────────────

describe("decodeLabCreateParamsRaw — length-limit enforcement", () => {
  it("returns null when name is 65 characters (> 64 limit)", () => {
    const buf = makeAt(40, "A".repeat(65), "SYM", "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("accepts a name exactly 64 characters long (at boundary)", () => {
    const buf = makeAt(40, "A".repeat(64), "SYM", "https://uri.example.com");
    const result = decodeLabCreateParamsRaw(buf);
    expect(result).not.toBeNull();
    expect(result?.name).toHaveLength(64);
  });

  it("returns null when symbol is 17 characters (> 16 limit)", () => {
    const buf = makeAt(40, "ValidName", "X".repeat(17), "https://uri.example.com");
    expect(decodeLabCreateParamsRaw(buf)).toBeNull();
  });

  it("accepts a symbol exactly 16 characters long (at boundary)", () => {
    const buf = makeAt(40, "ValidName", "X".repeat(16), "https://uri.example.com");
    const result = decodeLabCreateParamsRaw(buf);
    expect(result).not.toBeNull();
    expect(result?.symbol).toHaveLength(16);
  });
});
