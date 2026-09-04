'use client';

import React, { useState, useMemo } from 'react';
import type { DetectedChartPattern, ChartPatternType } from '@fno/shared';
import { useAssetTabsStore } from '@/stores';

const PATTERN_LABELS: Record<ChartPatternType, string> = {
  DOUBLE_TOP: 'Double Top Reversal',
  DOUBLE_BOTTOM: 'Double Bottom Reversal',
  HEAD_AND_SHOULDERS: 'Head & Shoulders Top',
  INVERSE_HEAD_AND_SHOULDERS: 'Inverse Head & Shoulders',
  ASCENDING_TRIANGLE: 'Ascending Triangle Breakout',
  DESCENDING_TRIANGLE: 'Descending Triangle Breakdown',
  SYMMETRIC_TRIANGLE: 'Symmetric Triangle Coil',
  RISING_WEDGE: 'Rising Wedge Exhaustion',
  FALLING_WEDGE: 'Falling Wedge Reversal',
  ASCENDING_CHANNEL: 'Ascending Channel',
  DESCENDING_CHANNEL: 'Descending Channel',
  HORIZONTAL_CHANNEL: 'Horizontal Channel (Range)',
  BULLISH_FLAG: 'Bullish Flag Continuation',
  BEARISH_FLAG: 'Bearish Flag Continuation',
};

const PATTERN_ICONS: Partial<Record<ChartPatternType, string>> = {
  DOUBLE_TOP: '〽️',
  DOUBLE_BOTTOM: '⚡',
  HEAD_AND_SHOULDERS: '👤',
  INVERSE_HEAD_AND_SHOULDERS: '🚀',
  ASCENDING_TRIANGLE: '📐',
  DESCENDING_TRIANGLE: '📉',
  SYMMETRIC_TRIANGLE: '⚖️',
  RISING_WEDGE: '↗️',
  FALLING_WEDGE: '↘️',
  ASCENDING_CHANNEL: '📈',
  DESCENDING_CHANNEL: '📉',
  HORIZONTAL_CHANNEL: '↔️',
  BULLISH_FLAG: '🚩',
  BEARISH_FLAG: '🏴',
};

export function ChartPatternsPanel({ patterns, loading }: { patterns: DetectedChartPattern[]; loading: boolean }) {
  const openTab = useAssetTabsStore((s) => s.openTab);
  const [filter, setFilter] = useState<'ALL' | 'BULLISH' | 'BEARISH'>('ALL');

  const filtered = useMemo(() => {
    let list = [...patterns];
    if (filter !== 'ALL') {
      list = list.filter((p) => p.direction === filter);
    }
    return list.sort((a, b) => b.confidence - a.confidence);
  }, [patterns, filter]);

  return (
    <div className="card-premium card-accent-top animate-fade-in" style={{ '--accent-gradient': 'linear-gradient(90deg, rgba(168, 85, 247, 0.7), rgba(59, 130, 246, 0.4), rgba(16, 185, 129, 0.3))' } as React.CSSProperties}>
      <div className="px-4 py-3 border-b border-gray-800/40 light:border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base">📐</span>
            <h2 className="text-sm font-bold text-gray-100 light:text-slate-900">
              AI Structural Chart Patterns &amp; Breakouts
            </h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 light:text-purple-700 font-semibold">
              {filtered.length} Formations
            </span>
          </div>
          <p className="text-[10px] text-gray-400 light:text-slate-500 mt-0.5">
            Algorithmic swing-pivot geometry detected across 15m &amp; 1h candle structures
          </p>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center bg-gray-900/60 light:bg-slate-100 p-0.5 rounded-lg border border-gray-800/40 light:border-slate-200">
          <button
            onClick={() => setFilter('ALL')}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
              filter === 'ALL' ? 'bg-purple-500/20 text-purple-400' : 'text-gray-400'
            }`}
          >
            All ({patterns.length})
          </button>
          <button
            onClick={() => setFilter('BULLISH')}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
              filter === 'BULLISH' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-400'
            }`}
          >
            ▲ Bullish
          </button>
          <button
            onClick={() => setFilter('BEARISH')}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
              filter === 'BEARISH' ? 'bg-red-500/20 text-red-400' : 'text-gray-400'
            }`}
          >
            ▼ Bearish
          </button>
        </div>
      </div>

      {loading && patterns.length === 0 ? (
        <div className="p-8 text-xs text-gray-400 light:text-slate-500 text-center font-medium animate-pulse">
          Scanning chart geometry across tracked contracts…
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-8 text-xs text-gray-500 light:text-slate-400 text-center font-medium">
          No clean chart patterns detected matching the filter right now.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-gray-800/30 light:bg-slate-200">
          {filtered.map((p, idx) => {
            const isBull = p.direction === 'BULLISH';
            const icon = PATTERN_ICONS[p.pattern] || (isBull ? '📈' : '📉');
            return (
              <div
                key={`${p.symbol}-${p.interval}-${p.pattern}-${idx}`}
                onClick={() => openTab(p.symbol, p.exchange)}
                className="bg-[#12121c] light:bg-white px-4 py-3 hover:bg-gray-800/40 light:hover:bg-slate-50 cursor-pointer transition-colors flex items-center gap-3 group"
              >
                {/* Direction bar */}
                <div
                  className={`w-1 h-10 rounded-full shrink-0 ${
                    isBull
                      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]'
                      : 'bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.7)]'
                  }`}
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-sm">{icon}</span>
                    <span className="text-xs font-bold text-gray-100 light:text-slate-900 truncate group-hover:text-purple-400 transition-colors">
                      {p.symbol}
                    </span>
                    <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-gray-800 light:bg-slate-100 text-gray-400 light:text-slate-600 shrink-0 font-mono">
                      {p.interval}
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-400 light:text-slate-500 font-medium truncate">
                    {PATTERN_LABELS[p.pattern] ?? p.pattern}
                  </div>
                </div>

                <div className="text-right shrink-0 space-y-1">
                  <div
                    className={`text-[11px] font-bold ${
                      isBull ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'
                    }`}
                  >
                    {isBull ? '▲ Bullish' : '▼ Bearish'}
                  </div>

                  {/* Confidence progress pill */}
                  <div className="flex items-center gap-1 justify-end">
                    <div className="w-12 h-1.5 bg-gray-800/80 light:bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full bar-animated ${
                          isBull ? 'bg-emerald-400' : 'bg-red-400'
                        }`}
                        style={{ width: `${p.confidence}%` }}
                      />
                    </div>
                    <span className="text-[9px] font-bold text-gray-400 light:text-slate-500 tabular-nums">
                      {p.confidence}%
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

