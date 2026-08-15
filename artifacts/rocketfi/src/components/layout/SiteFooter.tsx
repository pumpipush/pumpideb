import { Link } from "wouter";

const YEAR = new Date().getFullYear();

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.741l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

const LEGAL_LINKS = [
  { href: "/privacy",    label: "Privacy Policy" },
  { href: "/disclaimer", label: "Disclaimer" },
  { href: "/terms",      label: "Terms of Service" },
  { href: "/contact",    label: "Contact" },
];

function SocialIcons() {
  return (
    <div className="flex items-center gap-3">
      <a href="https://x.com/pumpi_dex" target="_blank" rel="noopener noreferrer"
        className="text-muted-foreground/50 hover:text-foreground transition-colors" aria-label="X / Twitter">
        <XIcon />
      </a>
      <a href="https://t.me/pumpi_dex" target="_blank" rel="noopener noreferrer"
        className="text-muted-foreground/50 hover:text-foreground transition-colors" aria-label="Telegram">
        <TelegramIcon />
      </a>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/40 px-5 py-4">

      {/* ── Mobile (< md): 2 rows ── */}
      <div className="md:hidden flex flex-col gap-2.5">
        {/* Row 1: copyright + social */}
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-muted-foreground">© {YEAR} Pumpi</span>
          <SocialIcons />
        </div>
        {/* Row 2: legal links */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {LEGAL_LINKS.map((l, i) => (
            <span key={l.href} className="flex items-center gap-2.5">
              {i > 0 && <span className="text-muted-foreground/30">·</span>}
              <Link href={l.href} className="text-[13px] text-muted-foreground hover:text-foreground transition-colors">
                {l.label}
              </Link>
            </span>
          ))}
        </div>
      </div>

      {/* ── Desktop (md+): single horizontal row ── */}
      <div className="hidden md:flex items-center justify-between gap-x-6 gap-y-3 flex-wrap">
        <span className="text-[14px] text-muted-foreground shrink-0">© {YEAR} Pumpi. All rights reserved.</span>
        <div className="flex items-center gap-3 flex-wrap">
          {LEGAL_LINKS.map((l, i) => (
            <span key={l.href} className="flex items-center gap-3">
              {i > 0 && <span className="text-muted-foreground/40">·</span>}
              <Link href={l.href} className="text-[14px] text-muted-foreground hover:text-foreground transition-colors">
                {l.label}
              </Link>
            </span>
          ))}
        </div>
        <SocialIcons />
      </div>

    </footer>
  );
}
