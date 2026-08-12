import { SEO } from "@/components/seo/SEO";
import { Link } from "wouter";
import { ArrowLeft, TriangleAlert } from "lucide-react";

const LAST_UPDATED = "August 12, 2025";
const CONTACT_EMAIL = "legal@pumpi.io";
const SITE_URL = "https://pumpi.io";

export default function Disclaimer() {
  return (
    <>
      <SEO title="Disclaimer" description="Important risk disclosures and disclaimers for using Pumpi." />

      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-3xl mx-auto px-5 py-10 md:py-14">

          {/* Back */}
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8">
            <ArrowLeft className="w-4 h-4" />
            Back to Pumpi
          </Link>

          {/* Header */}
          <div className="flex items-start gap-4 mb-8">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0 mt-1">
              <TriangleAlert className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-foreground">Disclaimer</h1>
              <p className="text-sm text-muted-foreground mt-1">Last updated: {LAST_UPDATED}</p>
            </div>
          </div>

          {/* High-risk banner */}
          <div className="mb-8 p-4 rounded-xl bg-amber-500/10 border border-amber-500/25">
            <p className="text-sm font-semibold text-amber-300 mb-1">⚠ High-Risk Activity Warning</p>
            <p className="text-sm text-amber-200/80">
              Trading, buying, or holding memecoins and other crypto assets involves extreme risk of financial loss,
              including total loss of invested capital. This platform does not provide financial advice.
              Only use funds you can afford to lose entirely.
            </p>
          </div>

          <div className="prose prose-sm prose-invert max-w-none space-y-8 text-[15px] leading-relaxed text-foreground/85">

            {/* Intro */}
            <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.07]">
              <p>
                Please read this Disclaimer carefully before using Pumpi ("<strong>Platform</strong>"), operated at{" "}
                <a href={SITE_URL} className="text-primary hover:underline">{SITE_URL}</a>.
                By accessing or using the Platform, you acknowledge that you have read, understood, and agree to be
                bound by all the terms and conditions set forth in this Disclaimer. If you do not agree, you must not
                use the Platform.
              </p>
            </div>

            <Section n={1} title="Not Financial or Investment Advice">
              <p>
                Nothing on the Platform — including but not limited to token listings, price data, charts, trade histories,
                trending rankings, community comments, or any other content — constitutes financial advice, investment advice,
                trading advice, or any other type of advice. All content is provided for <strong>informational and
                educational purposes only</strong>.
              </p>
              <p>
                Pumpi does not recommend that any cryptocurrency or digital asset should be bought, sold, held, or traded.
                You should conduct your own independent research and consult a qualified financial advisor before making
                any investment decisions. Past performance of any token or asset is not indicative of future results.
              </p>
            </Section>

            <Section n={2} title="Memecoin & Speculative Asset Risks">
              <p>
                Memecoins and other speculative tokens listed or discoverable on the Platform carry exceptional risks that
                are substantially greater than traditional investments:
              </p>
              <ul>
                <li><strong>Extreme Volatility.</strong> Token prices can decline by 50–100% within minutes or hours. Large gains and total losses are both possible.</li>
                <li><strong>Rug Pulls & Scams.</strong> Token developers may abandon projects, drain liquidity, or engage in fraudulent activity. Pumpi does not verify, endorse, or vet any token or its creators.</li>
                <li><strong>No Underlying Value.</strong> Many memecoins have no underlying business, revenue, or utility. Their value is purely speculative and driven by market sentiment.</li>
                <li><strong>Low Liquidity.</strong> Many tokens have thin markets, meaning large orders can move prices significantly. Exiting a position may be difficult or impossible at desired prices.</li>
                <li><strong>Market Manipulation.</strong> Pump-and-dump schemes, coordinated buying/selling, and other manipulative practices are common in memecoin markets.</li>
                <li><strong>Total Loss of Capital.</strong> You may lose all funds you invest in any token. Never invest more than you can afford to lose entirely.</li>
              </ul>
            </Section>

            <Section n={3} title="No Guarantee of Accuracy">
              <p>
                Pumpi aggregates data from third-party sources including blockchain RPCs, DEX APIs, and market data providers.
                While we strive to provide accurate and up-to-date information, we make <strong>no representations or warranties</strong>,
                express or implied, regarding the accuracy, completeness, reliability, timeliness, or availability of any
                information on the Platform.
              </p>
              <ul>
                <li>Price data, market capitalisation figures, and trading volumes are estimates and may differ from other sources.</li>
                <li>Token metadata (names, logos, descriptions) is user-submitted or sourced from third parties and may be inaccurate or misleading.</li>
                <li>Technical errors, delays, or API outages may result in incorrect or missing data being displayed.</li>
                <li>Pumpi is not responsible for any errors, omissions, or inaccuracies in the data displayed.</li>
              </ul>
            </Section>

            <Section n={4} title="Smart Contract & Blockchain Risks">
              <p>
                Transactions executed through the Platform interact with smart contracts on the Solana blockchain. You acknowledge the following risks:
              </p>
              <ul>
                <li><strong>Irreversibility.</strong> Blockchain transactions are final and cannot be reversed, cancelled, or refunded once confirmed. You bear full responsibility for all transactions initiated through your wallet.</li>
                <li><strong>Smart Contract Bugs.</strong> Smart contracts — including those underlying DEXes, bonding curves, and token programs — may contain bugs, vulnerabilities, or exploits that result in loss of funds.</li>
                <li><strong>Network Congestion.</strong> High network demand may result in failed transactions, increased fees, or delayed execution.</li>
                <li><strong>Protocol Changes.</strong> Solana network upgrades, DEX protocol changes, or third-party program updates may affect functionality without notice.</li>
                <li><strong>Slippage & MEV.</strong> Trades may execute at prices different from quoted prices due to slippage, sandwich attacks, or other MEV (Maximum Extractable Value) activity.</li>
                <li><strong>Wallet Security.</strong> You are solely responsible for the security of your private keys and seed phrases. Pumpi has no ability to recover lost wallet access.</li>
              </ul>
            </Section>

            <Section n={5} title="No Endorsement of Tokens">
              <p>
                The listing, display, or discoverability of any token on Pumpi does <strong>not</strong> constitute endorsement,
                approval, or certification of that token, its creators, or its project. Pumpi displays tokens based on on-chain
                activity and does not perform due diligence, KYC, or vetting of token creators or projects.
              </p>
              <p>
                Users should independently verify any token's contract address, ownership, and legitimacy before interacting
                with it. Always verify contract addresses on official project channels before trading.
              </p>
            </Section>

            <Section n={6} title="Third-Party Services & Links">
              <p>
                The Platform integrates with or links to third-party services including DEX aggregators, blockchain explorers,
                wallet providers, and market data APIs. We have no control over and assume no responsibility for the content,
                accuracy, availability, or practices of any third-party services.
              </p>
              <p>
                Your use of third-party services is governed by their respective terms and conditions and privacy policies.
                We recommend reviewing these documents before use.
              </p>
            </Section>

            <Section n={7} title="Regulatory Compliance">
              <p>
                The regulatory status of cryptocurrencies and digital assets varies significantly by jurisdiction. It is your
                sole responsibility to determine whether your use of the Platform, purchase, sale, or holding of any token
                complies with applicable laws and regulations in your country or territory.
              </p>
              <p>
                The Platform is not intended for use in jurisdictions where cryptocurrency trading is prohibited, restricted,
                or requires specific licences or registrations. By using the Platform, you represent that your use is lawful
                in your jurisdiction. Pumpi does not operate as a registered broker-dealer, investment adviser, financial
                institution, or money services business in any jurisdiction.
              </p>
            </Section>

            <Section n={8} title="Tax Obligations">
              <p>
                Cryptocurrency transactions may have tax implications in your jurisdiction, including capital gains tax,
                income tax, or other levies. Pumpi does not provide tax advice. You are solely responsible for determining
                and fulfilling any tax obligations arising from your use of the Platform and any trades or transactions you
                conduct. We recommend consulting a qualified tax professional.
              </p>
            </Section>

            <Section n={9} title="Limitation of Liability">
              <p>
                To the maximum extent permitted by applicable law, Pumpi and its operators, directors, employees, and agents
                shall not be liable for any:
              </p>
              <ul>
                <li>Direct, indirect, incidental, special, consequential, or punitive damages.</li>
                <li>Loss of profits, revenue, data, business, goodwill, or anticipated savings.</li>
                <li>Financial losses resulting from trading, investment decisions, or reliance on information displayed on the Platform.</li>
                <li>Losses resulting from wallet compromise, private key theft, phishing, or other security incidents not caused directly by Pumpi.</li>
                <li>Losses resulting from smart contract vulnerabilities, blockchain network failures, or third-party service outages.</li>
                <li>Losses resulting from inaccurate or delayed market data.</li>
              </ul>
              <p className="mt-3">
                The Platform is provided on an "<strong>as is</strong>" and "<strong>as available</strong>" basis without
                warranties of any kind, whether express or implied, including but not limited to implied warranties of
                merchantability, fitness for a particular purpose, or non-infringement.
              </p>
            </Section>

            <Section n={10} title="Indemnification">
              <p>
                You agree to indemnify, defend, and hold harmless Pumpi and its operators, directors, employees, and agents
                from and against any claims, liabilities, damages, losses, costs, and expenses (including reasonable legal fees)
                arising out of or in connection with:
              </p>
              <ul>
                <li>Your use of or inability to use the Platform.</li>
                <li>Your violation of this Disclaimer or any applicable laws.</li>
                <li>Your trading activity, investment decisions, or reliance on Platform data.</li>
                <li>Any content you submit, post, or transmit through the Platform.</li>
              </ul>
            </Section>

            <Section n={11} title="Forward-Looking Statements">
              <p>
                Any statements on the Platform regarding potential future performance, expected functionality, roadmap items,
                or anticipated developments are forward-looking statements based on current expectations. Such statements
                involve known and unknown risks and uncertainties that may cause actual results to differ materially.
                Pumpi undertakes no obligation to update forward-looking statements.
              </p>
            </Section>

            <Section n={12} title="Changes to This Disclaimer">
              <p>
                We reserve the right to modify this Disclaimer at any time. Changes will be effective immediately upon
                posting to this page with an updated "Last updated" date. Your continued use of the Platform after any
                changes constitutes your acceptance of the revised Disclaimer. We encourage you to review this page
                periodically.
              </p>
            </Section>

            <Section n={13} title="Governing Law">
              <p>
                This Disclaimer shall be governed by and construed in accordance with applicable law. Any disputes arising
                in connection with this Disclaimer or the Platform shall be subject to the exclusive jurisdiction of
                competent courts in the applicable jurisdiction, to the extent permitted by law.
              </p>
            </Section>

            <Section n={14} title="Contact">
              <p>
                If you have questions about this Disclaimer, please contact us at:
              </p>
              <div className="mt-3 p-4 rounded-lg bg-white/[0.04] border border-white/[0.07] text-sm">
                <p className="font-semibold text-foreground">Pumpi</p>
                <p>Email: <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a></p>
                <p>Website: <a href={SITE_URL} className="text-primary hover:underline">{SITE_URL}</a></p>
              </div>
            </Section>

          </div>

          <div className="mt-12 pt-6 border-t border-white/[0.07] flex flex-wrap gap-4 text-sm text-muted-foreground">
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link>
            <Link href="/" className="hover:text-foreground transition-colors">← Back to Pumpi</Link>
          </div>
        </div>
      </div>
    </>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[17px] font-bold text-foreground mb-3">
        {n}. {title}
      </h2>
      <div className="space-y-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-2 [&_li]:text-foreground/85">
        {children}
      </div>
    </div>
  );
}
