'use client';

import React from 'react';
import { useAssetTabsStore, useMarketStore } from '@/stores';
import { AddAssetButton } from '@/components/common/add-asset-button';

export function AssetTabBar() {
  const { tabs, switchToTab, closeTab } = useAssetTabsStore();
  const activeTab = useMarketStore((s) => s.activeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 h-10 px-3 bg-[#0d0d14]/80 backdrop-blur border-b border-gray-800/50 shrink-0 overflow-x-auto scrollbar-thin">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => switchToTab(tab.id)}
            className={`group flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-all duration-150 ${
              isActive
                ? 'bg-gradient-to-b from-emerald-500/20 to-emerald-500/10 text-emerald-300 border border-emerald-500/40 shadow-[0_0_0_1px_rgba(16,185,129,0.15),0_2px_8px_-2px_rgba(16,185,129,0.3)]'
                : 'bg-gray-800/40 text-gray-400 border border-transparent hover:bg-gray-800/70 hover:text-gray-200'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-emerald-400' : 'bg-gray-600'}`} />
            {tab.symbol}
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="ml-0.5 w-4 h-4 flex items-center justify-center rounded text-gray-500 opacity-0 group-hover:opacity-100 hover:bg-gray-700/60 hover:text-gray-200 transition-all"
            >
              ×
            </span>
          </button>
        );
      })}
      <div className="pl-1">
        <AddAssetButton compact />
      </div>
    </div>
  );
}
