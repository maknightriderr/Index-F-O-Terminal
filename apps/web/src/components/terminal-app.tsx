'use client';

import React from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Dashboard } from '@/components/dashboard';
import { CommandCenter } from '@/components/command-center';
import { WorkspacePage } from '@/components/workspace';
import { OptionChainPage } from '@/components/option-chain';
import { StrategyLabPage } from '@/components/strategy-lab';
import { AssetWorkspace } from '@/components/asset-workspace';
import { CorporateActionsPage } from '@/components/corporate-actions';
import { IndicesPage } from '@/components/indices';
import { FnoExplorerPage } from '@/components/fno-explorer';
import { PaperTradesPage } from '@/components/paper-trades';
import { SystemHealthPage } from '@/components/system-health';
import { UnbuiltPage } from '@/components/common/unbuilt-page';
import { AlertsPage } from '@/components/alerts';
import { InstitutionalFlowPage } from '@/components/institutional-flow';
import { SystemLearningPage } from '@/components/system-learning';
import { AddAssetModal } from '@/components/common/add-asset-modal';
import { useMarketStore, useUISettingsStore } from '@/stores';
import { useMarketWebSocket } from '@/lib/ws';
import { useUrlSync } from '@/lib/use-url-sync';
import { resolveTab, RETIRED_PAGES, pageMeta } from '@/lib/nav';
import { RetiredPage } from '@/components/common/retired-page';

export function TerminalApp() {
  const { activeTab: storedTab } = useMarketStore();
  const { addAssetModalOpen, closeAddAssetModal } = useUISettingsStore();
  useMarketWebSocket();
  useUrlSync();

  // An old persisted tab id (fno-stocks, oi-intelligence, iv-greeks) renders as the page that replaced it.
  const activeTab = resolveTab(storedTab).tab;

  const renderContent = () => {
    if (activeTab.startsWith('asset:')) return <AssetWorkspace />;
    // Retired legacy engines: their setups, scanners and trade analytics are no longer shown anywhere.
    if (RETIRED_PAGES.some((p) => p.id === activeTab)) return <RetiredPage title={pageMeta(activeTab)?.label ?? 'Retired page'} />;

    switch (activeTab) {
      case 'workspace':
        return <WorkspacePage />;
      case 'dashboard':
        return <CommandCenter />;
      case 'market-overview':
        return <Dashboard />;
      case 'option-chain':
        return <OptionChainPage />;
      case 'strategy-lab':
        return <StrategyLabPage />;
      case 'indices':
        return <IndicesPage />;
      case 'fno-explorer':
        return <FnoExplorerPage />;
      case 'corporate-actions':
        return <CorporateActionsPage />;
      case 'paper-trades':
        return <PaperTradesPage />;
      case 'institutional-flow':
        return <InstitutionalFlowPage />;
      case 'alerts':
        return <AlertsPage />;
      case 'system-learning':
        return <SystemLearningPage />;
      case 'system-health':
        return <SystemHealthPage />;
      case 'positions':
        return <UnbuiltPage title="Positions" description="A position tracker with portfolio Greeks and risk is planned. For simulated trades, see Paper Trades." />;
      case 'settings':
        return <UnbuiltPage title="Settings" description="Broker, risk and alert settings are planned. The theme is changed from the top bar." />;
      default:
        return <CommandCenter />;
    }
  };

  return (
    <>
      <AppShell>{renderContent()}</AppShell>
      <AddAssetModal isOpen={addAssetModalOpen} onClose={closeAddAssetModal} />
    </>
  );
}
