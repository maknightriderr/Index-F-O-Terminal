'use client';

import React from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Dashboard } from '@/components/dashboard';
import { AssetWorkspace } from '@/components/asset-workspace';
import { CorporateActionsPage } from '@/components/corporate-actions';
import { IndicesPage } from '@/components/indices';
import { FnoExplorerPage } from '@/components/fno-explorer';
import { PaperTradesPage } from '@/components/paper-trades';
import { BestSetupsPage } from '@/components/best-setups';
import { MeasurementPage } from '@/components/measurement';
import { SystemHealthPage } from '@/components/system-health';
import { PerformanceNav } from '@/components/performance/performance-nav';
import { UnbuiltPage } from '@/components/common/unbuilt-page';
import { AlertsPage } from '@/components/alerts';
import { StrategyScannerPage } from '@/components/strategy-scanner';
import { MarketScannerPage } from '@/components/market-scanner';
import { AiAssistantPage } from '@/components/ai-assistant';
import { InstitutionalFlowPage } from '@/components/institutional-flow';
import { BacktestingPage } from '@/components/backtesting';
import { SystemLearningPage } from '@/components/system-learning';
import { LossAttributionPage } from '@/components/loss-attribution';
import { SignalDiagnosticsPage } from '@/components/signal-diagnostics';
import { AddAssetModal } from '@/components/common/add-asset-modal';
import { useMarketStore, useUISettingsStore } from '@/stores';
import { useMarketWebSocket } from '@/lib/ws';
import { useUrlSync } from '@/lib/use-url-sync';
import { resolveTab } from '@/lib/nav';

export function TerminalApp() {
  const { activeTab: storedTab } = useMarketStore();
  const { addAssetModalOpen, closeAddAssetModal } = useUISettingsStore();
  useMarketWebSocket();
  useUrlSync();

  // An old persisted tab id (fno-stocks, oi-intelligence, iv-greeks) renders as the page that replaced it.
  const activeTab = resolveTab(storedTab).tab;

  const renderContent = () => {
    if (activeTab.startsWith('asset:')) return <AssetWorkspace />;

    switch (activeTab) {
      case 'dashboard':
        return <Dashboard />;
      case 'indices':
        return <IndicesPage />;
      case 'fno-explorer':
        return <FnoExplorerPage />;
      case 'corporate-actions':
        return <CorporateActionsPage />;
      case 'paper-trades':
        return <PaperTradesPage />;
      case 'best-setups':
        return <BestSetupsPage />;
      case 'strategy-scanner':
        return <StrategyScannerPage />;
      case 'market-scanner':
        return <MarketScannerPage />;
      case 'backtesting':
        return (
          <>
            <PerformanceNav />
            <BacktestingPage />
          </>
        );
      case 'loss-attribution':
        return (
          <>
            <PerformanceNav />
            <LossAttributionPage />
          </>
        );
      case 'signal-diagnostics':
        return (
          <>
            <PerformanceNav />
            <SignalDiagnosticsPage />
          </>
        );
      case 'measurement':
        return <MeasurementPage />;
      case 'institutional-flow':
        return <InstitutionalFlowPage />;
      case 'alerts':
        return <AlertsPage />;
      case 'ai-assistant':
        return <AiAssistantPage />;
      case 'system-learning':
        return <SystemLearningPage />;
      case 'system-health':
        return <SystemHealthPage />;
      case 'positions':
        return <UnbuiltPage title="Positions" description="A position tracker with portfolio Greeks and risk is planned. For simulated trades, see Paper Trades." />;
      case 'settings':
        return <UnbuiltPage title="Settings" description="Broker, risk and alert settings are planned. The theme is changed from the top bar." />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <>
      <AppShell>{renderContent()}</AppShell>
      <AddAssetModal isOpen={addAssetModalOpen} onClose={closeAddAssetModal} />
    </>
  );
}
