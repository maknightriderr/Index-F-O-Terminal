'use client';

import React from 'react';
import { useMarketStore } from '@/stores';
import { pageMeta } from '@/lib/nav';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { SessionCluster } from './session-cluster';
import { AlertBell } from './alert-bell';
import { CommandBar } from './command-bar';
import { SettingsMenu } from './settings-menu';

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
  const title = pageMeta(activeTab)?.label ?? 'Instrument';

  const clock = new Date(feed.now).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <header className="relative z-10 flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 md:gap-4 md:px-4">
      <div className="min-w-0 shrink-0 max-w-[40vw] lg:max-w-none">
        <p className="truncate text-base font-semibold tracking-tight md:text-lg">{title}</p>
      </div>
      <span className="rounded border border-[var(--desk-accent)]/40 bg-[var(--desk-accent)]/10 px-2 py-1 text-xs font-semibold tracking-wider text-[var(--desk-accent)]">PAPER</span>

      <div className="flex min-w-0 flex-1 justify-center"><CommandBar /></div>

      <div className="hidden sm:block"><SessionCluster feed={feed} onOpen={() => setActiveTab('system-health')} /></div>

      <AlertBell />
      <SettingsMenu />

      <div className="shrink-0 text-right font-mono text-sm tabular-nums text-[var(--text-secondary)]" aria-label={`Current time ${clock} IST`}>
        <span className="sm:hidden">{clock.slice(0, 5)}</span>
        <span className="hidden sm:inline">{clock}</span>
        <span className="ml-1 hidden text-xs sm:inline">IST</span>
      </div>
    </header>
  );
}

