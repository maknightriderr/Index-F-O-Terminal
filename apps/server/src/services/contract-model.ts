// ============================================================
// CONTRACT GENERATION MODEL
// ============================================================
// The vocabulary of the capture data contract: which generation a row was
// written under, how that is decided, and the five separate properties that
// together make a row replay-eligible.
//
// Pure, and in its own module for the same reason the outcome and stop
// classifiers are: this is where the judgement lives, and a unit test should
// be able to ask whether a post-cutover row with no validity flag belongs to
// the middle generation without standing up a database pool to find out.
//
// Nothing here is read by the trading engine.
// ============================================================

export type ContractGeneration =
  /** Absence stored as zero. No validity, no provenance, no model identity. */
  | 'LEGACY_ZERO_MAPPING'
  /** Absence stored as NULL, but nothing recorded about validity or provenance. */
  | 'NULL_PRESERVING_NO_VALIDITY'
  /** Absence preserved, validity stated, provenance and model identity recorded. */
  | 'FULL_CAPTURE_CONTRACT_V1'
  /** Could not be determined — reported, never silently bucketed. */
  | 'UNCLASSIFIED';

export const CONTRACT_GENERATIONS: ContractGeneration[] = [
  'LEGACY_ZERO_MAPPING',
  'NULL_PRESERVING_NO_VALIDITY',
  'FULL_CAPTURE_CONTRACT_V1',
  'UNCLASSIFIED',
];

/**
 * The four transitions, kept separate because they are four events.
 *
 * They landed within an hour of each other, which is exactly why folding
 * them into one "post-instrumentation" concept was tempting and wrong: a
 * row written between two of them belongs to neither the old contract nor
 * the new one.
 */
export const CUTOVER_MILESTONES = [
  'capture_lineage_cutover_at',
  'data_quality_cutover_at',
  'validity_contract_cutover_at',
  'greek_provenance_cutover_at',
] as const;

export type CutoverMilestone = (typeof CUTOVER_MILESTONES)[number];

/**
 * Which generation a row belongs to, and why.
 *
 * DERIVED from persisted fields first, with the cutover milestone only as a
 * fallback for rows written before those fields existed. Never assigned by
 * renaming a population to make it look uniform: the reason string always
 * says which evidence decided it, so a reader can tell a recorded fact from
 * an inference.
 */
export function classifyGeneration(row: {
  contract_generation?: string | null;
  greeks_valid?: boolean | null;
  greeks_model_name?: string | null;
  capture_quality_version?: string | null;
  time?: Date | string | number | null;
}, dataQualityCutoverAt: number): { generation: ContractGeneration; reason: string } {
  // 1. Stamped at write time. Nothing to infer.
  if (row.contract_generation && CONTRACT_GENERATIONS.includes(row.contract_generation as ContractGeneration)) {
    return {
      generation: row.contract_generation as ContractGeneration,
      reason: 'stamped on the row at write time',
    };
  }

  // 2. Carries the validity contract's own fields. This is a recorded fact,
  //    not a date comparison.
  if (row.greeks_valid != null && row.greeks_model_name != null) {
    return {
      generation: 'FULL_CAPTURE_CONTRACT_V1',
      reason: 'row carries both greeks_valid and greeks_model_name',
    };
  }
  if (row.greeks_valid != null) {
    return {
      generation: 'FULL_CAPTURE_CONTRACT_V1',
      reason: 'row carries greeks_valid; model identity absent on this leg (broker-published Greeks carry no local model)',
    };
  }

  // 3. No validity fields. Which side of the null-preserving cutover?
  const at = row.time == null ? null : new Date(row.time).getTime();
  if (row.capture_quality_version === 'NULL_PRESERVING_V1' || (at != null && at >= dataQualityCutoverAt)) {
    return {
      generation: 'NULL_PRESERVING_NO_VALIDITY',
      reason:
        row.capture_quality_version === 'NULL_PRESERVING_V1'
          ? 'row carries capture_quality_version=NULL_PRESERVING_V1 but no validity fields'
          : 'row written at or after data_quality_cutover_at, but carries no validity fields',
    };
  }
  if (at != null) {
    return {
      generation: 'LEGACY_ZERO_MAPPING',
      reason: 'row written before data_quality_cutover_at, so absence was stored as zero',
    };
  }

  return { generation: 'UNCLASSIFIED', reason: 'no timestamp and no contract fields to classify from' };
}

// ============================================================
// REPLAY ELIGIBILITY — FIVE SEPARATE PROPERTIES
// ============================================================

/**
 * What each property means. Written here rather than in a report so the
 * definitions and the numbers cannot drift apart.
 */
export const ELIGIBILITY_DEFINITIONS = {
  VALUE_USABLE:
    'The stored numeric value is usable under the field-specific contract: present, finite, and not a placeholder the field cannot legitimately take. For a Greek this means non-null and not a degenerate exact zero on a listed option.',
  VALIDITY_KNOWN:
    'The system explicitly RECORDED whether the value was valid at capture time. A row can hold a perfectly reasonable number and still have unknown validity, because nothing was written down about it.',
  PROVENANCE_KNOWN:
    'The source is recorded: BROKER, LOCAL_MODEL or UNAVAILABLE. Without it a modelled value is indistinguishable from an observation.',
  MODEL_VERSION_KNOWN:
    'For a locally calculated Greek, the model name and version that produced it are recorded. Required because a replay comparing across a model change is comparing two different models.',
  REPLAY_ELIGIBLE:
    'The row satisfies every prerequisite of the SPECIFIC replay being run. For a Greek-dependent replay that is all four of the above. A replay that does not read Greeks has a weaker prerequisite set and a correspondingly larger eligible population.',
} as const;

