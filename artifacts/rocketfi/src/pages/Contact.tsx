import { SEO } from "@/components/seo/SEO";
import { Link } from "wouter";
import { ArrowUpRight, ChevronRight } from "lucide-react";

/* ─── Data ────────────────────────────────────────────────────────── */
const CHANNELS = [
  {
    label: "General & Partnerships",
    email: "hello@pumpi.io",
    description:
      "Business inquiries, media coverage, partnership proposals, and anything that doesn't need urgent support.",
    topics: ["Partnerships", "Press", "Feedback", "Suggestions"],
    accent: "#6366f1", // indigo
  },
  {
    label: "User Support",
    email: "support@pumpi.io",
    description:
      "Account issues, token display problems, trade questions, and anything you need as a Pumpi user.",
    topics: ["Login issues", "Token missing", "Trade help", "Bug reports"],
    accent: "#10b981", // emerald
  },
];

const SOCIALS = [
  {
    label: "X / Twitter",
    handle: "@pumpi_io",
    href: "https://x.com/pumpi_io",
    icon: (
      <svg viewBox="0 0 24 24" className="w-[18px] h-[18px] fill-current" aria-hidden>
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.741l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    label: "Telegram",
    handle: "t.me/pumpi_io",
    href: "https://t.me/pumpi_io",
    icon: (
      <svg viewBox="0 0 24 24" className="w-[18px] h-[18px] fill-current" aria-hidden>
        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
      </svg>
    ),
  },
];

const FAQ = [
  {
    q: "How quickly do you reply?",
    a: "Within 24 hours on weekdays. Support queries are usually faster.",
  },
  {
    q: "Found a security vulnerability?",
    a: 'Email hello@pumpi.io with "[SECURITY]" in the subject. Please don\'t post it publicly.',
  },
  {
    q: "My token isn't showing on Pumpi.",
    a: "Tokens are auto-indexed from pump.fun, PumpSwap, and Raydium LaunchLab. If yours is still missing after 30 minutes, send the mint address to support.",
  },
  {
    q: "How do I report a scam token?",
    a: "Send the token address and a short description to support@pumpi.io. We review every report.",
  },
];

/* ─── Component ───────────────────────────────────────────────────── */
export default function Contact() {
  return (
    <>
      <SEO
        title="Contact Us"
        description="Get in touch with the Pumpi team — support, partnerships, press, and more."
      />

      <div className="min-h-screen bg-background text-foreground">

        {/* ── HERO ──────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden">
          {/* City night photo */}
          <img
            src="/contact-city.jpg"
            alt=""
            aria-hidden
            className="absolute inset-0 w-full h-full object-cover object-center scale-[1.02]"
            style={{ filter: "brightness(0.22) saturate(0.7)" }}
          />
          {/* Bottom fade into bg */}
          <div
            className="absolute inset-x-0 bottom-0 h-32 pointer-events-none"
            style={{ background: "linear-gradient(to bottom, transparent, hsl(var(--background)))" }}
          />

          {/* Content */}
          <div className="relative max-w-5xl mx-auto px-6 pt-16 pb-20 md:pt-24 md:pb-28">
            <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-white/40 mb-5">
              Pumpi · Contact
            </p>
            <h1 className="text-[42px] md:text-[64px] font-black text-white tracking-tight leading-[1.0] mb-6 max-w-2xl">
              We're just<br />an email away.
            </h1>
            <p className="text-[16px] text-white/55 max-w-md leading-relaxed">
              Small team, big focus. We read every message and respond as fast as we can — usually within a day.
            </p>

            {/* Response badge */}
            <div className="mt-8 inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-white/10 bg-white/5 backdrop-blur-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[13px] text-white/60">
                Avg. response time · <span className="text-white font-medium">under 24 hours</span>
              </span>
            </div>
          </div>
        </div>

        {/* ── MAIN CONTENT ──────────────────────────────────────────── */}
        <div className="max-w-5xl mx-auto px-6 pb-20">

          {/* ── Email channels ─────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-16">
            {CHANNELS.map((ch) => (
              <div
                key={ch.email}
                className="group relative rounded-2xl border border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.04] hover:border-white/[0.12] transition-all duration-300 overflow-hidden"
              >
                {/* Subtle top accent line */}
                <div
                  className="absolute top-0 inset-x-0 h-[1.5px] opacity-60"
                  style={{ background: `linear-gradient(to right, ${ch.accent}00, ${ch.accent}, ${ch.accent}00)` }}
                />

                <div className="p-7">
                  {/* Label */}
                  <p
                    className="text-[11px] font-bold uppercase tracking-[0.15em] mb-4"
                    style={{ color: ch.accent }}
                  >
                    {ch.label}
                  </p>

                  {/* Email — the hero element */}
                  <a
                    href={`mailto:${ch.email}`}
                    className="group/link inline-flex items-center gap-2 text-[22px] md:text-[26px] font-bold text-white hover:opacity-80 transition-opacity mb-5 break-all"
                  >
                    {ch.email}
                    <ArrowUpRight
                      className="w-5 h-5 opacity-0 group-hover/link:opacity-100 transition-opacity shrink-0"
                      style={{ color: ch.accent }}
                    />
                  </a>

                  {/* Description */}
                  <p className="text-[14px] text-muted-foreground/75 leading-relaxed mb-6">
                    {ch.description}
                  </p>

                  {/* Topic pills */}
                  <div className="flex flex-wrap gap-2 mb-7">
                    {ch.topics.map((t) => (
                      <span
                        key={t}
                        className="text-[11px] font-medium px-2.5 py-1 rounded-full border"
                        style={{
                          borderColor: `${ch.accent}30`,
                          color: `${ch.accent}cc`,
                          background: `${ch.accent}0f`,
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>

                  {/* CTA */}
                  <a
                    href={`mailto:${ch.email}`}
                    className="inline-flex items-center gap-2 text-[13px] font-semibold rounded-xl px-4 py-2.5 border transition-all hover:opacity-80"
                    style={{
                      borderColor: `${ch.accent}35`,
                      color: ch.accent,
                      background: `${ch.accent}12`,
                    }}
                  >
                    Open in mail app →
                  </a>
                </div>
              </div>
            ))}
          </div>

          {/* ── Trading chart photo + social — side by side ─────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 mb-16">

            {/* Real photo accent */}
            <div className="relative rounded-2xl overflow-hidden min-h-[220px] border border-white/[0.07]">
              <img
                src="/contact-chart.jpg"
                alt="Crypto price chart"
                className="absolute inset-0 w-full h-full object-cover object-center"
                style={{ filter: "brightness(0.45) saturate(1.2)" }}
              />
              <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.15) 0%, transparent 60%)" }} />
              <div className="relative p-8 flex flex-col justify-end h-full">
                <p className="text-[28px] md:text-[34px] font-black text-white leading-tight mb-2">
                  Real-time data.<br />Real people behind it.
                </p>
                <p className="text-[14px] text-white/50 max-w-sm">
                  Every token, every trade, tracked live across pump.fun, PumpSwap, and Raydium LaunchLab.
                </p>
              </div>
            </div>

            {/* Socials */}
            <div className="flex flex-col gap-3">
              <p className="text-[11px] font-semibold tracking-[0.15em] uppercase text-muted-foreground/50 mb-1">
                Find us on social
              </p>
              {SOCIALS.map((s) => (
                <a
                  key={s.href}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-3 p-5 rounded-2xl border border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.05] hover:border-white/[0.12] transition-all group"
                >
                  <div className="flex items-center gap-3.5">
                    <div className="w-10 h-10 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-muted-foreground/60 group-hover:text-white transition-colors">
                      {s.icon}
                    </div>
                    <div>
                      <p className="text-[14px] font-semibold text-foreground">{s.label}</p>
                      <p className="text-[12px] text-muted-foreground/50">{s.handle}</p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground/25 group-hover:text-muted-foreground/60 transition-colors" />
                </a>
              ))}

              {/* Response time card */}
              <div className="mt-auto p-5 rounded-2xl border border-white/[0.07] bg-white/[0.02]">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <p className="text-[12px] font-semibold text-emerald-400/80">Currently active</p>
                </div>
                <p className="text-[13px] text-muted-foreground/60 leading-relaxed">
                  We check emails every weekday. Expect a reply within 24 hours — usually sooner for support issues.
                </p>
              </div>
            </div>
          </div>

          {/* ── FAQ ─────────────────────────────────────────────────── */}
          <div className="mb-16">
            <h2 className="text-[11px] font-semibold tracking-[0.15em] uppercase text-muted-foreground/50 mb-6">
              Common questions
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/[0.05] rounded-2xl overflow-hidden border border-white/[0.06]">
              {FAQ.map((item, i) => (
                <div key={i} className="bg-background p-6 hover:bg-white/[0.02] transition-colors">
                  <p className="text-[14px] font-semibold text-foreground mb-2">{item.q}</p>
                  <p className="text-[13px] text-muted-foreground/70 leading-relaxed">{item.a}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── Footer strip ─────────────────────────────────────────── */}
          <div className="pt-8 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-4">
            <span className="text-[12px] text-muted-foreground/40">
              © {new Date().getFullYear()} Pumpi · <a href="https://pumpi.io" className="hover:text-foreground/60 transition-colors">pumpi.io</a>
            </span>
            <div className="flex items-center gap-4 text-[12px] text-muted-foreground/40">
              {[["Privacy", "/privacy"], ["Terms", "/terms"], ["Disclaimer", "/disclaimer"]].map(([label, href]) => (
                <Link key={href} href={href} className="hover:text-foreground/60 transition-colors">{label}</Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
