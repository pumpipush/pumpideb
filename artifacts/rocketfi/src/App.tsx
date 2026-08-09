import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, Router as WouterRouter, useLocation, useSearch } from 'wouter';
import { useEffect, useRef } from 'react';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/Dashboard';
import AppInterface from '@/pages/AppInterface';
import ProfilePage from '@/pages/Profile';
import { Sidebar, BottomNav } from '@/components/layout/Sidebar';
import { Navbar } from '@/components/layout/Navbar';
import { WalletProvider } from '@/contexts/WalletContext';
import { SearchDialog } from '@/components/shared/SearchDialog';
import { CopyToastProvider } from '@/components/shared/CopyToast';
import { AuthModal } from '@/components/shared/AuthModal';
import { Redirect } from 'wouter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function AppShell() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const mainRef = useRef<HTMLElement>(null);

  const isSignIn = location === '/signin';
  const isSignUp = location === '/signup';
  const authOpen = isSignIn || isSignUp;

  // Scroll main content area to top on every route/query change
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [location, search]);

  return (
    <div className="flex min-h-[100dvh] w-full overflow-x-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col md:ml-[220px] min-w-0">
        <Navbar />
        <main ref={mainRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-16 md:pb-0 pt-[60px]">
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/dashboard"><Redirect to="/" /></Route>
            <Route path="/app" component={AppInterface} />
            <Route path="/profile/:address" component={ProfilePage} />
            {/* signin/signup show the dashboard behind the auth modal */}
            <Route path="/signin"><Dashboard /></Route>
            <Route path="/signup"><Dashboard /></Route>
            <Route component={NotFound} />
          </Switch>
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <WalletProvider>
          <AppShell />
          <SearchDialog />
          <CopyToastProvider />
        </WalletProvider>
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
