'use client';

import React, { useMemo, useState } from 'react';
import { useAllIndices } from '@/lib/use-all-indices';
import { getPriceHistory } from '@/lib/price-history-store';
import { formatIndianNumber, formatPercent } from '@fno/shared';
import type { Exchange, MarketQuote } from '@fno/shared';
import { Sparkline } from '@/components/common/sparkline';
import { SkeletonTableRow } from '@/components/common/skeleton';
import { FilterPills } from '@/components/common/filter-pills';
import { ScoreBadge, BiasBadge } from '@/components/common/badges';
import { computeIndexStrength, computeIndexBias } from '@/lib/index-strength';
import { useAssetTabsStore } from '@/stores';

// Friendlier display names for the compact lookup-key symbols this
// terminal uses internally (see KNOWN_INDEX_TOKENS) — the handful that
// already appear elsewhere in the app (NIFTY, BANKNIFTY, SENSEX, ...)
// deliberately keep their raw symbol so labeling stays consistent with
// the Dashboard/TopBar. MCX's near-duplicate benchmark tickers (e.g.
// MCXCOMPDEX vs MCXCOMPOSITE) are left as their raw Angel One symbol
// rather than guessing at a distinguishing name.
const INDEX_LABELS: Record<string, string> = {
  NIFTYNEXT50: 'NIFTY Next 50',
  NIFTY100: 'NIFTY 100',
  NIFTY500: 'NIFTY 500',
  INDIAVIX: 'India VIX',
  NIFTYIT: 'NIFTY IT',
  NIFTYAUTO: 'NIFTY Auto',
  NIFTYPHARMA: 'NIFTY Pharma',
  NIFTYFMCG: 'NIFTY FMCG',
  NIFTYMETAL: 'NIFTY Metal',
  NIFTYREALTY: 'NIFTY Realty',
  NIFTYENERGY: 'NIFTY Energy',
  NIFTYPSUBANK: 'NIFTY PSU Bank',
  NIFTYPVTBANK: 'NIFTY Pvt Bank',
  NIFTYMEDIA: 'NIFTY Media',
  NIFTYINFRA: 'NIFTY Infra',
  BSE100: 'BSE 100',
  BSE200: 'BSE 200',
  BSE500: 'BSE 500',
  BSEMIDCAP: 'BSE MidCap',
  BSESMALLCAP: 'BSE SmallCap',
  BSEIT: 'BSE IT',
  MCXCRUDEX: 'MCX Crude Oil Index',
  MCXCOPRDEX: 'MCX Copper Index',
  MCXSILVDEX: 'MCX Silver Index',
  MCXGOLDEX: 'MCX Gold Index',
};

function labelFor(symbol: string): string {
  return INDEX_LABELS[symbol] || symbol;
}

type ExchangeFilter = 'ALL' | Exchange;

const EXCHANGE_OPTIONS: Array<{ value: ExchangeFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'NSE', label: 'NSE' },
  { value: 'BSE', label: 'BSE' },
  { value: 'MCX', label: 'MCX' },
];

export function IndicesPage() {
  const { indices, isLive, loading } = useAllIndices();
  const openTab = useAssetTabsStore((s) => s.openTab);
  const [query, setQuery] = useState('');
  const [exchangeFilter, setExchangeFilter] = useState<ExchangeFilter>('ALL');

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let base = indices;
    if (exchangeFilter !== 'ALL') base = base.filter((i) => i.exchange === exchangeFilter);
    if (q) base = base.filter((i) => i.symbol.includes(q) || labelFor(i.symbol).toUpperCase().includes(q));
    return base;
  }, [indices, query, exchangeFilter]);

  const grouped = useMemo(() => {
    const groups: Record<Exchange, MarketQuote[]> = { NSE: [], BSE: [], MCX: [] };
    for (const i of filtered) groups[i.exchange]?.push(i);
    return groups;
  }, [filtered]);

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">Indices</h1>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            Every broad-market and sectoral index this terminal tracks, across NSE, BSE, and MCX's commodity benchmark indices.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-gray-500 light:text-slate-500">
            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600 light:bg-slate-300'}`} />
            {isLive ? `${filtered.length} of ${indices.length}` : loading ? 'Loading…' : 'Unreachable'}
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter index…"
            className="bg-gray-900/70 light:bg-slate-50 border border-gray-700/60 light:border-slate-200 rounded-lg px-3 py-1.5 text-xs text-gray-200 light:text-slate-800 placeholder-gray-600 light:placeholder-slate-400 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-colors w-40"
          />
        </div>
      </div>

      <div className="flex items-center flex-wrap gap-4">
        <FilterPills label="Exchange" options={EXCHANGE_OPTIONS} value={exchangeFilter} onChange={setExchangeFilter} />
      </div>

      {!isLive && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium">
          ⚠️ Live index feed unreachable — showing nothing right now. It'll pick back up on the next successful poll.
        </div>
      )}

      {loading && indices.length === 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] p-1">
          <table className="w-full text-xs">
            <tbody>
              {Array.from({ length: 8 }, (_, i) => (
                <SkeletonTableRow key={i} cols={8} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {indices.length > 0 && filtered.length === 0 && (
        <div className="text-sm text-gray-500 light:text-slate-500 py-16 text-center">No indices match the current filters.</div>
      )}

      {(['NSE', 'BSE', 'MCX'] as const).map((exchange) =>
        grouped[exchange].length > 0 ? (
          <IndexGroup key={exchange} exchange={exchange} rows={grouped[exchange]} onOpen={openTab} />
        ) : null
      )}
    </div>
  );
}

function IndexGroup({
  exchange,
  rows,
  onOpen,
}: {
  exchange: Exchange;
  rows: MarketQuote[];
  onOpen: (symbol: string, exchange: Exchange) => string;
}) {
  return (
    <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)]">
      <div className="px-4 py-2.5 border-b border-gray-800/60 light:border-slate-200">
        <h2 className="text-sm font-bold text-gray-200 light:text-slate-800">{exchange} <span className="text-gray-500 light:text-slate-500 font-medium">— {rows.length} indices</span></h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gradient-to-b from-gray-900/90 to-gray-900/60 light:from-slate-100 light:to-slate-50 text-gray-500 light:text-slate-500 uppercase tracking-wider">
              <th className="text-left px-4 py-2 font-medium">Index</th>
              <th className="text-center px-3 py-2 font-medium">Strength</th>
              <th className="text-center px-3 py-2 font-medium">Bias</th>
              <th className="text-right px-3 py-2 font-medium">LTP</th>
              <th className="text-right px-3 py-2 font-medium">Chg</th>
              <th className="text-right px-3 py-2 font-medium">Chg%</th>
              <th className="text-right px-3 py-2 font-medium">Day Range</th>
              <th className="text-right px-3 py-2 font-medium">Trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isPositive = row.change >= 0;
              const dayRange = row.high - row.low;
              const positionInRange = dayRange > 0 ? ((row.ltp - row.low) / dayRange) * 100 : 50;
              const strength = computeIndexStrength(row);
              const bias = computeIndexBias(strength);
              return (
                <tr
                  key={row.token}
                  onClick={() => onOpen(row.symbol, row.exchange)}
                  className="border-t border-gray-800/40 light:border-slate-200 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2.5 font-semibold text-gray-200 light:text-slate-800 whitespace-nowrap">{labelFor(row.symbol)}</td>
                  <td className="text-center px-3 py-2.5">
                    <ScoreBadge score={strength} />
                  </td>
                  <td className="text-center px-3 py-2.5">
                    <BiasBadge bias={bias} />
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-200 light:text-slate-800 whitespace-nowrap">{formatIndianNumber(row.ltp, 2)}</td>
                  <td className={`text-right px-3 py-2.5 tabular-nums font-medium whitespace-nowrap ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                    {isPositive ? '+' : ''}{row.change.toFixed(2)}
                  </td>
                  <td className={`text-right px-3 py-2.5 tabular-nums font-medium whitespace-nowrap ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatPercent(row.changePercent)}
                  </td>
                  <td className="text-right px-3 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5 justify-end">
                      <span className="text-[10px] text-gray-500 light:text-slate-500 tabular-nums">{formatIndianNumber(row.low, 0)}</span>
                      <div className="w-14 h-1.5 bg-gray-800 light:bg-slate-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full bar-animated ${isPositive ? 'bg-gradient-to-r from-emerald-600 to-emerald-400' : 'bg-gradient-to-r from-red-600 to-red-400'}`}
                          style={{ width: `${positionInRange}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-500 light:text-slate-500 tabular-nums">{formatIndianNumber(row.high, 0)}</span>
                    </div>
                  </td>
                  <td className="text-right px-3 py-2.5">
                    <div className="flex justify-end">
                      <Sparkline
                        data={getPriceHistory(row.symbol)}
                        symbol={row.symbol}
                        width={56}
                        height={18}
                        color={isPositive ? '#34d399' : '#f87171'}
                        showArea={false}
                        strokeWidth={1.2}
                        points={20}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
