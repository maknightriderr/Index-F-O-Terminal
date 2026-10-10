'use client';

import React from 'react';
import { formatIndianNumber } from '@fno/shared';
import type { MarketQuote } from '@fno/shared';
import { useMarketStore } from '@/stores';
import { useAllIndices } from '@/lib/use-all-indices';
import { useLiveIndices } from '@/lib/use-live-indices';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { classifyFreshness, FRESH_WITHIN_MS } from '@/lib/freshness';
import { formatArrowPercent, formatIstDateTime, formatNumber, MISSING } from '@/lib/format';
import { FreshnessBadge, HealthBadge, StatusBadge } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';

// ============================================================
// SECTION A — MARKET AND FEED STATUS
// ============================================================
// Each cell shows a value AND how current it is, from timestamps and the exchange session (lib/freshness.ts). A quote is
// never "live" merely because a socket is open; after the close the last observation is labelled as such.
// ============================================================

function Cell({ label, children, detail }: { label: string; children: React.ReactNode; detail?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border-primary)] bg-[var(--surface-card-alt)] px-3 py-2.5" title={detail}>
      <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className="mt-1 space-y-1">{children}</div>
    </div>
  );
}

function IndexCell({ symbol, quote, observedAt, now, sessionOpen }: { symbol: string; quote: MarketQuote | null; observedAt: number | null; now: number; sessionOpen: boolean | null }) {
  const f = classifyFreshness({ observedAt: quote?.timestamp ?? observedAt, now, sessionOpen, transportConnected: null, freshWithinMs: FRESH_WITHIN_MS.quote });
  if (!quote) {
    return (
      <Cell label={symbol}>
        <div className="text-xl font-semibold text-[var(--text-secondary)]">{MISSING}</div>
        <FreshnessBadge state="UNAVAILABLE" detail="No quote has been received." />
      </Cell>
    );
  }
  const up = quote.change >= 0;
  return (
    <Cell label={symbol} detail={f.detail}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xl font-semibold tabular-nums text-[var(--text-primary)]">{formatIndianNumber(quote.ltp, 2)}</span>
        <span className={`text-sm font-medium tabular-nums ${up ? 'text-[var(--status-ok)]' : 'text-[var(--status-bad)]'}`}>{formatArrowPercent(quote.changePercent)}</span>
      </div>
      <div className="text-xs tabular-nums text-[var(--text-secondary)]">
        Day {formatNumber(quote.low, 2)} – {formatNumber(quote.high, 2)}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <FreshnessBadge state={f.state} detail={f.detail} />
        <span className="text-xs text-[var(--text-secondary)]">{formatIstDateTime(quote.timestamp, now)}</span>
      </div>
    </Cell>
  );
}

export function StatusBar() {
  const feed = useFeedSummary();
  const { indices, observedAt } = useLiveIndices();
  const { indices: allIndices } = useAllIndices();
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  const nifty = indices.find((i) => i.symbol === 'NIFTY') ?? null;
  const bank = indices.find((i) => i.symbol === 'BANKNIFTY') ?? null;
  const vix = allIndices.find((i) => i.symbol === 'INDIAVIX') ?? null;
  const h = feed.health;
  const row = (id: string) => h.rows.find((r) => r.id === id);
  const angel = row('provider');
  const ticks = row('tick-feed');
  const dhan = row('order-flow');
  const sock = row('browser-socket');
  const nse = feed.sessions.find((s) => s.exchange === 'NSE')?.open ?? null;

  return (
    <Card as="section" aria-label="Market and feed status" className="!p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Market and feed status</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
          <span>Last market observation: {formatIstDateTime(feed.quotesObservedAt, feed.now)}</span>
          <button type="button" onClick={() => setActiveTab('system-health')} className="rounded-md border border-[var(--border-secondary)] px-2 py-1 hover:bg-[var(--surface-card-alt)]">
            System Health →
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
        <Cell label="Sessions (IST)">
          <div className="flex flex-wrap gap-1.5">
            {feed.sessions.map((s) => (
              <StatusBadge key={s.exchange} tone={s.open ? 'ok' : 'info'} label={`${s.exchange} ${s.open ? 'OPEN' : 'CLOSED'}`} />
            ))}
          </div>
          <div className="text-xs text-[var(--text-secondary)]">{feed.sessions.some((s) => s.open) ? 'At least one exchange is trading.' : 'All exchanges are closed.'}</div>
        </Cell>
        <IndexCell symbol="NIFTY" quote={nifty} observedAt={observedAt} now={feed.now} sessionOpen={nse} />
        <IndexCell symbol="BANKNIFTY" quote={bank} observedAt={observedAt} now={feed.now} sessionOpen={nse} />
        <IndexCell symbol="INDIA VIX" quote={vix} observedAt={vix?.timestamp ?? null} now={feed.now} sessionOpen={nse} />
        <Cell label="Angel One data" detail={`${angel?.detail ?? ''} ${ticks?.detail ?? ''}`}>
          {angel ? <HealthBadge status={angel.status} detail={angel.detail} /> : <FreshnessBadge state="UNAVAILABLE" />}
          {ticks && <HealthBadge status={ticks.status} detail={ticks.detail} />}
          <div className="text-xs text-[var(--text-secondary)]">{ticks?.observedAt ? `Last tick ${formatIstDateTime(ticks.observedAt, feed.now)}` : 'No tick recorded'}</div>
        </Cell>
        <Cell label="Dhan order flow" detail={dhan?.detail}>
          {dhan ? <HealthBadge status={dhan.status} detail={dhan.detail} /> : <FreshnessBadge state="UNAVAILABLE" />}
          <div className="text-xs text-[var(--text-secondary)]">Delta is inferred, not exchange delta.</div>
        </Cell>
        <Cell label="WebSocket (this browser)" detail={sock?.detail}>
          {sock ? <HealthBadge status={sock.status} detail={sock.detail} /> : null}
          <div className="text-xs text-[var(--text-secondary)]">Connected is not the same as current: see each quote&apos;s time.</div>
        </Cell>
        <Cell label="Overall" detail={h.headline}>
          <HealthBadge status={h.overall} detail={h.headline} />
          <div className="text-xs text-[var(--text-secondary)]">{h.apiReachable ? `Checked from observed evidence` : 'API unreachable from this browser'}</div>
        </Cell>
      </div>
    </Card>
  );
}
