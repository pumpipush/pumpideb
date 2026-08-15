import React from 'react';
import { Link, useLocation } from 'wouter';
import { LayoutDashboard, Users, Coins, ArrowRightLeft, Settings, LogOut } from 'lucide-react';
import { useAdmin } from '@/contexts/AdminContext';
import { cn } from '@/lib/utils';

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { clearSecret } = useAdmin();

  const navItems = [
    { href: '/', label: 'Overview', icon: LayoutDashboard },
    { href: '/users', label: 'Users', icon: Users },
    { href: '/tokens', label: 'Tokens', icon: Coins },
    { href: '/trades', label: 'Trades', icon: ArrowRightLeft },
    { href: '/system', label: 'System', icon: Settings },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside className="w-64 flex-shrink-0 border-r border-border bg-sidebar flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-border">
          <div className="flex items-center gap-2 text-primary font-mono font-bold tracking-tight text-lg">
            <div className="w-3 h-3 bg-primary rounded-sm brand-glow"></div>
            PUMPI<span className="text-muted-foreground font-sans text-xs">/OPS</span>
          </div>
        </div>
        <nav className="flex-1 py-4 flex flex-col gap-1 px-2">
          {navItems.map((item) => {
            const active = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                  active 
                    ? "bg-sidebar-primary/10 text-primary font-medium" 
                    : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
                )}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <item.icon className={cn("w-4 h-4", active ? "text-primary" : "")} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-border">
          <button
            onClick={clearSecret}
            className="flex items-center gap-3 px-3 py-2 w-full rounded-md text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            data-testid="nav-logout"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="h-14 flex-shrink-0 flex items-center px-6 border-b border-border bg-card">
          <h1 className="text-lg font-semibold tabular">
            {navItems.find(i => i.href === location)?.label || 'Dashboard'}
          </h1>
        </header>
        <div className="flex-1 overflow-auto p-6 bg-background">
          {children}
        </div>
      </main>
    </div>
  );
}
