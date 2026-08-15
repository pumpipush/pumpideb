import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

import { AdminProvider, useAdmin } from '@/contexts/AdminContext';
import { AdminLayout } from '@/components/layout';

import Login from '@/pages/login';
import Overview from '@/pages/overview';
import Users from '@/pages/users';
import Tokens from '@/pages/tokens';
import Trades from '@/pages/trades';
import System from '@/pages/system';
import Fees from '@/pages/fees';
import Analytics from '@/pages/analytics';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoutes() {
  const { secret } = useAdmin();
  const [location] = useLocation();

  if (!secret) {
    if (location !== '/login') {
      return <Login />;
    }
    return (
      <Switch>
        <Route path="/login" component={Login} />
        <Route component={Login} />
      </Switch>
    );
  }

  return (
    <AdminLayout>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/users" component={Users} />
        <Route path="/tokens" component={Tokens} />
        <Route path="/trades" component={Trades} />
        <Route path="/system" component={System} />
        <Route path="/fees" component={Fees} />
        <Route path="/analytics" component={Analytics} />
        <Route component={NotFound} />
      </Switch>
    </AdminLayout>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <ProtectedRoutes />
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AdminProvider>
            <Router />
          </AdminProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
