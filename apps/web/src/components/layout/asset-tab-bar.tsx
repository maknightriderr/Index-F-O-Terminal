'use client';

import React from 'react';
import { useAssetTabsStore, useMarketStore } from '@/stores';
import { AddAssetButton } from '@/components/common/add-asset-button';

export function AssetTabBar() {
  const { tabs, switchToTab, closeTab } = useAssetTabsStore();
  const activeTab = useMarketStore((s) => s.activeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 h-10 px-3 bg-[#0b0b12]/90 light:bg-white/90 backdrop-blur-sm border-b border-gray-800/40 light:border-slate-200 shrink-0 overflow-x-auto scrollbar-thin">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => switchToTab(tab.id)}
            className={`group relative flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-all duration-200 ${
              isActive
                ? 'bg-gradient-to-b from-emerald-500/20 to-emerald-500/8 light:from-emerald-500/15 light:to-emerald-500/8 text-emerald-300 light:text-emerald-700 border border-emerald-500/30 shadow-[0_0_0_1px_rgba(16,185,129,0.1),0_2px_10px_-2px_rgba(16,185,129,0.35)]'
                : 'bg-gray-800/30 light:bg-slate-100 text-gray-400 light:text-slate-600 border border-transparent hover:bg-gray-800/50 light:hover:bg-slate-200 hover:text-gray-200 light:hover:text-slate-900 hover:border-gray-700/40 light:hover:border-slate-300'
            }`}
          >
            {/* Glowing bottom accent on active tab */}
            {isActive && (
              <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-gradient-to-r from-transparent via-emerald-400 to-transparent rounded-full shadow-[0_0_6px_rgba(16,185,129,0.5)]" />
            )}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-emerald-400 shadow-[0_0_4px_rgba(16,185,129,0.5)]' : 'bg-gray-600 light:bg-slate-400'}`} />
            {tab.symbol}
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="ml-0.5 w-4 h-4 flex items-center justify-center rounded text-gray-500 opacity-0 group-hover:opacity-100 hover:bg-gray-700/60 light:hover:bg-slate-300 hover:text-gray-200 light:hover:text-slate-900 hover:scale-110 transition-all duration-150"
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
