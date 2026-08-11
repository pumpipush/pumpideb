import { Navbar } from "@/components/layout/Navbar";
import { useGetPlatformStats } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Flame, ShieldAlert, Zap, Cpu, Orbit, Terminal } from "lucide-react";
import { SiX, SiTelegram, SiGithub } from "react-icons/si";
import { formatEth } from "@/lib/utils";

export default function Home() {
  const { data: stats, isLoading } = useGetPlatformStats();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background selection:bg-primary/30">
      <Navbar />
      
      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative pt-24 pb-32 md:pt-36 md:pb-40 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/20 via-background to-background -z-10" />
          <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay pointer-events-none -z-10" />
          
          <div className="container mx-auto px-4 text-center">
            <div className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-sm font-medium text-primary mb-8 shadow-[0_0_10px_rgba(14,165,233,0.2)]">
              <span className="flex h-2 w-2 rounded-full bg-primary mr-2 animate-pulse"></span>
              Mainnet Live. No waitlist.
            </div>
            
            <h1 className="text-5xl md:text-7xl font-extrabold tracking-tighter mb-6 bg-clip-text text-transparent bg-gradient-to-b from-white to-white/60">
              The midnight arena <br className="hidden md:block" /> for serious degens.
            </h1>
            
            <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
              Launch tokens with instant liquidity. Trade before anyone else knows they exist. 
              No presales. No team allocations. Pure, unadulterated price discovery.
            </p>
            
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link href="/app">
                <Button size="lg" className="h-14 px-8 text-lg w-full sm:w-auto shadow-[0_0_20px_rgba(14,165,233,0.4)] hover:shadow-[0_0_30px_rgba(14,165,233,0.6)] hover:-translate-y-1 transition-all">
                  <Flame className="mr-2 h-5 w-5" />
                  Enter Arena
                </Button>
              </Link>
              <Link href="/dashboard">
                <Button size="lg" variant="outline" className="h-14 px-8 text-lg w-full sm:w-auto border-primary/20 hover:bg-primary/10">
                  <Terminal className="mr-2 h-5 w-5" />
                  Open Terminal
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Stats Strip */}
        <section className="border-y border-border/50 bg-muted/20">
          <div className="container mx-auto px-4 py-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
              <StatBlock label="Total Volume" value={isLoading ? null : `${formatEth(stats?.totalVolumeEth || "0")} ETH`} />
              <StatBlock label="Tokens Launched" value={isLoading ? null : stats?.totalTokens?.toLocaleString()} />
              <StatBlock label="Tokens Graduated" value={isLoading ? null : stats?.totalGraduated?.toLocaleString()} />
              <StatBlock label="24h Trades" value={isLoading ? null : stats?.tradesLast24h?.toLocaleString()} />
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="py-24 bg-background relative">
          <div className="container mx-auto px-4">
            <div className="mb-16 text-center max-w-2xl mx-auto">
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">Engineered for velocity</h2>
              <p className="text-muted-foreground text-lg">Every millisecond counts. We stripped out the noise so you can focus on the signal.</p>
            </div>
            
            <div className="grid md:grid-cols-3 gap-8">
              <FeatureCard 
                icon={<Zap className="h-8 w-8 text-primary" />}
                title="Instant Liquidity"
                desc="Tokens are launched via a bonding curve. Immediate trading. No seeded liquidity required by creators."
              />
              <FeatureCard 
                icon={<ShieldAlert className="h-8 w-8 text-primary" />}
                title="Rug-Proof Mechanics"
                desc="No minting. No pre-sales. No dev allocations. Supply is fixed and governed by the curve."
              />
              <FeatureCard 
                icon={<Orbit className="h-8 w-8 text-primary" />}
                title="DEX Graduation"
                desc="Hit the market cap threshold and the coin automatically migrates to Raydium. Liquidity is locked forever."
              />
            </div>
          </div>
        </section>
        
        {/* Terminal CTA */}
        <section className="py-32 relative overflow-hidden">
          <div className="absolute inset-0 bg-primary/5 -z-10" />
          <div className="container mx-auto px-4 text-center">
            <h2 className="text-4xl font-bold mb-6">Stop playing with toys.</h2>
            <p className="text-xl text-muted-foreground mb-10 max-w-2xl mx-auto">
              Open the Terminal. Track the volume. Hunt the next breakout.
            </p>
            <Link href="/dashboard">
              <Button size="lg" className="h-14 px-10 text-lg shadow-[0_0_20px_rgba(14,165,233,0.4)]">
                <Cpu className="mr-2 h-5 w-5" /> Launch Terminal
              </Button>
            </Link>
          </div>
        </section>
      </main>
      
      <footer className="border-t border-border/40 py-8 bg-card">
        <div className="container mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-primary font-bold">
            <Flame className="h-5 w-5" />
            <span>Mintix <span className="text-white/50 font-normal">fun</span></span>
          </div>
          <p className="text-sm text-muted-foreground text-center md:text-left">
            © {new Date().getFullYear()} Mintix Protocol. All systems nominal.
          </p>
          <div className="flex gap-4">
            <span className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"><SiX className="h-5 w-5" /></span>
            <span className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"><SiTelegram className="h-5 w-5" /></span>
            <span className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"><SiGithub className="h-5 w-5" /></span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function StatBlock({ label, value }: { label: string, value: string | undefined | null }) {
  return (
    <div className="flex flex-col items-center justify-center p-4 border border-border/30 rounded-xl bg-card/30 backdrop-blur">
      <span className="text-sm text-muted-foreground mb-1 uppercase tracking-wider">{label}</span>
      {value == null
        ? <div className="h-9 w-28 rounded-md bg-muted/60 animate-pulse mt-0.5" />
        : <span className="text-2xl md:text-3xl font-bold text-foreground">{value}</span>
      }
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) {
  return (
    <div className="p-8 rounded-2xl border border-border/50 bg-card hover:border-primary/50 transition-colors group">
      <div className="mb-6 p-4 rounded-xl bg-primary/10 inline-block group-hover:scale-110 transition-transform">
        {icon}
      </div>
      <h3 className="text-xl font-bold mb-3">{title}</h3>
      <p className="text-muted-foreground leading-relaxed">{desc}</p>
    </div>
  );
}
