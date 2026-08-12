import { useEffect } from "react";
import { SEO } from "@/components/seo/SEO";
import { Link } from "wouter";
import { ArrowLeft, FileText } from "lucide-react";

const LAST_UPDATED = "August 12, 2026";
const EFFECTIVE_DATE = "August 12, 2026";
const VERSION = "1.0";
const CONTACT_EMAIL = "legal@pumpi.io";
const SITE_URL = "https://pumpi.io";

const TOC = [
  { id: "s1",  label: "Agreement to Terms" },
  { id: "s2",  label: "Eligibility" },
  { id: "s3",  label: "Account Registration & Wallets" },
  { id: "s4",  label: "Acceptable Use" },
  { id: "s5",  label: "Prohibited Conduct" },
  { id: "s6",  label: "Content & Intellectual Property" },
  { id: "s7",  label: "Platform Fees" },
  { id: "s8",  label: "Service Modifications & Availability" },
  { id: "s9",  label: "Termination & Suspension" },
  { id: "s10", label: "Limitation of Liability" },
  { id: "s11", label: "Indemnification" },
  { id: "s12", label: "Dispute Resolution" },
  { id: "s13", label: "Governing Law" },
  { id: "s14", label: "Changes to These Terms" },
  { id: "s15", label: "Miscellaneous" },
  { id: "s16", label: "Contact Us" },
];

export default function TermsOfService() {
  useEffect(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = 0;
  }, []);

  return (
    <>
      <SEO title="Terms of Service" description="Terms and conditions governing your use of the Pumpi platform." />

      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-3xl mx-auto px-5 py-10 md:py-14">


          {/* Header */}
          <div className="mb-10">
            <h1 className="text-[32px] md:text-[38px] font-black text-foreground tracking-tight leading-tight mb-4">
              Terms of Service
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
              <span>Effective {EFFECTIVE_DATE}</span>
              <Dot />
              <span>Version {VERSION}</span>
              <Dot />
              <a href={SITE_URL} className="text-primary/80 hover:text-primary transition-colors">{SITE_URL}</a>
            </div>
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
              These Terms of Service ("<strong className="text-foreground">Terms</strong>") constitute a legally binding
              agreement between you and Pumpi ("<strong className="text-foreground">we</strong>",{" "}
              "<strong className="text-foreground">our</strong>", or "<strong className="text-foreground">us</strong>"),
              governing your access to and use of the Platform at{" "}
              <a href={SITE_URL} className="text-primary hover:underline">{SITE_URL}</a>.
            </p>
            <p>
              By accessing or using the Platform you confirm that you have read, understood, and agree to be bound by
              these Terms. If you do not agree, do not use the Platform.
            </p>
            <p className="text-[13px] text-muted-foreground">
              Please also read our{" "}
              <Link href="/privacy" className="text-primary hover:underline">Privacy Policy</Link> and{" "}
              <Link href="/disclaimer" className="text-primary hover:underline">Disclaimer</Link>,
              which are incorporated into these Terms by reference.
            </p>
          </div>

          {/* Sections */}
          <div className="space-y-0 divide-y divide-white/[0.06]">

            <Section n={1} id="s1" title="Agreement to Terms">
              <p>
                By creating an account, connecting a wallet, or otherwise accessing the Platform, you agree to these Terms
                and to our Privacy Policy and Disclaimer. If you are using the Platform on behalf of an organisation, you
                represent that you have the authority to bind that organisation to these Terms.
              </p>
            </Section>

            <Section n={2} id="s2" title="Eligibility">
              <p>You may use the Platform only if you meet all of the following requirements:</p>
              <ul className="mt-3 space-y-2">
                <li>You are at least 18 years of age, or the age of majority in your jurisdiction if higher.</li>
                <li>You have full legal capacity to enter into and be bound by these Terms.</li>
                <li>Your use of the Platform complies with all applicable laws and regulations in your jurisdiction.</li>
                <li>You are not located in, or a citizen or resident of, any jurisdiction where cryptocurrency trading is prohibited, restricted, or requires a licence that Pumpi does not hold.</li>
                <li>You are not subject to any government sanctions or included on any list of prohibited or restricted parties.</li>
              </ul>
              <p className="mt-3">
                If you do not meet all of these requirements, you must not access or use the Platform. We reserve the right
                to verify eligibility and to refuse access to any person or jurisdiction at our discretion.
              </p>
            </Section>

            <Section n={3} id="s3" title="Account Registration & Wallets">
              <Subsection title="3.1 — Account Creation">
                <p>
                  You may use the Platform as a guest (read-only) or by connecting a Solana wallet and optionally creating
                  a profile. Profiles may also be created via Google or email sign-in. You agree to provide accurate,
                  current, and complete information and to keep your profile information up to date.
                </p>
              </Subsection>
              <Subsection title="3.2 — Wallet Security">
                <p>
                  You are solely responsible for the security of your wallet, private keys, and seed phrases. Pumpi has
                  no ability to recover lost wallet access, reverse on-chain transactions, or retrieve funds sent to
                  incorrect addresses. Never share your private key or seed phrase with any party, including Pumpi.
                </p>
              </Subsection>
              <Subsection title="3.3 — Account Responsibility">
                <p>
                  You are responsible for all activity that occurs under your account or through your connected wallet.
                  If you believe your account has been compromised, disconnect your wallet immediately and contact us at{" "}
                  <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>.
                </p>
              </Subsection>
            </Section>

            <Section n={4} id="s4" title="Acceptable Use">
              <p>You may use the Platform only for lawful purposes consistent with these Terms and applicable law. Permitted uses include:</p>
              <ul className="mt-3 space-y-2">
                <li>Viewing token information, price data, charts, and market statistics.</li>
                <li>Creating and managing a personal profile.</li>
                <li>Initiating cryptocurrency trades through your own connected wallet.</li>
                <li>Creating and launching tokens through supported protocols (pump.fun, Raydium LaunchLab).</li>
                <li>Participating in community features (comments, leaderboards) in a respectful manner.</li>
              </ul>
            </Section>

            <Section n={5} id="s5" title="Prohibited Conduct">
              <p>The following conduct is strictly prohibited and may result in immediate account suspension or termination, as well as referral to law enforcement.</p>
              <div className="mt-4">
                <LegalTable
                  headers={["Category", "Prohibited Actions"]}
                  rows={[
                    ["Market Manipulation", "Wash trading, pump-and-dump schemes, spoofing, layering, front-running other users, or any other deceptive trading practice"],
                    ["Fraud & Deception", "Creating fake or deceptive tokens, impersonating other users or projects, providing materially false information, phishing, or any conduct intended to mislead users"],
                    ["Illegal Activity", "Money laundering, terrorist financing, tax evasion, sanctions evasion, or any use of the Platform for illegal purposes"],
                    ["Platform Abuse", "Systematic scraping or crawling without written permission, use of bots or automated tools that place excessive load on infrastructure, DDoS attacks"],
                    ["Security Violations", "Attempting unauthorised access to accounts, systems, or data; injecting malicious code, viruses, or exploits; probing for vulnerabilities without authorisation"],
                    ["Spam & Harassment", "Posting spam, unsolicited advertising, hate speech, or content that harasses, threatens, intimidates, or harms other users"],
                    ["IP Infringement", "Uploading or distributing content that infringes third-party copyrights, trademarks, or other intellectual property rights"],
                    ["Circumvention", "Attempting to bypass rate limits, access controls, geographic restrictions, or other Platform safeguards"],
                  ]}
                />
              </div>
            </Section>

            <Section n={6} id="s6" title="Content & Intellectual Property">
              <Subsection title="6.1 — Our Content">
                <p>
                  The Platform and its original content, features, design, and functionality are owned by Pumpi and protected
                  by applicable intellectual property laws. You may not copy, modify, distribute, sell, or lease any part
                  of the Platform without our express written permission.
                </p>
              </Subsection>
              <Subsection title="6.2 — User-Submitted Content">
                <p>
                  By submitting content — including token metadata, profile information, images, usernames, and descriptions —
                  you grant Pumpi a non-exclusive, worldwide, royalty-free licence to use, display, reproduce, and distribute
                  that content in connection with operating the Platform.
                </p>
                <p className="mt-2">
                  You represent that you own or have the necessary rights to submit such content, and that it does not violate
                  any third-party rights or applicable laws. We reserve the right to remove any content that violates these Terms
                  or that we find objectionable, at our sole discretion and without notice.
                </p>
              </Subsection>
              <Subsection title="6.3 — On-Chain Data">
                <p>
                  Data originating on the Solana blockchain (transaction histories, wallet balances, token trades) is public
                  by nature. This information cannot be modified or deleted by Pumpi and is not subject to our content policies.
                </p>
              </Subsection>
            </Section>

            <Section n={7} id="s7" title="Platform Fees">
              <p>
                Pumpi may charge fees on certain transactions. All fees are disclosed in the trading interface prior to
                confirmation. By confirming a transaction, you agree to the fees displayed at that time.
              </p>
              <div className="mt-4">
                <LegalTable
                  headers={["Fee Type", "Rate", "Applies To", "Notes"]}
                  rows={[
                    ["Platform referral fee", "0.25%", "pump.fun trades via Pumpi", "Collected by the pump.fun protocol and attributed to Pumpi's referral address"],
                    ["Platform referral fee", "0.25%", "Raydium LaunchLab trades", "Collected by the Raydium protocol and attributed to Pumpi's referral address"],
                    ["Network fee (gas)", "Variable", "All on-chain transactions", "Paid to the Solana network; not controlled by Pumpi"],
                    ["Token creation fee", "Protocol-set", "New token launches", "Set by pump.fun or Raydium; subject to change by those protocols"],
                  ]}
                />
              </div>
              <p className="mt-3">
                Fees are subject to change. Updated fees will be reflected in the trading interface and in revised Terms.
                Blockchain network fees are set by the Solana network and are entirely outside Pumpi's control.
              </p>
            </Section>

            <Section n={8} id="s8" title="Service Modifications & Availability">
              <p>
                Pumpi reserves the right to modify, suspend, or discontinue the Platform or any part of it at any time,
                with or without notice. This includes changes to supported protocols, listed tokens, features, and APIs.
              </p>
              <p className="mt-3">
                We do not guarantee Platform availability at any particular time. Planned maintenance, unplanned outages,
                blockchain network issues, third-party API failures, or regulatory requirements may result in downtime or
                feature restrictions. Pumpi shall not be liable for any loss resulting from Platform unavailability.
              </p>
            </Section>

            <Section n={9} id="s9" title="Termination & Suspension">
              <Subsection title="9.1 — By Pumpi">
                <p>
                  We may suspend or terminate your access to the Platform at any time, with or without cause and with or
                  without notice, including if we reasonably believe you have violated these Terms, engaged in fraudulent
                  activity, or pose a risk to other users or Platform integrity.
                </p>
              </Subsection>
              <Subsection title="9.2 — By You">
                <p>
                  You may stop using the Platform at any time. To delete your profile and off-chain data, contact us at{" "}
                  <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>.
                  Deletion of your profile does not affect your on-chain transaction history, which is permanently recorded
                  on the Solana blockchain.
                </p>
              </Subsection>
              <Subsection title="9.3 — Survival">
                <p>
                  Provisions that by their nature should survive termination — including intellectual property rights,
                  limitation of liability, indemnification, dispute resolution, and governing law — remain in effect
                  after termination of your access.
                </p>
              </Subsection>
            </Section>

            <Section n={10} id="s10" title="Limitation of Liability">
              <p>
                To the maximum extent permitted by applicable law, Pumpi and its operators, directors, employees, and
                agents shall not be liable for any indirect, incidental, special, consequential, or punitive damages,
                including but not limited to loss of profits, data, goodwill, or other intangible losses, arising from:
              </p>
              <ul className="mt-3 space-y-2">
                <li>Your use of or inability to use the Platform.</li>
                <li>Any trading decisions, investment losses, or financial damages arising from use of the Platform.</li>
                <li>Unauthorised access to or alteration of your wallet or data.</li>
                <li>Third-party conduct, content, or services accessible through or referenced by the Platform.</li>
                <li>Smart contract vulnerabilities, blockchain network failures, or protocol changes.</li>
                <li>Platform downtime, data inaccuracies, or service interruptions.</li>
              </ul>
              <div className="mt-4 p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] text-[13px] text-foreground/70">
                The Platform is provided on an <strong className="text-foreground">"as is"</strong> and{" "}
                <strong className="text-foreground">"as available"</strong> basis. Pumpi expressly disclaims all warranties,
                express or implied, including merchantability, fitness for a particular purpose, and non-infringement.
                In jurisdictions that do not allow exclusion of certain warranties, our liability shall be limited to the
                greatest extent permitted by law.
              </div>
            </Section>

            <Section n={11} id="s11" title="Indemnification">
              <p>
                You agree to indemnify, defend, and hold harmless Pumpi and its operators, directors, employees, and
                agents from any claims, liabilities, damages, losses, costs, and expenses (including reasonable legal fees)
                arising out of or in connection with:
              </p>
              <ul className="mt-3 space-y-2">
                <li>Your use of or access to the Platform.</li>
                <li>Your violation of these Terms or any applicable law.</li>
                <li>Your trading activity or reliance on information displayed on the Platform.</li>
                <li>Content you submit, post, or transmit through the Platform.</li>
                <li>Your infringement of any third party's rights.</li>
              </ul>
            </Section>

            <Section n={12} id="s12" title="Dispute Resolution">
              <Subsection title="12.1 — Informal Resolution First">
                <p>
                  Before initiating any formal legal action, you agree to contact us at{" "}
                  <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a> and
                  give us 30 days to attempt informal resolution of the dispute.
                </p>
              </Subsection>
              <Subsection title="12.2 — Binding Arbitration">
                <p>
                  If informal resolution fails, disputes shall be resolved by binding arbitration rather than in court,
                  except that you may bring claims in small claims court if they qualify. You waive your right to a jury
                  trial and to participate in class-action lawsuits or class-wide arbitration.
                </p>
              </Subsection>
              <Subsection title="12.3 — No Class Actions">
                <p>
                  Any dispute shall be resolved on an individual basis. No arbitration or proceeding shall be joined with
                  any other claim, and no class action or representative proceeding is permitted, to the fullest extent
                  allowed by applicable law.
                </p>
              </Subsection>
            </Section>

            <Section n={13} id="s13" title="Governing Law">
              <p>
                These Terms shall be governed by and construed in accordance with applicable law, without regard to
                conflict-of-law principles. To the extent that arbitration does not apply and litigation is required,
                you consent to the exclusive jurisdiction of competent courts in the applicable jurisdiction.
              </p>
            </Section>

            <Section n={14} id="s14" title="Changes to These Terms">
              <p>
                We may update these Terms from time to time. When we make material changes, we will update the effective date
                above and, where appropriate, provide additional notice (such as a banner on the Platform). Your continued
                use of the Platform after the effective date of revised Terms constitutes your acceptance of the changes.
              </p>
              <p className="mt-3">
                If you do not agree to revised Terms, you must stop using the Platform before the effective date of the changes.
              </p>
            </Section>

            <Section n={15} id="s15" title="Miscellaneous">
              <LegalTable
                headers={["Provision", "Description"]}
                rows={[
                  ["Entire Agreement", "These Terms, together with the Privacy Policy and Disclaimer, constitute the entire agreement between you and Pumpi regarding your use of the Platform and supersede all prior agreements."],
                  ["Severability", "If any provision of these Terms is found to be invalid or unenforceable, the remaining provisions continue in full force and effect."],
                  ["Waiver", "Failure by Pumpi to enforce any provision of these Terms on any occasion does not constitute a waiver of that provision or our right to enforce it in the future."],
                  ["Assignment", "You may not assign or transfer these Terms or your rights under them without our prior written consent. Pumpi may assign its rights and obligations freely."],
                  ["No Partnership", "Nothing in these Terms creates a partnership, agency, joint venture, franchise, or employment relationship between you and Pumpi."],
                  ["Notices", "We may provide notices to you via the Platform, email (if provided), or other reasonable means. Notices to us must be sent to the contact details below."],
                ]}
              />
            </Section>

            <Section n={16} id="s16" title="Contact Us">
              <p>Questions about these Terms of Service? Reach us at:</p>
              <ContactCard email={CONTACT_EMAIL} site={SITE_URL} />
            </Section>

          </div>

          {/* Footer nav */}
          <LegalFooter current="terms" />
        </div>
      </div>
    </>
  );
}

/* ─── Shared primitives ─────────────────────────────────── */

function Dot() {
  return <span className="w-1 h-1 rounded-full bg-white/20 inline-block" />;
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
    <div className="mb-5">
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
