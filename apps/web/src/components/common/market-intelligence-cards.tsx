'use client';

import React from 'react';
import { formatIndianNumber } from '@fno/shared';
import type { MarketBias, IntelligenceScore } from '@fno/shared';
import { BiasBadge, ScoreBadge } from '@/components/common/badges';

export function MarketBiasCard({ bias, symbol }: { bias: MarketBias; symbol: string }) {
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

export function MarketRegimeCard({ bias }: { bias: MarketBias }) {
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

export function IntelligenceScoreCard({ score, symbol }: { score: IntelligenceScore; symbol: string }) {
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

function ProbBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-500 w-12 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full bg-${color}-500`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-gray-300 font-medium tabular-nums w-8 text-right">{value}%</span>
    </div>
  );
}
