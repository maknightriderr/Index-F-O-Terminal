'use client';

import React from 'react';
import { formatIndianNumber } from '@fno/shared';
import type { MarketBias, IntelligenceScore } from '@fno/shared';
import { BiasBadge, ScoreBadge } from '@/components/common/badges';

export function MarketBiasCard({ bias, symbol }: { bias: MarketBias; symbol: string }) {
  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 border-t-cyan-500/50 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] hover:border-gray-700/80 light:hover:border-slate-300 transition-all duration-200 p-4">
      <div className="flex items-center justify-between mb-3.5">
        <h3 className="text-xs font-bold text-gray-300 light:text-slate-700 uppercase tracking-wide">Market Bias <span className="text-gray-500 light:text-slate-500 font-medium normal-case">— {symbol}</span></h3>
        <BiasBadge bias={bias.direction} large />
      </div>
      {/* Probability Bars */}
      <div className="space-y-2 mb-3.5">
        <ProbBar label="Bullish" value={bias.bullishProbability} color="emerald" />
        <ProbBar label="Neutral" value={bias.neutralProbability} color="gray" />
        <ProbBar label="Bearish" value={bias.bearishProbability} color="red" />
      </div>
      <div className="flex items-center justify-between text-xs bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-1.5">
        <span className="text-gray-500 light:text-slate-500">Confidence</span>
        <span className="text-gray-200 light:text-slate-800 font-semibold tabular-nums">{bias.confidence}/100</span>
      </div>
      {/* Reasoning */}
      <div className="mt-3.5 pt-3.5 border-t border-gray-800/60 light:border-slate-200 space-y-2">
        {bias.reasoning.slice(0, 9).map((r, i) => (
          <div key={i} className="text-xs leading-snug text-gray-300 light:text-slate-600 flex items-start gap-2">
            <span className="text-cyan-500/70 mt-0.5 shrink-0">▸</span>
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
  OPERATOR_ACCUMULATION: { label: 'Operator Accumulation', className: 'text-emerald-400', dot: 'bg-emerald-400' },
  OPERATOR_DISTRIBUTION: { label: 'Operator Distribution', className: 'text-red-400', dot: 'bg-red-400' },
};

export function MarketRegimeCard({ bias }: { bias: MarketBias }) {
  const info = REGIME_LABELS[bias.regime] || { label: bias.regime, className: 'text-gray-400 light:text-slate-500', dot: 'bg-gray-400' };
  const inputs = bias.inputs as Record<string, number | string | null>;

  const expectedRangeLow = inputs.expectedRangeLow as number | null;
  const expectedRangeHigh = inputs.expectedRangeHigh as number | null;
  const maxPain = inputs.maxPain as number | null;
  const support = inputs.support as number | null;
  const resistance = inputs.resistance as number | null;
  const pcr = inputs.pcr as number | undefined;
  const atmIv = inputs.atmIv as number | undefined;
  const adx = inputs.adx as number | undefined;

  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 border-t-violet-500/50 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] hover:border-gray-700/80 light:hover:border-slate-300 transition-all duration-200 p-4">
      <h3 className="text-xs font-bold text-gray-300 light:text-slate-700 uppercase tracking-wide mb-3">Market Regime</h3>
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${info.dot} animate-pulse`} />
        <div className={`text-lg font-bold ${info.className}`}>{info.label}</div>
        {adx != null && (
          <span className="text-[10px] text-gray-500 light:text-slate-500 font-medium" title="Regime measures trend STRENGTH (ADX), not directional agreement — this can differ from Market Bias, which counts how many signals agree on direction. ADX >=25 is a strong trend, >=18 weak, below that the regime falls back to a volatility read.">
            ADX {adx.toFixed(1)}
          </span>
        )}
      </div>
      <p className="text-[10px] text-gray-600 light:text-slate-400 mb-3 leading-snug">
        Trend strength — a separate read from Market Bias&apos;s directional agreement. Early-stage trends often show high bias confidence before ADX catches up.
      </p>
      <div className="grid grid-cols-2 gap-2.5 text-xs">
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 light:text-slate-500 mb-1 text-[10px] uppercase tracking-wide">Expected Range</div>
          <div className="text-gray-200 light:text-slate-800 font-semibold tabular-nums">
            {expectedRangeLow != null && expectedRangeHigh != null
              ? `${formatIndianNumber(expectedRangeLow, 0)} — ${formatIndianNumber(expectedRangeHigh, 0)}`
              : '—'}
          </div>
        </div>
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 light:text-slate-500 mb-1 text-[10px] uppercase tracking-wide">Max Pain</div>
          <div className="text-gray-200 light:text-slate-800 font-semibold tabular-nums">{maxPain != null ? formatIndianNumber(maxPain, 0) : '—'}</div>
        </div>
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 light:text-slate-500 mb-1 text-[10px] uppercase tracking-wide">Support</div>
          <div className="text-emerald-400 font-semibold tabular-nums">{support != null ? formatIndianNumber(support, 0) : '—'}</div>
        </div>
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 light:text-slate-500 mb-1 text-[10px] uppercase tracking-wide">Resistance</div>
          <div className="text-red-400 font-semibold tabular-nums">{resistance != null ? formatIndianNumber(resistance, 0) : '—'}</div>
        </div>
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 light:text-slate-500 mb-1 text-[10px] uppercase tracking-wide">PCR</div>
          <div className="text-gray-200 light:text-slate-800 font-semibold tabular-nums">{pcr != null ? pcr.toFixed(2) : '—'}</div>
        </div>
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 light:text-slate-500 mb-1 text-[10px] uppercase tracking-wide">ATM IV</div>
          <div className="text-gray-200 light:text-slate-800 font-semibold tabular-nums">{atmIv != null ? `${atmIv.toFixed(1)}%` : '—'}</div>
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
    { label: 'OI Shifts', value: score.oiShifts },
    { label: 'Volume', value: score.volume },
    { label: 'Rel. Strength', value: score.relativeStrength },
  ];

  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 border-t-amber-500/50 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] hover:border-gray-700/80 light:hover:border-slate-300 transition-all duration-200 p-4">
      <div className="flex items-center justify-between mb-3.5">
        <h3 className="text-xs font-bold text-gray-300 light:text-slate-700 uppercase tracking-wide">Intelligence Score <span className="text-gray-500 light:text-slate-500 font-medium normal-case">— {symbol}</span></h3>
        <ScoreBadge score={score.score} large />
      </div>
      <div className="space-y-2">
        {scoreBreakdown.map(({ label, value }) => {
          const barColor = value >= 70 ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : value >= 40 ? 'bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.4)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.4)]';
          return (
            <div key={label} className="flex items-center gap-2">
              <span className="text-[10px] text-gray-400 light:text-slate-500 w-20 shrink-0">{label}</span>
              <div className="flex-1 h-2 bg-gray-900/70 light:bg-slate-200 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${value}%` }} />
              </div>
              <span className="text-[10px] text-gray-300 light:text-slate-700 font-medium tabular-nums w-6 text-right">{value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Support & Resistance ---
// Two independent methodologies, both already computed server-side but
// previously collapsed down to a single level each in MarketRegimeCard —
// intraday trading wants the fuller ladder, not just "the one strongest
// level," since price often reacts at several nearby zones on the way to
// (or past) the primary one.

interface OiLevelInput {
  strike: number;
  oi: number;
  strengthPct: number;
}

export function SupportResistanceCard({ bias }: { bias: MarketBias }) {
  const inputs = bias.inputs as Record<string, unknown>;
  const spotPrice = inputs.spotPrice as number | null;
  const supportLevels = ((inputs.supportLevels as OiLevelInput[] | undefined) ?? []).slice().sort((a, b) => b.strike - a.strike);
  const resistanceLevels = ((inputs.resistanceLevels as OiLevelInput[] | undefined) ?? []).slice().sort((a, b) => b.strike - a.strike);
  const pivotLevels: Array<{ label: string; value: number | null; kind: 'resistance' | 'pivot' | 'support' }> = [
    { label: 'R3', value: inputs.pivotR3 as number | null, kind: 'resistance' },
    { label: 'R2', value: inputs.pivotR2 as number | null, kind: 'resistance' },
    { label: 'R1', value: inputs.pivotR1 as number | null, kind: 'resistance' },
    { label: 'PP', value: inputs.pivotPP as number | null, kind: 'pivot' },
    { label: 'S1', value: inputs.pivotS1 as number | null, kind: 'support' },
    { label: 'S2', value: inputs.pivotS2 as number | null, kind: 'support' },
    { label: 'S3', value: inputs.pivotS3 as number | null, kind: 'support' },
  ];
  const hasPivots = pivotLevels.some((p) => p.value != null);
  const hasOiLevels = supportLevels.length > 0 || resistanceLevels.length > 0;

  if (!hasOiLevels && !hasPivots) return null;

  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 border-t-amber-500/50 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] hover:border-gray-700/80 light:hover:border-slate-300 transition-all duration-200 p-4">
      <h3 className="text-xs font-bold text-gray-300 light:text-slate-700 uppercase tracking-wide mb-3">Support &amp; Resistance</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {hasOiLevels && (
          <div>
            <div className="text-[10px] text-gray-500 light:text-slate-500 uppercase tracking-wide mb-1.5" title="Top strikes by open interest on each side — OI concentration is where positioning is heaviest, a real trading-activity signal.">
              OI Walls
            </div>
            <div className="space-y-1">
              {resistanceLevels.length > 0 && (
                <>
                  <div className="text-[9px] font-bold text-red-400 uppercase tracking-wide">▲ Resistance</div>
                  {resistanceLevels.map((r, i) => (
                    <OiLevelRow key={`r-${i}`} strike={r.strike} strengthPct={r.strengthPct} color="red" />
                  ))}
                </>
              )}
              {spotPrice != null && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 h-px bg-gray-700 light:bg-slate-300" />
                  <span className="text-[10px] text-gray-400 light:text-slate-500 font-semibold tabular-nums whitespace-nowrap">Spot {formatIndianNumber(spotPrice, 0)}</span>
                  <div className="flex-1 h-px bg-gray-700 light:bg-slate-300" />
                </div>
              )}
              {supportLevels.length > 0 && (
                <>
                  <div className="text-[9px] font-bold text-emerald-400 uppercase tracking-wide">▼ Support</div>
                  {supportLevels.map((s, i) => (
                    <OiLevelRow key={`s-${i}`} strike={s.strike} strengthPct={s.strengthPct} color="emerald" />
                  ))}
                </>
              )}
            </div>
          </div>
        )}
        {hasPivots && (
          <div>
            <div className="text-[10px] text-gray-500 light:text-slate-500 uppercase tracking-wide mb-1.5" title="Classic pivot ladder from the prior session's high/low/close — where price itself has previously reacted, independent of current positioning.">
              Pivot Ladder
            </div>
            <div className="space-y-1">
              {pivotLevels.map((p) => (
                <div key={p.label} className="flex items-center justify-between text-xs bg-gray-900/50 light:bg-slate-100 rounded px-2 py-1">
                  <span
                    className={`text-[10px] font-bold w-6 ${
                      p.kind === 'resistance' ? 'text-red-400' : p.kind === 'support' ? 'text-emerald-400' : 'text-gray-400 light:text-slate-500'
                    }`}
                  >
                    {p.label}
                  </span>
                  <span className="text-gray-200 light:text-slate-800 font-medium tabular-nums">{p.value != null ? formatIndianNumber(p.value, 0) : '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OiLevelRow({ strike, strengthPct, color }: { strike: number; strengthPct: number; color: 'red' | 'emerald' }) {
  const barColor = color === 'red' ? 'bg-red-500' : 'bg-emerald-500';
  const textColor = color === 'red' ? 'text-red-400' : 'text-emerald-400';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`font-semibold tabular-nums w-14 ${textColor}`}>{formatIndianNumber(strike, 0)}</span>
      <div className="flex-1 h-1.5 bg-gray-900/70 light:bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${strengthPct}%` }} />
      </div>
      <span className="text-gray-500 light:text-slate-500 tabular-nums w-8 text-right">{strengthPct}%</span>
    </div>
  );
}

const PROB_BAR_COLORS: Record<string, string> = {
  emerald: 'bg-emerald-500',
  gray: 'bg-gray-500',
  red: 'bg-red-500',
};

function ProbBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-400 light:text-slate-500 w-12 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-gray-900/70 light:bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full bar-animated ${PROB_BAR_COLORS[color] || 'bg-gray-500'}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-gray-200 light:text-slate-800 font-semibold tabular-nums w-8 text-right">{value}%</span>
    </div>
  );
}

