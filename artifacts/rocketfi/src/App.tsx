import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/Dashboard';
import AppInterface from '@/pages/AppInterface';
import ProfilePage from '@/pages/Profile';
import { Sidebar, BottomNav } from '@/components/layout/Sidebar';
import { Navbar } from '@/components/layout/Navbar';
import { WalletProvider } from '@/contexts/WalletContext';
import { SearchDialog } from '@/components/shared/SearchDialog';
import { CopyToastProvider } from '@/components/shared/CopyToast';
import { Redirect } from 'wouter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/dashboard">
        <Redirect to="/" />
      </Route>
      <Route path="/app" component={AppInterface} />
      <Route path="/profile/:address" component={ProfilePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <WalletProvider>
          <div className="flex min-h-[100dvh] w-full overflow-x-hidden">
            {/* Fixed left sidebar */}
            <Sidebar />

            {/* Right column: sticky header + scrollable content */}
            <div className="flex-1 flex flex-col md:ml-[220px] min-w-0">
              {/* Global header — consistent across all pages */}
              <Navbar />

              {/* Page content */}
              <main className="flex-1 overflow-y-auto overflow-x-hidden pb-16 md:pb-0">
                <Router />
              </main>
            </div>

            <BottomNav />
          </div>
          <SearchDialog />
          <CopyToastProvider />
        </WalletProvider>
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
