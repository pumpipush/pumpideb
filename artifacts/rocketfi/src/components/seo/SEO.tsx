import { Helmet } from "react-helmet-async";

const SITE_NAME = "Pumpi";
const DEFAULT_TITLE = "Pumpi — Launch & Trade Solana Memecoins";
const DEFAULT_DESC =
  "Pumpi is the fastest way to launch and trade Solana memecoins. No presales. No team allocations. Pure price discovery on pump.fun, PumpSwap, and Raydium LaunchLab.";
const DEFAULT_IMAGE = "/pumpi-social-preview.png";
const DEFAULT_KEYWORDS =
  "solana, memecoin, pump.fun, pumpswap, raydium, launchlab, crypto trading, solana token launch, memecoin trading, defi";

interface SEOProps {
  /** Browser tab title. Automatically appended with " | Pumpi" unless `titleTemplate` is false. */
  title?: string;
  /** Override the full title without appending site name. */
  fullTitle?: string;
  description?: string;
  /** Absolute or root-relative URL for og:image / twitter:image. */
  image?: string | null;
  /** Canonical URL. Defaults to current page URL. */
  url?: string;
  /** og:type — defaults to "website". Use "article" for token pages. */
  type?: "website" | "article";
  /** Additional keywords appended to default set. */
  keywords?: string;
  /** Set true for pages that should not be indexed (e.g. wallet-gated panels). */
  noIndex?: boolean;
}

export function SEO({
  title,
  fullTitle,
  description = DEFAULT_DESC,
  image,
  url,
  type = "website",
  keywords,
  noIndex = false,
}: SEOProps) {
  const computedTitle = fullTitle
    ? fullTitle
    : title
    ? `${SITE_NAME} — ${title}`
    : DEFAULT_TITLE;

  // og:image / twitter:image must be absolute URLs — social crawlers reject root-relative paths.
  const rawImage = image ?? DEFAULT_IMAGE;
  const computedImage =
    typeof window !== "undefined" && rawImage.startsWith("/")
      ? `${window.location.origin}${rawImage}`
      : rawImage;

  // Resolve canonical — prefer explicit prop, fall back to current href (client-only)
  const canonical =
    url ?? (typeof window !== "undefined" ? window.location.href : "/");

  const keywordStr = keywords
    ? `${DEFAULT_KEYWORDS}, ${keywords}`
    : DEFAULT_KEYWORDS;

  return (
    <Helmet>
      {/* ── Primary ────────────────────────────────────────────────────────── */}
      <title>{computedTitle}</title>
      <meta name="description" content={description} />
      <meta name="keywords" content={keywordStr} />
      {noIndex && <meta name="robots" content="noindex,nofollow" />}
      <link rel="canonical" href={canonical} />

      {/* ── Open Graph ─────────────────────────────────────────────────────── */}
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={computedTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={computedImage} />
      <meta property="og:url" content={canonical} />
      <meta property="og:locale" content="en_US" />

      {/* ── Twitter / X Card ───────────────────────────────────────────────── */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={computedTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={computedImage} />
      <meta name="twitter:site" content="@pumpi_dex" />
    </Helmet>
  );
}
