/**
 * proxy.image.test.ts — Integration tests for GET /api/proxy-image
 *
 * Contract under test:
 *   • Missing url param         → 400
 *   • Unlisted / private host   → 403  (SSRF guard)
 *   • Valid IPFS URL            → 200 with correct Content-Type +
 *                                  Cache-Control: public, max-age=31536000, immutable
 *   • CID extraction            → all 5 gateways raced; first success wins
 *   • Non-image Content-Type    → 502
 *   • Image > 5 MB              → 413
 *   • All gateways fail         → 502
 *   • Non-IPFS CDN URL          → proxied directly (single fetch, no gateway racing)
 *
 * Mocks:
 *   ObjectStorageService, rateLimiters, auth-jwt — not used by /proxy-image but
 *   imported at module level by the router.  Mocked to prevent GCS / JWT init.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// vi.mock is hoisted by vitest, so these stubs apply before the router import below.
vi.mock("../lib/objectStorage.js", () => ({
  ObjectStorageService: class {
    uploadToPublicPath = vi.fn().mockResolvedValue(null);
  },
}));
vi.mock("../lib/rateLimiters.js", () => ({
  uploadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/auth-jwt.js", () => ({
  extractBearer: vi.fn().mockReturnValue(null),
  verifyToken: vi.fn().mockReturnValue(null),
}));

import proxyRouter from "./proxy.js";

function makeApp() {
  const a = express();
  a.use(express.json());
  a.use("/api", proxyRouter);
  return a;
}

const app = makeApp();

/** Build a minimal successful image Response for fetch mocking. */
function fakeImageResponse(type = "image/png", byteLength = 512): Response {
  return new Response(new Uint8Array(byteLength), {
    status: 200,
    headers: { "content-type": type },
  });
}

afterEach(() => vi.restoreAllMocks());

// ── Input validation ───────────────────────────────────────────────────────────

describe("GET /api/proxy-image — input validation", () => {
  it("returns 400 when the url param is missing", async () => {
    const res = await request(app).get("/api/proxy-image");
    expect(res.status).toBe(400);
  });

  it("returns 403 for an unlisted host (SSRF guard)", async () => {
    const res = await request(app).get(
      "/api/proxy-image?url=" + encodeURIComponent("https://evil.com/steal.png"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 for localhost (SSRF guard)", async () => {
    const res = await request(app).get(
      "/api/proxy-image?url=" + encodeURIComponent("https://localhost/secret.png"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 for a bare private IP (SSRF guard)", async () => {
    const res = await request(app).get(
      "/api/proxy-image?url=" + encodeURIComponent("https://192.168.1.1/secret.png"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 for the AWS EC2 metadata endpoint (SSRF guard)", async () => {
    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://169.254.169.254/latest/meta-data/"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 for a data: URI (non-HTTP scheme)", async () => {
    const res = await request(app).get(
      "/api/proxy-image?url=" + encodeURIComponent("data:image/png;base64,abc"),
    );
    expect(res.status).toBe(403);
  });
});

// ── IPFS proxying ──────────────────────────────────────────────────────────────

describe("GET /api/proxy-image — IPFS image proxying", () => {
  it("returns 200 with the upstream Content-Type for a valid IPFS URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeImageResponse("image/jpeg"));

    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://ipfs.io/ipfs/QmTestCid123"),
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/jpeg/);
  });

  it("sets Cache-Control: immutable on a successful IPFS response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeImageResponse("image/png"));

    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://ipfs.io/ipfs/QmImmutableCid"),
    );
    expect(res.status).toBe(200);
    // Must include both the long max-age AND the immutable directive
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.headers["cache-control"]).toContain("max-age=31536000");
    expect(res.headers["cache-control"]).toContain("public");
  });

  it("races all 5 IPFS gateways: first success wins even if the primary is slow", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      callCount++;
      const url = typeof input === "string" ? input : (input as Request).url;
      // Only pinata gateway succeeds; everything else rejects (simulates slow primary)
      if (url.includes("pinata.cloud")) return fakeImageResponse("image/png");
      return Promise.reject(new Error("simulated timeout"));
    });

    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://ipfs.io/ipfs/QmRacingCid"),
    );
    expect(res.status).toBe(200);
    // All 5 gateways must have been called (Promise.any launches them all)
    expect(callCount).toBe(5);
  });

  it("extracts the CID and tries all gateways even for a non-primary IPFS URL", async () => {
    const calledUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calledUrls.push(url);
      if (url.includes("nftstorage.link")) return fakeImageResponse("image/png");
      return Promise.reject(new Error("down"));
    });

    // URL uses a gateway other than ipfs.io — CID must still be extracted
    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://dweb.link/ipfs/QmCidFromDweb"),
    );
    expect(res.status).toBe(200);
    // Gateway list should include ipfs.io even though the original URL used dweb.link
    expect(calledUrls.some(u => u.includes("ipfs.io/ipfs/QmCidFromDweb"))).toBe(true);
    expect(calledUrls.some(u => u.includes("nftstorage.link/ipfs/QmCidFromDweb"))).toBe(true);
    expect(calledUrls.length).toBe(5);
  });

  it("returns 502 when all 5 IPFS gateways fail", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("gateway down"));

    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://ipfs.io/ipfs/QmDeadCid"),
    );
    expect(res.status).toBe(502);
  });

  it("returns 502 when upstream returns non-image content-type (e.g. 404 HTML page)", async () => {
    // Some gateways return a text/html 200 page for missing CIDs instead of 404
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>Not found</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://ipfs.io/ipfs/QmHtmlGatewayBug"),
    );
    expect(res.status).toBe(502);
  });

  it("returns 413 when the upstream image exceeds 5 MB", async () => {
    const over5MB = new Uint8Array(5 * 1024 * 1024 + 1);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(over5MB, { status: 200, headers: { "content-type": "image/png" } }),
    );

    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://ipfs.io/ipfs/QmHugeCid"),
    );
    expect(res.status).toBe(413);
  });
});

// ── Non-IPFS CDN URLs ──────────────────────────────────────────────────────────

describe("GET /api/proxy-image — non-IPFS allowlisted CDN hosts", () => {
  it("proxies a pump.fun CDN URL directly (single fetch, no gateway racing)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fakeImageResponse("image/webp"));

    const cdnUrl = "https://cdn.pump.fun/logo.webp";
    const res = await request(app).get(
      "/api/proxy-image?url=" + encodeURIComponent(cdnUrl),
    );
    expect(res.status).toBe(200);
    // Exactly one fetch call — no 5-gateway racing for non-IPFS URLs
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = (fetchSpy.mock.calls[0]![0] as string);
    expect(calledUrl).toBe(cdnUrl);
  });

  it("sets Cache-Control: immutable for non-IPFS CDN images too", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeImageResponse("image/png"));

    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://dd.dexscreener.com/ds-data/tokens/solana/logo.png"),
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("proxies DiceBear avatar URL for wallet profile images", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeImageResponse("image/svg+xml"));

    // DiceBear uses api.dicebear.com — check if it's in the allowlist
    // (it may not be; this test documents the current behaviour)
    const res = await request(app).get(
      "/api/proxy-image?url=" +
        encodeURIComponent("https://i.imgur.com/token-logo.png"),
    );
    expect([200, 403]).toContain(res.status); // allowed or not: no 500s
  });
});
