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
// GRADE BANDS — fixed BEFORE any outcome was looked at, from the score's own
// component structure (see gradeFromScore below), never fitted to results.
// ============================================================

import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

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
  | 'CLOSED';

export type SetupDecision = 'WATCH' | 'DETECTED' | 'REJECTED' | 'TRADED';

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
};

/**
 * Descriptive grade bands, fixed in advance from the score's own shape (Tier
 * 1 maxes at 60: pool 15 + sweep 10 + displacement 15 + structure-shift 10 +
 * FVG 10; Tier 2/3 add up to +/-25 and +/-15). Chosen before any `setup_events`
 * outcome was graded — NOT fitted to win rate or R:
 *   A+  total >= 70  (a fully-formed Tier 1 setup plus favourable context)
 *   A   55-69        (a fully-formed Tier 1 setup, or a strong one with mixed context)
 *   B   40-54        (a workable but incomplete Tier 1 setup)
 *   C   < 40         (a thin setup: low pool rank, shallow sweep, weak or no displacement)
 */
export function gradeFromScore(total: number | null | undefined): 'A+' | 'A' | 'B' | 'C' | null {
  if (total == null || !Number.isFinite(total)) return null;
  if (total >= 70) return 'A+';
  if (total >= 55) return 'A';
  if (total >= 40) return 'B';
  return 'C';
}

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
  const rejectionReason = decision === 'REJECTED' ? input.reason : null;
  const validIf = decision === 'REJECTED' ? wouldBeValidIf({ eventType, reason: input.reason, entry: input.entry, stop: input.stop, t1: input.t1, grossRr }) : null;

  // Descriptive score components — see the module comment for what each one is (and isn't).
  const rankPts: Record<number, number> = { 1: 15, 2: 12, 3: 9, 4: 6, 5: 3 };
  const scorePool = input.poolRank != null ? rankPts[input.poolRank] ?? null : null;
  const scoreSweep = input.sweepDepthAtr != null ? round2(input.sweepDepthAtr) : null;
  const scoreDisplacement = input.displacementBodyAtr != null ? round2(input.displacementBodyAtr) : null;
  const scoreCandle = input.scoreCandleApplied ?? null;
  const scoreRr = grossRr;

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
        strategy_version, trigger_version, risk_version, option_version, cost_version
      ) VALUES (
        ${input.time}, ${input.instrument}, ${input.exchange}, ${input.timeframe}, ${input.lifecycleId}, ${input.direction}, ${eventType},
        ${input.poolId ?? null}, ${input.poolType}, ${input.poolPrice},
        ${input.triggerType ?? (input.poolType ? `${input.poolType}_SWEEP` : null)}, ${input.sweepHigh ?? null}, ${input.sweepLow ?? null}, ${input.sweepDepthAtr ?? null},
        ${input.entry}, ${input.stop}, ${input.t1}, ${input.t2}, ${grossRr},
        ${null}, ${null},
        ${scorePool}, ${scoreSweep}, ${scoreDisplacement}, ${scoreCandle}, ${scoreRr}, ${null}, ${input.scoreTotal}, ${grade},
        ${input.context ? sql.json(input.context as never) : null}, ${input.optionCandidate ? sql.json(input.optionCandidate as never) : null},
        ${decision}, ${rejectionReason}, ${validIf},
        ${input.versions.strategyVersion}, ${input.versions.triggerVersion}, ${input.versions.riskVersion}, ${input.versions.optionVersion}, ${input.versions.costVersion}
      )
    `;
  } catch (err: any) {
    logger.error({ error: err.message, lifecycleId: input.lifecycleId, eventType }, 'setup_events: insert failed');
  }
}
