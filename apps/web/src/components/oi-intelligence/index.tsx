'use client';

import React, { useMemo, useState } from 'react';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { useAssetTabsStore } from '@/stores';
import { formatIndianNumber, formatPercent, formatCompact } from '@fno/shared';
import { OIBadge, BiasBadge, ScoreBadge } from '@/components/common/badges';
import { ActivityList } from '@/components/common/activity-list';
import { FilterPills } from '@/components/common/filter-pills';
import { SkeletonTableRow } from '@/components/common/skeleton';
import type { BiasDirection, OIInterpretation } from '@fno/shared';

type SortKey = 'symbol' | 'price' | 'changePercent' | 'volume' | 'futuresOi' | 'futuresChangeOi' | 'futuresChangeOiPercent' | 'pcr' | 'score';
type BiasFilter = 'ALL' | BiasDirection;
type ActivityFilter = 'ALL' | OIInterpretation;

const BIAS_OPTIONS: Array<{ value: BiasFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'BULLISH', label: 'Bullish' },
  { value: 'BEARISH', label: 'Bearish' },
  { value: 'NEUTRAL', label: 'Neutral' },
];

const ACTIVITY_OPTIONS: Array<{ value: ActivityFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'LONG_BUILDUP', label: 'Long Build' },
  { value: 'SHORT_BUILDUP', label: 'Short Build' },
  { value: 'SHORT_COVERING', label: 'Short Cover' },
  { value: 'LONG_UNWINDING', label: 'Long Unwind' },
  { value: 'NEUTRAL', label: 'Neutral' },
];

export function OiIntelligencePage() {
  const { rows, isLive, loading } = useFnoScanner('NSE');
  const openTab = useAssetTabsStore((s) => s.openTab);
  const [query, setQuery] = useState('');
  const [biasFilter, setBiasFilter] = useState<BiasFilter>('ALL');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('futuresChangeOiPercent');
  const [sortDesc, setSortDesc] = useState(true);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let base = q ? rows.filter((r) => r.symbol.includes(q)) : rows;
    if (biasFilter !== 'ALL') base = base.filter((r) => r.direction === biasFilter);
    if (activityFilter !== 'ALL') base = base.filter((r) => r.oiInterpretation === activityFilter);
    const sorted = [...base].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv));
      }
      return (av as number) - (bv as number);
    });
    if (sortDesc) sorted.reverse();
    return sorted;
  }, [rows, query, biasFilter, activityFilter, sortKey, sortDesc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const byChangeOiMagnitude = useMemo(
    () => [...rows].sort((a, b) => Math.abs(b.futuresChangeOiPercent) - Math.abs(a.futuresChangeOiPercent)),
    [rows]
  );

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">OI Intelligence</h1>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            Futures OI buildup classification and change-OI% — every NSE stock with F&O contracts, ranked by unusual activity.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-gray-500 light:text-slate-500">
            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600 light:bg-slate-300'}`} />
            {isLive ? `${filtered.length} of ${rows.length} stocks` : loading ? 'Loading…' : 'Unreachable'}
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
        <FilterPills label="Bias" options={BIAS_OPTIONS} value={biasFilter} onChange={setBiasFilter} />
        <FilterPills label="Activity" options={ACTIVITY_OPTIONS} value={activityFilter} onChange={setActivityFilter} />
      </div>

      {!isLive && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium">
          ⚠️ Live scanner unreachable — showing nothing right now. It'll pick back up on the next successful poll.
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] p-1">
          <table className="w-full text-xs">
            <tbody>
              {Array.from({ length: 8 }, (_, i) => (
                <SkeletonTableRow key={i} cols={11} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && filtered.length === 0 && (
        <div className="text-sm text-gray-500 light:text-slate-500 py-16 text-center">No stocks match the current filters.</div>
      )}

      {rows.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <ActivityList
            title="🟢 Top Long Buildup"
            items={rows.filter((s) => s.oiInterpretation === 'LONG_BUILDUP').sort((a, b) => b.futuresChangeOiPercent - a.futuresChangeOiPercent).slice(0, 8)}
            color="emerald"
          />
          <ActivityList
            title="🔴 Top Short Buildup"
            items={rows.filter((s) => s.oiInterpretation === 'SHORT_BUILDUP').sort((a, b) => b.futuresChangeOiPercent - a.futuresChangeOiPercent).slice(0, 8)}
            color="red"
          />
          <ActivityList
            title="🟡 Short Covering"
            items={rows.filter((s) => s.oiInterpretation === 'SHORT_COVERING').sort((a, b) => a.futuresChangeOiPercent - b.futuresChangeOiPercent).slice(0, 8)}
            color="yellow"
          />
          <ActivityList
            title="🟠 Long Unwinding"
            items={rows.filter((s) => s.oiInterpretation === 'LONG_UNWINDING').sort((a, b) => a.futuresChangeOiPercent - b.futuresChangeOiPercent).slice(0, 8)}
            color="orange"
          />
        </div>
      )}

      {filtered.length > 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)]">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gradient-to-b from-gray-900/90 to-gray-900/60 light:from-slate-100 light:to-slate-50 text-gray-500 light:text-slate-500 uppercase tracking-wider">
                  <SortTh label="Stock" active={sortKey === 'symbol'} desc={sortDesc} onClick={() => toggleSort('symbol')} align="left" />
                  <SortTh label="Price" active={sortKey === 'price'} desc={sortDesc} onClick={() => toggleSort('price')} />
                  <SortTh label="Chg%" active={sortKey === 'changePercent'} desc={sortDesc} onClick={() => toggleSort('changePercent')} />
                  <SortTh label="Volume" active={sortKey === 'volume'} desc={sortDesc} onClick={() => toggleSort('volume')} />
                  <SortTh label="Futures OI" active={sortKey === 'futuresOi'} desc={sortDesc} onClick={() => toggleSort('futuresOi')} />
                  <SortTh label="OI Chg" active={sortKey === 'futuresChangeOi'} desc={sortDesc} onClick={() => toggleSort('futuresChangeOi')} />
                  <SortTh label="OI Chg%" active={sortKey === 'futuresChangeOiPercent'} desc={sortDesc} onClick={() => toggleSort('futuresChangeOiPercent')} />
                  <th className="text-left px-3 py-2 font-medium">Activity</th>
                  <SortTh label="PCR" active={sortKey === 'pcr'} desc={sortDesc} onClick={() => toggleSort('pcr')} />
                  <th className="text-center px-3 py-2 font-medium">Bias</th>
                  <SortTh label="Score" active={sortKey === 'score'} desc={sortDesc} onClick={() => toggleSort('score')} align="center" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((stock) => {
                  const isUnusual = byChangeOiMagnitude.slice(0, 10).includes(stock);
                  return (
                    <tr
                      key={stock.symbol}
                      onClick={() => openTab(stock.symbol, stock.exchange)}
                      className="border-t border-gray-800/40 light:border-slate-200 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-2.5 font-semibold text-gray-200 light:text-slate-800">
                        {stock.symbol}
                        {isUnusual && <span className="ml-1.5 text-amber-400" title="Among the largest OI% moves right now">🔥</span>}
                      </td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-200 light:text-slate-800">{formatIndianNumber(stock.price, 2)}</td>
                      <td className={`text-right px-3 py-2.5 tabular-nums font-medium ${stock.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {formatPercent(stock.changePercent)}
                      </td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-500">{formatCompact(stock.volume)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-500">{formatCompact(stock.futuresOi)}</td>
                      <td className={`text-right px-3 py-2.5 tabular-nums font-medium ${stock.futuresChangeOi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {stock.futuresChangeOi >= 0 ? '+' : ''}{formatCompact(stock.futuresChangeOi)}
                      </td>
                      <td className={`text-right px-3 py-2.5 tabular-nums font-medium ${stock.futuresChangeOiPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {stock.futuresChangeOiPercent !== 0 ? `${stock.futuresChangeOiPercent >= 0 ? '+' : ''}${stock.futuresChangeOiPercent.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <OIBadge type={stock.oiInterpretation} />
                      </td>
                      <td className={`text-right px-3 py-2.5 tabular-nums ${stock.pcr > 1 ? 'text-emerald-400' : stock.pcr < 0.7 ? 'text-red-400' : 'text-gray-400 light:text-slate-500'}`}>
                        {stock.pcr > 0 ? stock.pcr.toFixed(2) : '—'}
                      </td>
                      <td className="text-center px-3 py-2.5">
                        <BiasBadge bias={stock.direction} />
                      </td>
                      <td className="text-center px-3 py-2.5">
                        <ScoreBadge score={stock.score} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-[10px] text-gray-600 light:text-slate-400 leading-snug">
          Buildup classification compares today's futures price change against futures OI change since the day's opening baseline
          (Long/Short Buildup = OI rising with price up/down, Short Covering/Long Unwinding = OI falling with price up/down). 🔥
          flags the 10 stocks with the largest OI% swing right now, regardless of direction. Click a row to open its full option
          chain.
        </p>
      )}
    </div>
  );
}

function SortTh({
  label,
  active,
  desc,
  onClick,
  align = 'right',
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 font-medium cursor-pointer select-none hover:text-gray-300 light:hover:text-slate-700 transition-colors whitespace-nowrap ${
        align === 'left' ? 'text-left' : align === 'center' ? 'text-center' : 'text-right'
      } ${active ? 'text-emerald-400' : ''}`}
    >
      {label}
      {active && <span className="ml-0.5">{desc ? '▾' : '▴'}</span>}
    </th>
  );
}
