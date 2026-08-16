/**
 * pumpfunUpload.smoke.test.ts
 *
 * Live smoke test for the pump.fun IPFS upload endpoint (fallback path).
 *
 * WHY THIS EXISTS
 * ---------------
 * uploadToPumpFunIpfs() in pumpfunLauncher.ts is the fallback when the
 * Raydium upload endpoint is unavailable. It POSTs a single multipart form
 * to https://pump.fun/api/ipfs containing the image + all metadata fields
 * and expects a JSON response with a `metadataUri` string.
 *
 * If pump.fun silently changes the endpoint URL, required fields, or response
 * shape, every token launch attempt that reaches the fallback would fail with
 * a cryptic error and no indication of which step broke.
 *
 * This smoke test catches that breakage before a real launch attempt.
 *
 * WHAT IT DOES
 * ------------
 * 1. POSTs a 1×1 pixel PNG + minimal metadata fields to /api/ipfs in a single
 *    multipart request — mirrors the exact FormData shape in uploadToPumpFunIpfs().
 * 2. Verifies the response is HTTP 2xx and contains a non-empty `metadataUri` string.
 * 3. GETs the returned metadataUri, retrying for a bounded propagation window,
 *    and fails the test if it never returns 2xx JSON with name/symbol fields.
 *    `ipfs:` URIs are resolved through an HTTP gateway before fetching.
 *
 * HOW TO RUN
 * ----------
 * Full smoke run (hits the real pump.fun endpoint):
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

const UPLOAD_URL = "https://pump.fun/api/ipfs";

/**
 * A valid 1×1 pixel PNG (red pixel, 67 bytes).
 * Using a real PNG ensures any Content-Type validation on the endpoint
 * cannot silently reject the payload.
 */
const ONE_PX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

/** Minimal metadata fields — matches the shape built by uploadToPumpFunIpfs() */
const SMOKE_NAME   = "SmokeUploadTest";
const SMOKE_SYMBOL = "SMKUP";
const SMOKE_DESC   = "Automated smoke test — safe to ignore";

/**
 * IPFS HTTP gateway used to resolve ipfs:// URIs.
 * pump.fun may return ipfs:// scheme URIs; Node fetch cannot handle that scheme
 * directly, so we rewrite them before fetching.
 */
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

/**
 * Maximum time to wait for IPFS propagation when checking whether the
 * returned metadataUri is reachable. We retry every RETRY_INTERVAL_MS
 * until the total elapsed time exceeds this value, then fail the test.
 */
const MAX_PROPAGATION_MS = 20_000;
const RETRY_INTERVAL_MS  = 3_000;

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

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the metadataUri with retry logic for IPFS propagation delays.
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
        headers: { "User-Agent": "Pumpi/1.0 SmokeTest" },
      });

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        console.warn(`[smoke] attempt ${attempt}: metadataUri returned ${res.status} — retrying`);
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any;
      try {
        parsed = await res.json();
      } catch {
        lastError = "non-JSON body";
        console.warn(`[smoke] attempt ${attempt}: metadataUri returned non-JSON — retrying`);
        await sleep(RETRY_INTERVAL_MS);
        continue;
      }

      // Validate the required fields expected by buildPumpFunCreateTx()
      if (typeof parsed.name !== "string" || !parsed.name.trim()) {
        lastError = `missing or empty 'name' field (got ${JSON.stringify(parsed.name)})`;
        // Content error — not a propagation delay — fail immediately.
        throw new Error(
          `metadataUri ${rawUri} returned JSON missing a valid 'name' field: ` +
          JSON.stringify(parsed),
        );
      }
      if (typeof parsed.symbol !== "string" || !parsed.symbol.trim()) {
        lastError = `missing or empty 'symbol' field (got ${JSON.stringify(parsed.symbol)})`;
        throw new Error(
          `metadataUri ${rawUri} returned JSON missing a valid 'symbol' field: ` +
          JSON.stringify(parsed),
        );
      }

      // All checks pass
      return parsed as Record<string, unknown>;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // Re-throw content validation failures immediately
      if (msg.startsWith("metadataUri")) throw err;
      // Re-throw unsupported scheme errors immediately
      if (msg.startsWith("Cannot fetch URI")) throw err;
      // Network / timeout — retry
      lastError = msg;
      console.warn(`[smoke] attempt ${attempt}: fetch error — ${msg} — retrying`);
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  throw new Error(
    `metadataUri "${rawUri}" was not reachable within ${MAX_PROPAGATION_MS / 1000}s ` +
    `(${attempt} attempts). Last error: ${lastError}`,
  );
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe(
  "pump.fun IPFS upload endpoint live smoke test (fallback path — hits real HTTPS endpoint)",
  { timeout: 60_000 },
  () => {

    // ── Skip notice for normal CI ───────────────────────────────────────────
    it("(tests below are skipped in normal CI — set RUN_SMOKE_TESTS=1 to run)", () => {
      if (RUN) return;
      // Passes immediately so the file is not flagged as empty in normal CI.
      expect(true).toBe(true);
    });

    // ── 1. Upload + response shape ──────────────────────────────────────────
    // Single POST mirrors the exact FormData shape in uploadToPumpFunIpfs().
    // pump.fun bundles image + metadata in one multipart request (unlike Raydium
    // which requires two separate uploads).
    let metadataUri: string;

    it(
      "POST 1×1 PNG + metadata fields to /api/ipfs returns HTTP 2xx and a non-empty metadataUri",
      async () => {
        if (!RUN) return;

        const pngBytes = base64ToUint8Array(ONE_PX_PNG_B64);
        // Use File so the multipart boundary includes the filename, matching
        // exactly how uploadToPumpFunIpfs() appends the user's image.
        const file = new File([pngBytes], "smoke.png", { type: "image/png" });

        // Mirror the exact FormData construction in uploadToPumpFunIpfs():
        //   body.append("name",        fields.name);
        //   body.append("symbol",      fields.symbol);
        //   body.append("description", fields.description);
        //   body.append("showName",    "true");
        //   body.append("file", fields.image, fields.image.name);
        const form = new FormData();
        form.append("name",        SMOKE_NAME);
        form.append("symbol",      SMOKE_SYMBOL);
        form.append("description", SMOKE_DESC);
        form.append("showName",    "true");
        form.append("file",        file, file.name);

        const res = await fetch(UPLOAD_URL, {
          method: "POST",
          body:   form,
          signal: AbortSignal.timeout(20_000),
        });

        expect(
          res.ok,
          `Expected HTTP 2xx from ${UPLOAD_URL} but got ${res.status}`,
        ).toBe(true);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = await res.json() as any;

        // Mirror the exact extraction logic in uploadToPumpFunIpfs():
        //   const data = await res.json() as { metadataUri?: string; ... };
        //   if (!data.metadataUri) throw new Error(...)
        metadataUri = json.metadataUri;

        expect(
          typeof metadataUri,
          `Expected 'metadataUri' string in response but got: ${JSON.stringify(json)}`,
        ).toBe("string");

        expect(
          metadataUri.length,
          `'metadataUri' field is empty in response: ${JSON.stringify(json)}`,
        ).toBeGreaterThan(0);

        // Must be a valid, resolvable URI scheme (https:// or ipfs://)
        const resolvedUri = resolveToHttpUri(metadataUri); // throws on unknown scheme
        expect(resolvedUri).toBeTruthy();

        console.log(`[smoke] ✓ metadataUri: ${metadataUri}`);
      },
    );

    // ── 2. Metadata URI reachability ────────────────────────────────────────
    // Retry for a bounded propagation window, then fail hard if never reachable.
    it("returned metadataUri is reachable and contains valid JSON with name/symbol", async () => {
      if (!RUN) return;

      if (!metadataUri) {
        // Guard against running this test in isolation without the upload step.
        throw new Error(
          "metadataUri is not set — run the full smoke suite, not this test alone.\n" +
          "The previous 'POST ... /api/ipfs' test must pass first to populate metadataUri.",
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
        `[smoke] ✓ metadataUri reachable: ${metadataUri}\n` +
        `[smoke]   name="${parsed.name}"  symbol="${parsed.symbol}"`,
      );
    });
  },
);
