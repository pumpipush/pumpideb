import { randomUUID } from "crypto";
import { Router } from "express";
import { URL } from "url";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();
const storageService = new ObjectStorageService();

// ── pump.fun metadata self-hosting ────────────────────────────────────────────

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Allowlisted hostnames for image proxying — prevents SSRF to internal services.
// Add new CDN/IPFS hosts here as needed; never allow bare IP addresses or localhost.
const ALLOWED_HOSTS = new Set([
  // pump.fun CDN
  "cf-ipfs.com",
  "ipfs.io",
  "gateway.ipfs.io",
  "dweb.link",
  "nftstorage.link",
  // Arweave gateways
  "arweave.net",
  "gateway.arweave.net",
  // Common image CDNs used by Solana token metadata
  "i.imgur.com",
  "raw.githubusercontent.com",
  "bafybei.ipfs.nftstorage.link",
  // pump.fun + pumpswap own CDN
  "pump.fun",
  "pumpswap.fun",
  "cdn.pump.fun",
  // DexScreener token images
  "dd.dexscreener.com",
  "assets.coingecko.com",
  // Birdeye CDN
  "cdn.birdeye.so",
  "birdeye.so",
  // Generic image hosts commonly used by Solana token creators
  "images.unsplash.com",
  "cloudflare-ipfs.com",
  "gateway.pinata.cloud",
  "ipfs.filebase.io",
  "media.discordapp.net",
  "cdn.discordapp.com",
]);

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    // Only HTTP/HTTPS, no file:// data:// etc.
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    // Reject bare IPs and localhost
    if (/^[\d.]+$/.test(host) || /^[0-9a-f:]+$/.test(host)) return false;
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    // Allow exact match or any subdomain of an allowed host
    return Array.from(ALLOWED_HOSTS).some(
      allowed => host === allowed || host.endsWith("." + allowed)
    );
  } catch {
    return false;
  }
}

/**
 * POST /pump-ipfs-upload
 *
 * Hosts token metadata for pump.fun coin creation using our own object storage.
 * pump.fun's /api/ipfs endpoint is blocked from Replit datacenter IPs (Cloudflare 530)
 * and also rejects cross-origin browser requests. Instead of forwarding to pump.fun,
 * we host the metadata ourselves:
 *
 *   1. Decode the base64-encoded image from the JSON body
 *   2. Upload the image to GCS under the public search path
 *   3. Build a Metaplex-standard metadata JSON referencing the image URL
 *   4. Upload the metadata JSON to GCS under the public search path
 *   5. Return { metadataUri } — an absolute HTTPS URL that any client can fetch
 *
 * pump.fun's on-chain program only stores the metadataUri string; it accepts any
 * publicly reachable HTTPS URL, not just IPFS URIs.
 *
 * Body (application/json):
 *   name, symbol, description: string (required)
 *   imageBase64: string (required) — base64-encoded image bytes
 *   imageType: string (required) — MIME type, e.g. "image/png"
 *   twitter, telegram, website: string (optional)
 *
 * Rate: 1 upload every 10 s per IP — token creation is a deliberate user action.
 */
const _ipfsRateMap = new Map<string, number>();
const IPFS_RATE_MS = 10_000;

router.post("/pump-ipfs-upload", async (req, res) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const last = _ipfsRateMap.get(ip) ?? 0;
  if (now - last < IPFS_RATE_MS) {
    return res.status(429).json({ error: "Too many upload requests — wait a moment and try again" });
  }
  _ipfsRateMap.set(ip, now);

  const { name, symbol, description, imageBase64, imageType, twitter, telegram, website } =
    req.body as Record<string, unknown>;

  if (
    typeof name !== "string" || !name.trim() ||
    typeof symbol !== "string" || !symbol.trim() ||
    typeof description !== "string" || !description.trim() ||
    typeof imageBase64 !== "string" || !imageBase64 ||
    typeof imageType !== "string" || !ALLOWED_IMAGE_MIME.has(imageType)
  ) {
    return res.status(400).json({
      error: "Missing or invalid required fields: name, symbol, description, imageBase64, imageType",
    });
  }

  // Decode base64 image
  let imageBuffer: Buffer;
  try {
    imageBuffer = Buffer.from(imageBase64, "base64");
  } catch {
    return res.status(400).json({ error: "imageBase64 is not valid base64" });
  }

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
  if (imageBuffer.byteLength > MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: "Image must be 5 MB or smaller" });
  }
  if (imageBuffer.byteLength === 0) {
    return res.status(400).json({ error: "Image data is empty" });
  }

  // Derive the public base URL from request headers so the metadataUri is absolute
  // and fetchable by external clients (pump.fun explorers, wallets, etc.)
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
    req.headers.host ??
    "localhost";
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? "https";
  const baseUrl = `${proto}://${host}`;

  try {
    const uuid = randomUUID();
    const ext = MIME_TO_EXT[imageType] ?? "bin";
    const imageSubPath = `token-images/${uuid}.${ext}`;
    const metaSubPath  = `token-meta/${uuid}.json`;

    // 1. Upload image to public object storage
    await storageService.uploadToPublicPath(imageSubPath, imageBuffer, imageType);
    const imageUrl = `${baseUrl}/api/storage/public-objects/${imageSubPath}`;

    // 2. Build Metaplex-compatible metadata JSON
    const metadata: Record<string, unknown> = {
      name:        name.trim(),
      symbol:      symbol.trim(),
      description: description.trim(),
      image:       imageUrl,
      showName:    true,
    };
    if (typeof twitter === "string" && twitter.trim())  metadata.twitter  = twitter.trim();
    if (typeof telegram === "string" && telegram.trim()) metadata.telegram = telegram.trim();
    if (typeof website === "string" && website.trim())  metadata.website  = website.trim();

    // 3. Upload metadata JSON to public object storage
    const metaBuffer = Buffer.from(JSON.stringify(metadata));
    await storageService.uploadToPublicPath(metaSubPath, metaBuffer, "application/json");

    const metadataUri = `${baseUrl}/api/storage/public-objects/${metaSubPath}`;
    return res.json({ metadataUri });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: `Metadata upload failed: ${msg}` });
  }
});

router.get("/proxy-image", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing url");
  if (!isAllowedUrl(url)) return res.status(403).send("Domain not allowed");

  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) return res.status(502).send("Upstream error");

    const contentType = upstream.headers.get("content-type") ?? "image/png";
    // Only proxy image content types
    if (!contentType.startsWith("image/")) return res.status(415).send("Not an image");

    // Cap response at 5 MB to prevent memory abuse
    const MAX_BYTES = 5 * 1024 * 1024;
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return res.status(413).send("Image too large");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(Buffer.from(buf));
  } catch {
    return res.status(502).send("Failed to fetch image");
  }
});

export default router;
