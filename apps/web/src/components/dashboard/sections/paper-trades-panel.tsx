'use client';

import React, { useMemo } from 'react';
import { isMarketOpen } from '@fno/shared';
import type { Exchange, PaperTradeView } from '@fno/shared';
import { useAssetTabsStore, useMarketStore } from '@/stores';
import { usePaperTrades } from '@/lib/use-paper-trades';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { classifyFreshness, FRESH_WITHIN_MS } from '@/lib/freshness';
import { contractLabel } from '@/lib/paper-trade-view';
import { formatAge, formatHold, formatIstDateTime, formatNumber, formatR, formatRupees, MISSING } from '@/lib/format';
import { Section } from '@/components/ui/card';
import { ActionButton } from '@/components/ui/controls';
import { DataState } from '@/components/ui/data-state';
import { FreshnessBadge, TradeStateBadge } from '@/components/ui/status-badge';

// ============================================================
// SECTION C — MY PAPER TRADES (compact)
// ============================================================
// The open trades and today's closes, straight from the server's trade records. These are simulated: no broker order was
// placed. Costs are estimates. Everything shown is the record's own value; a missing one is an em dash. The full list,
// filters and details live on the Paper Trades page.
// ============================================================

const todayIst = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function TradeRow({ t, now, apiReachable }: { t: PaperTradeView; now: number; apiReachable: boolean }) {
  const openTab = useAssetTabsStore((s) => s.openTab);
  const live = t.live;
  const f = live?.observedAt != null ? classifyFreshness({ observedAt: live.observedAt, now, sessionOpen: isMarketOpen(t.exchange as Exchange, now), transportConnected: apiReachable, freshWithinMs: FRESH_WITHIN_MS.tradeMark }) : null;
  const r = t.state === 'OPEN' ? live?.unrealisedGrossR ?? null : t.grossR;
  const netR = t.state === 'OPEN' ? live?.unrealisedNetR ?? null : t.netR;
  const tone = r == null ? '' : r > 0 ? 'text-[var(--status-ok)]' : r < 0 ? 'text-[var(--status-bad)]' : '';
  return (
    <li className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface-card-alt)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => openTab(t.symbol, t.exchange as Exchange)} className="font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline" title={`Open the ${t.symbol} workspace`}>
              {contractLabel(t)}
            </button>
            <TradeStateBadge state={t.state} status={t.status} />
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            {t.strategyLabel}
            {t.logicVersion ? ` · ${t.logicVersion.length > 24 ? `${t.logicVersion.slice(0, 24)}…` : t.logicVersion}` : ''} · {t.direction === 'BULLISH' ? '▲ bullish' : '▼ bearish'} · opened {formatIstDateTime(t.mintedAt, now)} · held {formatHold(t.holdMinutes)}
          </div>
        </div>
        <div className="text-right">
          <div className={`text-lg font-semibold tabular-nums ${tone}`}>
            {formatR(r)}
            {t.state === 'OPEN' && <span className="ml-1 text-xs font-normal text-[var(--text-secondary)]">unrealised</span>}
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            net {formatR(netR)} after the est. cost{live?.unrealisedPnlInr != null ? ` · ${formatRupees(live.unrealisedPnlInr, { signed: true })} simulated` : ''}
          </div>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-[var(--text-secondary)]">Entry</dt>
          <dd className="tabular-nums">{formatNumber(t.entry)}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-secondary)]">Stop · Target</dt>
          <dd className="tabular-nums">
            {formatNumber(t.state === 'OPEN' ? t.currentStop ?? t.initialStop : t.initialStop)} · {formatNumber(t.target)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-secondary)]">{t.state === 'OPEN' ? 'Latest price' : 'Exit'}</dt>
          <dd className="tabular-nums">{t.state === 'OPEN' ? formatNumber(live?.premium ?? null) : formatNumber(t.exitPrice)}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-secondary)]">Est. cost (model)</dt>
          <dd className="tabular-nums">{t.estimatedCost.pct != null ? `${formatNumber(t.estimatedCost.pct)}% est.` : MISSING}</dd>
        </div>
      </dl>
      {t.state === 'OPEN' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
          {f ? <FreshnessBadge state={f.state} detail={f.detail} /> : <FreshnessBadge state="UNAVAILABLE" detail={t.status === 'OPEN_UNTRACKED' ? 'No live slot is tracking this trade.' : 'The monitor has not recorded a price yet.'} />}
          <span>{live?.observedAt ? `price observed ${formatIstDateTime(live.observedAt, now)} (${formatAge(live.ageSeconds != null ? live.ageSeconds * 1000 : null)})` : 'no price observed yet'}</span>
          {live?.health && <span title={live.health.reason}>· tracking health: {live.health.state.toLowerCase()}</span>}
        </div>
      )}
      {t.state !== 'OPEN' && t.closeReason && <div className="mt-2 text-xs text-[var(--text-secondary)]">Closed: {t.closeReason.replace(/_/g, ' ').toLowerCase()}{!t.includedInPerformance && t.excludedReason ? ` · ${t.excludedReason}` : ''}</div>}
    </li>
  );
}

export function PaperTradesPanel() {
  const { data, loading, error, reload } = usePaperTrades(300);
  const feed = useFeedSummary();
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  const now = feed.now;

  const { open, closedToday, counts } = useMemo(() => {
    const trades = data?.trades ?? [];
    const today = todayIst(now);
    const o = trades.filter((t) => t.state === 'OPEN' && t.status !== 'VOIDED' && t.status !== 'TRACKING_LOST').sort((a, b) => b.mintedAt - a.mintedAt);
    const c = trades.filter((t) => t.state !== 'OPEN' && t.exitAt != null && todayIst(t.exitAt) === today).sort((a, b) => (b.exitAt ?? 0) - (a.exitAt ?? 0));
    return { open: o, closedToday: c, counts: data?.counts };
  }, [data, now]);

  return (
    <Section
      title="My paper trades"
      subtitle="Simulated trades: no broker order was placed, and costs are estimates, not actual fills."
      actions={<ActionButton onClick={() => setActiveTab('paper-trades')}>View all paper trades →</ActionButton>}
    >
      <DataState loading={loading} error={error} hasData={!!data} onRetry={reload} errorTitle="Could not load paper trades" emptyTitle="No paper trades recorded yet" skeletonRows={3}>
        <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-[var(--text-secondary)]">
          <span>
            <strong className="text-[var(--text-primary)]">{open.length}</strong> open{counts && counts.openUntracked > 0 ? ` (${counts.openUntracked} not tracked)` : ''}
          </span>
          <span>
            <strong className="text-[var(--text-primary)]">{closedToday.length}</strong> closed today
          </span>
        </div>
        {open.length === 0 && closedToday.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--border-secondary)] px-4 py-6 text-center text-sm text-[var(--text-secondary)]" data-testid="paper-trades-empty">
            No paper trade is open and none closed today. Trades appear here when an engine mints one during a session.
          </div>
        ) : (
          <ul className="space-y-2">
            {open.slice(0, 6).map((t) => (
              <TradeRow key={t.id} t={t} now={now} apiReachable={feed.apiReachable} />
            ))}
            {closedToday.slice(0, 4).map((t) => (
              <TradeRow key={t.id} t={t} now={now} apiReachable={feed.apiReachable} />
            ))}
          </ul>
        )}
        {(open.length > 6 || closedToday.length > 4) && <p className="mt-2 text-sm text-[var(--text-secondary)]">Showing the newest few; the Paper Trades page lists them all.</p>}
      </DataState>
    </Section>
  );
}
