'use client';

// ============================================================
// COMMAND CENTER — the terminal's home screen
// ============================================================
// Health strip → paper account → live positions → setup radar → journal, with equity, the strategy scorecard,
// market context and expiring calendars on the side. Every number comes from /api/fresh-start/status,
// /api/health, the index quotes or the NIFTY chain; anything missing renders "—" or an empty state.
// ============================================================

import React, { useMemo, useState } from 'react';
import { useFreshStart } from '@/lib/use-fresh-start';
import { useHealth, useNow } from '@/lib/use-health';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { useLiveIndices } from '@/lib/use-live-indices';
import { useChain } from '@/lib/use-chain';
import { useMarketStore } from '@/stores';
import {
  accountView,
  equityCurve,
  istDay,
  istTime,
  inr,
  MIN_SAMPLE,
  positionViews,
  setupRadar,
  signedInr,
  signedR,
  STRATEGY_IDS,
  strategyName,
  stopToTarget,
  type PositionView,
  type RadarState,
} from '@/lib/command-center';
import { Empty, Kpi, Panel, Pill, Stat, type Tone } from './panel';
import { TradeDetailDialog } from './trade-detail';

const HORIZON_NAMES: Record<string, string> = {
  EXCHANGE_HOLIDAY_CALENDAR: 'NSE/BSE holiday table',
  FEE_SCHEDULE: 'Fee schedule',
};
export const horizonName = (id: string) =>
  HORIZON_NAMES[id] ?? id.split('_').map((w) => (['MCX', 'NSE', 'BSE'].includes(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');
export const daysUntil = (until: string, now: number) => Math.ceil((Date.parse(`${until}T00:00:00+05:30`) - now) / 86_400_000);

export function CommandCenter() {
  const fresh = useFreshStart();
  const health = useHealth();
  const feed = useFeedSummary();
  const now = useNow(5000);
  const status = fresh.data;
  const positions = useMemo(() => positionViews(status), [status]);
  const account = useMemo(() => accountView(status, positions, now), [status, positions, now]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedView = positions.find((p) => p.id === selected) ?? null;
  const selectedRaw = status?.positions.find((p) => (p.state as { id?: string } | null)?.id === selected) ?? null;

  return (
    <div className="cc-page">
      {fresh.error && (
        <p role="alert" className="cc-panel px-4 py-2 text-sm" style={{ color: 'var(--status-warn)' }}>
          Fresh-start status could not be refreshed ({fresh.error}). {status ? `Showing the last reading from ${istTime(fresh.fetchedAt)} IST.` : 'Entry state cannot be verified.'}
        </p>
      )}
      <HealthStrip status={status} health={health.data} quotes={feed.quotes} now={now} />
      <AccountStrip account={account} loading={fresh.loading && !status} />

      <div className="cc-main">
        <div className="cc-col-wide">
          <LivePositions positions={positions.filter((p) => p.status !== 'CLOSED')} onOpen={setSelected} />
          <SetupRadar rows={setupRadar(status, positions, now)} />
          <Journal positions={positions} now={now} onOpen={setSelected} />
        </div>
        <aside className="cc-col-side" aria-label="Context">
          <EquityPanel positions={positions} capital={account.capital} />
          <Scorecard status={status} />
          <MarketContext />
          <Horizons horizons={health.data?.calendarHorizons ?? []} now={now} />
        </aside>
      </div>

      <p className="cc-note flex flex-wrap justify-between gap-2 border-t border-[var(--border-primary)] pt-3">
        <span>{status?.version ?? 'NEW-INTRADAY'} · Paper fills: ask + 1 tick in, bid − 1 tick out, 250 ms latency, quotes ≤ 2 s old · no broker orders</span>
        <span>Status {fresh.fetchedAt ? `refreshed ${istTime(fresh.fetchedAt)} IST` : 'loading…'}</span>
      </p>
      <TradeDetailDialog position={selectedView} raw={selectedRaw} onClose={() => setSelected(null)} />
    </div>
  );
}

// ---------------- Health strip ----------------

function HealthStrip({ status, health, quotes, now }: { status: ReturnType<typeof useFreshStart>['data']; health: ReturnType<typeof useHealth>['data']; quotes: ReturnType<typeof useFeedSummary>['quotes']; now: number }) {
  const go = useMarketStore((s) => s.setActiveTab);
  const incidents = health?.ops?.incidents ?? [];
  const degrades = incidents.filter((i) => i.severity === 'DEGRADES').length;
  const horizons = (health?.calendarHorizons ?? []).map((h) => ({ ...h, days: daysUntil(h.until, now) })).sort((a, b) => a.days - b.days);
  const next = horizons[0];
  const fq = status?.feedQualification;
  const qTone: Tone = quotes.state === 'FRESH' ? 'ok' : quotes.state === 'MARKET_CLOSED' ? 'off' : 'bad';
  const tiles: Array<{ label: string; state: string; tone: Tone; value: string; sub: string }> = [
    { label: 'Index quotes', state: quotes.label, tone: qTone, value: quotes.state === 'MARKET_CLOSED' ? 'Session closed' : quotes.ageMs != null ? `${(quotes.ageMs / 1000).toFixed(1)} s age` : '—', sub: quotes.detail },
    {
      label: 'Fresh-start feed',
      state: fq ? fq.status.replaceAll('_', ' ') : '—',
      tone: !fq ? 'off' : fq.entriesArmed ? 'ok' : fq.monitorRunning ? 'warn' : 'bad',
      value: fq ? `${fq.observedExecutableBooks} executable books` : '—',
      sub: fq ? `Exit monitor ${fq.monitorRunning ? 'running' : 'not running'} · recovery ${fq.recovered ? 'done' : 'pending'}` : 'Waiting for status',
    },
    {
      label: 'Redis / database',
      state: health?.services?.redis?.status === 'HEALTHY' && health?.services?.database?.status === 'HEALTHY' ? 'OK' : health ? 'CHECK' : '—',
      tone: health?.services?.redis?.status === 'HEALTHY' && health?.services?.database?.status === 'HEALTHY' ? 'ok' : health ? 'bad' : 'off',
      value: health ? `${health.services?.redis?.latencyMs ?? '—'} ms · ${health.services?.database?.latencyMs ?? '—'} ms` : '—',
      sub: 'Ping round trip',
    },
    { label: 'Ops incidents', state: `${incidents.length} OPEN`, tone: degrades ? 'bad' : incidents.length ? 'warn' : 'ok', value: incidents[0]?.check ?? 'None', sub: incidents[0]?.detail ?? 'No functional incident open' },
    {
      label: 'Calendar horizon',
      state: next ? (next.days <= 7 ? 'URGENT' : next.days <= 30 ? 'WARN' : 'OK') : '—',
      tone: !next ? 'off' : next.days <= 7 ? 'bad' : next.days <= 30 ? 'warn' : 'ok',
      value: next ? `${horizonName(next.id)}` : '—',
      sub: next ? `${next.days} days left (until ${next.until})` : 'Not reported',
    },
    {
      label: 'Paper entries',
      state: status ? (status.enabled ? 'ARMED' : 'OFF') : '—',
      tone: !status ? 'off' : status.enabled ? 'ok' : 'warn',
      value: status?.eventPolicy?.id?.replace(/_V\d+$/, '').replaceAll('_', ' ') ?? '—',
      sub: status ? `Legacy entries ${status.legacyNewEntries ? 'ON' : 'retired'} · live orders off` : 'Waiting for status',
    },
  ];
  return (
    <section aria-label="System health" className="cc-grid-auto cc-health">
      {tiles.map((t) => (
        <button key={t.label} type="button" onClick={() => go('system-health')} className="cc-panel flex flex-col gap-1 px-3 py-2.5 text-left hover:border-[var(--desk-accent)]" title={`${t.sub} — open Ops & Health`}>
          <span className="flex items-center justify-between gap-2"><span className="cc-label">{t.label}</span><Pill tone={t.tone}>{t.state}</Pill></span>
          <span className="cc-num truncate text-[14px] font-medium">{t.value}</span>
          <span className="cc-note truncate">{t.sub}</span>
        </button>
      ))}
    </section>
  );
}

// ---------------- Account ----------------

function AccountStrip({ account: a, loading }: { account: ReturnType<typeof accountView>; loading: boolean }) {
  const cls = (v: number) => (v > 0 ? 'cc-up' : v < 0 ? 'cc-down' : '');
  return (
    <section aria-label="Paper account" className="cc-strip" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
      <Kpi label="Virtual capital" value={loading ? '…' : inr(a.capital)} sub={a.riskPerTrade != null ? `Risk 0.25% / trade = ${inr(a.riskPerTrade)}` : 'Capital not configured'} />
      <Kpi label="Today net" value={signedInr(a.todayNet)} valueClass={cls(a.todayNet)} sub={a.capital ? `${a.todayNet >= 0 ? '+' : '−'}${Math.abs((a.todayNet / a.capital) * 100).toFixed(2)}% · closed trades, after costs` : 'Closed trades, after costs'} />
      <Kpi label="Open risk" value={inr(a.openRisk)} sub={`${a.open} position${a.open === 1 ? '' : 's'} · ${a.riskPerTrade ? (a.openRisk / a.riskPerTrade).toFixed(1) : '—'}R at stake`} />
      <Kpi label="Trades today" value={`${a.todayTrades}`} sub={`${a.todayClosed} closed · ${a.todayWins} W · ${a.todayLosses} L`} />
      <div>
        <div className="cc-label">Cohort drawdown</div>
        <div className="cc-kpi-value">{a.drawdownPct.toFixed(2)}% <span className="text-[12px] font-normal text-[var(--text-muted)]">/ 3.00% pause</span></div>
        <div className="cc-bar mt-1" role="meter" aria-label="Cohort drawdown used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(a.drawdownUsed * 100)}>
          <span style={{ width: `${Math.max(2, a.drawdownUsed * 100)}%`, background: a.drawdownUsed > 0.66 ? 'var(--status-bad)' : 'var(--desk-accent)' }} />
        </div>
        <div className="cc-note mt-1">Cohort net {signedInr(a.cohortNet)}</div>
      </div>
    </section>
  );
}

// ---------------- Positions ----------------

function LivePositions({ positions, onOpen }: { positions: PositionView[]; onOpen: (id: string) => void }) {
  return (
    <Panel title={<>Live positions <small>· {positions.length} open</small></>} meta="Marked at the best bid seen · exits fill bid − 1 tick" bodyClassName="p-3">
      {positions.length === 0 ? (
        <Empty>No open paper positions. New entries appear here the moment a fill is recorded.</Empty>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))' }}>
          {positions.map((p) => {
            const l = stopToTarget(p);
            const unreal = (p.highBid - p.entry) * p.units;
            return (
              <button key={p.id} type="button" className="cc-position" onClick={() => onOpen(p.id)} aria-label={`${p.contract}, ${p.strategyLabel}. Open trade detail.`}>
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="cc-num block truncate text-[15px] font-semibold">{p.contract}</span>
                    <span className="cc-note block">{p.strategyLabel} · {p.direction.toLowerCase()} · {istTime(p.openedAt)} IST</span>
                  </span>
                  <Pill tone={p.status === 'EXIT_PENDING' ? 'warn' : 'ok'}>{p.status.replace('_', ' ')}</Pill>
                </span>
                <span className="grid grid-cols-4 gap-2">
                  <Stat label="ENTRY" value={p.entry.toFixed(2)} />
                  <Stat label="BEST BID" value={p.highBid.toFixed(2)} />
                  <Stat label="QTY" value={`${p.units}`} />
                  <Stat label="PEAK GAIN" value={signedInr(unreal)} className={unreal > 0 ? 'cc-up' : unreal < 0 ? 'cc-down' : ''} />
                </span>
                <span className="block">
                  <span className="cc-rail block" aria-hidden="true">
                    <i className="entry" style={{ left: `${l.entryAt * 100}%` }} />
                    <i style={{ left: `${l.markAt * 100}%` }} />
                  </span>
                  <span className="cc-num mt-2 flex justify-between text-[11px]">
                    <span className="cc-down">STOP {l.stop.toFixed(2)}</span>
                    <span className="text-[var(--text-muted)]">{Math.round(l.markAt * 100)}% of range</span>
                    <span className="cc-up">1.5R {l.target.toFixed(2)}</span>
                  </span>
                </span>
                <span className="cc-note flex flex-wrap justify-between gap-1 border-t border-dashed border-[var(--border-secondary)] pt-2">
                  <span>1R {inr(p.riskCurrency)}</span>
                  <span>Underlying invalidation {p.underlyingStop.toFixed(2)} · target {p.underlyingTarget.toFixed(2)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ---------------- Setup radar ----------------

const RADAR_LABEL: Record<RadarState, string> = { IN_TRADE: 'IN TRADE', FILLED: 'FILLED', REFUSED: 'REFUSED', NO_SETUP: 'NO SETUP', NOT_EVALUATED: 'NOT SEEN' };

export function SetupRadar({ rows }: { rows: ReturnType<typeof setupRadar> }) {
  return (
    <Panel
      title="Setup radar"
      meta={<span className="flex flex-wrap gap-2">{(['IN_TRADE', 'FILLED', 'REFUSED', 'NO_SETUP'] as RadarState[]).map((s) => <span key={s} className="cc-cell inline-block !min-w-0 !px-2 !py-0.5" data-state={s}><b>{RADAR_LABEL[s]}</b></span>)}</span>}
      bodyClassName="cc-scroll"
    >
      {rows.length === 0 ? (
        <Empty>No instrument evaluated today yet. The radar fills as the engine evaluates each 5-minute bar in session.</Empty>
      ) : (
        <table className="cc-table" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col">Instrument</th>
              {STRATEGY_IDS.map((s) => <th key={s} scope="col">{strategyName(s)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.instrument}>
                <th scope="row" className="!text-[var(--text-primary)]"><span className="cc-num block text-[13px] normal-case tracking-normal">{r.instrument}</span><span className="cc-note normal-case tracking-normal">{r.at ? `seen ${istTime(r.at)}` : ''}</span></th>
                {STRATEGY_IDS.map((s) => {
                  const c = r.cells[s];
                  return (
                    <td key={s}>
                      <div className="cc-cell" data-state={c.state} title={c.code ?? undefined}>
                        <b>{RADAR_LABEL[c.state]}</b>
                        <span>{c.code ? (c.state === 'IN_TRADE' ? c.code : c.code.replaceAll('_', ' ').toLowerCase()) : '—'}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------------- Journal ----------------

function Journal({ positions, now, onOpen }: { positions: PositionView[]; now: number; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<'today' | 'all' | 'win' | 'loss'>('today');
  const today = istDay(now);
  const rows = positions.filter((p) => (filter === 'today' ? istDay(p.openedAt) === today : filter === 'win' ? (p.netPnl ?? 0) > 0 : filter === 'loss' ? (p.netPnl ?? 0) < 0 : true)).slice(0, 50);
  const chip = (id: typeof filter, label: string) => <button type="button" className="cc-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>;
  return (
    <Panel title="Trade journal" meta={<span className="flex flex-wrap gap-1.5">{chip('today', 'Today')}{chip('all', 'All')}{chip('win', 'Winners')}{chip('loss', 'Losers')}</span>} bodyClassName="cc-scroll">
      {rows.length === 0 ? (
        <Empty>{filter === 'today' ? 'No paper trades today.' : 'No trades match this filter.'}</Empty>
      ) : (
        <table className="cc-table" style={{ minWidth: 760 }}>
          <thead>
            <tr><th>Time</th><th>Contract</th><th>Strategy</th><th className="r">Entry</th><th className="r">Exit</th><th>Reason</th><th className="r">Net ₹</th><th className="r">R</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const c = (p.netPnl ?? 0) > 0 ? 'cc-up' : (p.netPnl ?? 0) < 0 ? 'cc-down' : '';
              return (
                <tr key={p.id} className="cursor-pointer" onClick={() => onOpen(p.id)}>
                  <td className="cc-num text-[var(--text-muted)]">{istDay(p.openedAt) === today ? '' : `${istDay(p.openedAt).slice(5)} `}{istTime(p.openedAt)} → {p.status === 'CLOSED' ? istTime(p.closedAt) : ''}</td>
                  <td className="cc-num"><button type="button" className="hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}>{p.contract}</button></td>
                  <td>{p.strategyLabel}</td>
                  <td className="r cc-num">{p.entry.toFixed(2)}</td>
                  <td className="r cc-num">{p.exit != null ? p.exit.toFixed(2) : '—'}</td>
                  <td className="text-[var(--text-muted)]">{p.status === 'CLOSED' ? p.exitReason ?? '—' : p.status.replace('_', ' ')}</td>
                  <td className={`r cc-num ${c}`}>{p.status === 'CLOSED' ? signedInr(p.netPnl) : '—'}</td>
                  <td className={`r cc-num font-semibold ${c}`}>{p.status === 'CLOSED' ? signedR(p.r) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------------- Equity ----------------

export function EquityPanel({ positions, capital }: { positions: PositionView[]; capital: number | null }) {
  const pts = capital ? equityCurve(positions, capital) : [];
  const last = pts.at(-1);
  const W = 340, H = 120;
  let body: React.ReactNode = <Empty>The curve starts with the first closed trade.</Empty>;
  if (capital && pts.length) {
    const values = [capital, ...pts.map((p) => p.equity)];
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const maxDd = Math.max(1, ...pts.map((p) => p.drawdown));
    const x = (i: number) => (i / Math.max(1, values.length - 1)) * W;
    const y = (v: number) => 8 + (1 - (v - lo) / span) * (H - 36);
    const eq = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const dd = [0, ...pts.map((p) => p.drawdown)].map((d, i) => `${x(i).toFixed(1)},${(H - 2 - (d / maxDd) * 22).toFixed(1)}`).join(' ');
    body = (
      <>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[120px] w-full" role="img" aria-label={`Equity from ${inr(capital)} to ${inr(last!.equity)} over ${pts.length} closed trades`}>
          <line x1="0" x2={W} y1={y(capital)} y2={y(capital)} stroke="var(--border-secondary)" strokeDasharray="3 3" />
          <polyline fill="none" stroke="var(--accent-blue)" strokeWidth="2" points={eq} />
          <polyline fill="none" stroke="var(--negative)" strokeWidth="1.5" opacity=".7" points={dd} />
        </svg>
        <div className="cc-note mt-1 flex justify-between"><span><span style={{ color: 'var(--accent-blue)' }}>—</span> equity · <span className="cc-down">—</span> drawdown</span><span>{pts.length} closed trades</span></div>
      </>
    );
  }
  return (
    <Panel title="Equity · net of costs" meta={last ? <span className={`cc-num font-semibold ${last.equity - capital! >= 0 ? 'cc-up' : 'cc-down'}`}>{signedInr(last.equity - capital!)}</span> : undefined}>
      {body}
    </Panel>
  );
}

// ---------------- Scorecard ----------------

function Scorecard({ status }: { status: ReturnType<typeof useFreshStart>['data'] }) {
  const go = useMarketStore((s) => s.setActiveTab);
  const perf = status?.performance ?? [];
  return (
    <Panel title="Strategy scorecard" meta={<button type="button" className="desk-link" onClick={() => go('strategy-lab')}>Strategy Lab →</button>} bodyClassName="">
      {STRATEGY_IDS.map((id) => {
        const p = perf.find((x) => x.strategy === id);
        const enabled = status?.strategies.find((s) => s.id === id)?.enabled;
        return (
          <div key={id} className="flex flex-col gap-1.5 border-b border-[var(--border-primary)] px-4 py-2.5 last:border-b-0">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{strategyName(id)}</span>
              <span className="flex gap-1">
                {!enabled && <Pill tone="off">OFF</Pill>}
                <Pill tone={p?.minimumSampleMet ? 'ok' : 'warn'}>{p?.minimumSampleMet ? 'SAMPLE OK' : 'LOW SAMPLE'}</Pill>
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <Stat label="CLOSED" value={p ? `${p.closed}` : '0'} />
              <Stat label="WIN %" value={p?.winRate != null ? `${(p.winRate * 100).toFixed(0)}%` : '—'} />
              <Stat label="EXP R" value={signedR(p?.expectancyR)} className={(p?.expectancyR ?? 0) > 0 ? 'cc-up' : (p?.expectancyR ?? 0) < 0 ? 'cc-down' : ''} />
              <Stat label="NET" value={signedInr(p?.netPnl)} />
            </div>
          </div>
        );
      })}
      <p className="cc-note px-4 py-2.5">Win % is not judged before {MIN_SAMPLE} closed trades per strategy. Results are not validated.</p>
    </Panel>
  );
}

// ---------------- Market context ----------------

function MarketContext() {
  const { indices } = useLiveIndices();
  const { chain, error } = useChain('NIFTY', 'NSE', undefined, 30_000);
  const nifty = indices.find((q) => q.symbol === 'NIFTY' || q.symbol === 'NIFTY 50');
  const atm = chain?.strikes.find((s) => s.strike === chain.atmStrike);
  const ivs = [atm?.call?.iv, atm?.put?.iv].filter((v): v is number => typeof v === 'number' && v > 0);
  const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const spread = atm?.call && atm.call.ask > 0 && atm.call.bid > 0 ? atm.call.ask - atm.call.bid : null;
  const range = nifty && nifty.high > nifty.low ? ((nifty.ltp - nifty.low) / (nifty.high - nifty.low)) * 100 : null;
  const vwapGap = nifty?.vwap ? ((nifty.ltp - nifty.vwap) / nifty.vwap) * 100 : null;
  return (
    <Panel title="NIFTY · context" meta={nifty ? <span className="cc-num font-semibold">{nifty.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className={nifty.changePercent >= 0 ? 'cc-up' : 'cc-down'}>{nifty.changePercent >= 0 ? '+' : '−'}{Math.abs(nifty.changePercent).toFixed(2)}%</span></span> : undefined}>
      {!nifty && !chain ? (
        <Empty>{error ? 'Option chain unavailable.' : 'Waiting for NIFTY quotes…'}</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {nifty && (
            <div>
              <div className="cc-num flex justify-between text-[11px] text-[var(--text-muted)]"><span>LOW {nifty.low.toFixed(2)}</span><span>Day range</span><span>HIGH {nifty.high.toFixed(2)}</span></div>
              <div className="cc-rail mt-1.5" role="img" aria-label={`NIFTY at ${range?.toFixed(0) ?? '—'} percent of the day range`}>
                {range != null && <i style={{ left: `${range}%` }} />}
              </div>
              <div className="cc-note mt-1.5 flex justify-between"><span>Prev close {nifty.close.toFixed(2)}</span><span>{vwapGap != null ? `VWAP ${nifty.vwap!.toFixed(2)} (${vwapGap >= 0 ? '+' : '−'}${Math.abs(vwapGap).toFixed(2)}%)` : 'VWAP not in quote'}</span></div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 border-t border-[var(--border-primary)] pt-2.5">
            <Stat label="ATM IV" value={atmIv != null ? `${atmIv.toFixed(1)}%` : '—'} />
            <Stat label="PCR (OI)" value={chain ? chain.pcr.toFixed(2) : '—'} />
            <Stat label="MAX PAIN" value={chain ? chain.maxPain.toLocaleString('en-IN') : '—'} />
            <Stat label="EXPIRY" value={chain ? `${chain.expiry}` : '—'} />
            <Stat label="DTE" value={chain ? chain.dte.toFixed(1) : '—'} />
            <Stat label="ATM CE SPREAD" value={spread != null ? spread.toFixed(2) : '—'} />
          </div>
          {chain && <p className="cc-note">Expected move ±{chain.expectedMove.points.toFixed(0)} pts ({chain.expectedMove.lowerBound.toFixed(0)} – {chain.expectedMove.upperBound.toFixed(0)}). Context only — no strategy trades on OI.</p>}
        </div>
      )}
    </Panel>
  );
}

// ---------------- Horizons ----------------

export function Horizons({ horizons, now }: { horizons: Array<{ id: string; until: string }>; now: number }) {
  const rows = horizons.map((h) => ({ ...h, days: daysUntil(h.until, now) })).sort((a, b) => a.days - b.days);
  return (
    <Panel title="Calendars that expire" bodyClassName="">
      {rows.length === 0 ? (
        <Empty>Not reported by the server.</Empty>
      ) : (
        rows.map((h) => {
          const col = h.days <= 7 ? 'var(--status-bad)' : h.days <= 30 ? 'var(--status-warn)' : 'var(--status-ok)';
          return (
            <div key={h.id} className="flex flex-col gap-1.5 border-b border-[var(--border-primary)] px-4 py-2.5 last:border-b-0">
              <div className="flex justify-between gap-2 text-[12.5px]"><span>{horizonName(h.id)}</span><span className="cc-num" style={{ color: col }}>{h.days <= 0 ? 'EXPIRED' : `${h.days} days`}</span></div>
              <div className="cc-bar"><span style={{ width: `${Math.max(3, Math.min(100, (h.days / 120) * 100))}%`, background: col }} /></div>
            </div>
          );
        })
      )}
    </Panel>
  );
}
