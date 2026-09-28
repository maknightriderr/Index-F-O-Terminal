// ============================================================
// LOSS ATTRIBUTION — data access (Phase 1, read-only)
// ============================================================
// Loads recorded decisions and hands them to the pure aggregation in
// loss-attribution-model.ts. SELECT only: nothing here writes, and nothing
// here is read by the decision path.
// ============================================================

import { sql } from '../lib/db.js';
import { DATA_QUALITY_CUTOVER_AT } from './capture-quality.js';
import {
  buildAttributionReport,
  buildSplitReport,
  buildOpeningHourReport,
  buildCooldownEffectivenessReport,
  type AttributionReport,
  type AttributionRow,
  type SplitReport,
  type OpeningHourReport,
  type CooldownEffectivenessReport,
} from './loss-attribution-model.js';
import type { ExitReason } from './exit-reason.js';
import { buildShadowComparison, type ShadowComparisonReport, type ShadowRow } from './shadow-comparison-model.js';

export type DecisionScope = 'TAKE' | 'REFUSE' | 'ALL';

export interface AttributionQuery {
  since?: Date | null;
  until?: Date | null;
  /** TAKE = paper trades the engine minted (default). REFUSE = hypothetical outcomes of refusals. */
  decision?: DecisionScope;
}

interface RawRow {
  decision_id: string;
  time: Date;
  symbol: string;
  bias: string | null;
  regime: string | null;
  confidence: string | null;
  primary_strategy_label: string | null;
  setup_family: string | null;
  option_type: string | null;
  strike: string | null;
  underlying_price: string | null;
  atr: string | null;
  delta: string | null;
  dte: string | null;
  iv: string | null;
  session_bucket: string | null;
  signal_age_seconds: string | null;
  spread_pct: string | null;
  exit_reason: string | null;
  outcome_mfe_atr: string | null;
  outcome_mae_atr: string | null;
  outcome_r: string | null;
  eventual_r: string | null;
  eventual_exit_reason: string | null;
  dead_at: Date | null;
  invalidation_reason: string | null;
  same_direction_exposure: string | number | null;
  correlated_exposure: string | number | null;
  minutes_from_session_open: string | number | null;
  opening_environment: string | null;
  minutes_since_last_loss: string | number | null;
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function toRow(r: RawRow): AttributionRow {
  const strike = num(r.strike);
  const spot = num(r.underlying_price);
  const atr = num(r.atr);
  return {
    decisionId: r.decision_id,
    time: new Date(r.time).getTime(),
    symbol: r.symbol,
    bias: r.bias,
    regime: r.regime,
    confidence: num(r.confidence),
    strategy: r.primary_strategy_label ?? (r.setup_family ? `family:${r.setup_family}` : 'UNLABELLED'),
    side: r.option_type === 'CE' || r.option_type === 'PE' ? r.option_type : null,
    strikeDistanceAtr: strike != null && spot != null && atr != null && atr > 0 ? Math.abs(strike - spot) / atr : null,
    delta: num(r.delta),
    dte: num(r.dte),
    ivPct: num(r.iv),
    sessionBucket: r.session_bucket,
    signalAgeSeconds: num(r.signal_age_seconds),
    spreadPct: num(r.spread_pct),
    exitReason: (r.exit_reason as ExitReason | null) ?? null,
    mfeAtr: num(r.outcome_mfe_atr),
    maeAtr: num(r.outcome_mae_atr),
    simR: num(r.outcome_r),
    premiumR: num(r.eventual_r),
    eventualExitReason: (r.eventual_exit_reason as ExitReason | null) ?? null,
    deadAt: r.dead_at ? new Date(r.dead_at).getTime() : null,
    invalidationReason: r.invalidation_reason,
    sameDirectionExposure: num(r.same_direction_exposure),
    correlatedExposure: num(r.correlated_exposure),
    minutesFromSessionOpen: num(r.minutes_from_session_open),
    openingEnvironment: r.opening_environment,
    minutesSinceLastLoss: num(r.minutes_since_last_loss),
  };
}

/** Graded decisions in range. UNKNOWN (ungradeable) rows are excluded — they carry no outcome. */
export async function loadAttributionRows(q: AttributionQuery = {}): Promise<AttributionRow[]> {
  const scope = q.decision ?? 'TAKE';
  const since = q.since ?? new Date(0);
  const until = q.until ?? new Date('2999-01-01T00:00:00Z');
  const rows = await sql<RawRow[]>`
    SELECT decision_id, time, symbol, bias, regime, confidence,
           primary_strategy_label, setup_family, option_type, strike, underlying_price, atr,
           delta, option->>'dte' AS dte, iv, session_bucket, signal_age_seconds, spread_pct,
           exit_reason, outcome_mfe_atr, outcome_mae_atr, outcome_r,
           eventual_r, eventual_exit_reason, dead_at,
           invalidation_reason, same_direction_exposure, correlated_exposure,
           minutes_from_session_open, opening_environment, minutes_since_last_loss
    FROM decision_snapshots
    WHERE time >= ${since} AND time < ${until}
      AND outcome_evaluated_at IS NOT NULL
      AND COALESCE(outcome_class, '') <> 'UNKNOWN'
      AND (${scope}::text = 'ALL' OR decision = ${scope}::text)
    ORDER BY time ASC
  `;
  return rows.map(toRow);
}

export async function lossAttributionReport(q: AttributionQuery = {}): Promise<AttributionReport> {
  return buildAttributionReport(await loadAttributionRows(q));
}

export const IN_SAMPLE_SPLIT_REASON =
  'DATA_QUALITY_CUTOVER_AT (capture-quality.ts): the deploy after which absent values stopped being stored as zero. ' +
  'Rows before it are in-sample (older capture contract); rows after it are out-of-sample.';

export async function lossAttributionSplitReport(q: AttributionQuery = {}): Promise<SplitReport> {
  return buildSplitReport(await loadAttributionRows(q), DATA_QUALITY_CUTOVER_AT, IN_SAMPLE_SPLIT_REASON);
}

/** Phase 3 (spec §15) — opening-hour granular breakdown over the same graded rows as every other question above. */
export async function openingHourReport(q: AttributionQuery = {}): Promise<OpeningHourReport> {
  return buildOpeningHourReport(await loadAttributionRows(q));
}

/** Phase 3 (spec §16) — cooldown-effectiveness re-bucketed on current data. */
export async function cooldownEffectivenessReport(q: AttributionQuery = {}): Promise<CooldownEffectivenessReport> {
  return buildCooldownEffectivenessReport(await loadAttributionRows(q));
}

interface RawShadowRow {
  decision_id: string;
  time: Date;
  symbol: string;
  dte_bucket: string | null;
  strike: string | null;
  premium: string | null;
  target: string | null;
  live_net_r: string | null;
  shadow_selected_strike: string | null;
  shadow_selection_score: string | number | null;
  shadow_entry_price: string | null;
  shadow_execution_quality: 'NORMAL' | 'DEGRADED' | null;
  shadow_net_r: string | null;
  shadow_target_v2: string | null;
  shadow_expected_net_r_v2: string | null;
  eventual_exit_reason: string | null;
  eventual_r: string | null;
}

/**
 * Phase 2 — TAKE decisions carrying any shadow-model column, graded or not
 * (the comparison is between two models of the same entry, which does not
 * need the outcome audit to have run). SELECT only.
 */
export async function loadShadowRows(q: AttributionQuery = {}): Promise<ShadowRow[]> {
  const since = q.since ?? new Date(0);
  const until = q.until ?? new Date('2999-01-01T00:00:00Z');
  const rows = await sql<RawShadowRow[]>`
    SELECT decision_id, time, symbol, dte_bucket, strike, premium, target, live_net_r,
           shadow_selected_strike, shadow_selection_score, shadow_entry_price, shadow_execution_quality,
           shadow_net_r, shadow_target_v2, shadow_expected_net_r_v2, eventual_exit_reason, eventual_r
    FROM decision_snapshots
    WHERE time >= ${since} AND time < ${until}
      AND decision = 'TAKE'
      AND (shadow_selected_strike IS NOT NULL OR shadow_execution_quality IS NOT NULL OR shadow_target_v2 IS NOT NULL)
    ORDER BY time ASC
  `;
  return rows.map((r) => ({
    decisionId: r.decision_id,
    time: new Date(r.time).getTime(),
    symbol: r.symbol,
    dteBucket: r.dte_bucket,
    liveStrike: num(r.strike),
    liveEntry: num(r.premium),
    liveTarget: num(r.target),
    liveNetR: num(r.live_net_r),
    shadowStrike: num(r.shadow_selected_strike),
    shadowSelectionScore: num(r.shadow_selection_score),
    shadowEntry: num(r.shadow_entry_price),
    shadowExecutionQuality: r.shadow_execution_quality,
    shadowNetR: num(r.shadow_net_r),
    shadowTargetV2: num(r.shadow_target_v2),
    shadowExpectedNetRV2: num(r.shadow_expected_net_r_v2),
    eventualExitReason: r.eventual_exit_reason,
    premiumR: num(r.eventual_r),
  }));
}

export async function shadowComparisonReport(q: AttributionQuery = {}): Promise<ShadowComparisonReport> {
  return buildShadowComparison(await loadShadowRows(q));
}

export interface GateFailureRow {
  gate: string;
  pass: number;
  fail: number;
  notEvaluated: number;
  /** Times this gate failed while it was NOT the gate the live chain refused on. */
  failedButNotDeciding: number;
  decidingCount: number;
}

/**
 * Per gate, across recorded decisions: how often it passed, failed, or was
 * not evaluated, and how often it would ALSO have refused a decision some
 * earlier gate had already refused — the fact the live first-match chain
 * hides.
 */
export async function gateFailureSummary(q: AttributionQuery = {}): Promise<GateFailureRow[]> {
  const since = q.since ?? new Date(0);
  const until = q.until ?? new Date('2999-01-01T00:00:00Z');
  const rows = await sql<
    { gate: string; pass: string; fail: string; not_evaluated: string; failed_not_deciding: string; deciding: string }[]
  >`
    SELECT gate,
           COUNT(*) FILTER (WHERE status = 'PASS') AS pass,
           COUNT(*) FILTER (WHERE status = 'FAIL') AS fail,
           COUNT(*) FILTER (WHERE status = 'NOT_EVALUATED') AS not_evaluated,
           COUNT(*) FILTER (WHERE status = 'FAIL' AND NOT was_deciding_gate) AS failed_not_deciding,
           COUNT(*) FILTER (WHERE was_deciding_gate) AS deciding
    FROM gate_diagnostics
    WHERE evaluated_at >= ${since} AND evaluated_at < ${until}
    GROUP BY gate
    ORDER BY COUNT(*) FILTER (WHERE status = 'FAIL') DESC
  `;
  return rows.map((r) => ({
    gate: r.gate,
    pass: Number(r.pass),
    fail: Number(r.fail),
    notEvaluated: Number(r.not_evaluated),
    failedButNotDeciding: Number(r.failed_not_deciding),
    decidingCount: Number(r.deciding),
  }));
}
