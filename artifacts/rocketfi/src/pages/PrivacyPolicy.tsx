import { SEO } from "@/components/seo/SEO";
import { Link } from "wouter";
import { ArrowLeft, Shield } from "lucide-react";

const LAST_UPDATED = "August 12, 2025";
const CONTACT_EMAIL = "privacy@pumpi.io";
const SITE_URL = "https://pumpi.io";

export default function PrivacyPolicy() {
  return (
    <>
      <SEO title="Privacy Policy" description="How Pumpi collects, uses, and protects your information." />

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
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-foreground">Privacy Policy</h1>
              <p className="text-sm text-muted-foreground mt-1">Last updated: {LAST_UPDATED}</p>
            </div>
          </div>

          <div className="prose prose-sm prose-invert max-w-none space-y-8 text-[15px] leading-relaxed text-foreground/85">

            {/* Intro */}
            <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.07]">
              <p>
                Pumpi ("<strong>we</strong>", "<strong>our</strong>", or "<strong>us</strong>") operates the website at{" "}
                <a href={SITE_URL} className="text-primary hover:underline">{SITE_URL}</a> (the "<strong>Platform</strong>").
                This Privacy Policy explains what information we collect, how we use it, and the choices you have.
              </p>
              <p className="mt-3">
                By accessing or using Pumpi, you agree to the collection and use of information in accordance with this policy.
              </p>
            </div>

            <Section n={1} title="Information We Collect">
              <SubSection title="1.1 Information You Provide">
                <ul>
                  <li><strong>Wallet Address.</strong> When you connect a Solana wallet, we receive your public wallet address. We never have access to your private keys, seed phrases, or the ability to initiate transactions on your behalf.</li>
                  <li><strong>Profile Information.</strong> If you create a profile, we collect your chosen username, bio, avatar image, Twitter/X handle, and website URL.</li>
                  <li><strong>Email Address.</strong> If you sign in via email OTP, we store your email address to authenticate you and link it to your profile.</li>
                  <li><strong>Google Account.</strong> If you sign in with Google, we receive your name, email address, and profile picture from Google. We do not receive your Google password.</li>
                </ul>
              </SubSection>

              <SubSection title="1.2 Information Collected Automatically">
                <ul>
                  <li><strong>Usage Data.</strong> We collect information about how you interact with the Platform — pages visited, tokens viewed, searches performed, and features used.</li>
                  <li><strong>Device & Browser Information.</strong> We collect your IP address, browser type, operating system, referring URLs, and device identifiers.</li>
                  <li><strong>Cookies & Local Storage.</strong> We use browser storage to remember your preferences (e.g., last connected wallet, dismissed banners) and to maintain your session. No cross-site advertising cookies are used.</li>
                  <li><strong>On-Chain Data.</strong> We index publicly available blockchain data including token trades, wallet balances, and transaction histories on the Solana blockchain. This data is public by nature.</li>
                </ul>
              </SubSection>

              <SubSection title="1.3 Information from Third Parties">
                <ul>
                  <li><strong>Blockchain RPC Providers.</strong> We use Alchemy and public Solana RPC nodes to query on-chain data. These providers may log your requests per their own privacy policies.</li>
                  <li><strong>Market Data Providers.</strong> We use Birdeye and DexScreener APIs to fetch token prices and market data.</li>
                  <li><strong>Google Identity Services.</strong> When you use "Sign in with Google," we share your request with Google under their Privacy Policy.</li>
                </ul>
              </SubSection>
            </Section>

            <Section n={2} title="How We Use Your Information">
              <ul>
                <li>To provide, operate, and improve the Platform.</li>
                <li>To authenticate your identity and maintain your session.</li>
                <li>To display your profile and trade history to yourself and other users (as per your privacy preferences).</li>
                <li>To detect, prevent, and investigate fraud, abuse, or security incidents.</li>
                <li>To analyze usage patterns and improve platform performance.</li>
                <li>To communicate with you about important updates, security notices, or changes to our terms (we do not send marketing emails without your explicit consent).</li>
                <li>To comply with applicable laws and regulations.</li>
              </ul>
            </Section>

            <Section n={3} title="How We Share Your Information">
              <p>We do not sell your personal information. We may share it only in the following circumstances:</p>
              <ul>
                <li><strong>Publicly on the Platform.</strong> Your wallet address (or username), profile information, and trading activity on Solana are publicly visible on the Platform, consistent with the public nature of blockchain data.</li>
                <li><strong>Service Providers.</strong> We share data with trusted service providers (hosting, database, analytics, email delivery) who process it on our behalf under data processing agreements.</li>
                <li><strong>Legal Requirements.</strong> We may disclose information if required by law, court order, or to protect the rights, safety, or property of Pumpi or others.</li>
                <li><strong>Business Transfers.</strong> If Pumpi is involved in a merger, acquisition, or asset sale, your information may be transferred as part of that transaction.</li>
              </ul>
            </Section>

            <Section n={4} title="Data Retention">
              <p>
                We retain your personal information for as long as your account is active or as needed to provide the Platform.
                On-chain data (wallet addresses, trades) is permanently public on the Solana blockchain and cannot be deleted by us.
                You may request deletion of your profile and off-chain data by contacting us at{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>.
                Deletion of your profile does not remove your wallet's public on-chain transaction history.
              </p>
            </Section>

            <Section n={5} title="Security">
              <p>
                We implement industry-standard technical and organizational measures to protect your information, including
                encrypted communications (HTTPS/TLS), hashed authentication tokens, and access controls.
                However, no system is 100% secure. You are responsible for maintaining the security of your own wallet,
                private keys, and seed phrases — we never have access to these.
              </p>
            </Section>

            <Section n={6} title="Your Rights">
              <p>Depending on your jurisdiction, you may have the right to:</p>
              <ul>
                <li><strong>Access</strong> the personal data we hold about you.</li>
                <li><strong>Correct</strong> inaccurate or incomplete data.</li>
                <li><strong>Delete</strong> your off-chain profile data (subject to legal retention obligations).</li>
                <li><strong>Object</strong> to or restrict certain processing activities.</li>
                <li><strong>Data portability</strong> — receive a copy of your data in a machine-readable format.</li>
              </ul>
              <p className="mt-3">
                To exercise any of these rights, contact us at{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>.
                We will respond within 30 days.
              </p>
            </Section>

            <Section n={7} title="Children's Privacy">
              <p>
                The Platform is not directed to individuals under the age of 18. We do not knowingly collect personal
                information from minors. If you believe we have inadvertently collected data from a minor, please contact
                us immediately and we will take steps to delete it.
              </p>
            </Section>

            <Section n={8} title="Third-Party Links">
              <p>
                The Platform may contain links to third-party websites, tokens, or services. We are not responsible
                for the privacy practices of those third parties. We encourage you to review their privacy policies before
                interacting with them.
              </p>
            </Section>

            <Section n={9} title="Cookies & Tracking Technologies">
              <p>We use the following types of storage:</p>
              <ul>
                <li><strong>Session Storage.</strong> Temporary data for your current browsing session.</li>
                <li><strong>Local Storage.</strong> Persistent preferences such as your last connected wallet, dismissed notifications, and authentication tokens.</li>
                <li><strong>No third-party advertising cookies.</strong> We do not use cookies for advertising tracking or behavioral profiling.</li>
              </ul>
              <p className="mt-3">
                You can clear browser storage at any time through your browser settings, which will sign you out and reset your preferences.
              </p>
            </Section>

            <Section n={10} title="International Data Transfers">
              <p>
                Our servers and service providers may be located in various countries. By using the Platform, you consent
                to the transfer and processing of your information in countries that may have different data protection
                laws than your country of residence. We take appropriate safeguards to ensure your data is protected
                in accordance with this policy.
              </p>
            </Section>

            <Section n={11} title="Changes to This Policy">
              <p>
                We may update this Privacy Policy from time to time. We will notify you of material changes by posting
                the new policy on this page and updating the "Last updated" date. Your continued use of the Platform
                after changes take effect constitutes your acceptance of the updated policy.
              </p>
            </Section>

            <Section n={12} title="Contact Us">
              <p>
                If you have questions, concerns, or requests regarding this Privacy Policy or your personal data, please contact us at:
              </p>
              <div className="mt-3 p-4 rounded-lg bg-white/[0.04] border border-white/[0.07] text-sm">
                <p className="font-semibold text-foreground">Pumpi</p>
                <p>Email: <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a></p>
                <p>Website: <a href={SITE_URL} className="text-primary hover:underline">{SITE_URL}</a></p>
              </div>
            </Section>

          </div>

          <div className="mt-12 pt-6 border-t border-white/[0.07] flex flex-wrap gap-4 text-sm text-muted-foreground">
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
