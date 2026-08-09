'use client';

import React from 'react';
import { useMarketStore, useUISettingsStore } from '@/stores';
import { AddAssetButton } from '@/components/common/add-asset-button';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'indices', label: 'Indices', icon: '📈' },
  { id: 'fno-stocks', label: 'F&O Stocks', icon: '📋' },
  { id: 'option-chain', label: 'Option Chain', icon: '⛓️' },
  { id: 'futures', label: 'Futures', icon: '📉' },
  { id: 'oi-intelligence', label: 'OI Intelligence', icon: '🔍' },
  { id: 'iv-greeks', label: 'IV & Greeks', icon: '🔬' },
  { id: 'market-scanner', label: 'Market Scanner', icon: '🔥' },
  { id: 'strategy-scanner', label: 'Strategy Scanner', icon: '🎯' },
  { id: 'backtesting', label: 'Backtesting', icon: '🧪' },
  { id: 'market-replay', label: 'Market Replay', icon: '🔄' },
  { id: 'positions', label: 'Positions', icon: '💼' },
  { id: 'alerts', label: 'Alerts', icon: '🔔' },
  { id: 'ai-assistant', label: 'AI Assistant', icon: '🤖' },
  { id: 'system-health', label: 'System Health', icon: '🏥' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

export function Sidebar() {
  const { sidebarOpen, toggleSidebar } = useUISettingsStore();
  const { activeTab, setActiveTab } = useMarketStore();

  return (
    <aside
      className={`flex flex-col h-full bg-[#0d0d14] border-r border-gray-800/50 transition-all duration-200 ${
        sidebarOpen ? 'w-56' : 'w-14'
      }`}
    >
      {/* Logo */}
      <div
        className="flex items-center h-12 px-3 border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/30"
        onClick={toggleSidebar}
      >
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center text-sm font-bold text-black shrink-0">
          F&O
        </div>
        {sidebarOpen && (
          <span className="ml-2 text-sm font-semibold text-gray-200 truncate">
            Terminal
          </span>
        )}
      </div>

      {/* Add Asset */}
      <div className="px-2 py-2 border-b border-gray-800/50">
        <AddAssetButton compact={!sidebarOpen} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 scrollbar-thin">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`w-full flex items-center px-3 py-2 text-sm transition-colors ${
              activeTab === item.id
                ? 'bg-emerald-500/10 text-emerald-400 border-r-2 border-emerald-400'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/40'
            }`}
            title={!sidebarOpen ? item.label : undefined}
          >
            <span className="text-base shrink-0 w-8 text-center">{item.icon}</span>
            {sidebarOpen && (
              <span className="ml-1 truncate">{item.label}</span>
            )}
          </button>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-gray-800/50 px-3 py-2">
        {sidebarOpen && (
          <div className="text-xs text-gray-600">
            v0.1.0 — Phase 1
          </div>
        )}
      </div>
    </aside>
  );
}
