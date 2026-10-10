'use client';

import React from 'react';
import { useMarketStore, useUISettingsStore, useAssetTabsStore } from '@/stores';
import { AddAssetButton } from '@/components/common/add-asset-button';
import { NAV_GROUPS } from '@/lib/nav';

// ============================================================
// SIDEBAR ICONS — Inline SVG (Lucide-style, 18×18 stroked); no icon dependency.
// ============================================================

function Icon({ d, className = '' }: { d: string; className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      <path d={d} />
    </svg>
  );
}

const ICONS: Record<string, string> = {
  dashboard: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  indices: 'M22 12h-4l-3 9L9 3l-3 9H2',
  'fno-stocks': 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 12h6 M9 16h6 M12 2v4',
  'corporate-actions': 'M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M8 14h.01 M12 14h.01 M16 14h.01 M8 18h.01 M12 18h.01',
  'oi-intelligence': 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35 M11 8v4l2.5 1.5',
  'market-scanner': 'M13 2L3 14h9l-1 8 10-12h-9l1-8',
  'strategy-scanner': 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 8v8 M8 12h8',
  backtesting: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  'loss-attribution': 'M3 3v18h18 M7 8l4 4 3-3 5 6',
  'signal-diagnostics': 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35 M7 11h2l1.5-3 2 6 1.5-3h2',
  'institutional-flow': 'M1 4v6h6 M23 20v-6h-6 M20.49 9A9 9 0 0 0 5.64 5.64L1 10 M23 14l-4.64 4.36A9 9 0 0 1 3.51 15',
  positions: 'M20 7h-9 M14 17H5 M17 17a3 3 0 1 0 0-6 M7 7a3 3 0 1 0 0 6',
  alerts: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0',
  'ai-assistant': 'M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.27A7 7 0 0 1 7.27 19H6a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h-1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z M10 14a1 1 0 1 0 0 2 M14 14a1 1 0 1 0 0 2',
  'system-health': 'M22 12h-4l-3 9L9 3l-3 9H2',
  'system-learning': 'M12 4a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 6 0v-1a3 3 0 0 0 0-6V7a3 3 0 0 0-3-3zM12 4v16',
  asset: 'M3 17l6-6 4 4 8-8 M14 7h7v7',
  'paper-trades': 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z M9 12h6 M9 16h4',
  'best-setups': 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  measurement: 'M3 3v18h18 M7 16v-3 M12 16V8 M17 16v-6',
};

export function Sidebar() {
  const { sidebarOpen, toggleSidebar } = useUISettingsStore();
  const { activeTab, setActiveTab } = useMarketStore();
  const assetTabs = useAssetTabsStore((s) => s.tabs);
  const switchToTab = useAssetTabsStore((s) => s.switchToTab);

  const itemClass = (active: boolean) =>
    `relative flex w-full items-center rounded-lg px-2.5 py-2 text-sm transition-colors ${
      active ? 'bg-[var(--accent-indigo)]/15 text-[var(--text-primary)] font-semibold' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-card-alt)] hover:text-[var(--text-primary)]'
    }`;

  return (
    <aside
      aria-label="Primary"
      // Always the narrow icon rail on a phone: an expanded 224 px sidebar on a ~390 px screen leaves too little for the
      // dense screens it navigates to. Every item keeps its name in aria-label and a tooltip.
      className={`relative z-[2] flex h-full w-14 shrink-0 flex-col border-r border-[var(--border-primary)] bg-[var(--bg-secondary)] ${sidebarOpen ? 'md:w-56' : 'md:w-14'}`}
    >
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? 'Collapse the sidebar' : 'Expand the sidebar'}
        aria-expanded={sidebarOpen}
        className="flex h-12 items-center border-b border-[var(--border-primary)] px-3 text-left hover:bg-[var(--surface-card-alt)]"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 text-xs font-bold text-black">F&O</span>
        {sidebarOpen && <span className="ml-2.5 hidden truncate text-sm font-semibold tracking-tight md:inline">Terminal</span>}
      </button>

      <div className="border-b border-[var(--border-primary)] px-2 py-2">
        <div className="md:hidden">
          <AddAssetButton compact />
        </div>
        <div className="hidden md:block">
          <AddAssetButton compact={!sidebarOpen} />
        </div>
      </div>

      <nav aria-label="Pages" className="flex-1 space-y-1 overflow-y-auto px-1.5 py-2">
        {NAV_GROUPS.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`nav-${group.id}`}>
            {sidebarOpen ? (
              <div id={`nav-${group.id}`} className="hidden px-2.5 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] md:block">
                {group.title}
              </div>
            ) : (
              <div id={`nav-${group.id}`} className="sr-only">
                {group.title}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = activeTab === item.id;
                return (
                  <button key={item.id} type="button" onClick={() => setActiveTab(item.id)} aria-current={active ? 'page' : undefined} aria-label={item.label} title={`${item.label}: ${item.description}`} className={itemClass(active)}>
                    {active && <span aria-hidden="true" className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-[var(--accent-green)]" />}
                    <span className="flex w-7 shrink-0 items-center justify-center">
                      <Icon d={ICONS[item.icon] ?? ICONS.dashboard} className={active ? 'text-[var(--accent-green)]' : ''} />
                    </span>
                    {sidebarOpen && <span className="ml-1 hidden truncate md:inline">{item.label}</span>}
                  </button>
                );
              })}
              {group.id === 'trade-desk' &&
                assetTabs.map((t) => {
                  const active = activeTab === t.id;
                  return (
                    <button key={t.id} type="button" onClick={() => switchToTab(t.id)} aria-current={active ? 'page' : undefined} aria-label={`Asset workspace ${t.symbol}`} title={`Asset workspace: ${t.symbol} (${t.exchange})`} className={itemClass(active)}>
                      <span className="flex w-7 shrink-0 items-center justify-center">
                        <Icon d={ICONS.asset} className={active ? 'text-[var(--accent-green)]' : ''} />
                      </span>
                      {sidebarOpen && (
                        <span className="ml-1 hidden truncate md:inline">
                          {t.symbol} <span className="text-xs text-[var(--text-dimmed)]">workspace</span>
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--border-primary)] px-3 py-2.5 text-xs text-[var(--text-secondary)]">
        {sidebarOpen ? <span className="hidden md:inline">F&amp;O Terminal v0.1 · paper trading only</span> : null}
        <span className={sidebarOpen ? 'md:hidden' : ''} aria-hidden="true">
          v0.1
        </span>
      </div>
    </aside>
  );
}
