'use client';

import React, { useEffect, useRef } from 'react';
import type { FreshStartStatus } from '@fno/shared';
import { Panel, Pill } from './panel';
import { istTime, signedInr, signedR, inr, stopToTarget, type PositionView } from '@/lib/command-center';

const fmt = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) || v === 0 ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const held = (from: number, to: number | null) => {
  const ms = Math.max(0, (to ?? Date.now()) - from);
  const m = Math.floor(ms / 60_000), s = Math.floor((ms % 60_000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s}s`;
};

/** One fresh-start paper position in full: levels, lifecycle, fills and the P&L arithmetic. Read-only. */
export function TradeDetailDialog({ position, raw, onClose }: { position: PositionView | null; raw: FreshStartStatus['positions'][number] | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (position && !d.open) d.showModal();
    if (!position && d.open) d.close();
  }, [position]);
  const p = position;
  const state = (raw?.state ?? {}) as { candidate?: { at?: unknown }; exitTriggeredAt?: unknown };
  const candidateAt: number | null = typeof state.candidate?.at === 'number' ? state.candidate.at : null;
  const exitAt: number | null = typeof state?.exitTriggeredAt === 'number' ? state.exitTriggeredAt : null;
  const gross = p && p.exit != null ? (p.exit - p.entry) * p.units : null;
  const levels = p ? stopToTarget(p) : null;
  const uSpan = p ? Math.abs(p.underlyingTarget - p.underlyingStop) : 0;
  const uPos = (x: number) => (p && uSpan > 0 ? Math.max(0, Math.min(100, (Math.abs(x - p.underlyingStop) / uSpan) * 100)) : 0);
  const favorable = p ? p.underlyingRef + (p.direction === 'BULLISH' ? 1 : -1) * p.maxFavorable : 0;
  const timeline: Array<{ at: number | null; title: string; detail: string; tone: string }> = p
    ? [
        { at: candidateAt, title: 'Candidate armed', detail: `${p.strategyLabel} · ${p.direction.toLowerCase()} · invalidation ${fmt(p.underlyingStop)} · target ${fmt(p.underlyingTarget)}`, tone: 'var(--status-info)' },
        { at: p.openedAt, title: 'Paper fill at ask + 1 tick', detail: `${fmt(p.entry)} × ${p.units} units · 1R frozen at ${inr(p.riskCurrency)} · emergency stop ${fmt(p.emergencyStop)}`, tone: 'var(--status-ok)' },
        ...(exitAt ? [{ at: exitAt, title: 'Exit triggered', detail: `Reason ${p.exitReason ?? '—'} · fills at bid − 1 tick after the latency model`, tone: 'var(--status-warn)' }] : []),
        ...(p.status === 'CLOSED' ? [{ at: p.closedAt, title: `Closed · ${p.exitReason ?? '—'}`, detail: `Exit ${fmt(p.exit)} · net ${signedInr(p.netPnl)} (${signedR(p.r)}) after estimated costs`, tone: (p.netPnl ?? 0) >= 0 ? 'var(--status-ok)' : 'var(--status-bad)' }] : []),
      ]
    : [];
  return (
    <dialog ref={ref} className="cc-dialog" aria-labelledby="trade-detail-title" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close(); }}>
      {p && (
        <div className="flex flex-col gap-3 p-4 md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <p className="cc-note">Paper trade · {p.session} · {p.id.slice(0, 12)}</p>
              <h2 id="trade-detail-title" className="cc-num m-0 text-xl font-semibold md:text-2xl">
                {p.contract} {p.expiry && <span className="text-sm font-normal text-[var(--text-muted)]">· {p.expiry}</span>}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                <Pill tone="info">{p.strategyLabel.toUpperCase()}</Pill>
                <Pill tone={p.direction === 'BULLISH' ? 'ok' : 'bad'}>{p.direction}</Pill>
                <Pill tone={p.status === 'CLOSED' ? ((p.netPnl ?? 0) >= 0 ? 'ok' : 'bad') : p.status === 'EXIT_PENDING' ? 'warn' : 'info'}>{p.status === 'CLOSED' ? `CLOSED · ${p.exitReason ?? '—'}` : p.status.replace('_', ' ')}</Pill>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <div className="cc-strip grid-cols-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                <div><div className="cc-label">Net P&amp;L</div><div className={`cc-kpi-value ${(p.netPnl ?? 0) > 0 ? 'cc-up' : (p.netPnl ?? 0) < 0 ? 'cc-down' : ''}`}>{p.status === 'CLOSED' ? signedInr(p.netPnl) : '—'}</div></div>
                <div><div className="cc-label">R multiple</div><div className={`cc-kpi-value ${(p.r ?? 0) > 0 ? 'cc-up' : (p.r ?? 0) < 0 ? 'cc-down' : ''}`}>{p.status === 'CLOSED' ? signedR(p.r) : '—'}</div></div>
                <div><div className="cc-label">Held</div><div className="cc-kpi-value">{held(p.openedAt, p.closedAt)}</div></div>
              </div>
              <button type="button" className="cc-chip" onClick={() => ref.current?.close()} aria-label="Close trade detail">Close</button>
            </div>
          </div>

          <div className="cc-main">
            <div className="cc-col-wide">
              <Panel title="Price levels">
                <div className="flex flex-col gap-5">
                  <div>
                    <div className="cc-label mb-2">Underlying {p.instrument}</div>
                    <div className="cc-rail" role="img" aria-label={`Underlying invalidation ${fmt(p.underlyingStop)}, entry reference ${fmt(p.underlyingRef)}, target ${fmt(p.underlyingTarget)}, best move ${fmt(favorable)}`}>
                      <i className="entry" style={{ left: `${uPos(p.underlyingRef)}%` }} />
                      <i style={{ left: `${uPos(favorable)}%` }} />
                    </div>
                    <div className="cc-num mt-2 flex justify-between text-[11px]"><span className="cc-down">INVALIDATION {fmt(p.underlyingStop)}</span><span className="text-[var(--text-muted)]">best {fmt(favorable)}</span><span className="cc-up">TARGET {fmt(p.underlyingTarget)}</span></div>
                  </div>
                  {levels && (
                    <div>
                      <div className="cc-label mb-2">Option premium</div>
                      <div className="cc-rail" role="img" aria-label={`Premium stop ${fmt(levels.stop)}, entry ${fmt(p.entry)}, best bid ${fmt(levels.mark)}, 1.5R premium ${fmt(levels.target)}`}>
                        <i className="entry" style={{ left: `${levels.entryAt * 100}%` }} />
                        <i style={{ left: `${levels.markAt * 100}%` }} />
                      </div>
                      <div className="cc-num mt-2 flex justify-between text-[11px]"><span className="cc-down">STOP {fmt(levels.stop)}</span><span className="text-[var(--text-muted)]">best bid {fmt(levels.mark)}</span><span className="cc-up">1.5R {fmt(levels.target)}</span></div>
                    </div>
                  )}
                </div>
              </Panel>
              <Panel title="Lifecycle" bodyClassName="px-4 pb-3 pt-1">
                <ol className="m-0 list-none p-0">
                  {timeline.map((t, i) => (
                    <li key={i} className="flex gap-3 py-2">
                      <span className="cc-num w-14 flex-none pt-0.5 text-[12px] text-[var(--text-muted)]">{istTime(t.at)}</span>
                      <span className="cc-dot mt-1.5" style={{ color: t.tone }} aria-hidden="true" />
                      <div className="flex min-w-0 flex-col"><span className="font-semibold">{t.title}</span><span className="cc-note">{t.detail}</span></div>
                    </li>
                  ))}
                </ol>
              </Panel>
            </div>
            <div className="cc-col-side">
              <Panel title="Fills" bodyClassName="">
                <table className="cc-table">
                  <tbody>
                    <tr><td className="text-[var(--text-muted)]">Entry (ask + 1 tick)</td><td className="r cc-num">{fmt(p.entry)}</td></tr>
                    <tr><td className="text-[var(--text-muted)]">Exit (bid − 1 tick)</td><td className="r cc-num">{fmt(p.exit)}</td></tr>
                    <tr><td className="text-[var(--text-muted)]">Quantity · units</td><td className="r cc-num">{p.quantity} · {p.units}</td></tr>
                    <tr><td className="text-[var(--text-muted)]">Contract delta at entry</td><td className="r cc-num">{p.delta == null ? '—' : p.delta.toFixed(2)}</td></tr>
                    <tr><td className="text-[var(--text-muted)]">Best bid seen</td><td className="r cc-num">{fmt(p.highBid)}</td></tr>
                    <tr><td className="text-[var(--text-muted)]">Current stop</td><td className="r cc-num">{fmt(p.currentStop)}</td></tr>
                  </tbody>
                </table>
              </Panel>
              <Panel title="P&amp;L arithmetic" bodyClassName="">
                <table className="cc-table">
                  <tbody>
                    <tr><td>Gross ({p.exit != null ? `${(p.exit - p.entry).toFixed(2)} × ${p.units}` : 'open'})</td><td className="r cc-num">{signedInr(gross)}</td></tr>
                    <tr><td className="text-[var(--text-muted)]">Estimated costs</td><td className="r cc-num">{p.fees != null ? inr(-Math.abs(p.fees), 2) : gross != null && p.netPnl != null ? inr(p.netPnl - gross, 2) : '—'}</td></tr>
                    <tr><td className="font-semibold">Net</td><td className={`r cc-num font-semibold ${(p.netPnl ?? 0) >= 0 ? 'cc-up' : 'cc-down'}`}>{signedInr(p.netPnl)}</td></tr>
                    <tr><td className="text-[var(--text-muted)]">Initial risk (1R)</td><td className="r cc-num">{inr(p.riskCurrency)}</td></tr>
                  </tbody>
                </table>
              </Panel>
              <p className="cc-note px-1">Paper trade — no broker order was placed. Entry and exit notices go to Telegram when the bot is configured.</p>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
