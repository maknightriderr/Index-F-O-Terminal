'use client';

import React, { useMemo } from 'react';
import { PageBody, PageHeader, Section, MetricGrid, MetricTile } from '@/components/ui/card';
import { ActionButton, SimulatedNotice } from '@/components/ui/controls';
import { DataTable, type Column } from '@/components/ui/data-table';
import { DataState, EmptyState, ErrorNotice } from '@/components/ui/data-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { PerformanceNav, MetricDefinitions } from '@/components/performance/performance-nav';
import { useMeasurement, type MeasurementReport, type Tally } from '@/lib/use-measurement';
import { displayTally, reliabilityLines, SMALL_SAMPLE_BELOW } from '@/lib/measurement-view';
import { MISSING } from '@/lib/format';

// ============================================================
// MEASUREMENT — how much the numbers can be trusted
// ============================================================
// Reads the deployed /api/diagnostics/measurement report as returned. Every figure shows its denominator; modelled
// values are labelled as models; historical trades and the measurement-reliable sample are separate tables and are
// never combined. A capability the deployed API does not include, or has no data for yet, is shown as NOT AVAILABLE or
// NOT YET VERIFIED, never as zero and never as an expected value.
// ============================================================

interface TallyRow {
  key: string;
  cohort: string;
  group: string;
  tally: Tally;
}

function useTallyColumns(showGroup: boolean): Column<TallyRow>[] {
  return useMemo(() => {
    const cols: Column<TallyRow>[] = [{ id: 'cohort', header: 'Cohort', sortValue: (r) => r.cohort, cell: (r) => <span className="font-medium">{r.cohort.replace('_', ' ')}</span> }];
    if (showGroup) cols.push({ id: 'group', header: 'Strategy / instrument', sortValue: (r) => r.group, cell: (r) => r.group });
    cols.push(
      { id: 'n', header: 'Closed counted', numeric: true, sortValue: (r) => r.tally.n, cell: (r) => <span>{r.tally.n}{displayTally(r.tally).smallSample && <span className="ml-1 text-xs text-[var(--status-warn)]" title={`Fewer than ${SMALL_SAMPLE_BELOW} closed trades: a sample, not evidence`}>small sample</span>}</span> },
      { id: 'wlx', header: 'Win / loss / expired', numeric: true, cell: (r) => `${r.tally.wins} / ${r.tally.losses} / ${r.tally.expired}` },
      { id: 'wrc', header: 'Win rate (closed only)', title: 'wins ÷ (wins + losses); expired excluded', numeric: true, hideBelow: 'md', cell: (r) => displayTally(r.tally).winRateClosed },
      { id: 'wra', header: 'Win rate (all trades)', title: 'wins ÷ (wins + losses + expired)', numeric: true, hideBelow: 'md', cell: (r) => displayTally(r.tally).winRateAll },
      { id: 'g', header: 'Gross R / trade', numeric: true, hideBelow: 'lg', cell: (r) => displayTally(r.tally).grossR },
      { id: 'n2', header: 'Net R est. / trade', title: 'After the ESTIMATED cost; only trades with a recorded cost %', numeric: true, hideBelow: 'lg', cell: (r) => displayTally(r.tally).netR },
      { id: 'gs', header: 'Gross R, same trades as net', numeric: true, hideBelow: 'lg', cell: (r) => displayTally(r.tally).grossRSameTrades },
      { id: 'c', header: 'Conservative-fill net R (modelled)', title: 'A modelled sensitivity test, not execution performance', numeric: true, hideBelow: 'lg', cell: (r) => displayTally(r.tally).conservativeNetR },
      { id: 'x', header: 'Excluded', hideBelow: 'md', cell: (r) => <span className="text-[var(--text-secondary)]">{displayTally(r.tally).excluded}</span> }
    );
    return cols;
  }, [showGroup]);
}

function TallyTable({ rows, group, label }: { rows: TallyRow[]; group: boolean; label: string }) {
  const cols = useTallyColumns(group);
  return <DataTable columns={cols} rows={rows} rowKey={(r) => r.key} ariaLabel={label} pageSize={20} emptyTitle="No trades in this population" emptyHint="Nothing to count yet. This is not a result of zero." />;
}

const cohortRows = (list: Array<{ cohort: string; tally: Tally }> | undefined): TallyRow[] => (list ?? []).map((c) => ({ key: c.cohort, cohort: c.cohort, group: 'all strategies', tally: c.tally }));
const familyRows = (list: Array<{ cohort: string; family: string; tally: Tally }> | undefined): TallyRow[] => (list ?? []).map((c) => ({ key: `${c.cohort}:${c.family}`, cohort: c.cohort, group: c.family, tally: c.tally }));
const instrumentRows = (list: Array<{ cohort: string; family: string; instrument: string; tally: Tally }> | undefined): TallyRow[] => (list ?? []).map((c) => ({ key: `${c.cohort}:${c.family}:${c.instrument}`, cohort: c.cohort, group: `${c.family} · ${c.instrument}`, tally: c.tally }));

function Availability({ report }: { report: MeasurementReport }) {
  return (
    <div className="flex flex-wrap gap-2">
      <StatusBadge tone={report.schemaReady ? 'ok' : 'warn'} label={report.schemaReady ? 'MEASUREMENT TABLES READY' : 'MEASUREMENT TABLES NOT READY'} />
      <StatusBadge tone={report.populations ? 'ok' : 'warn'} label={report.populations ? 'POPULATIONS SEPARATED' : 'POPULATION SPLIT NOT DEPLOYED'} title="Historical and measurement-reliable trades reported apart, with a denominator beside every figure." />
      <StatusBadge tone={report.costs && report.costs.n > 0 ? 'ok' : 'off'} label={report.costs && report.costs.n > 0 ? 'COST RECORDS PRESENT' : 'NO COST RECORDS YET'} />
      <StatusBadge tone={report.postExit && report.postExit.rows > 0 ? 'ok' : 'off'} label={report.postExit && report.postExit.rows > 0 ? 'POST-EXIT ROWS PRESENT' : 'NO POST-EXIT ROWS YET'} />
      <StatusBadge tone={report.payoff && report.payoff.n > 0 ? 'ok' : 'off'} label={report.payoff && report.payoff.n > 0 ? 'PAYOFF V2 GRADES PRESENT' : 'NO PAYOFF V2 GRADES YET'} />
    </div>
  );
}

const VERDICT_NOTE: Record<string, string> = {
  CORROBORATED: 'a recorded price reached the level',
  CONTRADICTED_DENSE: 'continuous data never reached it',
  NOT_CORROBORATED: 'data exists but is too sparse to tell; NOT proof the target was missed',
  UNVERIFIABLE: 'no price data at all; nothing is inferred',
  TARGET_SEEN_NOT_RECORDED: 'a target-level price was seen before an exit that did not record a target (review flag)',
  STOP_SEEN_NOT_RECORDED: 'a stop-level price was seen before an exit that did not record a stop (review flag)',
  NO_CONFLICT: 'neither level was seen before the recorded exit',
  NOT_APPLICABLE: 'not gradeable',
};

export function MeasurementPage() {
  const { data, loading, error, reload } = useMeasurement();
  const notDeployed = error === 'NOT_DEPLOYED';
  const r = data;
  const payoff = r?.payoff;
  const postExit = r?.postExit;
  const costs = r?.costs;
  const reliableRows = r?.reliableSample ? cohortRows(r.reliableSample.byCohort) : [];

  return (
    <>
      <PerformanceNav />
      <PageBody>
        <PageHeader
          title="Measurement"
          subtitle="How far the performance numbers can be trusted: which trades are counted, the denominator of every figure, and how complete the cost and payoff data are. Historical trades and the new measurement-reliable sample are always separate."
          actions={<ActionButton onClick={reload}>Refresh</ActionButton>}
        />
        <SimulatedNotice />

        {notDeployed ? (
          <ErrorNotice tone="warn" title="NOT AVAILABLE: this API build does not include the measurement report" detail="The endpoint /api/diagnostics/measurement returned 404. Nothing on this page is estimated or assumed in its place." />
        ) : (
          <DataState loading={loading} error={error} hasData={!!r} onRetry={reload} errorTitle="Could not load the measurement report" emptyTitle="NOT YET VERIFIED" emptyHint="The report returned no data.">
            {r && (
              <>
                <Availability report={r} />
                <MetricDefinitions />

                <Section title="Reliability cutoff and versions" subtitle="Read from the server's configuration, not hardcoded here.">
                  <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
                    {reliabilityLines(r.reliability).map(([k, v]) => (
                      <div key={k} className="flex flex-wrap gap-x-2 text-sm">
                        <dt className="text-[var(--text-secondary)]">{k}:</dt>
                        <dd className="font-medium">{v}</dd>
                      </div>
                    ))}
                    {r.cohortBoundaries && (
                      <>
                        <div className="flex flex-wrap gap-x-2 text-sm">
                          <dt className="text-[var(--text-secondary)]">Baseline change:</dt>
                          <dd className="font-medium">{r.cohortBoundaries.baselineChangeAt ? new Date(r.cohortBoundaries.baselineChangeAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : MISSING}</dd>
                        </div>
                        <div className="flex flex-wrap gap-x-2 text-sm">
                          <dt className="text-[var(--text-secondary)]">Tracking fixes deployed:</dt>
                          <dd className="font-medium">{r.cohortBoundaries.trackingFixDeployedAt ? new Date(r.cohortBoundaries.trackingFixDeployedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : MISSING}</dd>
                        </div>
                      </>
                    )}
                    {r.versions && Object.entries(r.versions).map(([k, v]) => (
                      <div key={k} className="flex flex-wrap gap-x-2 text-sm">
                        <dt className="text-[var(--text-secondary)]">{k}:</dt>
                        <dd className="font-mono text-xs font-medium">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {r.populations && (
                    <p className="mt-3 text-sm text-[var(--text-secondary)]">
                      {r.populations.historicalRows ?? MISSING} historical trade rows and {r.populations.measurementReliableRows ?? MISSING} measurement-reliable rows are reported separately below. {r.populations.netR}
                    </p>
                  )}
                </Section>

                <Section title="Measurement-reliable sample" subtitle="Trades minted from the reliability cutoff, with cost records and post-exit tracking. A separate population from the historical groups below.">
                  {reliableRows.length === 0 ? (
                    <EmptyState title="NOT YET VERIFIED: no trade in the measurement-reliable period yet" hint="The first rows appear after the first trade is minted from the cutoff. This is an absence of data, not a result of zero." />
                  ) : (
                    <TallyTable rows={reliableRows} group={false} label="Measurement-reliable sample by cohort" />
                  )}
                  {r.reliableSample && r.reliableSample.byFamily.length > 0 && <div className="mt-4"><TallyTable rows={familyRows(r.reliableSample.byFamily)} group label="Measurement-reliable sample by strategy" /></div>}
                </Section>

                <Section title="Historical trades by cohort" subtitle="Minted before the reliability cutoff. PRE: before the 5 Oct change; POST_A: after it, before the tracking fixes; POST_B: after the tracking fixes. Each trade is in exactly one cohort.">
                  <TallyTable rows={cohortRows(r.byCohort)} group={false} label="Historical trades by cohort" />
                </Section>
                <Section title="Historical trades by strategy" collapsible defaultOpen={false}>
                  <TallyTable rows={familyRows(r.byFamily)} group label="Historical trades by strategy" />
                </Section>
                <Section title="Historical trades by strategy and instrument" subtitle="Instruments are never pooled." collapsible defaultOpen={false}>
                  <TallyTable rows={instrumentRows(r.byInstrument)} group label="Historical trades by strategy and instrument" />
                </Section>

                <Section title="Estimated cost quality" subtitle="Every cost here is a model (spread, slippage, charges, brokerage). Paper trades have no actual fills, so no actual cost exists to compare against.">
                  {costs && costs.n > 0 ? (
                    <MetricGrid>
                      <MetricTile label="Cost records" value={costs.n} sub={`basis ${costs.basis}`} />
                      <MetricTile label="Spread from a real quote" value={costs.spreadFromQuote} sub={`${costs.spreadFallbackAssumed} used the assumed fallback spread`} />
                      <MetricTile label="Median total cost" value={costs.medianTotalPct != null ? `${costs.medianTotalPct.toFixed(2)}%` : MISSING} sub="of premium (estimate)" />
                      <MetricTile label="Median cost in R" value={costs.medianCostR != null ? `${costs.medianCostR.toFixed(3)}R` : MISSING} sub="estimate" />
                      <MetricTile label="Cost as % of planned gross profit" value={costs.medianCostPctOfPlannedGrossProfit != null ? `${costs.medianCostPctOfPlannedGrossProfit.toFixed(1)}%` : MISSING} sub="median, estimate" />
                      <MetricTile label="Agree with the setup's own cost" value={`${costs.reconcilesWithSetupCost?.matches ?? 0} of ${costs.reconcilesWithSetupCost?.checked ?? 0}`} />
                    </MetricGrid>
                  ) : (
                    <EmptyState title="NOT YET VERIFIED: no per-trade cost records yet" hint="They are written when a trade is minted after the release. Older trades carry a single recorded estimate, or the assumed default, and are never back-filled." />
                  )}
                </Section>

                <Section title="Conservative-fill sensitivity" subtitle={r.conservativeFillMethod?.label ?? 'A modelled sensitivity test, not execution performance.'}>
                  <p className="text-sm text-[var(--text-secondary)]">{r.conservativeFillMethod?.rule ?? 'The method is not described by this API build.'}</p>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">{r.conservativeFillMethod?.limitation}</p>
                  <p className="mt-2 text-sm">The conservative-fill net R column in the tables above is this test. It is a lower bound on net R and is never an actual result.</p>
                </Section>

                <Section title="Post-exit tracking" subtitle="What the contract did after a paper exit, sampled from option-chain quotes and live ticks: a lower bound (a spike between observations is not seen).">
                  {postExit && postExit.rows > 0 ? (
                    <MetricGrid>
                      <MetricTile label="Rows" value={postExit.rows} sub={Object.entries(postExit.byStatus ?? {}).map(([k, v]) => `${v} ${k.replace(/_/g, ' ').toLowerCase()}`).join(', ')} />
                      <MetricTile label="Target exits observed" value={postExit.targetExits?.n ?? 0} sub="rows with data" />
                      <MetricTile label="Median extra move after target" value={postExit.targetExits?.medianMaxBeyondExitR != null ? `${postExit.targetExits.medianMaxBeyondExitR.toFixed(2)}R` : MISSING} sub="best price seen after exit, a lower bound" />
                    </MetricGrid>
                  ) : (
                    <EmptyState title="NOT YET VERIFIED: no post-exit rows yet" hint="A row is written when the watch of a closed trade ends at the session close." />
                  )}
                </Section>

                <Section title="Payoff grading: V2 versus legacy" subtitle="V2 uses every timestamped price that exists and states what it cannot verify. The legacy grader compared 15-minute option-chain mids and often contradicted recorded target exits; the two are never combined.">
                  {payoff && payoff.n > 0 ? (
                    <>
                      <MetricGrid>
                        <MetricTile label="V2 grades" value={payoff.n} />
                        <MetricTile label="Recorded target exits" value={payoff.recordedTargetExits?.n ?? 0} sub={`${payoff.recordedTargetExits?.corroborated ?? 0} corroborated · ${payoff.recordedTargetExits?.notCorroboratedSparse ?? 0} sparse · ${payoff.recordedTargetExits?.unverifiable ?? 0} unverifiable · ${payoff.recordedTargetExits?.contradictedByDenseData ?? 0} contradicted by dense data`} />
                        <MetricTile label="Legacy said 'not reached'" value={payoff.firstGraderComparison?.firstGraderSaidTargetNotReached ?? 0} sub={`of ${payoff.firstGraderComparison?.recordedTargetExitsWithAFirstGrade ?? 0} recorded target exits with a legacy grade; V2 corroborated ${payoff.firstGraderComparison?.ofThose_v2Corroborated ?? 0} of them`} />
                      </MetricGrid>
                      <ul className="mt-3 space-y-1 text-sm">
                        {Object.entries(payoff.byVerdict ?? {}).map(([k, n]) => (
                          <li key={k}>
                            <span className="font-mono text-xs font-semibold">{k}</span> × {String(n)}: <span className="text-[var(--text-secondary)]">{VERDICT_NOTE[k] ?? 'status as returned by the server'}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <EmptyState title="NOT YET VERIFIED: no V2 payoff grades yet" hint="They are written by the post-session job. Sparse or missing price data is never read as a missed target." />
                  )}
                </Section>
              </>
            )}
          </DataState>
        )}
      </PageBody>
    </>
  );
}
