'use client';

import React, { useMemo, useState } from 'react';
import { isMarketOpen, formatIndianNumber } from '@fno/shared';
import type { FnoScannerRow, BiasDirection, StrategyTrackRecord } from '@fno/shared';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { useStrategyTrackRecord } from '@/lib/use-strategy-track-record';
import { useAssetTabsStore } from '@/stores';
import { useNow } from '@/lib/use-health';
import { classifyFreshness, FRESH_WITHIN_MS } from '@/lib/freshness';
import { recommendStrategy, STRATEGY_MIN_CONFIDENCE, type StrategyCategory } from '@/lib/strategy-recommender';
import { formatSignedPercent, formatIstDateTime, MISSING } from '@/lib/format';
import { PageBody, PageHeader, Section } from '@/components/ui/card';
import { FilterBar, SearchField, SegmentedControl } from '@/components/ui/controls';
import { DataState } from '@/components/ui/data-state';
import { DataTable, type Column } from '@/components/ui/data-table';
import { FreshnessBadge } from '@/components/ui/status-badge';
import { BiasBadge, ScoreBadge } from '@/components/common/badges';

// ============================================================
// OPTION-BUYING LEANS (the Strategy Scanner)
// ============================================================
// An option-buying structure for each NSE F&O stock with a clear lean, matched from direction, IV rank and ATM theta. A
// heuristic, not a trade: it has no strike, stop, target or cost. The track record grades each day's calls against the
// next session. The rationale is one clamped line per row (the full text is one click away) — the same sentence repeated
// on 170 rows used to make this a 6000 px page.
// ============================================================

interface Row {
  row: FnoScannerRow;
  strategy: string;
  category: StrategyCategory;
  riskProfile: 'DEFINED_RISK';
  rationale: string;
}

type BiasFilter = '' | BiasDirection;

export function StrategyScannerPage() {
  const { rows, loading, error, meta, asOf, reload } = useFnoScanner('NSE');
  const { record: trackRecord, loading: trackLoading } = useStrategyTrackRecord();
  const openTab = useAssetTabsStore((s) => s.openTab);
  const [query, setQuery] = useState('');
  const [bias, setBias] = useState<BiasFilter>('');
  const now = useNow(5000);

  const withStrategy = useMemo<Row[]>(
    () =>
      rows
        .map((row) => {
          const rec = recommendStrategy(row);
          return rec ? { row, ...rec } : null;
        })
        .filter((r): r is Row => r !== null),
    [rows]
  );
  const shown = useMemo(() => {
    const q = query.trim().toUpperCase();
    return withStrategy.filter((r) => (!q || r.row.symbol.includes(q)) && (!bias || r.row.direction === bias));
  }, [withStrategy, query, bias]);

  const freshness = classifyFreshness({ observedAt: asOf, now, sessionOpen: isMarketOpen('NSE', now), transportConnected: error ? false : null, freshWithinMs: FRESH_WITHIN_MS.scan });

  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        id: 'symbol',
        header: 'Stock',
        sortValue: (r) => r.row.symbol,
        cell: (r) => (
          <button type="button" onClick={(e) => { e.stopPropagation(); openTab(r.row.symbol, r.row.exchange); }} title={`Open the ${r.row.symbol} workspace`} className="font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline">
            {r.row.symbol}
          </button>
        ),
      },
      { id: 'price', header: 'Price', numeric: true, sortValue: (r) => r.row.price, cell: (r) => formatIndianNumber(r.row.price, 2) },
      { id: 'chg', header: 'Chg %', numeric: true, sortValue: (r) => r.row.changePercent, cell: (r) => <span className={`font-medium ${r.row.changePercent >= 0 ? 'text-[var(--status-ok)]' : 'text-[var(--status-bad)]'}`}>{formatSignedPercent(r.row.changePercent)}</span> },
      { id: 'bias', header: 'Bias', sortValue: (r) => r.row.direction, cell: (r) => <BiasBadge bias={r.row.direction} /> },
      { id: 'conf', header: 'Conf', numeric: true, hideBelow: 'md', title: 'The scanner’s own confidence for the lean, 0 to 100', sortValue: (r) => r.row.confidence, cell: (r) => r.row.confidence },
      { id: 'score', header: 'Score', sortValue: (r) => r.row.score, cell: (r) => <ScoreBadge score={r.row.score} /> },
      { id: 'ivr', header: 'IV rank', numeric: true, hideBelow: 'md', sortValue: (r) => r.row.ivRank, cell: (r) => (r.row.ivRank != null ? r.row.ivRank : MISSING) },
      {
        id: 'strategy',
        header: 'Strategy',
        cell: (r) => (
          <div className="min-w-[150px]">
            <div className="font-semibold text-[var(--text-primary)]">{r.strategy}</div>
            <div className="text-xs text-[var(--text-secondary)]">Defined risk · option buying</div>
          </div>
        ),
      },
      { id: 'why', header: 'Rationale', hideBelow: 'lg', cell: (r) => <span className="line-clamp-2 max-w-md text-sm text-[var(--text-secondary)]">{r.rationale}</span> },
    ],
    [openTab]
  );

  return (
    <PageBody>
      <PageHeader
        title="Option-Buying Leans"
        subtitle={`The Strategy Scanner: an option-buying structure for NSE F&O stocks with a clear lean (confidence ${STRATEGY_MIN_CONFIDENCE}+), matched from direction, IV rank and ATM theta. Neutral or mixed stocks are left out. A heuristic: it has no strike, stop, target or cost, so it is not a trade. For ranked, tradable candidates see Best Setups.`}
        actions={
          <span className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
            <FreshnessBadge state={freshness.state} detail={freshness.detail} />
            {rows.length > 0 && <span>{shown.length} of {withStrategy.length} setups</span>}
          </span>
        }
      />

      <TrackRecordStrip record={trackRecord} loading={trackLoading} />

      <DataState
        loading={loading}
        error={error}
        hasData={rows.length > 0}
        onRetry={reload}
        errorTitle="Could not load the F&O scan"
        emptyTitle="No F&O scan has been recorded yet"
        emptyHint={meta?.unavailableReason ?? 'The server records a scan while the exchange is open.'}
        staleNote={meta?.source === 'LAST_KNOWN' || freshness.state === 'MARKET_CLOSED' ? `${freshness.detail} These leans come from the last recorded scan (${formatIstDateTime(asOf, now)}), not live data.` : undefined}
        skeletonRows={8}
      >
        <Section title="Leans" subtitle="Select a column heading to sort; expand a row for the full rationale.">
          <FilterBar label="Option-buying lean filters">
            <SearchField value={query} onChange={setQuery} placeholder="Symbol" label="Filter by symbol" />
            <SegmentedControl<BiasFilter> label="Bias" value={bias} onChange={setBias} options={[{ id: '', label: 'All' }, { id: 'BULLISH', label: 'Bullish' }, { id: 'BEARISH', label: 'Bearish' }]} />
          </FilterBar>
          <DataTable
            columns={columns}
            rows={shown}
            rowKey={(r) => r.row.symbol}
            ariaLabel="Option-buying leans"
            pageSize={25}
            maxHeight="70vh"
            initialSort={{ id: 'score', dir: 'desc' }}
            onRowClick={(r) => openTab(r.row.symbol, r.row.exchange)}
            renderDetail={(r) => (
              <p className="py-1 text-sm">
                <span className="text-[var(--text-secondary)]">Rationale: </span>
                {r.rationale}
              </p>
            )}
            emptyTitle="No setups match the current filters"
            emptyHint="Clear the filters to see every lean."
          />
          <p className="mt-3 max-w-4xl text-sm leading-relaxed text-[var(--text-secondary)]">
            Strategy shapes are matched from bias direction, score, IV rank and ATM theta only: the same lightweight signals as the other universe scanners, with no historical technicals or ADX. This is not strike selection or a real reward-to-risk number; open a stock's option chain to size an actual trade.
          </p>
        </Section>
      </DataState>
    </PageBody>
  );
}

// Grades the direction call only: the underlying's move from one session's 14:45 snapshot to the next. Option P&L also depends on
// strike, IV and decay, so a positive average move is necessary, not sufficient.
const TRACK_MIN_GRADED = 20;

function TrackRecordStrip({ record, loading }: { record: StrategyTrackRecord | null; loading: boolean }) {
  const shell = 'rounded-lg border border-[var(--border-secondary)] bg-[var(--surface-card)] px-4 py-3 text-sm';
  if (!record) return <div className={`${shell} text-[var(--text-secondary)]`}>{loading ? 'Loading the track record…' : 'The track record is unavailable right now.'}</div>;
  if (record.graded < TRACK_MIN_GRADED) {
    return (
      <div className={`${shell} text-[var(--text-secondary)]`}>
        <span className="font-semibold text-[var(--text-primary)]">Track record: building.</span> Recommendations are snapshotted at {record.snapshotTime} each session and graded at the next one: {record.graded} graded, {record.pending} pending
        {record.since ? ` since ${record.since}` : ''}. Treat the calls below as unproven until at least {TRACK_MIN_GRADED} are graded.
      </div>
    );
  }
  const good = (record.avgSignedMovePercent ?? 0) > 0 && (record.directionHitPercent ?? 0) > 50;
  return (
    <div className={shell}>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="font-semibold text-[var(--text-primary)]">Track record</span>
        <span className="tabular-nums">
          Direction right <b className={good ? 'text-[var(--status-ok)]' : 'text-[var(--status-warn)]'}>{record.directionHitPercent}%</b> of {record.graded} graded
        </span>
        <span className="tabular-nums">
          Average move the called way <b>{formatSignedPercent(record.avgSignedMovePercent)}</b> by the next session
        </span>
        <span className="text-[var(--text-secondary)]">{record.snapshots} sessions since {record.since}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-[var(--text-secondary)]">
        {record.byConfidence.filter((b) => b.graded > 0).map((b) => (
          <span key={b.label}>
            Conf {b.label}: {b.directionHitPercent}% · {formatSignedPercent(b.avgSignedMovePercent)} (n={b.graded})
          </span>
        ))}
        {record.byStrategy.filter((b) => b.graded > 0).map((b) => (
          <span key={b.label}>
            {b.label}: {b.directionHitPercent}% (n={b.graded})
          </span>
        ))}
      </div>
    </div>
  );
}
