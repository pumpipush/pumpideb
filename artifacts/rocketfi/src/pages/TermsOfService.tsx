import { SEO } from "@/components/seo/SEO";
import { Link } from "wouter";
import { ArrowLeft, FileText } from "lucide-react";

const LAST_UPDATED = "August 12, 2025";
const CONTACT_EMAIL = "legal@pumpi.io";
const SITE_URL = "https://pumpi.io";

export default function TermsOfService() {
  return (
    <>
      <SEO title="Terms of Service" description="Terms and conditions governing your use of the Pumpi platform." />

      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-3xl mx-auto px-5 py-10 md:py-14">

          {/* Back */}
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8">
            <ArrowLeft className="w-4 h-4" />
            Back to Pumpi
          </Link>

          {/* Header */}
          <div className="flex items-start gap-4 mb-8">
            <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-1">
              <FileText className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-foreground">Terms of Service</h1>
              <p className="text-sm text-muted-foreground mt-1">Last updated: {LAST_UPDATED}</p>
            </div>
          </div>

          <div className="prose prose-sm prose-invert max-w-none space-y-8 text-[15px] leading-relaxed text-foreground/85">

            {/* Intro */}
            <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.07]">
              <p>
                These Terms of Service ("<strong>Terms</strong>") govern your access to and use of Pumpi ("<strong>we</strong>",
                "<strong>our</strong>", or "<strong>us</strong>"), operated at{" "}
                <a href={SITE_URL} className="text-primary hover:underline">{SITE_URL}</a> (the "<strong>Platform</strong>").
                By accessing or using the Platform, you agree to be bound by these Terms. If you do not agree, do not use the Platform.
              </p>
              <p className="mt-3">
                Please also read our{" "}
                <Link href="/privacy" className="text-primary hover:underline">Privacy Policy</Link>{" "}
                and{" "}
                <Link href="/disclaimer" className="text-primary hover:underline">Disclaimer</Link>,
                which are incorporated into these Terms by reference.
              </p>
            </div>

            <Section n={1} title="Eligibility">
              <p>
                By using the Platform, you represent and warrant that:
              </p>
              <ul>
                <li>You are at least 18 years of age (or the age of majority in your jurisdiction, if higher).</li>
                <li>You have the legal capacity to enter into these Terms.</li>
                <li>Your use of the Platform does not violate any applicable laws or regulations in your jurisdiction.</li>
                <li>You are not located in, or a citizen or resident of, any jurisdiction where use of the Platform or cryptocurrency trading is prohibited, restricted, or requires a licence or registration that Pumpi does not hold.</li>
                <li>You are not subject to sanctions or included on any government list of prohibited or restricted parties.</li>
              </ul>
              <p className="mt-3">
                If you do not meet these requirements, you must not access or use the Platform.
              </p>
            </Section>

            <Section n={2} title="Account Registration & Wallets">
              <SubSection title="2.1 Account Creation">
                <p>
                  You may use the Platform as a guest (read-only) or by connecting a Solana wallet and optionally creating
                  a profile. When creating a profile, you agree to provide accurate, current, and complete information.
                  You are responsible for keeping your profile information up to date.
                </p>
              </SubSection>
              <SubSection title="2.2 Wallet Security">
                <p>
                  You are solely responsible for maintaining the security of your connected wallet, private keys, and seed
                  phrases. Pumpi has no ability to recover lost wallet access, reverse transactions, or retrieve funds sent
                  to wrong addresses. Never share your private keys or seed phrases with anyone, including Pumpi.
                </p>
              </SubSection>
              <SubSection title="2.3 Account Responsibility">
                <p>
                  You are responsible for all activity that occurs under your account or through your connected wallet.
                  If you believe your account has been compromised, disconnect your wallet immediately and take steps to
                  secure it. Notify us at{" "}
                  <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>{" "}
                  if you suspect unauthorized use.
                </p>
              </SubSection>
            </Section>

            <Section n={3} title="Acceptable Use">
              <p>
                You may use the Platform only for lawful purposes and in accordance with these Terms. You agree to use
                the Platform in a manner consistent with all applicable local, national, and international laws and regulations.
              </p>
              <p className="mt-3">
                Permitted uses include:
              </p>
              <ul>
                <li>Viewing token information, price data, and market statistics.</li>
                <li>Creating and managing a personal profile.</li>
                <li>Initiating cryptocurrency trades through your own connected wallet.</li>
                <li>Creating and launching tokens through supported protocols.</li>
                <li>Participating in community features in a respectful manner.</li>
              </ul>
            </Section>

            <Section n={4} title="Prohibited Conduct">
              <p>You agree <strong>not</strong> to:</p>
              <ul>
                <li><strong>Market Manipulation.</strong> Engage in wash trading, pump-and-dump schemes, spoofing, layering, or any other form of market manipulation or deceptive trading practices.</li>
                <li><strong>Fraud & Deception.</strong> Create fake tokens, impersonate other users or projects, provide false information, or engage in any deceptive conduct intended to mislead other users.</li>
                <li><strong>Illegal Activity.</strong> Use the Platform for money laundering, terrorist financing, tax evasion, sanctions evasion, or any other illegal purpose.</li>
                <li><strong>Platform Abuse.</strong> Scrape, crawl, or systematically collect data from the Platform without written permission; use bots or automated tools to interact with the Platform in a manner that places excessive load on our infrastructure.</li>
                <li><strong>Security Violations.</strong> Attempt to gain unauthorized access to any part of the Platform, other users' accounts, or our systems; introduce malicious code, viruses, or other harmful software.</li>
                <li><strong>Spam & Harassment.</strong> Post spam, unsolicited advertising, or content that harasses, threatens, or harms other users.</li>
                <li><strong>Intellectual Property Infringement.</strong> Upload or distribute content that infringes any third party's intellectual property rights.</li>
                <li><strong>Circumvention.</strong> Attempt to circumvent any access controls, rate limits, or restrictions we impose on use of the Platform.</li>
              </ul>
              <p className="mt-3">
                Violation of these prohibitions may result in immediate account suspension or termination, and may be
                reported to relevant law enforcement authorities.
              </p>
            </Section>

            <Section n={5} title="Content & Intellectual Property">
              <SubSection title="5.1 Our Content">
                <p>
                  The Platform and its original content, features, design, and functionality are owned by Pumpi and are
                  protected by applicable intellectual property laws. You may not copy, modify, distribute, sell, or
                  lease any part of the Platform or its content without our express written permission.
                </p>
              </SubSection>
              <SubSection title="5.2 User-Submitted Content">
                <p>
                  By submitting content to the Platform — including token metadata, profile information, images, usernames,
                  and descriptions — you grant Pumpi a non-exclusive, worldwide, royalty-free licence to use, display,
                  reproduce, and distribute that content in connection with operating the Platform.
                </p>
                <p className="mt-2">
                  You represent that you own or have the necessary rights to submit such content, and that it does not
                  violate any third-party rights, applicable laws, or these Terms. We reserve the right to remove any
                  content that we determine, in our sole discretion, violates these Terms or is otherwise objectionable.
                </p>
              </SubSection>
              <SubSection title="5.3 On-Chain Data">
                <p>
                  Data originating on the Solana blockchain (transaction histories, wallet balances, token trades) is
                  public by nature. You acknowledge that on-chain information cannot be modified or deleted by Pumpi
                  and is not subject to our content policies.
                </p>
              </SubSection>
            </Section>

            <Section n={6} title="Platform Fees">
              <p>
                Pumpi may charge platform fees on certain transactions executed through the Platform, including a referral
                fee on trades. All applicable fees will be disclosed in the trading interface prior to confirmation.
                By confirming a transaction, you agree to the fees displayed.
              </p>
              <p className="mt-3">
                Blockchain network fees (gas fees) are separate from Pumpi's platform fees and are paid directly to the
                Solana network. These fees are determined by network conditions and are not controlled by Pumpi.
              </p>
            </Section>

            <Section n={7} title="Service Modifications & Availability">
              <p>
                Pumpi reserves the right to modify, suspend, or discontinue the Platform (or any part of it) at any time,
                with or without notice. We may also update these Terms, the Platform's features, supported protocols,
                or the tokens accessible through the Platform at our sole discretion.
              </p>
              <p className="mt-3">
                We do not guarantee that the Platform will be available at any particular time or that it will be
                error-free. Planned maintenance, unplanned outages, blockchain network issues, or third-party API
                failures may result in downtime. Pumpi shall not be liable for any loss resulting from Platform
                unavailability.
              </p>
            </Section>

            <Section n={8} title="Termination & Suspension">
              <SubSection title="8.1 By Pumpi">
                <p>
                  We may suspend or terminate your access to the Platform at any time, with or without cause and with or
                  without notice, including if we reasonably believe you have violated these Terms, engaged in fraudulent
                  activity, or pose a risk to other users or the Platform's integrity. Upon termination, your right to
                  use the Platform ceases immediately.
                </p>
              </SubSection>
              <SubSection title="8.2 By You">
                <p>
                  You may stop using the Platform at any time. If you wish to delete your profile and off-chain data,
                  contact us at{" "}
                  <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>.
                  Deletion of your profile does not affect your on-chain transaction history, which is permanently
                  recorded on the Solana blockchain.
                </p>
              </SubSection>
              <SubSection title="8.3 Effect of Termination">
                <p>
                  Sections that by their nature should survive termination — including intellectual property rights,
                  limitation of liability, indemnification, and governing law — shall remain in effect after termination.
                </p>
              </SubSection>
            </Section>

            <Section n={9} title="Limitation of Liability">
              <p>
                To the maximum extent permitted by applicable law, Pumpi and its operators, directors, employees, and
                agents shall not be liable for any indirect, incidental, special, consequential, or punitive damages,
                including but not limited to loss of profits, data, goodwill, or other intangible losses, arising out of
                or in connection with:
              </p>
              <ul>
                <li>Your use of or inability to use the Platform.</li>
                <li>Any trading decisions, investment losses, or financial damages resulting from use of the Platform.</li>
                <li>Unauthorized access to or alteration of your wallet or data.</li>
                <li>Any third-party conduct, content, or services accessible through or referenced by the Platform.</li>
                <li>Smart contract vulnerabilities, blockchain network failures, or protocol changes.</li>
                <li>Platform downtime, data inaccuracies, or service interruptions.</li>
              </ul>
              <p className="mt-3">
                The Platform is provided on an "<strong>as is</strong>" and "<strong>as available</strong>" basis.
                Pumpi expressly disclaims all warranties, express or implied, including merchantability, fitness for a
                particular purpose, and non-infringement.
              </p>
              <p className="mt-3">
                In jurisdictions that do not allow the exclusion of certain warranties or limitation of liability, our
                liability shall be limited to the greatest extent permitted by law.
              </p>
            </Section>

            <Section n={10} title="Indemnification">
              <p>
                You agree to indemnify, defend, and hold harmless Pumpi and its operators, directors, employees, and
                agents from and against any claims, liabilities, damages, losses, costs, and expenses (including
                reasonable legal fees) arising out of or in connection with:
              </p>
              <ul>
                <li>Your use of or access to the Platform.</li>
                <li>Your violation of these Terms or any applicable law.</li>
                <li>Your trading activity or reliance on information displayed on the Platform.</li>
                <li>Content you submit, post, or transmit through the Platform.</li>
                <li>Your infringement of any third party's rights.</li>
              </ul>
            </Section>

            <Section n={11} title="Dispute Resolution">
              <SubSection title="11.1 Informal Resolution">
                <p>
                  Before initiating any formal dispute, you agree to contact us at{" "}
                  <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>{" "}
                  and attempt to resolve the dispute informally. We will try to resolve it within 30 days of receiving
                  your notice.
                </p>
              </SubSection>
              <SubSection title="11.2 Binding Arbitration">
                <p>
                  If informal resolution fails, any dispute, claim, or controversy arising out of or relating to these
                  Terms or the Platform shall be resolved by binding arbitration rather than in court, except that you
                  may assert claims in small claims court if your claims qualify. You waive any right to a jury trial
                  or to participate in a class action lawsuit or class-wide arbitration.
                </p>
              </SubSection>
              <SubSection title="11.3 No Class Actions">
                <p>
                  You agree that any arbitration or proceeding shall be limited to the dispute between you and Pumpi
                  individually. To the fullest extent permitted by law, no arbitration or proceeding shall be joined
                  with any other claim or dispute, and no class action or representative proceeding is permitted.
                </p>
              </SubSection>
            </Section>

            <Section n={12} title="Governing Law">
              <p>
                These Terms shall be governed by and construed in accordance with applicable law, without regard to
                conflict-of-law principles. To the extent that arbitration does not apply and litigation is required,
                you consent to the exclusive jurisdiction of competent courts in the applicable jurisdiction.
              </p>
            </Section>

            <Section n={13} title="Changes to These Terms">
              <p>
                We may update these Terms from time to time. When we make material changes, we will update the "Last
                updated" date at the top of this page. Your continued use of the Platform after any changes constitutes
                your acceptance of the revised Terms. We encourage you to review these Terms periodically.
              </p>
              <p className="mt-3">
                If you do not agree to the revised Terms, you must stop using the Platform.
              </p>
            </Section>

            <Section n={14} title="Miscellaneous">
              <ul>
                <li><strong>Entire Agreement.</strong> These Terms, together with our Privacy Policy and Disclaimer, constitute the entire agreement between you and Pumpi regarding your use of the Platform.</li>
                <li><strong>Severability.</strong> If any provision of these Terms is found to be unenforceable, the remaining provisions will continue in full force and effect.</li>
                <li><strong>Waiver.</strong> Our failure to enforce any right or provision of these Terms shall not be deemed a waiver of that right or provision.</li>
                <li><strong>Assignment.</strong> You may not assign or transfer these Terms or your rights under them without our prior written consent. We may assign our rights and obligations under these Terms without restriction.</li>
                <li><strong>No Partnership.</strong> Nothing in these Terms creates a partnership, agency, joint venture, or employment relationship between you and Pumpi.</li>
              </ul>
            </Section>

            <Section n={15} title="Contact Us">
              <p>
                If you have questions about these Terms of Service, please contact us at:
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
            <Link href="/disclaimer" className="hover:text-foreground transition-colors">Disclaimer</Link>
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

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-[14px] font-semibold text-foreground/90 mb-2">{title}</h3>
      <div className="[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-2 [&_li]:text-foreground/85">
        {children}
      </div>
    </div>
  );
}
