import { SEO } from "@/components/seo/SEO";
import { ArrowUpRight } from "lucide-react";

const XIcon = () => (
  <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.741l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const TelegramIcon = () => (
  <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden>
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
);

export default function Contact() {
  return (
    <>
      <SEO
        title="Contact Us"
        description="Get in touch with the Pumpi team — support, partnerships, and more."
      />
      <div className="min-h-screen bg-background text-foreground flex items-start justify-center px-4 py-20">
        <div className="w-full max-w-md">

          {/* Header */}
          <h1 className="text-3xl font-extrabold text-white mb-2">Contact</h1>
          <p className="text-sm text-muted-foreground mb-10">
            Small team, big focus. We read every message and reply within 24 hours.
          </p>

          {/* Email rows */}
          <div className="space-y-px mb-10">
            {[
              { label: "General & Partnerships", email: "hello@pumpi.io" },
              { label: "Support", email: "support@pumpi.io" },
            ].map((ch) => (
              <a
                key={ch.email}
                href={`mailto:${ch.email}`}
                className="group flex items-center justify-between py-4 border-b border-white/[0.07] hover:border-white/20 transition-colors"
              >
                <div>
                  <p className="text-[11px] uppercase tracking-widest text-muted-foreground/50 mb-0.5 font-medium">
                    {ch.label}
                  </p>
                  <p className="text-base font-semibold text-white">{ch.email}</p>
                </div>
                <ArrowUpRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-white transition-colors" />
              </a>
            ))}
          </div>

          {/* Social links */}
          <div className="space-y-px">
            {[
              { label: "X / Twitter", handle: "@pumpi_dex", href: "https://x.com/pumpi_dex", icon: <XIcon /> },
              { label: "Telegram", handle: "t.me/pumpi_dex", href: "https://t.me/pumpi_dex", icon: <TelegramIcon /> },
            ].map((s) => (
              <a
                key={s.href}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center justify-between py-4 border-b border-white/[0.07] hover:border-white/20 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground/50 group-hover:text-white transition-colors">{s.icon}</span>
                  <div>
                    <p className="text-[11px] uppercase tracking-widest text-muted-foreground/50 mb-0.5 font-medium">
                      {s.label}
                    </p>
                    <p className="text-base font-semibold text-white">{s.handle}</p>
                  </div>
                </div>
                <ArrowUpRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-white transition-colors" />
              </a>
            ))}
          </div>

        </div>
      </div>
    </>
  );
}
