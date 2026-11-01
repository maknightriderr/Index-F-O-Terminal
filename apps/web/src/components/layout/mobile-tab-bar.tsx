'use client';

import React from 'react';
import { useMarketStore } from '@/stores';
import { resolveTab } from '@/lib/nav';
import { useTerminalNavigation } from './terminal-navigation';

const TABS: Array<{ id: string; label: string; d: string; pages: string[] }> = [
  { id: 'dashboard', label: 'Home', d: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z', pages: ['dashboard'] },
  { id: 'option-chain', label: 'Chain', d: 'M4 6h16 M4 12h16 M4 18h16 M12 3v18', pages: ['option-chain'] },
  { id: 'paper-trades', label: 'Trades', d: 'M4 19l5-6 4 3 7-9', pages: ['paper-trades', 'strategy-lab'] },
  { id: 'system-health', label: 'Ops', d: 'M22 12h-4l-3 9L9 3l-3 9H2', pages: ['system-health', 'alerts', 'system-learning'] },
];

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
