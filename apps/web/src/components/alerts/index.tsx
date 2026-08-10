'use client';

import React, { useMemo, useState } from 'react';
import { useAlerts } from '@/lib/use-alerts';
import { relativeTime } from '@/lib/relative-time';
import { SeverityBadge } from '@/components/common/badges';
import { useAssetTabsStore } from '@/stores';
import type { Exchange } from '@fno/shared';

const SEVERITY_FILTERS = ['ALL', 'CRITICAL', 'WARNING', 'INFO'] as const;
type SeverityFilter = (typeof SEVERITY_FILTERS)[number];

export function AlertsPage() {
  const { alerts, isLive, loading } = useAlerts(100);
  const openTab = useAssetTabsStore((s) => s.openTab);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL');

  const filtered = useMemo(
    () => (severityFilter === 'ALL' ? alerts : alerts.filter((a) => a.severity === severityFilter)),
    [alerts, severityFilter]
  );

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">Alerts</h1>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            Unusual futures OI moves, IV extremes, and Trade Setup closures — scanned every 2 minutes across the NSE F&O
            universe plus any symbol you've recently viewed.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-gray-500 light:text-slate-500">
            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600 light:bg-slate-300'}`} />
            {isLive ? 'live' : loading ? 'Loading…' : 'Unreachable'}
          </span>
          <div className="flex items-center gap-1 bg-gray-900/40 light:bg-slate-100 border border-gray-800/50 light:border-slate-200 rounded-full p-0.5">
            {SEVERITY_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => setSeverityFilter(s)}
                className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${
                  severityFilter === s
                    ? 'bg-emerald-500/20 light:bg-emerald-500/15 text-emerald-400 light:text-emerald-700 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.35)]'
                    : 'text-gray-400 light:text-slate-500 hover:bg-gray-800/60 light:hover:bg-slate-200/70'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!isLive && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium">
          ⚠️ Alerts feed unreachable — showing nothing right now. It'll pick back up on the next successful poll.
        </div>
      )}

      {loading && alerts.length === 0 && (
        <div className="text-sm text-gray-500 light:text-slate-500 py-16 text-center">Loading alerts…</div>
      )}

      {!loading && alerts.length === 0 && isLive && (
        <div className="text-sm text-gray-500 light:text-slate-500 py-16 text-center">
          No alerts yet. This page fills in as the scanner finds unusual OI/IV activity or a Trade Setup closes.
        </div>
      )}

      {filtered.length > 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] divide-y divide-gray-800/40 light:divide-slate-100">
          {filtered.map((a) => (
            <div
              key={a.id}
              onClick={() => {
                const exchange = a.data?.exchange as string | undefined;
                if (exchange) openTab(a.symbol, exchange as Exchange);
              }}
              className="px-4 py-3 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors flex items-start justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-gray-200 light:text-slate-800">{a.symbol}</span>
                  <SeverityBadge severity={a.severity} />
                  <span className="text-[10px] text-gray-600 light:text-slate-400 uppercase tracking-wide">{a.type.replace(/_/g, ' ')}</span>
                </div>
                <p className="text-xs text-gray-400 light:text-slate-500 leading-snug">{a.message}</p>
              </div>
              <span className="text-[11px] text-gray-500 light:text-slate-400 shrink-0 whitespace-nowrap">{relativeTime(a.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
