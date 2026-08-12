import { SEO } from "@/components/seo/SEO";
import { Link } from "wouter";
import { ArrowLeft, Shield, Lock, Eye, Trash2, Download } from "lucide-react";

const LAST_UPDATED = "August 12, 2026";
const EFFECTIVE_DATE = "August 12, 2026";
const VERSION = "1.0";
const CONTACT_EMAIL = "privacy@pumpi.io";
const SITE_URL = "https://pumpi.io";

const TOC = [
  { id: "s1",  label: "Information We Collect" },
  { id: "s2",  label: "How We Use Your Information" },
  { id: "s3",  label: "How We Share Your Information" },
  { id: "s4",  label: "Data Retention" },
  { id: "s5",  label: "Third-Party Services" },
  { id: "s6",  label: "Your Rights" },
  { id: "s7",  label: "Security" },
  { id: "s8",  label: "Cookies & Local Storage" },
  { id: "s9",  label: "Children's Privacy" },
  { id: "s10", label: "International Transfers" },
  { id: "s11", label: "Policy Changes" },
  { id: "s12", label: "Contact Us" },
];

export default function PrivacyPolicy() {
  return (
    <>
      <SEO title="Privacy Policy" description="How Pumpi collects, uses, and protects your information." />

      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-3xl mx-auto px-5 py-10 md:py-14">

          {/* Back */}
          <Link href="/" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors mb-10 group">
            <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
            Back to Pumpi
          </Link>

          {/* Header */}
          <div className="mb-10">
            <h1 className="text-[32px] md:text-[38px] font-black text-foreground tracking-tight leading-tight mb-4">
              Privacy Policy
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
              <span>Effective {EFFECTIVE_DATE}</span>
              <Dot />
              <span>Version {VERSION}</span>
              <Dot />
              <a href={SITE_URL} className="text-primary/80 hover:text-primary transition-colors">{SITE_URL}</a>
            </div>
          </div>

          {/* Key facts */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-10">
            <FactCard icon={<Lock className="w-4 h-4" />} title="We never sell your data" body="Your personal information is never sold to advertisers or third parties." />
            <FactCard icon={<Eye className="w-4 h-4" />} title="On-chain data is public" body="Wallet addresses and blockchain transactions are publicly visible by design." />
            <FactCard icon={<Trash2 className="w-4 h-4" />} title="You control your profile" body="Request deletion of your off-chain profile data at any time." />
          </div>

          {/* Table of contents */}
          <div className="mb-12 p-5 rounded-2xl border border-white/[0.08] bg-white/[0.02]">
            <p className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-widest mb-4">Contents</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5">
              {TOC.map((item, i) => (
                <a key={item.id} href={`#${item.id}`}
                  className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors text-[13px] text-muted-foreground hover:text-foreground group">
                  <span className="font-mono text-[11px] text-white/20 group-hover:text-white/40 tabular-nums w-5 shrink-0">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {item.label}
                </a>
              ))}
            </div>
          </div>

          {/* Intro */}
          <div className="mb-12 p-5 rounded-2xl bg-white/[0.03] border border-white/[0.07] text-[14px] leading-relaxed text-foreground/80 space-y-3">
            <p>
              Pumpi ("<strong className="text-foreground">we</strong>", "<strong className="text-foreground">our</strong>", or "<strong className="text-foreground">us</strong>") operates the Platform at{" "}
              <a href={SITE_URL} className="text-primary hover:underline">{SITE_URL}</a>.
              This Privacy Policy explains what information we collect, why we collect it, how we use it, and your choices.
            </p>
            <p>
              By accessing or using Pumpi you agree to this policy. If you do not agree, please discontinue use of the Platform.
            </p>
          </div>

          {/* Sections */}
          <div className="space-y-0 divide-y divide-white/[0.06]">

            <Section n={1} id="s1" title="Information We Collect">
              <Subsection title="1.1 — Information You Provide Directly">
                <p className="mb-4">The following personal data is collected only when you voluntarily provide it.</p>
                <LegalTable
                  headers={["Data Category", "What We Collect", "When Collected"]}
                  rows={[
                    ["Wallet Address", "Your Solana public key", "When you connect a wallet"],
                    ["Profile Information", "Username, bio, avatar image, Twitter/X handle, website URL", "When you create or edit a profile"],
                    ["Email Address", "Your email address", "When you sign up or sign in via email OTP"],
                    ["Google Account", "Name, email, and profile photo from Google", "When you use \"Sign in with Google\""],
                  ]}
                />
                <InfoBox>We never receive your wallet's private keys, seed phrases, or the ability to sign transactions on your behalf.</InfoBox>
              </Subsection>

              <Subsection title="1.2 — Information Collected Automatically">
                <LegalTable
                  headers={["Data Category", "What We Collect", "Purpose"]}
                  rows={[
                    ["Usage Data", "Pages visited, tokens viewed, searches performed, features used", "Platform improvement, analytics"],
                    ["Device & Browser", "IP address, browser type, OS, referring URL, device identifiers", "Security, fraud detection"],
                    ["Local Storage", "Session tokens, dismissed banners, wallet preferences", "Session management, preferences"],
                    ["On-Chain Data", "Token trades, wallet balances, transaction histories on Solana", "Platform display (this data is public by nature)"],
                  ]}
                />
              </Subsection>

              <Subsection title="1.3 — Information from Third Parties">
                <p>Data may be received from the following third-party sources when you interact with them through our Platform:</p>
                <ul className="mt-3 space-y-2">
                  <li><strong>Blockchain RPC Providers (Alchemy, PublicNode)</strong> — on-chain data queried on your behalf.</li>
                  <li><strong>Market Data APIs (Birdeye, DexScreener)</strong> — token price and market data.</li>
                  <li><strong>Google Identity Services</strong> — your Google profile when you sign in with Google.</li>
                </ul>
              </Subsection>
            </Section>

            <Section n={2} id="s2" title="How We Use Your Information">
              <p>We use the information we collect for the following purposes:</p>
              <ul className="mt-4 space-y-2">
                <li><strong>Platform operation</strong> — providing, maintaining, and improving the core service.</li>
                <li><strong>Authentication</strong> — verifying your identity and maintaining your session securely.</li>
                <li><strong>Profile display</strong> — showing your username, bio, and trading activity to other users (consistent with the public nature of blockchain data).</li>
                <li><strong>Security &amp; fraud prevention</strong> — detecting and investigating abuse, fraud, and unauthorized access.</li>
                <li><strong>Analytics</strong> — understanding how the Platform is used to improve performance and features.</li>
                <li><strong>Communications</strong> — sending security notices, authentication codes, and material policy updates. We do <strong>not</strong> send marketing emails without your explicit consent.</li>
                <li><strong>Legal compliance</strong> — fulfilling obligations under applicable laws and regulations.</li>
              </ul>
            </Section>

            <Section n={3} id="s3" title="How We Share Your Information">
              <p>We do <strong>not</strong> sell your personal information. We share data only in the following circumstances:</p>
              <div className="mt-4">
                <LegalTable
                  headers={["Recipient", "What Is Shared", "Basis"]}
                  rows={[
                    ["Other Platform users (public)", "Wallet address / username, profile details, on-chain trade history", "Public nature of blockchain data; your profile is visible by default"],
                    ["Infrastructure providers", "Data necessary to host, store, and operate the Platform", "Data processing agreements; processors act on our instructions only"],
                    ["Email delivery (Resend)", "Your email address and OTP codes", "Required for authentication"],
                    ["Law enforcement / courts", "Data required by valid legal process", "Legal obligation; we notify you where permitted by law"],
                    ["Acquirer / successor entity", "All data in the event of a merger or acquisition", "Legitimate interest; you will be notified of any change in controller"],
                  ]}
                />
              </div>
            </Section>

            <Section n={4} id="s4" title="Data Retention">
              <p>We retain personal data for as long as necessary to fulfil the purposes set out in this policy or as required by law.</p>
              <div className="mt-4">
                <LegalTable
                  headers={["Data Type", "Retention Period", "Notes"]}
                  rows={[
                    ["Profile data (username, bio, avatar)", "Until you request deletion", "Deletable via email request"],
                    ["Email address", "Until account deletion", "Retained for auth purposes"],
                    ["Google login data", "Until account deletion", "Retained for auth purposes"],
                    ["Usage & analytics logs", "90 days rolling", "Aggregated after 90 days"],
                    ["Security & fraud logs", "12 months", "May be retained longer if an incident is open"],
                    ["On-chain transaction data", "Permanent", "Public blockchain data; cannot be deleted by Pumpi or by you"],
                  ]}
                />
              </div>
              <p className="mt-4">
                To request deletion of your off-chain profile data, email{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>.
                We respond within 30 days. Deletion of your profile does not remove your wallet's on-chain history.
              </p>
            </Section>

            <Section n={5} id="s5" title="Third-Party Services">
              <p>The Platform relies on the following third-party services. Each has its own privacy policy governing their use of data.</p>
              <div className="mt-4">
                <LegalTable
                  headers={["Service", "Role", "Data Exposed", "Privacy Policy"]}
                  rows={[
                    ["Alchemy", "Solana RPC provider", "IP address, wallet addresses in queries", "alchemy.com/policies/privacy"],
                    ["PublicNode", "Fallback Solana RPC", "IP address, wallet addresses in queries", "publicnode.com"],
                    ["Birdeye", "Token market data API", "Token contract addresses", "birdeye.so/privacy"],
                    ["DexScreener", "DEX price & liquidity data", "Token contract addresses", "dexscreener.com/privacy"],
                    ["Google (GSI)", "OAuth 2.0 sign-in", "Your Google account email, name, photo", "policies.google.com/privacy"],
                    ["Resend", "Transactional email delivery", "Your email address and OTP message content", "resend.com/legal/privacy-policy"],
                  ]}
                />
              </div>
            </Section>

            <Section n={6} id="s6" title="Your Rights">
              <p>Depending on your jurisdiction, you may have the following rights over your personal data.</p>
              <div className="mt-4">
                <LegalTable
                  headers={["Right", "Description", "How to Exercise", "Response Time"]}
                  rows={[
                    ["Access", "Obtain a copy of the personal data we hold about you", `Email ${CONTACT_EMAIL}`, "30 days"],
                    ["Correction", "Have inaccurate or incomplete data corrected", "Update your profile, or email us", "30 days"],
                    ["Deletion", "Request removal of your off-chain profile and associated data", `Email ${CONTACT_EMAIL}`, "30 days"],
                    ["Restriction", "Ask us to limit processing in certain circumstances", `Email ${CONTACT_EMAIL}`, "30 days"],
                    ["Portability", "Receive your data in a structured, machine-readable format", `Email ${CONTACT_EMAIL}`, "30 days"],
                    ["Objection", "Object to processing based on legitimate interests", `Email ${CONTACT_EMAIL}`, "30 days"],
                  ]}
                />
              </div>
              <InfoBox>Exercising these rights does not affect the public on-chain data associated with your wallet address, which exists independently on the Solana blockchain.</InfoBox>
            </Section>

            <Section n={7} id="s7" title="Security">
              <p>
                We implement industry-standard technical and organisational measures to protect your information:
              </p>
              <ul className="mt-3 space-y-2">
                <li><strong>Encryption in transit</strong> — all data transmitted between your browser and our servers is encrypted via HTTPS/TLS.</li>
                <li><strong>Token security</strong> — authentication tokens (JWTs) are signed with a secret key and expire after a fixed period.</li>
                <li><strong>Access controls</strong> — only authorised personnel have access to production systems, under least-privilege principles.</li>
                <li><strong>No private key access</strong> — we architecturally cannot access your wallet's private key or seed phrase at any time.</li>
              </ul>
              <p className="mt-4">
                No system is completely secure. You are responsible for maintaining the security of your wallet and credentials.
                If you believe your account has been compromised, contact us immediately at{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>.
              </p>
            </Section>

            <Section n={8} id="s8" title="Cookies & Local Storage">
              <p>We use browser storage (not traditional cookies) to operate the Platform. No cross-site advertising trackers are used.</p>
              <div className="mt-4">
                <LegalTable
                  headers={["Storage Type", "What Is Stored", "Deletable"]}
                  rows={[
                    ["localStorage – Authentication", "JWT token for social sign-in (email / Google)", "Yes — clear browser storage or sign out"],
                    ["localStorage – Preferences", "Dismissed banners, UI preferences, risk acknowledgment", "Yes — clear browser storage"],
                    ["localStorage – Wallet", "Last connected wallet adapter preference", "Yes — clear browser storage"],
                    ["sessionStorage", "Temporary page state during your browsing session", "Yes — cleared automatically on tab close"],
                  ]}
                />
              </div>
              <p className="mt-4">You can clear all browser storage at any time through your browser settings, which will sign you out and reset preferences.</p>
            </Section>

            <Section n={9} id="s9" title="Children's Privacy">
              <p>
                The Platform is not directed to individuals under the age of 18. We do not knowingly collect personal
                information from minors. If you believe a minor has provided us with personal data, please contact us
                at <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a> and
                we will take steps to delete it promptly.
              </p>
            </Section>

            <Section n={10} id="s10" title="International Data Transfers">
              <p>
                Our infrastructure and service providers may be located in multiple jurisdictions, including the United States
                and the European Union. By using the Platform, you acknowledge that your information may be transferred to
                and processed in countries with data protection laws that differ from your country of residence.
              </p>
              <p className="mt-3">
                Where required by applicable law, we implement appropriate safeguards for such transfers, including standard
                contractual clauses or equivalent mechanisms.
              </p>
            </Section>

            <Section n={11} id="s11" title="Policy Changes">
              <p>
                We may update this Privacy Policy periodically. When we make material changes, we will post the revised
                policy on this page and update the "Effective" date above. Your continued use of the Platform after the
                effective date of a revised policy constitutes your acceptance of the changes.
              </p>
              <p className="mt-3">
                For significant changes affecting how we use your personal data, we will provide additional notice
                (such as a banner on the Platform or an email notification where we hold your email address).
              </p>
            </Section>

            <Section n={12} id="s12" title="Contact Us">
              <p>For questions, requests, or concerns about this Privacy Policy or your personal data:</p>
              <ContactCard email={CONTACT_EMAIL} site={SITE_URL} />
            </Section>

          </div>

          {/* Footer nav */}
          <LegalFooter current="privacy" />
        </div>
      </div>
    </>
  );
}

/* ─── Shared primitives ─────────────────────────────────── */

function Dot() {
  return <span className="w-1 h-1 rounded-full bg-white/20 inline-block" />;
}

function FactCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="p-4 rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mb-3">
        {icon}
      </div>
      <p className="text-[13px] font-semibold text-foreground mb-1">{title}</p>
      <p className="text-[12px] text-muted-foreground leading-snug">{body}</p>
    </div>
  );
}

function Section({ n, id, title, children }: { n: number; id: string; title: string; children: React.ReactNode }) {
  return (
    <div id={id} className="py-10">
      <div className="mb-6">
        <span className="text-[44px] font-black leading-none text-white/[0.18] select-none tabular-nums block mb-2">
          {String(n).padStart(2, "0")}
        </span>
        <h2 className="text-[19px] font-bold text-foreground">{title}</h2>
      </div>
      <div className="space-y-4 text-[14px] leading-relaxed text-foreground/80 [&_strong]:text-foreground/95 [&_a]:text-primary [&_a:hover]:underline [&_ul]:space-y-2.5 [&_li]:relative [&_li]:pl-4 [&_li]:before:absolute [&_li]:before:left-0 [&_li]:before:top-[0.52em] [&_li]:before:w-[5px] [&_li]:before:h-[5px] [&_li]:before:rounded-full [&_li]:before:bg-white/25">
        {children}
      </div>
    </div>
  );
}

function Subsection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-[13px] font-semibold text-foreground/60 uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function LegalTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/[0.08] mb-2">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr className="bg-white/[0.04] border-b border-white/[0.08]">
            {headers.map((h) => (
              <th key={h} className="text-left px-4 py-3 text-foreground/70 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-white/[0.05] last:border-0 hover:bg-white/[0.02] transition-colors">
              {row.map((cell, j) => (
                <td key={j} className={`px-4 py-3 text-foreground/75 align-top leading-snug ${j === 0 ? "font-medium text-foreground/90 whitespace-nowrap" : ""}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex gap-3 p-4 rounded-xl bg-primary/[0.06] border border-primary/20">
      <div className="w-1 rounded-full bg-primary/40 shrink-0 self-stretch" />
      <p className="text-[13px] text-foreground/75 leading-snug">{children}</p>
    </div>
  );
}

function ContactCard({ email, site }: { email: string; site: string }) {
  return (
    <div className="mt-4 p-5 rounded-2xl border border-white/[0.10] bg-white/[0.03] flex flex-col gap-3">
      <p className="text-[15px] font-bold text-foreground">Pumpi</p>
      <div className="space-y-1.5 text-[13px]">
        <p className="text-muted-foreground">
          Email:{" "}
          <a href={`mailto:${email}`} className="text-primary hover:underline font-medium">{email}</a>
        </p>
        <p className="text-muted-foreground">
          Website:{" "}
          <a href={site} className="text-primary hover:underline font-medium">{site}</a>
        </p>
      </div>
      <p className="text-[12px] text-muted-foreground/60">We aim to respond to all privacy-related requests within 30 days.</p>
    </div>
  );
}

function LegalFooter({ current }: { current: "privacy" | "disclaimer" | "terms" }) {
  const links = [
    { href: "/privacy", label: "Privacy Policy", key: "privacy" },
    { href: "/disclaimer", label: "Disclaimer", key: "disclaimer" },
    { href: "/terms", label: "Terms of Service", key: "terms" },
  ];
  return (
    <div className="mt-16 pt-8 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap gap-5">
        {links
          .filter((l) => l.key !== current)
          .map((l) => (
            <Link key={l.key} href={l.href} className="text-[13px] text-muted-foreground hover:text-foreground transition-colors">
              {l.label}
            </Link>
          ))}
      </div>
      <Link href="/" className="text-[13px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Pumpi
      </Link>
    </div>
  );
}
