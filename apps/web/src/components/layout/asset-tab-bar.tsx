'use client';

import React from 'react';
import { useAssetTabsStore, useMarketStore } from '@/stores';
import { AddAssetButton } from '@/components/common/add-asset-button';

export function AssetTabBar() {
  const { tabs, switchToTab, closeTab } = useAssetTabsStore();
  const activeTab = useMarketStore(s => s.activeTab);
  if (!tabs.length) return null;
  return <nav aria-label="Open instruments" className="terminal-asset-tabs">
    {tabs.map(tab => <div key={tab.id} className="terminal-asset-tab" data-active={activeTab === tab.id}>
      <button type="button" onClick={() => switchToTab(tab.id)} aria-current={activeTab === tab.id ? 'page' : undefined} aria-label={`Open ${tab.symbol} workspace`}><span>{tab.symbol}</span><small>{tab.exchange}</small></button>
      <button type="button" onClick={() => closeTab(tab.id)} aria-label={`Close ${tab.symbol} workspace`} className="terminal-asset-close">×</button>
    </div>)}
    <AddAssetButton compact />
  </nav>;
}
