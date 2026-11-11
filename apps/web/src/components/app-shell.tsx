import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, ChevronsUpDown, Inbox, LogOut, Menu, Network, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authClient } from '@/lib/auth-client';
import { useLiveEvents } from '@/lib/live';
import { useHealth, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';

function NavItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center gap-3 rounded-md px-3 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground',
          isActive && 'bg-sidebar-accent font-medium text-sidebar-foreground',
        )
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

function SystemStatus() {
  const health = useHealth();
  const settings = useSettings();
  const ok = health.data?.status === 'ok';
  return (
    <div className="space-y-2 rounded-lg border bg-background/60 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">API</span>
        <span className="flex items-center gap-1.5">
          <span
            className={cn('size-1.5 rounded-full', health.isPending ? 'bg-muted-foreground/40' : ok ? 'bg-success' : 'bg-destructive')}
          />
          {health.isPending ? 'Checking' : ok ? 'Healthy' : 'Unreachable'}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">MLLP</span>
        <span className="truncate font-mono">
          {settings.data ? `${settings.data.mllp.host}:${settings.data.mllp.portRange.from}–${settings.data.mllp.portRange.to}` : '…'}
        </span>
      </div>
    </div>
  );
}

function UserMenu({ email }: { email: string }) {
  const qc = useQueryClient();
  async function signOut() {
    await authClient.signOut();
    qc.clear();
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium uppercase">
          {email.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate">{email}</span>
        <ChevronsUpDown className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="flex items-center justify-between px-2 py-1.5 text-sm">
          Theme <ThemeToggle />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarContent({ email, onNavigate }: { email: string; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-6 p-4" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <Logo className="px-2 pt-1" />
      <nav className="flex flex-col gap-0.5" aria-label="Main">
        <NavItem to="/channels" icon={<Network className="size-4" />}>
          Channels
        </NavItem>
        <NavItem to="/messages" icon={<Inbox className="size-4" />}>
          Messages
        </NavItem>
        <a
          href="/api/docs"
          target="_blank"
          rel="noreferrer"
          className="flex h-9 items-center gap-3 rounded-md px-3 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <BookOpen className="size-4" />
          API docs
        </a>
      </nav>
      <div className="mt-auto space-y-3">
        <SystemStatus />
        <UserMenu email={email} />
      </div>
    </div>
  );
}

export function AppShell({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  useLiveEvents(qc); // one SSE stream for the whole authenticated app
  return (
    <div className="min-h-svh bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r bg-sidebar lg:block">
        <SidebarContent email={email} />
      </aside>

      {/* Mobile top bar + drawer */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/90 px-4 backdrop-blur lg:hidden">
        <Logo />
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="rounded-md p-2 hover:bg-muted">
          <Menu className="size-5" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r bg-sidebar shadow-xl">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="absolute top-4 right-3 rounded-md p-1.5 hover:bg-muted"
            >
              <X className="size-4" />
            </button>
            <SidebarContent email={email} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <main className="lg:pl-64">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
