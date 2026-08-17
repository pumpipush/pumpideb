import { Link } from "wouter";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SEO } from "@/components/seo/SEO";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background">
      <SEO
        fullTitle="404 — Page Not Found | Pumpi"
        description="The page you're looking for doesn't exist. Head back to Pumpi to explore and trade Solana memecoins."
        noIndex
      />
      <AlertCircle className="w-16 h-16 text-destructive mb-4" />
      <h1 className="text-4xl font-bold mb-2">404 Not Found</h1>
      <p className="text-muted-foreground mb-6">Sector clear. No signal detected at this coordinate.</p>
      <Link href="/">
        <Button>Return to Base</Button>
      </Link>
    </div>
  );
}
