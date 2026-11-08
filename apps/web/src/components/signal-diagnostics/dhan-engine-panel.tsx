'use client';

// ============================================================
// SIGNAL DIAGNOSTICS — Dhan order-flow engine v2 (phase 5 dashboard)
// ============================================================
// Setup board (A–D and expiry gamma: SIGNAL / NO_TRADE with score, gates, no-trade reasons and the paper decision),
// per-contract engine state (CVD, VWAP, profile, structure) and the latest bar's footprint ladder with diagonal
// imbalances. Every number carries its status: ESTIMATED (inferred aggressor sides), VERIFIED, APPROXIMATION,
// INCOMPLETE (withheld) or UNAVAILABLE — an estimate is never shown as exchange truth, a gap never as zero.
// Paper only; a signal is not evidence that a setup is profitable.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Section, MetricGrid, MetricTile } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { ErrorNotice, SkeletonRows } from '@/components/ui/data-state';
import { formatNumber, MISSING } from '@/lib/format';

export type EngineStatus = 'VERIFIED' | 'ESTIMATED' | 'APPROXIMATION' | 'INCOMPLETE' | 'UNAVAILABLE';

/** Mirrors apps/server/src/services/dhan-engine-state.ts dhanEngineSummary(). */
export interface DhanEngineContract { symbol: string; kind: string | null; bars: number; incompleteBars: number; cvd: number | null; cvdStatus: string; vwap: number | null; vwapStatus: string; poc: number | null; footprint: string; trend: string | null }
export interface DhanEngineSummary { note: string; contracts: DhanEngineContract[] }

export interface LadderRow { price: number; ask: number; bid: number; unknown: number; buyRatio: number | null; sellRatio: number | null; buyImbalance: boolean; sellImbalance: boolean }
/** Mirrors dhanEngineSnapshot(). */
export interface DhanEngineSnapshot {
  symbol: string; version: string; session: string; exchange: string; instrument: string | null; kind: string | null; tickSize: number | null;
  bars: number; tradedBars: number; incompleteBars: number;
  lastBar: { barTime: number; deltaMode: string; delta: number | null; deltaPct: number | null; incomplete: boolean; unreconciledVolume: number | null } | null;
  footprint: { status: EngineStatus; reason: string | null; barTime: number; priceStep: number | null; minLevelVolume: number | null; buyImbalances: number; sellImbalances: number; stacks: Array<{ side: 'BUY' | 'SELL'; low: number; high: number; rows: number }>; rows?: LadderRow[] } | null;
  cvd: { last: { cvd: number; status: EngineStatus } | null; series?: Array<{ time: number; delta: number | null; cvd: number; status: EngineStatus }>; divergences: Array<{ side: string; time: number; price: [number, number]; cvd: [number, number] }> };
  profile: { status: EngineStatus; reason: string | null; poc: number | null; vah: number | null; val: number | null; valueAreaShare: number | null; hvn: number[]; lvn: number[]; total: number };
  vwap: { status: EngineStatus; source: string; vwap: number | null; sd: number | null; distanceSd: number | null; bands: { upper1: number; lower1: number; upper2: number; lower2: number } | null };
  atr: { value: number | null; source: string };
  structure: { source: string; trend: string; lastSwingHigh: number | null; lastSwingLow: number | null; lastBreak: { type: string; side: string; level: number; time: number | null } | null } | null;
  absorption: Array<{ side: string; zone: number; state: string; time: number | null }>;
  exhaustion: Array<{ side: string; extreme: number; state: string; time: number | null }>;
}

export interface DhanSignalRow {
  strategy: string; side: string; symbol: string; instrument: string | null; exchange: string | null; bar_time: string; status: string; score: number | null; eligibility: string | null;
  entry: string | number | null; stop_loss: string | number | null; target: string | number | null; rr: string | number | null; session_window: string | null;
  no_trade: { reasons: string[]; notEvaluated: string[] } | null; gates: Array<{ id: string; ok: boolean }> | null; paper_decision?: string | null;
}
export interface DhanSignalsReport {
  mode: string; day: string;
  status: { recorded: { SIGNAL: number; NO_TRADE: number }; paper?: Record<string, number>; contracts: number; firstFailures: Array<{ k: string; c: number }>; gamma: Array<{ index: string; samples: number; fired: string[] }> };
  signals: DhanSignalRow[];
}

export interface DhanCohortStats { trades: number; wins: number; losses: number; open: number; winRate: number | null; expectancyR: number | null; netExpectancyR: number | null; profitFactor: number | null; maxDrawdownR: number | null; totalR: number; totalNetR: number; sample: 'OK' | 'SMALL_SAMPLE' }
/** Mirrors apps/server/src/services/dhan-engine-validation.ts dhanValidation(). */
export interface DhanValidationReport {
  from: string; to: string; signals: number; ungradable: number; costBasis?: string; candleBacktest: string; overall: DhanCohortStats;
  byStrategy: Array<{ strategy: string; stats: DhanCohortStats; split: { inSample: DhanCohortStats; outOfSample: DhanCohortStats } }>;
  rejected?: DhanCohortStats;
}

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'off' | 'info'> = { VERIFIED: 'ok', ESTIMATED: 'warn', APPROXIMATION: 'warn', INCOMPLETE: 'bad', UNAVAILABLE: 'off', SIGNAL: 'ok', NO_TRADE: 'off' };
const TITLE: Record<string, string> = {
  VERIFIED: 'Exchange-published values.',
  ESTIMATED: 'Built from inferred aggressor sides (quote rule, then tick rule): an estimate, not exchange delta.',
  APPROXIMATION: 'Computed from candles where the definition wants trades.',
  INCOMPLETE: 'Too much unreconciled volume or a data gap: withheld.',
  UNAVAILABLE: 'Not enough input to compute.',
};
export const EngineBadge = ({ status }: { status: string }) => <StatusBadge tone={TONE[status] ?? 'off'} label={status} title={TITLE[status]} />;

const ist = (t: number | string | null) => (t == null ? MISSING : new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }));
const n = (v: string | number | null | undefined) => (v == null ? null : Number(v));
const pretty = (s: string) => s.replace(/^DHAN_/, '').replace(/_/g, ' ').toLowerCase();

export function DhanEnginePanel() {
  const [summary, setSummary] = useState<DhanEngineSummary | null>(null);
  const [signals, setSignals] = useState<DhanSignalsReport | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [snap, setSnap] = useState<DhanEngineSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<DhanValidationReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getDhanEngineValidation().then((v) => !cancelled && setValidation(v)).catch(() => undefined);
    Promise.all([api.getDhanEngineSummary(), api.getDhanEngineSignals()])
      .then(([s, g]) => { if (cancelled) return; setSummary(s); setSignals(g); setError(null); })
      .catch((e) => !cancelled && setError(e?.message ?? 'Could not load the Dhan engine.'));
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api.getDhanEngineSnapshot(selected).then((d) => !cancelled && setSnap(d)).catch(() => !cancelled && setSnap(null));
    return () => { cancelled = true; };
  }, [selected]);

  const signalCols = useMemo<Column<DhanSignalRow>[]>(() => [
    { id: 't', header: 'Bar (IST)', sortValue: (r) => r.bar_time, cell: (r) => ist(r.bar_time) },
    { id: 'sym', header: 'Contract', cell: (r) => <span className="font-medium">{r.symbol}</span> },
    { id: 'st', header: 'Setup', cell: (r) => <span>{pretty(r.strategy)} <span className="text-xs text-[var(--text-secondary)]">{r.side.toLowerCase()}</span></span> },
    { id: 'status', header: 'Status', cell: (r) => <EngineBadge status={r.status} /> },
    { id: 'score', header: 'Score', numeric: true, sortValue: (r) => r.score, cell: (r) => (r.score == null ? MISSING : `${r.score}/10`) },
    { id: 'plan', header: 'Entry / SL / Target', cell: (r) => (r.entry == null ? MISSING : `${formatNumber(n(r.entry))} / ${formatNumber(n(r.stop_loss))} / ${formatNumber(n(r.target))}`) },
    { id: 'rr', header: 'R:R (gross)', numeric: true, cell: (r) => formatNumber(n(r.rr)) },
    { id: 'why', header: 'Rejected because', cell: (r) => [...(r.gates ?? []).filter((g) => !g.ok).map((g) => g.id), ...(r.no_trade?.reasons ?? [])].join(', ') || (r.status === 'SIGNAL' ? '—' : `score ${r.eligibility?.toLowerCase() ?? MISSING}`) },
    { id: 'paper', header: 'Paper', cell: (r) => r.paper_decision ?? (r.status === 'SIGNAL' ? 'pending' : MISSING) },
  ], []);
  const contractCols = useMemo<Column<DhanEngineContract>[]>(() => [
    { id: 's', header: 'Contract', sortValue: (r) => r.symbol, cell: (r) => <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => setSelected(r.symbol)}>{r.symbol}</button> },
    { id: 'k', header: 'Kind', cell: (r) => r.kind?.toLowerCase() ?? MISSING },
    { id: 'b', header: 'Bars', numeric: true, sortValue: (r) => r.bars, cell: (r) => `${r.bars}${r.incompleteBars ? ` (${r.incompleteBars} incomplete)` : ''}` },
    { id: 'cvd', header: 'Session CVD', numeric: true, cell: (r) => <span className="inline-flex items-center gap-2">{formatNumber(r.cvd)} <EngineBadge status={r.cvdStatus} /></span> },
    { id: 'vwap', header: 'VWAP', numeric: true, cell: (r) => <span className="inline-flex items-center gap-2">{formatNumber(r.vwap)} <EngineBadge status={r.vwapStatus} /></span> },
    { id: 'poc', header: 'POC', numeric: true, cell: (r) => formatNumber(r.poc) },
    { id: 'fp', header: 'Footprint', cell: (r) => <EngineBadge status={r.footprint} /> },
    { id: 'tr', header: 'Structure (15m)', cell: (r) => r.trend?.toLowerCase() ?? MISSING },
  ], []);

  if (error) return <ErrorNotice title="Could not load the Dhan engine" detail={error} />;
  if (!summary || !signals) return <SkeletonRows rows={4} label="Loading the Dhan engine" />;

  const st = signals.status;
  return (
    <div className="space-y-5">
      <Section title="Dhan engine v2: setup board" subtitle={`Setups A–D and expiry gamma, ${signals.day}. Signals are paper-traded in options only (expiry gamma: expiry-day option, 30% premium stop, 15:15 time exit). A signal is not evidence of profitability.`}>
        <MetricGrid>
          <MetricTile label="SIGNAL" value={st.recorded.SIGNAL} sub="every condition, gate, score ≥ 7 and no-trade clear" />
          <MetricTile label="NO_TRADE" value={st.recorded.NO_TRADE} sub="conditions met, then rejected" />
          <MetricTile label="Contracts evaluated" value={st.contracts} />
          <MetricTile label="Paper decisions" value={Object.values(st.paper ?? {}).reduce((a, x) => a + x, 0)} sub={Object.entries(st.paper ?? {}).map(([k, v]) => `${k.toLowerCase().replace(/_/g, ' ')} ${v}`).join(' · ') || 'none yet'} />
        </MetricGrid>
        <div className="mt-4">
          <DataTable columns={signalCols} rows={signals.signals} rowKey={(r) => `${r.strategy}:${r.side}:${r.symbol}:${r.bar_time}`} ariaLabel="Dhan engine signals" pageSize={20} emptyTitle="No setup has met its conditions today" emptyHint="Most bars end at the first condition; see the table below." />
        </div>
        {st.firstFailures.length > 0 && (
          <details className="mt-3 text-sm text-[var(--text-secondary)]">
            <summary className="cursor-pointer">Where setups stopped (first failed condition)</summary>
            <ul className="mt-2 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">{st.firstFailures.map((f) => <li key={f.k}>{pretty(f.k)}: {f.c}</li>)}</ul>
          </details>
        )}
        {st.gamma.length > 0 && <p className="mt-2 text-xs text-[var(--text-secondary)]">Expiry gamma chain samples: {st.gamma.map((g) => `${g.index} ${g.samples}${g.fired.length ? ` (fired ${g.fired.join(', ').toLowerCase()})` : ''}`).join(' · ')}</p>}
      </Section>

      <Section title="Contract engines" subtitle="Per futures contract, this session. Click a contract for its footprint ladder. Delta, CVD and imbalances are ESTIMATED from inferred sides.">
        <DataTable columns={contractCols} rows={summary.contracts} rowKey={(r) => r.symbol} ariaLabel="Dhan engine contracts" pageSize={25} emptyTitle="No contract has closed a bar this session" />
      </Section>

      {selected && snap && <ContractDetail snap={snap} />}

      {validation && <ValidationSection v={validation} />}
    </div>
  );
}

export function ContractDetail({ snap }: { snap: DhanEngineSnapshot }) {
  const fp = snap.footprint;
  const rows = [...(fp?.rows ?? [])].sort((a, b) => b.price - a.price);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.ask, r.bid)));
  return (
    <Section title={`${snap.symbol} · ${snap.instrument ?? ''}`} subtitle={`Engine ${snap.version}, session ${snap.session}. ${snap.tradedBars} traded bars, ${snap.incompleteBars} incomplete.`}>
      <MetricGrid>
        <MetricTile label="Session CVD" value={snap.cvd.last ? formatNumber(snap.cvd.last.cvd) : MISSING} sub={snap.cvd.last?.status ?? 'UNAVAILABLE'} tone={snap.cvd.last?.status === 'INCOMPLETE' ? 'bad' : undefined} />
        <MetricTile label={`VWAP (${snap.vwap.source.toLowerCase()})`} value={formatNumber(snap.vwap.vwap)} sub={`${snap.vwap.status} · ${snap.vwap.distanceSd == null ? MISSING : `${snap.vwap.distanceSd} SD`}`} />
        <MetricTile label="POC / VAH / VAL" value={snap.profile.poc == null ? MISSING : `${formatNumber(snap.profile.poc)}`} sub={`${formatNumber(snap.profile.vah)} / ${formatNumber(snap.profile.val)} · ${snap.profile.status}`} />
        <MetricTile label="Structure (15m)" value={snap.structure?.trend.toLowerCase() ?? MISSING} sub={snap.structure?.lastBreak ? `${snap.structure.lastBreak.type} ${snap.structure.lastBreak.side.toLowerCase()} @ ${formatNumber(snap.structure.lastBreak.level)}` : 'no break yet'} />
      </MetricGrid>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm"><span className="font-medium">Footprint ladder, bar {ist(fp?.barTime ?? null)}</span>{fp && <EngineBadge status={fp.status} />}</div>
          {fp?.reason && <p className="mb-2 text-xs text-[var(--text-secondary)]">{fp.reason.replace(/_/g, ' ').toLowerCase()}</p>}
          {rows.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">No rows: no trades in the latest bar.</p> : (
            <table className="w-full text-xs" aria-label="Footprint ladder">
              <thead><tr className="text-[var(--text-secondary)]"><th className="text-right">Bid (sold)</th><th className="text-center">Price</th><th className="text-left">Ask (bought)</th><th className="text-right">Unknown</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.price} data-buy-imbalance={r.buyImbalance || undefined} data-sell-imbalance={r.sellImbalance || undefined}>
                    <td className={`text-right ${r.sellImbalance ? 'font-semibold text-[var(--status-bad)]' : ''}`}><span className="inline-block h-2 rounded-sm bg-[var(--status-bad)] align-middle opacity-40" style={{ width: `${(r.bid / max) * 60}px` }} /> {r.bid}</td>
                    <td className="text-center tabular-nums">{r.price}</td>
                    <td className={r.buyImbalance ? 'font-semibold text-[var(--status-ok)]' : ''}>{r.ask} <span className="inline-block h-2 rounded-sm bg-[var(--status-ok)] align-middle opacity-40" style={{ width: `${(r.ask / max) * 60}px` }} /></td>
                    <td className="text-right text-[var(--text-secondary)]">{r.unknown || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {fp && <p className="mt-2 text-xs text-[var(--text-secondary)]">Diagonal imbalance ≥ 300% (min row volume {formatNumber(fp.minLevelVolume)}): {fp.buyImbalances} buy, {fp.sellImbalances} sell{fp.stacks.length ? ` · stacks ${fp.stacks.map((s) => `${s.side.toLowerCase()} ${s.low}–${s.high}`).join(', ')}` : ''}.</p>}
        </div>
        <div className="space-y-2 text-sm">
          <p><span className="font-medium">CVD divergences:</span> {snap.cvd.divergences.length ? snap.cvd.divergences.map((d) => `${d.side.toLowerCase()} at ${ist(d.time)}`).join(', ') : 'none'}</p>
          <p><span className="font-medium">Absorption:</span> {snap.absorption.length ? snap.absorption.map((a) => `${a.side.toLowerCase()} ${formatNumber(a.zone)} (${a.state.toLowerCase()})`).join(', ') : 'none'}</p>
          <p><span className="font-medium">Exhaustion:</span> {snap.exhaustion.length ? snap.exhaustion.map((e) => `${e.side.toLowerCase()} ${formatNumber(e.extreme)} (${e.state.toLowerCase()})`).join(', ') : 'none'}</p>
          <p><span className="font-medium">HVN / LVN:</span> {snap.profile.hvn.join(', ') || MISSING} / {snap.profile.lvn.join(', ') || MISSING}</p>
          {snap.cvd.series && snap.cvd.series.length > 1 && <CvdSpark series={snap.cvd.series} />}
          <p className="text-xs text-[var(--text-secondary)]">ATR: {formatNumber(snap.atr.value)} ({snap.atr.source.replace(/_/g, ' ').toLowerCase()}). Last bar delta {formatNumber(snap.lastBar?.delta ?? null)}{snap.lastBar?.incomplete ? ' (incomplete: withheld)' : ''}.</p>
        </div>
      </div>
    </Section>
  );
}

/** Session CVD as a small line; incomplete points are drawn dashed (the running total no longer equals the session's). */
export function CvdSpark({ series }: { series: Array<{ time: number; cvd: number; status: string }> }) {
  const w = 280, h = 60, lo = Math.min(0, ...series.map((p) => p.cvd)), hi = Math.max(0, ...series.map((p) => p.cvd)), span = hi - lo || 1;
  const x = (i: number) => (i / (series.length - 1)) * w, y = (v: number) => h - ((v - lo) / span) * h;
  const firstGap = series.findIndex((p) => p.status === 'INCOMPLETE');
  const pts = (a: typeof series, off: number) => a.map((p, i) => `${x(i + off).toFixed(1)},${y(p.cvd).toFixed(1)}`).join(' ');
  const solid = firstGap < 0 ? series : series.slice(0, Math.max(1, firstGap));
  return (
    <svg role="img" aria-label="Session CVD" width={w} height={h} className="block">
      <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="var(--border-primary)" />
      <polyline fill="none" stroke="var(--accent-primary, currentColor)" strokeWidth={1.5} points={pts(solid, 0)} />
      {firstGap >= 0 && <polyline fill="none" stroke="var(--status-bad)" strokeDasharray="3 3" strokeWidth={1.5} points={pts(series.slice(Math.max(0, firstGap - 1)), Math.max(0, firstGap - 1))} />}
    </svg>
  );
}

const pctOf = (x: number | null) => (x == null ? MISSING : `${(x * 100).toFixed(0)}%`);
export function ValidationSection({ v }: { v: DhanValidationReport }) {
  const rows = [{ strategy: 'ALL SIGNALS', stats: v.overall, split: null as DhanValidationReport['byStrategy'][number]['split'] | null }, ...v.byStrategy];
  const cols: Column<(typeof rows)[number]>[] = [
    { id: 's', header: 'Setup', cell: (r) => <span className="font-medium">{pretty(r.strategy)}</span> },
    { id: 'n', header: 'Trades', numeric: true, cell: (r) => <span>{r.stats.trades}{r.stats.sample === 'SMALL_SAMPLE' && <span className="ml-1 text-xs text-[var(--status-warn)]" title="Below 200 trades: a sample, not evidence">sample</span>}</span> },
    { id: 'w', header: 'Win rate', numeric: true, cell: (r) => pctOf(r.stats.winRate) },
    { id: 'e', header: 'Expectancy R (net)', numeric: true, cell: (r) => `${formatNumber(r.stats.expectancyR)} (${formatNumber(r.stats.netExpectancyR)})` },
    { id: 'pf', header: 'Profit factor', numeric: true, cell: (r) => formatNumber(r.stats.profitFactor) },
    { id: 'dd', header: 'Max DD (R)', numeric: true, cell: (r) => formatNumber(r.stats.maxDrawdownR) },
    { id: 'oos', header: 'Out-of-sample (last 30%)', cell: (r) => (r.split ? `${r.split.outOfSample.trades} trades · ${pctOf(r.split.outOfSample.winRate)} · ${formatNumber(r.split.outOfSample.expectancyR)} R` : MISSING) },
  ];
  return (
    <Section title="Validation: recorded signals graded" subtitle={`${v.from} to ${v.to}. Each SIGNAL walked forward on the recorded trades of its session (a bar touching stop and target counts the stop). Net = after ${v.costBasis ?? 'slippage'}. No parameter is tuned on this.`}>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.strategy} ariaLabel="Dhan engine validation" pageSize={10} emptyTitle="No graded signals yet" />
      <p className="mt-2 text-xs text-[var(--text-secondary)]">{v.signals} signals in range, {v.ungradable} not gradable (no later trades). {v.rejected ? `Rejected (NO_TRADE) setups, graded separately: ${v.rejected.trades} trades, win rate ${pctOf(v.rejected.winRate)}, expectancy ${formatNumber(v.rejected.expectancyR)} R.` : ''} Candle history: {v.candleBacktest.replace(/^NOT_POSSIBLE: /, 'not possible — ')}</p>
    </Section>
  );
}
