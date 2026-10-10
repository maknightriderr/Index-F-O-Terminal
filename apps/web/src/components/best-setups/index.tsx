'use client';

import React, { useMemo, useState } from 'react';
import { isMarketOpen } from '@fno/shared';
import { PageBody, PageHeader, Section } from '@/components/ui/card';
import { ActionButton, Disclosure, FilterBar, SearchField, SegmentedControl, SelectField } from '@/components/ui/controls';
import { DataState } from '@/components/ui/data-state';
import { FreshnessBadge, type DecisionState } from '@/components/ui/status-badge';
import { useBestSetups } from '@/lib/use-best-setups';
import { useNow } from '@/lib/use-health';
import { classifyFreshness, FRESH_WITHIN_MS } from '@/lib/freshness';
import { DEFAULT_SETUP_FILTERS, filterSetups, type SetupFilters } from '@/lib/setups';
import { SetupsTable } from './setups-table';

const STATUS_OPTIONS: ReadonlyArray<{ id: '' | DecisionState; label: string; title?: string }> = [
  { id: '', label: 'All' },
  { id: 'LIVE_PAPER_ELIGIBLE', label: 'Live paper-eligible', title: 'Can create a paper trade if every gate passes' },
  { id: 'SHADOW_ONLY', label: 'Shadow only', title: 'Measured only; can never create a paper trade' },
  { id: 'REJECTED', label: 'Rejected', title: 'A gate or the scan refused it' },
  { id: 'UNAVAILABLE', label: 'Unavailable' },
];

export function BestSetupsPage() {
  const s = useBestSetups();
  const now = useNow(5000);
  const [filters, setFilters] = useState<SetupFilters>(DEFAULT_SETUP_FILTERS);
  const set = <K extends keyof SetupFilters>(k: K, v: SetupFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const shown = useMemo(() => filterSetups(s.rows, filters), [s.rows, filters]);
  const families = useMemo(() => [...new Set(s.rows.map((r) => r.family))].sort(), [s.rows]);
  const freshness = classifyFreshness({ observedAt: s.scannedAt, now, sessionOpen: isMarketOpen('NSE', now), transportConnected: s.error ? false : null, freshWithinMs: FRESH_WITHIN_MS.scan });
  const counts = useMemo(() => {
    const c = { LIVE_PAPER_ELIGIBLE: 0, SHADOW_ONLY: 0, REJECTED: 0, UNAVAILABLE: 0 };
    for (const r of s.rows) c[r.decision]++;
    return c;
  }, [s.rows]);

  return (
    <PageBody>
      <PageHeader
        title="Best Setups"
        subtitle="Every recorded candidate in one ranked list, with whether it can create a paper trade and why it was accepted or rejected. Nothing here is a trade until the engine mints one."
        actions={
          <>
            <FreshnessBadge state={freshness.state} detail={freshness.detail} />
            <ActionButton onClick={() => void s.runScan()} disabled={s.scanRunning || !isMarketOpen('NSE', now)} title={isMarketOpen('NSE', now) ? 'Runs the market scan now. It records the same decision rows as the background scan, so it only happens when you press this.' : 'NSE is closed: a scan only runs in session, so there is nothing to run now. The last recorded scan stays on screen.'}>
              {s.scanRunning ? 'Running scan…' : 'Run scan now'}
            </ActionButton>
          </>
        }
      />
      <DataState
        loading={s.loading}
        error={s.error}
        hasData={s.rows.length > 0}
        isEmpty={s.rows.length === 0}
        errorTitle="Could not load the recorded scan"
        emptyTitle="No setups have been recorded yet"
        emptyHint={s.scanMeta?.unavailableReason ?? 'The scan runs every five minutes while NSE is open, and structure setups appear as they develop.'}
        staleNote={freshness.state === 'MARKET_CLOSED' ? `${freshness.detail} These are the last recorded candidates, not live opportunities.` : freshness.state === 'STALE' ? freshness.detail : undefined}
        skeletonRows={6}
      >
        <Section
          title="Candidates"
          subtitle={`${counts.LIVE_PAPER_ELIGIBLE} live paper-eligible · ${counts.SHADOW_ONLY} shadow only · ${counts.REJECTED} rejected · ${counts.UNAVAILABLE} unavailable`}
        >
          <FilterBar label="Setup filters">
            <SegmentedControl label="Decision state" value={filters.status} onChange={(v) => set('status', v)} options={STATUS_OPTIONS} />
            <SegmentedControl label="Direction" value={filters.direction} onChange={(v) => set('direction', v)} options={[{ id: '', label: 'Any' }, { id: 'BULLISH', label: 'Bullish' }, { id: 'BEARISH', label: 'Bearish' }]} />
            <SelectField label="Strategy" value={filters.family} onChange={(v) => set('family', v)} options={[{ id: '', label: 'All' }, ...families.map((f) => ({ id: f, label: f }))]} />
            <SelectField label="Exchange" value={filters.exchange} onChange={(v) => set('exchange', v)} options={[{ id: '', label: 'All' }, { id: 'NSE', label: 'NSE' }, { id: 'BSE', label: 'BSE' }, { id: 'MCX', label: 'MCX' }]} />
            <SearchField value={filters.query} onChange={(v) => set('query', v)} placeholder="Symbol" label="Filter by symbol" />
            <ActionButton onClick={() => setFilters(DEFAULT_SETUP_FILTERS)}>Clear filters</ActionButton>
          </FilterBar>
          <SetupsTable rows={shown} now={now} />
        </Section>
        <Disclosure summary="How to read the decision states">
          <p>
            <strong>Live paper-eligible</strong>: the strategy family trades on paper, and no refusal is recorded. It becomes a paper trade only if every gate passes when it fills.
          </p>
          <p>
            <strong>Shadow only</strong>: the family is measured, never traded. It cannot create a paper trade.
          </p>
          <p>
            <strong>Rejected</strong>: the scan declined the mover, or the live engine refused it at the fill. The reason shown is the recorded one.
          </p>
          <p>
            <strong>Unavailable</strong>: the family is retired, or its live stage is not recorded.
          </p>
          <p>Scores order and describe candidates; they never gate a trade. Estimated costs are model estimates, not actual fills.</p>
        </Disclosure>
      </DataState>
    </PageBody>
  );
}
