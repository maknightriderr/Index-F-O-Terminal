'use client';

import React, { useMemo, useState } from 'react';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { useAssetTabsStore } from '@/stores';
import { formatIndianNumber } from '@fno/shared';
import type { FnoScannerRow } from '@fno/shared';
import { BiasBadge } from '@/components/common/badges';
import { FilterPills } from '@/components/common/filter-pills';
import { SkeletonTableRow } from '@/components/common/skeleton';
import type { BiasDirection } from '@fno/shared';

type SortKey = 'symbol' | 'price' | 'atmIv' | 'ivRank' | 'ivPercentile' | 'ivSkew' | 'atmGamma' | 'atmTheta' | 'atmVega' | 'pcr';
type BiasFilter = 'ALL' | BiasDirection;
type IvRankFilter = 'ALL' | 'HIGH' | 'LOW';

const BIAS_OPTIONS: Array<{ value: BiasFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'BULLISH', label: 'Bullish' },
  { value: 'BEARISH', label: 'Bearish' },
  { value: 'NEUTRAL', label: 'Neutral' },
];

const IV_RANK_OPTIONS: Array<{ value: IvRankFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'HIGH', label: 'High (≥70)' },
  { value: 'LOW', label: 'Low (≤30)' },
];

export function IvGreeksPage() {
  const { rows, isLive, loading } = useFnoScanner('NSE');
  const openTab = useAssetTabsStore((s) => s.openTab);
  const [query, setQuery] = useState('');
  const [biasFilter, setBiasFilter] = useState<BiasFilter>('ALL');
  const [ivRankFilter, setIvRankFilter] = useState<IvRankFilter>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('ivRank');
  const [sortDesc, setSortDesc] = useState(true);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let base = q ? rows.filter((r) => r.symbol.includes(q)) : rows;
    if (biasFilter !== 'ALL') base = base.filter((r) => r.direction === biasFilter);
    if (ivRankFilter === 'HIGH') base = base.filter((r) => r.ivRank != null && r.ivRank >= 70);
    if (ivRankFilter === 'LOW') base = base.filter((r) => r.ivRank != null && r.ivRank <= 30);
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
  }, [rows, query, biasFilter, ivRankFilter, sortKey, sortDesc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">IV & Greeks</h1>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            ATM IV, IV Rank/Percentile, CE-PE skew, and ATM Gamma/Theta/Vega — every NSE stock with F&O contracts.
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
        <FilterPills label="IV Rank" options={IV_RANK_OPTIONS} value={ivRankFilter} onChange={setIvRankFilter} />
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

      {filtered.length > 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)]">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gradient-to-b from-gray-900/90 to-gray-900/60 light:from-slate-100 light:to-slate-50 text-gray-500 light:text-slate-500 uppercase tracking-wider">
                  <SortTh label="Stock" active={sortKey === 'symbol'} desc={sortDesc} onClick={() => toggleSort('symbol')} align="left" />
                  <SortTh label="Price" active={sortKey === 'price'} desc={sortDesc} onClick={() => toggleSort('price')} />
                  <SortTh label="ATM IV" active={sortKey === 'atmIv'} desc={sortDesc} onClick={() => toggleSort('atmIv')} />
                  <SortTh label="IV Rank" active={sortKey === 'ivRank'} desc={sortDesc} onClick={() => toggleSort('ivRank')} />
                  <SortTh label="IV %ile" active={sortKey === 'ivPercentile'} desc={sortDesc} onClick={() => toggleSort('ivPercentile')} />
                  <SortTh label="Skew (CE-PE)" active={sortKey === 'ivSkew'} desc={sortDesc} onClick={() => toggleSort('ivSkew')} />
                  <SortTh label="Gamma" active={sortKey === 'atmGamma'} desc={sortDesc} onClick={() => toggleSort('atmGamma')} />
                  <SortTh label="Theta ₹/day" active={sortKey === 'atmTheta'} desc={sortDesc} onClick={() => toggleSort('atmTheta')} />
                  <SortTh label="Vega" active={sortKey === 'atmVega'} desc={sortDesc} onClick={() => toggleSort('atmVega')} />
                  <SortTh label="PCR" active={sortKey === 'pcr'} desc={sortDesc} onClick={() => toggleSort('pcr')} />
                  <th className="text-center px-3 py-2 font-medium">Bias</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((stock) => (
                  <tr
                    key={stock.symbol}
                    onClick={() => openTab(stock.symbol, stock.exchange)}
                    className="border-t border-gray-800/40 light:border-slate-200 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5 font-semibold text-gray-200 light:text-slate-800">{stock.symbol}</td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-200 light:text-slate-800">{formatIndianNumber(stock.price, 2)}</td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-500">
                      {stock.atmIv > 0 ? `${stock.atmIv.toFixed(1)}%` : '—'}
                    </td>
                    <td className="text-right px-3 py-2.5">
                      {stock.ivRank != null ? <MetricBar value={stock.ivRank} /> : <span className="text-gray-600 light:text-slate-300">—</span>}
                    </td>
                    <td className="text-right px-3 py-2.5">
                      {stock.ivPercentile != null ? <MetricBar value={stock.ivPercentile} /> : <span className="text-gray-600 light:text-slate-300">—</span>}
                    </td>
                    <td className={`text-right px-3 py-2.5 tabular-nums font-medium ${
                      stock.ivSkew === 0 ? 'text-gray-400 light:text-slate-500' : stock.ivSkew > 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {stock.ivSkew !== 0 ? `${stock.ivSkew >= 0 ? '+' : ''}${stock.ivSkew.toFixed(1)}` : '—'}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-500">
                      {stock.atmGamma > 0 ? stock.atmGamma.toFixed(4) : '—'}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-red-400/90">
                      {stock.atmTheta !== 0 ? stock.atmTheta.toFixed(2) : '—'}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-500">
                      {stock.atmVega > 0 ? stock.atmVega.toFixed(2) : '—'}
                    </td>
                    <td className={`text-right px-3 py-2.5 tabular-nums ${stock.pcr > 1 ? 'text-emerald-400' : stock.pcr < 0.7 ? 'text-red-400' : 'text-gray-400 light:text-slate-500'}`}>
                      {stock.pcr > 0 ? stock.pcr.toFixed(2) : '—'}
                    </td>
                    <td className="text-center px-3 py-2.5">
                      <BiasBadge bias={stock.direction} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-[10px] text-gray-600 light:text-slate-400 leading-snug">
          IV Rank/Percentile need daily history the terminal only started collecting recently, so they read "—" until at least two
          days of data exist per stock. Gamma/Theta/Vega are per-share ATM Greeks (average of the nearest-expiry ATM call and put,
          from our own Black-Scholes engine) — Theta is the combined call+put daily decay. Skew is Call IV minus Put IV at the ATM
          strike; positive means calls are pricier than puts. Click a row to open its full option chain.
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

function MetricBar({ value }: { value: number }) {
  const color = value >= 70 ? 'bg-red-500' : value >= 40 ? 'bg-yellow-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-12 h-1.5 bg-gray-900/70 light:bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-gray-400 light:text-slate-500 w-6 text-right">{value}</span>
    </div>
  );
}
