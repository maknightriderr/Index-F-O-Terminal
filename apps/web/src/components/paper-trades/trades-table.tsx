'use client';

// ============================================================
// PAPER TRADES TABLE — the one table for open, closed and expired trades
// ============================================================
// Shows the server's record exactly (entry, stop at the mint, target, outcome, exit, R, cost). Nothing is recomputed
// here. Estimated costs are labelled as estimates; an unknown value is an em dash, never 0; an open trade's latest
// premium carries its own observation time and freshness; a voided / lost / untracked trade says so in its status.
// ============================================================

import React, { useMemo } from 'react';
import { isMarketOpen } from '@fno/shared';
import type { Exchange, PaperTradeView } from '@fno/shared';
import { DataTable, type Column } from '@/components/ui/data-table';
import { FreshnessBadge, StatusBadge, TradeStateBadge } from '@/components/ui/status-badge';
import { classifyFreshness, FRESH_WITHIN_MS } from '@/lib/freshness';
import { formatAge, formatHold, formatIstDateTime, formatNumber, formatR, formatRupees, formatSignedPercent, MISSING } from '@/lib/format';
import { contractLabel } from '@/lib/paper-trade-view';

const rColor = (v: number | null) => (v == null ? '' : v > 0 ? 'text-[var(--status-ok)]' : v < 0 ? 'text-[var(--status-bad)]' : '');

function CostCell({ t }: { t: PaperTradeView }) {
  const c = t.estimatedCost;
  if (c.pct == null) return <span title="No cost estimate exists for this trade type">{MISSING}</span>;
  const label = c.basis === 'ESTIMATED_MODEL' ? 'est.' : c.basis === 'DEFAULT_ASSUMPTION' ? 'assumed' : '';
  const title =
    c.basis === 'ESTIMATED_MODEL'
      ? 'Estimated round-trip cost recorded with the trade (spread, slippage, charges, brokerage). A model, not an actual fill.'
      : 'No cost was recorded with this older trade; the system default (3%) is assumed. Not an actual fill.';
  return (
    <span title={title}>
      <span className="tabular-nums">{formatNumber(c.pct, 2)}%</span> <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      {c.costR != null && <div className="text-xs text-[var(--text-secondary)]">{formatR(c.costR)}</div>}
    </span>
  );
}

function LiveCell({ t, now, apiReachable }: { t: PaperTradeView; now: number; apiReachable: boolean }) {
  const live = t.live;
  if (!live) return <span>{MISSING}</span>;
  if (live.premium == null) {
    return (
      <span>
        <StatusBadge tone={t.status === 'OPEN_UNTRACKED' ? 'warn' : 'off'} label={t.status === 'OPEN_UNTRACKED' ? 'NOT TRACKED' : 'NO PRICE YET'} title={t.status === 'OPEN_UNTRACKED' ? 'No live slot is tracking this open trade, so there is no current price.' : 'The monitor has not recorded a price for this trade yet.'} />
      </span>
    );
  }
  const f = classifyFreshness({ observedAt: live.observedAt, now, sessionOpen: isMarketOpen(t.exchange as Exchange, now), transportConnected: apiReachable, freshWithinMs: FRESH_WITHIN_MS.tradeMark });
  return (
    <span>
      <span className="tabular-nums font-medium">{formatNumber(live.premium, 2)}</span>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        <FreshnessBadge state={f.state} detail={f.detail} />
        <span className="text-xs text-[var(--text-secondary)]">{live.observedAt ? `${formatIstDateTime(live.observedAt, now)} · ${formatAge(live.ageSeconds != null ? live.ageSeconds * 1000 : null)}` : ''}</span>
      </div>
    </span>
  );
}

export function TradeDetail({ t, now }: { t: PaperTradeView; now: number }) {
  const rows: Array<[string, React.ReactNode]> = [
    ['Opened', formatIstDateTime(t.mintedAt, now)],
    ['Strategy', `${t.strategyLabel}${t.logicVersion ? ` · ${t.logicVersion}` : ''}`],
    ['Planned stop (at the mint)', formatNumber(t.initialStop)],
    ['Current stop', t.state === 'OPEN' ? formatNumber(t.currentStop) : MISSING],
    ['Target', formatNumber(t.target)],
    ['Planned reward:risk', t.plannedRiskReward != null ? t.plannedRiskReward.toFixed(2) : MISSING],
    ['Exit price', formatNumber(t.exitPrice)],
    ['Exit', t.exitAt ? `${formatIstDateTime(t.exitAt, now)} · ${t.closeReason ?? 'reason not recorded'}` : MISSING],
    ['Holding time', formatHold(t.holdMinutes)],
    ['Gross R', formatR(t.grossR)],
    ['Estimated cost', t.estimatedCost.pct != null ? `${formatNumber(t.estimatedCost.pct)}% of premium (${t.estimatedCost.basis === 'ESTIMATED_MODEL' ? 'estimate recorded with the trade' : 'assumed default'})` : MISSING],
    ['Estimated net R', formatR(t.netR)],
    ['Return on premium (gross)', formatSignedPercent(t.returnPercent)],
    ['Cohort', `${t.cohort}${t.measurementReliable ? ' · measurement-reliable' : ' · historical'}`],
    ['Counts in performance', t.includedInPerformance ? 'Yes' : `No: ${t.excludedReason ?? 'not applicable'}`],
  ];
  if (t.estimatedCost.record) rows.push(['Cost record', `${t.estimatedCost.record.spreadSource === 'QUOTE' ? 'spread from the quote at the mint' : 'fallback spread assumed'}; ${t.estimatedCost.record.totalPerLotInr != null ? `${formatRupees(t.estimatedCost.record.totalPerLotInr)} per lot (estimate)` : 'per-lot cost not available'}`]);
  if (t.live) {
    rows.push(['Unrealised P&L (simulated)', t.live.unrealisedPnlInr != null ? `${formatRupees(t.live.unrealisedPnlInr, { signed: true })} on ${t.live.quantity} units` : MISSING]);
    rows.push(['Tracking health', t.live.health ? `${t.live.health.state} · ${t.live.health.reason}` : t.live.slotTracked ? 'No health reading yet' : 'No live slot tracking this trade']);
  }
  return (
    <div className="space-y-2 py-1">
      <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap gap-x-2 text-sm">
            <dt className="text-[var(--text-secondary)]">{k}:</dt>
            <dd className="font-medium text-[var(--text-primary)]">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-[var(--text-secondary)]">{t.disclosure}</p>
    </div>
  );
}

export function TradesTable({ trades, now, apiReachable, pageSize = 25, maxHeight, ariaLabel = 'Paper trades' }: { trades: readonly PaperTradeView[]; now: number; apiReachable: boolean; pageSize?: number; maxHeight?: string; ariaLabel?: string }) {
  const columns = useMemo<Column<PaperTradeView>[]>(
    () => [
      {
        id: 'trade',
        header: 'Trade',
        label: 'Trade',
        sortValue: (t) => t.symbol,
        cell: (t) => (
          <div className="min-w-[150px]">
            <div className="font-medium text-[var(--text-primary)]">{contractLabel(t)}</div>
            <div className="text-xs text-[var(--text-secondary)]">
              {t.strategyLabel} · {t.direction === 'BULLISH' ? '▲ bullish' : t.direction === 'BEARISH' ? '▼ bearish' : 'neutral'}
            </div>
          </div>
        ),
      },
      {
        id: 'state',
        header: 'Status',
        label: 'Status',
        sortValue: (t) => t.state,
        cell: (t) => (
          <div title={t.excludedReason ?? undefined}>
            <TradeStateBadge state={t.state} status={t.status} />
            {t.state !== 'OPEN' && !t.includedInPerformance && t.status === 'CLOSED' && <div className="mt-0.5 text-xs text-[var(--text-secondary)]">not in performance</div>}
          </div>
        ),
      },
      { id: 'opened', header: 'Opened (IST)', label: 'Opened', sortValue: (t) => t.mintedAt, hideBelow: '2xl', cell: (t) => <span className="whitespace-nowrap text-xs">{formatIstDateTime(t.mintedAt, now)}</span> },
      { id: 'entry', header: 'Entry', numeric: true, hideBelow: 'md', sortValue: (t) => t.entry, cell: (t) => formatNumber(t.entry) },
      {
        id: 'stop',
        header: 'Stop',
        numeric: true,
        hideBelow: 'md',
        title: 'Stop at the mint (an open trade may have a trailing stop; see the row details)',
        cell: (t) => formatNumber(t.initialStop),
      },
      { id: 'target', header: 'Target', numeric: true, hideBelow: 'md', cell: (t) => formatNumber(t.target) },
      { id: 'rr', header: 'R:R', numeric: true, hideBelow: '2xl', title: 'Planned reward:risk recorded at the mint', sortValue: (t) => t.plannedRiskReward, cell: (t) => (t.plannedRiskReward != null ? t.plannedRiskReward.toFixed(2) : MISSING) },
      {
        id: 'exit',
        header: 'Exit',
        numeric: true,
        hideBelow: 'xl',
        cell: (t) => (
          <span>
            {formatNumber(t.exitPrice)}
            {t.closeReason && <div className="text-xs text-[var(--text-secondary)]">{t.closeReason.replace(/_/g, ' ').toLowerCase()}</div>}
          </span>
        ),
      },
      { id: 'hold', header: 'Held', numeric: true, hideBelow: '2xl', sortValue: (t) => t.holdMinutes, cell: (t) => formatHold(t.holdMinutes) },
      {
        id: 'r',
        header: 'R (gross)',
        numeric: true,
        title: 'Closed: realised. Open: unrealised at the latest observed price.',
        sortValue: (t) => (t.state === 'OPEN' ? t.live?.unrealisedGrossR ?? null : t.grossR),
        cell: (t) => {
          const v = t.state === 'OPEN' ? t.live?.unrealisedGrossR ?? null : t.grossR;
          return (
            <span className={`font-medium ${rColor(v)}`}>
              {formatR(v)}
              {t.state === 'OPEN' && v != null && <div className="text-xs font-normal text-[var(--text-secondary)]">unrealised</div>}
            </span>
          );
        },
      },
      { id: 'cost', header: 'Est. cost', numeric: true, hideBelow: 'md', title: 'Estimated round-trip cost: a model, not an actual fill', cell: (t) => <CostCell t={t} /> },
      {
        id: 'net',
        header: 'Net R (est.)',
        numeric: true,
        title: 'Gross R minus the estimated cost',
        sortValue: (t) => (t.state === 'OPEN' ? t.live?.unrealisedNetR ?? null : t.netR),
        cell: (t) => {
          const v = t.state === 'OPEN' ? t.live?.unrealisedNetR ?? null : t.netR;
          return <span className={`font-medium ${rColor(v)}`}>{formatR(v)}</span>;
        },
      },
      {
        id: 'pnl',
        header: 'P&L ₹ (sim.)',
        numeric: true,
        hideBelow: '2xl',
        title: 'Simulated profit and loss in rupees. Only available for open trades whose position size is known.',
        cell: (t) => (t.state === 'OPEN' ? formatRupees(t.live?.unrealisedPnlInr ?? null, { signed: true }) : MISSING),
      },
      { id: 'live', header: 'Latest price', hideBelow: 'md', cell: (t) => (t.state === 'OPEN' ? <LiveCell t={t} now={now} apiReachable={apiReachable} /> : <span>{MISSING}</span>) },
    ],
    [now, apiReachable]
  );

  return (
    <DataTable
      columns={columns}
      rows={trades}
      rowKey={(t) => t.id}
      ariaLabel={ariaLabel}
      pageSize={pageSize}
      maxHeight={maxHeight}
      renderDetail={(t) => <TradeDetail t={t} now={now} />}
      emptyTitle="No paper trades match these filters"
      emptyHint="Change or clear a filter. Paper trades appear here as the engines mint them."
    />
  );
}
