// ============================================================
// RESEARCH CONTRACT
// ============================================================
// The rules the research layer holds itself to, as code rather than as
// prose in a report: what kind of "no" a refusal was, how much data is
// enough before a question can be asked, how a dataset must be split before
// a rule can be promoted, and which universe the capture is drawn from.
//
// Nothing here is read by the trading engine. Every value is a research
// threshold, not a trading rule — raising or lowering any of them changes
// what the research is allowed to claim, and changes no decision.
// ============================================================

import type { NoTradeCode } from '@fno/shared';

// ============================================================
// REFUSAL CLASSIFICATION
// ============================================================

/**
 * What KIND of "no" a refusal was.
 *
 * The existing reason code says which rule fired. This says what that
 * implies about the setup, which is a different question and the one that
 * matters for missed-winner analysis:
 *
 *   A filter that rejects genuinely bad setups and a risk control that
 *   blocks a perfectly good setup both appear as "a refusal" today. When
 *   grading matures, those two produce the same MISSED_WINNER row and
 *   demand opposite responses — tighten the first, reconsider the second.
 */
export type RefusalClass =
  /** The setup itself did not clear the bar. */
  | 'REFUSED'
  /** A cooldown, lock or circuit breaker intervened. The setup may have been fine. */
  | 'BLOCKED_BY_RISK_CONTROL'
  /** The feed could not be read, so no judgement about the setup was possible. */
  | 'BLOCKED_BY_DATA_QUALITY'
  /** No tradeable opportunity existed to judge — market closed, no chain, no quote. */
  | 'NOT_ELIGIBLE'
  | 'UNKNOWN';

const REFUSAL_CLASS: Record<string, RefusalClass> = {
  // The setup was judged and found wanting.
  LOW_SETUP_QUALITY: 'REFUSED',
  NEUTRAL_BIAS: 'REFUSED',
  POSITIONING_CONFLICT: 'REFUSED',
  RELIABILITY_FILTER: 'REFUSED',
  UNREALISTIC_TARGET: 'REFUSED',
  INSUFFICIENT_ROOM: 'REFUSED',
  POOR_LOCATION: 'REFUSED',
  COST_EXCEEDS_EDGE: 'REFUSED',
  REWARD_RISK_TOO_LOW: 'REFUSED',
  POOR_OPTION_QUALITY: 'REFUSED',
  LOW_OPTION_LIQUIDITY: 'REFUSED',
  WIDE_SPREAD: 'REFUSED',

  // A safety rule intervened. Nothing here is a statement about the setup.
  RISK_OFF: 'BLOCKED_BY_RISK_CONTROL',
  POST_LOSS_COOLDOWN: 'BLOCKED_BY_RISK_CONTROL',
  SAME_SYMBOL_SIDE: 'BLOCKED_BY_RISK_CONTROL',
  DIRECTION_LOCKED: 'BLOCKED_BY_RISK_CONTROL',
  OPENING_HOUR: 'BLOCKED_BY_RISK_CONTROL',

  // The feed was unusable, so the setup was never actually judged.
  NO_QUOTE: 'BLOCKED_BY_DATA_QUALITY',

  // There was nothing to judge.
  MARKET_CLOSED: 'NOT_ELIGIBLE',
  NO_CHAIN: 'NOT_ELIGIBLE',

  UNKNOWN: 'UNKNOWN',
};

/**
 * Classifies a refusal reason. Pure, total, and never guesses: an
 * unrecognised code returns UNKNOWN rather than being filed under whichever
 * class seems closest, because a mis-filed refusal would quietly shift the
 * blame for a missed winner from one filter to another.
 */
export function classifyRefusal(code: NoTradeCode | string | null | undefined): RefusalClass {
  if (code == null) return 'UNKNOWN';
  return REFUSAL_CLASS[code] ?? 'UNKNOWN';
}

/** Every code this module knows how to classify, for the completeness test. */
export const CLASSIFIED_REFUSAL_CODES = Object.keys(REFUSAL_CLASS);

// ============================================================
// OPPORTUNITY VERDICT
// ============================================================

/**
 * What a refusal turned out to be worth, once its horizon elapsed.
 *
 * Deliberately three values and not two. UNRESOLVED is not a failure of the
 * grader — it is the honest answer when a thesis neither ran nor failed, and
 * collapsing it into CORRECT_REFUSAL would credit every filter for declining
 * trades that were never going anywhere.
 */
export type OpportunityVerdict = 'MISSED_WINNER' | 'CORRECT_REFUSAL' | 'UNRESOLVED';

/**
 * Maps a graded outcome to the research verdict.
 *
 * `null` means not gradeable yet — an immature refusal has no verdict, and
 * must never be counted as a correct one.
 */
export function opportunityVerdict(outcomeClass: string | null | undefined): OpportunityVerdict | null {
  switch (outcomeClass) {
    case 'MISSED_WINNER':
      return 'MISSED_WINNER';
    case 'GOOD_REJECTION':
      return 'CORRECT_REFUSAL';
    case 'NEUTRAL':
      return 'UNRESOLVED';
    case 'UNKNOWN':
      return 'UNRESOLVED';
    default:
      return null;
  }
}

// ============================================================
// RESEARCH READINESS THRESHOLDS
// ============================================================

/**
 * How much data a question needs before it can be asked.
 *
 * These are RESEARCH thresholds. None of them changes production behaviour,
 * and a dataset falling short does not stop the engine trading — it stops
 * the research from claiming an answer.
 *
 * The numbers are conventional rather than derived: 30 is where a mean
 * starts to behave, 50 is where a difference between two buckets starts to
 * be worth looking at, 100 is where a distribution's tails are represented
 * at all. They are not tuned, and tuning them would be the same mistake as
 * tuning a threshold on the data it will be tested against.
 */
export const RESEARCH_THRESHOLDS = {
  /** Trading sessions of option-chain history before a replay can mean anything. */
  minChainSessions: 10,
  /** Refusals past their evaluation horizon before missed-winner analysis is worth reading. */
  minMatureRefusals: 100,
  /** Closed trades before an expectancy figure is more than an anecdote. */
  minClosedTrades: 100,
  /** Per setup type. */
  minPerSetupExploratory: 30,
  minPerSetupPreferred: 50,
  /** Per market regime. */
  minPerRegimeExploratory: 30,
  minPerRegimePreferred: 50,
  /** Per session bucket, for the first-hour question. */
  minPerSessionBucketExploratory: 30,
  minPerSessionBucketPreferred: 50,
} as const;

export type SampleGrade = 'INSUFFICIENT' | 'EXPLORATORY' | 'PREFERRED';

/**
 * Grades a sample size. Three levels rather than a pass/fail, because the
 * middle one is where most of this research will live for a long time and
 * pretending it is either nothing or enough would be wrong in both
 * directions.
 */
export function gradeSample(n: number, exploratory: number, preferred: number): SampleGrade {
  if (n >= preferred) return 'PREFERRED';
  if (n >= exploratory) return 'EXPLORATORY';
  return 'INSUFFICIENT';
}

// ============================================================
// DATASET SEPARATION
// ============================================================

export type DatasetSplit = 'IN_SAMPLE' | 'VALIDATION' | 'OUT_OF_SAMPLE' | 'UNASSIGNED';

/**
 * The instant the current live gates were frozen.
 *
 * Everything recorded BEFORE this is in-sample by construction: the 93
 * closed trades are the data the opening-hour guard, the confidence floor
 * and the post-loss rules were derived from, and measuring those rules
 * against that book can only ever confirm what it was fitted to.
 *
 * Everything recorded AFTER it is out-of-sample for those rules, because the
 * rules could not have been fitted to data that did not exist. That is the
 * whole value of the date, and it is why it must never be moved: shifting it
 * forward would silently reclassify in-sample data as out-of-sample and
 * manufacture evidence.
 */
export const RULES_FROZEN_AT = Date.parse('2026-09-17T23:59:59+05:30');

/**
 * The instant the shadow layers began recording. A shadow rule's own
 * out-of-sample period starts here, not at RULES_FROZEN_AT, because before
 * this there are no observations of it at all.
 */
export const SHADOW_RECORDING_STARTED_AT = Date.parse('2026-09-21T00:00:00+05:30');

/**
 * Which dataset an observation belongs to, for a given rule.
 *
 * `frozenAt` is when the rule under test stopped changing. An observation
 * made before that instant cannot test the rule; it is part of what produced
 * it.
 */
export function datasetSplit(observedAt: number, frozenAt: number = RULES_FROZEN_AT): DatasetSplit {
  if (!Number.isFinite(observedAt)) return 'UNASSIGNED';
  return observedAt <= frozenAt ? 'IN_SAMPLE' : 'OUT_OF_SAMPLE';
}

/**
 * The promotion conditions, as a checkable structure rather than a list in
 * a document. A rule is eligible only when every one is true.
 */
export interface PromotionCheck {
  rule: string;
  sampleSize: number;
  matureObservations: number;
  outOfSampleObservations: number;
  sampleGrade: SampleGrade;
  hasOutOfSample: boolean;
  eligible: boolean;
  reason: string;
}

export function checkPromotion(input: {
  rule: string;
  sampleSize: number;
  matureObservations: number;
  outOfSampleObservations: number;
  exploratory?: number;
  preferred?: number;
}): PromotionCheck {
  const exploratory = input.exploratory ?? RESEARCH_THRESHOLDS.minPerSetupExploratory;
  const preferred = input.preferred ?? RESEARCH_THRESHOLDS.minPerSetupPreferred;
  const grade = gradeSample(input.matureObservations, exploratory, preferred);
  const hasOos = input.outOfSampleObservations >= exploratory;

  const reasons: string[] = [];
  if (input.matureObservations === 0) reasons.push('no mature observations');
  else if (grade === 'INSUFFICIENT') reasons.push(`only ${input.matureObservations} mature observations, below the ${exploratory} exploratory minimum`);
  if (!hasOos) reasons.push(`out-of-sample observations (${input.outOfSampleObservations}) below the ${exploratory} minimum`);

  return {
    rule: input.rule,
    sampleSize: input.sampleSize,
    matureObservations: input.matureObservations,
    outOfSampleObservations: input.outOfSampleObservations,
    sampleGrade: grade,
    hasOutOfSample: hasOos,
    eligible: reasons.length === 0,
    reason: reasons.length === 0 ? 'meets the sample and out-of-sample minimums' : reasons.join('; '),
  };
}

// ============================================================
// CAPTURE UNIVERSE MODE
// ============================================================

export type CaptureUniverseMode = 'ATTENTION_BASED' | 'RESEARCH_UNIVERSE';

/**
 * The mode this deployment runs in. Declared, not inferred, so a reader
 * never has to work out from row counts which one is active.
 *
 * NOT configurable at runtime on purpose. Switching to RESEARCH_UNIVERSE
 * multiplies API calls and storage by roughly the size of the F&O list, and
 * that is a decision to be taken deliberately rather than by flipping an
 * environment variable during an incident.
 */
export const CAPTURE_UNIVERSE_MODE: CaptureUniverseMode = 'ATTENTION_BASED';

export const CAPTURE_MODE_DOCUMENTATION = {
  active: CAPTURE_UNIVERSE_MODE,
  modes: {
    ATTENTION_BASED: {
      description:
        'Captures only instruments the engine is actively evaluating. The universe is whatever the bias engine read recently, tracked in Redis — it follows attention rather than a configured list.',
      advantages: [
        'Lower storage: roughly 2 MB a day rather than the whole F&O list.',
        'Lower API usage, which matters because the quote endpoints are rate-limited and the capture shares them with live decisions.',
        'Directly aligned with decision auditing — every captured chain is one a decision was actually made against.',
      ],
      disadvantages: [
        'History cannot be reconstructed for instruments ignored at the time. If the engine never looked at a symbol on a given day, that day is gone for that symbol.',
        'Introduces selection bias into any cross-instrument research: the captured set is correlated with whatever the scanner surfaced, which is itself a function of the current rules.',
      ],
      suitableFor: ['Decision auditing', 'Missed-winner analysis on refusals the engine actually made', 'Replay of decisions that were actually taken'],
      notSuitableFor: ['Unbiased cross-stock expectancy', 'Scanner backtests over the full universe', 'Opportunity analysis for instruments the engine never inspected'],
    },
    RESEARCH_UNIVERSE: {
      description:
        'Scheduled capture of a predefined F&O universe regardless of whether the engine looked at it. PREPARED BUT NOT ENABLED.',
      advantages: [
        'Unbiased historical dataset for scanner research.',
        'Missed-opportunity analysis across instruments the engine never evaluated.',
        'Setup expectancy comparable across the whole universe rather than across whatever was surfaced.',
      ],
      disadvantages: [
        'Storage and API cost scale with the universe size — roughly 15-20x the current volume for the NSE F&O list.',
        'Competes with live decisions for the same rate-limited quote endpoints.',
      ],
      enablement:
        'Requires explicit approval. Not switchable at runtime; the constant is compiled in so the change is a reviewed commit rather than a configuration flip.',
    },
  },
  selectionBiasWarning:
    'Under ATTENTION_BASED the captured set is NOT the universe. Any research that treats it as one will be measuring the scanner as much as the market. The universe-coverage diagnostic exists so that mistake is visible rather than silent.',
} as const;
