'use client';

import React, { useState, useEffect } from 'react';
import { Sidebar } from './sidebar';
import { TopBar } from './topbar';
import { AssetTabBar } from './asset-tab-bar';
import { ThemeEffect } from '@/components/theme-effect';

interface AppShellProps {
  children: React.ReactNode;
}

/**
 * The first frame, before the persisted settings have loaded. It matches the real layout (rail + top bar + content
 * blocks) so nothing jumps when the app appears, and it carries no data — only placeholders — so it can never be
 * mistaken for live information. It replaces the blank screen the shell used to render until mount.
 */
export function ShellSkeleton() {
  return (
    <div role="status" aria-label="Loading the terminal" data-testid="shell-skeleton" className="flex h-[100dvh] w-full overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <aside className="hidden h-full w-14 shrink-0 border-r border-[var(--border-primary)] bg-[var(--bg-secondary)] md:block md:w-56">
        <div className="h-12 border-b border-[var(--border-primary)]" />
        <div className="space-y-3 p-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-[var(--surface-card-alt)]" />
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="h-12 shrink-0 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)]" />
        <div className="grid flex-1 grid-cols-1 gap-4 p-4 md:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border border-[var(--border-primary)] bg-[var(--surface-card)]" />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading the terminal…</span>
    </div>
  );
}

export function AppShell({ children }: AppShellProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  // The persisted UI settings are read on the client, so the real layout waits for mount — but it shows the skeleton, not a blank screen.
  if (!mounted) return <ShellSkeleton />;

  return (
    // h-[100dvh] not h-screen: 100vh on mobile browsers measures the viewport as if the address bar were hidden.
    // w-full not w-screen: 100vw includes the scrollbar gutter, which produces a phantom horizontal scroll.
    <div className="flex h-[100dvh] w-full overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)] font-sans">
      <ThemeEffect />
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-[var(--surface-card)] focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Sidebar />

      <div className="relative z-[1] flex min-w-0 flex-1 flex-col">
        <TopBar />
        <AssetTabBar />
        <div className="flex min-h-0 flex-1">
          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-auto">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
