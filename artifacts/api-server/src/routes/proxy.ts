import { Router } from "express";
import { URL } from "url";

const router = Router();

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
