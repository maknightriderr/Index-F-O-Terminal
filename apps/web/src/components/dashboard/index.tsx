'use client';

import React from 'react';
import {
  MOCK_INDICES,
  MOCK_FNO_SCANNER,
  MOCK_NIFTY_BIAS,
  MOCK_NIFTY_SCORE,
  MOCK_DATA_LABEL,
} from '@/lib/mock-data';
import { formatIndianNumber, formatPercent, formatCompact } from '@fno/shared';
import { OIBadge, BiasBadge, ScoreBadge } from '@/components/common/badges';
import { AddAssetButton } from '@/components/common/add-asset-button';

export function Dashboard() {
  return (
    <div className="p-4 space-y-4 min-h-full">
      {/* Mock Data Warning */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2 text-amber-400 text-xs font-medium">
        {MOCK_DATA_LABEL}
      </div>

      {/* Market Overview Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Market Overview</h1>
        <AddAssetButton />
      </div>

      {/* Index Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
        {MOCK_INDICES.map((index) => (
          <IndexCard key={index.token} {...index} />
        ))}
      </div>

      {/* Market Bias + Market Regime + Intelligence Score */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <MarketBiasCard />
        <MarketRegimeCard />
        <IntelligenceScoreCard />
      </div>

      {/* F&O Activity Scanner */}
      <div className="bg-[#12121a] border border-gray-800/50 rounded-lg overflow-hidden">
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

function IndexCard({ symbol, ltp, change, changePercent, open, high, low, close }: any) {
  const isPositive = change >= 0;
  const dayRange = high - low;
  const positionInRange = dayRange > 0 ? ((ltp - low) / dayRange) * 100 : 50;

  return (
    <div className="bg-[#12121a] border border-gray-800/50 rounded-lg p-3 hover:border-gray-700/60 transition-colors cursor-pointer group">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-400 group-hover:text-gray-300">{symbol}</span>
        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
          isPositive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
        }`}>
          {formatPercent(changePercent)}
        </span>
      </div>
      <div className="text-xl font-bold tabular-nums text-gray-100 mb-1">
        {formatIndianNumber(ltp, 2)}
      </div>
      <div className={`text-xs tabular-nums mb-3 ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
        {isPositive ? '▲' : '▼'} {Math.abs(change).toFixed(2)}
      </div>
      {/* Day Range Bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-gray-500 tabular-nums">
          <span>L: {formatIndianNumber(low, 2)}</span>
          <span>H: {formatIndianNumber(high, 2)}</span>
        </div>
        <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${isPositive ? 'bg-emerald-500' : 'bg-red-500'}`}
            style={{ width: `${positionInRange}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function MarketBiasCard() {
  const bias = MOCK_NIFTY_BIAS;

  return (
    <div className="bg-[#12121a] border border-gray-800/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">Market Bias — NIFTY</h3>
        <BiasBadge bias={bias.direction} large />
      </div>
      {/* Probability Bars */}
      <div className="space-y-2 mb-3">
        <ProbBar label="Bullish" value={bias.bullishProbability} color="emerald" />
        <ProbBar label="Neutral" value={bias.neutralProbability} color="gray" />
        <ProbBar label="Bearish" value={bias.bearishProbability} color="red" />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-500">Confidence</span>
        <span className="text-gray-300 font-medium">{bias.confidence}/100</span>
      </div>
      {/* Reasoning */}
      <div className="mt-3 pt-3 border-t border-gray-800/50 space-y-1">
        {bias.reasoning.slice(0, 4).map((r, i) => (
          <div key={i} className="text-[10px] text-gray-500 flex items-start gap-1">
            <span className="text-gray-600 mt-0.5">•</span>
            <span>{r}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MarketRegimeCard() {
  const regime = MOCK_NIFTY_BIAS.regime;
  const regimeLabels: Record<string, { label: string; color: string }> = {
    STRONG_BULL_TREND: { label: 'Strong Bull Trend', color: 'emerald' },
    WEAK_BULL_TREND: { label: 'Weak Bull Trend', color: 'green' },
    STRONG_BEAR_TREND: { label: 'Strong Bear Trend', color: 'red' },
    WEAK_BEAR_TREND: { label: 'Weak Bear Trend', color: 'orange' },
    RANGE_BOUND: { label: 'Range Bound', color: 'yellow' },
    HIGH_VOLATILITY: { label: 'High Volatility', color: 'purple' },
    LOW_VOLATILITY: { label: 'Low Volatility', color: 'blue' },
    BREAKOUT: { label: 'Breakout', color: 'cyan' },
    BREAKDOWN: { label: 'Breakdown', color: 'red' },
    EXPIRY_GAMMA: { label: 'Expiry Gamma', color: 'amber' },
  };

  const info = regimeLabels[regime] || { label: regime, color: 'gray' };

  return (
    <div className="bg-[#12121a] border border-gray-800/50 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-200 mb-3">Market Regime</h3>
      <div className={`text-lg font-bold text-${info.color}-400 mb-2`}>{info.label}</div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-gray-500 mb-1">Expected Range</div>
          <div className="text-gray-300 font-medium tabular-nums">24,380 — 24,860</div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">Max Pain</div>
          <div className="text-gray-300 font-medium tabular-nums">24,600</div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">Support</div>
          <div className="text-emerald-400 font-medium tabular-nums">24,500</div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">Resistance</div>
          <div className="text-red-400 font-medium tabular-nums">24,800</div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">PCR</div>
          <div className="text-gray-300 font-medium tabular-nums">1.12</div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">ATM IV</div>
          <div className="text-gray-300 font-medium tabular-nums">14.2%</div>
        </div>
      </div>
    </div>
  );
}

function IntelligenceScoreCard() {
  const score = MOCK_NIFTY_SCORE;

  const scoreBreakdown = [
    { label: 'Trend', value: score.trend },
    { label: 'Price Action', value: score.priceAction },
    { label: 'Futures OI', value: score.futuresOi },
    { label: 'Options OI', value: score.optionsOi },
    { label: 'PCR', value: score.pcr },
    { label: 'IV', value: score.iv },
    { label: 'Technicals', value: score.technicals },
    { label: 'Volume', value: score.volume },
  ];

  return (
    <div className="bg-[#12121a] border border-gray-800/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">Intelligence Score — NIFTY</h3>
        <ScoreBadge score={score.score} large />
      </div>
      <div className="space-y-1.5">
        {scoreBreakdown.map(({ label, value }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500 w-20 shrink-0">{label}</span>
            <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  value >= 70 ? 'bg-emerald-500' : value >= 40 ? 'bg-yellow-500' : 'bg-red-500'
                }`}
                style={{ width: `${value}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-400 tabular-nums w-6 text-right">{value}</span>
          </div>
        ))}
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
    <div className="bg-[#12121a] border border-gray-800/50 rounded-lg p-3">
      <h3 className="text-xs font-semibold text-gray-300 mb-2">{title}</h3>
      {items.length === 0 ? (
        <div className="text-xs text-gray-600 py-2">No activity</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((s) => (
            <div
              key={s.symbol}
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

function ProbBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-500 w-12 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full bg-${color}-500`}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-xs text-gray-300 font-medium tabular-nums w-8 text-right">{value}%</span>
    </div>
  );
}
