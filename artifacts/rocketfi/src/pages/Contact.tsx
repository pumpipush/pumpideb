import { SEO } from "@/components/seo/SEO";
import { ArrowUpRight, Clock, Shield, MessageCircle, Zap } from "lucide-react";

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

const CHANNELS = [
  {
    label: "General & Partnerships",
    email: "hello@pumpi.io",
    description: "Business inquiries, media coverage, partnership proposals, and general feedback.",
    topics: ["Partnerships", "Press", "Feedback"],
  },
  {
    label: "User Support",
    email: "support@pumpi.io",
    description: "Account issues, token display problems, trade questions, and bug reports.",
    topics: ["Login issues", "Token missing", "Bug reports"],
  },
];

const SOCIALS = [
  { label: "X / Twitter", handle: "@pumpi_dex", href: "https://x.com/pumpi_dex", icon: <XIcon /> },
  { label: "Telegram", handle: "t.me/pumpi_dex", href: "https://t.me/pumpi_dex", icon: <TelegramIcon /> },
];

const INFO = [
  { icon: <Zap className="w-3.5 h-3.5" />, text: "Average reply under 24 hours" },
  { icon: <Shield className="w-3.5 h-3.5" />, text: "Security reports? Mark subject [SECURITY]" },
  { icon: <MessageCircle className="w-3.5 h-3.5" />, text: "Token missing? Include the mint address" },
  { icon: <Clock className="w-3.5 h-3.5" />, text: "Active Mon – Fri" },
];

export default function Contact() {
  return (
    <>
      <SEO
        title="Contact Us"
        description="Get in touch with the Pumpi team — support, partnerships, press, and more."
      />
      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-3xl mx-auto px-5 py-16">

          {/* Header */}
          <div className="mb-12">
            <p className="text-[10px] font-semibold tracking-[0.18em] uppercase text-muted-foreground/40 mb-3">
              Pumpi · Contact
            </p>
            <h1 className="text-4xl font-extrabold text-white tracking-tight mb-3">
              Get in touch
            </h1>
            <p className="text-[15px] text-muted-foreground/60 max-w-md leading-relaxed">
              Small team, big focus. We read every message and reply as fast as we can — usually within a day.
            </p>
          </div>

          {/* Email channels */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
            {CHANNELS.map((ch) => (
              <a
                key={ch.email}
                href={`mailto:${ch.email}`}
                className="group relative rounded-2xl border border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.04] hover:border-white/[0.12] transition-all duration-200 p-5 flex flex-col gap-3 overflow-hidden"
              >
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/40 mb-2">
                    {ch.label}
                  </p>
                  <p className="text-[18px] font-semibold text-white group-hover:opacity-80 transition-opacity">
                    {ch.email}
                  </p>
                </div>

                <p className="text-[14px] text-muted-foreground/55 leading-relaxed flex-1">
                  {ch.description}
                </p>

                <div className="flex flex-wrap gap-1.5">
                  {ch.topics.map((t) => (
                    <span
                      key={t}
                      className="text-[12px] font-medium px-2.5 py-1 rounded-full border border-white/[0.08] text-muted-foreground/50 bg-white/[0.03]"
                    >
                      {t}
                    </span>
                  ))}
                </div>

                <ArrowUpRight className="absolute top-4 right-4 w-3.5 h-3.5 text-muted-foreground/20 group-hover:text-muted-foreground/60 transition-colors" />
              </a>
            ))}
          </div>

          {/* Social + info row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

            {/* Social links */}
            <div className="space-y-2">
              {SOCIALS.map((s) => (
                <a
                  key={s.href}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between gap-3 px-4 py-3.5 rounded-xl border border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/[0.12] transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg border border-white/[0.08] bg-white/[0.05] flex items-center justify-center text-muted-foreground/50 group-hover:text-white transition-colors">
                      {s.icon}
                    </div>
                    <div>
                      <p className="text-[15px] font-semibold text-white leading-tight">{s.label}</p>
                      <p className="text-[13px] text-muted-foreground/40">{s.handle}</p>
                    </div>
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground/20 group-hover:text-muted-foreground/60 transition-colors" />
                </a>
              ))}
            </div>

            {/* Info card */}
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-5 py-4 flex flex-col justify-center gap-3">
              {INFO.map((item, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <span className="text-muted-foreground/30 shrink-0">{item.icon}</span>
                  <span className="text-[13px] text-muted-foreground/55">{item.text}</span>
                </div>
              ))}
            </div>

          </div>
        </div>
      </div>
    </>
  );
}
