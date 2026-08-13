import { PrivyProvider } from '@privy-io/react-auth';
import { HelmetProvider } from 'react-helmet-async';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, Redirect, Router as WouterRouter, useLocation, useSearch, useParams } from 'wouter';
import { useEffect, useLayoutEffect, useRef } from 'react';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/Dashboard';
import AppInterface from '@/pages/AppInterface';
import ProfilePage from '@/pages/Profile';
import PrivacyPolicy from '@/pages/PrivacyPolicy';
import DisclaimerPage from '@/pages/Disclaimer';
import TermsOfService from '@/pages/TermsOfService';
import { Sidebar, BottomNav } from '@/components/layout/Sidebar';
import { Navbar } from '@/components/layout/Navbar';
import { WalletProvider } from '@/contexts/WalletContext';
import { AuthProvider } from '@/contexts/AuthContext';
import { SearchDialog } from '@/components/shared/SearchDialog';
import { CopyToastProvider } from '@/components/shared/CopyToast';
import { AuthModal } from '@/components/shared/AuthModal';
import { UsernameNudgeBanner } from '@/components/shared/UsernameNudgeBanner';
import { PlatformFeeBanner } from '@/components/shared/PlatformFeeBanner';
import { SiteFooter } from '@/components/layout/SiteFooter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

/** Renders a token page at /coin/:address — path-based URL for SEO. */
function TokenPage() {
  const params = useParams<{ address: string }>();
  return <AppInterface tokenAddress={params.address} />;
}

function LegacyTokenRedirect() {
  const params = useParams<{ address: string }>();
  return <Redirect to={`/coin/${params.address}`} />;
}

function AppShell() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const mainRef = useRef<HTMLElement>(null);

  const isSignIn = location === '/signin';
  const isSignUp = location === '/signup';
  const authOpen = isSignIn || isSignUp;

  // Scroll to top on every route change.
  // window is the real scroll container (main has no fixed height ancestor).
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);

  return (
    <div className="flex min-h-[100dvh] w-full overflow-x-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col md:ml-[220px] min-w-0">
        <Navbar />
        <main ref={mainRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-24 md:pb-0 pt-[60px]">
          <UsernameNudgeBanner />
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/explore"><Redirect to="/" /></Route>
            <Route path="/dashboard"><Redirect to="/" /></Route>
            {/* Legacy /app route — redirects to /coin/:address when ?token= is present */}
            <Route path="/app" component={AppRoute} />
            {/* Legacy /token/:address — redirect to canonical /coin/:address */}
            <Route path="/token/:address" component={LegacyTokenRedirect} />
            {/* Canonical SEO-friendly coin pages */}
            <Route path="/coin/:address" component={TokenPage} />
            <Route path="/profile/:slug" component={ProfilePage} />
            {/* signin/signup show the explore page behind the auth modal */}
            <Route path="/signin"><Dashboard /></Route>
            <Route path="/signup"><Dashboard /></Route>
            <Route path="/privacy" component={PrivacyPolicy} />
            <Route path="/disclaimer" component={DisclaimerPage} />
            <Route path="/terms" component={TermsOfService} />
            <Route component={NotFound} />
          </Switch>
          <SiteFooter />
        </main>
      </div>
      <BottomNav />

      {/* Auth modal — opens when route is /signin or /signup */}
      <AuthModal
        open={authOpen}
        onOpenChange={(open) => { if (!open) navigate('/'); }}
        defaultMode={isSignUp ? 'signup' : 'signin'}
      />
    </div>
  );
}

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string;

function App() {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["google"],
        appearance: { theme: "dark" },
        embeddedWallets: { createOnLogin: "off" },
      }}
    >
      <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <WalletProvider>
            <AuthProvider>
              <AppShell />
              <SearchDialog />
              <CopyToastProvider />
            </AuthProvider>
          </WalletProvider>
        </WouterRouter>
        <Toaster />
        <PlatformFeeBanner />
      </QueryClientProvider>
      </HelmetProvider>
    </PrivyProvider>
  );
}

export default App;

/**
 * Thin shim for the legacy /app route.
 * If a ?token= query param is present, redirect to the canonical /coin/:address path.
 * Otherwise render AppInterface normally (launch / portfolio tabs).
 */
function AppRoute() {
  const search = useSearch();
  const tokenParam = new URLSearchParams(search).get('token');
  if (tokenParam) return <Redirect to={`/coin/${tokenParam}`} />;
  return <AppInterface />;
}


