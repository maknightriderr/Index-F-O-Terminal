'use client';

import React from 'react';
import { useMarketStore } from '@/stores';
import { AddAssetButton } from '@/components/common/add-asset-button';
import { NAV_GROUPS, resolveTab } from '@/lib/nav';
import { useTerminalNavigation } from './terminal-navigation';

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
  'system-health': 'M22 12h-4l-3 9L9 3l-3 9H2',
  'system-learning': 'M12 4a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 6 0v-1a3 3 0 0 0 0-6V7a3 3 0 0 0-3-3zM12 4v16',
  asset: 'M3 17l6-6 4 4 8-8 M14 7h7v7',
  'paper-trades': 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z M9 12h6 M9 16h4',
  'best-setups': 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  measurement: 'M3 3v18h18 M7 16v-3 M12 16V8 M17 16v-6',
  evidence: 'M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
};

export function Sidebar() {
  const storedTab = useMarketStore(s => s.activeTab);
  const activeTab = resolveTab(storedTab).tab;
  const setActiveTab = useMarketStore(s => s.setActiveTab);
  const openDirectory = useTerminalNavigation();
  const primary = [
    { id: 'dashboard', label: 'Dashboard', pages: ['dashboard'] },
    { id: 'indices', label: 'Markets', pages: ['indices', 'fno-explorer', 'corporate-actions', 'institutional-flow'] },
    { id: 'best-setups', label: 'Setups', pages: ['best-setups', 'market-scanner', 'strategy-scanner'] },
    { id: 'paper-trades', label: 'Paper trades', pages: ['paper-trades'] },
    { id: 'measurement', label: 'Performance', pages: ['measurement', 'backtesting', 'loss-attribution', 'evidence'] },
    { id: 'signal-diagnostics', label: 'Research', pages: ['signal-diagnostics'] },
    { id: 'system-health', label: 'System', pages: ['system-health', 'alerts', 'system-learning'] },
  ];
  const items = NAV_GROUPS.flatMap(g => g.items);
  return <aside aria-label="Primary" className="desk-rail terminal-rail">
    <button type="button" aria-label="Go to dashboard" onClick={() => setActiveTab('dashboard')} className="terminal-brand"><span>F&O</span></button>
    <nav aria-label="Pages" className="terminal-rail-pages">
      {primary.map(link => {
        const item = items.find(i => i.id === link.id)!;
        const selected = link.pages.includes(activeTab);
        return <button key={link.id} type="button" aria-current={selected ? (activeTab === link.id ? 'page' : 'true') : undefined} aria-label={item.label} title={`${link.label}: ${item.description}`} onClick={() => setActiveTab(link.id)} className="terminal-rail-item"><Icon d={ICONS[item.icon] ?? ICONS.dashboard} /><span>{link.label}</span></button>;
      })}
      <button type="button" onClick={openDirectory} aria-label="All pages" title="All pages · Ctrl / ⌘ K" className="terminal-rail-item"><Icon d="M4 4h5v5H4z M15 4h5v5h-5z M4 15h5v5H4z M15 15h5v5h-5z" /><span>All pages</span></button>
    </nav>
    <div className="terminal-rail-footer"><AddAssetButton compact /></div>
  </aside>;
}
