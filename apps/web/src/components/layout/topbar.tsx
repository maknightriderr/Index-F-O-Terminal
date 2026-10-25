'use client';

import React from 'react';
import { useMarketStore, useUISettingsStore } from '@/stores';
import type { ThemeName } from '@/stores';
import { pageMeta } from '@/lib/nav';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { formatIstDateTime } from '@/lib/format';
import { FreshnessBadge } from '@/components/ui/status-badge';
import { AlertBell } from './alert-bell';
import { SignOutButton } from '@/components/auth/sign-out-button';

// ============================================================
// TOP BAR — workspace title, paper mode, freshness, alerts, theme and clock
// ============================================================
// The pill is derived from the newest quote's own timestamp and the exchange session (lib/freshness.ts), never from
// whether a socket is open. Outside the session it reads "MARKET CLOSED" with the last observation time — a closed
// market is not a failing feed, and a stored closing price is not a live quote.
// ============================================================

export function TopBar() {
  const { activeTab, setActiveTab } = useMarketStore();
  const feed = useFeedSummary();
  const title = activeTab === 'dashboard' ? 'Trading desk' : pageMeta(activeTab)?.label ?? 'Asset workspace';

  const clock = new Date(feed.now).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <header className="relative z-10 flex h-16 shrink-0 items-center gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 md:gap-4 md:px-4">
      <div className="min-w-0">
        <p className="truncate text-base font-semibold tracking-tight md:text-xl">{title}</p>
        <p className="hidden text-xs text-[var(--text-secondary)] lg:block">Market context. Clear decisions.</p>
      </div>
      <span className="rounded border border-[var(--desk-accent)]/40 bg-[var(--desk-accent)]/10 px-2 py-1 text-xs font-semibold tracking-wider text-[var(--desk-accent)]">PAPER</span>

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => setActiveTab('system-health')}
        title={`${feed.quotes.detail} Open System Health.`}
        aria-label={`Data status: ${feed.quotes.label}. ${feed.quotes.detail} Open System Health.`}
        className="hidden items-center gap-2 rounded-md px-1 py-1 hover:bg-[var(--surface-card-alt)] sm:flex"
      >
        <FreshnessBadge state={feed.quotes.state} label={feed.quotes.state === 'MARKET_CLOSED' ? `NSE CLOSED · last ${formatIstDateTime(feed.quotesObservedAt, feed.now)}` : feed.quotes.label} />
      </button>

      <AlertBell />
      <ThemeSwitcher />
      <SignOutButton />

      <div className="shrink-0 text-right font-mono text-sm tabular-nums text-[var(--text-secondary)]" style={{ fontFamily: "'JetBrains Mono', monospace" }} aria-label={`Current time ${clock} IST`}>
        <span className="sm:hidden">{clock.slice(0, 5)}</span>
        <span className="hidden sm:inline">{clock}</span>
        <span className="ml-1 hidden text-xs sm:inline">IST</span>
      </div>
    </header>
  );
}

// --- Theme Switcher ---

const THEME_OPTIONS: Array<{ value: ThemeName; icon: string; label: string }> = [
  { value: 'dark', icon: '◐', label: 'Dark' },
  { value: 'light', icon: '☼', label: 'Light' },
  { value: 'system', icon: '▣', label: 'System' },
];

const NEXT_THEME: Record<ThemeName, ThemeName> = { dark: 'light', light: 'system', system: 'dark' };

function ThemeSwitcher() {
  const { theme, setTheme } = useUISettingsStore();
  const current = THEME_OPTIONS.find((o) => o.value === theme) ?? THEME_OPTIONS[0];
  return (
    <>
      {/* Phones: one button that cycles the theme, so the top bar does not overflow. */}
      <button
        type="button"
        onClick={() => setTheme(NEXT_THEME[theme])}
        aria-label={`Theme: ${current.label}. Switch to ${THEME_OPTIONS.find((o) => o.value === NEXT_THEME[theme])!.label}.`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--border-secondary)] bg-[var(--surface-card-alt)] text-sm sm:hidden"
      >
        <span aria-hidden="true">{current.icon}</span>
      </button>
      <ThemeRadios theme={theme} setTheme={setTheme} />
    </>
  );
}

function ThemeRadios({ theme, setTheme }: { theme: ThemeName; setTheme: (t: ThemeName) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="hidden items-center gap-0.5 rounded-full border border-[var(--border-secondary)] bg-[var(--surface-card-alt)] p-0.5 sm:flex">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={theme === opt.value}
          aria-label={`${opt.label} theme`}
          onClick={() => setTheme(opt.value)}
          title={`${opt.label} theme`}
          className={`flex h-7 w-7 items-center justify-center rounded-full text-sm transition-colors ${theme === opt.value ? 'bg-[var(--accent-indigo)]/25 ring-1 ring-[var(--accent-indigo)]' : 'hover:bg-[var(--surface-card-alt)]'}`}
        >
          <span aria-hidden="true">{opt.icon}</span>
        </button>
      ))}
    </div>
  );
}
