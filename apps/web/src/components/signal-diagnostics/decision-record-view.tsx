'use client';

// ============================================================
// SIGNAL DIAGNOSTICS — Decision Record (Phase 8)
// ============================================================
// One snapshotted decision end to end: the input snapshot, each input's data
// quality (asOf, decision bar, age, source, status), market state, the
// events, the trigger candidates with their parent, the common metrics, the
// option candidates (selected + rejected), the arbitration (pre-build
// ranking and the live slot rows with the criterion each loser lost on), the
// final status, the graded outcome and every version. Read-only.
// ============================================================

import React, { useEffect, useState } from 'react';
import type { DecisionDiagnosticsView, DecisionListRow } from '@fno/shared';
import { api } from '@/lib/api';
import { FullReplayResult, type FullReplayReport } from './signal-engine-panel';

const INSTRUMENTS = ['', 'NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'GOLD'];

const ist = (t: number | null | undefined) =>
  t == null ? '—' : new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const n = (v: unknown, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : v == null ? '—' : String(v));
const ageText = (ms: number | null) => (ms == null ? '—' : ms < 0 ? `${Math.round(-ms / 1000)} s after T` : `${Math.round(ms / 1000)} s before T`);

const QUALITY_STYLE: Record<string, string> = {
  OK: 'text-emerald-400 light:text-emerald-700',
  STALE_INPUT: 'text-amber-400 light:text-amber-700',
  FUTURE_INPUT: 'text-orange-400 light:text-orange-700',
  MISSING: 'text-gray-500 light:text-slate-500',
};

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="bg-gray-900/40 light:bg-white border border-gray-800/60 light:border-slate-200 rounded-lg p-4 space-y-2">
      <header>
        <h4 className="text-sm font-semibold text-gray-200 light:text-slate-800">{title}</h4>
        {subtitle && <p className="text-xs text-gray-500 light:text-slate-500">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (rows.length === 0) return <p className="text-xs text-gray-500 light:text-slate-500 italic">None.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs tabular-nums">
        <thead className="text-gray-500 light:text-slate-500">
          <tr>{head.map((h) => <th key={h} className="text-left font-normal px-2 py-1">{h}</th>)}</tr>
        </thead>
        <tbody className="text-gray-300 light:text-slate-700">
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-800/60 light:border-slate-200">
              {r.map((c, j) => <td key={j} className="px-2 py-1 align-top">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyValues({ entries }: { entries: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
      {entries.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-gray-500 light:text-slate-500">{k}</dt>
          <dd className="text-gray-300 light:text-slate-700 tabular-nums break-all">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function DecisionDetail({ view }: { view: DecisionDiagnosticsView }) {
  const s = view.snapshot;
  const r = view.record;
  const lostOn = r?.arbitration?.lostOn ?? {};
  return (
    <div className="space-y-3">
      <Panel title="Input snapshot" subtitle={`${s.symbol} ${s.exchange} ${s.mode} · decision bar T ${ist(s.decisionBarTime)} · polled ${ist(s.polledAt)} · ${s.captureReason}`}>
        <KeyValues
          entries={[
            ['Snapshot', s.snapshotId],
            ['15m bars', `${s.inputs.ohlcv15m.bars} (${ist(s.inputs.ohlcv15m.firstBarTime)} → ${ist(s.inputs.ohlcv15m.lastBarTime)}), last close ${n(s.inputs.ohlcv15m.lastClose)}`],
            ['5m bars', s.inputs.ohlcv5m ? `${s.inputs.ohlcv5m.bars}, newest ${ist(s.inputs.ohlcv5m.lastBarTime)}` : 'not used'],
            ['Spot', n(s.inputs.spot)],
            ['Option chain', s.inputs.optionChain ? `${s.inputs.optionChain.expiry} · ATM ${s.inputs.optionChain.atmStrike} · ${s.inputs.optionChain.strikes} strikes · as of ${ist(s.inputs.optionChain.timestamp)}` : 'missing'],
            ['Futures', s.inputs.futures ? `${n(s.inputs.futures.price)} · OI ${s.inputs.futures.oi} (${s.inputs.futures.changeOi}) · ${s.inputs.futures.interpretation}` : 'missing'],
            ['OI / IV / HV', `PCR ${n(s.inputs.optionMetrics.pcr)} · ATM IV ${n(s.inputs.optionMetrics.atmIvPct)}% · HV ${n(s.inputs.optionMetrics.hvPct)}% · IV vs HV ${s.inputs.optionMetrics.ivVsHv ?? '—'}`],
            ['Market state', s.inputs.marketRegime ? `${s.inputs.marketRegime.regime} (${s.inputs.marketRegime.source})` : '—'],
            ['Liquidity pools', String(s.inputs.liquidityPools)],
            ['Corporate actions', s.inputs.corporateActions.applicable ? `${s.inputs.corporateActions.actions.length}` : 'not applicable'],
            ['Traded parents today', String(s.inputs.slotTradedKeys)],
          ]}
        />
      </Panel>

      <Panel title="Data quality" subtitle={s.dataQuality.degraded ? `Degraded — ${s.dataQuality.reasons.join(' · ')}` : 'Every input as of T.'}>
        <Table
          head={['Input', 'Status', 'As of', 'Decision bar (T)', 'Age', 'Tolerance', 'Source']}
          rows={Object.entries(s.dataQuality.inputs).map(([k, q]) => [
            k,
            <span key="s" className={QUALITY_STYLE[q.status]}>{q.status}</span>,
            ist(q.asOf),
            ist(q.decisionBarTime),
            ageText(q.ageMs),
            `${Math.round(q.toleranceMs / 1000)} s`,
            q.source,
          ])}
        />
      </Panel>

      {r ? (
        <>
          <Panel title="Final status" subtitle={`Record ${r.schemaVersion} · hash ${view.recordHash?.slice(0, 16) ?? '—'}…`}>
            <KeyValues
              entries={[
                ['Status', r.finalStatus],
                ['Top-ranked (pre-build)', r.selectedCandidateId ?? '—'],
                ['S1', `${r.structure.status}${r.structure.fill ? ` · fill ${r.structure.fill.kind} ${r.structure.fill.lifecycleId} @ ${n(r.structure.fill.price)}` : ''}`],
                ['Families', `${r.families.status}${r.families.session ? ` · ${r.families.session}` : ''} · ${r.families.evaluatedBarTimes.length} bar(s) evaluated`],
                ['Not re-derived', r.notReplayed.join(', ')],
              ]}
            />
          </Panel>

          <Panel title="Events" subtitle="The session's market events (event engine).">
            <Table
              head={['Event', 'Type', 'Dir', 'Bar', 'Price', 'Level', 'From']}
              rows={(r.families.events as any[]).map((e) => [e.id, e.type, e.direction ?? '—', ist(e.time), n(e.price), e.level ? `${e.level.kind} ${n(e.level.price)}` : '—', e.parentId ?? '—'])}
            />
          </Panel>

          <Panel title="Trigger candidates" subtitle="Every candidate decided at this bar, with its parent move.">
            <Table
              head={['Candidate', 'Source', 'Dir', 'Stage', 'Bucket', 'Entry', 'Stop', 'T1', 'R:T1', 'Parent', 'Eligible', 'Slot', 'Degraded', 'Reason']}
              rows={r.candidates.map((c) => [
                c.candidateId, c.source, c.direction, c.stage, c.bucket ?? '—', n(c.entry), n(c.stop), n(c.t1), n(c.rToT1), c.parentId ?? '—',
                c.eligible ? 'yes' : 'no', c.handedToSlot ? 'handed' : '—', c.degraded ? 'yes' : '—', c.reason ?? (c.observation ? `${c.observation.role}${c.observation.reason ? `: ${c.observation.reason}` : ''}` : '—'),
              ])}
            />
          </Panel>

          <Panel title="Common metrics" subtitle="The decision-time metrics every slot candidate is ranked on (NOT_MEASURED is never invented).">
            <Table
              head={['Candidate', 'Timing', 'Move consumed', 'Move potential', 'Objective (ATR)', 'Net R:R', 'Entry quality', 'Evidence', 'Lost on']}
              rows={r.metrics.map((m: any) => [m.candidateId, String(m.timingClass), n(m.moveConsumedPct), String(m.movePotential), n(m.objectiveDistanceAtr), n(m.netRR), n(m.entryQuality), String(m.evidence), lostOn[m.candidateId] ?? (r.selectedCandidateId === m.candidateId ? 'selected' : '—')])}
            />
          </Panel>

          <Panel title="Option candidates" subtitle="Each newest-bar family leg's cost on the snapshot chain; every strike of each persisted plan (selected / ranked / rejected).">
            <Table
              head={['Candidate', 'Side', 'Strike', 'Expiry', 'Premium', 'Cost % prem', 'Net R', 'Quality', 'Degraded']}
              rows={r.optionCandidates.map((o) => [o.candidateId, o.side ?? '—', n(o.strike, 0), o.expiry ?? '—', n(o.premium), n(o.costPctOfPremium), n(o.netR), o.quality ?? '—', o.degraded ? 'yes' : '—'])}
            />
            {view.optionPlans.map((p) => (
              <div key={p.planId} className="pt-2">
                <p className="text-xs text-gray-400 light:text-slate-600">
                  Plan {p.source} {p.candidateId ?? ''} · {p.option.side} {n(p.option.strike, 0)} {p.option.expiry} · Entry {n(p.option.entry)} SL {n(p.option.sl)} TSL {n(p.option.tsl)} T1 {n(p.option.t1)} T2 {n(p.option.t2)} · underlying {n(p.underlying.entry)} / {n(p.underlying.stop)} / {n(p.underlying.t1)} / {n(p.underlying.t2)}
                </p>
                <Table
                  head={['Strike', 'Status', 'Rank', 'Δ', 'Spread %', 'Premium', 'Net R:R', 'Rejected at', 'Reason']}
                  rows={(p.candidates as any[]).map((c) => [n(c.strike, 0), c.status, c.rank ?? '—', n(c.delta), n(c.spreadPct), n(c.premium), n(c.netRR), c.rejectedAt ?? '—', c.rejectionReason ?? '—'])}
                />
              </div>
            ))}
          </Panel>
        </>
      ) : (
        <Panel title="Decision record">
          <p className="text-xs text-gray-500 light:text-slate-500 italic">No record stored for this snapshot.</p>
        </Panel>
      )}

      <Panel title="Arbitration" subtitle="The live slot: every candidate's role, rank, parent and slot decision; a loser's reason names the criterion it lost on.">
        <Table
          head={['Candidate', 'Source', 'Parent', 'Role', 'Rank', 'Pre-build', 'Slot', 'Decision', 'Reason']}
          rows={view.arbitration.map((a) => [a.candidateId, a.source, a.parentId ?? '—', a.role ?? '—', a.rank ?? '—', a.preBuildRank ?? '—', a.slotDecision?.slot ?? '—', a.slotDecision?.decision ?? '—', a.optionBuildFailure ?? a.reason ?? '—'])}
        />
      </Panel>

      <Panel title="Outcome" subtitle="setup_events grading of the rows this decision produced (filled once the session ends).">
        <Table
          head={['Candidate', 'Event', 'Source', 'Decision', 'Result R', 'MFE R', 'MAE R', 'Exit', 'Graded']}
          rows={view.outcomes.map((o) => [o.candidateId, o.eventType, o.source ?? '—', o.decision ?? '—', n(o.resultR), n(o.mfeR), n(o.maeR), o.exitReason ?? '—', ist(o.gradedAt)])}
        />
      </Panel>

      <Panel title="Versions" subtitle="Everything the decision ran under.">
        <KeyValues
          entries={[
            ...Object.entries(s.versions).filter(([k]) => k !== 'triggerVersions').map(([k, v]) => [k, String(v ?? '—')] as [string, React.ReactNode]),
            ['triggerVersions', Object.values(s.versions.triggerVersions).join(', ')],
            ['configHash', s.config.configHash],
          ]}
        />
      </Panel>

      {view.replay && (
        <Panel title="Replay" subtitle="Re-derived offline from the stored snapshot only.">
          <KeyValues entries={[['Result', view.replay.status], ['Hash', view.replay.hash ?? '—'], ['Differences', view.replay.diff.length ? view.replay.diff.join(', ') : 'none']]} />
        </Panel>
      )}
    </div>
  );
}

export function DecisionRecordView() {
  const [symbol, setSymbol] = useState('');
  const [rows, setRows] = useState<DecisionListRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<DecisionDiagnosticsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState<FullReplayReport | null>(null);
  const [fullBusy, setFullBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getDecisionList(symbol || undefined)
      .then((d) => !cancelled && (setRows(d.rows), setError(null)))
      .catch((e) => !cancelled && setError(e?.message ?? 'Could not load decisions.'));
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const open = (id: string, replay = false) => {
    if (id !== selected) setFull(null);
    setSelected(id);
    api
      .getDecision(id, replay)
      .then((v) => (setView(v), setError(null)))
      .catch((e) => setError(e?.message ?? 'Could not load the decision.'));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="decision-symbol" className="text-xs text-gray-500 light:text-slate-500">Instrument</label>
        <select id="decision-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} className="text-xs bg-gray-900 light:bg-white border border-gray-700 light:border-slate-300 rounded px-2 py-1 text-gray-200 light:text-slate-800">
          {INSTRUMENTS.map((i) => <option key={i} value={i}>{i || 'All'}</option>)}
        </select>
        {selected && (
          <button onClick={() => open(selected, true)} className="text-xs px-2 py-1 rounded border border-gray-700 light:border-slate-300 text-gray-300 light:text-slate-700 hover:bg-gray-800/60 light:hover:bg-slate-100">
            Replay offline
          </button>
        )}
        {selected && (
          <button
            disabled={fullBusy}
            onClick={() => {
              setFullBusy(true);
              api
                .getDecisionFullReplay(selected)
                .then((r) => (setFull(r), setError(null)))
                .catch((e) => setError(e?.message ?? 'Full replay failed.'))
                .finally(() => setFullBusy(false));
            }}
            className="text-xs px-2 py-1 rounded border border-gray-700 light:border-slate-300 text-gray-300 light:text-slate-700 hover:bg-gray-800/60 light:hover:bg-slate-100 disabled:opacity-50"
          >
            {fullBusy ? 'Replaying…' : 'Full replay'}
          </button>
        )}
      </div>
      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</div>}
      <Panel title="Recent decisions" subtitle="One snapshot per new closed bar (and per spot fill). Pick one to see its record.">
        <Table
          head={['Decision bar (T)', 'Symbol', 'Capture', 'Status', 'Top-ranked', 'Inputs', 'Outcome', '']}
          rows={rows.map((r) => [
            ist(r.decisionBarTime), `${r.symbol} ${r.exchange}`, r.captureReason, r.finalStatus ?? '—', r.selectedCandidateId ?? '—',
            r.degraded ? <span key="d" className="text-amber-400 light:text-amber-700">degraded</span> : 'as of T', r.hasOutcome ? 'graded' : '—',
            <button key="o" onClick={() => open(r.snapshotId)} className={`underline ${selected === r.snapshotId ? 'text-blue-400' : 'text-gray-400 light:text-slate-600'}`}>Open</button>,
          ])}
        />
      </Panel>
      {full && full.snapshotId === selected && <FullReplayResult report={full} />}
      {view && <DecisionDetail view={view} />}
    </div>
  );
}
