'use client';

import React, { useState } from 'react';
import { isMarketOpen, type Exchange, type MarketQuote } from '@fno/shared';
import { useAssetTabsStore, useMarketStore } from '@/stores';
import { useBestSetups } from '@/lib/use-best-setups';
import { useNow } from '@/lib/use-health';
import { classifyFreshness, FRESH_WITHIN_MS } from '@/lib/freshness';
import { quoteObservedAt } from '@/lib/quote-time';
import { formatArrowPercent, formatNumber, MISSING } from '@/lib/format';
import type { SetupRow } from '@/lib/setups';
import { DecisionBadge, FreshnessBadge } from '@/components/ui/status-badge';
import { DataState } from '@/components/ui/data-state';
import { SetupDetail } from '@/components/best-setups/setups-table';
import { INSTRUMENTS } from './chart-section';

/** Navigates the existing chart; never fabricates mini-series from a single quote. */
export function DeskWatchlist({ instrumentIdx, onInstrument, quotes, now }: { instrumentIdx: number; onInstrument: (index: number) => void; quotes: MarketQuote[]; now: number }) {
  const [query, setQuery] = useState('');
  const shown = INSTRUMENTS.map((instrument, index) => ({ ...instrument, index })).filter((i) => `${i.symbol} ${i.label} ${i.exchange}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <section className="desk-watchlist desk-panel" aria-labelledby="desk-watch-title">
      <div className="desk-panel-heading"><h2 id="desk-watch-title" className="font-semibold">Watchlist</h2><span className="desk-eyebrow">Markets</span></div>
      <div className="p-3"><input aria-label="Search chart instruments" placeholder="Search instrument…" type="search" value={query} onChange={(e) => setQuery(e.target.value)} className="min-h-9 w-full rounded-md border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 text-sm" /></div>
      <div className="desk-watch-rows">
        {shown.map((i) => {
          const quote = quotes.find((q) => q.symbol === i.symbol && q.exchange === i.exchange);
          const freshness = classifyFreshness({ observedAt: quote ? quoteObservedAt(quote) : null, now, sessionOpen: isMarketOpen(i.exchange, now), transportConnected: null, freshWithinMs: FRESH_WITHIN_MS.quote });
          return <button key={i.symbol} type="button" className="desk-watch-row" aria-pressed={instrumentIdx === i.index} onClick={() => onInstrument(i.index)} aria-label={`Show ${i.label} chart`}>
            <span className="flex flex-wrap items-center justify-between gap-1"><span className="text-sm font-semibold">{i.label}</span><span className="text-sm font-semibold tabular-nums">{formatNumber(quote?.ltp ?? null)}</span></span>
            <span className="mt-1 flex items-center justify-between gap-1 text-xs"><span className="text-[var(--text-secondary)]">{i.exchange}</span><span className={quote && quote.changePercent < 0 ? 'text-[var(--status-bad)]' : 'text-[var(--status-ok)]'}>{quote ? formatArrowPercent(quote.changePercent) : MISSING}</span></span>
            <span className="mt-2 block text-xs text-[var(--text-secondary)]" title={freshness.detail}>{quote ? freshness.label : 'Quote unavailable'}</span>
          </button>;
        })}
      </div>
      {shown.length === 0 && <p className="p-4 text-sm text-[var(--text-secondary)]">No instruments match.</p>}
    </section>
  );
}

/** A presentation of the existing ranked records, scoped to the selected chart. */
export function SetupSpotlight({ symbol, exchange }: { symbol: string; exchange: Exchange }) {
  const s = useBestSetups();
  const now = useNow(5000);
  const setActiveTab = useMarketStore((st) => st.setActiveTab);
  const rows = s.rows.filter((r) => r.symbol === symbol && r.exchange === exchange);
  const [selected, setSelected] = useState<string | null>(null);
  const row = rows.find((r) => r.id === selected) ?? rows[0];
  return (
    <section className="desk-panel" aria-labelledby="spotlight-title">
      <div className="desk-panel-heading"><h2 id="spotlight-title" className="font-semibold">Setup spotlight</h2><button className="desk-link" onClick={() => setActiveTab('best-setups')}>View all →</button></div>
      <div className="p-4">
        <DataState loading={s.loading} error={s.error} hasData={!!row} isEmpty={!row} errorTitle="Could not load setups" emptyTitle={`No recorded setup for ${symbol}`} emptyHint={s.scanMeta?.unavailableReason ?? 'Select another instrument or view all setups.'} skeletonRows={4}>
          {row && <>
            {rows.length > 1 && <label className="mb-4 block text-xs text-[var(--text-secondary)]">Recorded candidates<select value={row.id} onChange={(e) => setSelected(e.target.value)} className="mt-1 min-h-9 w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-2 text-sm text-[var(--text-primary)]">{rows.map((r) => <option key={r.id} value={r.id}>{r.familyLabel} · {r.direction.toLowerCase()} · {r.stage ?? r.decision}</option>)}</select></label>}
            <SpotlightRecord key={row.id} row={row} now={now} />
          </>}
        </DataState>
      </div>
    </section>
  );
}

export function SpotlightRecord({ row, now }: { row: SetupRow; now: number }) {
  const openTab = useAssetTabsStore((s) => s.openTab);
  const freshness = classifyFreshness({ observedAt: row.observedAt, now, sessionOpen: isMarketOpen(row.exchange as Exchange, now), transportConnected: null, freshWithinMs: FRESH_WITHIN_MS.scan });
  const price = (n: number | null) => row.levels.basis === 'NONE' ? MISSING : formatNumber(n);
  return <div className="space-y-4">
    <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-2xl font-semibold tracking-tight">{row.symbol}</h3><span className="rounded border border-[var(--status-info)]/40 bg-[var(--status-info)]/10 px-2 py-1 text-xs text-[var(--status-info)]">{row.family}</span></div><p className={`mt-2 text-sm font-medium ${row.direction === 'BULLISH' ? 'text-[var(--status-ok)]' : 'text-[var(--status-bad)]'}`}>{row.direction === 'BULLISH' ? '▲ Bullish' : '▼ Bearish'} · {row.exchange}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{row.familyLabel}</p></div>
    <div className="flex flex-wrap gap-2"><DecisionBadge state={row.decision} /><FreshnessBadge state={freshness.state} detail={freshness.detail} /></div>
    <div className="border-y border-[var(--border-primary)] py-4">
      <p className="desk-eyebrow mb-3">{row.levels.basis === 'OPTION_PREMIUM' ? 'Planned option premium' : row.levels.basis === 'UNDERLYING' ? 'Planned underlying levels' : 'Levels unavailable'}</p>
      <dl className="grid grid-cols-3 gap-2 text-sm"><div><dt className="text-xs text-[var(--text-secondary)]">Entry</dt><dd className="mt-1 font-semibold tabular-nums">{price(row.levels.entry)}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">Stop</dt><dd className="mt-1 font-semibold tabular-nums text-[var(--status-bad)]">{price(row.levels.stop)}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">Target</dt><dd className="mt-1 font-semibold tabular-nums text-[var(--status-ok)]">{price(row.levels.target)}</dd></div></dl>
    </div>
    <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-[var(--text-secondary)]">Planned R:R · gross</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(row.rewardRisk)}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">Est. round-trip cost</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{row.estimatedCostPct == null ? MISSING : `${formatNumber(row.estimatedCostPct)}%`}</dd></div></dl>
    {(row.concern || row.decisionReason) && <p className="rounded-md border border-[var(--border-secondary)] bg-[var(--surface-card-alt)] p-3 text-xs leading-relaxed text-[var(--text-secondary)]">{row.concern ?? row.decisionReason}</p>}
    <button className="desk-primary w-full" onClick={() => openTab(row.symbol, row.exchange as Exchange)}>Inspect workspace <span aria-hidden="true" className="ml-3">→</span></button>
    <details className="border-t border-[var(--border-primary)] pt-3"><summary className="cursor-pointer text-sm font-medium text-[var(--desk-accent)]">View recorded evidence</summary><SetupDetail r={row} now={now} /></details>
  </div>;
}

export function StrategyResearch() {
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  return <section className="desk-panel" aria-labelledby="research-title">
    <div className="desk-panel-heading"><h2 id="research-title" className="font-semibold">Strategy research</h2><span className="desk-eyebrow">Shadow</span></div>
    <div className="divide-y divide-[var(--border-primary)]">
      {[['OB1', 'First touch vs rejection'], ['OF1', 'Control vs confirmation']].map(([family, label]) => <button key={family} onClick={() => setActiveTab('signal-diagnostics')} className="flex min-h-20 w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-card-alt)]"><span className={`rounded border px-2 py-1 text-xs font-semibold ${family === 'OB1' ? 'border-[var(--status-info)]/40 text-[var(--status-info)]' : 'border-[var(--accent-purple)]/40 text-[var(--accent-purple)]'}`}>{family}</span><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs text-[var(--text-secondary)]">Open recorded comparisons</span></span><span aria-hidden="true" className="text-[var(--text-secondary)]">›</span></button>)}
    </div>
  </section>;
}
