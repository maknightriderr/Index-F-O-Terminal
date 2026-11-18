'use client';

// ============================================================
// TODAY — the first screen (redesign phase 2): the eight questions in reading order
// ============================================================
// Market read → market pulse (path, range, engine bias) → paper account (both engines, net R curve) → one opportunity
// feed with a session timeline → strategy scorecard → data & system → alerts. Below it, the full Command Center desk
// (positions, setup radar, journal, equity, calendars) stays exactly as it was. Read-only; paper only.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { getSessionWindow } from '@fno/shared';
import { useFreshStart } from '@/lib/use-fresh-start';
import { usePaperTrades } from '@/lib/use-paper-trades';
import { useAlerts } from '@/lib/use-alerts';
import { useNow } from '@/lib/use-health';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { usePulse } from '@/lib/use-pulse';
import { api } from '@/lib/api';
import { positionViews, strategyName } from '@/lib/command-center';
import { alertTime, bookToday, displayDay, freshFeed, istAt, istDayOf, legacyFeed, marketRead, rCurve, scorecard, sortFeed, watchFeed, type Bar, type FeedItem, type FeedState, type PulseRow } from '@/lib/today';
import { useAssetTabsStore, useMarketStore } from '@/stores';

const fmtN = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const sgnPct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const sgnR = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`);
const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const dayTime = (t: number) => new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const toneOf = (v: number | null) => (v == null || v === 0 ? '' : v > 0 ? 'td-up' : 'td-dn');
const STATE_CLASS: Record<FeedState, string> = { NEW: 'in', ACTIVE: 'ac', PROFIT: 'up', LOSS: 'dn', EXPIRED: 'wa', FLAT: 'off' };
const STATE_GLYPH: Record<FeedState, string> = { NEW: '◆', ACTIVE: '●', PROFIT: '▲', LOSS: '▼', EXPIRED: '!', FLAT: '—' };

function Spark({ bars, up }: { bars: Bar[]; up: boolean }) {
  const w = 132, h = 32;
  if (bars.length < 2) return <span className="td-mut td-sm">no bars yet</span>;
  const c = bars.map((b) => b.close), lo = Math.min(...c), hi = Math.max(...c), rng = hi - lo || 1;
  const pts = c.map((v, i) => [2 + (i * (w - 6)) / (c.length - 1), h - 3 - ((v - lo) / rng) * (h - 8)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `M${pts[0][0]},${h} L${line.replace(/ /g, ' L')} L${pts[pts.length - 1][0]},${h} Z`;
  const id = `sp${Math.round(c[0] * 100)}${c.length}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Price path: ${c.length} five-minute bars, ${up ? 'up' : 'down'} on the period`}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={up ? 'var(--positive)' : 'var(--negative)'} stopOpacity=".28" /><stop offset="1" stopColor={up ? 'var(--positive)' : 'var(--negative)'} stopOpacity="0" /></linearGradient></defs>
      <path d={area} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={up ? 'var(--positive)' : 'var(--negative)'} strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.5" fill={up ? 'var(--positive)' : 'var(--negative)'} />
    </svg>
  );
}

function Range({ lo, hi, last }: { lo: number | null; hi: number | null; last: number | null }) {
  if (lo == null || hi == null || last == null || hi <= lo) return <span className="td-mut">—</span>;
  const p = Math.max(0, Math.min(100, ((last - lo) / (hi - lo)) * 100));
  return <div><div className="td-range" aria-label={`Day range ${fmtN(lo, 0)} to ${fmtN(hi, 0)}, last at ${Math.round(p)}%`}><span style={{ left: `${p}%` }} /></div><div className="td-num td-sm td-mut">{fmtN(lo, 0)} – {fmtN(hi, 0)}</div></div>;
}

function PulseTable({ rows, onOpen }: { rows: PulseRow[]; onOpen: (r: PulseRow) => void }) {
  return (
    <table className="td-table">
      <thead><tr><th>Instrument</th><th>Path</th><th>Last</th><th>Day range</th><th>Engine bias</th><th>Regime</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const up = (r.changePct ?? 0) >= 0;
          const cls = r.direction === 'BULLISH' ? 'up' : r.direction === 'BEARISH' ? 'dn' : 'off';
          return (
            <tr key={r.symbol} className={r.stale ? 'td-stale' : undefined}>
              <td><button type="button" className="td-sym" onClick={() => onOpen(r)} title={`Open ${r.symbol}`}>{r.symbol}</button><div className="td-ex">{r.exchange}{r.changeBasis === 'SESSION_OPEN' ? ' · futures' : ''}</div></td>
              <td><Spark bars={r.bars} up={up} /></td>
              <td className="td-num"><div className="td-big">{fmtN(r.last)}</div><div className={`td-sm ${toneOf(r.changePct)}`}>{sgnPct(r.changePct)} <span className="td-mut">{r.changeBasis === 'SESSION_OPEN' ? 'vs session open' : r.changeBasis === 'DAY' ? 'day' : ''}</span></div></td>
              <td><Range lo={r.low} hi={r.high} last={r.last} /></td>
              <td>{r.direction ? <><span className={`td-bias ${cls}`}>{r.direction === 'BULLISH' ? '▲ BULLISH' : r.direction === 'BEARISH' ? '▼ BEARISH' : '— NEUTRAL'}</span><div className="td-meter"><i className={cls} style={{ width: `${r.confidence ?? 0}%` }} /></div><div className="td-num td-sm td-mut">conf {r.confidence ?? '—'} · PCR {r.pcr != null ? r.pcr.toFixed(2) : '—'}</div></> : <span className="td-mut">not assessed</span>}</td>
              <td className="td-sm">{r.regime ? r.regime.replaceAll('_', ' ').toLowerCase() : '—'}<div className={`td-num td-sm ${r.stale ? 'td-wa' : 'td-mut'}`}>{r.stale ? '⚠ ' : ''}{r.assessedAt ? `assessed ${dayTime(r.assessedAt)}` : ''}</div></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RCurve({ points, start, end, now }: { points: Array<{ t: number; r: number }>; start: number; end: number; now: number }) {
  const w = 400, h = 150, L = 34, R = 8, T = 10, B = 22;
  const pts = [...points, { t: Math.min(Math.max(now, start), end), r: points[points.length - 1]?.r ?? 0 }];
  const lo = Math.floor(Math.min(0, ...pts.map((p) => p.r))), hi = Math.max(1, Math.ceil(Math.max(0, ...pts.map((p) => p.r))));
  const X = (t: number) => L + ((Math.min(Math.max(t, start), end) - start) / (end - start)) * (w - L - R);
  const Y = (v: number) => T + ((hi - v) / (hi - lo)) * (h - T - B);
  let d = `M${X(pts[0].t).toFixed(1)},${Y(pts[0].r).toFixed(1)}`;
  for (const p of pts.slice(1)) d += ` H${X(p.t).toFixed(1)} V${Y(p.r).toFixed(1)}`;
  const last = pts[pts.length - 1].r, col = last >= 0 ? 'var(--positive)' : 'var(--negative)';
  const hours: number[] = [];
  for (let t = start; t <= end; t += 3 * 3_600_000) hours.push(t);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="td-rcurve" role="img" aria-label={`Cumulative net R today: ${sgnR(last)} after ${points.length - 1} closes`}>
      {Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((v) => <g key={v}><line x1={L} x2={w - R} y1={Y(v)} y2={Y(v)} className={v === 0 ? 'td-zero' : 'td-grid'} /><text x={L - 5} y={Y(v) + 3} className="td-ax" textAnchor="end">{v > 0 ? `+${v}` : v}R</text></g>)}
      {hours.map((t) => <text key={t} x={X(t)} y={h - 6} className="td-ax" textAnchor="middle">{hhmm(t)}</text>)}
      <path d={`${d} V${Y(0)} H${X(pts[0].t)} Z`} fill={col} opacity=".12" />
      <path d={d} fill="none" stroke={col} strokeWidth="1.8" />
      {points.slice(1).map((p, i) => <circle key={i} cx={X(p.t)} cy={Y(p.r)} r="2.6" fill={col} />)}
    </svg>
  );
}

function Timeline({ items, day, now }: { items: FeedItem[]; day: string; now: number }) {
  const nse = getSessionWindow('NSE', day), mcx = getSessionWindow('MCX', day);
  const start = Math.min(nse?.open ?? istAt(day, '09:00'), mcx?.open ?? istAt(day, '09:00')), end = Math.max(nse?.close ?? istAt(day, '15:30'), mcx?.close ?? istAt(day, '23:30'));
  const w = 1000, L = 74, X = (t: number) => L + ((Math.min(Math.max(t, start), end) - start) / (end - start)) * (w - L - 10);
  const lane = (i: FeedItem) => (i.exchange === 'MCX' ? 1 : 0);
  const ticks: number[] = [];
  for (let t = start; t <= end; t += 2 * 3_600_000) ticks.push(t);
  return (
    <svg viewBox={`0 0 ${w} 60`} className="td-timeline" role="img" aria-label={`${items.length} signals and trades today on the session timeline`}>
      {ticks.map((t) => <g key={t}><line x1={X(t)} x2={X(t)} y1="4" y2="44" className="td-grid" /><text x={X(t)} y="57" className="td-ax" textAnchor="middle">{hhmm(t)}</text></g>)}
      {nse && <rect x={X(nse.open)} y="5" width={X(nse.close) - X(nse.open)} height="16" rx="3" className="td-band" />}
      {mcx && <rect x={X(mcx.open)} y="27" width={X(mcx.close) - X(mcx.open)} height="16" rx="3" className="td-band" />}
      <text x="0" y="17" className="td-ax">NSE · BSE</text><text x="0" y="39" className="td-ax">MCX</text>
      {items.map((i, k) => <circle key={k} cx={X(i.at)} cy={lane(i) ? 35 : 13} r="4.4" className={`td-dot ${STATE_CLASS[i.state]}`}><title>{`${hhmm(i.at)} ${i.symbol} · ${i.strategy} · ${i.state}`}</title></circle>)}
      {now >= start && now <= end && <line x1={X(now)} x2={X(now)} y1="2" y2="46" className="td-now" />}
    </svg>
  );
}

interface Lessons { newEngine?: { blocks?: string[] } | null }

export function TodayPage() {
  const now = useNow(5000);
  const fresh = useFreshStart();
  const status = fresh.data;
  const paper = usePaperTrades(1000);
  const { alerts } = useAlerts(12);
  const feed = useFeedSummary();
  const { rows } = usePulse(status, now);
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  const openAsset = useAssetTabsStore((s) => s.openTab);
  const [lessons, setLessons] = useState<Lessons | null>(null);
  useEffect(() => { api.getLessons<Lessons>().then(setLessons).catch(() => setLessons(null)); }, []);

  const positions = useMemo(() => positionViews(status), [status]);
  const today = istDayOf(now);
  const nseToday = getSessionWindow('NSE', today), mcxToday = getSessionWindow('MCX', today);
  const firstOpen = [nseToday?.open, mcxToday?.open].filter((x): x is number => x != null).sort((a, b) => a - b)[0] ?? null;
  const activityDays = useMemo(() => [...new Set([...(paper.data?.trades ?? []).map((t) => istDayOf(t.mintedAt)), ...positions.map((p) => p.session)])], [paper.data, positions]);
  const { day, live } = displayDay(now, activityDays, firstOpen);
  const dayLabel = live ? 'today' : `last session · ${new Date(`${day}T12:00:00+05:30`).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })}`;
  const items = useMemo(() => sortFeed([...legacyFeed(paper.data?.trades ?? [], day), ...freshFeed(positions, day, strategyName), ...watchFeed((alerts ?? []) as never, day)]), [paper.data, positions, alerts, day]);
  const book = useMemo(() => bookToday(items), [items]);
  const read = marketRead(rows, { ...book, day: live ? undefined : `in the ${dayLabel}` });
  const nse = getSessionWindow('NSE', day), mcx = getSessionWindow('MCX', day);
  const curveStart = Math.min(nse?.open ?? istAt(day, '09:00'), mcx?.open ?? istAt(day, '09:00')), curveEnd = Math.max(nse?.close ?? istAt(day, '15:30'), mcx?.close ?? istAt(day, '23:30'));
  const curve = useMemo(() => rCurve(items, curveStart), [items, curveStart]);
  const score = useMemo(() => scorecard(paper.data?.trades ?? [], positions, strategyName), [paper.data, positions]);
  const maxAbs = Math.max(1, ...score.map((s) => Math.abs(s.netR)));
  const bear = rows.filter((r) => r.direction === 'BEARISH' && !r.stale).length, bull = rows.filter((r) => r.direction === 'BULLISH' && !r.stale).length;
  const mcxBooks = status?.marketReadiness?.find((m) => m.market.startsWith('MCX'))?.observedExecutableBooks ?? null;
  const open = (i: FeedItem) => (i.open.kind === 'asset' ? openAsset(i.open.symbol, i.open.exchange) : setActiveTab(i.open.tab));
  const segTotal = Math.max(1, book.trades);
  const blocks = lessons?.newEngine?.blocks ?? null;
  const visible = items.slice(0, 10);

  return (
    <div className="td-page">
      <section className="td-read" aria-label="Market read">
        <span className="td-tag">MARKET READ</span>
        <p>{read ?? 'Waiting for the first quotes and engine assessments.'}</p>
        <span className="td-tally"><span className="td-st dn">▼ {bear} BEARISH</span><span className="td-st up">▲ {bull} BULLISH</span></span>
      </section>

      <div className="td-g1">
        <section className="td-p" aria-labelledby="td-pulse"><header><span className="td-q">Q1–2</span><h2 id="td-pulse">Market pulse</h2><span className="td-pm">latest session&apos;s 5-minute path · day range · engine bias &amp; confidence · click → instrument</span></header>
          <div className="td-scroll"><PulseTable rows={rows} onOpen={(r) => openAsset(r.symbol, r.exchange)} /></div>
        </section>

        <section className="td-p" aria-labelledby="td-acct"><header><span className="td-q">Q5</span><h2 id="td-acct">Paper account · {dayLabel}</h2><span className="td-pm">both engines</span></header>
          <div className="td-kpis">
            <div><div className="td-kl">{live ? 'Net today' : 'Net'}</div><div className={`td-kv ${toneOf(book.netR)}`}>{book.closed ? sgnR(book.netR) : '—'}</div><div className="td-ks">{book.closed} closed after costs</div></div>
            <div><div className="td-kl">Open</div><div className="td-kv">{book.open}</div><div className="td-ks">paper positions</div></div>
            <div><div className="td-kl">Trades</div><div className="td-kv">{book.trades}</div><div className="td-ks">{Object.entries(book.byEngine).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none yet'}</div></div>
          </div>
          <div className="td-seg" aria-hidden="true"><i className="up" style={{ flex: book.wins / segTotal }} /><i className="dn" style={{ flex: book.losses / segTotal }} /><i className="wa" style={{ flex: book.expired / segTotal }} /><i className="in" style={{ flex: book.open / segTotal }} /></div>
          <div className="td-legend"><span><i className="up" />{book.wins} profit</span><span><i className="dn" />{book.losses} loss</span><span><i className="wa" />{book.expired} expired</span><span><i className="in" />{book.open} open</span></div>
          <header className="td-sub"><h3>Cumulative net R · {dayLabel}</h3><span className="td-pm">a step at each close</span></header>
          <div className="td-chart"><RCurve points={curve} start={curveStart} end={curveEnd} now={now} /></div>
        </section>
      </div>

      <section className="td-p" aria-labelledby="td-feed"><header><span className="td-q">Q3–4</span><h2 id="td-feed">Opportunity feed</h2><span className="td-pm">{live ? 'every signal and paper trade today' : `nothing yet today · showing the ${dayLabel}`}, both engines · row → instrument</span></header>
        <div className="td-tl"><Timeline items={items} day={day} now={now} /></div>
        {visible.length === 0 ? <p className="td-empty">No signal or paper trade yet today. Signals appear here as the engines confirm structures and take paper trades.</p> : (
          <div className="td-scroll"><table className="td-table">
            <thead><tr><th>Time</th><th>Instrument</th><th>Engine · strategy</th><th>Contract</th><th>State</th><th>Why / status</th><th className="td-r">Net R</th></tr></thead>
            <tbody>{visible.map((i, k) => (
              <tr key={k} className="td-row" onClick={() => open(i)}>
                <td className="td-num td-mut">{hhmm(i.at)}</td>
                <td><button type="button" className="td-sym" onClick={(e) => { e.stopPropagation(); open(i); }}>{i.symbol}</button> <span className="td-ex">{i.exchange}</span></td>
                <td><span className="td-mut">{i.engine} ·</span> {i.strategy}</td>
                <td className="td-num">{i.contract}</td>
                <td><span className={`td-st ${STATE_CLASS[i.state]}`}>{STATE_GLYPH[i.state]} {i.state}</span></td>
                <td className="td-why">{i.why}</td>
                <td className={`td-num td-r ${toneOf(i.r)}`}>{i.r == null ? <span className="td-mut">—</span> : sgnR(i.r)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {items.length > visible.length && <button type="button" className="td-more" onClick={() => setActiveTab('paper-trades')}>+{items.length - visible.length} earlier · open Paper</button>}
      </section>

      <div className="td-g3">
        <section className="td-p" aria-labelledby="td-score"><header><span className="td-q">Q6</span><h2 id="td-score">Strategy scorecard</h2><span className="td-pm">net R after costs · all recorded paper trades</span></header>
          {score.length === 0 ? <p className="td-empty">No closed paper trade yet.</p> : <table className="td-table"><thead><tr><th>Strategy</th><th>Trades</th><th>Win</th><th>Net R</th><th className="td-r"></th></tr></thead><tbody>
            {score.map((s) => <tr key={`${s.engine}${s.strategy}`}><td><b>{s.strategy}</b><div className="td-ex">{s.engine}{s.trades < 20 ? ' · few trades' : ''}</div></td><td className="td-num td-mut">{s.trades}</td><td className="td-num td-mut">{s.winRate}%</td><td className="td-div"><div className="td-dv"><span className={s.netR >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(s.netR) / maxAbs) * 48}%` }} /></div></td><td className={`td-num td-r ${toneOf(s.netR)}`}>{sgnR(s.netR)}</td></tr>)}
          </tbody></table>}
        </section>

        <section className="td-p" aria-labelledby="td-sys"><header><span className="td-q">Q7–8</span><h2 id="td-sys">Data &amp; system</h2><span className="td-pm">attention first</span></header>
          <ul className="td-sys">
            {feed.health.rows.filter((r) => r.status !== 'HEALTHY').slice(0, 3).map((r) => <li key={r.id}><span><i className="wa" />{r.name}</span><span className="td-wa td-sm">{r.detail}</span></li>)}
            <li><span><i className={feed.apiReachable ? 'up' : 'dn'} />Terminal API</span><span className={feed.apiReachable ? 'td-up' : 'td-dn'}>{feed.apiReachable ? 'reachable' : 'unreachable'}</span></li>
            {feed.sessions.map((s) => <li key={s.exchange}><span><i className={s.open ? 'up' : 'off'} />{s.exchange} session</span><span className={s.open ? 'td-up' : 'td-mut'}>{s.open ? 'open' : 'closed'}</span></li>)}
            <li><span><i className={mcxBooks ? 'up' : 'off'} />MCX option books</span><span className="td-num">{mcxBooks ?? '—'} observed</span></li>
            <li><span><i className={status?.feedQualification?.status === 'FORWARD_PAPER_RUNNING' ? 'up' : 'wa'} />New-engine paper</span><span className="td-sm">{status?.feedQualification?.status?.replaceAll('_', ' ').toLowerCase() ?? '—'}</span></li>
            <li><span><i className={blocks?.length ? 'wa' : 'off'} />Learning blocks</span><span className="td-sm td-mut">{blocks == null ? '—' : blocks.length ? blocks.join(', ') : 'none yet · need 10 trades'}</span></li>
          </ul>
        </section>

        <section className="td-p" aria-labelledby="td-alerts"><header><h2 id="td-alerts">Alerts</h2><span className="td-pm">latest</span><button type="button" className="td-link" onClick={() => setActiveTab('alerts')}>All →</button></header>
          {(alerts ?? []).length === 0 ? <p className="td-empty">No alerts yet.</p> : <ul className="td-alerts">{(alerts ?? []).slice(0, 7).map((a) => {
            const m = a.message.split('\n')[0].replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
            const tone = /EXPIRED/.test(m) ? 'wa' : /WIN/.test(m) ? 'up' : /LOSS|STOP/.test(m) ? 'dn' : 'in';
            return <li key={a.id}><i className={tone} /><span className="td-num td-mut">{hhmm(alertTime(a as never))}</span><span className="td-alt"><b>{a.symbol}</b> {m.replace(/^PAPER TRADE /, '')}</span></li>;
          })}</ul>}
        </section>
      </div>

      <button type="button" className="td-more td-desk-link" onClick={() => setActiveTab('desk')}>Paper desk: positions, setup radar, journal, equity and calendars →</button>
    </div>
  );
}
