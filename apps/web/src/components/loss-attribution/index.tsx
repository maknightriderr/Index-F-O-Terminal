'use client';

// ============================================================
// LOSS ATTRIBUTION
// ============================================================
// Where do the losing PAPER TRADES come from? Pre-built questions over the
// recorded decisions, grouped by strategy, symbol, direction, strike
// distance, delta, DTE, IV, time of day, regime, signal age, spread, exit
// reason and MFE/MAE — each with its sample size stated.
//
// Read-only. Nothing on this page filters or gates a live setup, and every
// figure is a SIMULATED OUTCOME, not account P&L.
// ============================================================

import React, { useState } from 'react';
import {
  useLossAttribution,
  type LossAttributionScope,
  type AttributionGroup,
  type AttributionReport,
  type AttributionQuestionAnswer,
  type ShadowComparison,
} from '@/lib/use-loss-attribution';

type View = 'questions' | 'exits' | 'dead' | 'split' | 'gates' | 'branch' | 'exposure' | 'shadow';

const VIEW_LABELS: Record<View, string> = {
  questions: 'Questions',
  exits: 'Exit Reasons',
  dead: 'Dead Trades',
  split: 'In / Out of Sample',
  gates: 'Gate Diagnostics',
  branch: 'Close Branch',
  exposure: 'Exposure',
  shadow: 'Shadow vs Live',
};

const SCOPE_LABELS: Record<LossAttributionScope, string> = {
  TAKE: 'Paper trades',
  REFUSE: 'Refusals (hypothetical)',
  ALL: 'All decisions',
};

const EXIT_KEYS = ['TARGET', 'STOP', 'TIME_EXIT', 'INVALIDATED', 'EXPIRY', 'MANUAL_TEST_EXIT', 'OTHER'] as const;

function fmt(v: number | null | undefined, d = 2): string {
  return v == null ? '—' : v.toFixed(d);
}

function SampleBadge({ sample }: { sample: string }) {
  const cls =
    sample === 'ADEQUATE'
      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40 light:bg-emerald-100 light:text-emerald-700 light:border-emerald-300'
      : sample === 'LOW'
        ? 'bg-amber-500/15 text-amber-400 border-amber-500/40 light:bg-amber-100 light:text-amber-700 light:border-amber-300'
        : 'bg-red-500/15 text-red-400 border-red-500/40 light:bg-red-100 light:text-red-700 light:border-red-300';
  return <span className={`inline-block px-1.5 py-0.5 text-[10px] font-mono uppercase border rounded ${cls}`}>{sample}</span>;
}

function rColor(v: number | null | undefined): string {
  if (v == null) return 'text-gray-400 light:text-slate-500';
  return v > 0 ? 'text-emerald-400 light:text-emerald-600' : v < 0 ? 'text-red-400 light:text-red-600' : 'text-gray-300 light:text-slate-700';
}

function GroupTable({ groups, keyLabel = 'Group' }: { groups: AttributionGroup[]; keyLabel?: string }) {
  if (!groups || groups.length === 0) {
    return <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No graded rows in this group yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
            <th className="text-left px-2 py-1.5 font-medium">{keyLabel}</th>
            <th className="text-right px-2 py-1.5 font-medium">n</th>
            <th className="text-left px-2 py-1.5 font-medium">Sample</th>
            <th className="text-right px-2 py-1.5 font-medium">Win %</th>
            <th className="text-right px-2 py-1.5 font-medium" title="Simulated R on the underlying replay">Avg sim R</th>
            <th className="text-right px-2 py-1.5 font-medium" title="Simulated R on the underlying replay">Total sim R</th>
            <th className="text-right px-2 py-1.5 font-medium" title="Gross option-premium R of the paper close (recorded from Phase 1 onward)">Premium R (n)</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-t border-gray-800/40 light:border-slate-200">
              <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{g.key}</td>
              <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{g.n}</td>
              <td className="px-2 py-1.5"><SampleBadge sample={g.sample} /></td>
              <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{fmt(g.winRate, 1)}</td>
              <td className={`text-right px-2 py-1.5 tabular-nums font-medium ${rColor(g.avgSimR)}`}>{fmt(g.avgSimR)}</td>
              <td className={`text-right px-2 py-1.5 tabular-nums font-medium ${rColor(g.totalSimR)}`}>{fmt(g.totalSimR)}</td>
              <td className={`text-right px-2 py-1.5 tabular-nums ${rColor(g.premiumR?.avg)}`}>
                {fmt(g.premiumR?.avg)} <span className="text-gray-500 light:text-slate-500">({g.premiumR?.n ?? 0})</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExitMixTable({ groups }: { groups: AttributionGroup[] }) {
  if (!groups || groups.length === 0) {
    return <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No graded rows yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
            <th className="text-left px-2 py-1.5 font-medium">Group</th>
            <th className="text-right px-2 py-1.5 font-medium">n</th>
            {EXIT_KEYS.map((k) => (
              <th key={k} className="text-right px-2 py-1.5 font-medium">{k.replace(/_/g, ' ')} %</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-t border-gray-800/40 light:border-slate-200">
              <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{g.key}</td>
              <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{g.n}</td>
              {EXIT_KEYS.map((k) => (
                <td key={k} className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{fmt(g.exitReasonPct?.[k], 1)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="border border-gray-800/60 light:border-slate-200 rounded-xl bg-[#12121a] light:bg-white p-3 space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-gray-200 light:text-slate-800">{title}</h2>
        {subtitle && <p className="text-[11px] text-gray-500 light:text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

const TH = 'text-right px-2 py-1.5 font-medium';
const TD = 'text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700';

function ShadowTable({ head, rows }: { head: string[]; rows: Array<{ key: string; n: number; sample: string; cells: string[] }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
            <th className="text-left px-2 py-1.5 font-medium">DTE bucket</th>
            <th className={TH}>n</th>
            <th className="text-left px-2 py-1.5 font-medium">Sample</th>
            {head.map((h) => (
              <th key={h} className={TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-gray-800/40 light:border-slate-200">
              <td className="px-2 py-1.5 font-medium text-gray-200 light:text-slate-800">{r.key}</td>
              <td className="text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-600">{r.n}</td>
              <td className="px-2 py-1.5"><SampleBadge sample={r.sample} /></td>
              {r.cells.map((c, i) => (
                <td key={i} className={TD}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShadowComparisonView({ shadow }: { shadow: ShadowComparison | null }) {
  if (!shadow) {
    return <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">Shadow comparison unavailable from this backend.</p>;
  }
  const withN = (avg: number | null, n: number) => `${fmt(avg)} (${n})`;
  return (
    <div className="space-y-3">
      <Card title="Shadow models vs the live engine" subtitle={shadow.note}>
        <p className="text-[11px] text-gray-400 light:text-slate-600">{shadow.population.rows} taken paper trades carry shadow data.</p>
        <ul className="list-disc pl-4 text-[11px] text-gray-400 light:text-slate-600 space-y-0.5">
          {shadow.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Card>
      <Card title="Strike — candidate scorer vs live ATM pick" subtitle="Live premium R split by whether the shadow pick agreed. That is a split of LIVE outcomes, not what the shadow strike would have earned.">
        <ShadowTable
          head={['Differs', 'Differs %', 'Live R agreed (n)', 'Live R differed (n)']}
          rows={[shadow.strike.overall, ...shadow.strike.byDte].map((g) => ({
            key: g.key,
            n: g.n,
            sample: g.sample,
            cells: [String(g.differs), fmt(g.differsPct, 1), withN(g.livePremiumRWhenAgreed.avg, g.livePremiumRWhenAgreed.n), withN(g.livePremiumRWhenDiffered.avg, g.livePremiumRWhenDiffered.n)],
          }))}
        />
      </Card>
      <Card title="Execution — ask entry (shadow) vs mid entry (live)" subtitle="Same stop and target. DEGRADED = no reliable bid/ask, entry fell back to LTP. Shadow net R is a conservative lower bound.">
        <ShadowTable
          head={['Degraded', 'Live net R', 'Shadow net R', 'R delta', 'Slippage %']}
          rows={[shadow.execution.overall, ...shadow.execution.byDte].map((g) => ({
            key: g.key,
            n: g.n,
            sample: g.sample,
            cells: [String(g.degraded), fmt(g.avgLiveNetR), fmt(g.avgShadowNetR), fmt(g.avgNetRDelta), fmt(g.avgEntrySlippagePct)],
          }))}
        />
      </Card>
      <Card title="Target — gamma/theta v2 (shadow) vs delta-only (live)" subtitle="Hit rates are of the LIVE target among closed live trades, split by where v2 sat.">
        <ShadowTable
          head={['Div pts', 'Div % entry', 'v2 < live %', 'v2 net R', 'Live net R', 'Hit % v2<live (n)', 'Hit % v2≥live (n)']}
          rows={[shadow.target.overall, ...shadow.target.byDte].map((g) => ({
            key: g.key,
            n: g.n,
            sample: g.sample,
            cells: [
              fmt(g.avgDivergencePts),
              fmt(g.avgDivergencePctOfEntry),
              fmt(g.v2BelowLivePct, 1),
              fmt(g.avgShadowExpectedNetRV2),
              fmt(g.avgLiveNetR),
              `${fmt(g.liveTargetHitRate.v2Below.pct, 1)} (${g.liveTargetHitRate.v2Below.n})`,
              `${fmt(g.liveTargetHitRate.v2AtOrAbove.pct, 1)} (${g.liveTargetHitRate.v2AtOrAbove.n})`,
            ],
          }))}
        />
      </Card>
    </div>
  );
}

function questionById(report: AttributionReport | null, id: string): AttributionQuestionAnswer | null {
  return report?.questions?.find((q: AttributionQuestionAnswer) => q.id === id) ?? null;
}

export function LossAttributionPage() {
  const [scope, setScope] = useState<LossAttributionScope>('TAKE');
  const [view, setView] = useState<View>('questions');
  const { report, split, gates, shadow, loading, isLive, error, refresh } = useLossAttribution(scope);

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="max-w-3xl">
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">Loss Attribution</h1>
          <p className="text-xs text-gray-400 light:text-slate-600 mt-0.5">
            Where the losing PAPER TRADES come from. Every figure is a SIMULATED OUTCOME — no order was placed and nothing here is account P&amp;L.
            Read-only: this page filters and gates nothing. Sample size is stated per group; ADEQUATE means enough rows to read, not statistical significance.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-0.5 bg-gray-800/60 light:bg-slate-200/60 rounded-lg p-0.5" role="group" aria-label="Population">
            {(Object.keys(SCOPE_LABELS) as LossAttributionScope[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                aria-pressed={scope === s}
                className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${scope === s ? 'bg-emerald-500/20 text-emerald-300 light:text-emerald-700' : 'text-gray-400 light:text-slate-600 hover:text-gray-200'}`}
              >
                {SCOPE_LABELS[s]}
              </button>
            ))}
          </div>
          <button type="button" onClick={refresh} className="px-2.5 py-1 text-[11px] rounded-md border border-gray-700 light:border-slate-300 text-gray-300 light:text-slate-700 hover:bg-gray-800/40 light:hover:bg-slate-100">
            Refresh
          </button>
        </div>
      </div>

      {!isLive && !loading && (
        <div className="border border-red-500/40 bg-red-500/10 text-red-300 light:text-red-700 rounded-lg px-3 py-2 text-xs">
          Backend unreachable ({error ?? 'unknown error'}) — this is not the same as &quot;no losses&quot;.
        </div>
      )}

      <div className="flex items-center gap-1 flex-wrap border-b border-gray-800/60 light:border-slate-200 pb-1">
        {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`px-3 py-1.5 text-xs rounded-t-md ${view === v ? 'text-emerald-300 light:text-emerald-700 border-b-2 border-emerald-400' : 'text-gray-400 light:text-slate-600 hover:text-gray-200'}`}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>

      {loading && !report ? (
        <p className="text-xs text-gray-500 light:text-slate-500">Loading…</p>
      ) : (
        <>
          {report && (
            <p className="text-[11px] text-gray-500 light:text-slate-500">
              {report.population?.rows ?? 0} graded decisions · {report.population?.from ? new Date(report.population.from).toLocaleDateString('en-IN') : '—'} → {report.population?.to ? new Date(report.population.to).toLocaleDateString('en-IN') : '—'}
            </p>
          )}

          {view === 'questions' && report && (
            <div className="space-y-3">
              <Card title="Overall" subtitle="All graded decisions in scope.">
                <GroupTable groups={report.overall ? [report.overall] : []} />
              </Card>
              {report.questions?.map((q: AttributionQuestionAnswer) => (
                <Card key={q.id} title={`${q.id}. ${q.question}`} subtitle={`Grouped by ${q.dimension}. Worst total first.`}>
                  <GroupTable groups={q.groups} />
                </Card>
              ))}
              <Card title="MAE — how far trades went against the thesis">
                <GroupTable groups={report.mae ?? []} />
              </Card>
            </div>
          )}

          {view === 'exits' && report && (
            <div className="space-y-3">
              <Card title="Exit reasons — overall" subtitle="How the simulated underlying replay resolved: target, stop, or the horizon running out.">
                <ExitMixTable groups={report.overall ? [report.overall] : []} />
              </Card>
              {['Q1', 'Q2', 'Q6', 'Q5', 'Q9'].map((id) => {
                const q = questionById(report, id);
                return q ? (
                  <Card key={id} title={`Exit reasons — by ${q.dimension}`}>
                    <ExitMixTable groups={q.groups} />
                  </Card>
                ) : null;
              })}
            </div>
          )}

          {view === 'dead' && report?.deadTrades && (
            <Card title="Trades flagged dead by trade health" subtitle={report.deadTrades.note}>
              <GroupTable groups={[report.deadTrades.flaggedDead, report.deadTrades.neverFlagged]} />
              <p className="text-xs text-gray-400 light:text-slate-600">
                Recovered (premium close above zero) after being flagged dead: <span className="font-semibold">{fmt(report.deadTrades.recoveredPct, 1)}%</span>
              </p>
              <ExitMixTable groups={[report.deadTrades.flaggedDead, report.deadTrades.neverFlagged]} />
            </Card>
          )}

          {view === 'split' && split && (
            <div className="space-y-3">
              <Card title={`Split at ${new Date(split.splitAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`} subtitle={split.splitReason}>
                <p className="text-xs text-gray-400 light:text-slate-600">
                  A difference between the two halves on INSUFFICIENT or LOW groups is not evidence of anything.
                </p>
              </Card>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {[
                  { label: 'In-sample (before cutover)', r: split.inSample },
                  { label: 'Out-of-sample (after cutover)', r: split.outOfSample },
                ].map(({ label, r }) => (
                  <div key={label} className="space-y-3">
                    <Card title={label} subtitle={`${r?.population?.rows ?? 0} graded decisions`}>
                      <GroupTable groups={r?.overall ? [r.overall] : []} />
                    </Card>
                    {r?.questions?.map((q: AttributionQuestionAnswer) => (
                      <Card key={q.id} title={`${q.id}. ${q.question}`}>
                        <GroupTable groups={q.groups} />
                      </Card>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'branch' && report && (
            <Card
              title="Which close branch fired"
              subtitle="Premium stop/target is checked first and unconditionally; the underlying bias-reversal branch only runs if it did not fire. Labelled from Phase 2 onward — earlier rows show as NOT_RECORDED."
            >
              <GroupTable groups={report.invalidation ?? []} keyLabel="Close branch" />
            </Card>
          )}

          {view === 'exposure' && report && (
            <Card title="Concurrent paper exposure at creation" subtitle={report.exposure?.note ?? 'Recorded from Phase 2 onward.'}>
              <GroupTable groups={report.exposure?.sameDirection ?? []} keyLabel="Same direction" />
              <GroupTable groups={report.exposure?.correlated ?? []} keyLabel="Correlated index" />
            </Card>
          )}

          {view === 'shadow' && <ShadowComparisonView shadow={shadow} />}

          {view === 'gates' && (
            <Card
              title="Gate diagnostics"
              subtitle="Every gate evaluated independently for each recorded decision. 'Also failed' counts refusals where this gate would ALSO have refused but an earlier gate decided. Observation only — the live chain is unchanged."
            >
              {gates.length === 0 ? (
                <p className="text-xs text-gray-500 light:text-slate-500 italic py-2">No gate diagnostics recorded yet — they are written from Phase 1 onward.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-400 light:text-slate-600 uppercase tracking-wider text-[10px]">
                        <th className="text-left px-2 py-1.5 font-medium">Gate</th>
                        <th className="text-right px-2 py-1.5 font-medium">Pass</th>
                        <th className="text-right px-2 py-1.5 font-medium">Fail</th>
                        <th className="text-right px-2 py-1.5 font-medium">Not evaluated</th>
                        <th className="text-right px-2 py-1.5 font-medium">Deciding</th>
                        <th className="text-right px-2 py-1.5 font-medium">Also failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gates.map((g) => (
                        <tr key={g.gate} className="border-t border-gray-800/40 light:border-slate-200">
                          <td className="px-2 py-1.5 font-mono text-gray-200 light:text-slate-800">{g.gate}</td>
                          <td className="text-right px-2 py-1.5 tabular-nums text-emerald-400">{g.pass}</td>
                          <td className="text-right px-2 py-1.5 tabular-nums text-red-400">{g.fail}</td>
                          <td className="text-right px-2 py-1.5 tabular-nums text-gray-400">{g.notEvaluated}</td>
                          <td className="text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700">{g.decidingCount}</td>
                          <td className="text-right px-2 py-1.5 tabular-nums text-amber-400">{g.failedButNotDeciding}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
