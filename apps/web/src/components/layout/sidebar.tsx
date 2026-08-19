'use client';

import React from 'react';
import { useMarketStore, useUISettingsStore } from '@/stores';
import { AddAssetButton } from '@/components/common/add-asset-button';

// ============================================================
// SIDEBAR ICONS — Inline SVG (Lucide-style, 18×18 stroked)
// Avoids adding a dependency on lucide-react.
// ============================================================

function Icon({ d, className = '' }: { d: string; className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      <path d={d} />
    </svg>
  );
}

// Pre-built icon paths (Lucide-compatible)
const ICONS: Record<string, string> = {
  dashboard:    'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  indices:      'M22 12h-4l-3 9L9 3l-3 9H2',
  'fno-stocks': 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 12h6 M9 16h6 M12 2v4',
  'oi-intelligence': 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35 M11 8v4l2.5 1.5',
  'iv-greeks':  'M9.5 2A5.5 5.5 0 0 0 4 7.5v0A5.5 5.5 0 0 0 9.5 13h0a5.5 5.5 0 0 0 0-11z M14.5 11a5.5 5.5 0 0 0 0 11h0a5.5 5.5 0 0 0 0-11z',
  'market-scanner': 'M13 2L3 14h9l-1 8 10-12h-9l1-8',
  'strategy-scanner': 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 8v8 M8 12h8',
  backtesting:  'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  'market-replay': 'M1 4v6h6 M23 20v-6h-6 M20.49 9A9 9 0 0 0 5.64 5.64L1 10 M23 14l-4.64 4.36A9 9 0 0 1 3.51 15',
  positions:    'M20 7h-9 M14 17H5 M17 17a3 3 0 1 0 0-6 M7 7a3 3 0 1 0 0 6',
  alerts:       'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0',
  'ai-assistant': 'M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.27A7 7 0 0 1 7.27 19H6a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h-1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z M10 14a1 1 0 1 0 0 2 M14 14a1 1 0 1 0 0 2',
  'system-health': 'M22 12h-4l-3 9L9 3l-3 9H2',
  settings:     'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};

// ============================================================
// NAV ITEMS grouped into sections
// ============================================================

interface NavItem {
  id: string;
  label: string;
  icon: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Markets',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { id: 'indices', label: 'Indices', icon: 'indices' },
      { id: 'fno-stocks', label: 'F&O Stocks', icon: 'fno-stocks' },
    ],
  },
  {
    title: 'Analysis',
    items: [
      { id: 'oi-intelligence', label: 'OI Intelligence', icon: 'oi-intelligence' },
      { id: 'iv-greeks', label: 'IV & Greeks', icon: 'iv-greeks' },
      { id: 'market-scanner', label: 'Market Scanner', icon: 'market-scanner' },
    ],
  },
  {
    title: 'Tools',
    items: [
      { id: 'strategy-scanner', label: 'Strategy Scanner', icon: 'strategy-scanner' },
      { id: 'backtesting', label: 'Backtesting', icon: 'backtesting' },
      { id: 'market-replay', label: 'Market Replay', icon: 'market-replay' },
      { id: 'positions', label: 'Positions', icon: 'positions' },
    ],
  },
  {
    title: 'System',
    items: [
      { id: 'alerts', label: 'Alerts', icon: 'alerts' },
      { id: 'ai-assistant', label: 'AI Assistant', icon: 'ai-assistant' },
      { id: 'system-health', label: 'System Health', icon: 'system-health' },
      { id: 'settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

export function Sidebar() {
  const { sidebarOpen, toggleSidebar } = useUISettingsStore();
  const { activeTab, setActiveTab } = useMarketStore();

  return (
    <aside
      className={`flex flex-col h-full bg-[#0b0b12]/95 light:bg-white/95 backdrop-blur-sm border-r border-gray-800/40 light:border-slate-200 transition-all duration-300 ease-out relative z-[2] ${
        sidebarOpen ? 'w-56' : 'w-14'
      }`}
    >
      {/* Logo */}
      <div
        className="flex items-center h-12 px-3 border-b border-gray-800/40 light:border-slate-200 cursor-pointer hover:bg-gray-800/20 light:hover:bg-slate-50 transition-colors"
        onClick={toggleSidebar}
      >
        <div className="relative">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 via-emerald-500 to-cyan-500 flex items-center justify-center text-sm font-bold text-black shrink-0 shadow-[0_2px_12px_-2px_rgba(16,185,129,0.6)] animate-gradient-flow" style={{ backgroundSize: '200% 200%' }}>
            F&O
          </div>
          {/* Pulsing ring behind logo */}
          <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-emerald-400/20 to-cyan-500/20 animate-breathe" />
        </div>
        {sidebarOpen && (
          <span className="ml-2.5 text-sm font-semibold text-gray-100 light:text-slate-900 truncate tracking-tight">
            Terminal
          </span>
        )}
      </div>

      {/* Add Asset */}
      <div className="px-2 py-2 border-b border-gray-800/40 light:border-slate-200">
        <AddAssetButton compact={!sidebarOpen} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-1.5 scrollbar-thin">
        {NAV_SECTIONS.map((section, sIdx) => (
          <div key={section.title}>
            {/* Section Divider — gradient fade */}
            {sIdx > 0 && (
              <div className="mx-2 my-2.5 h-px bg-gradient-to-r from-emerald-500/15 via-gray-800/40 to-transparent light:from-emerald-500/10 light:via-slate-200 light:to-transparent" />
            )}
            {/* Section Title */}
            {sidebarOpen && (
              <div className="px-2.5 pt-2 pb-1.5 text-[9px] font-bold text-gray-600 light:text-slate-400 uppercase tracking-[0.14em]">
                {section.title}
              </div>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={`sidebar-item relative w-full flex items-center px-2.5 py-2 text-sm rounded-lg transition-all duration-200 ${
                      isActive
                        ? 'bg-gradient-to-r from-emerald-500/15 via-emerald-500/8 to-transparent light:from-emerald-500/15 light:to-emerald-500/5 text-emerald-300 light:text-emerald-700 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.2),0_0_12px_-4px_rgba(16,185,129,0.15)]'
                        : 'text-gray-400 light:text-slate-500 hover:text-gray-200 light:hover:text-slate-900 hover:bg-gray-800/40 light:hover:bg-slate-100 hover:scale-[1.02]'
                    }`}
                  >
                    {/* Active indicator line */}
                    {isActive && (
                      <div className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.7),0_0_4px_rgba(16,185,129,0.4)]" />
                    )}
                    <div className="w-7 flex items-center justify-center shrink-0">
                      <Icon d={ICONS[item.icon] || ICONS.dashboard} className={isActive ? 'text-emerald-400 light:text-emerald-600 drop-shadow-[0_0_4px_rgba(16,185,129,0.4)]' : ''} />
                    </div>
                    {sidebarOpen && (
                      <span className="ml-1 truncate">{item.label}</span>
                    )}
                    {/* Tooltip when collapsed */}
                    {!sidebarOpen && (
                      <span className="sidebar-tooltip">{item.label}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-gray-800/40 light:border-slate-200 relative">
        {/* Gradient accent above footer */}
        <div className="absolute top-0 left-2 right-2 h-px bg-gradient-to-r from-transparent via-emerald-500/20 to-transparent" />
        <div className="px-3 py-2.5">
          {sidebarOpen ? (
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-breathe" />
              <div className="text-[10px] text-gray-600 light:text-slate-400 tracking-wide font-medium">
                F&O TERMINAL <span className="text-gray-700 light:text-slate-300">v0.1</span>
              </div>
            </div>
          ) : (
            <div className="flex justify-center">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-breathe" />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
