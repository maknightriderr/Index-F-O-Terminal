'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useLiveIndices } from '@/lib/use-live-indices';
import { useAllIndices } from '@/lib/use-all-indices';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { useMarketBias } from '@/lib/use-market-bias';
import { useInstitutionalFlow } from '@/lib/use-institutional-flow';
import { useFiiDii } from '@/lib/use-fii-dii';
import { useFiiDiiHistory } from '@/lib/use-fii-dii-history';
import { useOptionChainSummary } from '@/lib/use-option-chain-summary';
import { formatIndianNumber, formatPercent, formatCompact, isMarketOpen, TRADING_HOURS } from '@fno/shared';
import type { Exchange, FnoScannerRow } from '@fno/shared';
import { OIBadge, BiasBadge, ScoreBadge } from '@/components/common/badges';
import { AddAssetButton } from '@/components/common/add-asset-button';
import { Sparkline } from '@/components/common/sparkline';
import { SkeletonTableRow } from '@/components/common/skeleton';
import { ChartPatternsPanel } from '@/components/common/chart-patterns-panel';
import { getPriceHistory } from '@/lib/price-history-store';
import { useChartPatterns } from '@/lib/use-chart-patterns';
import { useAssetTabsStore, useMarketStore } from '@/stores';
import { InstrumentChart } from './instrument-chart';
import { WatchlistPanel } from './watchlist-panel';

const TOP_MOVERS_COUNT = 8;

interface InstrumentOption {
  symbol: string;
  exchange: Exchange;
  label: string;
  /** MCX commodities (CRUDEOIL, GOLD) have no cash/spot instrument at all — futures/options only. */
  hasSpot: boolean;
}

const INSTRUMENTS: InstrumentOption[] = [
  { symbol: 'NIFTY', exchange: 'NSE', label: 'NIFTY', hasSpot: true },
  { symbol: 'BANKNIFTY', exchange: 'NSE', label: 'BANK NIFTY', hasSpot: true },
  { symbol: 'FINNIFTY', exchange: 'NSE', label: 'FIN NIFTY', hasSpot: true },
  { symbol: 'SENSEX', exchange: 'BSE', label: 'SENSEX', hasSpot: true },
  { symbol: 'CRUDEOIL', exchange: 'MCX', label: 'CRUDEOIL', hasSpot: false },
  { symbol: 'GOLD', exchange: 'MCX', label: 'GOLD', hasSpot: false },
];

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

type MoversTab = 'GAINERS' | 'LOSERS' | 'VOLUME' | 'OI' | 'LONG_BUILDUP' | 'SHORT_COVERING';

const INDEX_CONFIG: Record<string, { initials: string; gradient: string; accentColor: string; bgGlow: string }> = {
  'NIFTY 50': { initials: 'N50', gradient: 'from-emerald-400 to-cyan-400', accentColor: 'emerald', bgGlow: 'rgba(16, 185, 129, 0.15)' },
  'NIFTY': { initials: 'N50', gradient: 'from-emerald-400 to-cyan-400', accentColor: 'emerald', bgGlow: 'rgba(16, 185, 129, 0.15)' },
  'BANK NIFTY': { initials: 'BN', gradient: 'from-blue-400 to-indigo-400', accentColor: 'blue', bgGlow: 'rgba(59, 130, 246, 0.15)' },
  'BANKNIFTY': { initials: 'BN', gradient: 'from-blue-400 to-indigo-400', accentColor: 'blue', bgGlow: 'rgba(59, 130, 246, 0.15)' },
  'INDIAVIX': { initials: 'VIX', gradient: 'from-purple-400 to-fuchsia-400', accentColor: 'purple', bgGlow: 'rgba(168, 85, 247, 0.15)' },
  'SENSEX': { initials: 'SX', gradient: 'from-teal-400 to-emerald-400', accentColor: 'teal', bgGlow: 'rgba(20, 184, 166, 0.15)' },
  'FINNIFTY': { initials: 'FN', gradient: 'from-purple-400 to-pink-400', accentColor: 'purple', bgGlow: 'rgba(168, 85, 247, 0.15)' },
  'MIDCPNIFTY': { initials: 'MC', gradient: 'from-amber-400 to-orange-400', accentColor: 'orange', bgGlow: 'rgba(245, 158, 11, 0.15)' },
};

export function Dashboard() {
  const { indices, isLive: indicesLive } = useLiveIndices();
  const { indices: allIndices } = useAllIndices();
  const { rows: fnoRows, isLive: fnoLive, loading: fnoLoading } = useFnoScanner('NSE');
  const { patterns, loading: patternsLoading } = useChartPatterns();
  const { data: fiiDii } = useFiiDii();
  const { data: fiiDiiHistory } = useFiiDiiHistory(20);
  const { snapshot: sentiment } = useInstitutionalFlow();
  const vixQuote = allIndices.find((i) => i.symbol === 'INDIAVIX') ?? null;
  const niftyQuote = indices.find((i) => i.symbol === 'NIFTY') ?? indices[0] ?? null;
  const bankNiftyQuote = indices.find((i) => i.symbol === 'BANKNIFTY') ?? indices[1] ?? null;

  // Instrument & Expiry context — the chart, intelligence panel, and
  // Options Intelligence all follow whichever instrument is selected here.
  // FII/DII, Top Movers, and the Watchlist stay market-wide/NSE-universe
  // scoped regardless, since there's no per-instrument data for those.
  const [instrumentIdx, setInstrumentIdx] = useState(0);
  const instrument = INSTRUMENTS[instrumentIdx];
  const [selectedExpiry, setSelectedExpiry] = useState<string | undefined>(undefined);
  useEffect(() => {
    setSelectedExpiry(undefined); // reset to nearest expiry whenever the instrument changes
  }, [instrument.symbol]);

  const { data: optionSummary, availableExpiries, currentExpiry } = useOptionChainSummary(instrument.symbol, instrument.exchange, selectedExpiry);

  // Screener controls
  const [screenerFilter, setScreenerFilter] = useState<ScreenerFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [displayMode, setDisplayMode] = useState<'top' | 'full'>('top');
  const [moversTab, setMoversTab] = useState<MoversTab>('GAINERS');

  // Selected instrument's bias — drives both the chart's header stats and the intelligence panel
  const { bias, score } = useMarketBias(instrument.symbol, instrument.exchange);
  const instrumentQuote = allIndices.find((i) => i.symbol === instrument.symbol) ?? null;
  const instrumentPrice = instrumentQuote?.ltp ?? (bias.inputs.spotPrice as number | undefined) ?? null;
  const supportLevels = (bias.inputs.supportLevels as Array<{ strike: number; strengthPct: number }> | undefined) ?? [];
  const resistanceLevels = (bias.inputs.resistanceLevels as Array<{ strike: number; strengthPct: number }> | undefined) ?? [];

  // Market Breadth Calculations
  const breadth = useMemo(() => {
    const advances = fnoRows.filter((r) => r.changePercent > 0).length;
    const declines = fnoRows.filter((r) => r.changePercent < 0).length;
    const unchanged = fnoRows.filter((r) => r.changePercent === 0).length;
    const total = fnoRows.length || 1;
    const advPercent = Math.round((advances / total) * 100);
    const decPercent = Math.round((declines / total) * 100);
    const unchPercent = Math.max(0, 100 - advPercent - decPercent);
    const avgPcr = fnoRows.length ? fnoRows.reduce((acc, r) => acc + (r.pcr || 1), 0) / fnoRows.length : 1.12;
    const avgSpread = fnoRows.length
      ? fnoRows.filter((r) => r.atmSpreadPct != null).reduce((acc, r) => acc + (r.atmSpreadPct ?? 0), 0) /
        Math.max(1, fnoRows.filter((r) => r.atmSpreadPct != null).length)
      : null;

    return { advances, declines, unchanged, total, advPercent, decPercent, unchPercent, avgPcr: avgPcr.toFixed(2), avgSpread, isBullishBias: advances >= declines };
  }, [fnoRows]);

  // Filtered Screener Rows
  const filteredFnoRows = useMemo(() => {
    let result = [...fnoRows];
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toUpperCase();
      result = result.filter((r) => r.symbol.includes(q));
    }
    switch (screenerFilter) {
      case 'TOP_VOLUME': result.sort((a, b) => b.volume - a.volume); break;
      case 'LONG_BUILDUP': result = result.filter((r) => r.oiInterpretation === 'LONG_BUILDUP'); break;
      case 'SHORT_BUILDUP': result = result.filter((r) => r.oiInterpretation === 'SHORT_BUILDUP'); break;
      case 'SHORT_COVERING': result = result.filter((r) => r.oiInterpretation === 'SHORT_COVERING'); break;
      case 'LONG_UNWINDING': result = result.filter((r) => r.oiInterpretation === 'LONG_UNWINDING'); break;
      case 'HIGH_IV':
        result = result.filter((r) => (r.ivRank != null ? r.ivRank >= 50 : r.atmIv >= 25));
        result.sort((a, b) => (b.ivRank ?? b.atmIv) - (a.ivRank ?? a.atmIv));
        break;
      case 'TOP_SCORE': result.sort((a, b) => b.score - a.score); break;
      case 'GAINERS': result = result.filter((r) => r.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent); break;
      case 'LOSERS': result = result.filter((r) => r.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent); break;
      default: result.sort((a, b) => b.score - a.score); break;
    }
    return displayMode === 'top' ? result.slice(0, 8) : result;
  }, [fnoRows, screenerFilter, searchQuery, displayMode]);

  // Top Movers — single tabbed table over the F&O universe
  const moversRows = useMemo(() => {
    let rows = [...fnoRows];
    switch (moversTab) {
      case 'GAINERS': rows = rows.filter((r) => r.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent); break;
      case 'LOSERS': rows = rows.filter((r) => r.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent); break;
      case 'VOLUME': rows.sort((a, b) => b.volume - a.volume); break;
      case 'OI': rows.sort((a, b) => Math.abs(b.futuresChangeOi) - Math.abs(a.futuresChangeOi)); break;
      case 'LONG_BUILDUP': rows = rows.filter((r) => r.oiInterpretation === 'LONG_BUILDUP').sort((a, b) => b.futuresChangeOi - a.futuresChangeOi); break;
      case 'SHORT_COVERING': rows = rows.filter((r) => r.oiInterpretation === 'SHORT_COVERING').sort((a, b) => b.futuresChangeOi - a.futuresChangeOi); break;
    }
    return rows.slice(0, TOP_MOVERS_COUNT);
  }, [fnoRows, moversTab]);

  // Outside NSE trading hours, the broker's live feed legitimately has no
  // fresh ticks to serve — quote requests come back empty (not an error),
  // which used to trip the same "broker connection offline" alarm as an
  // actual outage during market hours. Distinguish the two.
  const marketOpen = isMarketOpen('NSE');
  const marketClosed = !marketOpen;

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
          MARKET TAPE — slim overview strip (detail lives in the KPI
          cards and sections below, so this stays intentionally light)
          ============================================================ */}
      <div className="card-premium p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className={`w-2.5 h-2.5 rounded-full ${breadth.isBullishBias ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]' : 'bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.7)]'} radar-ring`} />
            <span className="text-xs font-bold text-gray-100 light:text-slate-900 tracking-wide">
              {breadth.isBullishBias ? 'Indian Equities: Bullish Momentum' : 'Indian Equities: Bearish Caution'}
            </span>
          </div>
          <div className="flex items-center gap-3 bg-gray-900/60 light:bg-slate-100 px-3.5 py-1.5 rounded-xl border border-gray-800/50 light:border-slate-200">
            <div className="text-[10px] font-semibold text-gray-400 light:text-slate-500 uppercase tracking-wider">Breadth</div>
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
          <AddAssetButton />
        </div>
      </div>

      {/* ============================================================
          HERO KPI STRIP — Market Status, NIFTY, BANK NIFTY, VIX, Sentiment
          ============================================================ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        <div className="stagger-item" style={{ '--stagger-index': 0 } as React.CSSProperties}>
          <MarketStatusCard open={marketOpen} />
        </div>
        {niftyQuote && (
          <div className="stagger-item" style={{ '--stagger-index': 1 } as React.CSSProperties}>
            <IndexCard {...niftyQuote} />
          </div>
        )}
        {bankNiftyQuote && (
          <div className="stagger-item" style={{ '--stagger-index': 2 } as React.CSSProperties}>
            <IndexCard {...bankNiftyQuote} />
          </div>
        )}
        {vixQuote && (
          <div className="stagger-item" style={{ '--stagger-index': 3 } as React.CSSProperties}>
            <IndexCard {...vixQuote} />
          </div>
        )}
        <div className="stagger-item" style={{ '--stagger-index': 4 } as React.CSSProperties}>
          <SentimentCard score={sentiment?.sentimentScore ?? null} label={sentiment?.sentimentLabel ?? null} />
        </div>
      </div>

      {/* ============================================================
          MARKET INTELLIGENCE — instrument-switchable chart + panel
          ============================================================ */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 card-premium p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <h2 className="text-sm font-bold text-gray-100 light:text-slate-900">{instrument.label} Market Intelligence</h2>
              <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-400 light:text-slate-500">
                <span className="tabular-nums font-semibold text-gray-200 light:text-slate-800">
                  {instrumentPrice != null ? formatIndianNumber(instrumentPrice, 2) : '—'}
                </span>
                {instrumentQuote && (
                  <span className={`font-semibold tabular-nums ${instrumentQuote.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {instrumentQuote.change >= 0 ? '+' : ''}{instrumentQuote.change.toFixed(2)} ({formatPercent(instrumentQuote.changePercent)})
                  </span>
                )}
                <span className="tabular-nums">Vol {instrumentQuote ? formatCompact(instrumentQuote.volume) : '—'}</span>
                <span className="tabular-nums">VWAP {bias.inputs.vwap != null ? formatIndianNumber(bias.inputs.vwap as number, 0) : '—'}</span>
                <span className="text-emerald-400 tabular-nums">Support {bias.inputs.support != null ? formatIndianNumber(bias.inputs.support as number, 0) : '—'}</span>
                <span className="text-red-400 tabular-nums">Resistance {bias.inputs.resistance != null ? formatIndianNumber(bias.inputs.resistance as number, 0) : '—'}</span>
                <span className="px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-500 light:text-indigo-700 font-semibold">{bias.regime.replace(/_/g, ' ')}</span>
              </div>
            </div>

            {/* Instrument Switcher */}
            <div className="flex items-center gap-1 bg-gray-900/60 light:bg-slate-100 p-0.5 rounded-lg border border-gray-800/40 light:border-slate-200 overflow-x-auto scrollbar-none">
              {INSTRUMENTS.map((inst, i) => (
                <button
                  key={inst.symbol}
                  onClick={() => setInstrumentIdx(i)}
                  className={`px-2.5 py-1 text-[11px] font-semibold rounded-md whitespace-nowrap transition-colors ${
                    instrumentIdx === i ? 'bg-indigo-500/20 text-indigo-500 light:text-indigo-700' : 'text-gray-400 light:text-slate-500'
                  }`}
                >
                  {inst.label}
                </button>
              ))}
            </div>
          </div>
          <InstrumentChart
            symbol={instrument.symbol}
            exchange={instrument.exchange}
            hasSpot={instrument.hasSpot}
            supportLevels={supportLevels}
            resistanceLevels={resistanceLevels}
          />
        </div>

        <MarketIntelligencePanel bias={bias} score={score} sentiment={sentiment} fiiDii={fiiDii} breadth={breadth} />
      </div>

      {/* ============================================================
          FII / DII ANALYTICS
          ============================================================ */}
      <FiiDiiAnalytics today={fiiDii} history={fiiDiiHistory} />

      {/* ============================================================
          OPTIONS INTELLIGENCE
          ============================================================ */}
      <OptionsIntelligence
        label={instrument.label}
        summary={optionSummary}
        availableExpiries={availableExpiries}
        currentExpiry={currentExpiry}
        onExpiryChange={setSelectedExpiry}
      />

      {/* ============================================================
          TOP MOVERS
          ============================================================ */}
      <div className="card-premium overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800/40 light:border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-gray-100 light:text-slate-900">Top Movers</h2>
          <div className="flex items-center gap-1 bg-gray-900/60 light:bg-slate-100 p-0.5 rounded-lg border border-gray-800/40 light:border-slate-200 overflow-x-auto scrollbar-none">
            {([
              { id: 'GAINERS', label: 'Gainers' },
              { id: 'LOSERS', label: 'Losers' },
              { id: 'VOLUME', label: 'Volume' },
              { id: 'OI', label: 'OI' },
              { id: 'LONG_BUILDUP', label: 'Long Buildup' },
              { id: 'SHORT_COVERING', label: 'Short Covering' },
            ] as Array<{ id: MoversTab; label: string }>).map((t) => (
              <button
                key={t.id}
                onClick={() => setMoversTab(t.id)}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-md whitespace-nowrap transition-colors ${
                  moversTab === t.id ? 'bg-indigo-500/15 text-indigo-500 light:text-indigo-700' : 'text-gray-400 light:text-slate-500'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs table-premium">
            <thead>
              <tr className="bg-gray-900/60 light:bg-slate-50 text-gray-400 light:text-slate-500 uppercase tracking-wider text-[10px]">
                <th className="text-left px-4 py-2.5 font-semibold">Stock</th>
                <th className="text-right px-3 py-2.5 font-semibold">Price</th>
                <th className="text-right px-3 py-2.5 font-semibold">Change</th>
                <th className="text-right px-3 py-2.5 font-semibold">Volume</th>
                <th className="text-right px-3 py-2.5 font-semibold">OI Change</th>
                <th className="text-center px-3 py-2.5 font-semibold">Trend</th>
              </tr>
            </thead>
            <tbody>
              {moversRows.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-6 text-gray-500 light:text-slate-400">No stocks match this filter right now.</td></tr>
              ) : (
                moversRows.map((r) => {
                  const isPos = r.changePercent >= 0;
                  return (
                    <tr
                      key={r.symbol}
                      onClick={() => useAssetTabsStore.getState().openTab(r.symbol, r.exchange)}
                      className="border-t border-gray-800/30 light:border-slate-100 cursor-pointer hover:bg-gray-800/30 light:hover:bg-slate-50 transition-colors"
                    >
                      <td className="px-4 py-2.5 font-bold text-gray-100 light:text-slate-900">{r.symbol}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums font-semibold text-gray-100 light:text-slate-900">{formatIndianNumber(r.price, 2)}</td>
                      <td className={`text-right px-3 py-2.5 tabular-nums font-bold ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
                        {isPos ? '▲ +' : '▼ '}{formatPercent(r.changePercent)}
                      </td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-600">{formatCompact(r.volume)}</td>
                      <td className={`text-right px-3 py-2.5 tabular-nums font-semibold ${r.futuresChangeOi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {r.futuresChangeOi >= 0 ? '+' : ''}{formatCompact(r.futuresChangeOi)}
                      </td>
                      <td className="text-center px-3 py-2.5">
                        <Sparkline data={getPriceHistory(r.symbol)} symbol={r.symbol} width={48} height={16} color={isPos ? '#34d399' : '#f87171'} showArea showEndpointDot strokeWidth={1.2} points={18} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ============================================================
          WATCHLIST + RISK & SENTIMENT
          ============================================================ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WatchlistPanel allIndices={allIndices} fnoRows={fnoRows} />
        <RiskSentimentCard vix={vixQuote} breadth={breadth} bias={bias} sentiment={sentiment} />
      </div>

      {/* ============================================================
          F&O DERIVATIVES UNIVERSE SCANNER
          ============================================================ */}
      <div className="card-premium card-accent-top animate-fade-in" style={{ '--accent-gradient': 'linear-gradient(90deg, rgba(251, 146, 60, 0.7), rgba(16, 185, 129, 0.5), rgba(6, 182, 212, 0.4))' } as React.CSSProperties}>
        <div className="p-4 border-b border-gray-800/40 light:border-slate-200 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-gray-100 light:text-slate-900 flex items-center gap-2">
                <span>F&amp;O Derivatives Universe Scanner</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 light:text-emerald-700 font-semibold">
                  {fnoRows.length} Contracts
                </span>
              </h2>
              <p className="text-[11px] text-gray-400 light:text-slate-500 mt-0.5">
                Real-time Open Interest buildup, ATM Volatility, Put-Call Ratio, and Directional Momentum
              </p>
            </div>
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
                  <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs">✕</button>
                )}
              </div>
              <div className="flex items-center bg-gray-900/60 light:bg-slate-100 p-0.5 rounded-lg border border-gray-800/40 light:border-slate-200">
                <button onClick={() => setDisplayMode('top')} className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${displayMode === 'top' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-400'}`}>Top 8</button>
                <button onClick={() => setDisplayMode('full')} className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${displayMode === 'full' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-400'}`}>All ({fnoRows.length})</button>
              </div>
            </div>
          </div>
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

        {fnoLoading && filteredFnoRows.length === 0 ? (
          <div className="p-4">
            <table className="w-full text-xs"><tbody>{Array.from({ length: 8 }, (_, i) => <SkeletonTableRow key={i} cols={12} />)}</tbody></table>
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
                      <td className="px-4 py-2.5 font-medium text-gray-100 light:text-slate-900">
                        <div className="flex items-center gap-2.5">
                          <div className={`ticker-avatar ${isPos ? 'bg-gradient-to-br from-emerald-500/40 to-cyan-500/40 text-emerald-300' : 'bg-gradient-to-br from-red-500/40 to-orange-500/40 text-red-300'}`}>{initials}</div>
                          <div>
                            <div className="font-bold text-xs text-gray-100 light:text-slate-900 flex items-center gap-1.5">
                              <span>{stock.symbol}</span>
                              <span className="text-[9px] px-1 py-0.2 rounded bg-gray-800/80 light:bg-slate-200 text-gray-400 light:text-slate-600 font-mono">{stock.exchange}</span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="text-center px-2 py-2.5">
                        <Sparkline data={getPriceHistory(stock.symbol)} symbol={stock.symbol} width={44} height={16} color={isPos ? '#34d399' : '#f87171'} showArea showEndpointDot strokeWidth={1.2} points={18} />
                      </td>
                      <td className="text-right px-3 py-2.5 tabular-nums font-bold text-gray-100 light:text-slate-900">{formatIndianNumber(stock.price, 2)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums">
                        <span className={`inline-block px-1.5 py-0.5 rounded font-bold text-xs badge-glass ${isPos ? 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700' : 'bg-red-500/15 text-red-400 light:text-red-700'}`}>
                          {isPos ? '▲ +' : '▼ '}{formatPercent(stock.changePercent)}
                        </span>
                      </td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-600 font-medium">{formatCompact(stock.volume)}</td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-300 light:text-slate-700 font-medium">{formatCompact(stock.futuresOi)}</td>
                      <td className={`text-right px-3 py-2.5 tabular-nums font-bold ${stock.futuresChangeOi >= 0 ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
                        {stock.futuresChangeOi >= 0 ? '+' : ''}{formatCompact(stock.futuresChangeOi)}
                      </td>
                      <td className="px-3 py-2.5"><OIBadge type={stock.oiInterpretation} /></td>
                      <td className={`text-right px-3 py-2.5 tabular-nums font-semibold ${stock.pcr > 1.1 ? 'text-emerald-400 light:text-emerald-700' : stock.pcr < 0.8 ? 'text-red-400 light:text-red-700' : 'text-gray-400 light:text-slate-500'}`}>
                        {stock.pcr > 0 ? stock.pcr.toFixed(2) : '—'}
                      </td>
                      <td className="text-right px-3 py-2.5 tabular-nums text-gray-300 light:text-slate-700 font-medium">{stock.atmIv > 0 ? `${stock.atmIv.toFixed(1)}%` : '—'}</td>
                      <td className="text-right px-3 py-2.5">
                        {stock.ivRank != null ? <IVRankThermometer value={stock.ivRank} /> : <span className="text-gray-600 light:text-slate-400">—</span>}
                      </td>
                      <td className="text-center px-3 py-2.5"><BiasBadge bias={stock.direction} /></td>
                      <td className="text-center px-3 py-2.5"><ScoreBadge score={stock.score} /></td>
                      <td className="text-center px-3 py-2.5">
                        <span className="text-[11px] font-semibold text-emerald-400 light:text-emerald-700 hover:text-emerald-300 hover:underline">View →</span>
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
          AI CHART PATTERNS & STRUCTURAL BREAKOUTS
          ============================================================ */}
      <ChartPatternsPanel patterns={patterns} loading={patternsLoading} />
    </div>
  );
}

// ============================================================
// HERO KPI SUB-COMPONENTS
// ============================================================

function MarketStatusCard({ open }: { open: boolean }) {
  const hours = TRADING_HOURS.NSE;
  return (
    <div className="card-premium card-accent-top p-3.5" style={{ '--accent-gradient': open ? 'linear-gradient(90deg, rgba(16, 185, 129, 0.8), rgba(6, 182, 212, 0.5))' : 'linear-gradient(90deg, rgba(107, 114, 128, 0.6), rgba(75, 85, 99, 0.4))' } as React.CSSProperties}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-gray-200 light:text-slate-800 tracking-wide">Market Status</span>
        <span className={`w-2 h-2 rounded-full ${open ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)] animate-pulse' : 'bg-gray-500'}`} />
      </div>
      <div className={`text-2xl font-bold tracking-tight ${open ? 'text-emerald-400 light:text-emerald-700' : 'text-gray-400 light:text-slate-500'}`}>
        {open ? 'OPEN' : 'CLOSED'}
      </div>
      <div className="text-[11px] text-gray-400 light:text-slate-500 mt-2">
        NSE {hours.open} – {hours.close} IST
      </div>
    </div>
  );
}

function SentimentCard({ score, label }: { score: number | null; label: string | null }) {
  const isPositive = score != null && score >= 60;
  const isNegative = score != null && score <= 40;
  const color = isPositive ? 'emerald' : isNegative ? 'red' : 'gray';
  const colorClasses = { emerald: 'text-emerald-400 light:text-emerald-700', red: 'text-red-400 light:text-red-700', gray: 'text-gray-400 light:text-slate-500' }[color];
  return (
    <div className="card-premium card-accent-top p-3.5" style={{ '--accent-gradient': isPositive ? 'linear-gradient(90deg, rgba(16, 185, 129, 0.8), rgba(6, 182, 212, 0.5))' : isNegative ? 'linear-gradient(90deg, rgba(239, 68, 68, 0.8), rgba(251, 146, 60, 0.5))' : 'linear-gradient(90deg, rgba(129, 140, 248, 0.7), rgba(168, 85, 247, 0.4))' } as React.CSSProperties}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-gray-200 light:text-slate-800 tracking-wide">Market Sentiment</span>
      </div>
      <div className={`text-2xl font-bold tracking-tight tabular-nums ${colorClasses}`}>{score != null ? score : '—'}</div>
      <div className="text-[11px] text-gray-400 light:text-slate-500 mt-2 capitalize">
        {label ? label.replace(/_/g, ' ').toLowerCase() : 'Awaiting data'}
      </div>
    </div>
  );
}

// ============================================================
// MARKET INTELLIGENCE PANEL
// ============================================================

function MarketIntelligencePanel({ bias, score, sentiment, fiiDii, breadth }: any) {
  return (
    <div className="card-premium p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-100 light:text-slate-900">Market Intelligence</h3>
        <ScoreBadge score={score.score} />
      </div>

      <div className="text-center py-3 mb-3 border-b border-gray-800/40 light:border-slate-200">
        <BiasBadge bias={bias.direction} large />
        <div className="mt-2">
          <div className="w-full h-2 bg-gray-900/80 light:bg-slate-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full bar-animated ${bias.direction === 'BULLISH' ? 'bg-emerald-400' : bias.direction === 'BEARISH' ? 'bg-red-400' : 'bg-gray-500'}`}
              style={{ width: `${bias.confidence}%` }}
            />
          </div>
          <div className="text-[11px] text-gray-400 light:text-slate-500 mt-1 tabular-nums">{bias.confidence}% Confidence</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <StatTile label="FII Flow" value={fiiDii ? `${fiiDii.fii.netValue >= 0 ? '+' : ''}₹${fiiDii.fii.netValue.toFixed(0)} Cr` : '—'} positive={fiiDii ? fiiDii.fii.netValue >= 0 : undefined} />
        <StatTile label="DII Flow" value={fiiDii ? `${fiiDii.dii.netValue >= 0 ? '+' : ''}₹${fiiDii.dii.netValue.toFixed(0)} Cr` : '—'} positive={fiiDii ? fiiDii.dii.netValue >= 0 : undefined} />
        <StatTile label="India VIX" value={sentiment?.vix ? sentiment.vix.value.toFixed(2) : '—'} />
        <StatTile label="PCR" value={bias.inputs.pcr != null ? (bias.inputs.pcr as number).toFixed(2) : '—'} />
        <StatTile label="Advance/Decline" value={`${breadth.advances} / ${breadth.declines}`} />
        <StatTile label="Breadth" value={`${breadth.advPercent}% Adv`} positive={breadth.isBullishBias} />
      </div>
    </div>
  );
}

function StatTile({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  const colorClass = positive == null ? 'text-gray-100 light:text-slate-900' : positive ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700';
  return (
    <div className="bg-gray-900/40 light:bg-slate-50 rounded-lg p-2.5 border border-gray-800/30 light:border-slate-200">
      <div className="text-[9px] uppercase tracking-wider text-gray-500 light:text-slate-500">{label}</div>
      <div className={`text-sm font-bold tabular-nums mt-0.5 ${colorClass}`}>{value}</div>
    </div>
  );
}

// ============================================================
// FII / DII ANALYTICS
// ============================================================

function FiiDiiAnalytics({ today, history }: { today: import('@fno/shared').FiiDiiActivity | null; history: import('@fno/shared').FiiDiiActivity[] }) {
  const maxAbs = Math.max(1, ...history.map((h) => Math.max(Math.abs(h.fii.netValue), Math.abs(h.dii.netValue))));

  return (
    <div className="card-premium p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-gray-100 light:text-slate-900">FII / DII Analytics</h2>
          <p className="text-[10px] text-gray-500 light:text-slate-500 mt-0.5">
            NSE's daily cash-market activity{today ? ` — ${today.date}` : ''} (published after market close)
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
        <StatTile label="FII Buy" value={today ? `₹${formatCompact(today.fii.buyValue)} Cr` : '—'} />
        <StatTile label="FII Sell" value={today ? `₹${formatCompact(today.fii.sellValue)} Cr` : '—'} />
        <StatTile label="FII Net" value={today ? `${today.fii.netValue >= 0 ? '+' : ''}₹${today.fii.netValue.toFixed(0)} Cr` : '—'} positive={today ? today.fii.netValue >= 0 : undefined} />
        <StatTile label="DII Buy" value={today ? `₹${formatCompact(today.dii.buyValue)} Cr` : '—'} />
        <StatTile label="DII Sell" value={today ? `₹${formatCompact(today.dii.sellValue)} Cr` : '—'} />
        <StatTile label="DII Net" value={today ? `${today.dii.netValue >= 0 ? '+' : ''}₹${today.dii.netValue.toFixed(0)} Cr` : '—'} positive={today ? today.dii.netValue >= 0 : undefined} />
      </div>

      {history.length === 0 ? (
        <div className="text-center py-8 text-xs text-gray-500 light:text-slate-500">
          Building history — daily FII/DII figures accumulate here over time as NSE publishes them.
        </div>
      ) : (
        <div className="flex items-end gap-1.5 h-32 px-1">
          {history.map((h, i) => {
            const fiiHeight = (Math.abs(h.fii.netValue) / maxAbs) * 100;
            const diiHeight = (Math.abs(h.dii.netValue) / maxAbs) * 100;
            return (
              <div key={i} className="flex-1 flex flex-col items-center justify-end h-full gap-0.5" title={`${h.date}: FII ${h.fii.netValue.toFixed(0)} Cr, DII ${h.dii.netValue.toFixed(0)} Cr`}>
                <div className="w-full flex items-end justify-center gap-0.5 h-full">
                  <div className={`w-1/2 rounded-t-sm bar-animated ${h.fii.netValue >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`} style={{ height: `${fiiHeight}%` }} />
                  <div className={`w-1/2 rounded-t-sm bar-animated ${h.dii.netValue >= 0 ? 'bg-indigo-400' : 'bg-orange-400'}`} style={{ height: `${diiHeight}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-4 mt-2 text-[10px] text-gray-500 light:text-slate-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-400" /> FII (green=buy)</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-indigo-400" /> DII (indigo=buy)</span>
      </div>
    </div>
  );
}

// ============================================================
// OPTIONS INTELLIGENCE
// ============================================================

function OptionsIntelligence({
  label,
  summary,
  availableExpiries,
  currentExpiry,
  onExpiryChange,
}: {
  label: string;
  summary: import('@/lib/use-option-chain-summary').OptionChainSummary | null;
  availableExpiries: string[];
  currentExpiry: string | null;
  onExpiryChange: (expiry: string) => void;
}) {
  const totalOi = summary ? summary.callOi + summary.putOi : 0;
  const callPct = summary && totalOi > 0 ? (summary.callOi / totalOi) * 100 : 50;

  return (
    <div className="card-premium p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-bold text-gray-100 light:text-slate-900">Options Intelligence — {label}</h2>
        {availableExpiries.length > 0 && (
          <select
            value={currentExpiry ?? ''}
            onChange={(e) => onExpiryChange(e.target.value)}
            className="text-[11px] font-semibold bg-gray-900/60 light:bg-slate-100 border border-gray-800/50 light:border-slate-200 rounded-md px-2 py-1 text-gray-200 light:text-slate-800 focus:outline-none focus:border-indigo-500/50"
          >
            {availableExpiries.map((exp) => (
              <option key={exp} value={exp}>{exp}</option>
            ))}
          </select>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <StatTile label="Call OI" value={summary ? formatCompact(summary.callOi) : '—'} />
        <StatTile label="Put OI" value={summary ? formatCompact(summary.putOi) : '—'} />
        <StatTile label="Call OI Chg" value={summary ? formatCompact(summary.callOiChange) : '—'} positive={summary ? summary.callOiChange < 0 : undefined} />
        <StatTile label="Put OI Chg" value={summary ? formatCompact(summary.putOiChange) : '—'} positive={summary ? summary.putOiChange >= 0 : undefined} />
        <StatTile label="PCR" value={summary ? summary.pcr.toFixed(2) : '—'} />
        <StatTile label="Max Pain" value={summary ? formatIndianNumber(summary.maxPain, 0) : '—'} />
        <StatTile label="ATM IV" value={summary && summary.atmIv > 0 ? `${summary.atmIv.toFixed(1)}%` : '—'} />
        <StatTile label="Highest OI Strikes" value={summary ? `${summary.highestCallOiStrike ?? '—'} / ${summary.highestPutOiStrike ?? '—'}` : '—'} />
      </div>

      <div>
        <div className="flex justify-between text-[10px] font-semibold mb-1 tabular-nums">
          <span className="text-red-400">Call OI {callPct.toFixed(0)}%</span>
          <span className="text-emerald-400">Put OI {(100 - callPct).toFixed(0)}%</span>
        </div>
        <div className="thermometer-track">
          <div className="thermometer-fill bg-gradient-to-r from-red-500 to-red-400" style={{ width: `${callPct}%` }} />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// RISK & SENTIMENT
// ============================================================

function RiskSentimentCard({ vix, breadth, bias, sentiment }: any) {
  const volatilityScore = vix ? Math.max(0, Math.min(100, 100 - (vix.ltp - 10) * 4)) : 50;
  const liquidityScore = breadth.avgSpread != null ? Math.max(0, Math.min(100, 100 - breadth.avgSpread * 15)) : 50;
  const breadthScore = breadth.advPercent;
  const momentumScore = bias.confidence;
  const institutionalScore = sentiment?.institutionalConvictionScore ?? 50;

  const overall = (volatilityScore + liquidityScore + breadthScore + momentumScore + institutionalScore) / 5;
  const riskLevel = overall >= 65 ? 'Low' : overall >= 40 ? 'Medium' : 'High';
  const riskColor = riskLevel === 'Low' ? 'text-emerald-400 light:text-emerald-700' : riskLevel === 'Medium' ? 'text-amber-400 light:text-amber-700' : 'text-red-400 light:text-red-700';

  const rows: Array<{ label: string; value: number; note: string }> = [
    { label: 'Volatility', value: volatilityScore, note: vix ? `VIX ${vix.ltp.toFixed(1)}` : '—' },
    { label: 'Liquidity', value: liquidityScore, note: breadth.avgSpread != null ? `${breadth.avgSpread.toFixed(1)}% avg spread` : '—' },
    { label: 'Breadth', value: breadthScore, note: `${breadth.advances} adv / ${breadth.declines} dec` },
    { label: 'Momentum', value: momentumScore, note: `${bias.direction} ${bias.confidence}%` },
    { label: 'Institutional Flow', value: institutionalScore, note: sentiment ? 'FII/DII conviction' : 'Awaiting data' },
  ];

  return (
    <div className="card-premium p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-100 light:text-slate-900">Risk &amp; Sentiment</h3>
        <div className="text-right">
          <div className="text-[9px] uppercase tracking-wider text-gray-500 light:text-slate-500">Market Risk</div>
          <div className={`text-base font-bold ${riskColor}`}>{riskLevel}</div>
        </div>
      </div>
      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3">
            <span className="text-[11px] font-semibold text-gray-400 light:text-slate-500 w-32 shrink-0">{r.label}</span>
            <div className="flex-1 h-2 bg-gray-900/80 light:bg-slate-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full bar-animated ${r.value >= 65 ? 'bg-emerald-400' : r.value >= 40 ? 'bg-amber-400' : 'bg-red-400'}`}
                style={{ width: `${Math.round(r.value)}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-500 light:text-slate-500 w-28 text-right shrink-0 tabular-nums">{r.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// SHARED SUB-COMPONENTS
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
      style={{ '--accent-gradient': isPositive ? 'linear-gradient(90deg, rgba(16, 185, 129, 0.8), rgba(6, 182, 212, 0.5))' : 'linear-gradient(90deg, rgba(239, 68, 68, 0.8), rgba(251, 146, 60, 0.5))', '--glow-color': config.bgGlow } as React.CSSProperties}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-md bg-gradient-to-br ${config.gradient} flex items-center justify-center text-[10px] font-bold text-black shadow-sm shrink-0`}>{config.initials}</div>
          <div className="text-xs font-bold text-gray-200 light:text-slate-800 tracking-wide group-hover:text-emerald-400 transition-colors">{symbol}</div>
        </div>
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-md badge-glass tabular-nums ${isPositive ? 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700' : 'bg-red-500/15 text-red-400 light:text-red-700'}`}>
          {isPositive ? '▲ +' : '▼ '}{formatPercent(changePercent)}
        </span>
      </div>

      <div className="flex items-end justify-between mb-1 mt-2">
        <div>
          <div className={`text-2xl font-bold tabular-nums tracking-tight text-gray-50 light:text-slate-900 ${isPositive ? 'text-glow-emerald' : 'text-glow-red'}`}>{formatIndianNumber(ltp, 2)}</div>
          <div className={`text-[11px] tabular-nums font-semibold mt-0.5 ${isPositive ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
            {isPositive ? '+' : ''}{change.toFixed(2)} pts
          </div>
        </div>
        <Sparkline data={getPriceHistory(symbol)} symbol={symbol} width={68} height={26} color={isPositive ? '#34d399' : '#f87171'} showArea showEndpointDot strokeWidth={1.4} points={24} className="opacity-90 group-hover:opacity-100 transition-opacity" />
      </div>

      <div className="space-y-1 mt-3">
        <div className="flex justify-between text-[9px] text-gray-500 light:text-slate-500 tabular-nums font-mono">
          <span>L: {formatIndianNumber(low, 2)}</span>
          <span className="text-gray-400 font-semibold">{positionInRange.toFixed(0)}% Range</span>
          <span>H: {formatIndianNumber(high, 2)}</span>
        </div>
        <div className="relative h-1.5 bg-gray-800/80 light:bg-slate-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full bar-animated ${isPositive ? 'bg-gradient-to-r from-emerald-600 to-emerald-400' : 'bg-gradient-to-r from-red-600 to-red-400'}`} style={{ width: `${positionInRange}%` }} />
          <div className={`absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full ${isPositive ? 'bg-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-red-300 shadow-[0_0_8px_rgba(239,68,68,0.8)]'} transition-all duration-500`} style={{ left: `calc(${positionInRange}% - 4px)` }} />
        </div>
      </div>
    </div>
  );
}

function IVRankThermometer({ value }: { value: number }) {
  const colorClass = value >= 70 ? 'bg-gradient-to-r from-orange-500 to-red-500' : value >= 40 ? 'bg-gradient-to-r from-emerald-500 to-yellow-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-12 h-1.5 bg-gray-800/80 light:bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full bar-animated ${colorClass}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] font-bold tabular-nums text-gray-300 light:text-slate-700 w-6 text-right">{value}</span>
    </div>
  );
}
