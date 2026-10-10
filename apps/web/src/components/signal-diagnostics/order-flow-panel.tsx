'use client';

// ============================================================
// SIGNAL DIAGNOSTICS — Order Blocks (OB-2.0 / OB1) and Order Flow / OF1
// ============================================================
// What the repaired order-block detector did beside the indicator's legacy vote, how much Dhan order flow arrived (and whether
// its delta is exact or inferred), and every OF1 candidate. OB1 / OF1 paper trades themselves are in Backtesting → By Source.
//
// Presentation rules: the feed's state and the reason bars are missing are stated (a disconnected feed is not a row of zeros);
// EXACT, INFERRED and UNAVAILABLE bars are separate and labelled; and a working panel is not evidence that either strategy
// is profitable — small samples are flagged as samples.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { api, type DiagnosticsFilter } from '@/lib/api';
import { Section, MetricGrid, MetricTile } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { DataModeBadge, StatusBadge } from '@/components/ui/status-badge';
import { ErrorNotice, SkeletonRows } from '@/components/ui/data-state';
import { formatNumber, MISSING } from '@/lib/format';

/** Mirrors apps/server/src/services/order-flow-metrics.ts orderFlowReport(). */
export interface OrderFlowReport {
  note: string;
  settings: { orderBlockMode: string; of1Enabled: boolean; of1Trading: boolean; orderFlowSymbols: string[] };
  feed: { status: string; deltaMode: string; deltaModeReason: string; instruments: Record<string, { tradingSymbol: string }>; packets: number; trades: number; lastPacketAt: number | null; lastError: string | null };
  flowBars: Array<{ deltaMode: string; unavailableReason: string | null; bars: number }>;
  of1: {
    candidates: number; bullish: number; bearish: number; exact: number; inferred: number; wouldTradeIfLive: number;
    graded: number; targets: number; stops: number; openAtClose: number; avgR: number | null; avgMfeR: number | null; avgMaeR: number | null; existingTradedSameBar: number;
    bySubtype: Array<{ subtype: string; n: number; avgR: number | null }>;
    existingWinners: Array<{ source: string; n: number }>;
  };
  orderBlocks: {
    byState: Array<{ state: string; n: number; held: number; failed: number; avgMfeAtr: number | null; avgMaeAtr: number | null }>;
    decisions: number; legacySignals: number; v2Signals: number; wouldChangeIndicatorDirection: number;
  };
}

const SAMPLE = 30;

const FEED_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'off' | 'info'> = { CONNECTED: 'ok', DISCONNECTED: 'bad', DATA_PLAN_INACTIVE: 'off', NOT_CONFIGURED: 'off' };
const FEED_TEXT: Record<string, string> = {
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
  DATA_PLAN_INACTIVE: 'Data API plan not active',
  NOT_CONFIGURED: 'Not configured',
};

/** The lifecycle order of an order block, so the table reads left to right in time. */
const STATE_ORDER = ['FRESH', 'FIRST_TOUCH', 'MITIGATED', 'FAILED', 'EXPIRED'];
const STATE_NOTE: Record<string, string> = {
  FRESH: 'created, price has not returned to it',
  FIRST_TOUCH: 'price has returned to it once',
  MITIGATED: 'price has traded through it',
};

export function OrderFlowPanel({ filter }: { filter: DiagnosticsFilter }) {
  const [data, setData] = useState<OrderFlowReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(filter);
  useEffect(() => {
    let cancelled = false;
    api
      .getOrderFlowReport(filter)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(e?.message ?? 'Could not load the order-flow report.'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const blockRows = useMemo(() => (data ? [...data.orderBlocks.byState].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)) : []), [data]);
  const blockCols = useMemo<Column<OrderFlowReport['orderBlocks']['byState'][number]>[]>(
    () => [
      { id: 'state', header: 'Lifecycle state', cell: (r) => <span><span className="font-medium">{r.state.replace(/_/g, ' ').toLowerCase()}</span>{STATE_NOTE[r.state] && <span className="block text-xs text-[var(--text-secondary)]">{STATE_NOTE[r.state]}</span>}</span> },
      { id: 'n', header: 'Blocks', numeric: true, sortValue: (r) => r.n, cell: (r) => r.n },
      { id: 'held', header: 'Held ≥ 1 ATR', numeric: true, cell: (r) => r.held },
      { id: 'failed', header: 'Failed', numeric: true, cell: (r) => r.failed },
      { id: 'mfe', header: 'Avg MFE (ATR)', numeric: true, cell: (r) => formatNumber(r.avgMfeAtr) },
      { id: 'mae', header: 'Avg MAE (ATR)', numeric: true, cell: (r) => formatNumber(r.avgMaeAtr) },
    ],
    []
  );

  if (error) return <ErrorNotice title="Could not load the order-flow report" detail={error} />;
  if (!data) return <SkeletonRows rows={4} label="Loading the order-flow report" />;

  const { feed, of1, orderBlocks: ob } = data;
  const barsOf = (mode: string) => data.flowBars.filter((b) => b.deltaMode === mode).reduce((a, b) => a + b.bars, 0);
  const exact = barsOf('EXACT');
  const inferred = barsOf('INFERRED');
  const partial = barsOf('PARTIAL');
  const unavailable = barsOf('UNAVAILABLE');
  const totalBars = exact + inferred + partial + unavailable;
  const reasons = data.flowBars.filter((b) => b.deltaMode === 'UNAVAILABLE' && b.unavailableReason && b.bars > 0);
  const sampleNote = (n: number) => (n < SAMPLE ? `${n} is a small sample, not evidence` : undefined);

  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--text-secondary)]">
        Order blocks (OB1): {data.settings.orderBlockMode === 'PAPER' ? 'paper trading' : data.settings.orderBlockMode.toLowerCase()}. Order flow (OF1): {data.settings.of1Enabled ? (data.settings.of1Trading ? 'paper trading' : 'recording only') : 'off'}. Paper only: no broker orders. Their trades are under Backtesting → By Source. This panel shows what the detectors recorded; it is not evidence that either is profitable.
      </p>

      <Section title="Order blocks (OB-2.0) versus the indicator's legacy vote" subtitle="The repaired detector runs beside the old vote and changes no decision.">
        <MetricGrid>
          <MetricTile label="Decision bars" value={ob.decisions} />
          <MetricTile label="Legacy vote fired" value={ob.legacySignals} />
          <MetricTile label="OB-2.0 signals" value={ob.v2Signals} />
          <MetricTile label="Would change the indicator" value={ob.wouldChangeIndicatorDirection} sub="if OB-2.0 replaced the old vote (it does not)" />
        </MetricGrid>
        <div className="mt-4">
          <DataTable columns={blockCols} rows={blockRows} rowKey={(r) => r.state} ariaLabel="Order blocks by lifecycle state" pageSize={10} emptyTitle="No order blocks recorded yet" />
          <p className="mt-2 text-xs text-[var(--text-secondary)]">This report aggregates blocks by lifecycle state. Each block&apos;s direction, high/low zone, creation time and version are recorded with it but are not exposed per block here.</p>
        </div>
      </Section>

      <Section title="Dhan order-flow feed" subtitle="Whether data is arriving, and how trustworthy each bar's delta is.">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <StatusBadge tone={FEED_TONE[feed.status] ?? 'off'} label={(FEED_TEXT[feed.status] ?? feed.status).toUpperCase()} />
          <span className="text-sm text-[var(--text-secondary)]">
            {feed.lastPacketAt ? `Last packet ${new Date(feed.lastPacketAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST` : 'No packet recorded'}
            {Object.values(feed.instruments).length > 0 ? ` · ${Object.values(feed.instruments).map((i) => i.tradingSymbol).join(', ')}` : ''}
          </span>
        </div>
        {totalBars === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">No order-flow bars have been recorded, so there is no delta, POC, VAH or VAL to show. This is the absence of data, not a reading of zero.</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-4 text-sm">
              <span className="flex items-center gap-2"><DataModeBadge mode="EXACT" /> <strong>{exact}</strong> bars</span>
              <span className="flex items-center gap-2"><DataModeBadge mode="INFERRED" /> <strong>{inferred}</strong> bars</span>
              {partial > 0 && <span className="flex items-center gap-2"><DataModeBadge mode="PARTIAL" /> <strong>{partial}</strong> bars</span>}
              <span className="flex items-center gap-2"><DataModeBadge mode="UNAVAILABLE" /> <strong>{unavailable}</strong> bars</span>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              {exact + inferred + partial} of {totalBars} bars carry any order-flow data ({totalBars > 0 ? (((exact + inferred + partial) / totalBars) * 100).toFixed(0) : MISSING}%).
            </p>
          </>
        )}
        {reasons.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-[var(--text-secondary)]">
            {reasons.map((r, i) => (
              <li key={i}>
                {r.bars} bars unavailable: {r.unavailableReason}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          <strong className="text-[var(--text-primary)]">Delta mode: {feed.deltaMode}.</strong> {feed.deltaModeReason}
          {feed.lastError ? ` Last error: ${feed.lastError}` : ''}
        </p>
      </Section>

      <Section title="OF1: order-flow confirmation candidates" subtitle="Candidates are graded on their own stop and target; each count shows its sample size.">
        <MetricGrid>
          <MetricTile label="Candidates" value={of1.candidates} sub={`${of1.bullish} bullish · ${of1.bearish} bearish`} title={sampleNote(of1.candidates)} />
          <MetricTile label="Would trade if live" value={of1.wouldTradeIfLive} />
          <MetricTile label="Graded: avg R" value={of1.graded > 0 ? formatNumber(of1.avgR) : MISSING} sub={`${of1.graded} graded · ${of1.targets} target · ${of1.stops} stop · ${of1.openAtClose} open${of1.graded > 0 && of1.graded < SAMPLE ? ' · small sample' : ''}`} />
          <MetricTile label="Same bar, existing engine traded" value={of1.existingTradedSameBar} sub={`of ${of1.graded} graded`} />
        </MetricGrid>
        {of1.candidates === 0 && <p className="mt-3 text-sm text-[var(--text-secondary)]">Nothing recorded yet. With no order-flow data there are no candidates.</p>}
        {(of1.bySubtype.length > 0 || of1.existingWinners.length > 0) && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <DataTable columns={[{ id: 's', header: 'Subtype', cell: (r: { subtype: string; n: number; avgR: number | null }) => r.subtype }, { id: 'n', header: 'Candidates', numeric: true, cell: (r) => r.n }, { id: 'r', header: 'Avg R', numeric: true, cell: (r) => formatNumber(r.avgR) }]} rows={of1.bySubtype} rowKey={(r) => r.subtype} ariaLabel="OF1 candidates by subtype" pageSize={10} />
            <DataTable columns={[{ id: 's', header: 'Existing winner on the same bar', cell: (r: { source: string; n: number }) => r.source }, { id: 'n', header: 'Times', numeric: true, cell: (r) => r.n }]} rows={of1.existingWinners} rowKey={(r) => r.source} ariaLabel="Existing winners on the same bar" pageSize={10} />
          </div>
        )}
      </Section>
    </div>
  );
}
