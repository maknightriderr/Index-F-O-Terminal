'use client';

import React, { useMemo, useState } from 'react';
import { PageBody, PageHeader, Section, MetricGrid, MetricTile } from '@/components/ui/card';
import { ActionButton, FilterBar, SearchField, SegmentedControl, SelectField, SimulatedNotice, ChipToggle } from '@/components/ui/controls';
import { DataState } from '@/components/ui/data-state';
import { usePaperTrades } from '@/lib/use-paper-trades';
import { useNow } from '@/lib/use-health';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { byMintedDesc, countTrades, DEFAULT_FILTERS, distinct, filterTrades, type PeriodFilter, type StateFilter, type TradeFilters } from '@/lib/paper-trade-view';
import { formatIstDateTime } from '@/lib/format';
import { TradesTable } from './trades-table';

const STATE_OPTIONS: ReadonlyArray<{ id: StateFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'OPEN', label: 'Open' },
  { id: 'CLOSED', label: 'Closed' },
  { id: 'EXPIRED', label: 'Expired' },
  { id: 'WIN', label: 'Win' },
  { id: 'LOSS', label: 'Loss' },
];

const EXCLUSION_LABEL: Record<string, string> = {
  VOIDED: 'voided',
  TRACKING_LOST: 'tracking lost',
  OFF_SESSION: 'off-session',
  SPREAD: 'spread',
  INCOMPLETE: 'incomplete record',
  OTHER: 'other',
};

export function PaperTradesPage() {
  const { data, loading, error, fetchedAt, reload } = usePaperTrades(1000);
  const now = useNow(5000);
  const feed = useFeedSummary();
  const [filters, setFilters] = useState<TradeFilters>(DEFAULT_FILTERS);
  const set = <K extends keyof TradeFilters>(k: K, v: TradeFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  const all = useMemo(() => [...(data?.trades ?? [])].sort(byMintedDesc), [data]);
  const shown = useMemo(() => filterTrades(all, filters), [all, filters]);
  const counts = useMemo(() => countTrades(shown), [shown]);
  const families = useMemo(() => distinct(all, (t) => t.family), [all]);
  const versions = useMemo(() => distinct(all, (t) => t.logicVersion), [all]);
  const exclusions = Object.entries(counts.excluded);

  return (
    <PageBody>
      <PageHeader
        title="Paper Trades"
        subtitle="Every simulated trade the engines have taken: open, closed and expired. These are the system's own records; this page recomputes nothing."
        actions={<ActionButton onClick={reload}>Refresh</ActionButton>}
      />
      <SimulatedNotice />

      <DataState loading={loading} error={error} hasData={!!data} isEmpty={!!data && data.trades.length === 0} onRetry={reload} errorTitle="Could not load paper trades" emptyTitle="No paper trades have been recorded yet" emptyHint="They appear here as the engines mint them during a session.">
        <Section
          title="Summary of the rows below"
          subtitle={`Counts follow the filters. Closed trades are only counted in performance when they are eligible (not voided, lost, off-session or a spread). Data as of ${formatIstDateTime(fetchedAt, now)}.`}
        >
          <MetricGrid min={140}>
            <MetricTile label="Rows shown" value={counts.shown} sub={`of ${all.length} recorded`} />
            <MetricTile label="Open" value={counts.open} sub={`${counts.openTracked} tracked · ${counts.openUntracked} not tracked`} tone={counts.openUntracked > 0 ? 'warn' : undefined} />
            <MetricTile label="Win" value={counts.win} tone="ok" />
            <MetricTile label="Loss" value={counts.loss} tone="bad" />
            <MetricTile label="Expired" value={counts.expired} sub="own category, never counted as win or loss" />
            <MetricTile label="Count in performance" value={counts.includedClosed} sub={`of ${counts.win + counts.loss + counts.expired} closed shown`} />
          </MetricGrid>
          {exclusions.length > 0 && (
            <p className="mt-3 text-sm text-[var(--text-secondary)]">
              Closed trades not counted in performance: {exclusions.map(([k, n]) => `${n} ${EXCLUSION_LABEL[k] ?? k.toLowerCase()}`).join(', ')}. Each is shown with its status.
            </p>
          )}
          {data && <p className="mt-1 text-xs text-[var(--text-secondary)]">Measurement-reliable period starts {formatIstDateTime(Date.parse(data.measurementReliableFrom), now)}; earlier trades are historical and were not recorded with the newer cost and tracking data.</p>}
        </Section>

        <Section title="Trades" actions={<span className="text-sm text-[var(--text-secondary)]">{shown.length} rows</span>}>
          <FilterBar label="Paper trade filters">
            <SegmentedControl label="State" value={filters.state} onChange={(v) => set('state', v)} options={STATE_OPTIONS} />
            <SegmentedControl<PeriodFilter>
              label="Period"
              value={filters.period}
              onChange={(v) => set('period', v)}
              options={[
                { id: 'ALL', label: 'All periods' },
                { id: 'HISTORICAL', label: 'Historical', title: 'Minted before the measurement-reliable start' },
                { id: 'RELIABLE', label: 'Measurement-reliable', title: 'Minted from the measurement-reliable start' },
              ]}
            />
            <SelectField label="Strategy" value={filters.family} onChange={(v) => set('family', v)} options={[{ id: '', label: 'All' }, ...families.map((f) => ({ id: f, label: f }))]} />
            <SelectField label="Version" value={filters.version} onChange={(v) => set('version', v)} options={[{ id: '', label: 'All' }, ...versions.map((f) => ({ id: f, label: f.length > 36 ? `${f.slice(0, 36)}…` : f }))]} />
            <SelectField label="Exchange" value={filters.exchange} onChange={(v) => set('exchange', v)} options={[{ id: '', label: 'All' }, { id: 'NSE', label: 'NSE' }, { id: 'BSE', label: 'BSE' }, { id: 'MCX', label: 'MCX' }]} />
            <SearchField value={filters.symbol} onChange={(v) => set('symbol', v)} placeholder="Symbol" label="Filter by symbol" />
            <ChipToggle pressed={!filters.includeExcluded} onToggle={() => set('includeExcluded', !filters.includeExcluded)} title="Hide closed trades that do not count in performance">
              Hide excluded
            </ChipToggle>
            <ActionButton onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</ActionButton>
          </FilterBar>
          <TradesTable trades={shown} now={now} apiReachable={feed.apiReachable} pageSize={25} />
        </Section>
      </DataState>
    </PageBody>
  );
}
