'use client';

// ============================================================
// STRATEGY LAB — what the fresh-start paper results say, and what they do not yet
// ============================================================
// From the stored positions and the server's per-strategy totals: KPIs, R distribution, expectancy by time of
// entry, exit reasons and the promotion checklist. Every view carries its sample size; nothing is "validated".
// ============================================================

import React, { useMemo, useState } from 'react';
import { useFreshStart } from '@/lib/use-fresh-start';
import { exitReasons, MIN_SAMPLE, positionViews, promotionGate, rHistogram, signedInr, signedR, STRATEGY_IDS, strategyName, timeHeatmap, TIME_SLOTS } from '@/lib/command-center';
import { Empty, Kpi, Panel, Pill } from '@/components/command-center/panel';
import { EquityPanel } from '@/components/command-center';

export function StrategyLabPage() {
  const { data: status, loading, error } = useFreshStart();
  const [tab, setTab] = useState<string>('ALL');
  const all = useMemo(() => positionViews(status), [status]);
  const positions = tab === 'ALL' ? all : all.filter((p) => p.strategy === tab);
  const closed = positions.filter((p) => p.status === 'CLOSED');
  const wins = closed.filter((p) => (p.netPnl ?? 0) > 0), losses = closed.filter((p) => (p.netPnl ?? 0) < 0);
  const rs = closed.map((p) => p.r).filter((r): r is number => r != null);
  const expectancy = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  const grossWin = wins.reduce((a, p) => a + (p.netPnl ?? 0), 0), grossLoss = -losses.reduce((a, p) => a + (p.netPnl ?? 0), 0);
  let peak = 0, run = 0, maxDd = 0;
  for (const r of [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0)).map((p) => p.r ?? 0)) {
    run += r;
    peak = Math.max(peak, run);
    maxDd = Math.max(maxDd, peak - run);
  }
  const holds = closed.filter((p) => p.closedAt).map((p) => (p.closedAt! - p.openedAt) / 60_000);
  const hist = rHistogram(positions);
  const maxBin = Math.max(1, ...hist.map((h) => h.n));
  const heat = timeHeatmap(positions).filter((r) => tab === 'ALL' || r.strategy === tab);
  const reasons = exitReasons(positions);
  const gateFor = tab === 'ALL' ? null : status?.performance.find((p) => p.strategy === tab);

  return (
    <div className="cc-page">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Strategy">
        {['ALL', ...STRATEGY_IDS].map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="cc-chip" onClick={() => setTab(id)}>
            {id === 'ALL' ? 'All strategies' : strategyName(id)}
          </button>
        ))}
      </div>
      {error && !status && <p role="alert" className="cc-panel px-4 py-3 text-sm" style={{ color: 'var(--status-warn)' }}>Fresh-start results are unavailable ({error}).</p>}

      <section aria-label="Summary" className="cc-strip" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Kpi label="Closed trades" value={loading && !status ? '…' : `${closed.length}`} sub={`Need ${MIN_SAMPLE} per strategy`} />
        <Kpi label="Win rate" value={closed.length ? `${((wins.length / closed.length) * 100).toFixed(0)}%` : '—'} sub={`${wins.length} W · ${losses.length} L${closed.length < MIN_SAMPLE ? ' · not significant' : ''}`} />
        <Kpi label="Expectancy" value={signedR(expectancy)} valueClass={(expectancy ?? 0) > 0 ? 'cc-up' : (expectancy ?? 0) < 0 ? 'cc-down' : ''} sub="Per trade, after costs" />
        <Kpi label="Profit factor" value={grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : wins.length ? '∞' : '—'} sub="Gross win ÷ gross loss" />
        <Kpi label="Max drawdown" value={closed.length ? (maxDd > 0 ? `−${maxDd.toFixed(1)}R` : '0.0R') : '—'} valueClass={maxDd > 0 ? 'cc-down' : ''} sub="Peak-to-trough, in R" />
        <Kpi label="Avg hold" value={holds.length ? `${Math.round(holds.reduce((a, b) => a + b, 0) / holds.length)} min` : '—'} sub={holds.length ? `Longest ${Math.round(Math.max(...holds))} min` : undefined} />
      </section>

      <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))' }}>
        <Panel title={<>R-multiple distribution <small>· {rs.length} trades</small></>}>
          {rs.length === 0 ? (
            <Empty>No closed trades yet.</Empty>
          ) : (
            <>
              <div className="flex h-40 items-end gap-1.5 border-b border-[var(--border-secondary)]" role="img" aria-label={hist.map((h) => `${h.label}: ${h.n}`).join(', ')}>
                {hist.map((h) => (
                  <div key={h.label} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                    <span className="cc-num text-[11px] text-[var(--text-muted)]">{h.n || ''}</span>
                    <div className="w-full rounded-t" style={{ height: `${Math.max(2, (h.n / maxBin) * 120)}px`, background: h.tone === 'loss' ? 'var(--negative)' : h.tone === 'flat' ? 'var(--text-muted)' : 'var(--positive)', opacity: h.n ? 0.85 : 0.25 }} />
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex gap-1.5">{hist.map((h) => <span key={h.label} className="cc-num flex-1 text-center text-[10px] text-[var(--text-muted)]">{h.label}</span>)}</div>
            </>
          )}
        </Panel>

        <Panel title="Expectancy by time of entry (R / trade)" bodyClassName="cc-panel-body cc-scroll">
          <table className="w-full border-separate" style={{ borderSpacing: 3, minWidth: 400 }}>
            <thead>
              <tr><th className="cc-label text-left font-medium" scope="col" />{TIME_SLOTS.map((s) => <th key={s.label} scope="col" className="cc-label font-medium">{s.label}</th>)}</tr>
            </thead>
            <tbody>
              {heat.map((r) => (
                <tr key={r.strategy}>
                  <th scope="row" className="whitespace-nowrap pr-2 text-left text-[12px] font-medium">{r.label}</th>
                  {r.cells.map((c, i) => {
                    const a = c.r == null ? 0 : Math.min(0.55, 0.12 + Math.abs(c.r) * 0.35) * (c.n < 5 ? 0.55 : 1);
                    const bg = c.r == null ? 'var(--muted-bg)' : `color-mix(in srgb, ${c.r >= 0 ? 'var(--positive)' : 'var(--negative)'} ${Math.round(a * 100)}%, transparent)`;
                    return (
                      <td key={i} className="cc-num rounded py-2 text-center text-[11px] font-semibold" style={{ background: bg, color: c.r == null ? 'var(--text-muted)' : 'var(--text-primary)' }} title={`${c.n} trade${c.n === 1 ? '' : 's'}`}>
                        {c.r == null ? '—' : signedR(c.r).replace('R', '')}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="cc-note mt-2">Grey = no trades. Cells with fewer than 5 trades are faded. IST entry time.</p>
        </Panel>

        <Panel title={gateFor ? `Promotion gate · ${strategyName(tab)}` : 'Promotion gate'} meta={gateFor ? <Pill tone={promotionGate(gateFor).every((g) => g.ok) ? 'ok' : 'warn'}>{promotionGate(gateFor).every((g) => g.ok) ? 'READY FOR REVIEW' : 'NOT READY'}</Pill> : undefined}>
          {tab === 'ALL' ? (
            <div className="flex flex-col gap-2">
              {STRATEGY_IDS.map((id) => {
                const g = promotionGate(status?.performance.find((p) => p.strategy === id));
                const passed = g.filter((x) => x.ok).length;
                return (
                  <button key={id} type="button" className="flex items-center justify-between gap-2 rounded px-1 py-1.5 text-left text-[12.5px] hover:bg-[var(--surface-card-alt)]" onClick={() => setTab(id)}>
                    <span>{strategyName(id)}</span>
                    <span className="flex items-center gap-2"><span className="cc-num text-[var(--text-muted)]">{passed} / {g.length} checks</span><Pill tone={passed === g.length ? 'ok' : 'warn'}>{passed === g.length ? 'READY' : 'NOT READY'}</Pill></span>
                  </button>
                );
              })}
              <p className="cc-note mt-1">Pick a strategy for its checklist. Passing makes it eligible for a human review — never an automatic live switch.</p>
            </div>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {promotionGate(gateFor ?? undefined).map((g) => (
                <li key={g.rule} className="flex flex-col gap-1">
                  <div className="flex justify-between gap-2 text-[12px]"><span>{g.rule}</span><span className="cc-num" style={{ color: g.ok ? 'var(--status-ok)' : 'var(--status-warn)' }}>{g.value}</span></div>
                  <div className="cc-bar"><span style={{ width: `${Math.max(2, g.progress * 100)}%`, background: g.ok ? 'var(--status-ok)' : 'var(--status-warn)' }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Exit reasons" bodyClassName="">
          {reasons.length === 0 ? (
            <Empty>No closed trades yet.</Empty>
          ) : (
            reasons.map((r) => (
              <div key={r.reason} className="flex flex-col gap-1 border-b border-[var(--border-primary)] px-4 py-2 last:border-b-0">
                <div className="flex justify-between gap-2 text-[12.5px]"><span className="cc-num">{r.reason}</span><span className="cc-num"><span className="text-[var(--text-muted)]">{r.n} · </span><span className={r.net >= 0 ? 'cc-up' : 'cc-down'}>{signedInr(r.net)}</span></span></div>
                <div className="cc-bar"><span style={{ width: `${(r.n / Math.max(1, closed.length)) * 100}%`, background: r.net >= 0 ? 'var(--positive)' : 'var(--negative)' }} /></div>
              </div>
            ))
          )}
        </Panel>

        <EquityPanel positions={positions} capital={status?.capital ?? null} />
      </div>
      <p className="cc-note">Paper results on quote-backed fills after estimated costs. A high win rate is an objective to test, not a promise; no strategy is validated by this page.</p>
    </div>
  );
}
