import { SEO } from "@/components/seo/SEO";
import { ArrowUpRight, ChevronRight, Clock, Shield, MessageCircle } from "lucide-react";

/* ─── Data ────────────────────────────────────────────────────────── */
const CHANNELS = [
  {
    label: "General & Partnerships",
    email: "hello@pumpi.io",
    description: "Business inquiries, media coverage, partnership proposals, and general feedback.",
    topics: ["Partnerships", "Press", "Feedback", "Suggestions"],
    accent: "#6366f1",
  },
  {
    label: "User Support",
    email: "support@pumpi.io",
    description: "Account issues, token display problems, trade questions, and bug reports.",
    topics: ["Login issues", "Token missing", "Trade help", "Bug reports"],
    accent: "#10b981",
  },
];

const SOCIALS = [
  {
    label: "X / Twitter",
    handle: "@pumpi_io",
    href: "https://x.com/pumpi_io",
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden>
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.741l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    label: "Telegram",
    handle: "t.me/pumpi_io",
    href: "https://t.me/pumpi_io",
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden>
        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
      </svg>
    ),
  },
];

export default function Contact() {
  return (
    <>
      <SEO
        title="Contact Us"
        description="Get in touch with the Pumpi team — support, partnerships, press, and more."
      />
      <div className="min-h-screen bg-background text-foreground">

        {/* ── COMPACT HEADER ──────────────────────────────────────────
            City photo as a narrow band — readable height, no waste   */}
        <div className="relative overflow-hidden" style={{ height: 220 }}>
          <img
            src="/contact-city.jpg"
            alt=""
            aria-hidden
            className="absolute inset-0 w-full h-full object-cover object-[center_35%]"
            style={{ filter: "brightness(0.18) saturate(0.6)" }}
          />
          {/* Bottom fade */}
          <div
            className="absolute inset-x-0 bottom-0 h-16 pointer-events-none"
            style={{ background: "linear-gradient(to bottom, transparent, hsl(var(--background)))" }}
          />
          {/* Content — vertically centered */}
          <div className="relative h-full flex flex-col justify-center px-6 max-w-5xl mx-auto">
            <p className="text-[10px] font-semibold tracking-[0.18em] uppercase text-white/35 mb-2">
              Pumpi · Contact
            </p>
            <h1 className="text-[32px] md:text-[40px] font-black text-white tracking-tight leading-tight">
              Get in touch
            </h1>
          </div>
        </div>

        {/* ── MAIN ────────────────────────────────────────────────── */}
        <div className="max-w-5xl mx-auto px-6 pb-16">

          {/* Intro row — tight, below the header */}
          <div className="flex flex-wrap items-center justify-between gap-4 py-5 mb-6 border-b border-white/[0.06]">
            <p className="text-[14px] text-muted-foreground/70 max-w-lg">
              Small team, big focus. We read every message and reply as fast as we can.
            </p>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[12px] text-muted-foreground/70">
                Avg. reply · <span className="text-foreground font-medium">under 24 hours</span>
              </span>
            </div>
          </div>

          {/* ── Email channels ──────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            {CHANNELS.map((ch) => (
              <div
                key={ch.email}
                className="relative rounded-2xl border border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.04] hover:border-white/[0.11] transition-all duration-200 overflow-hidden"
              >
                {/* Top accent line */}
                <div
                  className="absolute top-0 inset-x-0 h-[1.5px]"
                  style={{ background: `linear-gradient(to right, transparent, ${ch.accent}90, transparent)` }}
                />

                <div className="p-6">
                  <p
                    className="text-[10px] font-bold uppercase tracking-[0.15em] mb-3"
                    style={{ color: ch.accent }}
                  >
                    {ch.label}
                  </p>

                  <a
                    href={`mailto:${ch.email}`}
                    className="group inline-flex items-center gap-1.5 text-[20px] md:text-[23px] font-bold text-white hover:opacity-75 transition-opacity mb-3 break-all"
                  >
                    {ch.email}
                    <ArrowUpRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" style={{ color: ch.accent }} />
                  </a>

                  <p className="text-[13px] text-muted-foreground/65 leading-relaxed mb-4">
                    {ch.description}
                  </p>

                  <div className="flex flex-wrap gap-1.5 mb-5">
                    {ch.topics.map((t) => (
                      <span
                        key={t}
                        className="text-[11px] font-medium px-2 py-0.5 rounded-full border"
                        style={{ borderColor: `${ch.accent}28`, color: `${ch.accent}bb`, background: `${ch.accent}0d` }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>

                  <a
                    href={`mailto:${ch.email}`}
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3.5 py-2 rounded-lg border transition-all hover:opacity-80"
                    style={{ borderColor: `${ch.accent}30`, color: ch.accent, background: `${ch.accent}10` }}
                  >
                    Open in mail app →
                  </a>
                </div>
              </div>
            ))}
          </div>

          {/* ── Bottom row: photo accent + socials + info ───────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Trading chart photo — spans 2 cols on large */}
            <div className="lg:col-span-2 relative rounded-2xl overflow-hidden border border-white/[0.07]" style={{ minHeight: 180 }}>
              <img
                src="/contact-chart.jpg"
                alt="Crypto trading chart"
                className="absolute inset-0 w-full h-full object-cover object-center"
                style={{ filter: "brightness(0.35) saturate(1.3)" }}
              />
              <div className="absolute inset-0" style={{ background: "linear-gradient(120deg, rgba(99,102,241,0.12) 0%, transparent 60%)" }} />
              <div className="relative p-6 flex flex-col justify-end h-full">
                <p className="text-[22px] md:text-[26px] font-black text-white leading-tight mb-1">
                  Real-time data.<br />Real people behind it.
                </p>
                <p className="text-[13px] text-white/45">
                  Every token tracked live across pump.fun, PumpSwap & Raydium LaunchLab.
                </p>
              </div>
            </div>

            {/* Socials + status — right column */}
            <div className="flex flex-col gap-3">
              {SOCIALS.map((s) => (
                <a
                  key={s.href}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-3 px-4 py-3.5 rounded-2xl border border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.05] hover:border-white/[0.12] transition-all group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-muted-foreground/60 group-hover:text-white transition-colors">
                      {s.icon}
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-foreground leading-tight">{s.label}</p>
                      <p className="text-[11px] text-muted-foreground/50">{s.handle}</p>
                    </div>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/25 group-hover:text-muted-foreground/50 transition-colors" />
                </a>
              ))}

              {/* Quick info card */}
              <div className="flex-1 p-4 rounded-2xl border border-white/[0.07] bg-white/[0.02] flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-muted-foreground/40" />
                  <span className="text-[12px] text-muted-foreground/60">Mon – Fri, responds in &lt;24h</span>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-muted-foreground/40" />
                  <span className="text-[12px] text-muted-foreground/60">Security? Mark subject [SECURITY]</span>
                </div>
                <div className="flex items-center gap-2">
                  <MessageCircle className="w-3.5 h-3.5 text-muted-foreground/40" />
                  <span className="text-[12px] text-muted-foreground/60">Token missing? Include mint address</span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
