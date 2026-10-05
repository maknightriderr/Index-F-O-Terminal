'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Dashboard } from '@/components/dashboard';
import { AssetWorkspace } from '@/components/asset-workspace';
import { FnoStocksPage } from '@/components/fno-stocks';
import { CorporateActionsPage } from '@/components/corporate-actions';
import { IndicesPage } from '@/components/indices';
import { IvGreeksPage } from '@/components/iv-greeks';
import { OiIntelligencePage } from '@/components/oi-intelligence';
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
import { useMarketStore, useUISettingsStore, useSystemHealthStore } from '@/stores';
import { useMarketWebSocket } from '@/lib/ws';
import { api } from '@/lib/api';
import type { FeedHealth, FeedTokenState, ServiceStatus } from '@fno/shared';

export function TerminalApp() {
  const { activeTab } = useMarketStore();
  const { addAssetModalOpen, closeAddAssetModal } = useUISettingsStore();
  useMarketWebSocket();

  const renderContent = () => {
    if (activeTab.startsWith('asset:')) return <AssetWorkspace />;

    switch (activeTab) {
      case 'dashboard':
        return <Dashboard />;
      case 'indices':
        return <IndicesPage />;
      case 'fno-stocks':
        return <FnoStocksPage />;
      case 'corporate-actions':
        return <CorporateActionsPage />;
      case 'oi-intelligence':
        return <OiIntelligencePage />;
      case 'iv-greeks':
        return <IvGreeksPage />;
      case 'market-scanner':
        return <MarketScannerPage />;
      case 'strategy-scanner':
        return <StrategyScannerPage />;
      case 'backtesting':
        return <BacktestingPage />;
      case 'loss-attribution':
        return <LossAttributionPage />;
      case 'signal-diagnostics':
        return <SignalDiagnosticsPage />;
      case 'institutional-flow':
        return <InstitutionalFlowPage />;
      case 'positions':
        return <PlaceholderPage title="Positions" icon="💼" description="Position tracker with portfolio Greeks, P&L, risk metrics, and position simulator." />;
      case 'alerts':
        return <AlertsPage />;
      case 'ai-assistant':
        return <AiAssistantPage />;
      case 'system-learning':
        return <SystemLearningPage />;
      case 'system-health':
        return <SystemHealthPage />;
      case 'settings':
        return <PlaceholderPage title="Settings" icon="⚙️" description="Configure broker connection, risk parameters, alert channels, and UI preferences." />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <>
      <AppShell>
        {renderContent()}
      </AppShell>
      <AddAssetModal
        isOpen={addAssetModalOpen}
        onClose={closeAddAssetModal}
      />
    </>
  );
}

// --- Rich "Coming Soon" Placeholder ---

const PLACEHOLDER_FEATURES: Record<string, string[]> = {
  'Indices': ['Spot & Futures Overview', 'Live Option Chain', 'OI & IV Analysis', 'Market Bias Signals'],
  'Market Scanner': ['Unusual Activity Alerts', 'Volume Breakout Detection', 'Relative Strength Ranking', 'Custom Screener Filters'],
  'Positions': ['Portfolio Dashboard', 'Position Greeks Summary', 'Live P&L Tracking', 'Risk Simulator'],
  'Settings': ['Broker Configuration', 'Risk Parameters', 'Alert Channels', 'UI Preferences'],
};

function PlaceholderPage({ title, icon, description }: { title: string; icon: string; description: string }) {
  const features = PLACEHOLDER_FEATURES[title] || ['Feature 1', 'Feature 2', 'Feature 3', 'Feature 4'];

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 animate-fade-in">
      {/* Main card with animated gradient border */}
      <div className="gradient-border rounded-2xl max-w-lg w-full">
        <div className="glass-strong rounded-2xl p-8 text-center">
          {/* Floating icon */}
          <div className="text-5xl mb-5 animate-float">{icon}</div>

          <h2 className="text-xl font-bold text-gray-100 light:text-slate-900 mb-2">{title}</h2>
          <p className="text-sm text-gray-400 light:text-slate-600 max-w-md mx-auto mb-6 leading-relaxed">{description}</p>

          {/* Feature preview grid */}
          <div className="grid grid-cols-2 gap-2.5 mb-6">
            {features.map((feature, i) => (
              <div
                key={feature}
                className="flex items-center gap-2 px-3 py-2.5 bg-gray-800/30 light:bg-slate-100 rounded-lg text-left stagger-item"
                style={{ '--stagger-index': i } as React.CSSProperties}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/50 shrink-0" />
                <span className="text-xs text-gray-300 light:text-slate-600">{feature}</span>
              </div>
            ))}
          </div>

          {/* Status badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 border border-emerald-500/20 rounded-full">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse-subtle" />
            <span className="text-xs font-medium text-gray-300 light:text-slate-600">Coming Soon</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- System Health Page ---

interface HealthServiceRow {
  name: string;
  status: ServiceStatus;
  icon: string;
  details: string;
}

function SystemHealthPage() {
  const wsHealth = useSystemHealthStore((s) => s.health.websocket);
  const feed = useSystemHealthStore((s) => s.health.feed);
  const updateHealth = useSystemHealthStore((s) => s.updateHealth);
  const [apiHealth, setApiHealth] = useState<any>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getHealth()
        .then((data) => {
          if (cancelled) return;
          setApiHealth(data);
          setApiError(null);
          // Phase 5: per-token feed states into the shared health store.
          if (data?.feed) updateHealth({ feed: data.feed });
        })
        .catch((err) => {
          if (cancelled) return;
          setApiHealth(null);
          setApiError(err?.message || 'API unreachable');
        });
    };

    poll();
    const interval = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [updateHealth]);

  const redis = apiHealth?.services?.redis;
  const database = apiHealth?.services?.database;
  const provider = apiHealth?.services?.provider;

  const services: HealthServiceRow[] = [
    { name: 'Frontend', status: 'HEALTHY', icon: '🌐', details: 'Next.js — Running' },
    {
      name: 'API Server',
      status: apiHealth ? 'HEALTHY' : 'DOWN',
      icon: '⚡',
      details: apiHealth ? `v${apiHealth.version} — up ${Math.round(apiHealth.uptime)}s` : (apiError || 'Checking…'),
    },
    {
      name: 'WebSocket',
      status: wsHealth.connected ? 'HEALTHY' : 'DOWN',
      icon: '🔌',
      details: wsHealth.connected
        ? `Connected — ${wsHealth.subscriptionCount} subscription${wsHealth.subscriptionCount === 1 ? '' : 's'}`
        : 'Not connected',
    },
    {
      name: 'Redis',
      status: redis?.status ?? 'DOWN',
      icon: '🗄️',
      details: redis?.status === 'HEALTHY' ? `${redis.latencyMs}ms` : (redis?.error || 'Start with: docker-compose up -d'),
    },
    {
      name: 'Database',
      status: database?.status ?? 'DOWN',
      icon: '🐘',
      details: database?.status === 'HEALTHY'
        ? `${database.latencyMs}ms`
        : (database?.error || 'PostgreSQL + TimescaleDB — Start with Docker'),
    },
    {
      name: 'Angel One Provider',
      status: provider?.authenticated ? 'HEALTHY' : 'DOWN',
      icon: '📡',
      details: provider?.authenticated ? 'Authenticated' : 'Not authenticated — check ANGEL_ONE_* env vars',
    },
    { name: 'Analytics Worker', status: 'DOWN', icon: '📊', details: 'Not yet built' },
    { name: 'Strategy Worker', status: 'DOWN', icon: '🎯', details: 'Not yet built' },
    { name: 'Alert Worker', status: 'DOWN', icon: '🔔', details: 'Not yet built' },
    { name: 'AI Service', status: 'DOWN', icon: '🤖', details: 'Not yet built' },
  ];

  const statusColors: Record<ServiceStatus, string> = {
    HEALTHY: 'bg-emerald-400',
    DEGRADED: 'bg-yellow-400',
    DOWN: 'bg-red-400',
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-lg font-semibold text-gray-100 light:text-slate-900">System Health</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {services.map((service) => (
          <div
            key={service.name}
            className="bg-[#12121a] light:bg-white border border-gray-800/60 light:border-slate-200 rounded-xl shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] p-4 hover:border-gray-700/70 light:hover:border-slate-300 transition-colors"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-lg">{service.icon}</span>
                <span className="text-sm font-medium text-gray-200 light:text-slate-800">{service.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${statusColors[service.status]}`} />
                <span className="text-xs text-gray-400 light:text-slate-600">
                  {service.status === 'HEALTHY' ? 'Healthy' :
                   service.status === 'DEGRADED' ? 'Degraded' : 'Down'}
                </span>
              </div>
            </div>
            <div className="text-xs text-gray-400 light:text-slate-600">{service.details}</div>
          </div>
        ))}
      </div>

      {feed && <FeedStatesTable feed={feed} />}
    </div>
  );
}

const FEED_STATE_STYLE: Record<FeedTokenState, string> = {
  DATA_FRESH: 'text-emerald-400 light:text-emerald-700',
  DATA_STALE: 'text-yellow-400 light:text-amber-700',
  DATA_GAP: 'text-red-400 light:text-red-700',
  RECOVERING: 'text-sky-400 light:text-sky-700',
};

/** Phase 5: every tick-feed token's data state, as /api/health reports it. */
function FeedStatesTable({ feed }: { feed: FeedHealth }) {
  const ageOf = (t: number | null) => (t == null ? '—' : `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago`);
  return (
    <div className="bg-[#12121a] light:bg-white border border-gray-800/60 light:border-slate-200 rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-200 light:text-slate-800">Data feed</h2>
        <span className="text-xs text-gray-400 light:text-slate-600">
          {feed.tokens} token{feed.tokens === 1 ? '' : 's'} · fresh {feed.byState.DATA_FRESH} · stale {feed.byState.DATA_STALE} · gap {feed.byState.DATA_GAP} · recovering {feed.byState.RECOVERING}
          {feed.upstreamDown ? ' · upstream down' : ''} · dropped {feed.droppedDuplicates} duplicate / {feed.droppedOutOfOrder} out-of-order · {feed.partialBatches} partial batch{feed.partialBatches === 1 ? '' : 'es'}
        </span>
      </div>
      {feed.perToken.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-gray-500 light:text-slate-500">
              <tr className="text-left">
                <th className="py-1 pr-3 font-normal">Token</th>
                <th className="py-1 pr-3 font-normal">State</th>
                <th className="py-1 pr-3 font-normal">Status</th>
                <th className="py-1 pr-3 font-normal">Last tick</th>
                <th className="py-1 pr-3 font-normal">Gap</th>
                <th className="py-1 pr-3 font-normal">Source</th>
                <th className="py-1 font-normal">Last gap check</th>
              </tr>
            </thead>
            <tbody className="text-gray-300 light:text-slate-700">
              {feed.perToken.map((t) => (
                <tr key={`${t.exchange}:${t.token}`} className="border-t border-gray-800/60 light:border-slate-200">
                  <td className="py-1 pr-3">{t.exchange} {t.token}</td>
                  <td className={`py-1 pr-3 ${FEED_STATE_STYLE[t.state]}`}>{t.state}</td>
                  <td className="py-1 pr-3">{t.status}</td>
                  <td className="py-1 pr-3">{ageOf(t.asOf)}</td>
                  <td className="py-1 pr-3">{t.gapDurationMs != null ? `${Math.round(t.gapDurationMs / 1000)}s` : '—'}</td>
                  <td className="py-1 pr-3">{t.source}</td>
                  <td className="py-1">{t.lastGapOutcome ? `${t.lastGapOutcome.outcome} — ${t.lastGapOutcome.detail}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
