import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import {
  LayoutDashboard, Users, Coins, ArrowRightLeft,
  Settings, LogOut, TrendingUp, Menu, X,
} from 'lucide-react';
import { useAdmin } from '@/contexts/AdminContext';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/',        label: 'Overview', icon: LayoutDashboard },
  { href: '/users',   label: 'Users',    icon: Users },
  { href: '/tokens',  label: 'Tokens',   icon: Coins },
  { href: '/trades',  label: 'Trades',   icon: ArrowRightLeft },
  { href: '/fees',    label: 'Fees',     icon: TrendingUp },
  { href: '/system',  label: 'System',   icon: Settings },
];

function SidebarContent({
  location,
  clearSecret,
  onNavClick,
}: {
  location: string;
  clearSecret: () => void;
  onNavClick?: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="h-14 flex items-center px-4 border-b border-border gap-3 flex-shrink-0">
        <img
          src={`${import.meta.env.BASE_URL}pumpi-logo.png`}
          alt="Pumpi"
          className="h-6 w-auto object-contain"
        />
        <span className="text-muted-foreground font-mono text-xs tracking-widest">/OPS</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 flex flex-col gap-1 px-2 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const active = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavClick}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors',
                active
                  ? 'bg-sidebar-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent',
              )}
              data-testid={`nav-${item.label.toLowerCase()}`}
            >
              <item.icon className={cn('w-4 h-4 shrink-0', active ? 'text-primary' : '')} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Sign out */}
      <div className="p-4 border-t border-border flex-shrink-0">
        <button
          onClick={clearSecret}
          className="flex items-center gap-3 px-3 py-2 w-full rounded-md text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          data-testid="nav-logout"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Sign Out
        </button>
      </div>
    </div>
  );
}

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { clearSecret } = useAdmin();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close drawer on route change
  useEffect(() => { setMobileOpen(false); }, [location]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  const pageLabel = NAV_ITEMS.find(i => i.href === location)?.label ?? 'Dashboard';

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">

      {/* ── Desktop sidebar ─────────────────────────────── */}
      <aside className="hidden md:flex w-64 flex-shrink-0 border-r border-border bg-sidebar flex-col">
        <SidebarContent location={location} clearSecret={clearSecret} />
      </aside>

      {/* ── Mobile backdrop ─────────────────────────────── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Mobile drawer ───────────────────────────────── */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-72 bg-sidebar border-r border-border flex flex-col',
          'transition-transform duration-250 ease-in-out md:hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Navigation"
      >
        {/* Close button */}
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute top-3 right-3 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
          data-testid="nav-close"
          aria-label="Close menu"
        >
          <X className="w-4 h-4" />
        </button>
        <SidebarContent
          location={location}
          clearSecret={clearSecret}
          onNavClick={() => setMobileOpen(false)}
        />
      </aside>

      {/* ── Main area ───────────────────────────────────── */}
      <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
        {/* Top bar */}
        <header className="h-14 flex-shrink-0 flex items-center px-4 md:px-6 border-b border-border bg-card gap-3">
          {/* Hamburger — mobile only */}
          <button
            onClick={() => setMobileOpen(true)}
            className="md:hidden p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            data-testid="nav-hamburger"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-base md:text-lg font-semibold tabular truncate">{pageLabel}</h1>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-auto p-4 md:p-6 bg-background">
          {children}
        </div>
      </div>
    </div>
  );
}
