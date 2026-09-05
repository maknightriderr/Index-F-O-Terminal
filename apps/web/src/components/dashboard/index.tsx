'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useLiveIndices } from '@/lib/use-live-indices';
import { useAllIndices } from '@/lib/use-all-indices';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { useMarketBias } from '@/lib/use-market-bias';
import { formatIndianNumber, formatPercent, formatCompact, isMarketOpen } from '@fno/shared';
import type { Exchange, BiasDirection, OIInterpretation } from '@fno/shared';
import { OIBadge, BiasBadge, ScoreBadge } from '@/components/common/badges';
import { AddAssetButton } from '@/components/common/add-asset-button';
import { ActivityList } from '@/components/common/activity-list';
import { TopMoversList } from '@/components/common/top-movers-list';
import { Sparkline } from '@/components/common/sparkline';
import { SkeletonTableRow } from '@/components/common/skeleton';
import { ChartPatternsPanel } from '@/components/common/chart-patterns-panel';
import { getPriceHistory } from '@/lib/price-history-store';
import { useChartPatterns } from '@/lib/use-chart-patterns';
import { useFiiDii } from '@/lib/use-fii-dii';
import { useAssetTabsStore, useMarketStore } from '@/stores';

const TOP_MOVERS_COUNT = 5;

type ScreenerFilter =
  | 'ALL'
  | 'TOP_VOLUME'
  | 'LONG_BUILDUP'
  | 'SHORT_BUILDUP'
  | 'SHORT_COVERING'
  | 'LONG_UNWINDING'
  | 'HIGH_IV'
  | 'TOP_SCORE'
  | 'GAINERS'
  | 'LOSERS';

const INDEX_CONFIG: Record<string, { initials: string; gradient: string; accentColor: string; bgGlow: string }> = {
  'NIFTY 50': {
    initials: 'N50',
    gradient: 'from-emerald-400 to-cyan-400',
    accentColor: 'emerald',
    bgGlow: 'rgba(16, 185, 129, 0.15)',
  },
  'NIFTY': {
    initials: 'N50',
    gradient: 'from-emerald-400 to-cyan-400',
    accentColor: 'emerald',
    bgGlow: 'rgba(16, 185, 129, 0.15)',
  },
  'BANK NIFTY': {
    initials: 'BN',
    gradient: 'from-blue-400 to-indigo-400',
    accentColor: 'blue',
    bgGlow: 'rgba(59, 130, 246, 0.15)',
  },
  'BANKNIFTY': {
    initials: 'BN',
    gradient: 'from-blue-400 to-indigo-400',
    accentColor: 'blue',
    bgGlow: 'rgba(59, 130, 246, 0.15)',
  },
  'SENSEX': {
    initials: 'SX',
    gradient: 'from-teal-400 to-emerald-400',
    accentColor: 'teal',
    bgGlow: 'rgba(20, 184, 166, 0.15)',
  },
  'FINNIFTY': {
    initials: 'FN',
    gradient: 'from-purple-400 to-pink-400',
    accentColor: 'purple',
    bgGlow: 'rgba(168, 85, 247, 0.15)',
  },
  'MIDCPNIFTY': {
    initials: 'MC',
    gradient: 'from-amber-400 to-orange-400',
    accentColor: 'orange',
    bgGlow: 'rgba(245, 158, 11, 0.15)',
  },
};

export function Dashboard() {
  const { indices, isLive: indicesLive } = useLiveIndices();
  const { indices: allIndices } = useAllIndices();
  const { rows: fnoRows, isLive: fnoLive, loading: fnoLoading } = useFnoScanner('NSE');
  const { patterns, loading: patternsLoading } = useChartPatterns();
  const { data: fiiDii } = useFiiDii();
  const vixQuote = allIndices.find((i) => i.symbol === 'INDIAVIX') ?? null;
  const setActiveTab = useMarketStore((s) => s.setActiveTab);

  // Screener controls
  const [screenerFilter, setScreenerFilter] = useState<ScreenerFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [displayMode, setDisplayMode] = useState<'top' | 'full'>('top');
  const [matrixTab, setMatrixTab] = useState<'movers' | 'buildup'>('movers');
  const [spotlightSymbol, setSpotlightSymbol] = useState<'NIFTY' | 'BANKNIFTY'>('NIFTY');

  // Spotlight Bias Hook
  const { bias: spotlightBias, score: spotlightScore } = useMarketBias(spotlightSymbol, 'NSE');

  // Market Breadth Calculations
  const breadth = useMemo(() => {
    const advances = fnoRows.filter((r) => r.changePercent > 0).length;
    const declines = fnoRows.filter((r) => r.changePercent < 0).length;
    const unchanged = fnoRows.filter((r) => r.changePercent === 0).length;
    const total = fnoRows.length || 1;
    const advPercent = Math.round((advances / total) * 100);
    const decPercent = Math.round((declines / total) * 100);
    const unchPercent = Math.max(0, 100 - advPercent - decPercent);
    const avgPcr = fnoRows.length
      ? fnoRows.reduce((acc, r) => acc + (r.pcr || 1), 0) / fnoRows.length
      : 1.12;

    return {
      advances,
      declines,
      unchanged,
      total,
      advPercent,
      decPercent,
      unchPercent,
      avgPcr: avgPcr.toFixed(2),
      isBullishBias: advances >= declines,
    };
  }, [fnoRows]);

  // Filtered Screener Rows
  const filteredFnoRows = useMemo(() => {
    let result = [...fnoRows];

    // Filter by query
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toUpperCase();
      result = result.filter((r) => r.symbol.includes(q));
    }

    // Filter by category
    switch (screenerFilter) {
      case 'TOP_VOLUME':
        result.sort((a, b) => b.volume - a.volume);
        break;
      case 'LONG_BUILDUP':
        result = result.filter((r) => r.oiInterpretation === 'LONG_BUILDUP');
        break;
      case 'SHORT_BUILDUP':
        result = result.filter((r) => r.oiInterpretation === 'SHORT_BUILDUP');
        break;
      case 'SHORT_COVERING':
        result = result.filter((r) => r.oiInterpretation === 'SHORT_COVERING');
        break;
      case 'LONG_UNWINDING':
        result = result.filter((r) => r.oiInterpretation === 'LONG_UNWINDING');
        break;
      case 'HIGH_IV':
        result = result.filter((r) => (r.ivRank != null ? r.ivRank >= 50 : r.atmIv >= 25));
        result.sort((a, b) => (b.ivRank ?? b.atmIv) - (a.ivRank ?? a.atmIv));
        break;
      case 'TOP_SCORE':
        result.sort((a, b) => b.score - a.score);
        break;
      case 'GAINERS':
        result = result.filter((r) => r.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent);
        break;
      case 'LOSERS':
        result = result.filter((r) => r.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent);
        break;
      default:
        // Default sort by composite score
        result.sort((a, b) => b.score - a.score);
        break;
    }

    return displayMode === 'top' ? result.slice(0, 8) : result;
  }, [fnoRows, screenerFilter, searchQuery, displayMode]);

  // Top Movers
  const indexGainers = useMemo(
    () => [...allIndices].sort((a, b) => b.changePercent - a.changePercent).slice(0, TOP_MOVERS_COUNT),
    [allIndices]
  );
  const indexLosers = useMemo(
    () => [...allIndices].sort((a, b) => a.changePercent - b.changePercent).slice(0, TOP_MOVERS_COUNT),
    [allIndices]
  );
  const toMoverItem = (r: (typeof fnoRows)[number]) => ({
    symbol: r.symbol,
    exchange: r.exchange,
    ltp: r.price,
    changePercent: r.changePercent,
  });
  const stockGainers = useMemo(
    () => [...fnoRows].sort((a, b) => b.changePercent - a.changePercent).slice(0, TOP_MOVERS_COUNT).map(toMoverItem),
    [fnoRows]
  );
  const stockLosers = useMemo(
    () => [...fnoRows].sort((a, b) => a.changePercent - b.changePercent).slice(0, TOP_MOVERS_COUNT).map(toMoverItem),
    [fnoRows]
  );

  // Outside NSE trading hours, the broker's live feed legitimately has no
  // fresh ticks to serve — quote requests come back empty (not an error),
  // which used to trip the same "broker connection offline" alarm as an
  // actual outage during market hours. That's a false alarm: the session is
  // fine, there's just nothing live to report right now. Distinguish the
  // two so the banner only reads as urgent when it actually is.
  const marketClosed = !isMarketOpen('NSE');

  return (
    <div className="p-4 space-y-4 min-h-full">
      {/* Offline / Mock Notice */}
      {!indicesLive && !fnoLive && (
        <div className={`rounded-xl px-4 py-2.5 text-xs font-medium animate-slide-in backdrop-blur-sm flex items-center justify-between border ${
          marketClosed
            ? 'bg-gray-800/40 light:bg-slate-100 border-gray-700/40 light:border-slate-200 text-gray-400 light:text-slate-500'
            : 'bg-amber-500/10 border-amber-500/20 text-amber-400 light:text-amber-700'
        }`}>
          <div className="flex items-center gap-2">
            <span className="text-sm">{marketClosed ? '🌙' : '⚠️'}</span>
            <span>
              {marketClosed
                ? 'Markets are closed — live feeds resume next session. Showing simulated placeholder data.'
                : 'Live broker connection offline — displaying simulated real-time intelligence feeds.'}
            </span>
          </div>
          <span className={`text-[11px] font-mono ${marketClosed ? 'text-gray-500 light:text-slate-400' : 'text-amber-400/70'}`}>
            {marketClosed ? 'Market Closed' : 'Simulated Market Feeds Active'}
          </span>
        </div>
      )}

      {/* ============================================================
          1. MACRO MARKET TAPE & SENTIMENT RIBBON
          ============================================================ */}
      <div className="card-premium p-3 border border-gray-800/60 light:border-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Market Status & Regime Radar */}
          <div className="flex items-center gap-2.5">
            <div className="relative flex items-center justify-center">
              <span className={`w-2.5 h-2.5 rounded-full ${breadth.isBullishBias ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]' : 'bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.7)]'} radar-ring`} />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-gray-100 light:text-slate-900 tracking-wide">
                  {breadth.isBullishBias ? 'Indian Equities: Bullish Momentum' : 'Indian Equities: Bearish Caution'}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-400 light:text-emerald-700 badge-glass">
                  Risk-On
                </span>
              </div>
              <p className="text-[10px] text-gray-400 light:text-slate-500 mt-0.5">
                Derivatives Sentiment: Nifty PCR {breadth.avgPcr} • Put Writing Floor Active
              </p>
            </div>
          </div>

          {/* Market Breadth Split Bar */}
          <div className="flex items-center gap-3 bg-gray-900/60 light:bg-slate-100 px-3.5 py-1.5 rounded-xl border border-gray-800/50 light:border-slate-200">
            <div className="text-[10px] font-semibold text-gray-400 light:text-slate-500 uppercase tracking-wider">
              Breadth
            </div>
            <div className="w-32 space-y-1">
              <div className="flex justify-between text-[9px] font-bold tabular-nums">
                <span className="text-emerald-400">{breadth.advances} Adv</span>
                <span className="text-red-400">{breadth.declines} Dec</span>
              </div>
              <div className="breadth-split-bar">
                <div className="bg-emerald-400 rounded-l-full bar-animated" style={{ width: `${breadth.advPercent}%` }} />
                <div className="bg-gray-600 bar-animated" style={{ width: `${breadth.unchPercent}%` }} />
                <div className="bg-red-400 rounded-r-full bar-animated" style={{ width: `${breadth.decPercent}%` }} />
              </div>
            </div>
          </div>

          {/* Macro Indicator Chips */}
          <div className="flex items-center gap-2">
            {/* India VIX */}
            <div className="flex items-center gap-1.5 bg-gray-900/40 light:bg-slate-100 px-2.5 py-1 rounded-lg border border-gray-800/40 light:border-slate-200 text-xs">
              <span className="text-[10px] font-medium text-gray-400 light:text-slate-500">INDIA VIX</span>
              <span className="font-bold text-gray-200 light:text-slate-800 tabular-nums">{vixQuote ? vixQuote.ltp.toFixed(2) : '—'}</span>
              {vixQuote && (
                <span className={`text-[10px] font-medium ${vixQuote.changePercent >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {vixQuote.changePercent >= 0 ? '+' : ''}{vixQuote.changePercent.toFixed(2)}%
                </span>
              )}
            </div>

            {/* FII/DII Net Flow — NSE's last-published daily figure (EOD-only, see fii-dii.ts) */}
            <div
              className="hidden lg:flex items-center gap-2 bg-gray-900/40 light:bg-slate-100 px-2.5 py-1 rounded-lg border border-gray-800/40 light:border-slate-200 text-xs"
              title={fiiDii ? `NSE FII/DII cash activity for ${fiiDii.date}` : 'FII/DII data unavailable this poll'}
            >
              <span className="text-[10px] font-medium text-gray-400 light:text-slate-500">FII / DII</span>
              {fiiDii ? (
                <>
                  <span className={`font-bold tabular-nums ${fiiDii.fii.netValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fiiDii.fii.netValue >= 0 ? '+' : ''}₹{fiiDii.fii.netValue.toFixed(0)} Cr
                  </span>
                  <span className="text-gray-600 light:text-slate-400">|</span>
                  <span className={`font-bold tabular-nums ${fiiDii.dii.netValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fiiDii.dii.netValue >= 0 ? '+' : ''}₹{fiiDii.dii.netValue.toFixed(0)} Cr
                  </span>
                </>
              ) : (
                <span className="text-gray-500 light:text-slate-400">—</span>
              )}
            </div>

            <AddAssetButton />
          </div>
        </div>
      </div>

      {/* ============================================================
          2. MAJOR INDICES COMMAND CARDS
          ============================================================ */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
        {indices.map((index, i) => (
          <div key={index.token} className="stagger-item" style={{ '--stagger-index': i } as React.CSSProperties}>
            <IndexCard {...index} />
          </div>
        ))}
      </div>

      {/* ============================================================
          3. MARKET INTELLIGENCE & BIAS SPOTLIGHT (NIFTY & BANKNIFTY)
          ============================================================ */}
      <div className="card-premium p-4 border border-gray-800/60 light:border-slate-200 animate-fade-in">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-gray-800/40 light:border-slate-200">
          <div className="flex items-center gap-2">
            <span className="text-base">🧠</span>
            <div>
              <h2 className="text-sm font-bold text-gray-100 light:text-slate-900">
                Market Intelligence &amp; Regime Spotlight
              </h2>
              <p className="text-[10px] text-gray-400 light:text-slate-500">
                Multi-factor algorithmic signal synthesis across Option Greeks, OI shifts, and structural pivots
              </p>
            </div>
          </div>

          {/* Spotlight Symbol Switcher */}
          <div className="flex items-center gap-1 bg-gray-900/60 light:bg-slate-100 p-1 rounded-xl border border-gray-800/50 light:border-slate-200">
            <button
              onClick={() => setSpotlightSymbol('NIFTY')}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${
                spotlightSymbol === 'NIFTY'
                  ? 'bg-emerald-500/20 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.4)]'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              NIFTY 50
            </button>
            <button
              onClick={() => setSpotlightSymbol('BANKNIFTY')}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${
                spotlightSymbol === 'BANKNIFTY'
                  ? 'bg-blue-500/20 text-blue-400 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.4)]'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              BANK NIFTY
            </button>
          </div>
        </div>

        {/* Intelligence Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* 1. Probabilistic Directional Bias */}
          <div className="bg-gray-900/40 light:bg-slate-50/80 rounded-xl p-3.5 border border-gray-800/40 light:border-slate-200">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-gray-300 light:text-slate-700 uppercase tracking-wider">
                Directional Bias
              </span>
              <BiasBadge bias={spotlightBias.direction} large />
            </div>

            {/* Probability Gauges */}
            <div className="space-y-2 mb-3">
              <ProbGauge label="Bullish" value={spotlightBias.bullishProbability} color="emerald" />
              <ProbGauge label="Neutral" value={spotlightBias.neutralProbability} color="gray" />
              <ProbGauge label="Bearish" value={spotlightBias.bearishProbability} color="red" />
            </div>

            <div className="flex items-center justify-between text-xs pt-2 border-t border-gray-800/40 light:border-slate-200">
              <span className="text-gray-400 light:text-slate-500">Signal Confidence</span>
              <span className="font-bold text-gray-100 light:text-slate-900 tabular-nums">
                {spotlightBias.confidence}% / 100
              </span>
            </div>
          </div>

          {/* 2. Key Technical Pivots & Expiry Range */}
          <div className="bg-gray-900/40 light:bg-slate-50/80 rounded-xl p-3.5 border border-gray-800/40 light:border-slate-200">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-gray-300 light:text-slate-700 uppercase tracking-wider">
                Structural Levels
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-purple-500/15 text-purple-400 light:text-purple-700 badge-glass">
                {spotlightBias.regime.replace(/_/g, ' ')}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-black/20 light:bg-white rounded-lg p-2 border border-gray-800/30 light:border-slate-200">
                <div className="text-[9px] uppercase tracking-wider text-gray-400 light:text-slate-500">Max Pain</div>
                <div className="text-sm font-bold text-gray-100 light:text-slate-900 tabular-nums">
                  {formatIndianNumber((spotlightBias.inputs.maxPain as number) || 24600, 0)}
                </div>
              </div>
              <div className="bg-black/20 light:bg-white rounded-lg p-2 border border-gray-800/30 light:border-slate-200">
                <div className="text-[9px] uppercase tracking-wider text-gray-400 light:text-slate-500">Put Wall (Support)</div>
                <div className="text-sm font-bold text-emerald-400 tabular-nums">
                  {formatIndianNumber((spotlightBias.inputs.support as number) || 24500, 0)}
                </div>
              </div>
              <div className="bg-black/20 light:bg-white rounded-lg p-2 border border-gray-800/30 light:border-slate-200">
                <div className="text-[9px] uppercase tracking-wider text-gray-400 light:text-slate-500">Call Wall (Resistance)</div>
                <div className="text-sm font-bold text-red-400 tabular-nums">
                  {formatIndianNumber((spotlightBias.inputs.resistance as number) || 24800, 0)}
                </div>
              </div>
              <div className="bg-black/20 light:bg-white rounded-lg p-2 border border-gray-800/30 light:border-slate-200">
                <div className="text-[9px] uppercase tracking-wider text-gray-400 light:text-slate-500">Expected Expiry Range</div>
                <div className="text-xs font-bold text-gray-100 light:text-slate-900 tabular-nums">
                  {formatIndianNumber((spotlightBias.inputs.expectedRangeLow as number) || 24420, 0)} — {formatIndianNumber((spotlightBias.inputs.expectedRangeHigh as number) || 24860, 0)}
                </div>
              </div>
            </div>
          </div>

          {/* 3. AI Key Market Drivers & Rationales */}
          <div className="bg-gray-900/40 light:bg-slate-50/80 rounded-xl p-3.5 border border-gray-800/40 light:border-slate-200 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-gray-300 light:text-slate-700 uppercase tracking-wider">
                  Algorithmic Rationale
                </span>
                <ScoreBadge score={spotlightScore.score} />
              </div>
              <div className="space-y-1.5">
                {spotlightBias.reasoning.slice(0, 4).map((r, i) => (
                  <div key={i} className="text-[11px] text-gray-300 light:text-slate-600 flex items-start gap-1.5 leading-tight">
                    <span className="text-cyan-400 font-bold mt-0.5">▸</span>
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={() => useAssetTabsStore.getState().openTab(spotlightSymbol, 'NSE')}
              className="mt-3 w-full py-1.5 px-3 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 light:text-emerald-700 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 border border-emerald-500/20"
            >
              <span>Open Complete {spotlightSymbol} Analytics</span>
              <span>→</span>
            </button>
          </div>
        </div>
      </div>

      {/* ============================================================
          4. PRO F&O DERIVATIVES SCREENER & ACTIVITY TABLE
          ============================================================ */}
      <div className="card-premium card-accent-top animate-fade-in" style={{ '--accent-gradient': 'linear-gradient(90deg, rgba(251, 146, 60, 0.7), rgba(16, 185, 129, 0.5), rgba(6, 182, 212, 0.4))' } as React.CSSProperties}>
        {/* Screener Header & Filter Controls */}
        <div className="p-4 border-b border-gray-800/40 light:border-slate-200 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-gray-100 light:text-slate-900 flex items-center gap-2">
                <span>🔥 F&O Derivatives Universe Scanner</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 light:text-emerald-700 font-semibold">
                  {fnoRows.length} Contracts
                </span>
              </h2>
              <p className="text-[11px] text-gray-400 light:text-slate-500 mt-0.5">
                Real-time Open Interest buildup, ATM Volatility, Put-Call Ratio, and Directional Momentum
              </p>
            </div>

            {/* Search Input & View Toggle */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search contract..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-40 md:w-52 pl-7 pr-3 py-1 text-xs bg-gray-900/60 light:bg-slate-100 border border-gray-800/60 light:border-slate-200 rounded-lg text-gray-200 light:text-slate-800 placeholder-gray-500 focus:outline-none focus:border-emerald-500/50"
                />
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-[11px]">🔍</span>
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* View Toggle */}
              <div className="flex items-center bg-gray-900/60 light:bg-slate-100 p-0.5 rounded-lg border border-gray-800/40 light:border-slate-200">
                <button
                  onClick={() => setDisplayMode('top')}
                  className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                    displayMode === 'top' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-400'
                  }`}
                >
                  Top 8
                </button>
                <button
                  onClick={() => setDisplayMode('full')}
                  className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                    displayMode === 'full' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-400'
                  }`}
                >
                  All ({fnoRows.length})
                </button>
              </div>
            </div>
          </div>

          {/* Category Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-1">
            {[
              { id: 'ALL', label: 'All Contracts' },
              { id: 'TOP_VOLUME', label: '🔥 High Volume' },
              { id: 'LONG_BUILDUP', label: '🟢 Long Buildup' },
              { id: 'SHORT_BUILDUP', label: '🔴 Short Buildup' },
              { id: 'SHORT_COVERING', label: '🟡 Short Covering' },
              { id: 'LONG_UNWINDING', label: '🟠 Long Unwinding' },
              { id: 'HIGH_IV', label: '⚡ High IV (>50%)' },
              { id: 'TOP_SCORE', label: '🎯 High Score (>75)' },
              { id: 'GAINERS', label: '📈 Top Gainers' },
              { id: 'LOSERS', label: '📉 Top Losers' },
            ].map((pill) => (
              <button
                key={pill.id}
                onClick={() => setScreenerFilter(pill.id as ScreenerFilter)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all duration-150 ${
                  screenerFilter === pill.id
                    ? 'bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 text-emerald-300 light:text-emerald-700 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.4)]'
                    : 'bg-gray-900/40 light:bg-slate-100 text-gray-400 light:text-slate-600 hover:text-gray-200 hover:bg-gray-800/50'
                }`}
              >
                {pill.label}
              </button>
            ))}
          </div>
        </div>

        {/* Screener Table */}
        {fnoLoading && filteredFnoRows.length === 0 ? (
          <div className="p-4">
            <table className="w-full text-xs">
              <tbody>
                {Array.from({ length: 8 }, (_, i) => (
                  <SkeletonTableRow key={i} cols={12} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-premium">
              <thead>
                <tr className="bg-gray-900/60 light:bg-slate-50 text-gray-400 light:text-slate-500 uppercase tracking-wider text-[10px]">
                  <th className="text-left px-4 py-3 font-semibold">Stock</th>
                  <th className="text-center px-2 py-3 font-semibold">Trend</th>
                  <th className="text-right px-3 py-3 font-semibold">LTP (₹)</th>
                  <th className="text-right px-3 py-3 font-semibold">Chg %</th>
                  <th className="text-right px-3 py-3 font-semibold">Volume</th>
                  <th className="text-right px-3 py-3 font-semibold">Futures OI</th>
                  <th className="text-right px-3 py-3 font-semibold">OI Chg</th>
                  <th className="text-left px-3 py-3 font-semibold">OI Activity</th>
                  <th className="text-right px-3 py-3 font-semibold">PCR</th>
                  <th className="text-right px-3 py-3 font-semibold">ATM IV</th>
                  <th className="text-right px-3 py-3 font-semibold">IV Rank</th>
                  <th className="text-center px-3 py-3 font-semibold">Bias</th>
                  <th className="text-center px-3 py-3 font-semibold">Score</th>
                  <th className="text-center px-3 py-3 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredFnoRows.map((stock, idx) => {
                  const isPos = stock.changePercent >= 0;
                  const initials = stock.symbol.slice(0, 2);
                  return (
                    <tr
                      key={stock.symbol}
                      onClick={() => useAssetTabsStore.getState().openTab(stock.symbol, stock.exchange)}
                      className="border-t border-gray-800/30 light:border-slate-100 cursor-pointer transition-all hover:bg-gray-800/30 light:hover:bg-slate-50 stagger-item"
                      style={{ '--stagger-index': idx } as React.CSSProperties}
                    >
                      {/* Stock avatar + Symbol */}
                      <td className="px-4 py-2.5 font-medium text-gray-100 light:text-slate-900">
                        <div className="flex items-center gap-2.5">
                          <div
                            className={`ticker-avatar ${
                              isPos
                                ? 'bg-gradient-to-br from-emerald-500/40 to-cyan-500/40 text-emerald-300'
                                : 'bg-gradient-to-br from-red-500/40 to-orange-500/40 text-red-300'
                            }`}
                          >
                            {initials}
                          </div>
                          <div>
                            <div className="font-bold text-xs text-gray-100 light:text-slate-900 flex items-center gap-1.5">
                              <span>{stock.symbol}</span>
                              <span className="text-[9px] px-1 py-0.2 rounded bg-gray-800/80 light:bg-slate-200 text-gray-400 light:text-slate-600 font-mono">
                                {stock.exchange}
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Sparkline Micro-chart */}
                      <td className="text-center px-2 py-2.5">
                        <Sparkline
                          data={getPriceHistory(stock.symbol)}
                          symbol={stock.symbol}
                          width={44}
                          height={16}
                          color={isPos ? '#34d399' : '#f87171'}
                          showArea={true}
                          showEndpointDot={true}
                          strokeWidth={1.2}
                          points={18}
                        />
                      </td>

                      {/* Price */}
                      <td className="text-right px-3 py-2.5 tabular-nums font-bold text-gray-100 light:text-slate-900">
                        {formatIndianNumber(stock.price, 2)}
                      </td>

                      {/* Change % */}
                      <td className="text-right px-3 py-2.5 tabular-nums">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded font-bold text-xs badge-glass ${
                            isPos
                              ? 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700'
                              : 'bg-red-500/15 text-red-400 light:text-red-700'
                          }`}
                        >
                          {isPos ? '▲ +' : '▼ '}{formatPercent(stock.changePercent)}
                        </span>
                      </td>

                      {/* Volume */}
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-600 font-medium">
                        {formatCompact(stock.volume)}
                      </td>

                      {/* Futures OI */}
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-300 light:text-slate-700 font-medium">
                        {formatCompact(stock.futuresOi)}
                      </td>

                      {/* OI Change */}
                      <td
                        className={`text-right px-3 py-2.5 tabular-nums font-bold ${
                          stock.futuresChangeOi >= 0
                            ? 'text-emerald-400 light:text-emerald-700'
                            : 'text-red-400 light:text-red-700'
                        }`}
                      >
                        {stock.futuresChangeOi >= 0 ? '+' : ''}
                        {formatCompact(stock.futuresChangeOi)}
                      </td>

                      {/* OI Interpretation Badge */}
                      <td className="px-3 py-2.5">
                        <OIBadge type={stock.oiInterpretation} />
                      </td>

                      {/* PCR */}
                      <td
                        className={`text-right px-3 py-2.5 tabular-nums font-semibold ${
                          stock.pcr > 1.1
                            ? 'text-emerald-400 light:text-emerald-700'
                            : stock.pcr < 0.8
                            ? 'text-red-400 light:text-red-700'
                            : 'text-gray-400 light:text-slate-500'
                        }`}
                      >
                        {stock.pcr > 0 ? stock.pcr.toFixed(2) : '—'}
                      </td>

                      {/* ATM IV */}
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-300 light:text-slate-700 font-medium">
                        {stock.atmIv > 0 ? `${stock.atmIv.toFixed(1)}%` : '—'}
                      </td>

                      {/* IV Rank */}
                      <td className="text-right px-3 py-2.5">
                        {stock.ivRank != null ? (
                          <IVRankThermometer value={stock.ivRank} />
                        ) : (
                          <span className="text-gray-600 light:text-slate-400">—</span>
                        )}
                      </td>

                      {/* Direction Bias */}
                      <td className="text-center px-3 py-2.5">
                        <BiasBadge bias={stock.direction} />
                      </td>

                      {/* Composite Score */}
                      <td className="text-center px-3 py-2.5">
                        <ScoreBadge score={stock.score} />
                      </td>

                      {/* Action Button */}
                      <td className="text-center px-3 py-2.5">
                        <span className="text-[11px] font-semibold text-emerald-400 light:text-emerald-700 hover:text-emerald-300 hover:underline">
                          View →
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ============================================================
          5. PRO MOVERS & OI BUILDUP MATRIX (SEGMENTED VIEW)
          ============================================================ */}
      <div className="space-y-3">
        {/* Matrix Tab Switcher */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-gray-100 light:text-slate-900">
              {matrixTab === 'movers' ? '📈 Market Momentum Leaders' : '⚡ Open Interest Buildup Matrix'}
            </h2>
          </div>
          <div className="flex items-center bg-gray-900/60 light:bg-slate-100 p-0.5 rounded-lg border border-gray-800/40 light:border-slate-200">
            <button
              onClick={() => setMatrixTab('movers')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                matrixTab === 'movers' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-400'
              }`}
            >
              Top Movers
            </button>
            <button
              onClick={() => setMatrixTab('buildup')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                matrixTab === 'buildup' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-400'
              }`}
            >
              OI Quadrants
            </button>
          </div>
        </div>

        {matrixTab === 'movers' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <TopMoversList title="📈 Top Index Gainers" items={indexGainers} accent="emerald" />
            <TopMoversList title="📉 Top Index Losers" items={indexLosers} accent="red" />
            <TopMoversList title="📈 Top Stock Gainers" items={stockGainers} accent="emerald" />
            <TopMoversList title="📉 Top Stock Losers" items={stockLosers} accent="red" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <ActivityList
              title="🟢 Top Long Buildup (Price ↑ OI ↑)"
              items={fnoRows.filter((s) => s.oiInterpretation === 'LONG_BUILDUP').slice(0, 5)}
              color="emerald"
            />
            <ActivityList
              title="🔴 Top Short Buildup (Price ↓ OI ↑)"
              items={fnoRows.filter((s) => s.oiInterpretation === 'SHORT_BUILDUP').slice(0, 5)}
              color="red"
            />
            <ActivityList
              title="🟡 Top Short Covering (Price ↑ OI ↓)"
              items={fnoRows.filter((s) => s.oiInterpretation === 'SHORT_COVERING').slice(0, 5)}
              color="yellow"
            />
            <ActivityList
              title="🟠 Top Long Unwinding (Price ↓ OI ↓)"
              items={fnoRows.filter((s) => s.oiInterpretation === 'LONG_UNWINDING').slice(0, 5)}
              color="orange"
            />
          </div>
        )}
      </div>

      {/* ============================================================
          6. AI CHART PATTERNS & STRUCTURAL BREAKOUTS
          ============================================================ */}
      <ChartPatternsPanel patterns={patterns} loading={patternsLoading} />
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function IndexCard({ symbol, exchange, ltp, change, changePercent, open, high, low, close }: any) {
  const isPositive = change >= 0;
  const dayRange = high - low;
  const positionInRange = dayRange > 0 ? ((ltp - low) / dayRange) * 100 : 50;
  const openTab = useAssetTabsStore((s) => s.openTab);

  const prevPriceRef = useRef(ltp);
  const [flashClass, setFlashClass] = useState('');

  useEffect(() => {
    if (prevPriceRef.current !== ltp) {
      const direction = ltp > prevPriceRef.current ? 'animate-flash-green' : 'animate-flash-red';
      setFlashClass(direction);
      prevPriceRef.current = ltp;
      const timer = setTimeout(() => setFlashClass(''), 600);
      return () => clearTimeout(timer);
    }
  }, [ltp]);

  const config = INDEX_CONFIG[symbol] || {
    initials: symbol.slice(0, 2),
    gradient: isPositive ? 'from-emerald-400 to-cyan-400' : 'from-red-400 to-orange-400',
    accentColor: isPositive ? 'emerald' : 'red',
    bgGlow: isPositive ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
  };

  return (
    <div
      onClick={() => openTab(symbol, exchange as Exchange)}
      className={`card-premium card-accent-top p-3.5 cursor-pointer group card-hover-glow ${flashClass}`}
      style={
        {
          '--accent-gradient': isPositive
            ? 'linear-gradient(90deg, rgba(16, 185, 129, 0.8), rgba(6, 182, 212, 0.5))'
            : 'linear-gradient(90deg, rgba(239, 68, 68, 0.8), rgba(251, 146, 60, 0.5))',
          '--glow-color': config.bgGlow,
        } as React.CSSProperties
      }
    >
      {/* Top Header Strip */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div
            className={`w-6 h-6 rounded-md bg-gradient-to-br ${config.gradient} flex items-center justify-center text-[10px] font-bold text-black shadow-sm shrink-0`}
          >
            {config.initials}
          </div>
          <div>
            <div className="text-xs font-bold text-gray-200 light:text-slate-800 tracking-wide group-hover:text-emerald-400 transition-colors">
              {symbol}
            </div>
          </div>
        </div>

        <span
          className={`text-xs font-bold px-1.5 py-0.5 rounded-md badge-glass tabular-nums ${
            isPositive
              ? 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700'
              : 'bg-red-500/15 text-red-400 light:text-red-700'
          }`}
        >
          {isPositive ? '▲ +' : '▼ '}{formatPercent(changePercent)}
        </span>
      </div>

      {/* Price & Sparkline */}
      <div className="flex items-end justify-between mb-1 mt-2">
        <div>
          <div
            className={`text-2xl font-bold tabular-nums tracking-tight text-gray-50 light:text-slate-900 ${
              isPositive ? 'text-glow-emerald' : 'text-glow-red'
            }`}
          >
            {formatIndianNumber(ltp, 2)}
          </div>
          <div
            className={`text-[11px] tabular-nums font-semibold mt-0.5 ${
              isPositive ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'
            }`}
          >
            {isPositive ? '+' : ''}{change.toFixed(2)} pts
          </div>
        </div>

        {/* Sparkline Micro-chart */}
        <Sparkline
          data={getPriceHistory(symbol)}
          symbol={symbol}
          width={68}
          height={26}
          color={isPositive ? '#34d399' : '#f87171'}
          showArea={true}
          showEndpointDot={true}
          strokeWidth={1.4}
          points={24}
          className="opacity-90 group-hover:opacity-100 transition-opacity"
        />
      </div>

      {/* Day Range Bar */}
      <div className="space-y-1 mt-3">
        <div className="flex justify-between text-[9px] text-gray-500 light:text-slate-500 tabular-nums font-mono">
          <span>L: {formatIndianNumber(low, 2)}</span>
          <span className="text-gray-400 font-semibold">{positionInRange.toFixed(0)}% Range</span>
          <span>H: {formatIndianNumber(high, 2)}</span>
        </div>
        <div className="relative h-1.5 bg-gray-800/80 light:bg-slate-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full bar-animated ${
              isPositive
                ? 'bg-gradient-to-r from-emerald-600 to-emerald-400'
                : 'bg-gradient-to-r from-red-600 to-red-400'
            }`}
            style={{ width: `${positionInRange}%` }}
          />
          {/* Glowing location pin */}
          <div
            className={`absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full ${
              isPositive
                ? 'bg-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.8)]'
                : 'bg-red-300 shadow-[0_0_8px_rgba(239,68,68,0.8)]'
            } transition-all duration-500`}
            style={{ left: `calc(${positionInRange}% - 4px)` }}
          />
        </div>
      </div>
    </div>
  );
}

function ProbGauge({ label, value, color }: { label: string; value: number; color: 'emerald' | 'gray' | 'red' }) {
  const colorMap = {
    emerald: 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.5)]',
    gray: 'bg-gray-500',
    red: 'bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.5)]',
  };

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold text-gray-400 light:text-slate-500 w-12 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-gray-900/80 light:bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full bar-animated ${colorMap[color]}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs font-bold text-gray-200 light:text-slate-800 tabular-nums w-8 text-right">
        {value}%
      </span>
    </div>
  );
}

function IVRankThermometer({ value }: { value: number }) {
  const colorClass =
    value >= 70
      ? 'bg-gradient-to-r from-orange-500 to-red-500'
      : value >= 40
      ? 'bg-gradient-to-r from-emerald-500 to-yellow-500'
      : 'bg-emerald-500';

  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-12 h-1.5 bg-gray-800/80 light:bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full bar-animated ${colorClass}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] font-bold tabular-nums text-gray-300 light:text-slate-700 w-6 text-right">
        {value}
      </span>
    </div>
  );
}

