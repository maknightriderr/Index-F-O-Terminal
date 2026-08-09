'use client';

import React from 'react';
import { MOCK_FNO_SCANNER } from '@/lib/mock-data';
import { useLiveIndices } from '@/lib/use-live-indices';
import { formatIndianNumber, formatPercent, formatCompact } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { OIBadge, BiasBadge, ScoreBadge } from '@/components/common/badges';
import { AddAssetButton } from '@/components/common/add-asset-button';
import { useAssetTabsStore } from '@/stores';

export function Dashboard() {
  const { indices, isLive: indicesLive } = useLiveIndices();

  return (
    <div className="p-4 space-y-4 min-h-full">
      {/* Mock Data Warning — the F&O scanner table below has no live
          F&O-wide scanner built yet, so it's always sample data. Market
          Bias/Regime/Score and full option chain analysis now live inside
          each asset's own tab (open one via "+ Add Asset"), not here. */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 text-xs font-medium">
        ⚠️ The F&O Market Activity scanner below is sample data (no F&O-wide scanner built yet).
        {!indicesLive && ' Index prices above are also sample data right now — backend unreachable.'}
      </div>

      {/* Market Overview Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Market Overview</h1>
        <AddAssetButton />
      </div>

      {/* Index Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
        {indices.map((index) => (
          <IndexCard key={index.token} {...index} />
        ))}
      </div>

      {/* F&O Activity Scanner */}
      <div className="bg-[#12121a] border border-gray-800/60 rounded-xl shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800/50 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">🔥 F&O Market Activity</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Sort by</span>
            <select className="bg-gray-800/50 border border-gray-700/50 rounded px-2 py-1 text-xs text-gray-300">
              <option>Intelligence Score</option>
              <option>OI Change</option>
              <option>Price Change</option>
              <option>IV Rank</option>
              <option>Volume</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-900/50 text-gray-500 uppercase tracking-wider">
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
              {MOCK_FNO_SCANNER.map((stock) => (
                <tr
                  key={stock.symbol}
                  onClick={() => useAssetTabsStore.getState().openTab(stock.symbol, 'NSE')}
                  className="border-t border-gray-800/30 hover:bg-gray-800/30 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2.5 font-medium text-gray-200">{stock.symbol}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-200">
                    {formatIndianNumber(stock.price, 2)}
                  </td>
                  <td className={`text-right px-3 py-2.5 tabular-nums font-medium ${
                    stock.change >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {formatPercent(stock.change)}
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-400">
                    {formatCompact(stock.volume)}
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-400">
                    {formatCompact(stock.futOI)}
                  </td>
                  <td className={`text-right px-3 py-2.5 tabular-nums font-medium ${
                    stock.changeOI > 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {stock.changeOI > 0 ? '+' : ''}{formatCompact(stock.changeOI)}
                  </td>
                  <td className="px-3 py-2.5">
                    <OIBadge type={stock.oiType} />
                  </td>
                  <td className={`text-right px-3 py-2.5 tabular-nums ${
                    stock.pcr > 1 ? 'text-emerald-400' : stock.pcr < 0.7 ? 'text-red-400' : 'text-gray-400'
                  }`}>
                    {stock.pcr.toFixed(2)}
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums text-gray-400">
                    {stock.iv.toFixed(1)}%
                  </td>
                  <td className="text-right px-3 py-2.5">
                    <IVRankBar value={stock.ivRank} />
                  </td>
                  <td className="text-center px-3 py-2.5">
                    <BiasBadge bias={stock.bias} />
                  </td>
                  <td className="text-center px-3 py-2.5">
                    <ScoreBadge score={stock.score} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Top Activity Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <ActivityList
          title="🟢 Top Long Buildup"
          items={MOCK_FNO_SCANNER.filter(s => s.oiType === 'LONG_BUILDUP')}
          color="emerald"
        />
        <ActivityList
          title="🔴 Top Short Buildup"
          items={MOCK_FNO_SCANNER.filter(s => s.oiType === 'SHORT_BUILDUP')}
          color="red"
        />
        <ActivityList
          title="🟡 Short Covering"
          items={MOCK_FNO_SCANNER.filter(s => s.oiType === 'SHORT_COVERING')}
          color="yellow"
        />
        <ActivityList
          title="🟡 Long Unwinding"
          items={MOCK_FNO_SCANNER.filter(s => s.oiType === 'LONG_UNWINDING')}
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
      className="bg-[#12121a] border border-gray-800/60 rounded-xl shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] p-3.5 hover:border-gray-700/70 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-14px_rgba(0,0,0,0.7)] transition-all duration-200 cursor-pointer group"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-400 group-hover:text-gray-200 transition-colors tracking-wide">{symbol}</span>
        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-md ${
          isPositive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
        }`}>
          {formatPercent(changePercent)}
        </span>
      </div>
      <div className="text-2xl font-bold tabular-nums text-gray-50 mb-1">
        {formatIndianNumber(ltp, 2)}
      </div>
      <div className={`text-xs tabular-nums mb-3 font-medium ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
        {isPositive ? '▲' : '▼'} {Math.abs(change).toFixed(2)}
      </div>
      {/* Day Range Bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-gray-500 tabular-nums">
          <span>L: {formatIndianNumber(low, 2)}</span>
          <span>H: {formatIndianNumber(high, 2)}</span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
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
  items: typeof MOCK_FNO_SCANNER;
  color: string;
}) {
  return (
    <div className="bg-[#12121a] border border-gray-800/60 rounded-xl shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] p-3">
      <h3 className="text-xs font-semibold text-gray-300 mb-2">{title}</h3>
      {items.length === 0 ? (
        <div className="text-xs text-gray-600 py-2">No activity</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((s) => (
            <div
              key={s.symbol}
              onClick={() => useAssetTabsStore.getState().openTab(s.symbol, 'NSE')}
              className="flex items-center justify-between text-xs py-1 hover:bg-gray-800/30 px-1.5 rounded cursor-pointer"
            >
              <span className="text-gray-300 font-medium">{s.symbol}</span>
              <div className="flex items-center gap-2">
                <span className={`tabular-nums ${s.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatPercent(s.change)}
                </span>
                <span className="text-gray-500 tabular-nums">{formatCompact(s.changeOI)}</span>
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
      <div className="w-12 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-gray-400 w-6 text-right">{value}</span>
    </div>
  );
}

