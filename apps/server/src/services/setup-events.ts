// ============================================================
// SETUP_EVENTS WRITER (Stage 2: signal-diagnostics measurement infrastructure)
// ============================================================
// Turns a structure LifecycleEventRow (the same stream `setup_lifecycle_events`
// already writes from) into a `setup_events` row. Instrumentation only:
// nothing in the decision path reads this table, and a write failure here is
// always logged, never silently swallowed, and never blocks or alters a
// decision.
//
// SCORE COLUMNS — what is and isn't recomputed here:
//   score_pool / score_sweep / score_displacement / score_candle are
//   descriptive numbers taken directly from the setup's own fields (pool
//   rank, sweep depth in ATR, displacement body in ATR, the candle bonus
//   already on the lifecycle) — NOT a recomputation of scoreStructureSetup's
//   internal point formula, which needs live tier-2/tier-3 inputs
//   (positioning, OI wall, regime, volume) that are not threaded into the
//   lifecycle event row. score_rr is the setup's own gross R:R, stored
//   descriptively — R:R is a gate (>= 1.5) in this round, not a weighted
//   score component. score_option is null: no option-chain breakdown
//   reaches this layer today (future work, see the diagnostics dashboard).
//
// COST COLUMNS (migration 032) — setup-cost.ts's measurement, present on the
// transitions that met a live option quote (the fill: ENTRY_MINTED /
// ENTRY_REFUSED); every other row records stop distance and
// cost_quality = UNAVAILABLE. Measurement only, never a gate.
//
// GRADE BANDS — fixed BEFORE any outcome was looked at, from the score's own
// component structure (gradeFromScore, @fno/shared), never fitted to results.
// ============================================================

import { gradeFromScore } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { measureStopDistance, type SetupCostMeasurement } from './setup-cost.js';

export { gradeFromScore };

export type SetupEventType =
  | 'WATCH'
  | 'SWEEP_DETECTED'
  | 'SETUP_CREATED'
  | 'CONFIRMED'
  | 'ENTRY'
  | 'ACTIVE'
  | 'REJECTED'
  | 'INVALIDATED'
  | 'LOW_RR'
  | 'LATE'
  | 'MISSED'
  | 'TRADED'
  | 'CLOSED'
  /** A trigger-family candidate from the live router (SHADOW: recorded and graded, never traded). */
  | 'CANDIDATE'
  /** One candidate's role in a slot arbitration (rank, criteria, option-build failure). Measurement only: never graded or counted by the census. */
  | 'ARBITRATION'
  /** A confirmed setup's watch lifecycle (setup-watch.ts): measurement only, decision LIFECYCLE. */
  | 'WATCH_STARTED'
  | 'REEVALUATED'
  /** Historical only: emitted until 2026-10-05, when net R:R stopped being a gate (nothing "recovers" any more). */
  | 'RR_RECOVERED'
  | 'STRIKE_CHANGED'
  | 'OPTION_BUILD_FAILED'
  | 'WATCH_ENDED';

export type SetupDecision = 'WATCH' | 'DETECTED' | 'REJECTED' | 'TRADED' | 'SHADOW' | 'ARBITRATION' | 'LIFECYCLE';

/** The structure engine's lifecycle stage vocabulary -> setup_events' own. */
const EVENT_TYPE_BY_STAGE: Record<string, SetupEventType> = {
  WATCH: 'WATCH',
  DEVELOPING: 'SWEEP_DETECTED',
  CONFIRMED: 'CONFIRMED',
  ENTRY: 'ENTRY',
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED',
  INVALIDATED: 'INVALIDATED',
  LATE: 'LATE',
  MISSED: 'MISSED',
  LOW_RR: 'LOW_RR',
  ENTRY_MINTED: 'TRADED',
  ENTRY_REFUSED: 'REJECTED',
};

const DECISION_BY_EVENT_TYPE: Record<SetupEventType, SetupDecision> = {
  WATCH: 'WATCH',
  SWEEP_DETECTED: 'DETECTED',
  SETUP_CREATED: 'DETECTED',
  CONFIRMED: 'DETECTED',
  ENTRY: 'DETECTED',
  ACTIVE: 'DETECTED',
  REJECTED: 'REJECTED',
  INVALIDATED: 'REJECTED',
  LOW_RR: 'REJECTED',
  LATE: 'REJECTED',
  MISSED: 'REJECTED',
  TRADED: 'TRADED',
  CLOSED: 'TRADED',
  CANDIDATE: 'SHADOW',
  ARBITRATION: 'ARBITRATION',
  WATCH_STARTED: 'LIFECYCLE',
  REEVALUATED: 'LIFECYCLE',
  RR_RECOVERED: 'LIFECYCLE',
  STRIKE_CHANGED: 'LIFECYCLE',
  OPTION_BUILD_FAILED: 'LIFECYCLE',
  WATCH_ENDED: 'LIFECYCLE',
};

/**
 * A required entry that would give exactly minT1R, holding stop and T1
 * fixed: |T1 - entry| = minT1R * |entry - stop|. Valid for stop < entry < T1
 * or stop > entry > T1 (the only geometries a real setup has).
 */
function requiredEntryForRR(stop: number, t1: number, minT1R: number): number {
  return (t1 + minT1R * stop) / (1 + minT1R);
}

/** Built ONLY from structured fields already on the row — no free-text guessing. */
export function wouldBeValidIf(row: {
  eventType: SetupEventType;
  reason: string | null;
  entry: number | null;
  stop: number | null;
  t1: number | null;
  grossRr: number | null;
}): string | null {
  const reason = (row.reason ?? '').toLowerCase();
  if (row.eventType === 'LOW_RR' && row.entry != null && row.stop != null && row.t1 != null) {
    const required = requiredEntryForRR(row.stop, row.t1, 1.5);
    const cmp = row.stop < row.t1 ? (required <= row.entry ? '<=' : '>=') : required >= row.entry ? '>=' : '<=';
    return `T1 >= 1.5R would need entry ${cmp} ${round2(required)} (was ${round2(row.entry)}).`;
  }
  if (reason.includes('cost') || reason.includes('premium risk') || reason.includes('spread')) {
    return 'Would be valid if cost < 5% of premium.';
  }
  if (reason.includes('closing') || reason.includes('minutes to close') || reason.includes('closing_hour')) {
    return 'Would be valid if filled earlier than the closing guard cutoff.';
  }
  if (reason.includes('cooldown') || reason.includes('losing close')) {
    return 'Would be valid if outside the post-loss cooldown window.';
  }
  if (reason.includes('concurren')) {
    return 'Would be valid if under the concurrent-exposure cap.';
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface SetupEventInput {
  time: Date;
  instrument: string;
  exchange: string;
  timeframe: string;
  lifecycleId: string;
  direction: 'BULLISH' | 'BEARISH';
  /** The engine's raw stage/outcome string (e.g. 'DEVELOPING', 'ENTRY_MINTED'). */
  fromStage: string | null;
  toStage: string;
  reason: string | null;
  poolId?: string | null;
  poolType: string | null;
  poolPrice: number | null;
  poolRank?: number | null;
  triggerType?: string | null;
  sweepHigh?: number | null;
  sweepLow?: number | null;
  sweepDepthAtr?: number | null;
  entry: number | null;
  stop: number | null;
  t1: number | null;
  t2: number | null;
  scoreTotal: number | null;
  scoreCandleApplied?: number | null;
  displacementBodyAtr?: number | null;
  context?: Record<string, unknown> | null;
  optionCandidate?: Record<string, unknown> | null;
  decisionId?: string | null;
  signalId?: string | null;
  /** The lifecycle's ATR on its entry timeframe, for stop distance in ATR. */
  atr?: number | null;
  /** setup-cost.ts's measurement, when this transition met a live option quote. */
  cost?: SetupCostMeasurement | null;
  versions: { strategyVersion: string; triggerVersion: string; riskVersion: string; optionVersion: string; costVersion: string };
}

/**
 * One `setup_events` row. Fire-and-forget, like every capture writer in this
 * codebase: a failure is logged (never silently caught) and never blocks or
 * alters the lifecycle it was called from.
 */
export function recordSetupEvent(input: SetupEventInput): void {
  void insertSetupEvent(input).catch((err: any) => logger.error({ error: err.message, lifecycleId: input.lifecycleId, toStage: input.toStage }, 'setup_events: insert failed'));
}

async function insertSetupEvent(input: SetupEventInput): Promise<void> {
  const eventType = EVENT_TYPE_BY_STAGE[input.toStage] ?? (input.toStage as SetupEventType);
  const decision = DECISION_BY_EVENT_TYPE[eventType] ?? 'DETECTED';
  const grossRr = input.entry != null && input.stop != null && input.t1 != null && Math.abs(input.entry - input.stop) > 0 ? round4(Math.abs(input.t1 - input.entry) / Math.abs(input.entry - input.stop)) : null;
  const grade = gradeFromScore(input.scoreTotal);
  // A shadow candidate carries its own risk verdict as the reason (e.g. LOW_RR, NO_TARGET); a passing one has none.
  const rejectionReason = decision === 'REJECTED' || (decision === 'SHADOW' && input.reason) ? input.reason : null;
  const validIf =
    rejectionReason != null
      ? wouldBeValidIf({ eventType: input.reason?.startsWith('LOW_RR') ? 'LOW_RR' : eventType, reason: input.reason, entry: input.entry, stop: input.stop, t1: input.t1, grossRr })
      : null;

  // Descriptive score components — see the module comment for what each one is (and isn't).
  const rankPts: Record<number, number> = { 1: 15, 2: 12, 3: 9, 4: 6, 5: 3 };
  const scorePool = input.poolRank != null ? rankPts[input.poolRank] ?? null : null;
  const scoreSweep = input.sweepDepthAtr != null ? round2(input.sweepDepthAtr) : null;
  const scoreDisplacement = input.displacementBodyAtr != null ? round2(input.displacementBodyAtr) : null;
  const scoreCandle = input.scoreCandleApplied ?? null;
  const scoreRr = grossRr;

  // Cost and stop distance (migration 032). Without a priced leg, stop distance still lands.
  const cost = input.cost ?? null;
  const stopDist = cost?.stop ?? measureStopDistance({ entry: input.entry, stop: input.stop, atr: input.atr ?? null });
  const opt = cost?.option ?? null;
  const optionCandidate = opt ? { ...(input.optionCandidate ?? {}), ...opt } : input.optionCandidate ?? null;

  try {
    await sql`
      INSERT INTO setup_events (
        time, instrument, exchange, timeframe, lifecycle_id, direction, event_type,
        pool_id, pool_type, pool_price,
        trigger_type, sweep_high, sweep_low, sweep_depth,
        entry, stop, t1, t2, gross_rr,
        cost_components, net_rr,
        score_pool, score_sweep, score_displacement, score_candle, score_rr, score_option, score_total, grade,
        context, option_candidate,
        decision, rejection_reason, would_be_valid_if,
        strategy_version, trigger_version, risk_version, option_version, cost_version,
        cost_quality, option_side, option_strike, option_expiry, option_strike_basis, option_premium, option_bid, option_ask, option_delta, lot_size,
        cost_spread, cost_slippage, cost_charges, cost_total, cost_pct_premium, cost_r, spread_r, slippage_r, charges_r,
        stop_points, stop_atr, stop_pct, underlying_risk_lot, option_risk_unit, option_risk_lot, option_risk_basis
      ) VALUES (
        ${input.time}, ${input.instrument}, ${input.exchange}, ${input.timeframe}, ${input.lifecycleId}, ${input.direction}, ${eventType},
        ${input.poolId ?? null}, ${input.poolType}, ${input.poolPrice},
        ${input.triggerType ?? (input.poolType ? `${input.poolType}_SWEEP` : null)}, ${input.sweepHigh ?? null}, ${input.sweepLow ?? null}, ${input.sweepDepthAtr ?? null},
        ${input.entry}, ${input.stop}, ${input.t1}, ${input.t2}, ${grossRr},
        ${cost ? sql.json(cost as never) : null}, ${cost?.netR ?? null},
        ${scorePool}, ${scoreSweep}, ${scoreDisplacement}, ${scoreCandle}, ${scoreRr}, ${null}, ${input.scoreTotal}, ${grade},
        ${input.context ? sql.json(input.context as never) : null}, ${optionCandidate ? sql.json(optionCandidate as never) : null},
        ${decision}, ${rejectionReason}, ${validIf},
        ${input.versions.strategyVersion}, ${input.versions.triggerVersion}, ${input.versions.riskVersion}, ${input.versions.optionVersion}, ${input.versions.costVersion},
        ${cost?.quality ?? 'UNAVAILABLE'}, ${opt?.side ?? null}, ${opt?.strike ?? null}, ${opt?.expiry ?? null}, ${opt?.strikeBasis ?? null}, ${opt?.premium ?? null}, ${opt?.bid ?? null}, ${opt?.ask ?? null}, ${opt?.delta ?? null}, ${opt?.lotSize ?? null},
        ${cost?.perUnit?.spread ?? null}, ${cost?.perUnit?.slippage ?? null}, ${cost?.perUnit?.charges ?? null}, ${cost?.perUnit?.total ?? null}, ${cost?.costPctOfPremium ?? null},
        ${cost?.costR ?? null}, ${cost?.spreadR ?? null}, ${cost?.slippageR ?? null}, ${cost?.chargesR ?? null},
        ${stopDist.points}, ${stopDist.atr}, ${stopDist.pct}, ${stopDist.underlyingRiskPerLot}, ${stopDist.optionRiskPerUnit}, ${stopDist.optionRiskPerLot}, ${stopDist.optionRiskBasis}
      )
    `;
  } catch (err: any) {
    logger.error({ error: err.message, lifecycleId: input.lifecycleId, eventType }, 'setup_events: insert failed');
  }
}
