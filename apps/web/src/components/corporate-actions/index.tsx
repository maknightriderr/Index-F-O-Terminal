'use client';

import React, { useMemo, useState } from 'react';
import { useUpcomingCorporateActions } from '@/lib/use-corporate-actions';
import { useAssetTabsStore } from '@/stores';
import { FilterPills } from '@/components/common/filter-pills';
import { Skeleton } from '@/components/common/skeleton';
import type { CorporateActionType } from '@fno/shared';

type TypeFilter = 'ALL' | CorporateActionType;

const TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'DIVIDEND', label: 'Dividend' },
  { value: 'BONUS', label: 'Bonus' },
  { value: 'SPLIT', label: 'Split' },
  { value: 'RIGHTS', label: 'Rights' },
  { value: 'BUYBACK', label: 'Buyback' },
];

const TYPE_BADGE: Record<CorporateActionType, string> = {
  DIVIDEND: 'bg-emerald-500/15 text-emerald-400',
  BONUS: 'bg-violet-500/15 text-violet-400',
  SPLIT: 'bg-cyan-500/15 text-cyan-400',
  RIGHTS: 'bg-blue-500/15 text-blue-400',
  BUYBACK: 'bg-amber-500/15 text-amber-400',
  OTHER: 'bg-gray-500/15 text-gray-400',
};

function daysUntil(iso: string): number {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const diffMs = new Date(iso).getTime() - new Date(today).getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

export function CorporateActionsPage() {
  const { actions, isLive, loading } = useUpcomingCorporateActions();
  const openTab = useAssetTabsStore((s) => s.openTab);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let base = q ? actions.filter((a) => a.symbol.includes(q) || a.company.toUpperCase().includes(q)) : actions;
    if (typeFilter !== 'ALL') base = base.filter((a) => a.type === typeFilter);
    return base;
  }, [actions, query, typeFilter]);

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">Corporate Actions</h1>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            Upcoming dividends, bonuses, splits, rights issues, and buybacks across NSE — ex-date today or later, nearest first. Sourced from NSE's own corporate-filings data.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-gray-500 light:text-slate-500">
            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600 light:bg-slate-300'}`} />
            {isLive ? `${filtered.length} of ${actions.length}` : loading ? 'Loading…' : 'Unreachable'}
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter symbol/company…"
            className="bg-gray-900/70 light:bg-slate-50 border border-gray-700/60 light:border-slate-200 rounded-lg px-3 py-1.5 text-xs text-gray-200 light:text-slate-800 placeholder-gray-600 light:placeholder-slate-400 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-colors w-48"
          />
        </div>
      </div>

      <FilterPills label="Type" options={TYPE_OPTIONS} value={typeFilter} onChange={setTypeFilter} />

      {!isLive && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium">
          ⚠️ Corporate actions feed unreachable — showing nothing right now. It'll pick back up on the next successful poll.
        </div>
      )}

      {loading && actions.length === 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] divide-y divide-gray-800/40 light:divide-slate-100">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton width="70px" height="14px" />
                <Skeleton width="50px" height="14px" className="rounded-full" />
              </div>
              <Skeleton width="60%" height="11px" />
            </div>
          ))}
        </div>
      )}

      {!loading && actions.length === 0 && isLive && (
        <div className="text-sm text-gray-500 light:text-slate-500 py-16 text-center">
          No upcoming corporate actions found right now.
        </div>
      )}

      {actions.length > 0 && filtered.length === 0 && (
        <div className="text-sm text-gray-500 light:text-slate-500 py-16 text-center">No corporate actions match the current filters.</div>
      )}

      {filtered.length > 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] divide-y divide-gray-800/40 light:divide-slate-100">
          {filtered.map((a, i) => {
            const dte = daysUntil(a.exDate);
            return (
              <div
                key={`${a.symbol}-${a.exDate}-${a.type}-${i}`}
                onClick={() => openTab(a.symbol, 'NSE')}
                className="px-4 py-3 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors flex items-center justify-between gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-gray-200 light:text-slate-800">{a.symbol}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${TYPE_BADGE[a.type]}`}>{a.type}</span>
                    <span className="text-[10px] text-gray-600 light:text-slate-400 truncate">{a.company}</span>
                  </div>
                  <p className="text-xs text-gray-400 light:text-slate-500 leading-snug">{a.purpose}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-gray-300 light:text-slate-700 font-medium tabular-nums">
                    {new Date(a.exDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}
                  </div>
                  <div className={`text-[10px] font-semibold ${dte <= 3 ? 'text-amber-400' : 'text-gray-500 light:text-slate-400'}`}>
                    {dte === 0 ? 'Ex-date today' : dte === 1 ? 'Ex-date tomorrow' : `${dte}d to ex-date`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
