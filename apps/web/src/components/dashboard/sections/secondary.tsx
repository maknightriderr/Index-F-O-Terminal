'use client';

import React, { useMemo, useState } from 'react';
import { formatIndianNumber, formatCompact } from '@fno/shared';
import type { FiiDiiActivity, FnoScannerRow, MarketQuote } from '@fno/shared';
import type { OptionChainSummary } from '@/lib/use-option-chain-summary';
import { useAssetTabsStore, useMarketStore } from '@/stores';
import { formatArrowPercent, MISSING } from '@/lib/format';
import { MetricGrid, MetricTile, Section } from '@/components/ui/card';
import { ActionButton, ChipToggle, FilterBar, SearchField, SegmentedControl } from '@/components/ui/controls';
import { DataTable, type Column } from '@/components/ui/data-table';
import { OIBadge, BiasBadge, ScoreBadge } from '@/components/common/badges';
import { Sparkline } from '@/components/common/sparkline';
import { getPriceHistory } from '@/lib/price-history-store';

// ============================================================
// SECTION F — SECONDARY MARKET INFORMATION
// ============================================================
// FII/DII, options OI, top movers, risk and the F&O screener, below the actionable sections and each collapsible. Nothing
// here repeats the index prices (status bar) or the FII/DII figures twice. Unknown values are em dashes.
// ============================================================

const signedCr = (v: number) => `${v > 0 ? '+' : v < 0 ? '-' : ''}₹${Math.abs(v).toFixed(0)} Cr`;

export function FiiDiiPanel({ today, history }: { today: FiiDiiActivity | null; history: FiiDiiActivity[] }) {
  const maxAbs = Math.max(1, ...history.map((h) => Math.max(Math.abs(h.fii.netValue), Math.abs(h.dii.netValue))));
  return (
    <Section title="FII / DII activity" subtitle={`NSE's daily cash-market activity${today ? `, ${today.date}` : ''}, published after the close.`} collapsible defaultOpen>
      <MetricGrid min={130}>
        <MetricTile label="FII buy" value={today ? `₹${formatCompact(today.fii.buyValue)} Cr` : MISSING} />
        <MetricTile label="FII sell" value={today ? `₹${formatCompact(today.fii.sellValue)} Cr` : MISSING} />
        <MetricTile label="FII net" value={today ? signedCr(today.fii.netValue) : MISSING} tone={today ? (today.fii.netValue >= 0 ? 'ok' : 'bad') : undefined} />
        <MetricTile label="DII buy" value={today ? `₹${formatCompact(today.dii.buyValue)} Cr` : MISSING} />
        <MetricTile label="DII sell" value={today ? `₹${formatCompact(today.dii.sellValue)} Cr` : MISSING} />
        <MetricTile label="DII net" value={today ? signedCr(today.dii.netValue) : MISSING} tone={today ? (today.dii.netValue >= 0 ? 'ok' : 'bad') : undefined} />
      </MetricGrid>
      {history.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--text-secondary)]">History is still accumulating: daily figures are added as NSE publishes them.</p>
      ) : (
        <>
          <div className="mt-4 flex h-32 items-end gap-1.5 px-1" role="img" aria-label={`Net FII and DII flow over the last ${history.length} days`}>
            {history.map((h, i) => (
              <div key={i} className="flex h-full flex-1 items-end justify-center gap-0.5" title={`${h.date}: FII ${signedCr(h.fii.netValue)}, DII ${signedCr(h.dii.netValue)}`}>
                <div className={`w-1/2 rounded-t-sm ${h.fii.netValue >= 0 ? 'bg-[var(--status-ok)]' : 'bg-[var(--status-bad)]'}`} style={{ height: `${(Math.abs(h.fii.netValue) / maxAbs) * 100}%` }} />
                <div className={`w-1/2 rounded-t-sm ${h.dii.netValue >= 0 ? 'bg-indigo-400' : 'bg-orange-400'}`} style={{ height: `${(Math.abs(h.dii.netValue) / maxAbs) * 100}%` }} />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Left bar of each pair FII, right bar DII. FII green = net buying, red = net selling; DII indigo = net buying, orange = net selling.</p>
        </>
      )}
    </Section>
  );
}

export function OptionsPanel({
  label,
  summary,
  availableExpiries,
  currentExpiry,
  onExpiryChange,
}: {
  label: string;
  summary: OptionChainSummary | null;
  availableExpiries: string[];
  currentExpiry: string | null;
  onExpiryChange: (e: string) => void;
}) {
  const totalOi = summary ? summary.callOi + summary.putOi : 0;
  const callPct = summary && totalOi > 0 ? (summary.callOi / totalOi) * 100 : null;
  return (
    <Section
      title={`Options OI: ${label}`}
      collapsible
      defaultOpen
      actions={
        availableExpiries.length > 0 ? (
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            Expiry
            <select value={currentExpiry ?? ''} onChange={(e) => onExpiryChange(e.target.value)} className="min-h-8 rounded-md border border-[var(--border-secondary)] bg-[var(--surface-card)] px-2 py-1 text-sm text-[var(--text-primary)]">
              {availableExpiries.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        ) : undefined
      }
    >
      <MetricGrid min={130}>
        <MetricTile label="Call OI" value={summary ? formatCompact(summary.callOi) : MISSING} />
        <MetricTile label="Put OI" value={summary ? formatCompact(summary.putOi) : MISSING} />
        <MetricTile label="Call OI change" value={summary ? formatCompact(summary.callOiChange) : MISSING} />
        <MetricTile label="Put OI change" value={summary ? formatCompact(summary.putOiChange) : MISSING} />
        <MetricTile label="PCR" value={summary ? summary.pcr.toFixed(2) : MISSING} />
        <MetricTile label="Max pain" value={summary ? formatIndianNumber(summary.maxPain, 0) : MISSING} />
        <MetricTile label="ATM IV" value={summary && summary.atmIv > 0 ? `${summary.atmIv.toFixed(1)}%` : MISSING} />
        <MetricTile label="Highest OI strikes" value={summary ? `${summary.highestCallOiStrike ?? MISSING} / ${summary.highestPutOiStrike ?? MISSING}` : MISSING} sub="call / put" />
      </MetricGrid>
      {callPct != null && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-xs font-medium tabular-nums">
            <span className="text-[var(--status-bad)]">Call OI {callPct.toFixed(0)}%</span>
            <span className="text-[var(--status-ok)]">Put OI {(100 - callPct).toFixed(0)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--status-ok)]/40" role="img" aria-label={`Call OI ${callPct.toFixed(0)} percent, put OI ${(100 - callPct).toFixed(0)} percent`}>
            <div className="h-full bg-[var(--status-bad)]" style={{ width: `${callPct}%` }} />
          </div>
        </div>
      )}
    </Section>
  );
}

type MoversTab = 'GAINERS' | 'LOSERS' | 'VOLUME' | 'OI' | 'LONG_BUILDUP' | 'SHORT_COVERING';

export function TopMoversPanel({ rows }: { rows: FnoScannerRow[] }) {
  const [tab, setTab] = useState<MoversTab>('GAINERS');
  const data = useMemo(() => {
    let r = [...rows];
    switch (tab) {
      case 'GAINERS': r = r.filter((x) => x.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent); break;
      case 'LOSERS': r = r.filter((x) => x.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent); break;
      case 'VOLUME': r.sort((a, b) => b.volume - a.volume); break;
      case 'OI': r.sort((a, b) => Math.abs(b.futuresChangeOi) - Math.abs(a.futuresChangeOi)); break;
      case 'LONG_BUILDUP': r = r.filter((x) => x.oiInterpretation === 'LONG_BUILDUP').sort((a, b) => b.futuresChangeOi - a.futuresChangeOi); break;
      case 'SHORT_COVERING': r = r.filter((x) => x.oiInterpretation === 'SHORT_COVERING').sort((a, b) => b.futuresChangeOi - a.futuresChangeOi); break;
    }
    return r.slice(0, 8);
  }, [rows, tab]);
  const columns = useMemo<Column<FnoScannerRow>[]>(
    () => [
      { id: 'symbol', header: 'Stock', cell: (r) => <span className="font-semibold">{r.symbol}</span> },
      { id: 'price', header: 'Price', numeric: true, cell: (r) => formatIndianNumber(r.price, 2) },
      { id: 'chg', header: 'Change', numeric: true, cell: (r) => <span className={`font-medium ${r.changePercent >= 0 ? 'text-[var(--status-ok)]' : 'text-[var(--status-bad)]'}`}>{formatArrowPercent(r.changePercent)}</span> },
      { id: 'vol', header: 'Volume', numeric: true, hideBelow: 'md', cell: (r) => formatCompact(r.volume) },
      { id: 'oi', header: 'OI change', numeric: true, hideBelow: 'md', cell: (r) => `${r.futuresChangeOi > 0 ? '+' : ''}${formatCompact(r.futuresChangeOi)}` },
      { id: 'trend', header: 'Trend', hideBelow: 'sm', cell: (r) => <Sparkline data={getPriceHistory(r.symbol)} symbol={r.symbol} width={48} height={16} color={r.changePercent >= 0 ? '#34d399' : '#f87171'} showArea showEndpointDot strokeWidth={1.2} points={18} /> },
    ],
    []
  );
  return (
    <Section
      title="Top movers"
      collapsible
      defaultOpen
      actions={
        <SegmentedControl<MoversTab>
          label="Movers list"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'GAINERS', label: 'Gainers' },
            { id: 'LOSERS', label: 'Losers' },
            { id: 'VOLUME', label: 'Volume' },
            { id: 'OI', label: 'OI' },
            { id: 'LONG_BUILDUP', label: 'Long build-up' },
            { id: 'SHORT_COVERING', label: 'Short covering' },
          ]}
        />
      }
    >
      <DataTable columns={columns} rows={data} rowKey={(r) => r.symbol} ariaLabel="Top movers" pageSize={8} onRowClick={(r) => useAssetTabsStore.getState().openTab(r.symbol, r.exchange)} emptyTitle="No stocks match this list right now" />
    </Section>
  );
}

export function RiskSentimentPanel({ vix, breadth, bias, biasLive, sentiment }: { vix: MarketQuote | null; breadth: { advances: number; declines: number; advPercent: number; avgSpread: number | null }; bias: { direction: string; confidence: number }; biasLive: boolean; sentiment: { institutionalConvictionScore?: number | null } | null }) {
  // A missing input is left out of the average and drawn empty: it used to count as a neutral 50, which made a dead feed look like a calm market.
  const volatilityScore = vix ? Math.max(0, Math.min(100, 100 - (vix.ltp - 10) * 4)) : null;
  const liquidityScore = breadth.avgSpread != null ? Math.max(0, Math.min(100, 100 - breadth.avgSpread * 15)) : null;
  const breadthScore = breadth.advances + breadth.declines > 0 ? breadth.advPercent : null;
  const momentumScore = biasLive ? bias.confidence : null;
  const institutionalScore = sentiment?.institutionalConvictionScore ?? null;
  const known = [volatilityScore, liquidityScore, breadthScore, momentumScore, institutionalScore].filter((v): v is number => v != null);
  const overall = known.length >= 3 ? known.reduce((a, b) => a + b, 0) / known.length : null;
  const level = overall == null ? null : overall >= 65 ? 'Low' : overall >= 40 ? 'Medium' : 'High';
  const rows: Array<{ label: string; value: number | null; note: string }> = [
    { label: 'Volatility', value: volatilityScore, note: vix ? `VIX ${vix.ltp.toFixed(1)}` : MISSING },
    { label: 'Liquidity', value: liquidityScore, note: breadth.avgSpread != null ? `${breadth.avgSpread.toFixed(1)}% avg spread` : MISSING },
    { label: 'Breadth', value: breadthScore, note: breadthScore != null ? `${breadth.advances} up / ${breadth.declines} down` : MISSING },
    { label: 'Momentum', value: momentumScore, note: biasLive ? `${bias.direction.toLowerCase()} ${bias.confidence}` : 'no current assessment' },
    { label: 'Institutional flow', value: institutionalScore, note: sentiment ? 'FII/DII conviction' : MISSING },
  ];
  return (
    <Section title="Risk and sentiment" subtitle={`Market risk: ${level ?? 'not enough inputs'} (needs at least three of five inputs; a missing one is left out, not counted as neutral).`} collapsible defaultOpen={false}>
      <ul className="space-y-2.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-3">
            <span className="w-36 shrink-0 text-sm text-[var(--text-secondary)]">{r.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-card-alt)]" role="img" aria-label={`${r.label}: ${r.value == null ? 'no data' : Math.round(r.value)} out of 100`}>
              <div className={`h-full rounded-full ${r.value == null ? '' : r.value >= 65 ? 'bg-[var(--status-ok)]' : r.value >= 40 ? 'bg-[var(--status-warn)]' : 'bg-[var(--status-bad)]'}`} style={{ width: `${r.value == null ? 0 : Math.round(r.value)}%` }} />
            </div>
            <span className="w-36 shrink-0 text-right text-xs tabular-nums text-[var(--text-secondary)]">{r.note}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

type ScreenerFilter = 'ALL' | 'TOP_VOLUME' | 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'HIGH_IV' | 'TOP_SCORE' | 'GAINERS' | 'LOSERS';
const SCREENER: ReadonlyArray<{ id: ScreenerFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'TOP_VOLUME', label: 'High volume' },
  { id: 'LONG_BUILDUP', label: 'Long build-up' },
  { id: 'SHORT_BUILDUP', label: 'Short build-up' },
  { id: 'SHORT_COVERING', label: 'Short covering' },
  { id: 'LONG_UNWINDING', label: 'Long unwinding' },
  { id: 'HIGH_IV', label: 'High IV' },
  { id: 'TOP_SCORE', label: 'High score' },
  { id: 'GAINERS', label: 'Gainers' },
  { id: 'LOSERS', label: 'Losers' },
];

/** The dashboard's F&O screener (same filters as before); the full multi-view table is the F&O Explorer. */
export function FnoScreenerPanel({ rows }: { rows: FnoScannerRow[] }) {
  const [filter, setFilter] = useState<ScreenerFilter>('ALL');
  const [query, setQuery] = useState('');
  const [full, setFull] = useState(false);
  const setActiveTab = useMarketStore((s) => s.setActiveTab);

  const data = useMemo(() => {
    let r = [...rows];
    const q = query.trim().toUpperCase();
    if (q) r = r.filter((x) => x.symbol.includes(q));
    switch (filter) {
      case 'TOP_VOLUME': r.sort((a, b) => b.volume - a.volume); break;
      case 'LONG_BUILDUP': r = r.filter((x) => x.oiInterpretation === 'LONG_BUILDUP'); break;
      case 'SHORT_BUILDUP': r = r.filter((x) => x.oiInterpretation === 'SHORT_BUILDUP'); break;
      case 'SHORT_COVERING': r = r.filter((x) => x.oiInterpretation === 'SHORT_COVERING'); break;
      case 'LONG_UNWINDING': r = r.filter((x) => x.oiInterpretation === 'LONG_UNWINDING'); break;
      case 'HIGH_IV':
        r = r.filter((x) => (x.ivRank != null ? x.ivRank >= 50 : x.atmIv >= 25));
        r.sort((a, b) => (b.ivRank ?? b.atmIv) - (a.ivRank ?? a.atmIv));
        break;
      case 'TOP_SCORE': r.sort((a, b) => b.score - a.score); break;
      case 'GAINERS': r = r.filter((x) => x.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent); break;
      case 'LOSERS': r = r.filter((x) => x.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent); break;
      default: r.sort((a, b) => b.score - a.score);
    }
    return full ? r : r.slice(0, 8);
  }, [rows, filter, query, full]);

  const columns = useMemo<Column<FnoScannerRow>[]>(
    () => [
      { id: 'symbol', header: 'Stock', cell: (r) => <span className="font-semibold">{r.symbol} <span className="text-xs font-normal text-[var(--text-secondary)]">{r.exchange}</span></span> },
      { id: 'trend', header: 'Trend', hideBelow: 'md', cell: (r) => <Sparkline data={getPriceHistory(r.symbol)} symbol={r.symbol} width={44} height={16} color={r.changePercent >= 0 ? '#34d399' : '#f87171'} showArea showEndpointDot strokeWidth={1.2} points={18} /> },
      { id: 'ltp', header: 'LTP (₹)', numeric: true, cell: (r) => formatIndianNumber(r.price, 2) },
      { id: 'chg', header: 'Chg %', numeric: true, cell: (r) => <span className={`font-medium ${r.changePercent >= 0 ? 'text-[var(--status-ok)]' : 'text-[var(--status-bad)]'}`}>{formatArrowPercent(r.changePercent)}</span> },
      { id: 'vol', header: 'Volume', numeric: true, hideBelow: 'md', cell: (r) => formatCompact(r.volume) },
      { id: 'foi', header: 'Futures OI', numeric: true, hideBelow: 'lg', cell: (r) => formatCompact(r.futuresOi) },
      { id: 'oi', header: 'OI chg', numeric: true, hideBelow: 'lg', cell: (r) => `${r.futuresChangeOi > 0 ? '+' : ''}${formatCompact(r.futuresChangeOi)}` },
      { id: 'act', header: 'OI activity', hideBelow: 'md', cell: (r) => <OIBadge type={r.oiInterpretation} futuresChangePercent={r.futuresChangePercent} /> },
      { id: 'pcr', header: 'PCR', numeric: true, hideBelow: 'lg', cell: (r) => (r.pcr > 0 ? r.pcr.toFixed(2) : MISSING) },
      { id: 'iv', header: 'ATM IV', numeric: true, hideBelow: 'lg', cell: (r) => (r.atmIv > 0 ? `${r.atmIv.toFixed(1)}%` : MISSING) },
      { id: 'ivr', header: 'IV rank', numeric: true, hideBelow: 'lg', cell: (r) => (r.ivRank != null ? r.ivRank : MISSING) },
      { id: 'bias', header: 'Bias', cell: (r) => <BiasBadge bias={r.direction} /> },
      { id: 'score', header: 'Score', cell: (r) => <ScoreBadge score={r.score} /> },
    ],
    []
  );

  return (
    <Section
      title={`F&O universe screener (${rows.length} stocks)`}
      subtitle="Open interest build-up, ATM volatility, put-call ratio and direction. The F&O Explorer has the full views."
      collapsible
      defaultOpen={false}
      actions={<ActionButton onClick={() => setActiveTab('fno-explorer')}>Open F&O Explorer →</ActionButton>}
    >
      <FilterBar label="Screener filters">
        <SearchField value={query} onChange={setQuery} placeholder="Symbol" label="Filter by symbol" />
        <SegmentedControl<ScreenerFilter> label="Screener list" value={filter} onChange={setFilter} options={SCREENER} />
        <ChipToggle pressed={full} onToggle={() => setFull((f) => !f)}>
          {full ? 'Showing all' : 'Top 8'}
        </ChipToggle>
      </FilterBar>
      <DataTable columns={columns} rows={data} rowKey={(r) => r.symbol} ariaLabel="F&O universe screener" pageSize={20} onRowClick={(r) => useAssetTabsStore.getState().openTab(r.symbol, r.exchange)} emptyTitle="No stocks match this screener" />
    </Section>
  );
}
