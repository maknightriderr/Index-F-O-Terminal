'use client';

// ============================================================
// SIGNAL DIAGNOSTICS — Signal Engine (slot behaviour + forward validation)
// ============================================================
// What the slot did with its candidates (NO TRADE rate, fallback success,
// candidates rejected for theta / cost and for liquidity, missed
// opportunities) and how the engine's predictions held up afterwards
// (expected vs actual option payoff, strike selection, evidence-count
// ranking). Read-only; simulated paper-trade outcomes only.
// ============================================================

import React, { useEffect, useState } from 'react';
import { api, type DiagnosticsFilter } from '@/lib/api';
import { OrderFlowPanel } from './order-flow-panel';

/** Mirrors apps/server/src/services/signal-engine-metrics.ts signalEngineMetrics(). */
export interface SignalEngineMetrics {
  note: string;
  slot: {
    bars: number;
    minted: number;
    noTrade: number;
    noCandidate: number;
    noTradeRate: number | null;
    candidates: number;
    rejectedCandidates: number;
    rejections: Record<'thetaCost' | 'liquidity' | 'other', { n: number; shareOfCandidates: number | null; shareOfRejections: number | null }>;
    topRejectionCodes: Array<{ code: string; n: number }>;
    noTradeLimitingStages: Record<string, number>;
    fallback: { needed: number; succeeded: number; successRate: number | null; mintedBelowFirst: number };
  };
  strikes: { plans: number; strikesEvaluated: number; thetaCost: number; liquidity: number; thetaCostRate: number | null; liquidityRate: number | null; byStage: Record<string, number> };
  missedOpportunities: { days: number; opportunities: number; traded: number; late: number; detectedButRejected: number; neverDetected: number; missed: number; missedRate: number | null };
  forward: {
    optionPayoff: { n: number; avgProjectedGainPct: number | null; avgRealisedPct: number | null; avgMaxGainPct: number | null; targetReachedRate: number | null; avgProjectionCaptured: number | null; avgProjectedTheta: number | null };
    strikeSelection: { n: number; selectedWasBestRate: number | null; avgSelectedReturnR: number | null; avgBestReturnR: number | null; avgRejectedReturnR: number | null; avgRankVsRealised: number | null };
    evidenceRank: {
      n: number;
      topWasBestRate: number | null;
      avgTopR: number | null;
      avgRankVsRealised: number | null;
      avgConfirmationsVsRealised: number | null;
      byConfirmations: Record<string, { n: number; avgR: number | null; targetRate: number | null; stopRate: number | null }>;
    };
  };
  truncated: boolean;
}

type EntryRuleStats = { measured: number; skipped: number; skippedNetPerTrade: number | null; keptNetPerTrade: number | null; totalNetWithRule: number; improvementTotalNet: number };
type EntryBlock = { trades: number; baselineNetPerTrade: number | null; baselineTotalNet: number; rules: Record<string, EntryRuleStats> };

/** Mirrors apps/server/src/services/signal-engine-metrics.ts shadowRulesReport(). */
export interface ShadowRulesReport {
  note: string;
  version: string;
  params: Record<string, number>;
  registeredAt?: number;
  entry: { sinceRegistered?: EntryBlock; all: EntryBlock; sinceArchitectureChange: EntryBlock };
  exit: {
    trades: number;
    baselineNetPerTrade: number | null;
    rules: Record<string, { fired: number; netPerTradeWithRule: number | null; firedActualNetPerTrade: number | null; firedRuleNetPerTrade: number | null }>;
  };
}

const ENTRY_RULE_TEXT: Record<string, string> = {
  COST_EDGE_2X: 'Skip when the target gain is under 2× the round-trip cost',
  MCX_EVENING: 'Skip MCX entries from 18:00 IST',
  RICH_IV: 'Skip entries with rich implied volatility',
};
const EXIT_RULE_TEXT: Record<string, string> = {
  TIME_STOP_60: 'Exit at 60 min if the premium is below entry',
  BREAKEVEN_AT_HALF: 'Stop to entry once half the target distance is reached',
};
const signedPct = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const tone = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'text-emerald-400 light:text-emerald-700' : v < 0 ? 'text-red-400 light:text-red-700' : '');

/** Pre-registered shadow experiments: what each candidate rule would have done to the trades the system actually made. */
export function ShadowRulesPanel({ filter }: { filter: DiagnosticsFilter }) {
  const [data, setData] = useState<ShadowRulesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(filter);
  useEffect(() => {
    let cancelled = false;
    api
      .getShadowRules(filter)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(e?.message ?? 'Could not load the shadow experiments.'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (error) return <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</div>;
  if (!data) return null;
  const entryRows = (b: EntryBlock) =>
    Object.entries(b.rules).map(([rule, r]) => [
      ENTRY_RULE_TEXT[rule] ?? rule,
      `${r.skipped} of ${r.measured}`,
      <span key="s" className={tone(r.skippedNetPerTrade)}>{signedPct(r.skippedNetPerTrade)}</span>,
      <span key="k" className={tone(r.keptNetPerTrade)}>{signedPct(r.keptNetPerTrade)}</span>,
      <span key="i" className={tone(r.improvementTotalNet)}>{signedPct(r.improvementTotalNet)}</span>,
    ]);
  const head = ['Rule', 'Would skip', 'Skipped: net / trade', 'Kept: net / trade', 'Change in total net'];
  return (
    <Block
      title="Shadow experiments"
      subtitle={`${data.version}. Candidate rules fixed in advance and measured on the trades the system actually made — none of them changes what it trades. A rule is considered for live use only after 30+ forward trades show a material gain.`}
    >
      {data.entry.sinceRegistered && (
        <div className="space-y-1">
          <h4 className={`text-[11px] uppercase tracking-wide ${muted}`}>
            Entry filters — fair test: trades after the rules were registered ({data.entry.sinceRegistered.trades} closed trades, baseline {signedPct(data.entry.sinceRegistered.baselineNetPerTrade)} / trade)
          </h4>
          <Rows head={head} rows={entryRows(data.entry.sinceRegistered)} />
        </div>
      )}
      <p className={`text-[11px] ${muted}`}>
        The two tables below are in sample: the cost-edge, MCX-evening and rich-IV filters were suggested by these same trades, so their improvement there is overstated. Judge the rules on the fair test above.
      </p>
      <div className="space-y-1">
        <h4 className={`text-[11px] uppercase tracking-wide ${muted}`}>Entry filters — since the 5 Oct change ({data.entry.sinceArchitectureChange.trades} closed trades, baseline {signedPct(data.entry.sinceArchitectureChange.baselineNetPerTrade)} / trade)</h4>
        <Rows head={head} rows={entryRows(data.entry.sinceArchitectureChange)} />
      </div>
      <div className="space-y-1">
        <h4 className={`text-[11px] uppercase tracking-wide ${muted}`}>Entry filters — all history ({data.entry.all.trades} closed trades, baseline {signedPct(data.entry.all.baselineNetPerTrade)} / trade)</h4>
        <Rows head={head} rows={entryRows(data.entry.all)} />
      </div>
      <div className="space-y-1">
        <h4 className={`text-[11px] uppercase tracking-wide ${muted}`}>Exit rules — {data.exit.trades} trades with recorded option marks (baseline {signedPct(data.exit.baselineNetPerTrade)} / trade)</h4>
        <Rows
          head={['Rule', 'Fired on', 'Net / trade with rule', 'Those trades: actual', 'Those trades: with rule']}
          rows={Object.entries(data.exit.rules).map(([rule, r]) => [
            EXIT_RULE_TEXT[rule] ?? rule,
            r.fired,
            <span key="w" className={tone(r.netPerTradeWithRule)}>{signedPct(r.netPerTradeWithRule)}</span>,
            <span key="a" className={tone(r.firedActualNetPerTrade)}>{signedPct(r.firedActualNetPerTrade)}</span>,
            <span key="r" className={tone(r.firedRuleNetPerTrade)}>{signedPct(r.firedRuleNetPerTrade)}</span>,
          ])}
        />
      </div>
    </Block>
  );
}

/** Mirrors apps/server/src/services/full-replay.ts FullReplayReport. */
export interface FullReplayReport {
  snapshotId: string;
  status: 'MATCH' | 'DIFFERENT' | 'DIVERGED' | 'NO_TAPE' | 'NOT_FOUND';
  diff: string[];
  divergences: string[];
  error: string | null;
  effects: { live: number; replay: number; onlyLive: string[]; onlyReplay: string[] };
  replayed: { available: boolean | null; noTradeCode: string | null; strategy: string | null; strike: number | null; limitingFactor: string | null };
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toFixed(d));
const muted = 'text-gray-500 light:text-slate-500';

function Block({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="bg-gray-900/40 light:bg-white border border-gray-800/60 light:border-slate-200 rounded-lg p-4 space-y-3">
      <header>
        <h3 className="text-sm font-semibold text-gray-200 light:text-slate-800">{title}</h3>
        {subtitle && <p className={`text-[11px] ${muted}`}>{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className={`text-[10px] uppercase tracking-wide ${muted}`}>{label}</div>
      <div className="text-base font-semibold tabular-nums text-gray-100 light:text-slate-900">{value}</div>
      {hint && <div className={`text-[10px] ${muted}`}>{hint}</div>}
    </div>
  );
}

const grid = 'grid grid-cols-2 sm:grid-cols-4 gap-3';

function Rows({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (rows.length === 0) return <p className={`text-xs italic ${muted}`}>Nothing recorded in this range yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className={muted}>
            {head.map((h) => (
              <th key={h} className="text-left font-medium py-1 pr-3 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="text-gray-300 light:text-slate-700">
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-800/60 light:border-slate-100">
              {r.map((c, j) => (
                <td key={j} className="py-1 pr-3 whitespace-nowrap">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SignalEnginePanel({ filter }: { filter: DiagnosticsFilter }) {
  const [data, setData] = useState<SignalEngineMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(filter);

  useEffect(() => {
    let cancelled = false;
    api
      .getSignalEngineMetrics(filter)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(e?.message ?? 'Could not load the signal engine metrics.'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (error) return <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</div>;
  if (!data) return <p className={`text-xs italic py-4 ${muted}`}>Loading…</p>;
  const { slot, strikes, missedOpportunities: miss, forward } = data;

  return (
    <div className="space-y-3">
      <p className={`text-[11px] ${muted}`}>{data.note}{data.truncated ? ' Showing the most recent 20,000 rows of a table — narrow the dates for the full range.' : ''}</p>

      <Block title="The slot" subtitle="Each decision bar whose slot was free: one row per bar (a bar that minted counts as minted once). A bar held by an open trade is not a decision.">
        <div className={grid}>
          <Stat label="Decision bars" value={slot.bars} hint={`${slot.noCandidate} with no candidate`} />
          <Stat label="Minted" value={slot.minted} hint={`${slot.fallback.mintedBelowFirst} from below #1`} />
          <Stat label="NO TRADE rate" value={pct(slot.noTradeRate)} hint={`${slot.noTrade} of ${slot.minted + slot.noTrade} bars with a candidate`} />
          <Stat label="Fallback success" value={pct(slot.fallback.successRate)} hint={`${slot.fallback.succeeded} of ${slot.fallback.needed} bars where #1 failed its final check`} />
        </div>
      </Block>

      <Block title="Why candidates were rejected" subtitle="Candidate level: each candidate the slot could not trade. Strike level: each strike the option plans rejected, by the stage it failed.">
        <div className={grid}>
          <Stat label="Theta / cost" value={slot.rejections.thetaCost.n} hint={`${pct(slot.rejections.thetaCost.shareOfCandidates)} of ${slot.candidates} candidates`} />
          <Stat label="Liquidity" value={slot.rejections.liquidity.n} hint={`${pct(slot.rejections.liquidity.shareOfCandidates)} of candidates`} />
          <Stat label="Strikes: theta / cost" value={strikes.thetaCost} hint={`${pct(strikes.thetaCostRate)} of ${strikes.strikesEvaluated} strikes`} />
          <Stat label="Strikes: liquidity" value={strikes.liquidity} hint={`${pct(strikes.liquidityRate)} of strikes`} />
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Rows head={['Refusal code', 'Candidates']} rows={slot.topRejectionCodes.map((r) => [r.code, r.n])} />
          <Rows
            head={['NO TRADE limited by', 'Bars']}
            rows={Object.entries(slot.noTradeLimitingStages)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => [k, v])}
          />
        </div>
      </Block>

      <Block title="Missed opportunities" subtitle="From the opportunity census: moves of 2R before 1R the engines could have traded.">
        <div className={grid}>
          <Stat label="Opportunities" value={miss.opportunities} hint={`${miss.days} session-days`} />
          <Stat label="Traded" value={miss.traded} hint={`${miss.late} late`} />
          <Stat label="Missed" value={miss.missed} hint={`${pct(miss.missedRate)} of opportunities`} />
          <Stat label="Never detected" value={miss.neverDetected} hint={`${miss.detectedButRejected} detected but rejected`} />
        </div>
      </Block>

      <Block title="Expected vs actual option payoff" subtitle="OPTION-2.0. The theta-adjusted target each closed paper trade was built with, against the premium its contract showed at each recorded bar until the exit.">
        <div className={grid}>
          <Stat label="Trades graded" value={forward.optionPayoff.n} />
          <Stat label="Projected gain" value={pct(forward.optionPayoff.avgProjectedGainPct)} hint={`theta over the hold ${num(forward.optionPayoff.avgProjectedTheta)} pts`} />
          <Stat label="Best gain seen" value={pct(forward.optionPayoff.avgMaxGainPct)} hint={`realised ${pct(forward.optionPayoff.avgRealisedPct)}`} />
          <Stat label="Target reached" value={pct(forward.optionPayoff.targetReachedRate)} hint={`${num(forward.optionPayoff.avgProjectionCaptured)}× of the projection on average`} />
        </div>
      </Block>

      <Block title="Strike selection" subtitle="OPTSEL-2.0. Every strike a plan ranked, marked to the chain at the trade's exit. Rank agreement: +1 = the ranking ordered realised R perfectly, 0 = no better than chance.">
        <div className={grid}>
          <Stat label="Trades graded" value={forward.strikeSelection.n} />
          <Stat label="Selected was best" value={pct(forward.strikeSelection.selectedWasBestRate)} />
          <Stat label="Selected / best R" value={`${num(forward.strikeSelection.avgSelectedReturnR)} / ${num(forward.strikeSelection.avgBestReturnR)}`} hint={`rejected strikes ${num(forward.strikeSelection.avgRejectedReturnR)} R`} />
          <Stat label="Rank agreement" value={num(forward.strikeSelection.avgRankVsRealised)} />
        </div>
      </Block>

      <ShadowRulesPanel filter={filter} />

      <OrderFlowPanel filter={filter} />

      <Block title="Evidence-count ranking" subtitle="ARB-2.0. Every arbitrated candidate graded on its own stop and objective over the rest of its session (a bar touching both counts the stop).">
        <div className={grid}>
          <Stat label="Decisions graded" value={forward.evidenceRank.n} />
          <Stat label="Top-ranked was best" value={pct(forward.evidenceRank.topWasBestRate)} hint={`top candidate ${num(forward.evidenceRank.avgTopR)} R`} />
          <Stat label="Rank agreement" value={num(forward.evidenceRank.avgRankVsRealised)} />
          <Stat label="Confirmations vs R" value={num(forward.evidenceRank.avgConfirmationsVsRealised)} hint="rank correlation" />
        </div>
        <Rows
          head={['Confirmations', 'Candidates', 'Avg R', 'Reached objective', 'Stopped']}
          rows={Object.entries(forward.evidenceRank.byConfirmations).map(([k, b]) => [k, b.n, num(b.avgR), pct(b.targetRate), pct(b.stopRate)])}
        />
      </Block>
    </div>
  );
}

const STATUS_STYLE: Record<FullReplayReport['status'], string> = {
  MATCH: 'text-emerald-400 light:text-emerald-700',
  DIFFERENT: 'text-amber-400 light:text-amber-700',
  DIVERGED: 'text-orange-400 light:text-orange-700',
  NO_TAPE: 'text-gray-400 light:text-slate-500',
  NOT_FOUND: 'text-gray-400 light:text-slate-500',
};

/** The full replay's report, for the Decision Record view. */
export function FullReplayResult({ report }: { report: FullReplayReport }) {
  const r = report.replayed;
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');
  return (
    <Block title="Full replay" subtitle="The whole decision path — indicators, safety gates, option build, arbitration, settlement — re-run at the poll's instant from its recorded inputs only. No network, no writes.">
      <div className={grid}>
        <Stat label="Result" value={<span className={STATUS_STYLE[report.status]}>{report.status}</span>} />
        <Stat label="Replayed decision" value={r.available ? `${r.strategy ?? 'TRADE'} ${r.strike ?? ''}` : r.noTradeCode ?? 'NO TRADE'} hint={r.limitingFactor ?? undefined} />
        <Stat label="Writes (live / replay)" value={`${report.effects.live} / ${report.effects.replay}`} />
        <Stat label="Unrecorded reads" value={report.divergences.length} />
      </div>
      <dl className="text-xs grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className={muted}>Result differences</dt>
        <dd className="text-gray-300 light:text-slate-700 break-words">{list(report.diff)}</dd>
        <dt className={muted}>Writes only live</dt>
        <dd className="text-gray-300 light:text-slate-700 break-words">{list(report.effects.onlyLive)}</dd>
        <dt className={muted}>Writes only in replay</dt>
        <dd className="text-gray-300 light:text-slate-700 break-words">{list(report.effects.onlyReplay)}</dd>
        {report.divergences.length > 0 && (
          <>
            <dt className={muted}>Unrecorded reads</dt>
            <dd className="text-gray-300 light:text-slate-700 break-all">{report.divergences.slice(0, 5).join(' · ')}</dd>
          </>
        )}
        {report.error && (
          <>
            <dt className={muted}>Error</dt>
            <dd className="text-red-400 break-words">{report.error}</dd>
          </>
        )}
      </dl>
    </Block>
  );
}
