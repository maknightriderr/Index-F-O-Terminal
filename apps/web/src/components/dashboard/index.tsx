'use client';

import React from 'react';
import { MOCK_FNO_SCANNER } from '@/lib/mock-data';
import { useLiveIndices } from '@/lib/use-live-indices';
import { useMarketBias } from '@/lib/use-market-bias';
import { formatIndianNumber, formatPercent, formatCompact } from '@fno/shared';
import type { Exchange, MarketBias, IntelligenceScore } from '@fno/shared';
import { OIBadge, BiasBadge, ScoreBadge } from '@/components/common/badges';
import { AddAssetButton } from '@/components/common/add-asset-button';
import { useAssetTabsStore, useMarketStore } from '@/stores';

export function Dashboard() {
  const { indices, isLive: indicesLive } = useLiveIndices();
  const { selectedSymbol, selectedExchange } = useMarketStore();
  const biasSymbol = selectedSymbol || 'NIFTY';
  const biasExchange = selectedExchange || 'NSE';
  const { bias, score, isLive: biasLive } = useMarketBias(biasSymbol, biasExchange);

  return (
    <div className="p-4 space-y-4 min-h-full">
      {/* Mock Data Warning — the F&O scanner table below has no live
          F&O-wide scanner built yet, so it's always sample data. Market
          Bias/Regime/Score is a live signal engine (RSI/VWAP/Supertrend/
          PCR/OI) for whichever asset is selected; it only shows sample
          data if that engine is unreachable. */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 text-xs font-medium">
        ⚠️ The F&O Market Activity scanner below is sample data (no F&O-wide scanner built yet).
        {!biasLive && ` Market Bias/Regime/Score for ${biasSymbol} is also sample data right now — live signal engine unreachable.`}
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

      {/* Market Bias + Market Regime + Intelligence Score */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <MarketBiasCard bias={bias} symbol={biasSymbol} />
        <MarketRegimeCard bias={bias} />
        <IntelligenceScoreCard score={score} symbol={biasSymbol} />
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

function MarketBiasCard({ bias, symbol }: { bias: MarketBias; symbol: string }) {
  return (
    <div className="bg-[#12121a] border border-gray-800/60 rounded-xl shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">Market Bias — {symbol}</h3>
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

const REGIME_LABELS: Record<string, { label: string; className: string }> = {
  STRONG_BULL_TREND: { label: 'Strong Bull Trend', className: 'text-emerald-400' },
  WEAK_BULL_TREND: { label: 'Weak Bull Trend', className: 'text-green-400' },
  STRONG_BEAR_TREND: { label: 'Strong Bear Trend', className: 'text-red-400' },
  WEAK_BEAR_TREND: { label: 'Weak Bear Trend', className: 'text-orange-400' },
  RANGE_BOUND: { label: 'Range Bound', className: 'text-yellow-400' },
  HIGH_VOLATILITY: { label: 'High Volatility', className: 'text-purple-400' },
  LOW_VOLATILITY: { label: 'Low Volatility', className: 'text-blue-400' },
  BREAKOUT: { label: 'Breakout', className: 'text-cyan-400' },
  BREAKDOWN: { label: 'Breakdown', className: 'text-red-400' },
  EXPIRY_GAMMA: { label: 'Expiry Gamma', className: 'text-amber-400' },
};

function MarketRegimeCard({ bias }: { bias: MarketBias }) {
  const info = REGIME_LABELS[bias.regime] || { label: bias.regime, className: 'text-gray-400' };
  const inputs = bias.inputs as Record<string, number | string | null>;

  const expectedRangeLow = inputs.expectedRangeLow as number | null;
  const expectedRangeHigh = inputs.expectedRangeHigh as number | null;
  const maxPain = inputs.maxPain as number | null;
  const support = inputs.support as number | null;
  const resistance = inputs.resistance as number | null;
  const pcr = inputs.pcr as number | undefined;
  const atmIv = inputs.atmIv as number | undefined;

  return (
    <div className="bg-[#12121a] border border-gray-800/60 rounded-xl shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] p-4">
      <h3 className="text-sm font-semibold text-gray-200 mb-3">Market Regime</h3>
      <div className={`text-lg font-bold ${info.className} mb-2`}>{info.label}</div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-gray-500 mb-1">Expected Range</div>
          <div className="text-gray-300 font-medium tabular-nums">
            {expectedRangeLow != null && expectedRangeHigh != null
              ? `${formatIndianNumber(expectedRangeLow, 0)} — ${formatIndianNumber(expectedRangeHigh, 0)}`
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">Max Pain</div>
          <div className="text-gray-300 font-medium tabular-nums">{maxPain != null ? formatIndianNumber(maxPain, 0) : '—'}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">Support</div>
          <div className="text-emerald-400 font-medium tabular-nums">{support != null ? formatIndianNumber(support, 0) : '—'}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">Resistance</div>
          <div className="text-red-400 font-medium tabular-nums">{resistance != null ? formatIndianNumber(resistance, 0) : '—'}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">PCR</div>
          <div className="text-gray-300 font-medium tabular-nums">{pcr != null ? pcr.toFixed(2) : '—'}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-1">ATM IV</div>
          <div className="text-gray-300 font-medium tabular-nums">{atmIv != null ? `${atmIv.toFixed(1)}%` : '—'}</div>
        </div>
      </div>
    </div>
  );
}

function IntelligenceScoreCard({ score, symbol }: { score: IntelligenceScore; symbol: string }) {
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
    <div className="bg-[#12121a] border border-gray-800/60 rounded-xl shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">Intelligence Score — {symbol}</h3>
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
