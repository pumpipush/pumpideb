/**
 * launchlabDecode.ts — shared Borsh / Base58 decode utilities for Raydium LaunchLab.
 *
 * Imported by:
 *   • adapters/raydium-launchlab.ts  — real-time indexer
 *   • launchlabBackfill.ts           — historical backfill
 *   • enrichment.ts                  — background ???-token enrichment
 *
 * Centralising here means any fix to offset probing, validation regex, or decode
 * logic only needs to be made in one place.  Previously each file had its own
 * hand-rolled copy that could silently diverge.
 */

// ── Base58 ────────────────────────────────────────────────────────────────────

export const BS58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode raw bytes to a Base58 string (Solana public-key format).
 */
export function bs58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) { n = n * 256n + BigInt(b); }
  let result = "";
  while (n > 0n) {
    result = BS58_ALPHA[Number(n % 58n)]! + result;
    n /= 58n;
  }
  let leading = 0;
  for (const b of bytes) { if (b !== 0) break; leading++; }
  return "1".repeat(leading) + result;
}

/**
 * Decode a Base58-encoded string to a Uint8Array.
 * Handles leading '1' characters (zero bytes) correctly.
 */
export function bs58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = BS58_ALPHA.indexOf(c);
    if (i < 0) throw new Error(`bad base58 char: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let leading = 0;
  for (const c of s) { if (c !== "1") break; leading++; }
  return new Uint8Array([...new Array<number>(leading).fill(0), ...bytes]);
}

// ── Borsh ─────────────────────────────────────────────────────────────────────

/**
 * Read a Borsh-encoded string (u32-LE length prefix + UTF-8 bytes) from `buf`
 * at byte offset `off`.  Returns [string, nextOffset].
 */
export function readBorshStr(buf: Uint8Array, off: number): [string, number] {
  if (off + 4 > buf.length) throw new RangeError("borsh underflow (length)");
  const len = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, true);
  const end = off + 4 + len;
  if (end > buf.length) throw new RangeError("borsh underflow (string)");
  return [new TextDecoder().decode(buf.subarray(off + 4, end)), end];
}

// ── High-level instruction decoder ───────────────────────────────────────────

/** Control characters + Unicode replacement char — rejected from token names. */
const CTRL_RE = /[\x00-\x08\x0B\x0E-\x1F\x7F\uFFFD]/;

/**
 * Attempt to decode name / symbol / uri from raw LaunchLab createLaunchpad
 * instruction bytes.
 *
 * The Anchor/Borsh layout is:
 *   [8 disc][32 mintA][name][symbol][uri]…
 * but the exact starting offset of the string fields can vary across IDL
 * versions.  This function probes an expanded set of starting offsets so
 * tokens that failed the original 3-offset probe can still be resolved.
 *
 * Returns null if no valid (name, symbol) pair is found at any offset.
 */
export function decodeLabCreateParamsRaw(
  raw: Uint8Array,
): { name: string; symbol: string; uri: string } | null {
  // Expanded offset list: original [40, 8, 72] plus additional candidates.
  for (const startOff of [40, 8, 72, 0, 16, 24, 48, 56, 64, 80, 96, 104, 112]) {
    if (startOff + 8 > raw.length) continue;
    try {
      let off = startOff;
      const [name,   off1] = readBorshStr(raw, off); off = off1;
      const [symbol, off2] = readBorshStr(raw, off); off = off2;
      const [uri]          = readBorshStr(raw, off);

      const n = name.trim();
      const s = symbol.trim();
      if (!n || !s) continue;
      if (n.length > 64 || s.length > 16) continue;
      if (CTRL_RE.test(n) || CTRL_RE.test(s)) continue;

      return { name: n, symbol: s, uri: uri.trim() };
    } catch { continue; }
  }
  return null;
}
