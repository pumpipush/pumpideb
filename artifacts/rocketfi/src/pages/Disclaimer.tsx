import { SEO } from "@/components/seo/SEO";
import { Link } from "wouter";
import { ArrowLeft, TriangleAlert } from "lucide-react";

/** Bump this string whenever the Disclaimer content changes materially.
 *  All users who acknowledged an older version will be re-prompted on their next trade.
 *  NOTE: the legacy hardcoded key was risk_ack_v1_<wallet>; this starts at "2" so that
 *  all existing users are re-prompted at least once after the versioning system is introduced. */
export const DISCLAIMER_VERSION = "2";

const LAST_UPDATED = "August 12, 2025";
const EFFECTIVE_DATE = "August 12, 2025";
const VERSION = "1.0";
const CONTACT_EMAIL = "legal@pumpi.io";
const SITE_URL = "https://pumpi.io";

const TOC = [
  { id: "s1",  label: "Not Financial or Investment Advice" },
  { id: "s2",  label: "Risk Summary" },
  { id: "s3",  label: "Memecoin & Speculative Asset Risks" },
  { id: "s4",  label: "No Guarantee of Accuracy" },
  { id: "s5",  label: "Smart Contract & Blockchain Risks" },
  { id: "s6",  label: "No Endorsement of Tokens" },
  { id: "s7",  label: "Third-Party Services" },
  { id: "s8",  label: "Regulatory Compliance" },
  { id: "s9",  label: "Tax Obligations" },
  { id: "s10", label: "Limitation of Liability" },
  { id: "s11", label: "Indemnification" },
  { id: "s12", label: "Changes to This Disclaimer" },
  { id: "s13", label: "Governing Law" },
  { id: "s14", label: "Contact" },
];

export default function Disclaimer() {
  return (
    <>
      <SEO title="Disclaimer" description="Important risk disclosures and disclaimers for using Pumpi." />

      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-3xl mx-auto px-5 py-10 md:py-14">

          {/* Back */}
          <Link href="/" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors mb-10 group">
            <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
            Back to Pumpi
          </Link>

          {/* Header */}
          <div className="mb-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-[11px] font-mono tracking-widest text-amber-400/70 uppercase mb-5">
              <TriangleAlert className="w-3 h-3" />
              Legal — Risk Disclaimer
            </div>
            <h1 className="text-[32px] md:text-[38px] font-black text-foreground tracking-tight leading-tight mb-4">
              Disclaimer
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
              <span>Effective {EFFECTIVE_DATE}</span>
              <Dot />
              <span>Version {VERSION}</span>
              <Dot />
              <a href={SITE_URL} className="text-primary/80 hover:text-primary transition-colors">{SITE_URL}</a>
            </div>
          </div>

          {/* High-risk warning banner */}
          <div className="mb-10 p-5 rounded-2xl bg-amber-500/[0.08] border border-amber-500/25">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center shrink-0 mt-0.5">
                <TriangleAlert className="w-4.5 h-4.5 text-amber-400" />
              </div>
              <div>
                <p className="text-[14px] font-bold text-amber-300 mb-1">High-Risk Activity Warning</p>
                <p className="text-[13px] text-amber-200/75 leading-relaxed">
                  Trading, buying, or holding memecoins and other crypto assets involves extreme risk of financial loss,
                  including the <strong className="text-amber-200">total loss of all invested capital</strong>.
                  This platform does not provide financial advice. Only use funds you can afford to lose entirely.
                </p>
              </div>
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
          <div className="mb-12 p-5 rounded-2xl bg-white/[0.03] border border-white/[0.07] text-[14px] leading-relaxed text-foreground/80">
            <p>
              Please read this Disclaimer carefully before using Pumpi ("<strong className="text-foreground">Platform</strong>"),
              operated at <a href={SITE_URL} className="text-primary hover:underline">{SITE_URL}</a>.
              By accessing or using the Platform, you acknowledge that you have read, understood, and agree to be bound by
              all terms and conditions set forth herein. If you do not agree, you must not use the Platform.
            </p>
          </div>

          {/* Sections */}
          <div className="space-y-0 divide-y divide-white/[0.06]">

            <Section n={1} id="s1" title="Not Financial or Investment Advice">
              <p>
                Nothing on the Platform — including token listings, price data, charts, trade histories, trending rankings,
                community comments, or any other content — constitutes financial advice, investment advice, trading advice,
                or any other type of professional advice. All content is provided for{" "}
                <strong>informational and educational purposes only</strong>.
              </p>
              <p>
                Pumpi does not recommend that any cryptocurrency or digital asset should be bought, sold, held, or traded.
                You should conduct your own independent research and consult a qualified financial adviser before making any
                investment decisions. Past performance of any token or asset is not indicative of future results.
              </p>
            </Section>

            <Section n={2} id="s2" title="Risk Summary">
              <p>The table below summarises the principal risk categories associated with using this Platform.</p>
              <div className="mt-4">
                <LegalTable
                  headers={["Risk Category", "Description", "Severity"]}
                  rows={[
                    ["Extreme Price Volatility", "Token prices can decline 50–100% within minutes or hours", "CRITICAL"],
                    ["Rug Pulls & Fraud", "Developers may drain liquidity or abandon projects at any time", "CRITICAL"],
                    ["Total Loss of Capital", "You may lose all funds invested in any token", "CRITICAL"],
                    ["No Underlying Value", "Memecoins are purely speculative with no revenue or utility", "HIGH"],
                    ["Smart Contract Bugs", "Code vulnerabilities in DEX or token programs may drain funds", "HIGH"],
                    ["Low Liquidity", "Thin markets make exiting positions difficult or impossible", "HIGH"],
                    ["Market Manipulation", "Pump-and-dump and wash trading are common in memecoin markets", "HIGH"],
                    ["MEV / Slippage", "Trades may execute at worse prices than quoted due to MEV or slippage", "MEDIUM"],
                    ["Regulatory Risk", "Legal status of crypto trading varies and may change by jurisdiction", "MEDIUM"],
                    ["Tax Obligations", "Crypto transactions may generate taxable events in your jurisdiction", "MEDIUM"],
                  ]}
                  renderCell={(cell, col) => {
                    if (col === 2) return <SeverityBadge level={cell as any} />;
                    return null;
                  }}
                />
              </div>
            </Section>

            <Section n={3} id="s3" title="Memecoin & Speculative Asset Risks">
              <p>
                Memecoins and other speculative tokens carry risks substantially greater than traditional investments.
                By using this Platform you acknowledge each of the following:
              </p>
              <ul className="mt-3 space-y-2.5">
                <li><strong>Extreme Volatility.</strong> Token prices can lose 50–100% of their value within minutes or hours. Large gains and total losses are both possible and common.</li>
                <li><strong>Rug Pulls &amp; Scams.</strong> Token developers may abandon projects, drain liquidity pools, or engage in fraudulent activity at any time without warning. Pumpi does not verify, endorse, or vet any token or its creators.</li>
                <li><strong>No Underlying Value.</strong> Many memecoins have no underlying business, revenue stream, or utility. Their value is driven purely by market sentiment and speculation.</li>
                <li><strong>Low Liquidity.</strong> Many tokens have thin order books or shallow liquidity pools. Large orders can move prices significantly, and exiting a position may be difficult or impossible at desired prices.</li>
                <li><strong>Market Manipulation.</strong> Coordinated pump-and-dump schemes, wash trading, and other manipulative practices are widespread in memecoin markets.</li>
                <li><strong>Total Loss of Capital.</strong> You may lose every cent invested in any token. Never invest more than you can afford to lose entirely, and never invest borrowed funds.</li>
              </ul>
            </Section>

            <Section n={4} id="s4" title="No Guarantee of Accuracy">
              <p>
                Pumpi aggregates data from third-party sources including blockchain RPCs, DEX APIs, and market data providers.
                While we strive for accuracy, we make <strong>no representations or warranties</strong>, express or implied,
                regarding the accuracy, completeness, reliability, timeliness, or availability of any information on the Platform.
              </p>
              <ul className="mt-3 space-y-2">
                <li>Price data, market capitalisation figures, and trading volumes are estimates that may differ from other sources.</li>
                <li>Token metadata (names, logos, descriptions) is user-submitted or third-party sourced and may be inaccurate or deliberately misleading.</li>
                <li>Technical errors, delays, or API outages may result in incorrect or missing data.</li>
                <li>Pumpi accepts no responsibility for any errors, omissions, or inaccuracies in data displayed.</li>
              </ul>
            </Section>

            <Section n={5} id="s5" title="Smart Contract & Blockchain Risks">
              <p>
                Transactions executed through the Platform interact with smart contracts on the Solana blockchain.
                You acknowledge the following risks specific to on-chain activity:
              </p>
              <div className="mt-4">
                <LegalTable
                  headers={["Risk", "Description"]}
                  rows={[
                    ["Irreversibility", "Confirmed blockchain transactions cannot be cancelled, reversed, or refunded under any circumstances. You bear full responsibility for all transactions signed by your wallet."],
                    ["Smart Contract Bugs", "DEX contracts, bonding curves, and token programs may contain bugs or exploits that result in loss of funds. Pumpi does not audit third-party smart contracts."],
                    ["Network Congestion", "High Solana network demand may cause failed transactions, increased priority fees, or delayed execution."],
                    ["Protocol Changes", "Solana network upgrades, DEX protocol migrations, or third-party program updates may affect functionality without advance notice."],
                    ["Slippage & MEV", "Your trade may execute at a price worse than quoted due to price impact, slippage, or sandwich attacks by MEV bots."],
                    ["Wallet Security", "You are solely responsible for securing your private keys and seed phrase. Pumpi has zero ability to recover lost wallet access or reverse unauthorised transactions."],
                  ]}
                />
              </div>
            </Section>

            <Section n={6} id="s6" title="No Endorsement of Tokens">
              <p>
                The listing, display, or discoverability of any token on Pumpi does <strong>not</strong> constitute
                endorsement, approval, certification, or recommendation of that token, its creators, or its project.
                Pumpi displays tokens based purely on on-chain activity and does not perform due diligence, KYC, or
                vetting of any token or creator.
              </p>
              <p className="mt-3">
                Always independently verify a token's contract address, ownership, and legitimacy through official project
                channels before trading. Never rely solely on information displayed on Pumpi.
              </p>
            </Section>

            <Section n={7} id="s7" title="Third-Party Services & Links">
              <p>
                The Platform integrates with third-party services including DEX aggregators (Jupiter), blockchain explorers
                (Solscan, Solana Explorer), wallet providers (Phantom, Solflare), and market data APIs. We have no control
                over and assume no responsibility for the content, accuracy, availability, or practices of any third-party service.
              </p>
              <p className="mt-3">
                Your use of third-party services is governed by their respective terms and conditions and privacy policies.
              </p>
            </Section>

            <Section n={8} id="s8" title="Regulatory Compliance">
              <p>
                The regulatory status of cryptocurrencies and digital assets varies significantly by jurisdiction. It is
                your sole responsibility to determine whether your use of the Platform, and the purchase, sale, or holding
                of any token, complies with applicable laws and regulations in your country or territory.
              </p>
              <p className="mt-3">
                The Platform is not intended for use in jurisdictions where cryptocurrency trading is prohibited, restricted,
                or requires specific licences or registrations. By using the Platform you represent that your use is lawful
                in your jurisdiction. Pumpi does not operate as a registered broker-dealer, investment adviser, financial
                institution, or money services business in any jurisdiction.
              </p>
            </Section>

            <Section n={9} id="s9" title="Tax Obligations">
              <p>
                Cryptocurrency transactions — including buying, selling, swapping, or receiving tokens — may constitute
                taxable events in your jurisdiction, potentially giving rise to capital gains tax, income tax, or other
                levies. Pumpi does not provide tax advice. You are solely responsible for determining and fulfilling any
                tax obligations arising from your use of the Platform. Consult a qualified tax professional in your
                jurisdiction.
              </p>
            </Section>

            <Section n={10} id="s10" title="Limitation of Liability">
              <p>
                To the maximum extent permitted by applicable law, Pumpi and its operators, directors, employees, and
                agents shall not be liable for any:
              </p>
              <ul className="mt-3 space-y-2">
                <li>Direct, indirect, incidental, special, consequential, or punitive damages of any kind.</li>
                <li>Loss of profits, revenue, data, business, goodwill, or anticipated savings.</li>
                <li>Financial losses resulting from trading decisions, investment activity, or reliance on Platform data.</li>
                <li>Losses from wallet compromise, private key theft, phishing attacks, or other security incidents not caused directly by Pumpi.</li>
                <li>Losses from smart contract vulnerabilities, blockchain network failures, or third-party service outages.</li>
                <li>Losses from inaccurate, delayed, or missing market data.</li>
              </ul>
              <div className="mt-4 p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] text-[13px] text-foreground/70">
                The Platform is provided on an <strong className="text-foreground">"as is"</strong> and{" "}
                <strong className="text-foreground">"as available"</strong> basis without warranties of any kind,
                whether express or implied, including implied warranties of merchantability, fitness for a particular purpose,
                or non-infringement.
              </div>
            </Section>

            <Section n={11} id="s11" title="Indemnification">
              <p>
                You agree to indemnify, defend, and hold harmless Pumpi and its operators, directors, employees, and agents
                from and against any claims, liabilities, damages, losses, costs, and expenses (including reasonable legal
                fees) arising out of or in connection with:
              </p>
              <ul className="mt-3 space-y-2">
                <li>Your use of or inability to use the Platform.</li>
                <li>Your violation of this Disclaimer or any applicable laws or regulations.</li>
                <li>Your trading activity, investment decisions, or reliance on Platform data.</li>
                <li>Any content you submit, post, or transmit through the Platform.</li>
              </ul>
            </Section>

            <Section n={12} id="s12" title="Changes to This Disclaimer">
              <p>
                We reserve the right to modify this Disclaimer at any time. Changes take effect immediately upon posting
                to this page with an updated effective date. Your continued use of the Platform after any changes
                constitutes your acceptance of the revised Disclaimer. We encourage you to review this page periodically.
              </p>
            </Section>

            <Section n={13} id="s13" title="Governing Law">
              <p>
                This Disclaimer shall be governed by and construed in accordance with applicable law. Any disputes arising
                in connection with this Disclaimer or the Platform shall be subject to the exclusive jurisdiction of
                competent courts in the applicable jurisdiction, to the extent permitted by law.
              </p>
            </Section>

            <Section n={14} id="s14" title="Contact">
              <p>Questions or concerns about this Disclaimer? Reach us at:</p>
              <ContactCard email={CONTACT_EMAIL} site={SITE_URL} />
            </Section>

          </div>

          {/* Footer nav */}
          <LegalFooter current="disclaimer" />
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
        <p className="text-[10px] font-mono text-muted-foreground/50 tracking-widest uppercase mb-1.5">Section {n}</p>
        <h2 className="text-[19px] font-bold text-foreground">{title}</h2>
      </div>
      <div className="space-y-4 text-[14px] leading-relaxed text-foreground/80 [&_strong]:text-foreground/95 [&_a]:text-primary [&_a:hover]:underline [&_ul]:space-y-2.5 [&_li]:relative [&_li]:pl-4 [&_li]:before:absolute [&_li]:before:left-0 [&_li]:before:top-[0.52em] [&_li]:before:w-[5px] [&_li]:before:h-[5px] [&_li]:before:rounded-full [&_li]:before:bg-white/25">
        {children}
      </div>
    </div>
  );
}

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

function SeverityBadge({ level }: { level: Severity }) {
  const styles: Record<Severity, string> = {
    CRITICAL: "bg-red-500/15 text-red-400 border-red-500/25",
    HIGH:     "bg-orange-500/15 text-orange-400 border-orange-500/25",
    MEDIUM:   "bg-amber-500/15 text-amber-400 border-amber-500/25",
    LOW:      "bg-green-500/15 text-green-400 border-green-500/25",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${styles[level] ?? ""}`}>
      {level}
    </span>
  );
}

function LegalTable({
  headers,
  rows,
  renderCell,
}: {
  headers: string[];
  rows: string[][];
  renderCell?: (cell: string, col: number, row: number) => React.ReactNode | null;
}) {
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
              {row.map((cell, j) => {
                const custom = renderCell?.(cell, j, i);
                return (
                  <td key={j} className={`px-4 py-3 text-foreground/75 align-top leading-snug ${j === 0 ? "font-medium text-foreground/90 whitespace-nowrap" : ""}`}>
                    {custom ?? cell}
                  </td>
                );
              })}
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
