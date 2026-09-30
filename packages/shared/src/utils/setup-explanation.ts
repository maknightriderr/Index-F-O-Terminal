// ============================================================
// SETUP EXPLANATION — one builder for the web cards and Telegram
// ============================================================
// Why a structure setup exists, what it would trade, and what would kill it,
// built ONLY from stored structured fields: the lifecycle (pool, sweep, zone,
// entry, stop, T1/T2, score, candles), the option leg when one was priced,
// and the setup_events measurement (net R, cost quality, rejection, fill,
// graded outcome). A line is omitted rather than invented when its field is
// absent. No free text, no AI.
//
// Informational only: nothing here feeds back into direction, entry, stop,
// target, score, grade or any trade decision.
// ============================================================

import type { StructureCandleScoreView, StructurePatternsView } from '../types/index.js';

export type SetupGrade = 'A+' | 'A' | 'B' | 'C';

/**
 * Descriptive grade bands, fixed in advance from the score's own shape (Tier
 * 1 maxes at 60: pool 15 + sweep 10 + displacement 15 + structure-shift 10 +
 * FVG 10; Tier 2/3 add up to +/-25 and +/-15). Chosen before any setup_events
 * outcome was graded, never fitted to win rate or R. Never gates.
 *   A+  total >= 70  (a fully-formed Tier 1 setup plus favourable context)
 *   A   55-69        (a fully-formed Tier 1 setup, or a strong one with mixed context)
 *   B   40-54        (a workable but incomplete Tier 1 setup)
 *   C   < 40         (a thin setup: low pool rank, shallow sweep, weak or no displacement)
 */
export function gradeFromScore(total: number | null | undefined): SetupGrade | null {
  if (total == null || !Number.isFinite(total)) return null;
  if (total >= 70) return 'A+';
  if (total >= 55) return 'A';
  if (total >= 40) return 'B';
  return 'C';
}

export type CostDataQuality = 'OBSERVED' | 'MODELLED' | 'UNAVAILABLE';
export type FillStatus = 'FILLED' | 'NO_FILL';

export interface SetupExplanationInput {
  direction: 'BULLISH' | 'BEARISH';
  pool: { kind: string; price: number; rank: number } | null;
  sweepExtreme: number | null;
  /** Present once a displacement printed (the zone is cut from it). */
  zone?: { kind: 'FVG' | 'DISP_50'; near: number; far: number } | null;
  entry: number | null;
  stop: number | null;
  t1: { kind: string; price: number } | null;
  t2?: { kind: string; price: number } | null;
  rToT1: number | null;
  score: number | null;
  scoreCandle?: StructureCandleScoreView | null;
  patterns?: StructurePatternsView | null;
  timeframe?: string | null;
  /** The option leg: a minted trade's contract, or a CONFIRMED preview's estimate. */
  option?: {
    side: 'CE' | 'PE';
    strike: number;
    expiry?: string | null;
    dte?: number | null;
    entryPremium?: number | null;
    stopPremium?: number | null;
    targetPremium?: number | null;
    lotSize?: number | null;
    /** True for a preview (premiums are estimates), false for a minted trade. */
    estimated: boolean;
  } | null;
  /** From setup_events. Null when no option quote was priced for this setup. */
  netR?: number | null;
  costR?: number | null;
  costQuality?: CostDataQuality | null;
  /** Present for a rejected setup. */
  rejection?: {
    reason: string | null;
    /** setup_events.would_be_valid_if, when stored. */
    wouldBeValidIf?: string | null;
    /** Null until the post-session grading has looked at the price path. NOT_GRADED: an event type the grading never checks (MISSED, INVALIDATED). */
    fillStatus?: FillStatus | 'NOT_GRADED' | null;
    resultR?: number | null;
    netResultR?: number | null;
  } | null;
}

export interface SetupExplanation {
  why: string;
  trigger: string | null;
  pool: string | null;
  entry: number | null;
  stop: number | null;
  t1: number | null;
  t2: number | null;
  option: string | null;
  grade: SetupGrade | null;
  grossR: number | null;
  netR: number | null;
  costNote: string | null;
  forLines: string[];
  against: string[];
  invalidation: string;
  wouldBeValidIf: string | null;
  rejected: {
    reason: string;
    potential: string;
    /** PENDING = not graded yet (grading runs after the session). NOT_GRADED = never checked for this event type. */
    fillStatus: FillStatus | 'PENDING' | 'NOT_GRADED';
    /** Only when the entry actually traded (FILLED) and the path was graded. */
    outcome: string | null;
  } | null;
}

const pretty = (kind: string | null | undefined) => (kind ? kind.replace(/_/g, ' ').toLowerCase() : '—');
const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const signedR = (r: number) => `${r > 0 ? '+' : ''}${r.toFixed(2)}R`;

/** The minimum T1 distance, in R, a structure setup needs (the engine's own floor). */
export const STRUCTURE_MIN_T1_R = 1.5;

export function buildSetupExplanation(input: SetupExplanationInput): SetupExplanation {
  const grade = gradeFromScore(input.score);
  const displaced = input.zone != null;
  const side = input.direction === 'BULLISH' ? 'bullish' : 'bearish';

  const why = input.pool
    ? `${side[0].toUpperCase()}${side.slice(1)} liquidity sweep: ${pretty(input.pool.kind)} ${num(input.pool.price)} was taken${input.sweepExtreme != null ? ` (extreme ${num(input.sweepExtreme)})` : ''} and price closed back inside` +
      (displaced ? ', then a displacement candle confirmed the reversal.' : '; no displacement yet.')
    : `${side[0].toUpperCase()}${side.slice(1)} structure setup.`;

  const zone = input.zone ? (input.zone.kind === 'FVG' ? `fair-value gap ${num(input.zone.near)}–${num(input.zone.far)}` : `displacement 50% at ${num(input.zone.near)}`) : null;
  const trigger = input.pool ? `${input.pool.kind}_SWEEP${zone ? ` · limit at the ${zone}` : ''}${input.timeframe ? ` · ${input.timeframe === '5m' ? '5m entry, 15m pools' : input.timeframe}` : ''}` : null;
  const pool = input.pool ? `${pretty(input.pool.kind)} ${num(input.pool.price)} (rank ${input.pool.rank})` : null;

  const o = input.option;
  const est = o?.estimated ? '~' : '';
  const option = o
    ? [
        `${o.side} ${num(o.strike)}`,
        o.expiry ? `exp ${o.expiry}${o.dte != null ? ` (${o.dte} DTE)` : ''}` : null,
        o.entryPremium != null ? `entry ${est}₹${num(o.entryPremium)}` : null,
        o.stopPremium != null ? `SL ${est}₹${num(o.stopPremium)}` : null,
        o.targetPremium != null ? `target ${est}₹${num(o.targetPremium)}` : null,
        o.lotSize != null ? `lot ${o.lotSize}` : null,
        o.estimated ? 'estimated' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const netR = input.netR ?? null;
  const costNote =
    input.costR != null && input.costQuality === 'OBSERVED'
      ? `Costs ${input.costR.toFixed(2)}R: spread from the live quote; slippage and charges modelled.`
      : input.costR != null && input.costQuality === 'MODELLED'
        ? `Costs ${input.costR.toFixed(2)}R: no two-sided quote, so the spread is assumed; slippage and charges modelled.`
        : null;

  const forLines: string[] = [];
  const against: string[] = [];
  if (input.pool) {
    if (input.pool.rank <= 2) forLines.push(`${pretty(input.pool.kind)} is a rank-${input.pool.rank} pool (previous-day / equal highs-lows tier).`);
    else against.push(`${pretty(input.pool.kind)} is a lower rank-${input.pool.rank} pool (a swing/opening-range level, less liquidity resting there).`);
  }
  if (input.rToT1 != null) {
    if (input.rToT1 >= 2) forLines.push(`T1 is ${input.rToT1}R away — comfortably past the ${STRUCTURE_MIN_T1_R}R floor.`);
    else if (input.rToT1 < 1.75) against.push(`T1 is only ${input.rToT1}R away — close to the ${STRUCTURE_MIN_T1_R}R minimum.`);
  }
  if (input.scoreCandle && input.scoreCandle.applied > 0 && input.patterns) forLines.push(`Candles: ${input.patterns.label} (+${input.scoreCandle.applied} score).`);
  else if (input.patterns) against.push('No scored candle pattern on the sweep or displacement.');
  if (input.score != null && grade) {
    if (grade === 'A+' || grade === 'A') forLines.push(`Setup quality ${input.score}/100 (grade ${grade} by the fixed bands).`);
    else if (grade === 'C') against.push(`Setup quality ${input.score}/100 (grade C by the fixed bands).`);
  }
  if (netR != null && input.rToT1 != null && netR < STRUCTURE_MIN_T1_R && input.rToT1 >= STRUCTURE_MIN_T1_R) {
    against.push(`After costs T1 is ${netR.toFixed(2)}R, under the ${STRUCTURE_MIN_T1_R}R the gross figure clears.`);
  }

  const invalidation =
    input.sweepExtreme != null
      ? `A close back beyond the sweep extreme (${num(input.sweepExtreme)}) invalidates it (SWEEP_RECLAIMED).`
      : 'A close back beyond the sweep invalidates it (SWEEP_RECLAIMED).';

  const r = input.rejection;
  const wouldBeValidIf =
    r?.wouldBeValidIf ??
    (input.rToT1 != null && input.rToT1 < STRUCTURE_MIN_T1_R ? `T1 >= ${STRUCTURE_MIN_T1_R}R would need a closer entry or a farther T1 (currently ${input.rToT1}R).` : null);

  let rejected: SetupExplanation['rejected'] = null;
  if (r) {
    const fillStatus = r.fillStatus ?? 'PENDING';
    const outcome =
      fillStatus === 'FILLED' && r.resultR != null
        ? `Graded ${signedR(r.resultR)}${r.netResultR != null ? ` (${signedR(r.netResultR)} after costs)` : ''} on the underlying path — simulated, not a fill.`
        : null;
    rejected = {
      reason: r.reason ?? 'Reason not recorded.',
      potential: `Potential entry ${num(input.entry)} · stop ${num(input.stop)} · target ${num(input.t1?.price)}`,
      fillStatus,
      outcome,
    };
  }

  return {
    why,
    trigger,
    pool,
    entry: input.entry,
    stop: input.stop,
    t1: input.t1?.price ?? null,
    t2: input.t2?.price ?? null,
    option,
    grade,
    grossR: input.rToT1,
    netR,
    costNote,
    forLines,
    against,
    invalidation,
    wouldBeValidIf,
    rejected,
  };
}
