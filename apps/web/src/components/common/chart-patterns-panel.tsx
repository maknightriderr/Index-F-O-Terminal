'use client';

import React from 'react';
import type { DetectedChartPattern, ChartPatternType } from '@fno/shared';
import { useAssetTabsStore } from '@/stores';

const PATTERN_LABELS: Record<ChartPatternType, string> = {
  DOUBLE_TOP: 'Double Top',
  DOUBLE_BOTTOM: 'Double Bottom',
  HEAD_AND_SHOULDERS: 'Head & Shoulders',
  INVERSE_HEAD_AND_SHOULDERS: 'Inverse Head & Shoulders',
  ASCENDING_TRIANGLE: 'Ascending Triangle',
  DESCENDING_TRIANGLE: 'Descending Triangle',
  SYMMETRIC_TRIANGLE: 'Symmetric Triangle',
  RISING_WEDGE: 'Rising Wedge',
  FALLING_WEDGE: 'Falling Wedge',
  BULLISH_FLAG: 'Bullish Flag',
  BEARISH_FLAG: 'Bearish Flag',
};

export function ChartPatternsPanel({ patterns, loading }: { patterns: DetectedChartPattern[]; loading: boolean }) {
  const openTab = useAssetTabsStore((s) => s.openTab);
  const sorted = [...patterns].sort((a, b) => b.confidence - a.confidence);

  return (
    <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)] overflow-hidden animate-fade-in">
      <div className="px-4 py-3 border-b border-gray-800/60 light:border-slate-200">
        <h2 className="text-sm font-bold text-gray-200 light:text-slate-800">
          📐 Chart Patterns <span className="text-gray-500 light:text-slate-500 font-medium">— forming across the Dashboard's indices &amp; top movers</span>
        </h2>
        <p className="text-[11px] text-gray-500 light:text-slate-500 mt-0.5">
          Detected from real swing-point structure on 15m and 1h candles, refreshed roughly every 25 minutes.
        </p>
      </div>
      {loading && patterns.length === 0 ? (
        <div className="p-6 text-xs text-gray-500 light:text-slate-500 text-center">Scanning for patterns…</div>
      ) : sorted.length === 0 ? (
        <div className="p-6 text-xs text-gray-500 light:text-slate-500 text-center">
          No clean chart patterns detected right now across the tracked symbols.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-gray-800/40 light:bg-slate-200">
          {sorted.map((p, idx) => (
            <div
              key={`${p.symbol}-${p.interval}-${p.pattern}-${idx}`}
              onClick={() => openTab(p.symbol, p.exchange)}
              className="bg-[#141420] light:bg-white px-3.5 py-2.5 hover:bg-gray-800/40 light:hover:bg-slate-50 cursor-pointer transition-colors flex items-center gap-2.5"
            >
              <span className={`w-1.5 h-8 rounded-full shrink-0 ${p.direction === 'BULLISH' ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-gray-200 light:text-slate-800 truncate">{p.symbol}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 light:bg-slate-100 text-gray-400 light:text-slate-500 font-medium shrink-0">
                    {p.interval}
                  </span>
                </div>
                <div className="text-[11px] text-gray-500 light:text-slate-500 truncate">{PATTERN_LABELS[p.pattern] ?? p.pattern}</div>
              </div>
              <div className="text-right shrink-0">
                <div className={`text-[10px] font-bold ${p.direction === 'BULLISH' ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
                  {p.direction === 'BULLISH' ? '▲ Bullish' : '▼ Bearish'}
                </div>
                <div className="text-[10px] text-gray-500 light:text-slate-500 tabular-nums">{p.confidence}% conf.</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
