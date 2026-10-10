'use client';

import React, { useMemo } from 'react';
import { useAssetTabsStore } from '@/stores';
import { DataTable, type Column } from '@/components/ui/data-table';
import { DecisionBadge } from '@/components/ui/status-badge';
import { formatNumber, formatIstDateTime, MISSING } from '@/lib/format';
import type { SetupRow } from '@/lib/setups';
import type { Exchange } from '@fno/shared';

// ============================================================
// SETUPS TABLE — ranked candidates with their decision state
// ============================================================
// Planned levels are the recorded ones: option premium for a scan candidate or a confirmed structure preview,
// the underlying's levels for a lifecycle that has no option preview yet (labelled). The reason a setup was
// accepted or rejected is the record's own text, shown in full on expansion. Estimated cost is labelled an estimate.
// ============================================================

const BASIS_LABEL = { OPTION_PREMIUM: 'option premium', UNDERLYING: 'underlying price', NONE: '' } as const;

function SymbolLink({ r }: { r: SetupRow }) {
  const openTab = useAssetTabsStore((s) => s.openTab);
  return (
    <button type="button" onClick={() => openTab(r.symbol, r.exchange as Exchange)} title={`Open the ${r.symbol} workspace`} className="font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline">
      {r.symbol}
    </button>
  );
}

function Levels({ r }: { r: SetupRow }) {
  if (r.levels.basis === 'NONE') return <span className="text-[var(--text-secondary)]">{MISSING}</span>;
  return (
    <div className="text-sm tabular-nums">
      <div>
        <span className="text-[var(--text-secondary)]">E</span> {formatNumber(r.levels.entry)} <span className="text-[var(--text-secondary)]">S</span> {formatNumber(r.levels.stop)} <span className="text-[var(--text-secondary)]">T</span> {formatNumber(r.levels.target)}
      </div>
      <div className="text-xs text-[var(--text-secondary)]">planned, {BASIS_LABEL[r.levels.basis]}</div>
    </div>
  );
}

export function SetupDetail({ r, now }: { r: SetupRow; now: number }) {
  return (
    <div className="space-y-2 py-1 text-sm">
      <p>
        <span className="text-[var(--text-secondary)]">Decision: </span>
        <span className="font-medium text-[var(--text-primary)]">{r.decisionReason ?? (r.decision === 'LIVE_PAPER_ELIGIBLE' ? 'Eligible; no refusal is recorded. It becomes a paper trade only if every gate passes when it fills.' : 'No reason is recorded.')}</span>
      </p>
      {r.evidence.length > 0 && (
        <div>
          <p className="text-[var(--text-secondary)]">Confirming evidence</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {r.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {r.concern && (
        <p>
          <span className="text-[var(--text-secondary)]">Main concern: </span>
          {r.concern}
        </p>
      )}
      <p className="text-xs text-[var(--text-secondary)]">
        Source: {r.source === 'MARKET_SCAN' ? 'market scan' : r.source === 'DECLINED' ? 'market scan (declined mover)' : 'structure watchlist'} · recorded {formatIstDateTime(r.observedAt, now)} · stage {r.stage ?? 'not recorded'}
        {r.estimatedCostPct != null ? ` · estimated cost ${formatNumber(r.estimatedCostPct)}% of premium (an estimate, not an actual fill)` : ''}. Entry timing (optimal / early / late) is not part of this record.
      </p>
    </div>
  );
}

export function SetupsTable({ rows, now, pageSize = 20, maxHeight, ariaLabel = 'Best setups' }: { rows: readonly SetupRow[]; now: number; pageSize?: number; maxHeight?: string; ariaLabel?: string }) {
  const columns = useMemo<Column<SetupRow>[]>(
    () => [
      {
        id: 'symbol',
        header: 'Setup',
        label: 'Setup',
        sortValue: (r) => r.symbol,
        cell: (r) => (
          <div className="min-w-[140px]">
            <SymbolLink r={r} /> <span className="text-xs text-[var(--text-secondary)]">{r.exchange}</span>
            <div className="text-xs text-[var(--text-secondary)]">
              {r.familyLabel} · {r.direction === 'BULLISH' ? '▲ bullish' : '▼ bearish'}
            </div>
          </div>
        ),
      },
      { id: 'decision', header: 'Decision', label: 'Decision', sortValue: (r) => r.decision, cell: (r) => <DecisionBadge state={r.decision} /> },
      { id: 'score', header: 'Score', numeric: true, sortValue: (r) => r.score, cell: (r) => (r.score != null ? r.score : MISSING) },
      { id: 'levels', header: 'Planned levels', hideBelow: 'md', cell: (r) => <Levels r={r} /> },
      { id: 'rr', header: 'R:R', numeric: true, hideBelow: 'md', title: 'Planned reward:risk as recorded (gross of estimated costs)', sortValue: (r) => r.rewardRisk, cell: (r) => (r.rewardRisk != null ? r.rewardRisk.toFixed(2) : MISSING) },
      { id: 'cost', header: 'Est. cost', numeric: true, hideBelow: 'lg', title: 'Estimated round-trip cost, % of premium: a model, not an actual fill', sortValue: (r) => r.estimatedCostPct, cell: (r) => (r.estimatedCostPct != null ? `${formatNumber(r.estimatedCostPct)}% est.` : MISSING) },
      { id: 'regime', header: 'Regime', hideBelow: 'lg', cell: (r) => (r.regime ? r.regime.replace(/_/g, ' ').toLowerCase() : MISSING) },
      {
        id: 'why',
        header: 'Why / main concern',
        hideBelow: 'lg',
        cell: (r) => <span className="line-clamp-2 max-w-[28rem] text-sm text-[var(--text-secondary)]">{r.concern ?? r.decisionReason ?? r.evidence[0] ?? MISSING}</span>,
      },
    ],
    []
  );
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      ariaLabel={ariaLabel}
      pageSize={pageSize}
      maxHeight={maxHeight}
      renderDetail={(r) => <SetupDetail r={r} now={now} />}
      emptyTitle="No setups match"
      emptyHint="Change a filter, or wait for the next scan: candidates are recorded while the exchange is open."
    />
  );
}
