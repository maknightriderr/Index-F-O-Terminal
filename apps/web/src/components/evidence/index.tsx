'use client';

import React, { useMemo } from 'react';
import { PageBody, PageHeader, Section, MetricGrid, MetricTile } from '@/components/ui/card';
import { ActionButton, SimulatedNotice } from '@/components/ui/controls';
import { DataTable, type Column } from '@/components/ui/data-table';
import { DataState } from '@/components/ui/data-state';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { PerformanceNav } from '@/components/performance/performance-nav';
import {
  useEvidenceReport,
  type ScorecardEntry,
  type ScorecardReport,
  type SignalQualityReport,
  type GateValidationReport,
  type PortfolioRiskReport,
  type ScorecardAction,
  type ClusterStat,
  type HorizonStat,
} from '@/lib/use-evidence';
import { formatR, formatNumber, MISSING } from '@/lib/format';

// ============================================================
// EVIDENCE — does anything here have an edge? (2026-10-15)
// ============================================================
// Four server reports, shown as returned: the strategy scorecard (with the
// written promote / demote rule; the Old Indicator is protected), whether the
// direction call predicts the next hour, whether each gate removes worse
// trades, and what the portfolio limits already in the code would have done
// to the paper book. Every figure carries its count and a 95% interval that
// resamples whole trading days. Nothing on this page changes what is traded.
// ============================================================

const ACTION: Record<ScorecardAction, { tone: Tone; label: string }> = {
  PROTECTED_BENCHMARK: { tone: 'info', label: 'PROTECTED BENCHMARK' },
  PROMOTE_ELIGIBLE: { tone: 'ok', label: 'EDGE SHOWN' },
  DEMOTE_CANDIDATE: { tone: 'bad', label: 'DEMOTION CANDIDATE' },
  KEEP_MEASURING: { tone: 'off', label: 'KEEP MEASURING' },
};

const withInterval = (s: { mean: number | null; lo: number | null; hi: number | null }, fmt: (v: number | null) => string = (v) => formatR(v)) =>
  s.mean == null ? MISSING : s.lo == null || s.hi == null ? `${fmt(s.mean)} (too few days)` : `${fmt(s.mean)} (${fmt(s.lo)} to ${fmt(s.hi)})`;
const atr = (v: number | null) => (v == null ? MISSING : `${v > 0 ? '+' : ''}${v.toFixed(3)} ATR`);
const pct = (v: number | null) => (v == null ? MISSING : `${v.toFixed(1)}%`);

function scorecardColumns(gross: boolean): Column<ScorecardEntry>[] {
  return [
    { id: 'strategy', header: 'Strategy', sortValue: (r) => r.strategy, cell: (r) => <span className="font-medium">{r.strategy === 'INDICATOR' ? 'Old Indicator' : r.strategy}</span> },
    { id: 'n', header: gross ? 'Candidates' : 'Trades', numeric: true, sortValue: (r) => r.n, cell: (r) => `${r.n} · ${r.days}d` },
    { id: 'wle', header: 'Win / loss / expired', numeric: true, hideBelow: 'md', cell: (r) => `${r.wins} / ${r.losses} / ${r.expired}` },
    { id: 'wr', header: 'Win rate closed · all', numeric: true, hideBelow: 'lg', title: 'wins ÷ (wins + losses) · wins ÷ every trade', cell: (r) => `${pct(r.winRateClosedOnly)} · ${pct(r.winRateAllTrades)}` },
    { id: 'net', header: gross ? 'Gross R / candidate (95%)' : 'Net R / trade (95%)', numeric: true, sortValue: (r) => r.netR.mean, cell: (r) => withInterval(r.netR) },
    { id: 'wl', header: 'Avg win · avg loss', numeric: true, hideBelow: 'xl', cell: (r) => `${formatR(r.avgNetWin)} · ${formatR(r.avgNetLoss)}` },
    { id: 'halves', header: '1st half · 2nd half', numeric: true, hideBelow: 'lg', title: 'Mean of the first and second half of the strategy’s own trading days', cell: (r) => `${formatR(r.firstHalfNetR)} · ${formatR(r.secondHalfNetR)}` },
    {
      id: 'action',
      header: 'Rule says',
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={ACTION[r.action].tone} label={ACTION[r.action].label} title={r.reason} />
          {r.currentStage && <span className="text-xs text-[var(--text-secondary)]">already {r.currentStage.stage} since {r.currentStage.since}</span>}
        </span>
      ),
    },
  ];
}

function Scorecard() {
  const { data, loading, error, reload } = useEvidenceReport<ScorecardReport>('scorecard');
  const paperCols = useMemo(() => scorecardColumns(false), []);
  const candCols = useMemo(() => scorecardColumns(true), []);
  const detail = (r: ScorecardEntry) => (
    <p className="text-sm">
      {r.reason} Interval corrected for {r.netRCorrected.comparisons} strategies: {formatR(r.netRCorrected.lo)} to {formatR(r.netRCorrected.hi)}.
    </p>
  );
  return (
    <Section title="Strategy scorecard" subtitle="Which strategies have shown an edge after estimated costs, by the written rule. The rule only proposes; every change is your decision." actions={<ActionButton onClick={reload}>Refresh</ActionButton>}>
      <DataState loading={loading} error={error} hasData={!!data} onRetry={reload} errorTitle="Could not load the scorecard">
        {data && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">{data.note}</p>
            <p className="text-sm text-[var(--text-secondary)]">
              Rule {data.rules.VERSION}: demotion candidate at {data.rules.MIN_N_DEMOTE}+ trades with the upper bound below 0; edge shown at {data.rules.MIN_N_PROMOTE}+ trades over {data.rules.MIN_DAYS_PROMOTE}+ trading days with the corrected lower bound above 0 and both halves positive.
            </p>
            <h4 className="text-sm font-semibold">Paper trades since 5 Oct (net of estimated costs)</h4>
            <DataTable columns={paperCols} rows={data.paper} rowKey={(r) => r.strategy} ariaLabel="Paper-trade scorecard" pageSize={25} renderDetail={detail} emptyTitle="No closed paper trades yet" />
            <h4 className="text-sm font-semibold">Measurement-reliable trades only (from 12 Oct)</h4>
            <DataTable columns={paperCols} rows={data.measurementReliable} rowKey={(r) => r.strategy} ariaLabel="Reliable-sample scorecard" pageSize={25} renderDetail={detail} emptyTitle="No reliable-sample trades yet" />
            <h4 className="text-sm font-semibold">Every graded trigger-family candidate (underlying R, before option costs)</h4>
            <DataTable columns={candCols} rows={data.candidates} rowKey={(r) => r.strategy} ariaLabel="Candidate scorecard" pageSize={25} renderDetail={detail} emptyTitle="No graded candidates yet" />
          </div>
        )}
      </DataState>
    </Section>
  );
}

function SignalQuality() {
  const { data, loading, error, reload } = useEvidenceReport<SignalQualityReport>('signal-quality');
  const hzCols = useMemo<Column<HorizonStat & { label: string }>[]>(
    () => [
      { id: 'h', header: 'After', cell: (r) => r.label },
      { id: 'n', header: 'Decisions', numeric: true, cell: (r) => r.n },
      { id: 'm', header: 'Move the call’s way (95%)', numeric: true, cell: (r) => withInterval(r, atr) },
      { id: 'hit', header: 'Right', numeric: true, cell: (r) => pct(r.hitRate) },
    ],
    []
  );
  const groupCols = useMemo<Column<HorizonStat & { key: string }>[]>(
    () => [
      { id: 'k', header: 'Group', cell: (r) => r.key },
      { id: 'n', header: 'Decisions', numeric: true, cell: (r) => r.n },
      { id: 'm', header: 'Move after 60 min (95%)', numeric: true, cell: (r) => withInterval(r, atr) },
      { id: 'hit', header: 'Right', numeric: true, cell: (r) => pct(r.hitRate) },
    ],
    []
  );
  const dimCols = useMemo<Column<SignalQualityReport['dimensions'][number]>[]>(
    () => [
      { id: 'd', header: 'Vote dimension', cell: (r) => r.dimension },
      { id: 'n', header: 'Decisions', numeric: true, cell: (r) => r.n },
      {
        id: 'rho',
        header: 'Rank correlation with the next hour (95%)',
        numeric: true,
        cell: (r) => (r.rho == null ? MISSING : `${formatNumber(r.rho, 3)} (${formatNumber(r.lo, 3)} to ${formatNumber(r.hi, 3)})`),
      },
      { id: 'v', header: 'Reading', cell: (r) => (r.lo != null && r.lo > 0 ? <StatusBadge tone="ok" label="CARRIES INFORMATION" /> : r.hi != null && r.hi < 0 ? <StatusBadge tone="bad" label="POINTS THE WRONG WAY" /> : <StatusBadge tone="off" label="NO SIGNAL SHOWN" />) },
    ],
    []
  );
  return (
    <Section title="Does the direction call predict the market?" subtitle="Every intraday decision, taken or refused, followed to the same symbol’s later price. 50% right is a coin flip.">
      <DataState loading={loading} error={error} hasData={!!data} onRetry={reload} errorTitle="Could not load the signal-quality report">
        {data && (
          <div className="space-y-4">
            <MetricGrid>
              <MetricTile label="Decisions" value={data.decisions.toLocaleString('en-IN')} sub={`${data.days} trading days · ${data.symbols} symbols`} />
              <MetricTile label="Right after 60 min" value={pct(data.horizons.find((h) => h.minutes === 60)?.hitRate ?? null)} tone="neutral" />
              <MetricTile label="Agrees with last-hour momentum" value={pct(data.agreesWithMomentumPct)} sub="share of calls that simply follow the last 60 minutes" />
              <MetricTile label="Trivial baseline after 60 min" value={pct(data.baseline60.hitRate)} sub="trading the last hour’s direction instead" />
            </MetricGrid>
            <p className="text-sm text-[var(--text-secondary)]">{data.note}</p>
            <DataTable
              columns={hzCols}
              rows={[...data.horizons.map((h) => ({ ...h, label: `${h.minutes} min` })), { ...data.toDayEnd, label: 'Rest of the session' }, { ...data.baseline60, label: 'Baseline: last-hour momentum, 60 min' }]}
              rowKey={(r) => r.label}
              ariaLabel="Direction call by horizon"
              pageSize={10}
            />
            <div className="grid gap-4 lg:grid-cols-2">
              <DataTable columns={groupCols} rows={data.byExchange} rowKey={(r) => r.key} ariaLabel="By exchange" pageSize={10} />
              <DataTable columns={groupCols} rows={data.byConfidence} rowKey={(r) => r.key} ariaLabel="By confidence" pageSize={10} />
            </div>
            <DataTable columns={dimCols} rows={data.dimensions} rowKey={(r) => r.dimension} ariaLabel="Vote dimensions" pageSize={12} />
          </div>
        )}
      </DataState>
    </Section>
  );
}

function GateValidation() {
  const { data, loading, error, reload } = useEvidenceReport<GateValidationReport>('gate-validation');
  const VERDICT: Record<GateValidationReport['gates'][number]['verdict'], { tone: Tone; label: string }> = {
    FILTERS_WORSE: { tone: 'ok', label: 'REMOVES WORSE TRADES' },
    REFUSES_NO_WORSE: { tone: 'warn', label: 'REFUSES TRADES NO WORSE' },
    INCONCLUSIVE: { tone: 'off', label: 'INCONCLUSIVE' },
  };
  const cols = useMemo<Column<GateValidationReport['gates'][number]>[]>(
    () => [
      { id: 'c', header: 'Refusal', cell: (r) => r.code.replace(/_/g, ' ').toLowerCase() },
      { id: 'n', header: 'Refused', numeric: true, sortValue: (r) => r.refused.n, cell: (r) => `${r.refused.n} · ${r.refused.clusters}d` },
      { id: 'r', header: 'Refused graded R (95%)', numeric: true, cell: (r) => withInterval(r.refused) },
      { id: 'd', header: 'Minus taken (95%)', numeric: true, cell: (r) => withInterval({ mean: r.diffVsTaken.diff, lo: r.diffVsTaken.lo, hi: r.diffVsTaken.hi }) },
      {
        id: 'v',
        header: 'Reading',
        cell: (r) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={VERDICT[r.verdict].tone} label={VERDICT[r.verdict].label} />
            {r.tooFewDays && <span className="text-xs text-[var(--text-secondary)]">refused on {r.refused.clusters} day{r.refused.clusters === 1 ? '' : 's'} only</span>}
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  return (
    <Section title="Do the gates remove worse trades?" subtitle="What each refusal code refused, graded the same way as what was taken.">
      <DataState loading={loading} error={error} hasData={!!data} onRetry={reload} errorTitle="Could not load the gate report">
        {data && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">{data.note}</p>
            <p className="text-sm">Taken decisions: {withInterval(data.taken as ClusterStat)} over {data.taken.n}.</p>
            <DataTable columns={cols} rows={data.gates} rowKey={(r) => r.code} ariaLabel="Gate validation" pageSize={20} />
          </div>
        )}
      </DataState>
    </Section>
  );
}

function PortfolioRisk() {
  const { data, loading, error, reload } = useEvidenceReport<PortfolioRiskReport>('portfolio-risk');
  type Row = { id: string; label: string; source: string; stats: PortfolioRiskReport['baseline']; skippedTotal: number };
  const cols = useMemo<Column<Row>[]>(
    () => [
      { id: 'l', header: 'Book', cell: (r) => <span><span className="font-medium">{r.label}</span><span className="block text-xs text-[var(--text-secondary)]">{r.source}</span></span> },
      { id: 't', header: 'Trades', numeric: true, cell: (r) => `${r.stats.trades}${r.skippedTotal ? ` (−${r.skippedTotal})` : ''}` },
      { id: 'm', header: 'Net R / trade', numeric: true, cell: (r) => formatR(r.stats.meanNetR) },
      { id: 's', header: 'Total net R', numeric: true, cell: (r) => formatR(r.stats.totalNetR) },
      { id: 'w', header: 'Worst day', numeric: true, cell: (r) => formatR(r.stats.worstDayR) },
      { id: 'd', header: 'Max drawdown', numeric: true, cell: (r) => formatR(-r.stats.maxDrawdownR) },
      { id: 'o', header: 'Most open · same way', numeric: true, hideBelow: 'md', cell: (r) => `${r.stats.maxOpen} · ${r.stats.maxSameDirection}` },
    ],
    []
  );
  return (
    <Section title="Portfolio limits already in the code (switched off)" subtitle="The paper book replayed under each limit: what it would remove, and what that does to results and risk.">
      <DataState loading={loading} error={error} hasData={!!data} onRetry={reload} errorTitle="Could not load the portfolio replay">
        {data && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">{data.note}</p>
            <DataTable
              columns={cols}
              rows={[{ id: 'BASELINE', label: 'As traded', source: 'every paper trade since 5 Oct', stats: data.baseline, skippedTotal: 0 }, ...data.variants]}
              rowKey={(r) => r.id}
              ariaLabel="Portfolio limits replay"
              pageSize={10}
            />
          </div>
        )}
      </DataState>
    </Section>
  );
}

export function EvidencePage() {
  return (
    <>
      <PerformanceNav />
      <PageBody>
        <PageHeader
          title="Evidence"
          subtitle="Whether any strategy, signal, gate or limit has shown an edge in the recorded data, with intervals. This page measures; it changes nothing that is traded."
        />
        <SimulatedNotice />
        <Scorecard />
        <SignalQuality />
        <GateValidation />
        <PortfolioRisk />
      </PageBody>
    </>
  );
}
