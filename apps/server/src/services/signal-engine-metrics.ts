// ============================================================
// SIGNAL ENGINE METRICS — the slot's behaviour and forward validation
// ============================================================
// Read-only aggregates for the Signal Diagnostics page:
//   * candidates rejected for theta / cost, and for liquidity — at the slot
//     (candidate level) and inside the option plans (strike level);
//   * fallback success: of the bars whose best-ranked candidate failed its
//     final check, the share that still minted the next-best;
//   * the NO TRADE rate (over bars whose slot was free and had a candidate);
//   * missed opportunities (the opportunity census);
//   * expected vs actual option payoff, strike selection and evidence-count
//     ranking (forward_outcomes).
// Paper / simulated figures only; per instrument when filtered, otherwise all.
// ============================================================

import { sql } from '../lib/db.js';
import type { DiagnosticsQuery } from './signal-diagnostics.js';
import { ESTIMATED_ROUND_TRIP_COST_PCT, type TradeSetupRecord } from '@fno/shared';
import { getTradeSetupHistory } from './backtesting.js';
import { SHADOW_PARAMS, SHADOW_RULES_VERSION, aggregateEntryRules, aggregateExitRules, entryFlags, type EntryRuleTrade } from './shadow-rules.js';

/** Option-plan stages that are time decay / cost, and that are liquidity (OptionCandidate.rejectedAt). */
export const STRIKE_THETA_COST_STAGES: ReadonlySet<string> = new Set(['TARGET_POTENTIAL', 'PREMIUM_RISK', 'NET_RR']);
export const STRIKE_LIQUIDITY_STAGES: ReadonlySet<string> = new Set(['AVAILABILITY', 'LIQUIDITY', 'SPREAD']);

const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
const avg = (xs: readonly number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export interface SlotDecisionAggRow {
  symbol: string;
  exchange: string;
  mode: string;
  decision_bar_time: Date | string;
  outcome: string;
  candidates: number;
  fellthrough: number;
  pre_mint_failures: number;
  limiting_stage: string | null;
  diagnostics: { rejections?: { thetaCost?: number; liquidity?: number; other?: number }; byCode?: Record<string, number> } | null;
}

/** Pure: one row per decision bar (a bar with a mint reads as MINTED), then the slot's rates. */
export function aggregateSlotDecisions(rows: readonly SlotDecisionAggRow[]) {
  const byBar = new Map<string, SlotDecisionAggRow>();
  for (const r of rows) {
    const k = `${r.exchange}:${r.symbol}:${r.mode}:${new Date(r.decision_bar_time).getTime()}`;
    const prev = byBar.get(k);
    if (!prev || (prev.outcome !== 'MINTED' && r.outcome === 'MINTED')) byBar.set(k, r);
  }
  const bars = [...byBar.values()];
  const minted = bars.filter((b) => b.outcome === 'MINTED');
  const noTrade = bars.filter((b) => b.outcome === 'NO_TRADE');
  const noCandidate = bars.filter((b) => b.outcome === 'NO_CANDIDATE');
  const withCandidates = bars.filter((b) => b.candidates > 0);
  const needed = withCandidates.filter((b) => b.pre_mint_failures > 0);
  const rejections = { thetaCost: 0, liquidity: 0, other: 0 };
  const byCode: Record<string, number> = {};
  const limiting: Record<string, number> = {};
  for (const b of withCandidates) {
    rejections.thetaCost += b.diagnostics?.rejections?.thetaCost ?? 0;
    rejections.liquidity += b.diagnostics?.rejections?.liquidity ?? 0;
    rejections.other += b.diagnostics?.rejections?.other ?? 0;
    for (const [c, n] of Object.entries(b.diagnostics?.byCode ?? {})) byCode[c] = (byCode[c] ?? 0) + n;
  }
  for (const b of noTrade) limiting[b.limiting_stage ?? 'UNKNOWN'] = (limiting[b.limiting_stage ?? 'UNKNOWN'] ?? 0) + 1;
  const candidates = withCandidates.reduce((a, b) => a + b.candidates, 0);
  const rejected = rejections.thetaCost + rejections.liquidity + rejections.other;
  return {
    bars: bars.length,
    minted: minted.length,
    noTrade: noTrade.length,
    noCandidate: noCandidate.length,
    // NO TRADE rate: bars with at least one candidate that ended without a trade.
    noTradeRate: rate(noTrade.length, minted.length + noTrade.length),
    candidates,
    rejectedCandidates: rejected,
    rejections: {
      thetaCost: { n: rejections.thetaCost, shareOfCandidates: rate(rejections.thetaCost, candidates), shareOfRejections: rate(rejections.thetaCost, rejected) },
      liquidity: { n: rejections.liquidity, shareOfCandidates: rate(rejections.liquidity, candidates), shareOfRejections: rate(rejections.liquidity, rejected) },
      other: { n: rejections.other, shareOfCandidates: rate(rejections.other, candidates), shareOfRejections: rate(rejections.other, rejected) },
    },
    topRejectionCodes: Object.entries(byCode)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([code, n]) => ({ code, n })),
    noTradeLimitingStages: limiting,
    fallback: {
      // Bars whose best-ranked built candidate failed its final check (stale quote / mint error).
      needed: needed.length,
      succeeded: needed.filter((b) => b.outcome === 'MINTED').length,
      successRate: rate(needed.filter((b) => b.outcome === 'MINTED').length, needed.length),
      // Mints that came from a candidate below #1.
      mintedBelowFirst: minted.filter((b) => b.fellthrough > 0).length,
    },
  };
}

/** Pure: strike-level rejections from option plans (each plan's rejected strikes, by stage). */
export function aggregateStrikeRejections(plans: ReadonlyArray<{ rejected_strikes: Array<{ rejectedAt?: string | null }> | null; n_candidates: number | string | null }>) {
  let strikes = 0;
  let thetaCost = 0;
  let liquidity = 0;
  const byStage: Record<string, number> = {};
  for (const p of plans) {
    strikes += Number(p.n_candidates ?? 0) || 0;
    for (const r of p.rejected_strikes ?? []) {
      const st = r.rejectedAt ?? 'UNKNOWN';
      byStage[st] = (byStage[st] ?? 0) + 1;
      if (STRIKE_THETA_COST_STAGES.has(st)) thetaCost += 1;
      if (STRIKE_LIQUIDITY_STAGES.has(st)) liquidity += 1;
    }
  }
  return { plans: plans.length, strikesEvaluated: strikes, thetaCost, liquidity, thetaCostRate: rate(thetaCost, strikes), liquidityRate: rate(liquidity, strikes), byStage };
}

export interface ForwardRow {
  kind: string;
  predicted: any;
  actual: any;
}

/** Pure: the three forward-validation measurements. */
export function aggregateForwardOutcomes(rows: readonly ForwardRow[]) {
  const payoff = rows.filter((r) => r.kind === 'OPTION_PAYOFF');
  const strike = rows.filter((r) => r.kind === 'STRIKE_SELECTION');
  const evidence = rows.filter((r) => r.kind === 'EVIDENCE_RANK');
  const vals = (xs: readonly ForwardRow[], f: (r: ForwardRow) => unknown) => xs.map(f).map(num).filter((v): v is number => v != null);
  const bools = (xs: readonly ForwardRow[], f: (r: ForwardRow) => unknown) => xs.map(f).filter((v): v is boolean => typeof v === 'boolean');

  const byConf: Record<string, { n: number; sumR: number; targets: number; stops: number }> = {};
  for (const r of evidence) {
    for (const [k, b] of Object.entries((r.actual?.byConfirmations ?? {}) as Record<string, { n: number; avgR: number | null; targets: number; stops: number }>)) {
      const t = (byConf[k] ??= { n: 0, sumR: 0, targets: 0, stops: 0 });
      t.n += b.n;
      t.sumR += (b.avgR ?? 0) * b.n;
      t.targets += b.targets;
      t.stops += b.stops;
    }
  }
  const tw = bools(payoff, (r) => r.actual?.targetReached);
  const sb = bools(strike, (r) => r.actual?.selectedWasBest);
  const eb = bools(evidence, (r) => r.actual?.topWasBest);
  return {
    optionPayoff: {
      n: payoff.length,
      avgProjectedGainPct: avg(vals(payoff, (r) => r.predicted?.projectedGainPct)),
      avgRealisedPct: avg(vals(payoff, (r) => r.actual?.realisedPct)),
      avgMaxGainPct: avg(vals(payoff, (r) => r.actual?.maxGainPct)),
      targetReachedRate: rate(tw.filter(Boolean).length, tw.length),
      avgProjectionCaptured: avg(vals(payoff, (r) => r.actual?.projectionCaptured)),
      avgProjectedTheta: avg(vals(payoff, (r) => r.predicted?.projectedPayoff?.thetaDecay)),
    },
    strikeSelection: {
      n: strike.length,
      selectedWasBestRate: rate(sb.filter(Boolean).length, sb.length),
      avgSelectedReturnR: avg(vals(strike, (r) => r.actual?.selectedReturnR)),
      avgBestReturnR: avg(vals(strike, (r) => r.actual?.bestReturnR)),
      avgRejectedReturnR: avg(vals(strike, (r) => r.actual?.rejectedAvgReturnR)),
      avgRankVsRealised: avg(vals(strike, (r) => r.actual?.rankVsRealised)),
    },
    evidenceRank: {
      n: evidence.length,
      topWasBestRate: rate(eb.filter(Boolean).length, eb.length),
      avgTopR: avg(vals(evidence, (r) => r.actual?.topR)),
      avgRankVsRealised: avg(vals(evidence, (r) => r.actual?.rankVsRealised)),
      avgConfirmationsVsRealised: avg(vals(evidence, (r) => r.actual?.confirmationsVsRealised)),
      byConfirmations: Object.fromEntries(
        Object.entries(byConf)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([k, t]) => [k, { n: t.n, avgR: t.n ? Math.round((t.sumR / t.n) * 1000) / 1000 : null, targetRate: rate(t.targets, t.n), stopRate: rate(t.stops, t.n) }])
      ),
    },
  };
}

const ROW_LIMIT = 20_000;

/** The Signal Diagnostics "signal engine" block. */
export async function signalEngineMetrics(q: DiagnosticsQuery) {
  const slotRows = await sql<SlotDecisionAggRow[]>`
    SELECT symbol, exchange, mode, decision_bar_time, outcome, candidates, fellthrough, pre_mint_failures, limiting_stage,
      jsonb_build_object('rejections', diagnostics->'rejections', 'byCode', diagnostics->'byCode') AS diagnostics
    FROM slot_decisions
    WHERE (${q.since}::timestamptz IS NULL OR time >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR time < ${q.until})
      AND (${q.instrument}::text IS NULL OR symbol = ${q.instrument})
    ORDER BY time DESC LIMIT ${ROW_LIMIT}
  `;
  const plans = await sql<{ rejected_strikes: any[] | null; n_candidates: number | null }[]>`
    SELECT rejected_strikes, jsonb_array_length(candidates) AS n_candidates FROM option_plans
    WHERE (${q.since}::timestamptz IS NULL OR created_at >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR created_at < ${q.until})
      AND (${q.instrument}::text IS NULL OR symbol = ${q.instrument})
    ORDER BY created_at DESC LIMIT ${ROW_LIMIT}
  `;
  const forward = await sql<ForwardRow[]>`
    SELECT kind, predicted, actual FROM forward_outcomes
    WHERE (${q.since}::timestamptz IS NULL OR decided_at >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR decided_at < ${q.until})
      AND (${q.instrument}::text IS NULL OR symbol = ${q.instrument})
    ORDER BY decided_at DESC LIMIT ${ROW_LIMIT}
  `;
  const census = await sql<{ opportunities: string; traded: string; rejected: string; late: string; never_detected: string; days: string }[]>`
    SELECT COALESCE(SUM(opportunities), 0)::text AS opportunities, COALESCE(SUM(traded), 0)::text AS traded, COALESCE(SUM(rejected), 0)::text AS rejected,
      COALESCE(SUM(late), 0)::text AS late, COALESCE(SUM(never_detected), 0)::text AS never_detected, COUNT(*)::text AS days
    FROM opportunity_census_daily
    WHERE (${q.since}::timestamptz IS NULL OR session_date >= ${q.since}::date)
      AND (${q.until}::timestamptz IS NULL OR session_date <= ${q.until}::date)
      AND (${q.instrument}::text IS NULL OR instrument = ${q.instrument})
  `;
  const c = census[0];
  const opp = Number(c?.opportunities ?? 0);
  const missed = Number(c?.rejected ?? 0) + Number(c?.never_detected ?? 0);
  return {
    slot: aggregateSlotDecisions(slotRows),
    strikes: aggregateStrikeRejections(plans),
    missedOpportunities: {
      days: Number(c?.days ?? 0),
      opportunities: opp,
      traded: Number(c?.traded ?? 0),
      late: Number(c?.late ?? 0),
      detectedButRejected: Number(c?.rejected ?? 0),
      neverDetected: Number(c?.never_detected ?? 0),
      missed,
      missedRate: rate(missed, opp),
    },
    forward: aggregateForwardOutcomes(forward),
    truncated: slotRows.length === ROW_LIMIT || plans.length === ROW_LIMIT || forward.length === ROW_LIMIT,
  };
}

// ---------------- shadow rules (shadow-rules.ts) ----------------

/** The 2026-10-05 architecture change (one trade per parent, no R:R gate, ARB-2.0): results are reported before and since. */
export const ARCHITECTURE_CHANGE_AT = Date.parse('2026-10-05T12:00:00Z');

/** Pure: the closed single-leg trades the entry rules are judged on, net of each trade's own estimated cost. */
export function entryRuleTrades(records: readonly TradeSetupRecord[]): EntryRuleTrade[] {
  return records
    .filter((r) => !r.voided && !r.generatedOffSession && r.structureType !== 'SPREAD')
    .filter((r) => (r.outcome === 'WIN' || r.outcome === 'LOSS' || r.outcome === 'EXPIRED') && r.returnPercent != null)
    .map((r) => ({
      netPct: r.returnPercent! - (r.estimatedCostPct ?? ESTIMATED_ROUND_TRIP_COST_PCT),
      flags: entryFlags({
        exchange: r.exchange,
        generatedAt: r.generatedAt,
        entry: r.entry ?? null,
        target: r.target ?? null,
        estimatedCostPct: r.estimatedCostPct ?? null,
        ivVsHv: (r.entryContext as { ivVsHv?: string } | null)?.ivVsHv ?? null,
      }),
    }));
}

/** The Signal Diagnostics "Shadow experiments" block. */
export async function shadowRulesReport(q: DiagnosticsQuery) {
  const history = (await getTradeSetupHistory()).filter(
    (r) =>
      (q.since == null || r.generatedAt >= q.since.getTime()) &&
      (q.until == null || r.generatedAt < q.until.getTime()) &&
      (q.instrument == null || r.symbol === q.instrument)
  );
  const exits = await sql<{ actual: any }[]>`
    SELECT actual FROM forward_outcomes
    WHERE kind = 'SHADOW_EXITS' AND (actual->>'measured')::boolean
      AND (${q.since}::timestamptz IS NULL OR decided_at >= ${q.since})
      AND (${q.until}::timestamptz IS NULL OR decided_at < ${q.until})
      AND (${q.instrument}::text IS NULL OR symbol = ${q.instrument})
  `;
  return {
    version: SHADOW_RULES_VERSION,
    params: SHADOW_PARAMS,
    entry: {
      all: aggregateEntryRules(entryRuleTrades(history)),
      sinceArchitectureChange: aggregateEntryRules(entryRuleTrades(history.filter((r) => r.generatedAt >= ARCHITECTURE_CHANGE_AT))),
    },
    exit: aggregateExitRules(exits.map((e) => ({ actualNetPct: Number(e.actual.actualNetPct), exits: e.actual.exits }))),
  };
}

