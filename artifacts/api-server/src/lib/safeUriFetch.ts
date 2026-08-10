/**
 * safeUriFetch.ts — Allowlist-gated fetch for untrusted on-chain metadata URIs.
 *
 * Security model
 * ──────────────
 * LaunchLab (and similar) token creators supply a metadata URI inside the
 * createLaunchpad instruction. That URI is entirely attacker-controlled; the
 * enrichment loop fetches it repeatedly in the background.
 *
 * A blocklist-based approach (reject private IPs, 127.0.0.1, etc.) is bypassable
 * via DNS rebinding (e.g. `127.0.0.1.nip.io`), IPv4-mapped IPv6 forms, or simple
 * typosquatting. Resolving hostnames before connecting and rejecting private
 * addresses is the correct DNS-rebinding defence but requires low-level hooks
 * Node's `fetch` does not expose.
 *
 * Instead we use an allowlist of known public metadata gateways. Any URI whose
 * hostname is not in the set is rejected before a network connection is made.
 * This is robust against all forms of private-address aliasing and completely
 * prevents redirect-chain escapes (redirect:"error" would catch that anyway).
 *
 * The allowlist covers every storage backend commonly used by Solana token
 * launchers (IPFS, Arweave, Shadow Drive, common Pinata/NFT.storage gateways).
 * Add entries here — not in individual call sites — as new providers are encountered.
 */

/** Hostnames from which on-chain metadata may be fetched. */
export const ALLOWED_META_HOSTS: ReadonlySet<string> = new Set([
  // ── IPFS gateways ──────────────────────────────────────────────────────────
  "ipfs.io",                      // ipfs:// → always resolves here via resolveIpfs()
  "cloudflare-ipfs.com",          // legacy cf-ipfs.com redirects here
  "gateway.pinata.cloud",         // Pinata cloud
  "nftstorage.link",              // NFT.storage / web3.storage v1
  "w3s.link",                     // web3.storage v2
  "dweb.link",                    // Protocol Labs public gateway
  "cf-ipfs.com",                  // Cloudflare IPFS (kept in case resolveIpfs misses a pattern)

  // ── Arweave ────────────────────────────────────────────────────────────────
  "arweave.net",                  // Primary Arweave gateway
  "arweave.dev",                  // Arweave dev/testnet (low risk to include)

  // ── Solana-native storage ──────────────────────────────────────────────────
  "shdw-drive.genesysgo.net",     // Shadow Drive (GenesysGo)

  // ── Common CDNs used by Solana launchers ──────────────────────────────────
  "storage.googleapis.com",       // Google Cloud Storage (commonly used)
  "cdn.pump.fun",                 // pump.fun metadata CDN (used by launchpad tokens)
  "ipfs-gateway.moonshot.money",  // Moonshot IPFS proxy
]);

/**
 * Resolve ipfs:// and cf-ipfs.com URLs to the canonical ipfs.io gateway.
 * Exported so consumers always use the same resolution rules as the safety check.
 */
export function resolveIpfs(url: string): string {
  return url
    .replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/")
    .replace(/https?:\/\/cf-ipfs\.com\/ipfs\//, "https://ipfs.io/ipfs/");
}

/**
 * Return true iff the URI is safe to fetch as on-chain metadata.
 *
 * The input may be an `ipfs://` URI — it is resolved first, then checked.
 * This function is intentionally strict:
 *   • scheme must be https://
 *   • hostname must be in ALLOWED_META_HOSTS (case-insensitive)
 *   • credentials (@) in the URL are rejected (proxy-confusion attack vector)
 *
 * Exported for unit testing.
 */
export function isSafeMetaUri(rawUri: string): boolean {
  if (!rawUri) return false;
  const uri = resolveIpfs(rawUri.trim());
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    return ALLOWED_META_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Shape returned by fetchSafeUriMeta. */
export interface UriMeta {
  name:        string | null;
  symbol:      string | null;
  imageUrl:    string | null;
  description: string | null;
  twitterUrl:  string | null;
  telegramUrl: string | null;
  websiteUrl:  string | null;
}

/**
 * Fetch and parse token metadata JSON from an on-chain URI.
 *
 * Returns null when:
 *   - the URI is not in the allowed-host list
 *   - the HTTP request fails or times out
 *   - the JSON contains no usable name or symbol
 *
 * Security properties:
 *   - isSafeMetaUri() rejects any hostname not in ALLOWED_META_HOSTS, defeating
 *     all forms of private-address aliasing (DNS rebinding, IPv4-mapped IPv6, etc.)
 *   - redirect:"error" ensures a redirect response is treated as a failure so a
 *     compromised allowed-host cannot chain to an internal address
 *   - The embedded image URL is subject to the same isSafeMetaUri() check
 */
export async function fetchSafeUriMeta(rawUri: string): Promise<UriMeta | null> {
  if (!isSafeMetaUri(rawUri)) return null;
  const url = resolveIpfs(rawUri.trim());
  try {
    const res = await fetch(url, {
      signal:   AbortSignal.timeout(10_000),
      headers:  { "User-Agent": "RocketFi/1.0" },
      redirect: "error",  // never follow redirects — prevents chaining to internal hosts
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      name?:        string;
      symbol?:      string;
      image?:       string;
      description?: string;
      twitter?:     string;
      telegram?:    string;
      website?:     string;
    };
    const name   = json.name?.trim()   || null;
    const symbol = json.symbol?.trim() || null;
    if (!name && !symbol) return null; // empty / not-ready metadata

    const rawImg      = json.image?.trim() || null;
    const resolvedImg = rawImg ? resolveIpfs(rawImg) : null;
    return {
      name,
      symbol,
      // Apply the same allowlist check to the embedded image URL
      imageUrl:    resolvedImg && isSafeMetaUri(resolvedImg) ? resolvedImg : null,
      description: json.description?.trim() || null,
      twitterUrl:  json.twitter?.trim()     || null,
      telegramUrl: json.telegram?.trim()    || null,
      websiteUrl:  json.website?.trim()     || null,
    };
  } catch {
    return null;
  }
}
