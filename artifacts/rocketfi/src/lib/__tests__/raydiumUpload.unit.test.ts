/**
 * raydiumUpload.unit.test.ts
 *
 * Unit tests for the Raydium IPFS upload path in raydiumLauncher.ts.
 *
 * PURPOSE
 * -------
 * The Raydium IPFS service (https://launch-mint-v1.raydium.io/upload) has an
 * undocumented response shape ({ uri?, url? }) that can change without notice.
 * These tests verify:
 *
 *   1. Happy path: reads uri from both image + metadata responses
 *   2. url fallback: reads url when uri is absent in the response
 *   3. uri preferred: uri wins when both uri and url are present
 *   4. HTTP errors: falls back to pump.fun IPFS with a clear status-code message
 *   5. Missing uri+url: falls back to pump.fun IPFS (clearly named error)
 *   6. Metadata readback (_verifyMetadataReadable):
 *        - fails-open on network errors (IPFS propagation delay)
 *        - fails-open on non-200 HTTP (CDN not yet populated)
 *        - fails-closed (falls back to pump.fun) when name/symbol fields are missing
 *        - empty-string name/symbol is treated as missing
 *
 * All network calls are mocked — no real endpoints are hit.
 *
 * HOW TO RUN
 * ----------
 *   pnpm --filter @workspace/rocketfi test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadToRaydiumIpfs } from "../raydiumLauncher";
import { uploadToPumpFunIpfs } from "../pumpfunLauncher";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock pumpfunLauncher so the fallback path is observable without network calls.
vi.mock("../pumpfunLauncher", () => ({
  uploadToPumpFunIpfs: vi.fn(),
}));

// The upload functions don't use the Solana connection, but raydiumLauncher.ts
// imports it at the module level — mock so the module loads without errors.
vi.mock("../solanaConnection", () => ({
  getConnection: vi.fn().mockReturnValue({
    getLatestBlockhash: vi.fn(),
    simulateTransaction: vi.fn(),
  }),
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const RAYDIUM_UPLOAD_URL = "https://launch-mint-v1.raydium.io/upload";
const CDN_IMAGE          = "https://cdn.raydium.io/image/abc123.png";
const CDN_META           = "https://cdn.raydium.io/metadata/abc123.json";
const PUMPFUN_URI        = "https://ipfs.io/ipfs/QmPumpFunFallback";

const VALID_PARAMS = {
  name:        "TestToken",
  symbol:      "TEST",
  description: "A test token for unit tests",
  image:       new File(["fake-image-data"], "test.png", { type: "image/png" }),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal fetch response: 2xx success with a JSON body */
function ok(body: unknown) {
  return {
    ok:     true,
    status: 200,
    json:   () => Promise.resolve(body),
  };
}

/** Minimal fetch response: HTTP error */
function err(status: number) {
  return {
    ok:     false,
    status,
    json:   () => Promise.resolve({}),
  };
}

// ── Shared test fixtures ───────────────────────────────────────────────────────

const pumpFunMock = vi.mocked(uploadToPumpFunIpfs);
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  // Default: pump.fun fallback always succeeds (individual tests can override)
  pumpFunMock.mockResolvedValue(PUMPFUN_URI);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1. Response shape — uri field ────────────────────────────────────────────

describe("uploadToRaydiumIpfs() — uri field in response", () => {
  it("happy path: returns metadata uri when both uploads succeed", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))  // image upload
      .mockResolvedValueOnce(ok({ uri: CDN_META }))   // metadata upload
      .mockResolvedValueOnce(ok({ name: "TestToken", symbol: "TEST" })); // readback

    const result = await uploadToRaydiumIpfs(VALID_PARAMS);

    expect(result).toBe(CDN_META);
    // Both uploads must target the Raydium endpoint (not pump.fun)
    const raydiumCalls = mockFetch.mock.calls.filter(([url]) => url === RAYDIUM_UPLOAD_URL);
    expect(raydiumCalls).toHaveLength(2);
    expect(pumpFunMock).not.toHaveBeenCalled();
  });

  it("metadata sent to Raydium includes name, symbol, description, and image URI", async () => {
    const paramsWithLinks = {
      ...VALID_PARAMS,
      twitter:  "https://twitter.com/test",
      telegram: "https://t.me/test",
      website:  "https://test.io",
    };

    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockResolvedValueOnce(ok({ name: "TestToken", symbol: "TEST" }));

    await uploadToRaydiumIpfs(paramsWithLinks);

    // The metadata upload is the second call — inspect its body
    const metaCallBody = mockFetch.mock.calls[1][1]?.body as FormData;
    expect(metaCallBody).toBeTruthy();
    // FormData.get() returns the Blob; convert to text to inspect JSON
    const blob   = metaCallBody.get("file") as Blob;
    const parsed = JSON.parse(await blob.text());
    expect(parsed.name).toBe("TestToken");
    expect(parsed.symbol).toBe("TEST");
    expect(parsed.image).toBe(CDN_IMAGE);
    expect(parsed.twitter).toBe("https://twitter.com/test");
    expect(parsed.telegram).toBe("https://t.me/test");
    expect(parsed.website).toBe("https://test.io");
    expect(parsed.external_url).toBe("https://test.io");
  });
});

// ── 2. Response shape — url fallback ─────────────────────────────────────────

describe("uploadToRaydiumIpfs() — url field fallback", () => {
  it("reads url when uri is absent in the image response", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ url: CDN_IMAGE }))  // image: url only
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockResolvedValueOnce(ok({ name: "TestToken", symbol: "TEST" }));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(CDN_META);
  });

  it("reads url when uri is absent in the metadata response", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ url: CDN_META }))   // metadata: url only
      .mockResolvedValueOnce(ok({ name: "TestToken", symbol: "TEST" }));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(CDN_META);
  });

  it("reads url when both responses use only the url field", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ url: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ url: CDN_META }))
      .mockResolvedValueOnce(ok({ name: "TestToken", symbol: "TEST" }));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(CDN_META);
  });

  it("uri is preferred over url when both fields are present", async () => {
    const ALT = "https://cdn.raydium.io/alt.json";
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE, url: "https://cdn.raydium.io/alt.png" }))
      .mockResolvedValueOnce(ok({ uri: CDN_META, url: ALT }))
      .mockResolvedValueOnce(ok({ name: "TestToken", symbol: "TEST" }));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(CDN_META);
  });
});

// ── 3. HTTP error handling ────────────────────────────────────────────────────

describe("uploadToRaydiumIpfs() — HTTP errors", () => {
  it("HTTP 429 on image upload: falls back to pump.fun IPFS", async () => {
    mockFetch.mockResolvedValueOnce(err(429));

    const result = await uploadToRaydiumIpfs(VALID_PARAMS);

    expect(result).toBe(PUMPFUN_URI);
    expect(pumpFunMock).toHaveBeenCalledOnce();
  });

  it("HTTP 500 on metadata upload: falls back to pump.fun IPFS", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(err(500));

    const result = await uploadToRaydiumIpfs(VALID_PARAMS);

    expect(result).toBe(PUMPFUN_URI);
    expect(pumpFunMock).toHaveBeenCalledOnce();
  });

  it("HTTP 503 on image upload: falls back to pump.fun IPFS", async () => {
    mockFetch.mockResolvedValueOnce(err(503));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(PUMPFUN_URI);
  });

  it("error propagates when both Raydium and pump.fun fallback fail", async () => {
    mockFetch.mockResolvedValueOnce(err(429));
    pumpFunMock.mockRejectedValueOnce(new Error("pump.fun also unavailable"));

    await expect(uploadToRaydiumIpfs(VALID_PARAMS))
      .rejects.toThrow(/pump\.fun also unavailable/);
  });
});

// ── 4. Missing uri + url in response ──────────────────────────────────────────

describe("uploadToRaydiumIpfs() — missing uri and url fields", () => {
  it("missing uri+url in image response: falls back to pump.fun IPFS", async () => {
    mockFetch.mockResolvedValueOnce(ok({ message: "ok", code: 0 })); // no uri/url

    const result = await uploadToRaydiumIpfs(VALID_PARAMS);

    expect(result).toBe(PUMPFUN_URI);
    expect(pumpFunMock).toHaveBeenCalledOnce();
  });

  it("missing uri+url in metadata response: falls back to pump.fun IPFS", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ message: "ok" })); // metadata: no uri/url

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(PUMPFUN_URI);
    expect(pumpFunMock).toHaveBeenCalledOnce();
  });

  it("null uri and null url in metadata response: falls back to pump.fun IPFS", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: null, url: null }));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(PUMPFUN_URI);
  });

  it("empty-string uri and url in metadata response: falls back to pump.fun IPFS", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: "", url: "" }));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(PUMPFUN_URI);
  });
});

// ── 5. Metadata readback (_verifyMetadataReadable) ────────────────────────────

describe("uploadToRaydiumIpfs() — metadata readback validation", () => {
  // Fail-open cases: the upload itself succeeds even if readback fails

  it("fails-open when readback returns 404 (IPFS not yet propagated)", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockResolvedValueOnce(err(404)); // readback: propagation delay

    const result = await uploadToRaydiumIpfs(VALID_PARAMS);
    expect(result).toBe(CDN_META); // must not block on propagation delay
    expect(pumpFunMock).not.toHaveBeenCalled();
  });

  it("fails-open when readback throws a network error", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch")); // network error

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(CDN_META);
    expect(pumpFunMock).not.toHaveBeenCalled();
  });

  it("fails-open when readback throws an AbortError (timeout)", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockRejectedValueOnce(Object.assign(new Error("Aborted"), { name: "AbortError" }));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(CDN_META);
    expect(pumpFunMock).not.toHaveBeenCalled();
  });

  // Fail-closed cases: malformed metadata → fall back to pump.fun

  it("falls back to pump.fun when readback JSON is missing the name field", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockResolvedValueOnce(ok({ symbol: "TEST" })); // name missing

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(PUMPFUN_URI);
    expect(pumpFunMock).toHaveBeenCalledOnce();
  });

  it("falls back to pump.fun when readback JSON is missing the symbol field", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockResolvedValueOnce(ok({ name: "TestToken" })); // symbol missing

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(PUMPFUN_URI);
    expect(pumpFunMock).toHaveBeenCalledOnce();
  });

  it("falls back to pump.fun when name is a blank string (whitespace only)", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockResolvedValueOnce(ok({ name: "   ", symbol: "TEST" }));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(PUMPFUN_URI);
  });

  it("falls back to pump.fun when symbol is a blank string (whitespace only)", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockResolvedValueOnce(ok({ name: "TestToken", symbol: " " }));

    expect(await uploadToRaydiumIpfs(VALID_PARAMS)).toBe(PUMPFUN_URI);
  });

  it("accepts valid metadata with all required fields present", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ uri: CDN_IMAGE }))
      .mockResolvedValueOnce(ok({ uri: CDN_META }))
      .mockResolvedValueOnce(ok({
        name:   "TestToken",
        symbol: "TEST",
        image:  CDN_IMAGE,
        description: "A test token",
      }));

    const result = await uploadToRaydiumIpfs(VALID_PARAMS);
    expect(result).toBe(CDN_META);
    expect(pumpFunMock).not.toHaveBeenCalled();
  });
});
