'use client';

import React from 'react';
import { formatIndianNumber } from '@fno/shared';
import type { MarketBias, IntelligenceScore } from '@fno/shared';
import { BiasBadge, ScoreBadge } from '@/components/common/badges';

export function MarketBiasCard({ bias, symbol }: { bias: MarketBias; symbol: string }) {
  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] border border-gray-800/60 border-t-2 border-t-cyan-500/50 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] hover:border-gray-700/80 transition-all duration-200 p-4">
      <div className="flex items-center justify-between mb-3.5">
        <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wide">Market Bias <span className="text-gray-500 font-medium normal-case">— {symbol}</span></h3>
        <BiasBadge bias={bias.direction} large />
      </div>
      {/* Probability Bars */}
      <div className="space-y-2 mb-3.5">
        <ProbBar label="Bullish" value={bias.bullishProbability} color="emerald" />
        <ProbBar label="Neutral" value={bias.neutralProbability} color="gray" />
        <ProbBar label="Bearish" value={bias.bearishProbability} color="red" />
      </div>
      <div className="flex items-center justify-between text-xs bg-gray-900/50 rounded-lg px-2.5 py-1.5">
        <span className="text-gray-500">Confidence</span>
        <span className="text-gray-200 font-semibold tabular-nums">{bias.confidence}/100</span>
      </div>
      {/* Reasoning */}
      <div className="mt-3.5 pt-3.5 border-t border-gray-800/60 space-y-1.5">
        {bias.reasoning.slice(0, 4).map((r, i) => (
          <div key={i} className="text-[10px] text-gray-400 flex items-start gap-1.5">
            <span className="text-cyan-500/70 mt-0.5">▸</span>
            <span>{r}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const REGIME_LABELS: Record<string, { label: string; className: string; dot: string }> = {
  STRONG_BULL_TREND: { label: 'Strong Bull Trend', className: 'text-emerald-400', dot: 'bg-emerald-400' },
  WEAK_BULL_TREND: { label: 'Weak Bull Trend', className: 'text-green-400', dot: 'bg-green-400' },
  STRONG_BEAR_TREND: { label: 'Strong Bear Trend', className: 'text-red-400', dot: 'bg-red-400' },
  WEAK_BEAR_TREND: { label: 'Weak Bear Trend', className: 'text-orange-400', dot: 'bg-orange-400' },
  RANGE_BOUND: { label: 'Range Bound', className: 'text-yellow-400', dot: 'bg-yellow-400' },
  HIGH_VOLATILITY: { label: 'High Volatility', className: 'text-purple-400', dot: 'bg-purple-400' },
  LOW_VOLATILITY: { label: 'Low Volatility', className: 'text-blue-400', dot: 'bg-blue-400' },
  BREAKOUT: { label: 'Breakout', className: 'text-cyan-400', dot: 'bg-cyan-400' },
  BREAKDOWN: { label: 'Breakdown', className: 'text-red-400', dot: 'bg-red-400' },
  EXPIRY_GAMMA: { label: 'Expiry Gamma', className: 'text-amber-400', dot: 'bg-amber-400' },
};

export function MarketRegimeCard({ bias }: { bias: MarketBias }) {
  const info = REGIME_LABELS[bias.regime] || { label: bias.regime, className: 'text-gray-400', dot: 'bg-gray-400' };
  const inputs = bias.inputs as Record<string, number | string | null>;

  const expectedRangeLow = inputs.expectedRangeLow as number | null;
  const expectedRangeHigh = inputs.expectedRangeHigh as number | null;
  const maxPain = inputs.maxPain as number | null;
  const support = inputs.support as number | null;
  const resistance = inputs.resistance as number | null;
  const pcr = inputs.pcr as number | undefined;
  const atmIv = inputs.atmIv as number | undefined;

  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] border border-gray-800/60 border-t-2 border-t-violet-500/50 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] hover:border-gray-700/80 transition-all duration-200 p-4">
      <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wide mb-3">Market Regime</h3>
      <div className="flex items-center gap-2 mb-4">
        <span className={`w-2 h-2 rounded-full ${info.dot} animate-pulse`} />
        <div className={`text-lg font-bold ${info.className}`}>{info.label}</div>
      </div>
      <div className="grid grid-cols-2 gap-2.5 text-xs">
        <div className="bg-gray-900/50 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 mb-1 text-[10px] uppercase tracking-wide">Expected Range</div>
          <div className="text-gray-200 font-semibold tabular-nums">
            {expectedRangeLow != null && expectedRangeHigh != null
              ? `${formatIndianNumber(expectedRangeLow, 0)} — ${formatIndianNumber(expectedRangeHigh, 0)}`
              : '—'}
          </div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 mb-1 text-[10px] uppercase tracking-wide">Max Pain</div>
          <div className="text-gray-200 font-semibold tabular-nums">{maxPain != null ? formatIndianNumber(maxPain, 0) : '—'}</div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 mb-1 text-[10px] uppercase tracking-wide">Support</div>
          <div className="text-emerald-400 font-semibold tabular-nums">{support != null ? formatIndianNumber(support, 0) : '—'}</div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 mb-1 text-[10px] uppercase tracking-wide">Resistance</div>
          <div className="text-red-400 font-semibold tabular-nums">{resistance != null ? formatIndianNumber(resistance, 0) : '—'}</div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 mb-1 text-[10px] uppercase tracking-wide">PCR</div>
          <div className="text-gray-200 font-semibold tabular-nums">{pcr != null ? pcr.toFixed(2) : '—'}</div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 mb-1 text-[10px] uppercase tracking-wide">ATM IV</div>
          <div className="text-gray-200 font-semibold tabular-nums">{atmIv != null ? `${atmIv.toFixed(1)}%` : '—'}</div>
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
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] border border-gray-800/60 border-t-2 border-t-amber-500/50 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] hover:border-gray-700/80 transition-all duration-200 p-4">
      <div className="flex items-center justify-between mb-3.5">
        <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wide">Intelligence Score <span className="text-gray-500 font-medium normal-case">— {symbol}</span></h3>
        <ScoreBadge score={score.score} large />
      </div>
      <div className="space-y-2">
        {scoreBreakdown.map(({ label, value }) => {
          const barColor = value >= 70 ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : value >= 40 ? 'bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.4)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.4)]';
          return (
            <div key={label} className="flex items-center gap-2">
              <span className="text-[10px] text-gray-400 w-20 shrink-0">{label}</span>
              <div className="flex-1 h-2 bg-gray-900/70 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${value}%` }} />
              </div>
              <span className="text-[10px] text-gray-300 font-medium tabular-nums w-6 text-right">{value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProbBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-400 w-12 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-gray-900/70 rounded-full overflow-hidden">
        <div className={`h-full rounded-full bg-${color}-500 transition-all`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-gray-200 font-semibold tabular-nums w-8 text-right">{value}%</span>
    </div>
  );
}
