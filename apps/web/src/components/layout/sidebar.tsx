'use client';

import React from 'react';
import { useMarketStore, useUISettingsStore } from '@/stores';
import { AddAssetButton } from '@/components/common/add-asset-button';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'indices', label: 'Indices', icon: '📈' },
  { id: 'fno-stocks', label: 'F&O Stocks', icon: '📋' },
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
        className="flex items-center h-12 px-3 border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/30 transition-colors"
        onClick={toggleSidebar}
      >
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center text-sm font-bold text-black shrink-0 shadow-[0_2px_10px_-2px_rgba(16,185,129,0.5)]">
          F&O
        </div>
        {sidebarOpen && (
          <span className="ml-2 text-sm font-semibold text-gray-100 truncate tracking-tight">
            Terminal
          </span>
        )}
      </div>

      {/* Add Asset */}
      <div className="px-2 py-2 border-b border-gray-800/50">
        <AddAssetButton compact={!sidebarOpen} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-1.5 scrollbar-thin space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center px-2.5 py-2 text-sm rounded-lg transition-all duration-150 ${
                isActive
                  ? 'bg-gradient-to-r from-emerald-500/15 to-emerald-500/5 text-emerald-300 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.2)]'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
              }`}
              title={!sidebarOpen ? item.label : undefined}
            >
              <span className="text-base shrink-0 w-7 text-center">{item.icon}</span>
              {sidebarOpen && (
                <span className="ml-1 truncate">{item.label}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-gray-800/50 px-3 py-2">
        {sidebarOpen && (
          <div className="text-[10px] text-gray-600 tracking-wide">
            F&O TERMINAL
          </div>
        )}
      </div>
    </aside>
  );
}
