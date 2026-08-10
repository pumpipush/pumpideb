/**
 * raydiumUpload.smoke.test.ts
 *
 * Live smoke test for the Raydium IPFS upload endpoint.
 *
 * WHY THIS EXISTS
 * ---------------
 * _tryRaydiumUpload() in raydiumLauncher.ts hits an undocumented endpoint:
 *   https://launch-mint-v1.raydium.io/upload
 *
 * The response shape ({ uri?, url? }) is not part of any public API contract.
 * Raydium could silently change it, add authentication, or alter the Content-Type
 * requirements at any time. If that happens, every launch attempt would fail
 * with a cryptic error — and the pump.fun fallback would fire instead, with
 * no indication that the primary path is broken.
 *
 * This smoke test catches that before a real token launch attempt.
 *
 * WHAT IT DOES
 * ------------
 * 1. POSTs a 1×1 pixel PNG to /upload — verifies HTTP 2xx and that the
 *    response body contains a `uri` or `url` string field.
 * 2. POSTs a minimal metadata JSON blob to /upload — same shape check.
 * 3. GETs the returned metadata URI, retrying for a bounded propagation window,
 *    and fails the test if it never returns 2xx JSON with name/symbol fields.
 *    `ipfs:` URIs are resolved through an HTTP gateway before fetching.
 *
 * NO SDK INIT — this test does not load @raydium-io/raydium-sdk-v2.
 * It exercises only the HTTP upload path in raydiumLauncher.ts.
 *
 * HOW TO RUN
 * ----------
 * Full smoke run (hits the real Raydium endpoint):
 *   RUN_SMOKE_TESTS=1 pnpm --filter @workspace/rocketfi test:smoke
 *
 * Normal CI (skips this file, runs unit tests only):
 *   pnpm --filter @workspace/rocketfi test
 */

import { describe, it, expect } from "vitest";

// ── Guard ─────────────────────────────────────────────────────────────────────
// Skip the entire suite unless RUN_SMOKE_TESTS=1 is set so normal CI is fast.
const RUN = process.env.RUN_SMOKE_TESTS === "1";

// ── Constants ─────────────────────────────────────────────────────────────────

const UPLOAD_URL = "https://launch-mint-v1.raydium.io/upload";

/**
 * A valid 1×1 pixel PNG (red pixel, 67 bytes).
 * Using a real PNG ensures the endpoint's Content-Type validation, if any,
 * cannot silently reject our payload.
 */
const ONE_PX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

/** Minimal metadata fields — matches the shape built by _tryRaydiumUpload() */
const SMOKE_NAME   = "SmokeUploadTest";
const SMOKE_SYMBOL = "SMKUP";
const SMOKE_DESC   = "Automated smoke test — safe to ignore";

/**
 * IPFS HTTP gateway used to resolve ipfs:// URIs.
 * Raydium may return ipfs:// scheme URIs; Node fetch cannot handle that scheme
 * directly, so we rewrite them before fetching.
 */
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

/**
 * Maximum time to wait for IPFS propagation when checking whether the
 * returned metadata URI is reachable. We retry every RETRY_INTERVAL_MS
 * until the total elapsed time exceeds this value, then fail the test.
 */
const MAX_PROPAGATION_MS   = 20_000;
const RETRY_INTERVAL_MS    = 3_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Decode a base64 string to a Uint8Array (works in both Node and browser). */
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert an `ipfs://` URI to an HTTPS gateway URL that Node fetch can reach.
 * Passes through http:// and https:// URIs unchanged.
 * Throws on any other scheme so the test fails loudly rather than silently.
 */
function resolveToHttpUri(uri: string): string {
  if (uri.startsWith("https://") || uri.startsWith("http://")) return uri;
  if (uri.startsWith("ipfs://")) {
    // ipfs://<CID>[/path] → https://ipfs.io/ipfs/<CID>[/path]
    return IPFS_GATEWAY + uri.slice("ipfs://".length);
  }
  throw new Error(
    `Cannot fetch URI with unsupported scheme — got "${uri.slice(0, 80)}".\n` +
    "Only http://, https://, and ipfs:// are resolvable from a smoke test. " +
    "Update resolveToHttpUri() or the endpoint has changed.",
  );
}

/**
 * Sleep for `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the metadata URI with retry logic for IPFS propagation delays.
 *
 * Returns the parsed JSON body once it is a 2xx response containing non-empty
 * name and symbol fields. Throws — failing the test — if the bounded window
 * expires without a successful response.
 */
async function fetchMetadataWithRetry(
  rawUri: string,
): Promise<Record<string, unknown>> {
  const httpUri   = resolveToHttpUri(rawUri);
  const deadline  = Date.now() + MAX_PROPAGATION_MS;
  let   attempt   = 0;
  let   lastError = "";

  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(httpUri, {
        signal:  AbortSignal.timeout(8_000),
        headers: { "User-Agent": "RocketFi/1.0 SmokeTest" },
      });

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        console.warn(`[smoke] attempt ${attempt}: metadata URI returned ${res.status} — retrying`);
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any;
      try {
        parsed = await res.json();
      } catch {
        lastError = "non-JSON body";
        console.warn(`[smoke] attempt ${attempt}: metadata URI returned non-JSON — retrying`);
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      // Validate the required fields — mirrors _verifyMetadataReadable()
      if (typeof parsed.name !== "string" || !parsed.name.trim()) {
        lastError = `missing or empty 'name' field (got ${JSON.stringify(parsed.name)})`;
        // This is a content error, not a propagation delay — fail immediately.
        throw new Error(
          `Metadata URI ${rawUri} returned JSON missing a valid 'name' field: ` +
          JSON.stringify(parsed),
        );
      }
      if (typeof parsed.symbol !== "string" || !parsed.symbol.trim()) {
        lastError = `missing or empty 'symbol' field (got ${JSON.stringify(parsed.symbol)})`;
        throw new Error(
          `Metadata URI ${rawUri} returned JSON missing a valid 'symbol' field: ` +
          JSON.stringify(parsed),
        );
      }

      // All checks pass
      return parsed as Record<string, unknown>;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // Re-throw content validation failures immediately
      if (msg.startsWith("Metadata URI")) throw err;
      // Re-throw unsupported scheme errors immediately
      if (msg.startsWith("Cannot fetch URI")) throw err;
      // Network / timeout — retry
      lastError = msg;
      console.warn(`[smoke] attempt ${attempt}: fetch error — ${msg} — retrying`);
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  throw new Error(
    `Metadata URI "${rawUri}" was not reachable within ${MAX_PROPAGATION_MS / 1000}s ` +
    `(${attempt} attempts). Last error: ${lastError}`,
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe(
  "Raydium upload endpoint live smoke test (no SDK — hits real HTTPS endpoint)",
  { timeout: 60_000 },
  () => {

    // ── Skip notice for normal CI ───────────────────────────────────────────
    it("(tests below are skipped in normal CI — set RUN_SMOKE_TESTS=1 to run)", () => {
      if (RUN) return;
      // Passes immediately so the file is not flagged as empty in normal CI.
      expect(true).toBe(true);
    });

    // ── 1. Image upload ─────────────────────────────────────────────────────
    // One POST: check HTTP status and extract the image URI in a single request.
    let imageUri: string;

    it("POST 1×1 PNG to /upload returns HTTP 2xx and a valid uri/url string", async () => {
      if (!RUN) return;

      const pngBytes = base64ToUint8Array(ONE_PX_PNG_B64);
      const file     = new File([pngBytes], "smoke.png", { type: "image/png" });
      const form     = new FormData();
      form.append("file", file, "smoke.png");

      const res = await fetch(UPLOAD_URL, {
        method: "POST",
        body:   form,
        signal: AbortSignal.timeout(15_000),
      });

      expect(
        res.ok,
        `Expected HTTP 2xx from ${UPLOAD_URL} but got ${res.status}`,
      ).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = await res.json() as any;

      // Mirror the exact extraction logic in raydiumLauncher.ts:
      //   const imageUri = imgJson.uri ?? imgJson.url;
      imageUri = json.uri ?? json.url;

      expect(
        typeof imageUri,
        `Expected uri or url string in response but got: ${JSON.stringify(json)}`,
      ).toBe("string");

      expect(
        imageUri.length,
        `uri/url field is empty in response: ${JSON.stringify(json)}`,
      ).toBeGreaterThan(0);

      // Must be a valid, resolvable URI scheme
      const resolvedUri = resolveToHttpUri(imageUri); // throws on unknown scheme
      expect(resolvedUri).toBeTruthy();

      console.log(`[smoke] ✓ Image URI: ${imageUri}`);
    });

    // ── 2. Metadata upload ──────────────────────────────────────────────────
    // One POST: check HTTP status and extract the metadata URI in a single request.
    let metadataUri: string;

    it("POST minimal metadata JSON to /upload returns HTTP 2xx and a valid uri/url string", async () => {
      if (!RUN) return;

      // Use a dummy image URI if the image upload above did not assign one
      // (e.g. when running this test in isolation).
      const imgUri = imageUri ?? "https://example.com/placeholder.png";

      const metadata: Record<string, string> = {
        name:        SMOKE_NAME,
        symbol:      SMOKE_SYMBOL,
        description: SMOKE_DESC,
        image:       imgUri,
      };

      const blob = new Blob([JSON.stringify(metadata)], {
        type: "application/json",
      });
      const form = new FormData();
      form.append("file", blob, "metadata.json");

      const res = await fetch(UPLOAD_URL, {
        method: "POST",
        body:   form,
        signal: AbortSignal.timeout(15_000),
      });

      expect(
        res.ok,
        `Expected HTTP 2xx from metadata upload but got ${res.status}`,
      ).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = await res.json() as any;

      // Mirror the exact extraction logic in raydiumLauncher.ts:
      //   const uri = metaJson.uri ?? metaJson.url;
      metadataUri = json.uri ?? json.url;

      expect(
        typeof metadataUri,
        `Expected uri or url string in metadata response but got: ${JSON.stringify(json)}`,
      ).toBe("string");

      expect(
        metadataUri.length,
        `uri/url field is empty in metadata response: ${JSON.stringify(json)}`,
      ).toBeGreaterThan(0);

      // Must be a valid, resolvable URI scheme
      const resolvedUri = resolveToHttpUri(metadataUri); // throws on unknown scheme
      expect(resolvedUri).toBeTruthy();

      console.log(`[smoke] ✓ Metadata URI: ${metadataUri}`);
    });

    // ── 3. Metadata URI reachability ────────────────────────────────────────
    // Retry for a bounded propagation window, then fail hard if never reachable.
    it("returned metadata URI is reachable and contains valid JSON with name/symbol", async () => {
      if (!RUN) return;

      if (!metadataUri) {
        // Guard against running this test in isolation without the upload steps.
        throw new Error(
          "metadataUri is not set — run the full smoke suite, not this test alone.\n" +
          "The previous 'metadata upload' test must pass first to populate metadataUri.",
        );
      }

      // fetchMetadataWithRetry retries until MAX_PROPAGATION_MS, then throws —
      // failing this test if the URI is never reachable or the JSON is malformed.
      const parsed = await fetchMetadataWithRetry(metadataUri);

      // Assertions are also enforced inside fetchMetadataWithRetry, but we
      // repeat them here so vitest's assertion output names the exact field.
      expect(
        typeof parsed.name === "string" && (parsed.name as string).trim().length > 0,
        `'name' field missing or empty in returned metadata: ${JSON.stringify(parsed)}`,
      ).toBe(true);

      expect(
        typeof parsed.symbol === "string" && (parsed.symbol as string).trim().length > 0,
        `'symbol' field missing or empty in returned metadata: ${JSON.stringify(parsed)}`,
      ).toBe(true);

      console.log(
        `[smoke] ✓ Metadata URI reachable: ${metadataUri}\n` +
        `[smoke]   name="${parsed.name}"  symbol="${parsed.symbol}"`,
      );
    });
  },
);
