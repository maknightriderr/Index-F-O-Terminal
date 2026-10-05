'use client';

// ============================================================
// SIGNAL DIAGNOSTICS
// ============================================================
// Answers one question: are we missing good trades because of our
// architecture? Opportunity (objective opportunities, detected, rejected,
// traded, late, never detected, with auditable detection/capture rates),
// decision (rejection-reason distribution), performance (PF, drawdown,
// gross/net R, MFE/MAE, and by grade/pool/trigger), cost (what spread,
// slippage and charges took), and architecture health (filter leakage, the
// daily census).
//
// Read-only. Nothing here touches a live decision, and every figure is a
// SIMULATED paper-trade outcome in R, not account P&L. Instruments are shown
// separately; segment totals sum inside INDEX or inside MCX, never across.
// ============================================================

import React, { useState } from 'react';
import {
  useSignalDiagnostics,
  type DiagnosticsSummaryRow,
  type DiagnosticsGradeRow,
  type DiagnosticsLeakageRow,
  type DiagnosticsRate,
  type DiagnosticsPerformanceStats,
  type DiagnosticsCostStats,
  type DiagnosticsOpportunityStats,
  type SignalDiagnosticsData,
} from '@/lib/use-signal-diagnostics';
import { DecisionRecordView } from './decision-record-view';

type View = 'opportunity' | 'decision' | 'record' | 'performance' | 'cost' | 'health' | 'moves' | 'registry';

const VIEW_LABELS: Record<View, string> = {
  opportunity: 'Opportunity',
  decision: 'Decision',
  record: 'Decision Record',
  performance: 'Performance',
  cost: 'Cost',
  health: 'Architecture Health',
  moves: 'Major Moves',
  registry: 'Trigger Registry',
};

const INSTRUMENTS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'GOLD'];

/** Metric definitions: every label on the page quotes one of these as its tooltip. */
const DEF = {
  opportunities: 'Objective opportunities: census windows where price reached +2 ATR before −1 ATR from a 15m bar close within the session (the research definition).',
  detected: 'Detected: opportunities with a setup_events row in the same direction within ±2 bars (traded, rejected) or 2–6 bars later (late).',
  rejected: 'Rejected: detected near the window start, but the engine refused or invalidated the setup.',
  traded: 'Traded: a paper trade was minted within ±2 bars of the opportunity window.',
  late: 'Late: the first setup row came 2–6 bars after the window started.',
  never: 'Never detected: no setup_events row in that direction within 6 bars.',
  detectionRate: 'Detection rate = (traded + rejected + late) ÷ covered opportunities.',
  captureRate: 'Capture rate = traded ÷ covered opportunities. Late and rejected detections are not captures.',
  dataGap: 'Data gap: opportunities in a session that was not fully covered (missing or stale bars, or the recorder was down). They are never called NEVER_DETECTED and are left out of every rate.',
  missedRate: 'Missed rate = never detected ÷ covered opportunities.',
  lateRate: 'Late rate = detected late ÷ covered opportunities.',
  rejectionRate: 'Rejection rate = detected but rejected ÷ covered opportunities.',
  created: 'Candidates created: setup lifecycles that got past WATCH (setup_events).',
  tradeReady: 'Trade-ready: lifecycles that reached CONFIRMED (a limit resting at the zone).',
  noFill: 'No fill: graded setups whose entry price never traded afterwards.',
  majorMove: 'A major move: the session\'s largest directional leg reached ≥ 1 average session range (previous 20 sessions).',
  cohortTraded: 'TRADED: paper trades the engine took, graded on the underlying path against their own stop and T1.',
  cohortRejected: 'REJECTED: setups the engine refused, graded as if entered — only those whose entry price actually traded afterwards (FILLED).',
  count: 'n: graded rows with a result.',
  winRate: 'Win rate: share of graded rows with result > 0R.',
  grossR: 'Gross R: sum of results before costs, in R of the underlying stop.',
  netR: 'Net R: sum of results after costs (result − cost R). Covers only rows with a measured option cost; the count in brackets says how many.',
  pf: 'Profit factor: sum of winning R ÷ |sum of losing R|. Blank with no losing row.',
  pfNet: 'Profit factor after costs, over the rows with a measured cost.',
  maxDd: 'Max drawdown: largest peak-to-trough fall of the cumulative R curve, in time order.',
  mfe: 'MFE: average most favourable excursion before exit, in R.',
  mae: 'MAE: average most adverse excursion before exit, in R.',
  priced: 'Priced: graded rows that carry a cost in R. OBSERVED = spread from a two-sided live quote; MODELLED = no two-sided quote, spread assumed. Slippage and charges are always modelled from the cost schedule.',
  totalCost: 'Total cost R: sum of cost R (spread + slippage + charges) over priced rows. Cost R = cost per option unit ÷ (|delta| × underlying stop).',
  avgCost: 'Average cost R per priced row.',
  costLeakage: 'Cost leakage R: cost R taken out of trades that were winners before costs.',
  flipped: 'Flipped: winners before costs that were not winners after them.',
  spreadLeak: 'Spread leakage R: the bid-ask part of total cost R.',
  slippageLeak: 'Slippage leakage R: the modelled slippage part of total cost R (paper trading has no fills to observe).',
  chargesLeak: 'Charges leakage R: statutory charges and brokerage, from the cost schedule.',
} as const;

function fmt(v: number | null | undefined, d = 2): string {
  return v == null ? '—' : v.toFixed(d);
}
function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}
function rColor(v: number | null | undefined): string {
  if (v == null) return 'text-gray-400 light:text-slate-500';
  return v > 0 ? 'text-emerald-400 light:text-emerald-600' : v < 0 ? 'text-red-400 light:text-red-600' : 'text-gray-300 light:text-slate-700';
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900/40 light:bg-white border border-gray-800/60 light:border-slate-200 rounded-lg p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-200 light:text-slate-800">{title}</h3>
        {subtitle && <p className="text-[11px] text-gray-500 light:text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

/** A column header or label that carries its definition as a tooltip. */
function Th({ def, align = 'right', children }: { def?: string; align?: 'left' | 'right'; children: React.ReactNode }) {
  return (
    <th className={`${align === 'left' ? 'text-left' : 'text-right'} px-2 py-1.5 font-medium`} title={def}>
      <span className={def ? 'underline decoration-dotted decoration-gray-600 underline-offset-2 cursor-help' : undefined}>{children}</span>
    </th>
  );
}

/** A rate with its numerator and denominator, so it can be audited. */
function RateCell({ r }: { r: DiagnosticsRate }) {
  return (
    <td className="text-right px-2 py-1.5 tabular-nums">
      <span className="text-gray-200 light:text-slate-800 font-medium">{pct(r.rate)}</span>
      <span className="text-gray-500 light:text-slate-500 ml-1">
        ({r.numerator}/{r.denominator})
      </span>
    </td>
  );
}

function Definitions({ keys }: { keys: (keyof typeof DEF)[] }) {
  return (
    <details className="text-[11px] text-gray-400 light:text-slate-600">
      <summary className="cursor-pointer text-gray-500 light:text-slate-500 select-none">Definitions</summary>
      <ul className="mt-1.5 space-y-0.5 list-disc pl-4">
        {keys.map((k) => (
          <li key={k}>{DEF[k]}</li>
        ))}
      </ul>
    </details>
  );
}

const SegmentTag = ({ segment }: { segment: string }) => (
  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${segment === 'MCX' ? 'bg-amber-500/15 text-amber-300 light:text-amber-700' : 'bg-sky-500/15 text-sky-300 light:text-sky-700'}`}>{segment}</span>
);

const bySegmentThenName = <T extends { segment: string; instrument?: string }>(a: T, b: T) => a.segment.localeCompare(b.segment) || (a.instrument ?? '').localeCompare(b.instrument ?? '');

// ---------------- Opportunity ----------------

function OpportunityCells({ s }: { s: DiagnosticsOpportunityStats }) {
  return (
    <>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-200 light:text-slate-800">{s.opportunities}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{s.detected}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-red-400">{s.rejected}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-emerald-400">{s.traded}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{s.late}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{s.neverDetected}</td>
      <RateCell r={s.detectionRate} />
      <RateCell r={s.captureRate} />
    </>
  );
}

function OpportunityHead({ first }: { first: string }) {
  return (
    <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
      <Th align="left">{first}</Th>
      <Th def={DEF.opportunities}>Objective opps</Th>
      <Th def={DEF.detected}>Detected</Th>
      <Th def={DEF.rejected}>Rejected</Th>
      <Th def={DEF.traded}>Traded</Th>
      <Th def={DEF.late}>Late</Th>
      <Th def={DEF.never}>Never detected</Th>
      <Th def={DEF.detectionRate}>Detection rate</Th>
      <Th def={DEF.captureRate}>Capture rate</Th>
    </tr>
  );
}

function OpportunityView({ opportunity }: { opportunity: SignalDiagnosticsData['opportunity'] }) {
  if (opportunity.byInstrument.length === 0) return <p className="text-xs text-gray-500 light:text-slate-500 italic py-4">No census rows in this window yet. The census runs after each exchange closes, for sessions recorded from their open.</p>;
  return (
    <div className="space-y-4">
      <Card title="Opportunities and what the engine did" subtitle="Per instrument. Rates show numerator/denominator. The strategy-version filter applies to census windows; the daily session counts carry no version.">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <OpportunityHead first="Instrument" />
            </thead>
            <tbody>
              {[...opportunity.byInstrument].sort(bySegmentThenName).map((o) => (
                <tr key={`${o.instrument}:${o.exchange}`} className="border-t border-gray-800/40 light:border-slate-200">
                  <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">
                    <span className="mr-1.5">{o.instrument}</span>
                    <SegmentTag segment={o.segment} />
                    <span className="block text-[10px] text-gray-500 light:text-slate-500 font-normal">
                      {o.sessions} sessions · {o.correctlyEmptySessions} correctly empty
                    </span>
                  </td>
                  <OpportunityCells s={o} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Segment totals" subtitle="Instruments summed inside INDEX or inside MCX. The two are never added together.">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <OpportunityHead first="Segment" />
            </thead>
            <tbody>
              {[...opportunity.bySegment].sort((a, b) => a.segment.localeCompare(b.segment)).map((s) => (
                <tr key={s.segment} className="border-t border-gray-800/40 light:border-slate-200">
                  <td className="px-2 py-1.5">
                    <SegmentTag segment={s.segment} />
                  </td>
                  <OpportunityCells s={s} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Rates and the setup funnel" subtitle="Every rate is over covered opportunities; data-gap opportunities are counted but never judged.">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
                <Th align="left">Instrument</Th>
                <Th def={DEF.dataGap}>Data gap</Th>
                <Th def={DEF.missedRate}>Missed rate</Th>
                <Th def={DEF.lateRate}>Late rate</Th>
                <Th def={DEF.rejectionRate}>Rejection rate</Th>
                <Th def={DEF.created}>Candidates created</Th>
                <Th def={DEF.tradeReady}>Trade-ready</Th>
                <Th def={DEF.noFill}>No fill</Th>
              </tr>
            </thead>
            <tbody>
              {[...opportunity.byInstrument].sort(bySegmentThenName).map((o) => (
                <tr key={`${o.instrument}:${o.exchange}:rates`} className="border-t border-gray-800/40 light:border-slate-200">
                  <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">
                    <span className="mr-1.5">{o.instrument}</span>
                    <SegmentTag segment={o.segment} />
                  </td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{o.dataGap}</td>
                  <RateCell r={o.missedRate} />
                  <RateCell r={o.lateRate} />
                  <RateCell r={o.rejectionRate} />
                  <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{o.candidatesCreated}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{o.tradeReady}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{o.noFill}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Definitions keys={['opportunities', 'detected', 'rejected', 'traded', 'late', 'never', 'detectionRate', 'captureRate', 'dataGap', 'missedRate', 'lateRate', 'rejectionRate', 'created', 'tradeReady', 'noFill']} />
    </div>
  );
}

// ---------------- Major moves ----------------

const MOVE_CLASS_STYLE: Record<string, string> = {
  TRADED: 'text-emerald-400 light:text-emerald-700',
  CORRECTLY_UNTRADEABLE: 'text-gray-400 light:text-slate-600',
  DATA_GAP: 'text-gray-500 light:text-slate-500',
  LATE_ENTRY: 'text-amber-400 light:text-amber-700',
  RISK_REJECTED: 'text-amber-400 light:text-amber-700',
  OPTION_REJECTED: 'text-amber-400 light:text-amber-700',
};

function MajorMovesView({ rows }: { rows: SignalDiagnosticsData['majorMoves'] }) {
  const time = (t: number | null) => (t == null ? '—' : new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }));
  return (
    <div className="space-y-4">
      <Card
        title="Major moves: what happened, and why it was or wasn't traded"
        subtitle="Computed after each session. The research trigger families are run over the session to say which of them saw the move and when it was first actionable; they never trade. A miss is only called when a predefined rule had an actionable setup while the data was covered."
      >
        {rows.length === 0 ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No major moves diagnosed in this window yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
                  <Th align="left">Date</Th>
                  <Th align="left">Instrument</Th>
                  <Th align="left" def={DEF.majorMove}>Move</Th>
                  <Th align="left">Started by</Th>
                  <Th align="left">Families that saw it</Th>
                  <Th align="left">First actionable</Th>
                  <Th align="left">Outcome</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={`${m.sessionDate}:${m.instrument}:${m.direction}`} className="border-t border-gray-800/40 light:border-slate-200 align-top">
                    <td className="px-2 py-1.5 text-gray-300 light:text-slate-700 whitespace-nowrap">{m.sessionDate}</td>
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800 whitespace-nowrap">
                      <span className="mr-1.5">{m.instrument}</span>
                      <SegmentTag segment={m.segment} />
                    </td>
                    <td className="px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700 whitespace-nowrap">
                      {m.direction === 'BULLISH' ? '▲' : '▼'} {fmt(m.startPrice)} → {fmt(m.endPrice)}
                      <span className="block text-[10px] text-gray-500 light:text-slate-500">
                        {fmt(m.sizeAdr)}× avg range · {time(m.startTime)}–{time(m.endTime)} · {m.coverage ?? '—'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-gray-400 light:text-slate-600">
                      {m.firstEventType ?? '—'}
                      {m.firstEventTime != null && <span className="block text-[10px] text-gray-500 light:text-slate-500">{time(m.firstEventTime)}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-gray-400 light:text-slate-600">{m.familiesRecognized.length ? m.familiesRecognized.join(', ').toLowerCase().replace(/_/g, ' ') : 'none'}</td>
                    <td className="px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700 whitespace-nowrap">
                      {m.firstActionable ? (
                        <>
                          {m.firstActionable.triggerId} @ {fmt(m.firstActionable.entry)}
                          <span className="block text-[10px] text-gray-500 light:text-slate-500">
                            {Math.round(m.firstActionable.remainingMovePct * 100)}% of the move left{m.firstActionable.decisionTime ? ` · ${time(m.firstActionable.decisionTime)}` : ''}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`font-semibold ${MOVE_CLASS_STYLE[m.classification] ?? 'text-red-400 light:text-red-700'}`}>{m.classification}</span>
                      {m.reason && <span className="block text-[10px] text-gray-500 light:text-slate-500 max-w-xs">{m.reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Definitions keys={['majorMove', 'dataGap']} />
    </div>
  );
}

// ---------------- Trigger registry ----------------

const STATUS_STYLE: Record<string, string> = {
  RESEARCH: 'bg-sky-500/15 text-sky-300 light:text-sky-700',
  SHADOW: 'bg-violet-500/15 text-violet-300 light:text-violet-700',
  PAPER_RESEARCH: 'bg-orange-500/15 text-orange-300 light:text-orange-700',
  PAPER:'bg-amber-500/15 text-amber-300 light:text-amber-700',
  ACTIVE: 'bg-emerald-500/15 text-emerald-300 light:text-emerald-700',
  RETIRED: 'bg-gray-500/15 text-gray-400 light:text-slate-600',
};

function RegistryView({
  triggers,
  stages,
  displacementRequiredBy,
  shadow,
}: {
  triggers: SignalDiagnosticsData['triggers'];
  stages: Record<string, string>;
  displacementRequiredBy: string[];
  shadow: SignalDiagnosticsData['shadow'];
}) {
  const forward = (id: string) => shadow.filter((r) => r.triggerId === id);
  return (
    <Card
      title="Trigger registry"
      subtitle="Displacement is a trigger's own condition, not a gate on the engine. Every family runs at its own stage: S1 (the structure engine) trades; SHADOW families are evaluated live on every closed bar, recorded and graded, but never traded; a family reaches PAPER only through a code-level promotion after an out-of-sample pass and 30 forward trades."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
              <Th align="left">Trigger</Th>
              <Th align="left">Family</Th>
              <Th align="left" def="The trigger's live stage now: ACTIVE/PAPER trade; SHADOW is live but never trades; RETIRED is off.">Live stage</Th>
              <Th align="left" def="Whether this trigger's own rule requires a displacement candle. No other trigger is gated on one.">Displacement</Th>
              <Th align="left" def="SHADOW forward record, per segment: candidates seen live · would have traded (valid geometry, session window, cost) · selected as its parent move's one setup · graded so far of the 30 needed · avg R before / after cost · PF.">Forward (shadow)</Th>
              <Th align="left">Exact rule</Th>
              <Th align="left">Stop</Th>
            </tr>
          </thead>
          <tbody>
            {triggers.map((t) => (
              <tr key={t.triggerId} className="border-t border-gray-800/40 light:border-slate-200 align-top">
                <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800 whitespace-nowrap">
                  {t.triggerId} <span className="block text-[10px] font-normal text-gray-400 light:text-slate-600">{t.name} · v{t.version}</span>
                </td>
                <td className="px-2 py-1.5 text-gray-400 light:text-slate-600 whitespace-nowrap">{t.family.toLowerCase().replace(/_/g, ' ')}</td>
                <td className="px-2 py-1.5">
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${STATUS_STYLE[stages[t.triggerId] ?? t.status] ?? ''}`}>{stages[t.triggerId] ?? t.status}</span>
                </td>
                <td className="px-2 py-1.5 text-gray-400 light:text-slate-600 whitespace-nowrap">{displacementRequiredBy.includes(t.triggerId) ? 'required' : 'not required'}</td>
                <td className="px-2 py-1.5 text-gray-300 light:text-slate-700 tabular-nums whitespace-nowrap">
                  {forward(t.triggerId).length === 0
                    ? '—'
                    : forward(t.triggerId).map((f) => (
                        <span key={f.segment} className="block">
                          <SegmentTag segment={f.segment} /> {f.candidates} · {f.wouldTrade} · sel {f.selected} · {f.forwardTrades}/{f.forwardTradesRequired} · {fmt(f.avgGrossR)}/{fmt(f.avgNetR)}R · PF {fmt(f.profitFactor)}
                        </span>
                      ))}
                </td>
                <td className="px-2 py-1.5 text-gray-300 light:text-slate-700 max-w-md">
                  {t.exactRule}
                  <span className="block text-[10px] text-gray-500 light:text-slate-500">Decides: {t.decisionBar}</span>
                  {t.priorEvidence && <span className="block text-[10px] text-amber-400 light:text-amber-700">{t.priorEvidence}</span>}
                </td>
                <td className="px-2 py-1.5 text-gray-400 light:text-slate-600 max-w-xs">{t.stopRule}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {forward('ONE_PER_PARENT').length > 0 && (
        <div className="mt-3 text-[11px] text-gray-300 light:text-slate-700 tabular-nums" title="Each parent move's selected setup only (setup arbitration): what trading one setup per move would have recorded.">
          <span className="font-semibold">One setup per parent move (arbitrated): </span>
          {forward('ONE_PER_PARENT').map((f) => (
            <span key={f.segment} className="mr-3">
              <SegmentTag segment={f.segment} /> {f.candidates} selected · {f.forwardTrades}/{f.forwardTradesRequired} graded · {fmt(f.avgGrossR)}/{fmt(f.avgNetR)}R · PF {fmt(f.profitFactor)}
            </span>
          ))}
        </div>
      )}
      {triggers[0] && <p className="text-[11px] text-gray-500 light:text-slate-500 mt-2">Entry: {triggers[0].entryRule} Target: {triggers[0].targetRule}</p>}
    </Card>
  );
}

// ---------------- Decision ----------------

function DecisionView({ summary, rejections }: { summary: DiagnosticsSummaryRow[]; rejections: import('@/lib/use-signal-diagnostics').DiagnosticsRejectionRow[] }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {summary.map((row) => (
          <Card key={`${row.instrument}:${row.exchange}`} title={`${row.instrument} (${row.exchange})`}>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div><div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Watch</div><div className="font-mono text-gray-300 light:text-slate-700">{row.decision.watch}</div></div>
              <div><div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Detected</div><div className="font-mono text-gray-300 light:text-slate-700">{row.decision.detected}</div></div>
              <div><div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Rejected</div><div className="font-mono text-red-400">{row.decision.rejected}</div></div>
              <div><div className="text-gray-500 light:text-slate-500 text-[10px] uppercase">Traded</div><div className="font-mono text-emerald-400">{row.decision.traded}</div></div>
            </div>
          </Card>
        ))}
      </div>
      <Card title="Rejection-reason distribution" subtitle="Grouped by instrument, event type and reason.">
        {rejections.length === 0 ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No rejections recorded in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
                  <th className="text-left px-2 py-1.5 font-medium">Instrument</th>
                  <th className="text-left px-2 py-1.5 font-medium">Event</th>
                  <th className="text-left px-2 py-1.5 font-medium">Reason</th>
                  <th className="text-right px-2 py-1.5 font-medium">Count</th>
                </tr>
              </thead>
              <tbody>
                {rejections.map((r, i) => (
                  <tr key={i} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{r.instrument} ({r.exchange})</td>
                    <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{r.eventType}</td>
                    <td className="px-2 py-1.5 text-gray-400 light:text-slate-600 max-w-md truncate" title={r.reason ?? ''}>{r.reason ?? '—'}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------- Performance ----------------

function PerformanceHead({ first }: { first: string }) {
  return (
    <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
      <Th align="left">{first}</Th>
      <Th align="left" def={`${DEF.cohortTraded} ${DEF.cohortRejected}`}>Cohort</Th>
      <Th def={DEF.count}>n</Th>
      <Th def={DEF.winRate}>Win %</Th>
      <Th def={DEF.grossR}>Gross R</Th>
      <Th def={DEF.netR}>Net R</Th>
      <Th def={DEF.pf}>PF</Th>
      <Th def={DEF.pfNet}>PF net</Th>
      <Th def={DEF.maxDd}>Max DD R</Th>
      <Th def={DEF.mfe}>Avg MFE R</Th>
      <Th def={DEF.mae}>Avg MAE R</Th>
    </tr>
  );
}

function PerformanceCells({ cohort, p }: { cohort: string; p: DiagnosticsPerformanceStats }) {
  return (
    <>
      <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{cohort}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{p.count}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{pct(p.winRate)}</td>
      <td className={`text-right px-2 py-1.5 tabular-nums font-medium ${rColor(p.grossR)}`}>{fmt(p.grossR)}</td>
      <td className={`text-right px-2 py-1.5 tabular-nums font-medium ${rColor(p.netR)}`}>
        {fmt(p.netR)}
        {p.netCount !== p.count && <span className="text-gray-500 light:text-slate-500 font-normal ml-1">({p.netCount})</span>}
      </td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{fmt(p.profitFactor)}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{fmt(p.profitFactorNet)}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-red-400">{fmt(p.maxDrawdownR)}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{fmt(p.avgMfeR)}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{fmt(p.avgMaeR)}</td>
    </>
  );
}

function PerformanceView({ performance, grades }: { performance: SignalDiagnosticsData['performance']; grades: DiagnosticsGradeRow[] }) {
  return (
    <div className="space-y-4">
      <Card title="Performance by instrument" subtitle="TRADED and REJECTED cohorts are kept apart. R is the underlying stop; every figure is simulated.">
        {performance.byInstrument.length === 0 ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No graded setup_events rows yet. Grading runs after each session.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <PerformanceHead first="Instrument" />
              </thead>
              <tbody>
                {[...performance.byInstrument].sort(bySegmentThenName).map((r) => (
                  <tr key={`${r.instrument}:${r.exchange}:${r.cohort}`} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">
                      <span className="mr-1.5">{r.instrument}</span>
                      <SegmentTag segment={r.segment} />
                    </td>
                    <PerformanceCells cohort={r.cohort} p={r.performance} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {performance.bySegment.length > 0 && (
        <Card title="Segment totals" subtitle="Instruments combined inside INDEX or inside MCX only.">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <PerformanceHead first="Segment" />
              </thead>
              <tbody>
                {[...performance.bySegment].sort((a, b) => a.segment.localeCompare(b.segment) || a.cohort.localeCompare(b.cohort)).map((s) => (
                  <tr key={`${s.segment}:${s.cohort}`} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5">
                      <SegmentTag segment={s.segment} />
                    </td>
                    <PerformanceCells cohort={s.cohort} p={s.performance} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card title="By grade / pool / trigger / instrument" subtitle="Grade bands (A+/A/B/C) are fixed from the score's own component structure, not fitted to outcomes.">
        {grades.length === 0 ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No graded setup_events rows yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
                  <Th align="left">Instrument</Th>
                  <Th align="left">Grade</Th>
                  <Th align="left">Pool</Th>
                  <Th align="left">Trigger</Th>
                  <Th def={DEF.count}>n</Th>
                  <Th def={DEF.winRate}>Win %</Th>
                  <Th>Avg R</Th>
                  <Th def={DEF.grossR}>Sum R</Th>
                  <Th def={DEF.mfe}>Avg MFE R</Th>
                  <Th def={DEF.mae}>Avg MAE R</Th>
                </tr>
              </thead>
              <tbody>
                {grades.map((g, i) => (
                  <tr key={i} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{g.instrument} ({g.exchange})</td>
                    <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{g.grade ?? '—'}</td>
                    <td className="px-2 py-1.5 text-gray-400 light:text-slate-600">{g.poolType ?? '—'}</td>
                    <td className="px-2 py-1.5 text-gray-400 light:text-slate-600">{g.triggerType ?? '—'}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{g.count}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{pct(g.winRate)}</td>
                    <td className={`text-right px-2 py-1.5 tabular-nums font-medium ${rColor(g.avgR)}`}>{fmt(g.avgR)}</td>
                    <td className={`text-right px-2 py-1.5 tabular-nums font-medium ${rColor(g.netR)}`}>{fmt(g.netR)}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{fmt(g.avgMfeR)}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{fmt(g.avgMaeR)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Definitions keys={['cohortTraded', 'cohortRejected', 'count', 'winRate', 'grossR', 'netR', 'pf', 'pfNet', 'maxDd', 'mfe', 'mae']} />
    </div>
  );
}

// ---------------- Cost ----------------

function CostHead({ first }: { first: string }) {
  return (
    <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
      <Th align="left">{first}</Th>
      <Th align="left" def={`${DEF.cohortTraded} ${DEF.cohortRejected}`}>Cohort</Th>
      <Th def={DEF.priced}>Priced (obs/mod)</Th>
      <Th def={DEF.totalCost}>Total cost R</Th>
      <Th def={DEF.avgCost}>Avg cost R</Th>
      <Th def={DEF.costLeakage}>Cost leakage R</Th>
      <Th def={DEF.flipped}>Flipped</Th>
      <Th def={DEF.spreadLeak}>Spread R</Th>
      <Th def={DEF.slippageLeak}>Slippage R</Th>
      <Th def={DEF.chargesLeak}>Charges R</Th>
    </tr>
  );
}

function CostCells({ cohort, c }: { cohort: string; c: DiagnosticsCostStats }) {
  return (
    <>
      <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{cohort}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">
        {c.priced} <span className="text-gray-500 light:text-slate-500">({c.observed}/{c.modelled})</span>
      </td>
      <td className="text-right px-2 py-1.5 tabular-nums text-red-400">{fmt(c.totalCostR)}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{fmt(c.avgCostR, 3)}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{fmt(c.costLeakageR)}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{c.flippedByCost}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{fmt(c.spreadLeakageR)}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{fmt(c.slippageLeakageR)}</td>
      <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{fmt(c.chargesLeakageR)}</td>
    </>
  );
}

function CostView({ performance }: { performance: SignalDiagnosticsData['performance'] }) {
  const anyPriced = performance.byInstrument.some((r) => r.cost.priced > 0);
  return (
    <div className="space-y-4">
      <Card
        title="What costs took"
        subtitle="Measured at the fill from the option leg's live quote (COST-2.0 onward). Spread is observed when the quote is two-sided; slippage and charges come from the cost schedule. Rows without a quote are left out, never filled with a flat estimate."
      >
        {!anyPriced ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No graded rows with a measured cost yet. Costs are recorded from COST-2.0; older rows carry none.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <CostHead first="Instrument" />
              </thead>
              <tbody>
                {[...performance.byInstrument].sort(bySegmentThenName).map((r) => (
                  <tr key={`${r.instrument}:${r.exchange}:${r.cohort}`} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">
                      <span className="mr-1.5">{r.instrument}</span>
                      <SegmentTag segment={r.segment} />
                    </td>
                    <CostCells cohort={r.cohort} c={r.cost} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {anyPriced && (
        <Card title="Segment totals" subtitle="Inside INDEX or inside MCX only.">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <CostHead first="Segment" />
              </thead>
              <tbody>
                {[...performance.bySegment].sort((a, b) => a.segment.localeCompare(b.segment) || a.cohort.localeCompare(b.cohort)).map((s) => (
                  <tr key={`${s.segment}:${s.cohort}`} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5">
                      <SegmentTag segment={s.segment} />
                    </td>
                    <CostCells cohort={s.cohort} c={s.cost} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Definitions keys={['priced', 'totalCost', 'avgCost', 'costLeakage', 'flipped', 'spreadLeak', 'slippageLeak', 'chargesLeak']} />
    </div>
  );
}

// ---------------- Architecture health ----------------

function HealthView({ leakage, census }: { leakage: DiagnosticsLeakageRow[]; census: import('@/lib/use-signal-diagnostics').DiagnosticsCensusRow[] }) {
  return (
    <div className="space-y-4">
      <Card title="Filter leakage" subtitle="Rejected setups that were graded and later reached +2R — the architecture's own filters throwing away trades that would have worked. Unfilled setups are excluded.">
        {leakage.length === 0 ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No graded rejections in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
                  <th className="text-left px-2 py-1.5 font-medium">Instrument</th>
                  <th className="text-left px-2 py-1.5 font-medium">Event</th>
                  <th className="text-right px-2 py-1.5 font-medium">Rejected (graded)</th>
                  <th className="text-right px-2 py-1.5 font-medium">Later hit +2R</th>
                  <th className="text-right px-2 py-1.5 font-medium">Leakage rate</th>
                </tr>
              </thead>
              <tbody>
                {leakage.map((l, i) => (
                  <tr key={i} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{l.instrument} ({l.exchange})</td>
                    <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{l.eventType}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{l.rejectedGraded}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{l.laterHit2R}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{pct(l.leakageRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Daily opportunity census" subtitle="TRADED / DETECTED_BUT_REJECTED / DETECTED_LATE / NEVER_DETECTED, plus correctly-empty days.">
        {census.length === 0 ? (
          <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No census rows in this window.</p>
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px] sticky top-0 bg-gray-900 light:bg-white">
                  <th className="text-left px-2 py-1.5 font-medium">Date</th>
                  <th className="text-left px-2 py-1.5 font-medium">Instrument</th>
                  <th className="text-right px-2 py-1.5 font-medium">Opps</th>
                  <th className="text-right px-2 py-1.5 font-medium">Traded</th>
                  <th className="text-right px-2 py-1.5 font-medium">Rejected</th>
                  <th className="text-right px-2 py-1.5 font-medium">Late</th>
                  <th className="text-right px-2 py-1.5 font-medium">Never</th>
                  <th className="text-right px-2 py-1.5 font-medium" title={DEF.captureRate}>Capture</th>
                  <th className="text-center px-2 py-1.5 font-medium">Empty OK?</th>
                </tr>
              </thead>
              <tbody>
                {census.map((c, i) => (
                  <tr key={i} className="border-t border-gray-800/40 light:border-slate-200">
                    <td className="px-2 py-1.5 text-gray-300 light:text-slate-700">{c.session_date}</td>
                    <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{c.instrument} ({c.exchange})</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{c.opportunities}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-emerald-400">{c.traded}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-red-400">{c.rejected}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{c.late}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{c.never_detected}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">
                      {pct(c.capture_rate)}
                      {c.opportunities > 0 && (
                        <span className="text-gray-500 light:text-slate-500 ml-1">
                          ({c.traded}/{c.opportunities})
                        </span>
                      )}
                    </td>
                    <td className="text-center px-2 py-1.5">{c.correctly_empty ? '✓' : c.opportunities === 0 ? '✗' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------- Filters ----------------

const inputClass =
  'text-xs rounded border border-gray-700 light:border-slate-300 bg-gray-900/60 light:bg-white text-gray-200 light:text-slate-800 px-2 py-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500';

function FilterBar({
  from,
  to,
  instrument,
  strategyVersion,
  costVersion,
  versions,
  onChange,
}: {
  from: string;
  to: string;
  instrument: string;
  strategyVersion: string;
  costVersion: string;
  versions: SignalDiagnosticsData['versions'];
  onChange: (patch: Partial<{ from: string; to: string; instrument: string; strategyVersion: string; costVersion: string }>) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-gray-500 light:text-slate-500">
        From
        <input id="diag-from" type="date" value={from} onChange={(e) => onChange({ from: e.target.value })} className={inputClass} />
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-gray-500 light:text-slate-500">
        To
        <input id="diag-to" type="date" value={to} onChange={(e) => onChange({ to: e.target.value })} className={inputClass} />
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-gray-500 light:text-slate-500">
        Instrument
        <select id="diag-instrument" value={instrument} onChange={(e) => onChange({ instrument: e.target.value })} className={inputClass}>
          <option value="">All, shown separately</option>
          {INSTRUMENTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-gray-500 light:text-slate-500">
        Strategy version
        <select id="diag-strategy-version" value={strategyVersion} onChange={(e) => onChange({ strategyVersion: e.target.value })} className={inputClass}>
          <option value="">All versions</option>
          {versions.strategyVersions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-gray-500 light:text-slate-500">
        Cost version
        <select id="diag-cost-version" value={costVersion} onChange={(e) => onChange({ costVersion: e.target.value })} className={inputClass}>
          <option value="">All versions</option>
          {versions.costVersions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function SignalDiagnosticsPage() {
  const [view, setView] = useState<View>('opportunity');
  const [filters, setFilters] = useState({ from: '', to: '', instrument: '', strategyVersion: '', costVersion: '' });
  const data = useSignalDiagnostics({
    from: filters.from || undefined,
    to: filters.to || undefined,
    instrument: filters.instrument || undefined,
    strategyVersion: filters.strategyVersion || undefined,
    costVersion: filters.costVersion || undefined,
  });
  const { loading, error, summary, rejections, census, grades, leakage, performance, opportunity, versions, majorMoves, triggers, triggerStages, displacementRequiredBy, shadow, refresh } = data;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100 light:text-slate-900">Signal Diagnostics</h2>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            Are we missing good trades because of our architecture? Read-only, simulated paper-trade outcomes only. Instruments are shown separately; INDEX and MCX are never pooled.
          </p>
        </div>
        <button onClick={refresh} className="text-xs px-3 py-1.5 rounded border border-gray-700 light:border-slate-300 text-gray-300 light:text-slate-700 hover:bg-gray-800/60 light:hover:bg-slate-100">
          Refresh
        </button>
      </div>

      <FilterBar {...filters} versions={versions} onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))} />

      <div className="flex gap-1 border-b border-gray-800/60 light:border-slate-200 overflow-x-auto">
        {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px whitespace-nowrap ${
              view === v ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 light:text-slate-500 hover:text-gray-300 light:hover:text-slate-700'
            }`}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>

      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</div>}
      {loading && summary.length === 0 && !error && <p className="text-xs text-gray-500 light:text-slate-500 italic py-4">Loading…</p>}

      {view === 'opportunity' && <OpportunityView opportunity={opportunity} />}
      {view === 'decision' && <DecisionView summary={summary} rejections={rejections} />}
      {view === 'record' && <DecisionRecordView />}
      {view === 'performance' && <PerformanceView performance={performance} grades={grades} />}
      {view === 'cost' && <CostView performance={performance} />}
      {view === 'health' && <HealthView leakage={leakage} census={census} />}
      {view === 'moves' && <MajorMovesView rows={majorMoves} />}
      {view === 'registry' && <RegistryView triggers={triggers} stages={triggerStages} displacementRequiredBy={displacementRequiredBy} shadow={shadow} />}
    </div>
  );
}
