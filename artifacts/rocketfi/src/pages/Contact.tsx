import { SEO } from "@/components/seo/SEO";
import { Link } from "wouter";
import {
  Mail, MessageCircle, Zap, Shield, HelpCircle,
  Twitter, Send, Globe, Clock, ChevronRight, ArrowUpRight,
} from "lucide-react";

const SITE_URL = "https://pumpi.io";

/* ─── Contact channels ────────────────────────────────────────────── */
const CHANNELS = [
  {
    email: "hello@pumpi.io",
    label: "General",
    badge: "Partnerships & Press",
    icon: <Globe className="w-5 h-5" />,
    color: "from-blue-500/20 to-indigo-500/10",
    border: "border-blue-500/20",
    iconBg: "bg-blue-500/15 border-blue-500/25",
    iconColor: "text-blue-400",
    badgeColor: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    description: "Business inquiries, media coverage, partnership proposals, and anything that doesn't fit the other categories.",
    topics: ["Business partnerships", "Media & press", "General feedback", "Feature suggestions"],
  },
  {
    email: "support@pumpi.io",
    label: "Support",
    badge: "User Help",
    icon: <HelpCircle className="w-5 h-5" />,
    color: "from-emerald-500/20 to-teal-500/10",
    border: "border-emerald-500/20",
    iconBg: "bg-emerald-500/15 border-emerald-500/25",
    iconColor: "text-emerald-400",
    badgeColor: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    description: "Account issues, token display problems, trading questions, and anything you need help with as a user of Pumpi.",
    topics: ["Account & login issues", "Token not showing", "Trade questions", "Bug reports"],
  },
];

/* ─── FAQ ──────────────────────────────────────────────────────────── */
const FAQ = [
  {
    q: "How quickly will I get a reply?",
    a: "We aim to respond within 24 hours on weekdays. Support queries typically get a faster turnaround.",
  },
  {
    q: "I found a security vulnerability — what should I do?",
    a: "Please email hello@pumpi.io with \"[SECURITY]\" in the subject line. Do not post security issues publicly.",
  },
  {
    q: "How do I report a scam or fraudulent token?",
    a: "Send the token address and a brief description to support@pumpi.io. Our team reviews all reports.",
  },
  {
    q: "My token doesn't appear on Pumpi. What can I do?",
    a: "Tokens are indexed automatically from pump.fun, PumpSwap, and Raydium LaunchLab. If yours is missing after 30 minutes, contact support with the mint address.",
  },
];

/* ─── Social links ─────────────────────────────────────────────────── */
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

/* ─── Helpers ──────────────────────────────────────────────────────── */
function Dot() {
  return <span className="inline-block w-1 h-1 rounded-full bg-muted-foreground/30" />;
}

export default function Contact() {
  return (
    <>
      <SEO
        title="Contact Us"
        description="Get in touch with the Pumpi team. Reach us for support, partnerships, press inquiries, and more."
      />

      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-3xl mx-auto px-5 py-10 md:py-14">

          {/* ── Header ─────────────────────────────────────────────── */}
          <div className="mb-12">
            {/* Icon */}
            <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-6">
              <Mail className="w-6 h-6 text-primary" />
            </div>

            <h1 className="text-[34px] md:text-[42px] font-black text-foreground tracking-tight leading-[1.1] mb-4">
              Get in touch
            </h1>
            <p className="text-[15px] text-muted-foreground leading-relaxed max-w-xl">
              We're a small team building the best Solana memecoin trading experience.
              We read every message and respond as fast as we can.
            </p>

            {/* Response time badge */}
            <div className="mt-5 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/20 bg-primary/5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[12px] font-medium text-muted-foreground">
                Typical response · <span className="text-foreground">within 24 hours</span>
              </span>
            </div>
          </div>

          {/* ── Email channels ──────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-12">
            {CHANNELS.map((ch) => (
              <div
                key={ch.email}
                className={`relative rounded-2xl border ${ch.border} bg-gradient-to-br ${ch.color} p-6 flex flex-col gap-5 overflow-hidden`}
              >
                {/* Top row */}
                <div className="flex items-start justify-between gap-3">
                  <div className={`w-10 h-10 rounded-xl border ${ch.iconBg} flex items-center justify-center ${ch.iconColor}`}>
                    {ch.icon}
                  </div>
                  <span className={`text-[11px] font-semibold px-2 py-1 rounded-full border ${ch.badgeColor}`}>
                    {ch.badge}
                  </span>
                </div>

                {/* Label + email */}
                <div>
                  <p className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-widest mb-1">
                    {ch.label}
                  </p>
                  <a
                    href={`mailto:${ch.email}`}
                    className="text-[17px] font-bold text-foreground hover:text-primary transition-colors break-all flex items-center gap-1.5 group"
                  >
                    {ch.email}
                    <ArrowUpRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </a>
                </div>

                {/* Description */}
                <p className="text-[13px] text-muted-foreground/80 leading-relaxed">
                  {ch.description}
                </p>

                {/* Topic pills */}
                <div className="flex flex-wrap gap-1.5">
                  {ch.topics.map((t) => (
                    <span
                      key={t}
                      className="text-[11px] px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-muted-foreground/70"
                    >
                      {t}
                    </span>
                  ))}
                </div>

                {/* CTA button */}
                <a
                  href={`mailto:${ch.email}`}
                  className={`mt-auto flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border ${ch.border} ${ch.iconBg} ${ch.iconColor} text-[13px] font-semibold hover:opacity-80 transition-opacity`}
                >
                  <Mail className="w-3.5 h-3.5" />
                  Send email
                </a>
              </div>
            ))}
          </div>

          {/* ── Social ──────────────────────────────────────────────── */}
          <div className="mb-12">
            <h2 className="text-[18px] font-bold mb-4">Find us on social</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {SOCIALS.map((s) => (
                <a
                  key={s.href}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-3 p-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.14] transition-all group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-muted-foreground/70 group-hover:text-foreground transition-colors">
                      {s.icon}
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-foreground">{s.label}</p>
                      <p className="text-[12px] text-muted-foreground/60">{s.handle}</p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
                </a>
              ))}
            </div>
          </div>

          {/* ── FAQ ─────────────────────────────────────────────────── */}
          <div className="mb-12">
            <h2 className="text-[18px] font-bold mb-5">Frequently asked</h2>
            <div className="space-y-3">
              {FAQ.map((item, i) => (
                <div
                  key={i}
                  className="p-5 rounded-2xl border border-white/[0.08] bg-white/[0.02]"
                >
                  <p className="text-[14px] font-semibold text-foreground mb-2">{item.q}</p>
                  <p className="text-[13px] text-muted-foreground/80 leading-relaxed">{item.a}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── Footer strip ─────────────────────────────────────────── */}
          <div className="pt-8 border-t border-white/[0.07] flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground/50">
              <span>© {new Date().getFullYear()} Pumpi</span>
              <Dot />
              <a href={SITE_URL} className="hover:text-foreground transition-colors">{SITE_URL}</a>
            </div>
            <div className="flex items-center gap-3 text-[12px] text-muted-foreground/50">
              <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
              <Dot />
              <Link href="/terms" className="hover:text-foreground transition-colors">Terms</Link>
              <Dot />
              <Link href="/disclaimer" className="hover:text-foreground transition-colors">Disclaimer</Link>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
