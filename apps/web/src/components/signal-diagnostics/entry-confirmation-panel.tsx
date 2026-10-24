'use client';

import { Section } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { formatNumber } from '@/lib/format';

interface Ledger { closed: number; open: number; unavailable: number; avgNetR: number | null; totalNetR: number | null; winRate: number | null; realisedDrawdownR: number | null }
export interface EntryConfirmationReport {
  version: string; enabled: boolean; status: 'AVAILABLE' | 'UNAVAILABLE'; note: string; reason?: string;
  activations?: Array<{ arm: string; activated_at: string }>;
  arms?: Array<{ arm: string; version: string; observed: number; passed: number; filtered: number; evidenceUnavailable: number; positions: number; official: Ledger; simulated: Ledger; avgEntryDelaySeconds: number | null; entryDelaySamples: number; avgEstimatedCostR: number | null }>;
  pairs?: Array<{ control: string; variant: string; filteredCandidates: number; controlPositions: number; noControlPosition: number; closedControl: number; pendingControl: number; missedWinners: number; avoidedLosers: number; flat: number; rejectedControlAvgNetR: number | null; simulatedClosedControl: number; simulatedMissedWinners: number; simulatedAvoidedLosers: number; simulatedRejectedAvgNetR: number | null }>;
  combinations?: Array<{ evidence: string; observed: number; passed: number; controlClosed: number; controlAvgNetR: number | null }>;
}
const names: Record<string, string> = { OB1C: 'OB1 first-touch control', OB1J: 'OB1 rejection close', OF1C: 'OF1 aligned control', OF1G: 'OF1 pressure + response' };

export function EntryConfirmationPanel({ data }: { data: EntryConfirmationReport }) {
  return <Section title="Entry confirmation experiments" subtitle="Exploratory shadow positions; current paper-entry rules stay unchanged.">
    <p className="mb-3 text-sm text-[var(--text-secondary)]">{data.version} · New entries {data.enabled ? 'enabled' : 'disabled'}. {data.note}</p>
    {data.status === 'UNAVAILABLE' ? <p>Comparison unavailable: {data.reason ?? 'not reported'}</p> : <>
      {!data.activations?.length && <p className="mb-3">Not activated yet. No forward results are available.</p>}
      <p className="mb-3 text-sm">OB1 requires a retest close beyond the block edge. OF1 requires both pressure and response evidence; these groups are not independent. Neither variant waits for a later candle. Compare outcomes over the same dates and instrument; small samples do not establish an edge.</p>
      <DataTable rows={data.arms ?? []} rowKey={(r) => r.arm} ariaLabel="Entry experiment coverage" pageSize={10} columns={[
        { id: 'arm', header: 'Arm', cell: (r) => names[r.arm] ?? r.arm },
        { id: 'obs', header: 'Observed', numeric: true, cell: (r) => r.observed },
        { id: 'pass', header: 'Rule passed', numeric: true, cell: (r) => r.passed },
        { id: 'filter', header: 'Filtered', numeric: true, cell: (r) => r.filtered },
        { id: 'missing', header: 'Evidence missing', numeric: true, cell: (r) => r.evidenceUnavailable },
        { id: 'pos', header: 'Positions', numeric: true, cell: (r) => r.positions },
        { id: 'delay', header: 'Avg entry delay (s)', numeric: true, cell: (r) => formatNumber(r.avgEntryDelaySeconds) },
        { id: 'cost', header: 'Avg estimated cost (R)', numeric: true, cell: (r) => formatNumber(r.avgEstimatedCostR) },
      ]} />
      {(['official', 'simulated'] as const).map((ledger) => <div className="mt-4" key={ledger}>
        <p className="mb-2 text-sm font-medium">{ledger === 'official' ? 'Official paper ledger — estimated round-trip costs included' : 'Quote-based simulated ledger — spread in fills; fees deducted'}</p>
        <DataTable rows={data.arms ?? []} rowKey={(r) => r.arm} ariaLabel={`${ledger} entry experiment outcomes`} pageSize={10} columns={[
          { id: 'arm', header: 'Arm', cell: (r) => names[r.arm] ?? r.arm },
          { id: 'closed', header: 'Closed', numeric: true, cell: (r) => r[ledger].closed },
          { id: 'open', header: 'Open / pending', numeric: true, cell: (r) => r[ledger].open },
          { id: 'missing', header: 'Unresolved / unavailable', numeric: true, cell: (r) => r[ledger].unavailable },
          { id: 'net', header: 'Avg net R', numeric: true, cell: (r) => formatNumber(r[ledger].avgNetR) },
          { id: 'total', header: 'Total net R', numeric: true, cell: (r) => formatNumber(r[ledger].totalNetR) },
          { id: 'wins', header: 'Win % (closed)', numeric: true, cell: (r) => formatNumber(r[ledger].winRate == null ? null : r[ledger].winRate! * 100) },
          { id: 'dd', header: 'Realised drawdown R', numeric: true, cell: (r) => formatNumber(r[ledger].realisedDrawdownR) },
        ]} />
      </div>)}
      {(data.pairs ?? []).map((p) => <p className="mt-3 text-sm" key={p.variant}>
        <strong>{names[p.variant]}</strong>: filtered {p.filteredCandidates}; matched closed controls {p.closedControl}; missed winners {p.missedWinners}; avoided losers {p.avoidedLosers}; flat {p.flat}; rejected-control avg net R {formatNumber(p.rejectedControlAvgNetR)} (official). Pending control outcomes {p.pendingControl}; no control position {p.noControlPosition}. Simulated: {p.simulatedClosedControl} closed controls, {p.simulatedMissedWinners} missed winners, {p.simulatedAvoidedLosers} avoided losers, avg net R {formatNumber(p.simulatedRejectedAvgNetR)}. Missing outcomes do not count as losses.
      </p>)}
      <div className="mt-4"><DataTable rows={data.combinations ?? []} rowKey={(r) => r.evidence} ariaLabel="OF1 confirmation combinations" pageSize={10} emptyTitle="No OF1 confirmation combinations recorded yet" columns={[
        { id: 'e', header: 'OF1 evidence combination', cell: (r) => r.evidence },
        { id: 'n', header: 'Observed', numeric: true, cell: (r) => r.observed },
        { id: 'p', header: 'Group rule passed', numeric: true, cell: (r) => r.passed },
        { id: 'c', header: 'Control closed', numeric: true, cell: (r) => r.controlClosed },
        { id: 'r', header: 'Control avg net R', numeric: true, cell: (r) => formatNumber(r.controlAvgNetR) },
      ]} /></div>
    </>}
  </Section>;
}
