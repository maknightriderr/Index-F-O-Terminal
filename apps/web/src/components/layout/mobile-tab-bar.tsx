'use client';

import React from 'react';
import { useMarketStore } from '@/stores';
import { NAV_GROUPS, resolveTab } from '@/lib/nav';
import { useTerminalNavigation } from './terminal-navigation';

const PATHS: Record<string, string> = {
  today: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z',
  trade: 'M3 4h18v16H3z M3 9h18 M10 9v11',
  opportunities: 'M13 2L3 14h9l-1 8 10-12h-9l1-8',
  paper: 'M4 19l5-6 4 3 7-9',
};
/** The four workspaces a phone needs most, from the one registry (lib/nav.ts); "More" opens everything else. */
const TABS = ['today', 'trade', 'opportunities', 'paper'].map((id) => {
  const g = NAV_GROUPS.find((x) => x.id === id)!;
  return { id: g.primary, label: g.short, d: PATHS[id], pages: g.items.map((i) => i.id as string) };
});

/** Phones only (CSS): a thumb-reach tab bar in place of the side rail. "More" opens the full page directory. */
export function MobileTabBar() {
  const active = useMarketStore((s) => resolveTab(s.activeTab).tab);
  const go = useMarketStore((s) => s.setActiveTab);
  const openDirectory = useTerminalNavigation();
  return (
    <nav className="cc-tabbar" aria-label="Main (phone)">
      {TABS.map((t) => (
        <button key={t.id} type="button" aria-current={t.pages.includes(active) ? 'page' : undefined} onClick={() => go(t.id)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={t.d} />
          </svg>
          {t.label}
        </button>
      ))}
      <button type="button" onClick={openDirectory}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 4h5v5H4z M15 4h5v5h-5z M4 15h5v5H4z M15 15h5v5h-5z" />
        </svg>
        More
      </button>
    </nav>
  );
}
