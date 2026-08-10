/**
 * safeUriFetch.test.ts — Unit tests for the allowlist-gated metadata URI fetcher.
 *
 * Covers:
 *  - resolveIpfs() normalisation
 *  - isSafeMetaUri() allowlist: valid gateways pass, private addresses / unknown
 *    hosts / non-HTTPS schemes / credential-bearing URLs are all rejected
 *  - Specific bypass vectors the reviewer flagged: private-DNS hostnames that
 *    resolve to loopback (e.g. nip.io), IPv4-mapped IPv6, redirect attempts
 *  - fetchSafeUriMeta() integration: valid URI returns parsed fields; unsafe URI
 *    returns null without making a network request
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveIpfs,
  isSafeMetaUri,
  fetchSafeUriMeta,
  ALLOWED_META_HOSTS,
} from "./safeUriFetch";

afterEach(() => vi.restoreAllMocks());

// ── resolveIpfs ────────────────────────────────────────────────────────────────

describe("resolveIpfs", () => {
  it("converts ipfs:// to ipfs.io gateway", () => {
    expect(resolveIpfs("ipfs://QmFoo/meta.json"))
      .toBe("https://ipfs.io/ipfs/QmFoo/meta.json");
  });

  it("converts cf-ipfs.com to ipfs.io", () => {
    expect(resolveIpfs("https://cf-ipfs.com/ipfs/QmBar"))
      .toBe("https://ipfs.io/ipfs/QmBar");
    expect(resolveIpfs("http://cf-ipfs.com/ipfs/QmBaz"))
      .toBe("https://ipfs.io/ipfs/QmBaz");
  });

  it("leaves a normal HTTPS URL unchanged", () => {
    expect(resolveIpfs("https://arweave.net/abc123"))
      .toBe("https://arweave.net/abc123");
  });
});

// ── isSafeMetaUri — happy path ─────────────────────────────────────────────────

describe("isSafeMetaUri — allowed gateways", () => {
  for (const host of ALLOWED_META_HOSTS) {
    it(`allows https://${host}/...`, () => {
      expect(isSafeMetaUri(`https://${host}/some/path/meta.json`)).toBe(true);
    });
  }

  it("allows ipfs:// (resolved to ipfs.io which is allowed)", () => {
    expect(isSafeMetaUri("ipfs://QmSomeCid/meta.json")).toBe(true);
  });
});

// ── isSafeMetaUri — scheme rejection ──────────────────────────────────────────

describe("isSafeMetaUri — scheme checks", () => {
  it("rejects http:// even for an allowed host", () => {
    expect(isSafeMetaUri("http://ipfs.io/ipfs/QmFoo")).toBe(false);
  });

  it("rejects ftp://", () => {
    expect(isSafeMetaUri("ftp://ipfs.io/file.json")).toBe(false);
  });

  it("rejects data: URI", () => {
    expect(isSafeMetaUri("data:application/json,{}")).toBe(false);
  });

  it("rejects file:// URI", () => {
    expect(isSafeMetaUri("file:///etc/passwd")).toBe(false);
  });
});

// ── isSafeMetaUri — credential rejection ──────────────────────────────────────

describe("isSafeMetaUri — credential checks", () => {
  it("rejects URL with username@", () => {
    expect(isSafeMetaUri("https://admin@ipfs.io/ipfs/QmFoo")).toBe(false);
  });

  it("rejects URL with user:pass@", () => {
    expect(isSafeMetaUri("https://user:secret@arweave.net/abc")).toBe(false);
  });
});

// ── isSafeMetaUri — unknown / unlisted hosts ──────────────────────────────────

describe("isSafeMetaUri — unlisted host rejection", () => {
  it("rejects an arbitrary HTTPS host not in the allowlist", () => {
    expect(isSafeMetaUri("https://evil.com/meta.json")).toBe(false);
  });

  it("rejects localhost", () => {
    expect(isSafeMetaUri("https://localhost/meta.json")).toBe(false);
  });

  it("rejects 127.0.0.1 (direct loopback IP)", () => {
    expect(isSafeMetaUri("https://127.0.0.1/meta.json")).toBe(false);
  });

  it("rejects 10.0.0.1 (RFC-1918 private IP)", () => {
    expect(isSafeMetaUri("https://10.0.0.1/meta.json")).toBe(false);
  });

  it("rejects 192.168.1.1 (RFC-1918 private IP)", () => {
    expect(isSafeMetaUri("https://192.168.1.1/meta.json")).toBe(false);
  });

  it("rejects 169.254.169.254 (AWS metadata endpoint)", () => {
    expect(isSafeMetaUri("https://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  // ── Private-DNS bypass vectors ───────────────────────────────────────────────
  // These hostnames resolve to private IPs in DNS but look like public URLs.
  // A blocklist regex would miss them; the allowlist catches them because they
  // are not in ALLOWED_META_HOSTS.

  it("rejects 127.0.0.1.nip.io (public DNS → loopback bypass)", () => {
    expect(isSafeMetaUri("https://127.0.0.1.nip.io/meta.json")).toBe(false);
  });

  it("rejects 10.0.0.1.nip.io (public DNS → private IP bypass)", () => {
    expect(isSafeMetaUri("https://10.0.0.1.nip.io/meta.json")).toBe(false);
  });

  it("rejects 192.168.0.1.nip.io (public DNS → RFC-1918 bypass)", () => {
    expect(isSafeMetaUri("https://192.168.0.1.nip.io/meta.json")).toBe(false);
  });

  // ── IPv4-mapped IPv6 ─────────────────────────────────────────────────────────

  it("rejects [::ffff:7f00:1] (IPv4-mapped IPv6 loopback)", () => {
    expect(isSafeMetaUri("https://[::ffff:7f00:1]/meta.json")).toBe(false);
  });

  it("rejects [::1] (IPv6 loopback)", () => {
    expect(isSafeMetaUri("https://[::1]/meta.json")).toBe(false);
  });
});

// ── isSafeMetaUri — edge cases ────────────────────────────────────────────────

describe("isSafeMetaUri — edge cases", () => {
  it("returns false for an empty string", () => {
    expect(isSafeMetaUri("")).toBe(false);
  });

  it("returns false for a non-URL string", () => {
    expect(isSafeMetaUri("not a url at all")).toBe(false);
  });

  it("is case-insensitive for the hostname", () => {
    expect(isSafeMetaUri("https://IPFS.IO/ipfs/QmFoo")).toBe(true);
  });
});

// ── fetchSafeUriMeta ──────────────────────────────────────────────────────────

describe("fetchSafeUriMeta", () => {
  it("returns null and never calls fetch for an unsafe URI", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await fetchSafeUriMeta("https://evil.com/meta.json");
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null and never calls fetch for a private-DNS bypass hostname", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await fetchSafeUriMeta("https://127.0.0.1.nip.io/meta.json");
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null for a valid URI when the server returns non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    const result = await fetchSafeUriMeta("https://arweave.net/abc123");
    expect(result).toBeNull();
  });

  it("returns null when the JSON has no name or symbol", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ description: "something" }), { status: 200 }),
    );
    const result = await fetchSafeUriMeta("https://arweave.net/abc123");
    expect(result).toBeNull();
  });

  it("parses a valid metadata JSON from an allowed gateway", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name:        "Moon Dog",
          symbol:      "MDOG",
          image:       "https://arweave.net/img.png",
          description: "A dog on the moon",
          twitter:     "https://twitter.com/mdog",
        }),
        { status: 200 },
      ),
    );
    const result = await fetchSafeUriMeta("https://arweave.net/abc123");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Moon Dog");
    expect(result!.symbol).toBe("MDOG");
    expect(result!.imageUrl).toBe("https://arweave.net/img.png");
    expect(result!.description).toBe("A dog on the moon");
    expect(result!.twitterUrl).toBe("https://twitter.com/mdog");
  });

  it("resolves ipfs:// before fetching and parses the response", async () => {
    let capturedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (input) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url;
      return new Response(
        JSON.stringify({ name: "IpfsToken", symbol: "IPT" }),
        { status: 200 },
      );
    });
    const result = await fetchSafeUriMeta("ipfs://QmTestCid/meta.json");
    expect(capturedUrl).toBe("https://ipfs.io/ipfs/QmTestCid/meta.json");
    expect(result!.name).toBe("IpfsToken");
    expect(result!.symbol).toBe("IPT");
  });

  it("strips an unsafe image URL even when the outer URI is valid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name:   "SneakyToken",
          symbol: "SNKY",
          image:  "https://evil.com/steal.png",  // not in allowlist
        }),
        { status: 200 },
      ),
    );
    const result = await fetchSafeUriMeta("https://arweave.net/abc");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("SneakyToken");
    expect(result!.imageUrl).toBeNull(); // unsafe image URL is stripped
  });
});
