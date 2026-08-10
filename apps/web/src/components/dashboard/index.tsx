'use client';

import React from 'react';
import { useLiveIndices } from '@/lib/use-live-indices';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { formatIndianNumber, formatPercent, formatCompact } from '@fno/shared';
import type { Exchange, FnoScannerRow } from '@fno/shared';
import { OIBadge, BiasBadge, ScoreBadge } from '@/components/common/badges';
import { AddAssetButton } from '@/components/common/add-asset-button';
import { useAssetTabsStore, useMarketStore } from '@/stores';

export function Dashboard() {
  const { indices, isLive: indicesLive } = useLiveIndices();
  const { rows: fnoRows, isLive: fnoLive } = useFnoScanner('NSE');
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  const topStocks = fnoRows.slice(0, 8);

  return (
    <div className="p-4 space-y-4 min-h-full">
      {!indicesLive && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium">
          ⚠️ Index prices above are sample data right now — backend unreachable.
        </div>
      )}

      {/* Market Overview Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100 light:text-slate-900">Market Overview</h1>
        <AddAssetButton />
      </div>

      {/* Index Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
        {indices.map((index) => (
          <IndexCard key={index.token} {...index} />
        ))}
      </div>

      {/* F&O Activity Scanner — top 8 by score; full universe lives on the F&O Stocks tab */}
      <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)] overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800/60 light:border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-200 light:text-slate-800">🔥 F&O Market Activity <span className="text-gray-500 light:text-slate-500 font-medium">— top movers</span></h2>
          <button
            onClick={() => setActiveTab('fno-stocks')}
            className="text-[11px] text-emerald-400 light:text-emerald-700 hover:text-emerald-300 light:hover:text-emerald-600 font-medium transition-colors"
          >
            View all {fnoRows.length > 0 ? fnoRows.length : ''} F&O stocks →
          </button>
        </div>
        {!fnoLive && topStocks.length === 0 ? (
          <div className="text-sm text-gray-500 light:text-slate-500 py-10 text-center">Scanning the F&O universe…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-900/50 light:bg-slate-100 text-gray-500 light:text-slate-500 uppercase tracking-wider">
                  <th className="text-left px-4 py-2 font-medium">Stock</th>
                  <th className="text-right px-3 py-2 font-medium">Price</th>
                  <th className="text-right px-3 py-2 font-medium">Chg%</th>
                  <th className="text-right px-3 py-2 font-medium">Volume</th>
                  <th className="text-right px-3 py-2 font-medium">Futures OI</th>
                  <th className="text-right px-3 py-2 font-medium">OI Chg</th>
                  <th className="text-left px-3 py-2 font-medium">OI Activity</th>
                  <th className="text-right px-3 py-2 font-medium">PCR</th>
                  <th className="text-right px-3 py-2 font-medium">IV</th>
                  <th className="text-right px-3 py-2 font-medium">IV Rank</th>
                  <th className="text-center px-3 py-2 font-medium">Bias</th>
                  <th className="text-center px-3 py-2 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {topStocks.map((stock) => (
                  <tr
                    key={stock.symbol}
                    onClick={() => useAssetTabsStore.getState().openTab(stock.symbol, stock.exchange)}
                    className="border-t border-gray-800/30 light:border-slate-200 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5 font-medium text-gray-200 light:text-slate-800">{stock.symbol}</td>
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
      className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)] p-3.5 hover:border-gray-700/80 light:hover:border-slate-300 hover:-translate-y-0.5 hover:shadow-[0_16px_40px_-16px_rgba(0,0,0,0.85)] transition-all duration-200 cursor-pointer group"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-400 light:text-slate-500 group-hover:text-gray-200 light:group-hover:text-slate-800 transition-colors tracking-wide">{symbol}</span>
        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-md ${
          isPositive ? 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700' : 'bg-red-500/15 text-red-400 light:text-red-700'
        }`}>
          {formatPercent(changePercent)}
        </span>
      </div>
      <div className="text-2xl font-bold tabular-nums text-gray-50 light:text-slate-900 mb-1">
        {formatIndianNumber(ltp, 2)}
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
        <div className="h-1.5 bg-gray-800 light:bg-slate-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${isPositive ? 'bg-gradient-to-r from-emerald-600 to-emerald-400' : 'bg-gradient-to-r from-red-600 to-red-400'}`}
            style={{ width: `${positionInRange}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function ActivityList({
  title,
  items,
  color,
}: {
  title: string;
  items: FnoScannerRow[];
  color: string;
}) {
  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)] hover:border-gray-700/80 light:hover:border-slate-300 transition-all duration-200 p-3.5">
      <h3 className="text-xs font-bold text-gray-300 light:text-slate-700 mb-2.5">{title}</h3>
      {items.length === 0 ? (
        <div className="text-xs text-gray-600 light:text-slate-400 py-2">No activity</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((s) => (
            <div
              key={s.symbol}
              onClick={() => useAssetTabsStore.getState().openTab(s.symbol, s.exchange)}
              className="flex items-center justify-between text-xs py-1 hover:bg-gray-800/30 light:hover:bg-slate-100 px-1.5 rounded cursor-pointer"
            >
              <span className="text-gray-300 light:text-slate-700 font-medium">{s.symbol}</span>
              <div className="flex items-center gap-2">
                <span className={`tabular-nums ${s.changePercent >= 0 ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
                  {formatPercent(s.changePercent)}
                </span>
                <span className="text-gray-500 light:text-slate-500 tabular-nums">{formatCompact(s.futuresChangeOi)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Local Badge Components ---
// (OIBadge, BiasBadge, ScoreBadge live in components/common/badges.tsx and are imported above)

function IVRankBar({ value }: { value: number }) {
  const color = value >= 70 ? 'bg-red-500' : value >= 40 ? 'bg-yellow-500' : 'bg-emerald-500';

  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-12 h-1.5 bg-gray-800 light:bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-gray-400 light:text-slate-500 w-6 text-right">{value}</span>
    </div>
  );
}

