'use client';

// ============================================================
// PAPER — one blotter for both engines (redesign), then each engine's full detail
// ============================================================
// Top: open now, today's closes and the last 30 days per engine. Middle: one list of every paper trade of both
// engines (Open / Today / All, engine, result, search), each with its date, strategy, contract, entry → exit, net R,
// net ₹ where the engine records it, and the result with its reason. Below, unchanged: the legacy table with every
// filter and the new engine's status, cohort and reviews. Read-only; simulated.
// ============================================================

import React, { useMemo, useState } from 'react';
import { PageBody, PageHeader, Section, MetricGrid, MetricTile } from '@/components/ui/card';
import { ActionButton, FilterBar, SearchField, SegmentedControl, SelectField, SimulatedNotice, ChipToggle } from '@/components/ui/controls';
import { DataState } from '@/components/ui/data-state';
import { ResultBadge } from '@/components/ui/status-badge';
import { usePaperTrades } from '@/lib/use-paper-trades';
import { useFreshStart } from '@/lib/use-fresh-start';
import { useNow } from '@/lib/use-health';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { byMintedDesc, countTrades, DEFAULT_FILTERS, distinct, filterTrades, type PeriodFilter, type StateFilter, type TradeFilters } from '@/lib/paper-trade-view';
import { blotter, DEFAULT_BLOTTER, fromFresh, fromLegacy, summarize, type BlotterFilter, type BlotterRow } from '@/lib/paper-unified';
import { positionViews, strategyName } from '@/lib/command-center';
import { formatIstDateTime } from '@/lib/format';
import { useAssetTabsStore } from '@/stores';
import { TradeDetail, TradesTable } from './trades-table';
import { FreshStartPanel } from './fresh-start';
import { AutomaticTradeReviews } from './automatic-reviews';

const STATE_OPTIONS: ReadonlyArray<{ id: StateFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'OPEN', label: 'Open' },
  { id: 'CLOSED', label: 'Closed' },
  { id: 'EXPIRED', label: 'Expired' },
  { id: 'WIN', label: 'Win' },
  { id: 'LOSS', label: 'Loss' },
];

const EXCLUSION_LABEL: Record<string, string> = {
  VOIDED: 'voided',
  TRACKING_LOST: 'tracking lost',
  OFF_SESSION: 'off-session',
  SPREAD: 'spread',
  INCOMPLETE: 'incomplete record',
  OTHER: 'other',
};

const PAGE = 40;
const istDay = (t: number) => new Date(t + 19_800_000).toISOString().slice(0, 10);
const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const px = (v: number | null) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const sgnR = (v: number | null) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`);
const inr = (v: number | null) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
const tone = (v: number | null) => (v == null || v === 0 ? '' : v > 0 ? 'td-up' : 'td-dn');

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<{ id: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="pp-chips">
      {options.map((o) => <button key={o.id} type="button" className="cc-chip" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

function FreshDetail({ r }: { r: BlotterRow }) {
  const p = r.fresh!;
  const rows: Array<[string, React.ReactNode]> = [
    ['Strategy', r.strategy], ['Contract', r.contract], ['Opened', formatIstDateTime(p.openedAt)], ['Closed', p.closedAt ? formatIstDateTime(p.closedAt) : '—'],
    ['Entry → exit', `${px(p.entry)} → ${px(p.exit)}`], ['Quantity', p.quantity ? p.quantity.toLocaleString('en-IN') : '—'], ['Risk at entry', p.riskCurrency ? `₹${Math.round(p.riskCurrency).toLocaleString('en-IN')}` : '—'],
    ['Underlying stop / target', `${px(p.underlyingStop)} / ${px(p.underlyingTarget)}`], ['Fees (estimated)', p.fees != null ? `₹${Math.round(p.fees).toLocaleString('en-IN')}` : '—'],
    ['Result', `${r.result}${r.reason ? ` — ${r.reason}` : ''}`], ['Order-flow tag at entry', p.orderFlow],
  ];
  return <dl className="pp-detail">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export function PaperTradesPage() {
  const { data, loading, error, fetchedAt, reload } = usePaperTrades(2000);
  const fresh = useFreshStart();
  const now = useNow(5000);
  const feed = useFeedSummary();
  const openAsset = useAssetTabsStore((s) => s.openTab);

  // ---- the one blotter ----
  const [bf, setBf] = useState<BlotterFilter>(DEFAULT_BLOTTER);
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const today = istDay(now);
  const unified = useMemo(() => [...(data?.trades ?? []).map(fromLegacy), ...positionViews(fresh.data).map((p) => fromFresh(p, strategyName))], [data, fresh.data]);
  const rows = useMemo(() => blotter(unified, bf, today), [unified, bf, today]);
  const sum = useMemo(() => summarize(unified, today, now), [unified, today, now]);
  const setB = <K extends keyof BlotterFilter>(k: K, v: BlotterFilter[K]) => { setBf((f) => ({ ...f, [k]: v })); setLimit(PAGE); setExpanded(null); };

  // ---- the legacy table, unchanged ----
  const [filters, setFilters] = useState<TradeFilters>(DEFAULT_FILTERS);
  const set = <K extends keyof TradeFilters>(k: K, v: TradeFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const all = useMemo(() => [...(data?.trades ?? [])].sort(byMintedDesc), [data]);
  const shown = useMemo(() => filterTrades(all, filters), [all, filters]);
  const counts = useMemo(() => countTrades(shown), [shown]);
  const families = useMemo(() => distinct(all, (t) => t.family), [all]);
  const versions = useMemo(() => distinct(all, (t) => t.logicVersion), [all]);
  const exclusions = Object.entries(counts.excluded);
  const engines = sum.window;

  return (
    <PageBody>
      <PageHeader
        title="Paper Trades"
        subtitle="Every simulated trade of both engines in one list, with its date, result and reason. These are the system's own records; this page recomputes nothing."
        actions={<ActionButton onClick={() => { reload(); }}>Refresh</ActionButton>}
      />
      <SimulatedNotice />

      <section className="td-p" aria-labelledby="pp-sum"><header><h2 id="pp-sum">Paper book</h2><span className="td-pm">both engines · counted trades only · data as of {formatIstDateTime(fetchedAt, now)}</span></header>
        <div className="pp-kpis">
          <div><div className="td-kl">Open now</div><div className="td-kv">{sum.open}</div><div className="td-ks">both engines</div></div>
          <div><div className="td-kl">Closed today</div><div className={`td-kv ${tone(sum.today.closed ? sum.today.netR : null)}`}>{sum.today.closed ? sgnR(sum.today.netR) : '—'}</div><div className="td-ks">{sum.today.closed} closed · {sum.today.wins} profit · {sum.today.losses} loss · {sum.today.expired} expired</div></div>
          {(['Legacy', 'New engine'] as const).map((e) => <div key={e}><div className="td-kl">{e} · 30 days</div><div className={`td-kv ${tone(engines[e].closed ? engines[e].netR : null)}`}>{engines[e].closed ? sgnR(engines[e].netR) : '—'}</div><div className="td-ks">{engines[e].closed} closed · win {engines[e].winRate != null ? `${engines[e].winRate}%` : '—'}</div></div>)}
          <div><div className="td-kl">Best · 30 days</div><div className="pp-strat td-up">{sum.best ? `${sum.best.strategy} ${sgnR(sum.best.netR)}` : '—'}</div><div className="td-kl" style={{ marginTop: 8 }}>Weakest · 30 days</div><div className="pp-strat td-dn">{sum.worst ? `${sum.worst.strategy} ${sgnR(sum.worst.netR)}` : '—'}</div></div>
        </div>
      </section>

      <section className="td-p" aria-labelledby="pp-blotter"><header><h2 id="pp-blotter">All paper trades</h2><span className="td-pm">{rows.length} rows · click a row for its detail</span></header>
        <div className="pp-toolbar">
          <Chips label="View" value={bf.view} onChange={(v) => setB('view', v)} options={[{ id: 'TODAY', label: 'Today + open' }, { id: 'OPEN', label: 'Open' }, { id: 'ALL', label: 'All' }]} />
          <Chips label="Engine" value={bf.engine} onChange={(v) => setB('engine', v)} options={[{ id: 'ALL', label: 'Both engines' }, { id: 'Legacy', label: 'Legacy' }, { id: 'New engine', label: 'New engine' }]} />
          <Chips label="Result" value={bf.result} onChange={(v) => setB('result', v)} options={[{ id: 'ALL', label: 'Any result' }, { id: 'PROFIT', label: 'Profit' }, { id: 'LOSS', label: 'Loss' }, { id: 'EXPIRED', label: 'Expired' }]} />
          <SearchField value={bf.query} onChange={(v) => setB('query', v)} placeholder="Symbol or strategy" label="Search paper trades" />
        </div>
        {(loading && !data) ? <p className="td-empty">Loading paper trades…</p> : rows.length === 0 ? <p className="td-empty">{bf.view === 'TODAY' ? 'No paper trade today and nothing open. Choose “All” for the history.' : 'No paper trade matches these filters.'}</p> : (
          <div className="td-scroll"><table className="td-table pp-table">
            <thead><tr><th>Date</th><th>Engine · strategy</th><th>Contract</th><th>Dir</th><th className="td-r">Entry → exit</th><th className="td-r">Net R</th><th className="td-r">Net ₹</th><th>Result</th></tr></thead>
            <tbody>
              {rows.slice(0, limit).map((r) => (
                <React.Fragment key={r.key}>
                  <tr className="td-row" aria-expanded={expanded === r.key} onClick={() => setExpanded(expanded === r.key ? null : r.key)}>
                    <td className="td-num"><div>{r.dateLabel}</div><div className="td-sm td-mut">{hhmm(r.openedAt)}{r.closedAt ? ` → ${hhmm(r.closedAt)}` : ''}</div></td>
                    <td><div>{r.strategy}</div><div className="td-ex">{r.engine}</div></td>
                    <td><button type="button" className="td-sym" onClick={(e) => { e.stopPropagation(); if (r.engine === 'Legacy') openAsset(r.symbol, r.exchange as 'NSE' | 'BSE' | 'MCX'); else setExpanded(r.key); }} title={r.engine === 'Legacy' ? `Open ${r.symbol}` : 'Show the detail'}>{r.contract}</button><div className="td-ex">{r.exchange}</div></td>
                    <td className={r.direction === 'BULLISH' ? 'td-up' : r.direction === 'BEARISH' ? 'td-dn' : 'td-mut'}>{r.direction === 'BULLISH' ? '▲' : r.direction === 'BEARISH' ? '▼' : '—'}</td>
                    <td className="td-num td-r">{px(r.entry)} → {r.open ? <span className="td-mut">{r.mark != null ? `${px(r.mark)} mark` : 'open'}</span> : px(r.exit)}</td>
                    <td className={`td-num td-r ${tone(r.netR)}`}>{sgnR(r.netR)}{r.open && r.netR != null && <div className="td-sm td-mut">unrealised</div>}</td>
                    <td className={`td-num td-r ${tone(r.netInr)}`}>{inr(r.netInr)}</td>
                    <td><ResultBadge result={r.result} reason={r.reason} />{r.excluded && <div className="td-sm td-wa">not counted: {r.excluded}</div>}</td>
                  </tr>
                  {expanded === r.key && <tr className="pp-expand"><td colSpan={8}>{r.legacy ? <TradeDetail t={r.legacy} now={now} /> : <FreshDetail r={r} />}</td></tr>}
                </React.Fragment>
              ))}
            </tbody>
          </table></div>
        )}
        {rows.length > limit && <button type="button" className="td-more" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}</button>}
      </section>

      <Section title="New engine · status, cohort and reviews" subtitle="Activation, feeds, markets, adapter decisions and every strategy's validation figures." collapsible defaultOpen={false}>
        <FreshStartPanel />
        <AutomaticTradeReviews />
      </Section>

      <Section title="Legacy engine · full table and filters" subtitle="Cohorts, versions, performance eligibility and estimated costs, exactly as before." collapsible defaultOpen={false}>
        <DataState loading={loading} error={error} hasData={!!data} isEmpty={!!data && data.trades.length === 0} onRetry={reload} errorTitle="Could not load paper trades" emptyTitle="No paper trades have been recorded yet" emptyHint="They appear here as the engines mint them during a session." staleNote={data?.counts.truncated ? `Showing the newest ${all.length} of ${data.counts.recorded} recorded paper trades (every open trade is included). Older closed trades are not on this page.` : undefined}>
          <MetricGrid min={140}>
            <MetricTile label="Rows shown" value={counts.shown} sub={`of ${data?.counts.recorded ?? all.length} recorded`} />
            <MetricTile label="Open" value={counts.open} sub={`${counts.openTracked} tracked · ${counts.openUntracked} not tracked`} tone={counts.openUntracked > 0 ? 'warn' : undefined} />
            <MetricTile label="Win" value={counts.win} tone="ok" />
            <MetricTile label="Loss" value={counts.loss} tone="bad" />
            <MetricTile label="Expired" value={counts.expired} sub="own category, never counted as win or loss" />
            {counts.expiredUntracked > 0 && (
              <MetricTile label="Expired, untracked" value={counts.expiredUntracked} sub="no exit price was ever recorded (abandoned or tracking lost); never in performance" tone="warn" />
            )}
            <MetricTile label="Count in performance" value={counts.includedClosed} sub={`of ${counts.win + counts.loss + counts.expired + counts.expiredUntracked} closed shown`} />
          </MetricGrid>
          {exclusions.length > 0 && (
            <p className="mt-3 text-sm text-[var(--text-secondary)]">
              Closed trades not counted in performance: {exclusions.map(([k, n]) => `${n} ${EXCLUSION_LABEL[k] ?? k.toLowerCase()}`).join(', ')}. Each is shown with its status.
            </p>
          )}
          {data && <p className="mt-1 mb-3 text-xs text-[var(--text-secondary)]">Measurement-reliable period starts {formatIstDateTime(Date.parse(data.measurementReliableFrom), now)}; earlier trades are historical and were not recorded with the newer cost and tracking data.</p>}
          <FilterBar label="Paper trade filters">
            <SegmentedControl label="State" value={filters.state} onChange={(v) => set('state', v)} options={STATE_OPTIONS} />
            <SegmentedControl<PeriodFilter>
              label="Period"
              value={filters.period}
              onChange={(v) => set('period', v)}
              options={[
                { id: 'ALL', label: 'All periods' },
                { id: 'HISTORICAL', label: 'Historical', title: 'Minted before the measurement-reliable start' },
                { id: 'RELIABLE', label: 'Measurement-reliable', title: 'Minted from the measurement-reliable start' },
              ]}
            />
            <SelectField label="Strategy" value={filters.family} onChange={(v) => set('family', v)} options={[{ id: '', label: 'All' }, ...families.map((f) => ({ id: f, label: f }))]} />
            <SelectField label="Version" value={filters.version} onChange={(v) => set('version', v)} options={[{ id: '', label: 'All' }, ...versions.map((f) => ({ id: f, label: f.length > 36 ? `${f.slice(0, 36)}…` : f }))]} />
            <SelectField label="Exchange" value={filters.exchange} onChange={(v) => set('exchange', v)} options={[{ id: '', label: 'All' }, { id: 'NSE', label: 'NSE' }, { id: 'BSE', label: 'BSE' }, { id: 'MCX', label: 'MCX' }]} />
            <SearchField value={filters.symbol} onChange={(v) => set('symbol', v)} placeholder="Symbol" label="Filter by symbol" />
            <ChipToggle pressed={!filters.includeExcluded} onToggle={() => set('includeExcluded', !filters.includeExcluded)} title="Hide closed trades that do not count in performance">
              Hide excluded
            </ChipToggle>
            <ActionButton onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</ActionButton>
          </FilterBar>
          <TradesTable trades={shown} now={now} apiReachable={feed.apiReachable} pageSize={25} />
        </DataState>
      </Section>
    </PageBody>
  );
}
