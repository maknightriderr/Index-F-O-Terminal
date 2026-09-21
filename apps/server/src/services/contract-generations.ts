// ============================================================
// CONTRACT GENERATIONS AND REPLAY ELIGIBILITY
// ============================================================
// Two things the previous release conflated, each of which made a number
// mean less than it appeared to.
//
// THE THIRD GENERATION. Rows were reported as two populations when there
// are three. Between the null-preserving cutover and the validity-column
// rollout, rows stored absence correctly but carry no validity flag, no
// provenance and no model identity. Calling all 1,066 of them
// NULL_PRESERVING_V1 implied 984 rows had metadata they do not have.
//
// FIVE PROPERTIES, NOT ONE. "83.31% replay-eligible" was reported beside
// "3,280 rows without a validity flag", which cannot both describe the same
// predicate. They do not: a stored number being usable, the system having
// RECORDED whether it was valid, knowing where it came from, knowing which
// model produced it, and a row satisfying a particular replay's
// prerequisites are five separate questions. A row can pass the first and
// fail the rest.
//
// Nothing here is read by the trading engine.
// ============================================================

import { sql } from '../lib/db.js';
import {
  CONTRACT_GENERATIONS,
  ELIGIBILITY_DEFINITIONS,
  type ContractGeneration,
} from './contract-model.js';

export {
  CONTRACT_GENERATIONS,
  CUTOVER_MILESTONES,
  ELIGIBILITY_DEFINITIONS,
  classifyGeneration,
} from './contract-model.js';
export type { ContractGeneration, CutoverMilestone } from './contract-model.js';

/**
 * The capture contract a row was written under.
 *
 * Ordered oldest to newest. Each generation is a strict superset of the
 * previous one's guarantees, so a later generation never knows less.
 */
export interface FieldEligibility {
  field: string;
  population: string;
  total: number;
  value_usable: number;
  validity_known: number;
  provenance_known: number;
  model_version_known: number;
  replay_eligible: number;
  replay_ineligible: number;
  /** Why the ineligible rows are ineligible, counted. Categories OVERLAP. */
  ineligibility_reasons: { reason: string; rows: number }[];
  overlapNote: string;
}

/**
 * Eligibility for the Greek-dependent replay, per field, per population.
 *
 * The ineligibility reasons deliberately overlap — a legacy row fails
 * validity, provenance AND model version at once — and they are reported as
 * overlapping rather than summed. Presenting them as disjoint would imply a
 * larger ineligible population than exists.
 */
export async function greekReplayEligibility(
  asOf: Date,
  dataQualityCutoverAt: number
): Promise<{ as_of: string; population_definition: string; fields: FieldEligibility[] }> {
  const fields = ['delta', 'gamma', 'theta', 'vega'];
  const out: FieldEligibility[] = [];

  const populations: { label: string; where: string }[] = [
    { label: 'ALL', where: '' },
    {
      label: 'FULL_CAPTURE_CONTRACT_V1',
      where: 'AND greeks_valid IS NOT NULL',
    },
    {
      label: 'NULL_PRESERVING_NO_VALIDITY',
      where: `AND greeks_valid IS NULL AND time >= '${new Date(dataQualityCutoverAt).toISOString()}'`,
    },
    {
      label: 'LEGACY_ZERO_MAPPING',
      where: `AND greeks_valid IS NULL AND time < '${new Date(dataQualityCutoverAt).toISOString()}'`,
    },
  ];

  for (const pop of populations) {
    for (const f of fields) {
      try {
        const [row] = await sql.unsafe<Record<string, string>[]>(
          `SELECT
             COUNT(*) AS total,
             -- VALUE_USABLE: present, and not a degenerate exact zero.
             COUNT(*) FILTER (WHERE ${f} IS NOT NULL AND ${f} <> 0) AS value_usable,
             -- VALIDITY_KNOWN: the system wrote down whether it was valid.
             COUNT(*) FILTER (WHERE greeks_valid IS NOT NULL) AS validity_known,
             -- PROVENANCE_KNOWN: we know where it came from.
             COUNT(*) FILTER (WHERE greeks_source IS NOT NULL) AS provenance_known,
             -- MODEL_VERSION_KNOWN: a locally solved Greek names its model;
             -- a broker-published one legitimately has none to name.
             COUNT(*) FILTER (
               WHERE (greeks_source = 'BROKER')
                  OR (greeks_model_name IS NOT NULL AND greeks_model_version IS NOT NULL)
             ) AS model_version_known,
             -- REPLAY_ELIGIBLE: all four, for a Greek-dependent replay.
             COUNT(*) FILTER (
               WHERE ${f} IS NOT NULL AND ${f} <> 0
                 AND greeks_valid IS TRUE
                 AND greeks_source IS NOT NULL
                 AND ((greeks_source = 'BROKER') OR (greeks_model_name IS NOT NULL AND greeks_model_version IS NOT NULL))
             ) AS replay_eligible,
             -- Overlapping reasons.
             COUNT(*) FILTER (WHERE ${f} IS NULL) AS r_null,
             COUNT(*) FILTER (WHERE ${f} = 0) AS r_zero,
             COUNT(*) FILTER (WHERE greeks_valid IS NULL) AS r_no_validity,
             COUNT(*) FILTER (WHERE greeks_valid IS FALSE) AS r_invalid,
             COUNT(*) FILTER (WHERE greeks_source IS NULL) AS r_no_provenance,
             COUNT(*) FILTER (
               WHERE greeks_source <> 'BROKER'
                 AND (greeks_model_name IS NULL OR greeks_model_version IS NULL)
             ) AS r_no_model
           FROM oi_snapshots
           WHERE time <= $1 ${pop.where}`,
          [asOf.toISOString()]
        );

        const n = (k: string) => Number(row?.[k] ?? 0);
        const total = n('total');
        const eligible = n('replay_eligible');

        out.push({
          field: f,
          population: pop.label,
          total,
          value_usable: n('value_usable'),
          validity_known: n('validity_known'),
          provenance_known: n('provenance_known'),
          model_version_known: n('model_version_known'),
          replay_eligible: eligible,
          replay_ineligible: total - eligible,
          ineligibility_reasons: [
            { reason: `${f} is NULL`, rows: n('r_null') },
            { reason: `${f} is a degenerate exact zero`, rows: n('r_zero') },
            { reason: 'validity was never recorded', rows: n('r_no_validity') },
            { reason: 'validity was recorded as false', rows: n('r_invalid') },
            { reason: 'provenance was never recorded', rows: n('r_no_provenance') },
            { reason: 'locally solved with no model name or version', rows: n('r_no_model') },
          ].filter((r) => r.rows > 0),
          overlapNote:
            'These reasons OVERLAP and must not be summed. A legacy row typically fails validity, provenance and model version simultaneously; it is one ineligible row, not three.',
        });
      } catch (err: any) {
        out.push({
          field: f,
          population: pop.label,
          total: -1,
          value_usable: -1,
          validity_known: -1,
          provenance_known: -1,
          model_version_known: -1,
          replay_eligible: -1,
          replay_ineligible: -1,
          ineligibility_reasons: [{ reason: err.message, rows: -1 }],
          overlapNote: '',
        });
      }
    }
  }

  return {
    as_of: asOf.toISOString(),
    population_definition:
      'Option-chain legs in oi_snapshots with time <= as_of. Populations are derived from persisted contract fields, falling back to the data-quality cutover milestone for rows predating those fields.',
    fields: out,
  };
}

/**
 * Rows in and out of scope for Greek-dependent research, with the reason.
 *
 * Nothing is silently removed: the excluded population is counted and the
 * overlapping reasons are listed as overlapping.
 */
export async function researchPopulationScope(
  asOf: Date,
  dataQualityCutoverAt: number
): Promise<Record<string, unknown>> {
  const [row] = await sql.unsafe<Record<string, string>[]>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (
         WHERE delta IS NOT NULL AND delta <> 0
           AND greeks_valid IS TRUE
           AND greeks_source IS NOT NULL
           AND ((greeks_source = 'BROKER') OR (greeks_model_name IS NOT NULL AND greeks_model_version IS NOT NULL))
       ) AS in_scope,
       COUNT(*) FILTER (WHERE delta IS NOT NULL AND delta <> 0) AS value_usable,
       COUNT(*) FILTER (WHERE greeks_valid IS NULL) AS no_validity,
       COUNT(*) FILTER (WHERE greeks_valid IS FALSE) AS invalid,
       COUNT(*) FILTER (WHERE greeks_model_name IS NULL AND greeks_source <> 'BROKER') AS no_model,
       COUNT(*) FILTER (WHERE quote_available IS FALSE) AS no_quote,
       COUNT(*) FILTER (WHERE time < $2) AS legacy
     FROM oi_snapshots WHERE time <= $1`,
    [asOf.toISOString(), new Date(dataQualityCutoverAt).toISOString()]
  ).catch(() => [] as never[]);

  const n = (k: string) => Number(row?.[k] ?? 0);
  const total = n('total');
  const inScope = n('in_scope');

  return {
    as_of: asOf.toISOString(),
    population_definition: 'Option-chain legs in oi_snapshots with time <= as_of, for a GREEK-DEPENDENT replay.',
    population_in_scope: inScope,
    population_excluded: total - inScope,
    total,
    exclusion_reasons: [
      { reason: 'legacy rows written before the data-quality cutover', rows: n('legacy') },
      { reason: 'validity never recorded', rows: n('no_validity') },
      { reason: 'validity recorded as false', rows: n('invalid') },
      { reason: 'locally solved with no model identity', rows: n('no_model') },
      { reason: 'no usable quote at capture time', rows: n('no_quote') },
      { reason: 'delta null or a degenerate exact zero', rows: total - n('value_usable') },
    ].filter((r) => r.rows > 0),
    overlapWarning:
      'These reasons are NOT disjoint and must not be summed. A single legacy row is typically counted under several of them. population_excluded is the authoritative figure.',
    note:
      'No row is silently dropped. A replay that excludes any of these must report the exclusion and its reason alongside its result.',
  };
}

// ============================================================
// CONTRACT GENERATION CENSUS
// ============================================================

export interface GenerationCensus {
  generation: ContractGeneration;
  rows: number;
  validity_known: number;
  provenance_known: number;
  model_version_known: number;
  stamped_at_write_time: number;
  derived_from_cutover: number;
  reason: string;
}

/**
 * Rows per contract generation, with what each generation actually knows.
 *
 * This table is the direct answer to the previous report's error: it cannot
 * show 1,066 rows under a contract when only 82 carry that contract's
 * fields, because every count comes from the fields themselves.
 */
export async function generationCensus(
  asOf: Date,
  dataQualityCutoverAt: number
): Promise<{ as_of: string; population_definition: string; generations: GenerationCensus[]; unexplained: number }> {
  const cutover = new Date(dataQualityCutoverAt).toISOString();

  const defs: { generation: ContractGeneration; where: string; reason: string }[] = [
    {
      generation: 'FULL_CAPTURE_CONTRACT_V1',
      where: "(contract_generation = 'FULL_CAPTURE_CONTRACT_V1' OR greeks_valid IS NOT NULL)",
      reason: 'stamped at write time, or carries greeks_valid',
    },
    {
      generation: 'NULL_PRESERVING_NO_VALIDITY',
      where: "(contract_generation IS NULL AND greeks_valid IS NULL AND time >= '" + cutover + "')",
      reason: 'written at or after the data-quality cutover but carries no validity fields',
    },
    {
      generation: 'LEGACY_ZERO_MAPPING',
      where: "(contract_generation IS NULL AND greeks_valid IS NULL AND time < '" + cutover + "')",
      reason: 'written before the data-quality cutover, so absence was stored as zero',
    },
  ];

  const generations: GenerationCensus[] = [];
  let classified = 0;

  for (const d of defs) {
    try {
      const [row] = await sql.unsafe<Record<string, string>[]>(
        `SELECT COUNT(*) AS rowcount,
                COUNT(*) FILTER (WHERE greeks_valid IS NOT NULL) AS validity_known,
                COUNT(*) FILTER (WHERE greeks_source IS NOT NULL) AS provenance_known,
                COUNT(*) FILTER (
                  WHERE (greeks_source = 'BROKER')
                     OR (greeks_model_name IS NOT NULL AND greeks_model_version IS NOT NULL)
                ) AS model_version_known,
                COUNT(*) FILTER (WHERE contract_generation IS NOT NULL) AS stamped,
                COUNT(*) FILTER (WHERE contract_generation IS NULL) AS derived
         FROM oi_snapshots WHERE time <= $1 AND ${d.where}`,
        [asOf.toISOString()]
      );
      const n = (k: string) => Number(row?.[k] ?? 0);
      classified += n('rowcount');
      generations.push({
        generation: d.generation,
        rows: n('rowcount'),
        validity_known: n('validity_known'),
        provenance_known: n('provenance_known'),
        model_version_known: n('model_version_known'),
        stamped_at_write_time: n('stamped'),
        derived_from_cutover: n('derived'),
        reason: d.reason,
      });
    } catch (err: any) {
      generations.push({
        generation: d.generation,
        rows: -1,
        validity_known: -1,
        provenance_known: -1,
        model_version_known: -1,
        stamped_at_write_time: -1,
        derived_from_cutover: -1,
        reason: err.message,
      });
    }
  }

  const [totalRow] = await sql<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM oi_snapshots WHERE time <= ${asOf}
  `.catch(() => [{ n: '0' }]);
  const total = Number(totalRow?.n ?? 0);

  // The generations are defined to be mutually exclusive and exhaustive. A
  // non-zero remainder means a row matched none of them, which is a
  // classification bug and is surfaced rather than absorbed.
  const unexplained = total - classified;
  if (unexplained !== 0) {
    generations.push({
      generation: 'UNCLASSIFIED',
      rows: unexplained,
      validity_known: 0,
      provenance_known: 0,
      model_version_known: 0,
      stamped_at_write_time: 0,
      derived_from_cutover: 0,
      reason: 'matched no generation definition — a classification gap, not a data property',
    });
  }

  return {
    as_of: asOf.toISOString(),
    population_definition:
      'Option-chain legs in oi_snapshots with time <= as_of. Generations are mutually exclusive and exhaustive by construction; any remainder is reported as UNCLASSIFIED.',
    generations,
    unexplained,
  };
}

// ============================================================
// DECISION POPULATION
// ============================================================

/**
 * One denominator for every decision figure in a report.
 *
 * The previous report quoted 184 decisions in one section and 137 in
 * another. The 137 was a count read at an earlier instant and then carried
 * into prose — a manually quoted number, which is exactly what this removes
 * the need for. Every count here comes from one query at one boundary, and
 * any subset states its own denominator.
 */
export async function decisionPopulation(asOf: Date, sinceHours: number): Promise<Record<string, unknown>> {
  const since = new Date(asOf.getTime() - sinceHours * 3600_000);

  const [row] = await sql<
    {
      total: string;
      with_pos: string;
      without_pos: string;
      in_120: string;
      in_unknown: string;
      takes: string;
      refusals: string;
    }[]
  >`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE minutes_from_session_open IS NOT NULL) AS with_pos,
           COUNT(*) FILTER (WHERE minutes_from_session_open IS NULL) AS without_pos,
           COUNT(*) FILTER (WHERE session_bucket = '120+') AS in_120,
           COUNT(*) FILTER (WHERE session_bucket = 'UNKNOWN' OR session_bucket IS NULL) AS in_unknown,
           COUNT(*) FILTER (WHERE decision = 'TAKE') AS takes,
           COUNT(*) FILTER (WHERE decision = 'REFUSE') AS refusals
    FROM decision_snapshots
    WHERE time >= ${since} AND time <= ${asOf}
  `.catch(() => [] as never[]);

  const n = (k: string) => Number((row as unknown as Record<string, string>)?.[k] ?? 0);

  const buckets = await sql<{ session_bucket: string | null; n: string }[]>`
    SELECT session_bucket, COUNT(*) AS n
    FROM decision_snapshots
    WHERE time >= ${since} AND time <= ${asOf}
    GROUP BY session_bucket
    ORDER BY COUNT(*) DESC
  `.catch(() => []);

  return {
    as_of: asOf.toISOString(),
    since: since.toISOString(),
    population_definition:
      'All decision_snapshots rows with since <= time <= as_of. Every decision figure in this report uses this denominator unless it states another.',
    total_decisions: n('total'),
    decisions_with_session_position: n('with_pos'),
    decisions_without_session_position: n('without_pos'),
    decisions_in_120_plus: n('in_120'),
    decisions_in_unknown: n('in_unknown'),
    takes: n('takes'),
    refusals: n('refusals'),
    bySessionBucket: buckets.map((b) => ({ bucket: b.session_bucket ?? 'NULL', n: Number(b.n) })),
    note:
      'A session position is UNKNOWN when the exchange was closed at the decision instant, so minutesSinceSessionOpen returned null. That is a property of when the decision happened, not a missing field.',
  };
}
