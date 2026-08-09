'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Dashboard } from '@/components/dashboard';
import { OptionChainPage } from '@/components/option-chain';
import { FuturesPage } from '@/components/futures';
import { AddAssetModal } from '@/components/common/add-asset-modal';
import { useMarketStore, useUISettingsStore, useSystemHealthStore } from '@/stores';
import { useMarketWebSocket } from '@/lib/ws';
import { api } from '@/lib/api';
import type { ServiceStatus } from '@fno/shared';

export function TerminalApp() {
  const { activeTab } = useMarketStore();
  const { addAssetModalOpen, closeAddAssetModal } = useUISettingsStore();
  useMarketWebSocket();

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard />;
      case 'indices':
        return <PlaceholderPage title="Indices" icon="📈" description="Index dashboard with spot, futures, option chain, OI, IV, Greeks, PCR, and market bias." />;
      case 'fno-stocks':
        return <PlaceholderPage title="F&O Stocks" icon="📋" description="F&O stock universe scanner with real-time OI, IV, Greeks, and intelligence scores." />;
      case 'option-chain':
        return <OptionChainPage />;
      case 'futures':
        return <FuturesPage />;
      case 'oi-intelligence':
        return <PlaceholderPage title="OI Intelligence" icon="🔍" description="OI walls, OI shifts, buildup classification, and unusual activity detection." />;
      case 'iv-greeks':
        return <PlaceholderPage title="IV & Greeks" icon="🔬" description="IV rank, IV percentile, IV skew, IV heatmap, theta decay scanner, gamma engine." />;
      case 'market-scanner':
        return <PlaceholderPage title="Market Scanner" icon="🔥" description="F&O market scanner with unusual activity detection and relative strength." />;
      case 'strategy-scanner':
        return <PlaceholderPage title="Strategy Scanner" icon="🎯" description="Find best strategies based on market bias, regime, IV, theta, and risk/reward." />;
      case 'backtesting':
        return <PlaceholderPage title="Backtesting" icon="🧪" description="Backtest strategies with historical data. Equity curve, win rate, profit factor." />;
      case 'market-replay':
        return <PlaceholderPage title="Market Replay" icon="🔄" description="Replay historical market conditions with spot, futures, option chain, and signals." />;
      case 'positions':
        return <PlaceholderPage title="Positions" icon="💼" description="Position tracker with portfolio Greeks, P&L, risk metrics, and position simulator." />;
      case 'alerts':
        return <PlaceholderPage title="Alerts" icon="🔔" description="Real-time alerts for OI spikes, IV changes, support/resistance breaks, and unusual activity." />;
      case 'ai-assistant':
        return <PlaceholderPage title="AI Assistant" icon="🤖" description="Terminal intelligence powered by live data. Ask about market conditions, signals, and strategies." />;
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

// --- Placeholder for upcoming pages ---

function PlaceholderPage({ title, icon, description }: { title: string; icon: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="text-5xl mb-4">{icon}</div>
      <h2 className="text-xl font-bold text-gray-200 mb-2">{title}</h2>
      <p className="text-sm text-gray-500 max-w-md text-center mb-4">{description}</p>
      <div className="px-4 py-2 bg-gray-800/50 border border-gray-700/50 rounded-lg text-xs text-gray-400">
        Coming in Phase 2–6
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
  }, []);

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
      <h1 className="text-lg font-semibold text-gray-100">System Health</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {services.map((service) => (
          <div
            key={service.name}
            className="bg-[#12121a] border border-gray-800/50 rounded-lg p-4"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-lg">{service.icon}</span>
                <span className="text-sm font-medium text-gray-200">{service.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${statusColors[service.status]}`} />
                <span className="text-xs text-gray-400">
                  {service.status === 'HEALTHY' ? 'Healthy' :
                   service.status === 'DEGRADED' ? 'Degraded' : 'Down'}
                </span>
              </div>
            </div>
            <div className="text-xs text-gray-500">{service.details}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
