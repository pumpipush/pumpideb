/**
 * objectStorage.test.ts — Unit tests for ObjectStorageService.uploadToPublicPath
 *
 * Covers the three distinct outcomes:
 *  1. makePublic() succeeds  → direct GCS URL returned (fine-grained ACL bucket)
 *  2. makePublic() fails for any reason (uniform-ACL, IAM denial, transient
 *     error) → null returned so the caller uses the proxied URL instead
 *  3. file.save() fails → throws so the caller can fall back to an alternative
 *     upload path (e.g. pump.fun IPFS in Path B of proxy.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
// vi.mock factories are hoisted before variable declarations; vi.hoisted()
// ensures these spies are available inside the factory.
const { mockSave, mockMakePublic, mockFile, mockBucket } = vi.hoisted(() => {
  const mockMakePublic = vi.fn();
  const mockSave       = vi.fn();
  const mockFile       = vi.fn(() => ({ save: mockSave, makePublic: mockMakePublic }));
  const mockBucket     = vi.fn(() => ({ file: mockFile }));
  return { mockSave, mockMakePublic, mockFile, mockBucket };
});

// ── Module mocks ──────────────────────────────────────────────────────────────
vi.mock("@google-cloud/storage", () => ({
  // Storage must be a real constructor (not an arrow fn) because objectStorage.ts
  // calls `new Storage(...)` at module-load time.
  Storage: vi.fn(function () { return { bucket: mockBucket }; }),
  File:    vi.fn(function () {}),
}));

vi.mock("./objectAcl", () => ({
  canAccessObject:    vi.fn(),
  getObjectAclPolicy: vi.fn(),
  setObjectAclPolicy: vi.fn(),
  ObjectAclPolicy:    {},
  ObjectPermission:   { READ: "READ" },
}));

// ── Import after mocks are registered ─────────────────────────────────────────
import { ObjectStorageService } from "./objectStorage";

// ── Constants ─────────────────────────────────────────────────────────────────

const STUB_CONTENT = Buffer.from("fake image bytes");
const STUB_MIME    = "image/png";
const STUB_SUBPATH = "token-images/abc123.png";

const EXPECTED_DIRECT_URL =
  "https://storage.googleapis.com/test-bucket/public-prefix/token-images/abc123.png";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ObjectStorageService.uploadToPublicPath", () => {
  let service: ObjectStorageService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_OBJECT_SEARCH_PATHS", "/test-bucket/public-prefix");
    service = new ObjectStorageService();
    mockSave.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Case 1: makePublic() succeeds → direct GCS URL ───────────────────────

  it("returns the direct GCS URL when makePublic() succeeds", async () => {
    mockMakePublic.mockResolvedValue(undefined);

    const result = await service.uploadToPublicPath(STUB_SUBPATH, STUB_CONTENT, STUB_MIME);

    expect(result).toBe(EXPECTED_DIRECT_URL);
    expect(mockSave).toHaveBeenCalledOnce();
    expect(mockMakePublic).toHaveBeenCalledOnce();
  });

  // ── Case 2: makePublic() fails → null (caller uses proxied URL) ───────────
  // This covers uniform-ACL buckets, IAM denials, and transient errors alike.
  // Returning null in all failure cases is the safe choice: we cannot confirm
  // the object is public, so the caller falls back to the always-reachable
  // /api/storage/public-objects proxy URL.

  const ACL_FAILURE_CASES: [string, string][] = [
    [
      "uniform bucket-level access (Replit-provisioned buckets)",
      "Cannot get legacy ACL for a bucket that has uniform bucket-level access.",
    ],
    [
      "uniform bucket-level access (alternate phrasing)",
      "bucket has uniform bucket-level access enabled",
    ],
    [
      "IAM permission denied",
      "403 Forbidden: caller does not have storage.objects.setIamPolicy",
    ],
    [
      "transient network error",
      "ECONNRESET",
    ],
  ];

  for (const [label, errMsg] of ACL_FAILURE_CASES) {
    it(`returns null when makePublic() fails — ${label}`, async () => {
      mockMakePublic.mockRejectedValue(new Error(errMsg));

      const result = await service.uploadToPublicPath(STUB_SUBPATH, STUB_CONTENT, STUB_MIME);

      expect(result).toBeNull();
      expect(mockSave).toHaveBeenCalledOnce();
      expect(mockMakePublic).toHaveBeenCalledOnce();
    });
  }

  // ── Case 3: file.save() fails → throws (activates Path B fallback) ────────

  it("throws when file.save() fails so the caller can fall back to IPFS upload", async () => {
    const saveError = new Error("GCS auth error: sidecar unavailable");
    mockSave.mockRejectedValue(saveError);

    await expect(
      service.uploadToPublicPath(STUB_SUBPATH, STUB_CONTENT, STUB_MIME),
    ).rejects.toThrow("GCS auth error: sidecar unavailable");

    // makePublic must not be called when save itself fails
    expect(mockMakePublic).not.toHaveBeenCalled();
  });

  // ── Correct bucket/object path construction ───────────────────────────────

  it("constructs the correct bucket name and object path from PUBLIC_OBJECT_SEARCH_PATHS", async () => {
    vi.stubEnv("PUBLIC_OBJECT_SEARCH_PATHS", "/my-bucket/prod/assets");
    mockMakePublic.mockResolvedValue(undefined);

    const result = await service.uploadToPublicPath(
      "token-meta/uuid.json",
      STUB_CONTENT,
      "application/json",
    );

    expect(mockBucket).toHaveBeenCalledWith("my-bucket");
    expect(mockFile).toHaveBeenCalledWith("prod/assets/token-meta/uuid.json");
    expect(result).toBe(
      "https://storage.googleapis.com/my-bucket/prod/assets/token-meta/uuid.json",
    );
  });

  it("handles a search path with no prefix (bucket-root path)", async () => {
    vi.stubEnv("PUBLIC_OBJECT_SEARCH_PATHS", "/root-bucket");
    mockMakePublic.mockResolvedValue(undefined);

    const result = await service.uploadToPublicPath(
      "token-images/x.png",
      STUB_CONTENT,
      STUB_MIME,
    );

    expect(mockBucket).toHaveBeenCalledWith("root-bucket");
    expect(mockFile).toHaveBeenCalledWith("token-images/x.png");
    expect(result).toBe("https://storage.googleapis.com/root-bucket/token-images/x.png");
  });
});
