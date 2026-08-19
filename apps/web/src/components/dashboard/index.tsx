'use client';

import React from 'react';
import { useLiveIndices } from '@/lib/use-live-indices';
import { useAllIndices } from '@/lib/use-all-indices';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { formatIndianNumber, formatPercent, formatCompact } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { OIBadge, BiasBadge, ScoreBadge } from '@/components/common/badges';
import { AddAssetButton } from '@/components/common/add-asset-button';
import { ActivityList } from '@/components/common/activity-list';
import { TopMoversList } from '@/components/common/top-movers-list';
import { ChartPatternsPanel } from '@/components/common/chart-patterns-panel';
import { Sparkline } from '@/components/common/sparkline';
import { SkeletonTableRow } from '@/components/common/skeleton';
import { getPriceHistory } from '@/lib/price-history-store';
import { useChartPatterns } from '@/lib/use-chart-patterns';
import { useAssetTabsStore, useMarketStore } from '@/stores';

const TOP_MOVERS_COUNT = 5;

export function Dashboard() {
  const { indices, isLive: indicesLive } = useLiveIndices();
  const { indices: allIndices } = useAllIndices();
  const { rows: fnoRows, isLive: fnoLive } = useFnoScanner('NSE');
  const { patterns, loading: patternsLoading } = useChartPatterns();
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  const topStocks = fnoRows.slice(0, 8);

  const indexGainers = [...allIndices].sort((a, b) => b.changePercent - a.changePercent).slice(0, TOP_MOVERS_COUNT);
  const indexLosers = [...allIndices].sort((a, b) => a.changePercent - b.changePercent).slice(0, TOP_MOVERS_COUNT);
  const toMoverItem = (r: (typeof fnoRows)[number]) => ({ symbol: r.symbol, exchange: r.exchange, ltp: r.price, changePercent: r.changePercent });
  const stockGainers = [...fnoRows].sort((a, b) => b.changePercent - a.changePercent).slice(0, TOP_MOVERS_COUNT).map(toMoverItem);
  const stockLosers = [...fnoRows].sort((a, b) => a.changePercent - b.changePercent).slice(0, TOP_MOVERS_COUNT).map(toMoverItem);

  return (
    <div className="p-4 space-y-4 min-h-full">
      {!indicesLive && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium animate-slide-in backdrop-blur-sm">
          ⚠️ Index prices above are sample data right now — backend unreachable.
        </div>
      )}

      {/* Market Overview Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100 light:text-slate-900 section-header">Market Overview</h1>
        <AddAssetButton />
      </div>

      {/* Index Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
        {indices.map((index, i) => (
          <div key={index.token} className="stagger-item" style={{ '--stagger-index': i } as React.CSSProperties}>
            <IndexCard {...index} />
          </div>
        ))}
      </div>

      {/* F&O Activity Scanner — top 8 by score; full universe lives on the F&O Stocks tab */}
      <div className="card-premium card-accent-top animate-fade-in" style={{ '--accent-gradient': 'linear-gradient(90deg, rgba(251, 146, 60, 0.6), rgba(16, 185, 129, 0.4), rgba(6, 182, 212, 0.3))' } as React.CSSProperties}>
        <div className="px-4 py-3 border-b border-gray-800/40 light:border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-200 light:text-slate-800">🔥 F&O Market Activity <span className="text-gray-500 light:text-slate-500 font-medium">— top movers</span></h2>
          <button
            onClick={() => setActiveTab('fno-stocks')}
            className="text-[11px] text-emerald-400 light:text-emerald-700 hover:text-emerald-300 light:hover:text-emerald-600 font-medium transition-colors hover:underline underline-offset-2"
          >
            View all {fnoRows.length > 0 ? fnoRows.length : ''} F&O stocks →
          </button>
        </div>
        {!fnoLive && topStocks.length === 0 ? (
          <div className="p-1">
            <table className="w-full text-xs">
              <tbody>
                {Array.from({ length: 5 }, (_, i) => (
                  <SkeletonTableRow key={i} cols={12} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-premium">
              <thead>
                <tr className="bg-gray-900/40 light:bg-slate-50 text-gray-500 light:text-slate-500 uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">Stock</th>
                  <th className="text-right px-3 py-2.5 font-medium">Price</th>
                  <th className="text-right px-3 py-2.5 font-medium">Chg%</th>
                  <th className="text-right px-3 py-2.5 font-medium">Volume</th>
                  <th className="text-right px-3 py-2.5 font-medium">Futures OI</th>
                  <th className="text-right px-3 py-2.5 font-medium">OI Chg</th>
                  <th className="text-left px-3 py-2.5 font-medium">OI Activity</th>
                  <th className="text-right px-3 py-2.5 font-medium">PCR</th>
                  <th className="text-right px-3 py-2.5 font-medium">IV</th>
                  <th className="text-right px-3 py-2.5 font-medium">IV Rank</th>
                  <th className="text-center px-3 py-2.5 font-medium">Bias</th>
                  <th className="text-center px-3 py-2.5 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {topStocks.map((stock, idx) => (
                  <tr
                    key={stock.symbol}
                    onClick={() => useAssetTabsStore.getState().openTab(stock.symbol, stock.exchange)}
                    className="border-t border-gray-800/20 light:border-slate-100 cursor-pointer transition-all stagger-item"
                    style={{ '--stagger-index': idx } as React.CSSProperties}
                  >
                    <td className="px-4 py-2.5 font-medium text-gray-200 light:text-slate-800">
                      <div className="flex items-center gap-2">
                        <Sparkline
                          data={getPriceHistory(stock.symbol)}
                          symbol={stock.symbol}
                          width={36}
                          height={14}
                          color={stock.changePercent >= 0 ? '#34d399' : '#f87171'}
                          showArea={false}
                          strokeWidth={1}
                          points={16}
                        />
                        {stock.symbol}
                      </div>
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-200 light:text-slate-800">
                      {formatIndianNumber(stock.price, 2)}
                    </td>
                    <td className={`text-right px-3 py-2.5 tabular-nums font-medium ${
                      stock.changePercent >= 0 ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'
                    }`}>
                      {formatPercent(stock.changePercent)}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-500">
                      {formatCompact(stock.volume)}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-500">
                      {formatCompact(stock.futuresOi)}
                    </td>
                    <td className={`text-right px-3 py-2.5 tabular-nums font-medium ${
                      stock.futuresChangeOi >= 0 ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'
                    }`}>
                      {stock.futuresChangeOi >= 0 ? '+' : ''}{formatCompact(stock.futuresChangeOi)}
                    </td>
                    <td className="px-3 py-2.5">
                      <OIBadge type={stock.oiInterpretation} />
                    </td>
                    <td className={`text-right px-3 py-2.5 tabular-nums ${
                      stock.pcr > 1 ? 'text-emerald-400 light:text-emerald-700' : stock.pcr < 0.7 ? 'text-red-400 light:text-red-700' : 'text-gray-400 light:text-slate-500'
                    }`}>
                      {stock.pcr > 0 ? stock.pcr.toFixed(2) : '—'}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-500">
                      {stock.atmIv > 0 ? `${stock.atmIv.toFixed(1)}%` : '—'}
                    </td>
                    <td className="text-right px-3 py-2.5">
                      {stock.ivRank != null ? <IVRankBar value={stock.ivRank} /> : <span className="text-gray-600 light:text-slate-400">—</span>}
                    </td>
                    <td className="text-center px-3 py-2.5">
                      <BiasBadge bias={stock.direction} />
                    </td>
                    <td className="text-center px-3 py-2.5">
                      <ScoreBadge score={stock.score} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Top Performing Indices & F&O Stocks */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <TopMoversList title="📈 Top Index Gainers" items={indexGainers} accent="emerald" />
        <TopMoversList title="📉 Top Index Losers" items={indexLosers} accent="red" />
        <TopMoversList title="📈 Top Stock Gainers" items={stockGainers} accent="emerald" />
        <TopMoversList title="📉 Top Stock Losers" items={stockLosers} accent="red" />
      </div>

      <ChartPatternsPanel patterns={patterns} loading={patternsLoading} />

      {/* Top Activity Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <ActivityList
          title="🟢 Top Long Buildup"
          items={fnoRows.filter(s => s.oiInterpretation === 'LONG_BUILDUP').slice(0, 5)}
          color="emerald"
        />
        <ActivityList
          title="🔴 Top Short Buildup"
          items={fnoRows.filter(s => s.oiInterpretation === 'SHORT_BUILDUP').slice(0, 5)}
          color="red"
        />
        <ActivityList
          title="🟡 Short Covering"
          items={fnoRows.filter(s => s.oiInterpretation === 'SHORT_COVERING').slice(0, 5)}
          color="yellow"
        />
        <ActivityList
          title="🟡 Long Unwinding"
          items={fnoRows.filter(s => s.oiInterpretation === 'LONG_UNWINDING').slice(0, 5)}
          color="orange"
        />
      </div>
    </div>
  );
}

// --- Sub-components ---

function IndexCard({ symbol, exchange, ltp, change, changePercent, open, high, low, close }: any) {
  const isPositive = change >= 0;
  const dayRange = high - low;
  const positionInRange = dayRange > 0 ? ((ltp - low) / dayRange) * 100 : 50;
  const openTab = useAssetTabsStore((s) => s.openTab);

  return (
    <div
      onClick={() => openTab(symbol, exchange as Exchange)}
      className="card-premium card-accent-top p-3.5 hover:-translate-y-1 hover:shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_20px_56px_-16px_rgba(0,0,0,0.9),0_4px_12px_-2px_rgba(0,0,0,0.5)] cursor-pointer group"
      style={{ '--accent-gradient': isPositive
        ? 'linear-gradient(90deg, rgba(16, 185, 129, 0.7), rgba(6, 182, 212, 0.4))'
        : 'linear-gradient(90deg, rgba(239, 68, 68, 0.7), rgba(251, 146, 60, 0.4))'
      } as React.CSSProperties}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-400 light:text-slate-500 group-hover:text-gray-200 light:group-hover:text-slate-800 transition-colors tracking-wide">{symbol}</span>
        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-md badge-glass ${
          isPositive ? 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700' : 'bg-red-500/15 text-red-400 light:text-red-700'
        }`}>
          {formatPercent(changePercent)}
        </span>
      </div>
      <div className="flex items-end justify-between mb-1">
        <div className={`text-2xl font-bold tabular-nums text-gray-50 light:text-slate-900 ${isPositive ? 'text-glow-emerald' : 'text-glow-red'}`}>
          {formatIndianNumber(ltp, 2)}
        </div>
        {/* Sparkline */}
        <Sparkline
          data={getPriceHistory(symbol)}
          symbol={symbol}
          width={64}
          height={24}
          color={isPositive ? '#34d399' : '#f87171'}
          showArea={true}
          strokeWidth={1.3}
          points={24}
          className="opacity-80 group-hover:opacity-100 transition-opacity"
        />
      </div>
      <div className={`text-xs tabular-nums mb-3 font-medium ${isPositive ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
        {isPositive ? '▲' : '▼'} {Math.abs(change).toFixed(2)}
      </div>
      {/* Day Range Bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-gray-500 light:text-slate-500 tabular-nums">
          <span>L: {formatIndianNumber(low, 2)}</span>
          <span>H: {formatIndianNumber(high, 2)}</span>
        </div>
        <div className="relative h-1.5 bg-gray-800/80 light:bg-slate-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full bar-animated ${isPositive ? 'bg-gradient-to-r from-emerald-600 to-emerald-400' : 'bg-gradient-to-r from-red-600 to-red-400'}`}
            style={{ width: `${positionInRange}%` }}
          />
          {/* Glowing dot at current position */}
          <div
            className={`absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full ${isPositive ? 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.6)]' : 'bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.6)]'} transition-all duration-500`}
            style={{ left: `calc(${positionInRange}% - 4px)` }}
          />
        </div>
      </div>
    </div>
  );
}

// --- Local Badge Components ---
// (OIBadge, BiasBadge, ScoreBadge live in components/common/badges.tsx and are imported above)

function IVRankBar({ value }: { value: number }) {
  const color = value >= 70 ? 'bg-red-500' : value >= 40 ? 'bg-yellow-500' : 'bg-emerald-500';

  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-12 h-1.5 bg-gray-800/80 light:bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full bar-animated ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-gray-400 light:text-slate-500 w-6 text-right">{value}</span>
    </div>
  );
}
