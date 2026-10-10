'use client';

import React, { useMemo, useState } from 'react';
import { isMarketOpen } from '@fno/shared';
import { useMarketStore } from '@/stores';
import { useBestSetups } from '@/lib/use-best-setups';
import { useNow } from '@/lib/use-health';
import { classifyFreshness, FRESH_WITHIN_MS } from '@/lib/freshness';
import { DEFAULT_SETUP_FILTERS, filterSetups, type SetupFilters } from '@/lib/setups';
import { Section } from '@/components/ui/card';
import { ActionButton, FilterBar, SegmentedControl } from '@/components/ui/controls';
import { DataState } from '@/components/ui/data-state';
import { FreshnessBadge, type DecisionState } from '@/components/ui/status-badge';
import { SetupsTable } from '@/components/best-setups/setups-table';

// ============================================================
// SECTION D — BEST CURRENT SETUPS (compact)
// ============================================================
// The top of the ranked list from the Best Setups page: candidates with their decision state (live paper-eligible, shadow
// only, rejected, unavailable) and the recorded reason. A shadow-only signal is never presented as able to trade.
// ============================================================

const STATUS: ReadonlyArray<{ id: '' | DecisionState; label: string }> = [
  { id: '', label: 'All' },
  { id: 'LIVE_PAPER_ELIGIBLE', label: 'Live paper-eligible' },
  { id: 'SHADOW_ONLY', label: 'Shadow only' },
  { id: 'REJECTED', label: 'Rejected' },
];

export function BestSetupsPanel() {
  const s = useBestSetups();
  const now = useNow(5000);
  const setActiveTab = useMarketStore((st) => st.setActiveTab);
  const [filters, setFilters] = useState<SetupFilters>(DEFAULT_SETUP_FILTERS);
  const shown = useMemo(() => filterSetups(s.rows, filters).slice(0, 8), [s.rows, filters]);
  const freshness = classifyFreshness({ observedAt: s.scannedAt, now, sessionOpen: isMarketOpen('NSE', now), transportConnected: s.error ? false : null, freshWithinMs: FRESH_WITHIN_MS.scan });

  return (
    <Section
      title="Best current setups"
      subtitle="Recorded candidates, ranked. Nothing is a trade until an engine mints one."
      actions={
        <>
          <FreshnessBadge state={freshness.state} detail={freshness.detail} />
          <ActionButton onClick={() => setActiveTab('best-setups')}>All setups →</ActionButton>
        </>
      }
    >
      <DataState
        loading={s.loading}
        error={s.error}
        hasData={s.rows.length > 0}
        isEmpty={s.rows.length === 0}
        errorTitle="Could not load the recorded scan"
        emptyTitle="No setups recorded yet"
        emptyHint={s.scanMeta?.unavailableReason ?? 'Candidates are recorded while the exchange is open.'}
        staleNote={freshness.state === 'MARKET_CLOSED' ? `${freshness.detail} The last recorded candidates are shown, not live opportunities.` : undefined}
        skeletonRows={4}
      >
        <FilterBar label="Setup filters">
          <SegmentedControl label="Decision state" value={filters.status} onChange={(v) => setFilters((f) => ({ ...f, status: v }))} options={STATUS} />
          <SegmentedControl label="Direction" value={filters.direction} onChange={(v) => setFilters((f) => ({ ...f, direction: v }))} options={[{ id: '', label: 'Any' }, { id: 'BULLISH', label: 'Bullish' }, { id: 'BEARISH', label: 'Bearish' }]} />
        </FilterBar>
        <SetupsTable rows={shown} now={now} pageSize={8} ariaLabel="Best current setups" />
      </DataState>
    </Section>
  );
}
