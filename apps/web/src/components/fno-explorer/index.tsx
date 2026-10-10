'use client';

import React, { useMemo, useState } from 'react';
import { isMarketOpen, formatIndianNumber, formatCompact, LIQUID_SPREAD_MAX_PCT } from '@fno/shared';
import type { FnoScannerRow } from '@fno/shared';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { useAssetTabsStore, useNavStore } from '@/stores';
import { useNow } from '@/lib/use-health';
import { classifyFreshness, FRESH_WITHIN_MS } from '@/lib/freshness';
import { EXPLORER_VIEWS, type ExplorerView } from '@/lib/nav';
import { DEFAULT_EXPLORER_FILTERS, DEFAULT_SORT, filterExplorerRows, oiActivityLists, unusualOiSymbols, VIEW_FILTERS, type ActivityFilter, type BiasFilter, type ExplorerFilters, type IvRankFilter } from '@/lib/fno-explorer';
import { formatNumber, formatSignedPercent, MISSING } from '@/lib/format';
import { PageBody, PageHeader, Section } from '@/components/ui/card';
import { ChipToggle, FilterBar, SearchField, SegmentedControl } from '@/components/ui/controls';
import { DataTable, type Column } from '@/components/ui/data-table';
import { DataState } from '@/components/ui/data-state';
import { FreshnessBadge } from '@/components/ui/status-badge';
import { BiasBadge, OIBadge, ScoreBadge } from '@/components/common/badges';
import { ActivityList } from '@/components/common/activity-list';

// ============================================================
// F&O EXPLORER — F&O Stocks, OI Intelligence and IV & Greeks as three views of one dataset
// ============================================================
// One scan, one hook, one filter bar. Each view keeps the columns, filters, default sort and notes of the page it
// replaced. Rows come from the newest scan the server has recorded (the server never starts a scan for a page load);
// the data's own observation time and the session decide whether it is shown as current or as the last recorded scan.
// ============================================================

const BIAS_OPTIONS: ReadonlyArray<{ id: BiasFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'BULLISH', label: 'Bullish' },
  { id: 'BEARISH', label: 'Bearish' },
  { id: 'NEUTRAL', label: 'Neutral' },
];
const ACTIVITY_OPTIONS: ReadonlyArray<{ id: ActivityFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'LONG_BUILDUP', label: 'Long build' },
  { id: 'SHORT_BUILDUP', label: 'Short build' },
  { id: 'SHORT_COVERING', label: 'Short cover' },
  { id: 'LONG_UNWINDING', label: 'Long unwind' },
  { id: 'NEUTRAL', label: 'Neutral' },
];
const IV_OPTIONS: ReadonlyArray<{ id: IvRankFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'HIGH', label: 'High (≥70)' },
  { id: 'LOW', label: 'Low (≤30)' },
];

const changeColor = (v: number) => (v > 0 ? 'text-[var(--status-ok)]' : v < 0 ? 'text-[var(--status-bad)]' : 'text-[var(--text-secondary)]');

function Bar({ value }: { value: number }) {
  const color = value >= 70 ? 'bg-[var(--status-bad)]' : value >= 40 ? 'bg-[var(--status-warn)]' : 'bg-[var(--status-ok)]';
  return (
    <div className="flex items-center justify-end gap-2" title={`${value}`}>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-[var(--surface-card-alt)]">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="w-7 text-right text-xs tabular-nums text-[var(--text-secondary)]">{value}</span>
    </div>
  );
}

// Tighter spread = more liquid, so the scale runs the opposite way to the IV bars: green up to 2%, amber to the liquidity gate, red past it.
function SpreadCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-[var(--text-secondary)]">{MISSING}</span>;
  const color = value <= 2 ? 'text-[var(--status-ok)]' : value <= LIQUID_SPREAD_MAX_PCT ? 'text-[var(--status-warn)]' : 'text-[var(--status-bad)]';
  return <span className={`font-medium ${color}`}>{value.toFixed(2)}%</span>;
}

function SymbolCell({ row, flag }: { row: FnoScannerRow; flag?: boolean }) {
  const openTab = useAssetTabsStore((s) => s.openTab);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openTab(row.symbol, row.exchange);
      }}
      title={`Open the ${row.symbol} workspace`}
      className="font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline"
    >
      {row.symbol}
      {flag && (
        <span className="ml-1.5" title="Among the ten largest open-interest % swings right now">
          <span aria-hidden="true">🔥</span>
          <span className="sr-only">unusual OI move</span>
        </span>
      )}
    </button>
  );
}

const num = (v: number) => (v !== 0 ? v : null);

function useColumns(view: ExplorerView, unusual: Set<string>): Column<FnoScannerRow>[] {
  return useMemo(() => {
    const stock: Column<FnoScannerRow> = { id: 'symbol', header: 'Stock', sortValue: (r) => r.symbol, cell: (r) => <SymbolCell row={r} flag={view === 'oi' && unusual.has(r.symbol)} /> };
    const price: Column<FnoScannerRow> = { id: 'price', header: 'Price', numeric: true, sortValue: (r) => r.price, cell: (r) => formatIndianNumber(r.price, 2) };
    const chg: Column<FnoScannerRow> = { id: 'chg', header: 'Chg %', numeric: true, sortValue: (r) => r.changePercent, cell: (r) => <span className={`font-medium ${changeColor(r.changePercent)}`}>{formatSignedPercent(r.changePercent)}</span> };
    const volume: Column<FnoScannerRow> = { id: 'volume', header: 'Volume', numeric: true, hideBelow: 'md', sortValue: (r) => r.volume, cell: (r) => formatCompact(r.volume) };
    const foi: Column<FnoScannerRow> = { id: 'foi', header: 'Futures OI', numeric: true, hideBelow: 'lg', sortValue: (r) => r.futuresOi, cell: (r) => formatCompact(r.futuresOi) };
    const oiChg: Column<FnoScannerRow> = {
      id: 'oiChg',
      header: 'OI chg',
      numeric: true,
      hideBelow: 'lg',
      sortValue: (r) => r.futuresChangeOi,
      cell: (r) => <span className={`font-medium ${changeColor(r.futuresChangeOi)}`}>{r.futuresChangeOi > 0 ? '+' : ''}{formatCompact(r.futuresChangeOi)}</span>,
    };
    const oiPct: Column<FnoScannerRow> = {
      id: 'oiPct',
      header: 'OI chg %',
      numeric: true,
      sortValue: (r) => r.futuresChangeOiPercent,
      cell: (r) => (r.futuresChangeOiPercent !== 0 ? <span className={`font-medium ${changeColor(r.futuresChangeOiPercent)}`}>{formatSignedPercent(r.futuresChangeOiPercent, 1)}</span> : MISSING),
    };
    const activity: Column<FnoScannerRow> = { id: 'activity', header: 'OI activity', hideBelow: 'md', cell: (r) => <OIBadge type={r.oiInterpretation} futuresChangePercent={r.futuresChangePercent} /> };
    const pcr: Column<FnoScannerRow> = {
      id: 'pcr',
      header: 'PCR',
      numeric: true,
      hideBelow: 'md',
      sortValue: (r) => num(r.pcr),
      cell: (r) => (r.pcr > 0 ? <span className={r.pcr > 1 ? 'text-[var(--status-ok)]' : r.pcr < 0.7 ? 'text-[var(--status-bad)]' : ''}>{r.pcr.toFixed(2)}</span> : MISSING),
    };
    const iv: Column<FnoScannerRow> = { id: 'iv', header: 'ATM IV', numeric: true, hideBelow: 'md', sortValue: (r) => num(r.atmIv), cell: (r) => (r.atmIv > 0 ? `${r.atmIv.toFixed(1)}%` : MISSING) };
    const ivRank: Column<FnoScannerRow> = { id: 'ivRank', header: 'IV rank', numeric: true, hideBelow: 'md', title: 'Needs daily IV history; shown as — until enough exists', sortValue: (r) => r.ivRank, cell: (r) => (r.ivRank != null ? <Bar value={r.ivRank} /> : MISSING) };
    const bias: Column<FnoScannerRow> = { id: 'bias', header: 'Bias', sortValue: (r) => r.direction, cell: (r) => <BiasBadge bias={r.direction} /> };
    const score: Column<FnoScannerRow> = { id: 'score', header: 'Score', sortValue: (r) => r.score, cell: (r) => <ScoreBadge score={r.score} /> };

    if (view === 'oi') return [stock, price, chg, volume, foi, oiChg, oiPct, { ...activity, header: 'Activity' }, pcr, bias, score];
    if (view === 'iv') {
      return [
        stock,
        price,
        { ...iv, hideBelow: undefined },
        { ...ivRank, hideBelow: undefined },
        { id: 'ivPct', header: 'IV %ile', numeric: true, hideBelow: 'md', sortValue: (r: FnoScannerRow) => r.ivPercentile, cell: (r: FnoScannerRow) => (r.ivPercentile != null ? <Bar value={r.ivPercentile} /> : MISSING) },
        { id: 'skew', header: 'Skew (CE−PE)', numeric: true, hideBelow: 'lg', title: 'Call IV minus put IV at the ATM strike; positive = calls pricier', sortValue: (r: FnoScannerRow) => num(r.ivSkew), cell: (r: FnoScannerRow) => (r.ivSkew !== 0 ? <span className={`font-medium ${changeColor(r.ivSkew)}`}>{r.ivSkew > 0 ? '+' : ''}{r.ivSkew.toFixed(1)}</span> : MISSING) },
        { id: 'gamma', header: 'Gamma', numeric: true, hideBelow: 'lg', sortValue: (r: FnoScannerRow) => num(r.atmGamma), cell: (r: FnoScannerRow) => (r.atmGamma > 0 ? r.atmGamma.toFixed(4) : MISSING) },
        { id: 'theta', header: 'Theta ₹/day', numeric: true, hideBelow: 'lg', sortValue: (r: FnoScannerRow) => num(r.atmTheta), cell: (r: FnoScannerRow) => (r.atmTheta !== 0 ? <span className="text-[var(--status-bad)]">{r.atmTheta.toFixed(2)}</span> : MISSING) },
        { id: 'vega', header: 'Vega', numeric: true, hideBelow: 'lg', sortValue: (r: FnoScannerRow) => num(r.atmVega), cell: (r: FnoScannerRow) => (r.atmVega > 0 ? r.atmVega.toFixed(2) : MISSING) },
        pcr,
        bias,
      ];
    }
    return [
      stock,
      price,
      chg,
      volume,
      { id: 'spread', header: 'Spread', numeric: true, hideBelow: 'md', title: `ATM bid-ask spread as % of mid; the liquidity gate is ${LIQUID_SPREAD_MAX_PCT}%`, sortValue: (r: FnoScannerRow) => r.atmSpreadPct, cell: (r: FnoScannerRow) => <SpreadCell value={r.atmSpreadPct} /> },
      foi,
      oiChg,
      activity,
      pcr,
      iv,
      ivRank,
      bias,
      score,
    ];
  }, [view, unusual]);
}

const NOTES: Record<ExplorerView, string> = {
  overview:
    "Bias and Score here are a lighter OI + PCR + price-change composite (no historical technicals), built to scan the whole universe quickly within the broker's rate limits. For a full technical read on one stock, open its workspace. IV rank needs daily history, so it reads — until enough exists for that stock.",
  oi: "Build-up classification compares today's futures price change with futures OI change since the day's opening baseline (Long/Short build-up = OI rising with price up/down; Short covering / Long unwinding = OI falling with price up/down). 🔥 flags the ten largest OI % swings, whichever the direction. Select a stock to open its option chain.",
  iv: 'IV rank and percentile need daily history, so they read — until enough exists. Gamma, Theta and Vega are per-share ATM Greeks (average of the nearest-expiry ATM call and put, from our own Black-Scholes engine); Theta is the combined call + put daily decay. Skew is call IV minus put IV at the ATM strike. Select a stock to open its option chain.',
};

export function FnoExplorerPage() {
  const { rows, loading, error, meta, asOf, reload } = useFnoScanner('NSE');
  const view = useNavStore((s) => s.explorerView);
  const setView = useNavStore((s) => s.setExplorerView);
  const [filters, setFilters] = useState<ExplorerFilters>(DEFAULT_EXPLORER_FILTERS);
  const now = useNow(5000);
  const set = <K extends keyof ExplorerFilters>(k: K, v: ExplorerFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  const filtered = useMemo(() => filterExplorerRows(rows, view, filters), [rows, view, filters]);
  const unusual = useMemo(() => unusualOiSymbols(rows), [rows]);
  const lists = useMemo(() => oiActivityLists(rows), [rows]);
  const columns = useColumns(view, unusual);
  const shows = new Set(VIEW_FILTERS[view]);
  const freshness = classifyFreshness({ observedAt: asOf, now, sessionOpen: isMarketOpen('NSE', now), transportConnected: error ? false : null, freshWithinMs: FRESH_WITHIN_MS.scan });
  const viewMeta = EXPLORER_VIEWS.find((v) => v.id === view)!;

  return (
    <PageBody>
      <PageHeader
        title="F&O Explorer"
        subtitle="Every NSE stock with F&O contracts, in three views of the same scan: price and OI, OI build-up, and IV and Greeks."
        actions={
          <span className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <FreshnessBadge state={freshness.state} detail={freshness.detail} />
            {rows.length > 0 && <span>{filtered.length} of {rows.length} stocks</span>}
          </span>
        }
      >
        <SegmentedControl<ExplorerView> label="Explorer view" value={view} onChange={setView} options={EXPLORER_VIEWS.map((v) => ({ id: v.id, label: v.label, title: v.description }))} />
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{viewMeta.description}</p>
      </PageHeader>

      <DataState
        loading={loading}
        error={error}
        hasData={rows.length > 0}
        onRetry={reload}
        errorTitle="Could not load the F&O scan"
        emptyTitle="No F&O scan has been recorded yet"
        emptyHint={meta?.unavailableReason ?? 'The server records a scan while the exchange is open.'}
        staleNote={meta?.source === 'LAST_KNOWN' || freshness.state === 'MARKET_CLOSED' ? `${freshness.detail} Showing the last recorded scan, not a live update.` : freshness.state === 'STALE' ? freshness.detail : undefined}
        skeletonRows={8}
      >
        <FilterBar label="Explorer filters">
          {shows.has('query') && <SearchField value={filters.query} onChange={(v) => set('query', v)} placeholder="Symbol" label="Filter by symbol" />}
          {shows.has('bias') && <SegmentedControl label="Bias" value={filters.bias} onChange={(v) => set('bias', v)} options={BIAS_OPTIONS} />}
          {shows.has('activity') && <SegmentedControl label="OI activity" value={filters.activity} onChange={(v) => set('activity', v)} options={ACTIVITY_OPTIONS} />}
          {shows.has('ivRank') && <SegmentedControl label="IV rank" value={filters.ivRank} onChange={(v) => set('ivRank', v)} options={IV_OPTIONS} />}
          {shows.has('liquidOnly') && (
            <ChipToggle pressed={filters.liquidOnly} onToggle={() => set('liquidOnly', !filters.liquidOnly)} title={`ATM bid-ask spread within ${LIQUID_SPREAD_MAX_PCT}% of mid, the same gate the trade setup uses. Hides anything wider and anything with no spread data.`}>
              Liquid only
            </ChipToggle>
          )}
        </FilterBar>

        {view === 'oi' && (
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <ActivityList title="🟢 Top Long Buildup" items={lists.longBuildup} color="emerald" />
            <ActivityList title="🔴 Top Short Buildup" items={lists.shortBuildup} color="red" />
            <ActivityList title="🟡 Short Covering" items={lists.shortCovering} color="yellow" />
            <ActivityList title="🟠 Long Unwinding" items={lists.longUnwinding} color="orange" />
          </div>
        )}

        <Section title={viewMeta.label} subtitle={`${formatNumber(filtered.length, 0)} stocks. Select a column heading to sort; select a stock to open its workspace.`}>
          <DataTable
            key={view}
            columns={columns}
            rows={filtered}
            rowKey={(r) => r.symbol}
            ariaLabel={`${viewMeta.label} table`}
            pageSize={40}
            maxHeight="68vh"
            initialSort={DEFAULT_SORT[view]}
            onRowClick={(r) => useAssetTabsStore.getState().openTab(r.symbol, r.exchange)}
            emptyTitle="No stocks match the current filters"
            emptyHint="Clear a filter to see more of the universe."
          />
          <p className="mt-3 max-w-4xl text-sm leading-relaxed text-[var(--text-secondary)]">{NOTES[view]}</p>
        </Section>
      </DataState>
    </PageBody>
  );
}
