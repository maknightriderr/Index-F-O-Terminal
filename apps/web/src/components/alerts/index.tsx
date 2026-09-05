'use client';

import React, { useMemo, useState } from 'react';
import { useAlerts } from '@/lib/use-alerts';
import { relativeTime } from '@/lib/relative-time';
import { SeverityBadge } from '@/components/common/badges';
import { FilterPills } from '@/components/common/filter-pills';
import { Skeleton } from '@/components/common/skeleton';
import { useAssetTabsStore } from '@/stores';
import type { Exchange, SignalType } from '@fno/shared';

type SeverityFilter = 'ALL' | 'CRITICAL' | 'WARNING' | 'INFO';
type TypeFilter = 'ALL' | SignalType;

const SEVERITY_OPTIONS: Array<{ value: SeverityFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'CRITICAL', label: 'Critical' },
  { value: 'WARNING', label: 'Warning' },
  { value: 'INFO', label: 'Info' },
];

// Every alert type this app's scanner can actually emit today (see
// apps/server/src/services/alerts.ts) — a prior version of this list only
// had 4 of the 7, so filtering by e.g. VIX Spike silently showed nothing
// even when the type option didn't exist to select it at all.
const TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'FUTURES_OI_SPIKE', label: 'OI Spike' },
  { value: 'IV_SPIKE', label: 'IV Spike' },
  { value: 'IV_CRUSH', label: 'IV Crush' },
  { value: 'TRADE_SETUP_CLOSED', label: 'Trade Setup' },
  { value: 'VIX_SPIKE', label: 'VIX Spike' },
  { value: 'PCR_EXTREME', label: 'PCR Extreme' },
  { value: 'INSTITUTIONAL_ACTIVITY', label: 'Institutional' },
];

const SEVERITY_BORDER: Record<string, string> = {
  CRITICAL: 'border-l-red-500',
  WARNING: 'border-l-amber-500',
  INFO: 'border-l-gray-500 light:border-l-slate-300',
};

export function AlertsPage() {
  const [query, setQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { alerts, isLive, loading } = useAlerts(100, {
    type: typeFilter === 'ALL' ? undefined : typeFilter,
    severity: severityFilter === 'ALL' ? undefined : severityFilter,
  });
  const openTab = useAssetTabsStore((s) => s.openTab);

  // Only the free-text symbol search stays client-side — type/severity are
  // now server-filtered (see useAlerts) so they reflect the real matching
  // rows, not just whatever was in this fetch's unfiltered limit window.
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return q ? alerts.filter((a) => a.symbol.includes(q)) : alerts;
  }, [alerts, query]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">Alerts</h1>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            Unusual futures OI moves, IV extremes, and Trade Setup closures — scanned every 2 minutes across the NSE F&O
            universe. OI/IV extremes are digested into one summary per type per day, not one row per stock.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-gray-500 light:text-slate-500">
            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600 light:bg-slate-300'}`} />
            {isLive ? `${filtered.length} of ${alerts.length}` : loading ? 'Loading…' : 'Unreachable'}
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter symbol…"
            className="bg-gray-900/70 light:bg-slate-50 border border-gray-700/60 light:border-slate-200 rounded-lg px-3 py-1.5 text-xs text-gray-200 light:text-slate-800 placeholder-gray-600 light:placeholder-slate-400 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-colors w-40"
          />
        </div>
      </div>

      <div className="flex items-center flex-wrap gap-4">
        <FilterPills label="Severity" options={SEVERITY_OPTIONS} value={severityFilter} onChange={setSeverityFilter} />
        <FilterPills label="Type" options={TYPE_OPTIONS} value={typeFilter} onChange={setTypeFilter} />
      </div>

      {!isLive && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium">
          ⚠️ Alerts feed unreachable — showing nothing right now. It'll pick back up on the next successful poll.
        </div>
      )}

      {loading && alerts.length === 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] divide-y divide-gray-800/40 light:divide-slate-100">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton width="70px" height="14px" />
                <Skeleton width="50px" height="14px" className="rounded-full" />
              </div>
              <Skeleton width="80%" height="11px" />
            </div>
          ))}
        </div>
      )}

      {!loading && alerts.length === 0 && isLive && (
        <div className="text-sm text-gray-500 light:text-slate-500 py-16 text-center">
          No alerts yet. This page fills in as the scanner finds unusual OI/IV activity or a Trade Setup closes.
        </div>
      )}

      {alerts.length > 0 && filtered.length === 0 && (
        <div className="text-sm text-gray-500 light:text-slate-500 py-16 text-center">No alerts match the current filters.</div>
      )}

      {filtered.length > 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] divide-y divide-gray-800/40 light:divide-slate-100">
          {filtered.map((a) => {
            // Digest alerts (OI Spike / IV Spike / IV Crush) carry the full
            // per-symbol breakdown in data.symbols — the message text only
            // names the first few, this is what "show all" expands into.
            const symbols = Array.isArray((a.data as any)?.symbols) ? ((a.data as any).symbols as Array<Record<string, unknown>>) : null;
            const isOpen = expanded.has(a.id);

            return (
              <div key={a.id} className={`border-l-2 ${SEVERITY_BORDER[a.severity] ?? SEVERITY_BORDER.INFO}`}>
                <div
                  onClick={() => {
                    const exchange = a.data?.exchange as string | undefined;
                    if (exchange && a.symbol !== 'NSE_FNO_UNIVERSE') openTab(a.symbol, exchange as Exchange);
                    else if (symbols) toggleExpanded(a.id);
                  }}
                  className="px-4 py-3 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors flex items-start justify-between gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-gray-200 light:text-slate-800">
                        {a.symbol === 'NSE_FNO_UNIVERSE' ? 'F&O Universe' : a.symbol}
                      </span>
                      <SeverityBadge severity={a.severity} />
                      <span className="text-[10px] text-gray-600 light:text-slate-400 uppercase tracking-wide">{a.type.replace(/_/g, ' ')}</span>
                    </div>
                    <p className="text-xs text-gray-400 light:text-slate-500 leading-snug">{a.message}</p>
                    {symbols && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpanded(a.id);
                        }}
                        className="text-[11px] font-semibold text-indigo-500 light:text-indigo-700 mt-1.5 hover:underline"
                      >
                        {isOpen ? '▾ Hide' : '▸ Show'} all {symbols.length} symbols
                      </button>
                    )}
                    {symbols && isOpen && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {symbols.map((s, i) => (
                          <button
                            key={i}
                            onClick={(e) => {
                              e.stopPropagation();
                              const exch = (s.exchange as string) ?? 'NSE';
                              openTab(s.symbol as string, exch as Exchange);
                            }}
                            className="text-[11px] font-medium px-2 py-1 rounded-md bg-gray-800/60 light:bg-slate-100 text-gray-300 light:text-slate-700 hover:bg-gray-700/60 light:hover:bg-slate-200 tabular-nums"
                          >
                            {s.symbol as string}
                            {s.changePercent != null && ` ${(s.changePercent as number) >= 0 ? '+' : ''}${(s.changePercent as number).toFixed(1)}%`}
                            {s.ivRank != null && ` (IVR ${s.ivRank})`}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="text-[11px] text-gray-500 light:text-slate-400 shrink-0 whitespace-nowrap">{relativeTime(a.createdAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
