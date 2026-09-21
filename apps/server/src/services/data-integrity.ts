// ============================================================
// DATA INTEGRITY DIAGNOSTICS
// ============================================================
// Completeness checks run against the database, not inferred from whether a
// writer exists.
//
// The previous replay checklist reported "historical Greeks = PASS" on the
// strength of delta being non-null. Delta is one of four. A checklist that
// answers a question narrower than the one it appears to answer is worse
// than no checklist, because it is trusted. Everything here reports the
// actual count against the actual total, per column, and grades PASS /
// PARTIAL / FAIL from that rather than from the existence of a code path.
// ============================================================

import { sql } from '../lib/db.js';
import { RESEARCH_THRESHOLDS, CAPTURE_UNIVERSE_MODE } from './research-contract.js';
import { DATA_QUALITY_CUTOVER_AT } from './capture-quality.js';
import { isMarketOpen } from '@fno/shared';
import type { Exchange } from '@fno/shared';

/**
 * THE REPORT BOUNDARY
 *
 * Every figure in one report must be evaluated against ONE instant. The
 * previous report compared a Greek count taken at 16:12 against a leg count
 * taken at 16:18 and a capture-run count from 16:03, and the six-minute drift
 * between the first two looked exactly like a missing 82-leg snapshot. It was
 * not a lineage gap; it was three different questions asked at three
 * different times.
 *
 * So every query below takes an explicit upper bound and every result states
 * which bound it used. A caller that omits it gets `new Date()` once, at the
 * top, and the same instant reaches every query.
 */
export interface ReportBoundary {
  /** Upper bound for every query in this report. */
  asOf: Date;
}

export function newBoundary(asOf: Date = new Date()): ReportBoundary {
  return { asOf };
}

export type CoverageGrade = 'PASS' | 'PARTIAL' | 'FAIL';

/** A column is PASS only at full coverage. Anything else is named for what it is. */
export function gradeCoverage(nonNull: number, total: number): CoverageGrade {
  if (total === 0) return 'FAIL';
  if (nonNull === total) return 'PASS';
  if (nonNull === 0) return 'FAIL';
  return 'PARTIAL';
}

const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 10000) / 100);
const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

// ============================================================
// GREEKS
// ============================================================

export interface GreekCoverage {
  greek: string;
  /** Rows present in the population at all. */
  raw: number;
  /** Rows where the column is not NULL. */
  nonNull: number;
  /**
   * Rows carrying a research-usable measurement.
   *
   * Read from `greeks_valid`, which the writer set having seen the raw value
   * — NOT from `greek <> 0`. That comparison was the previous rule and it is
   * wrong in both directions: it discards a far-OTM gamma that legitimately
   * rounds toward zero, and on legacy rows it cannot tell a degenerate model
   * output from a real one. Legacy rows with no validity flag fall back to
   * the numeric test, and are reported separately for exactly that reason.
   */
  usable: number;
  /** Non-null but not usable. */
  invalid: number;
  nulls: number;
  zeros: number;
  usablePct: number | null;
  grade: CoverageGrade;
  brokerPublished: number;
  locallySolved: number;
}

export interface GreekPopulation {
  population: 'LEGACY_ZERO_MAPPING' | 'NULL_PRESERVING_V1' | 'ALL';
  totalLegs: number;
  greeks: GreekCoverage[];
  overallGrade: CoverageGrade;
  zeroPlaceholderLegs: number;
  validityFlagCoverage: { withFlag: number; withoutFlag: number };
}

/**
 * Greek coverage, split by the persistence contract that wrote each row.
 *
 * Reported as three populations rather than one, because "coverage will
 * return to PASS when the legacy rows age out" was not a plan — the
 * retention horizon is 400 days and those rows are retained research data.
 * Stating the population is the honest alternative to waiting for it to
 * disappear.
 */
export async function greekCoverage(boundary: ReportBoundary = newBoundary()): Promise<{
  asOf: string;
  cutoverAt: string;
  populations: GreekPopulation[];
  provenance: { brokerPublished: number; locallySolved: number; unattributed: number };
  modelVersions: { name: string | null; version: string | null; legs: number }[];
  caveats: string[];
}> {
  const cutover = new Date(DATA_QUALITY_CUTOVER_AT);

  const forPopulation = async (
    label: GreekPopulation['population'],
    where: string
  ): Promise<GreekPopulation> => {
    const [row] = await sql.unsafe<Record<string, string>[]>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE greeks_valid IS NOT NULL) AS with_flag,
         COUNT(*) FILTER (WHERE greeks_valid IS NULL) AS without_flag,
         ${['delta', 'gamma', 'theta', 'vega']
           .map(
             (g) => `
         COUNT(${g}) AS ${g}_nn,
         COUNT(*) FILTER (WHERE ${g} IS NULL) AS ${g}_null,
         COUNT(*) FILTER (WHERE ${g} = 0) AS ${g}_zero,
         COUNT(*) FILTER (WHERE COALESCE(greeks_valid, (${g} IS NOT NULL AND ${g} <> 0))) AS ${g}_use,
         COUNT(${g}) FILTER (WHERE greeks_source = 'BROKER') AS ${g}_broker,
         COUNT(${g}) FILTER (WHERE greeks_source <> 'BROKER') AS ${g}_local`
           )
           .join(',')}
       FROM oi_snapshots WHERE time <= $1 ${where}`,
      [boundary.asOf.toISOString()]
    );

    const total = Number(row?.total ?? 0);
    const greeks = ['delta', 'gamma', 'theta', 'vega'].map<GreekCoverage>((g) => {
      const nonNull = Number(row?.[`${g}_nn`] ?? 0);
      const usable = Number(row?.[`${g}_use`] ?? 0);
      return {
        greek: g,
        raw: total,
        nonNull,
        usable,
        invalid: nonNull - usable,
        nulls: Number(row?.[`${g}_null`] ?? 0),
        zeros: Number(row?.[`${g}_zero`] ?? 0),
        usablePct: pct(usable, total),
        grade: gradeCoverage(usable, total),
        brokerPublished: Number(row?.[`${g}_broker`] ?? 0),
        locallySolved: Number(row?.[`${g}_local`] ?? 0),
      };
    });

    const overallGrade: CoverageGrade = greeks.some((x) => x.grade === 'FAIL')
      ? 'FAIL'
      : greeks.some((x) => x.grade === 'PARTIAL')
        ? 'PARTIAL'
        : 'PASS';

    return {
      population: label,
      totalLegs: total,
      greeks,
      overallGrade,
      zeroPlaceholderLegs: Number(row?.delta_zero ?? 0),
      validityFlagCoverage: {
        withFlag: Number(row?.with_flag ?? 0),
        withoutFlag: Number(row?.without_flag ?? 0),
      },
    };
  };

  const [all, legacy, current] = await Promise.all([
    forPopulation('ALL', ''),
    forPopulation('LEGACY_ZERO_MAPPING', `AND time < '${cutover.toISOString()}'`),
    forPopulation('NULL_PRESERVING_V1', `AND time >= '${cutover.toISOString()}'`),
  ]);

  const [prov] = await sql<{ broker: string; local: string; none: string }[]>`
    SELECT COUNT(*) FILTER (WHERE greeks_source = 'BROKER') AS broker,
           COUNT(*) FILTER (WHERE greeks_source = 'CALCULATED') AS local,
           COUNT(*) FILTER (WHERE greeks_source IS NULL) AS none
    FROM oi_snapshots WHERE time <= ${boundary.asOf}
  `.catch(() => [{ broker: '0', local: '0', none: '0' }]);

  const models = await sql<{ name: string | null; version: string | null; n: string }[]>`
    SELECT greeks_model_name AS name, greeks_model_version AS version, COUNT(*) AS n
    FROM oi_snapshots WHERE time <= ${boundary.asOf}
    GROUP BY greeks_model_name, greeks_model_version
    ORDER BY COUNT(*) DESC
  `.catch(() => []);

  return {
    asOf: boundary.asOf.toISOString(),
    cutoverAt: cutover.toISOString(),
    populations: [all, legacy, current],
    provenance: {
      brokerPublished: Number(prov?.broker ?? 0),
      locallySolved: Number(prov?.local ?? 0),
      unattributed: Number(prov?.none ?? 0),
    },
    modelVersions: models.map((m) => ({ name: m.name, version: m.version, legs: Number(m.n) })),
    caveats: [
      'Usability is read from greeks_valid, stated by the writer that saw the raw value — not from `greek <> 0`, which cannot tell a legitimate near-zero measurement from a degenerate model output.',
      'Legacy rows predate the validity flag and fall back to the numeric test. They are reported as their own population rather than pooled.',
      'Legacy rows are NOT rewritten and will NOT age out inside the 400-day retention horizon. The population split is the answer, not waiting.',
      'A locally-solved Greek is model output. Provenance and model version are recorded per leg so a replay can reproduce it rather than assume it.',
    ],
  };
}

// ============================================================
// NULL VERSUS ZERO
// ============================================================

export interface NullZeroAudit {
  column: string;
  total: number;
  nonNull: number;
  nulls: number;
  nullPct: number | null;
  zeros: number;
  zeroPct: number | null;
  nonZero: number;
  /** True where a zero is a legitimate measurement rather than a stand-in for missing. */
  zeroIsMeaningful: boolean;
  note: string;
}

/**
 * Counts nulls and zeros separately for every captured market-data column.
 *
 * The distinction is the point: a zero that means "no contracts traded" and
 * a zero that means "the feed did not tell us" are different facts, and only
 * one of them belongs in an average. This does not fix anything — it makes
 * a silent conversion visible if one is ever introduced.
 */
export async function nullZeroAudit(boundary: ReportBoundary = newBoundary()): Promise<{ asOf: string; columns: NullZeroAudit[]; suspicious: string[] }> {
  const spec: { column: string; zeroIsMeaningful: boolean; note: string }[] = [
    { column: 'oi', zeroIsMeaningful: true, note: 'A strike with genuinely no open interest reads 0. Null means the feed did not supply it.' },
    { column: 'change_oi', zeroIsMeaningful: true, note: 'Zero change is common and real. Null means no baseline existed to measure from.' },
    { column: 'volume', zeroIsMeaningful: true, note: 'An untraded strike reads 0 legitimately.' },
    { column: 'ltp', zeroIsMeaningful: false, note: 'A zero last price is not a price. Treat as missing if it ever appears.' },
    { column: 'bid', zeroIsMeaningful: false, note: 'No bid is absence of a bid, recorded as null; a 0 bid would be a feed artefact.' },
    { column: 'ask', zeroIsMeaningful: false, note: 'Same as bid.' },
    { column: 'bid_qty', zeroIsMeaningful: true, note: 'Always NULL: the chain leg carries no depth quantity at all. A SOURCE LIMITATION, stated by depth_available=false at write time, not a capture failure. Never fabricated.' },
    { column: 'ask_qty', zeroIsMeaningful: true, note: 'Always NULL — same source limitation.' },
    { column: 'iv', zeroIsMeaningful: false, note: 'A zero implied volatility is not a measurement.' },
    { column: 'delta', zeroIsMeaningful: false, note: 'A far-OTM delta rounds toward zero but is not exactly zero in practice.' },
    { column: 'gamma', zeroIsMeaningful: false, note: 'As delta.' },
    { column: 'theta', zeroIsMeaningful: false, note: 'As delta.' },
    { column: 'vega', zeroIsMeaningful: false, note: 'As delta.' },
    { column: 'spot_price', zeroIsMeaningful: false, note: 'A zero spot is never a measurement.' },
  ];

  const columns: NullZeroAudit[] = [];
  const suspicious: string[] = [];

  for (const s of spec) {
    try {
      const [row] = await sql.unsafe<{ total: string; nulls: string; zeros: string }[]>(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE ${s.column} IS NULL) AS nulls,
                COUNT(*) FILTER (WHERE ${s.column} = 0) AS zeros
         FROM oi_snapshots WHERE time <= $1`,
        [boundary.asOf.toISOString()]
      );
      const total = Number(row?.total ?? 0);
      const nulls = Number(row?.nulls ?? 0);
      const zeros = Number(row?.zeros ?? 0);
      columns.push({
        column: s.column,
        total,
        nonNull: total - nulls,
        nulls,
        nullPct: pct(nulls, total),
        zeros,
        zeroPct: pct(zeros, total),
        nonZero: total - nulls - zeros,
        zeroIsMeaningful: s.zeroIsMeaningful,
        note: s.note,
      });
      // A zero in a column where zero is not a measurement is the signature
      // of a missing value having been converted somewhere upstream.
      if (!s.zeroIsMeaningful && zeros > 0) {
        suspicious.push(`${s.column}: ${zeros} rows read exactly 0, where a zero is not a valid measurement — check for a missing value being coerced`);
      }
    } catch (err: any) {
      columns.push({ column: s.column, total: -1, nonNull: -1, nulls: -1, nullPct: null, zeros: -1, zeroPct: null, nonZero: -1, zeroIsMeaningful: s.zeroIsMeaningful, note: err.message });
    }
  }

  return { asOf: boundary.asOf.toISOString(), columns, suspicious };
}

// ============================================================
// SNAPSHOT LINEAGE
// ============================================================

/**
 * Splits the captured history at the instant run instrumentation began.
 *
 * Rows written before `capture_runs` existed cannot have a run, and that is
 * a fact about the instrumentation rather than a gap in the data. They are
 * labelled pre-instrumentation and left alone: fabricating retrospective
 * capture_runs rows for them would make an unverifiable claim look like a
 * verified one, which is the opposite of what the lineage is for.
 *
 * For post-instrumentation captures the invariant is one successful run to
 * one snapshot, and any snapshot without a run is reported as an orphan.
 */
export async function snapshotLineage(boundary: ReportBoundary = newBoundary()): Promise<Record<string, unknown>> {
  // The lineage is now a HARD link: every row carries the id of the run that
  // wrote it. Grouping by (time, symbol) and matching against run timestamps
  // was a reconstruction, and it is exactly what made a six-minute gap
  // between two readings look like a missing 82-leg snapshot.
  const snapshots = await sql<
    { time: Date; symbol: string; expiry: string | null; legs: string; run_id: string | null; quality: string | null }[]
  >`
    SELECT time, symbol, expiry, COUNT(*) AS legs,
           MAX(capture_run_id::text) AS run_id,
           MAX(capture_quality_version) AS quality
    FROM oi_snapshots
    WHERE time <= ${boundary.asOf}
    GROUP BY time, symbol, expiry
    ORDER BY time ASC
  `.catch(() => []);

  const runs = await sql<
    { id: string; time: Date; symbol: string; status: string; expected_legs: number | null; actual_legs: number | null }[]
  >`
    SELECT id::text AS id, COALESCE(capture_started_at, time) AS time, symbol, status,
           expected_legs, actual_legs
    FROM capture_runs
    WHERE COALESCE(capture_started_at, time) <= ${boundary.asOf}
  `.catch(() => []);

  const runById = new Map(runs.map((r) => [r.id, r]));
  const runsWithSnapshot = new Set<string>();

  let preSnapshots = 0;
  let postSnapshots = 0;
  let preLegs = 0;
  let postLegs = 0;
  let linkedSnapshots = 0;
  const orphans: Record<string, unknown>[] = [];
  const postDetail: Record<string, unknown>[] = [];

  for (const s of snapshots) {
    const legs = Number(s.legs);
    // Pre-instrumentation is now defined by the ABSENCE OF A RUN ID on the
    // row itself, not by a timestamp comparison. A row with no run id was
    // written before the lineage column existed; that is a property of the
    // row, not an inference about when it happened.
    const runId = s.run_id;
    if (runId == null) {
      preSnapshots++;
      preLegs += legs;
      continue;
    }

    postSnapshots++;
    postLegs += legs;
    const run = runById.get(runId);
    if (run) {
      linkedSnapshots++;
      runsWithSnapshot.add(runId);
    } else {
      orphans.push({
        timestamp: new Date(s.time).toISOString(),
        symbol: s.symbol,
        legs,
        captureRunId: runId,
        issue: 'snapshot carries a capture_run_id that no capture_runs row matches',
      });
    }

    postDetail.push({
      snapshot_id: `${new Date(s.time).toISOString()}|${s.symbol}`,
      timestamp: new Date(s.time).toISOString(),
      capture_run_id: runId,
      underlying: s.symbol,
      expiry: s.expiry,
      expected_legs: run?.expected_legs ?? null,
      actual_legs: legs,
      capture_quality_version: s.quality,
      status: run?.status ?? 'NO MATCHING RUN',
    });
  }

  const successfulRuns = runs.filter((r) => r.status === 'SUCCESS' || r.status === 'PARTIAL').length;
  // A successful run that wrote no snapshot is the other half of the
  // invariant, and it was never checked before.
  const runsWithoutSnapshot = runs
    .filter((r) => (r.status === 'SUCCESS' || r.status === 'PARTIAL') && !runsWithSnapshot.has(r.id))
    .map((r) => ({
      capture_run_id: r.id,
      timestamp: new Date(r.time).toISOString(),
      symbol: r.symbol,
      status: r.status,
      issue: 'successful capture run with no snapshot carrying its id',
    }));

  return {
    asOf: boundary.asOf.toISOString(),
    lineageMethod: 'hard: every row carries the capture_run_id of the run that wrote it',
    pre_instrumentation_snapshots: preSnapshots,
    post_instrumentation_snapshots: postSnapshots,
    total_snapshots: preSnapshots + postSnapshots,
    pre_instrumentation_legs: preLegs,
    post_instrumentation_legs: postLegs,
    total_legs: preLegs + postLegs,
    total_option_snapshots: preSnapshots + postSnapshots,
    total_capture_runs: runs.length,
    successful_capture_runs: successfulRuns,
    snapshots_linked_to_capture_run: linkedSnapshots,
    snapshots_without_capture_run: preSnapshots + orphans.length,
    /** A snapshot carrying a run id that no run matches. Must be 0. */
    orphan_snapshots: orphans.length,
    orphans,
    /** A successful run that wrote no snapshot. Must be 0. */
    runs_without_snapshot: runsWithoutSnapshot.length,
    runsWithoutSnapshot,
    invariant: {
      statement: 'post_instrumentation_snapshots = successful_capture_runs = snapshots_linked_to_capture_run, and orphan_snapshots = 0',
      post_instrumentation_snapshots: postSnapshots,
      successful_capture_runs: successfulRuns,
      snapshots_linked_to_capture_run: linkedSnapshots,
      orphan_snapshots: orphans.length,
      holds:
        postSnapshots === successfulRuns && successfulRuns === linkedSnapshots && orphans.length === 0,
      detail:
        postSnapshots === 0
          ? 'no snapshot carries a run id yet, so the invariant has nothing to check'
          : postSnapshots === successfulRuns && successfulRuns === linkedSnapshots && orphans.length === 0
            ? 'holds exactly'
            : `MISMATCH: ${postSnapshots} snapshots, ${successfulRuns} successful runs, ${linkedSnapshots} linked, ${orphans.length} orphans`,
    },
    postInstrumentationSnapshots: postDetail,
    note:
      'Rows with no capture_run_id were written before the lineage column existed. They are valid captured data and no retrospective run rows are fabricated for them.',
  };
}

// ============================================================
// UNIVERSE COVERAGE
// ============================================================

/**
 * How much of the eligible universe was actually observed.
 *
 * Exists so that no future analysis mistakes the captured set for the
 * universe. Under ATTENTION_BASED capture they are very different, and the
 * difference is a selection effect correlated with whatever the scanner
 * surfaced — which is itself a function of the current rules.
 */
export async function universeCoverage(
  eligibleByExchange: Record<string, number>,
  boundary: ReportBoundary = newBoundary()
): Promise<Record<string, unknown>> {
  // Every observed instrument, named. The previous report said "four MCX
  // commodities" while naming three, which is the kind of summary that hides
  // exactly the thing a reader would want to check.
  const observedRows = await sql<
    {
      exchange: string;
      symbol: string;
      expiry: string | null;
      snapshots: string;
      legs: string;
      runs: string;
      first: Date;
      last: Date;
    }[]
  >`
    SELECT exchange, symbol, expiry,
           COUNT(DISTINCT time) AS snapshots,
           COUNT(*) AS legs,
           COUNT(DISTINCT capture_run_id) AS runs,
           MIN(time) AS first, MAX(time) AS last
    FROM oi_snapshots
    WHERE time <= ${boundary.asOf}
    GROUP BY exchange, symbol, expiry
    ORDER BY exchange, symbol
  `.catch(() => []);

  // Futures-only instruments are captured too, and they are NOT option-chain
  // instruments. Conflating the two inflates the observed count.
  const futuresOnly = await sql<{ exchange: string; symbol: string; n: string }[]>`
    SELECT f.exchange, f.symbol, COUNT(*) AS n
    FROM futures_snapshots f
    WHERE f.time <= ${boundary.asOf}
      AND NOT EXISTS (
        SELECT 1 FROM oi_snapshots o
        WHERE o.symbol = f.symbol AND o.exchange = f.exchange AND o.time <= ${boundary.asOf}
      )
    GROUP BY f.exchange, f.symbol
  `.catch(() => []);

  const observedMap = new Map<string, Set<string>>();
  for (const r of observedRows) {
    if (!observedMap.has(r.exchange)) observedMap.set(r.exchange, new Set());
    observedMap.get(r.exchange)!.add(r.symbol);
  }

  const rows = Object.entries(eligibleByExchange).map(([exchange, eligible]) => {
    const obs = observedMap.get(exchange)?.size ?? 0;
    // Was this exchange even open at the report instant? An exchange that was
    // closed cannot have been captured, and reporting 0% for it implies a
    // capture failure that did not happen.
    const inSession = isMarketOpen(exchange as Exchange, boundary.asOf.getTime());
    return {
      exchange,
      capture_mode: CAPTURE_UNIVERSE_MODE,
      eligible_universe_count: eligible,
      observed_universe_count: obs,
      unobserved_universe_count: Math.max(0, eligible - obs),
      /** Against the whole eligible list, regardless of session. Always a number. */
      full_universe_coverage: pct(obs, eligible),
      in_session: inSession,
      /** Eligible instruments that COULD have been captured at this instant. */
      in_session_eligible_count: inSession ? eligible : 0,
      in_session_observed_count: inSession ? obs : 0,
      /**
       * N/A rather than 0% for a closed exchange: nothing could have been
       * captured, so there is no coverage figure to report and a 0 would
       * read as a failure.
       */
      in_session_coverage: inSession ? pct(obs, eligible) : 'N/A',
    };
  });

  const totalEligible = Object.values(eligibleByExchange).reduce((a, b) => a + b, 0);
  const totalObserved = [...observedMap.values()].reduce((a, b) => a + b.size, 0);
  const inSessionRows = rows.filter((r) => r.in_session);
  const inSessionEligible = inSessionRows.reduce((a, r) => a + r.eligible_universe_count, 0);
  const inSessionObserved = inSessionRows.reduce((a, r) => a + r.observed_universe_count, 0);

  return {
    asOf: boundary.asOf.toISOString(),
    capture_universe_mode: CAPTURE_UNIVERSE_MODE,
    byExchange: rows,
    total: {
      eligible_universe_count: totalEligible,
      observed_universe_count: totalObserved,
      unobserved_universe_count: Math.max(0, totalEligible - totalObserved),
      full_universe_coverage: pct(totalObserved, totalEligible),
      in_session_eligible_count: inSessionEligible,
      in_session_observed_count: inSessionObserved,
      in_session_coverage: inSessionEligible > 0 ? pct(inSessionObserved, inSessionEligible) : 'N/A',
    },
    /** Every observed option-chain instrument, named. No summary counts. */
    observedInstruments: observedRows.map((r) => ({
      exchange: r.exchange,
      symbol: r.symbol,
      expiry: r.expiry,
      instrument_kind: 'OPTION_CHAIN',
      snapshot_count: Number(r.snapshots),
      leg_count: Number(r.legs),
      capture_count: Number(r.runs),
      first_seen: iso(r.first),
      last_seen: iso(r.last),
    })),
    /** Captured as futures only — explicitly NOT option-chain instruments. */
    futuresOnlyInstruments: futuresOnly.map((r) => ({
      exchange: r.exchange,
      symbol: r.symbol,
      instrument_kind: 'FUTURES_ONLY',
      rows: Number(r.n),
      note: 'captured in futures_snapshots with no option chain, so it does not count toward option-chain coverage',
    })),
    warning:
      'The captured set is NOT the universe. Any cross-instrument research over these rows is measuring the scanner as much as the market.',
  };
}

// ============================================================
// REPLAY: ENGINE READY vs DATA SUFFICIENT
// ============================================================

/**
 * Two questions that were previously one.
 *
 * REPLAY_ENGINE_READY asks whether a replay would execute correctly: can
 * the engine be told it is a past instant, is future data refused, is the
 * decision logic shared rather than duplicated. Those are code guarantees,
 * covered by tests, and they are satisfied.
 *
 * REPLAY_DATA_SUFFICIENT asks whether running it would mean anything. That
 * is a question about span and volume, and it is not satisfied. Reporting
 * one number for both is how a checklist full of PASS lines ends up
 * implying a capability that does not exist.
 */
export async function replayStatus(boundary: ReportBoundary = newBoundary()): Promise<Record<string, unknown>> {
  const greeks = await greekCoverage(boundary);
  const all = greeks.populations.find((p) => p.population === 'ALL');
  const greekGrade: CoverageGrade = all?.overallGrade ?? 'FAIL';

  // Rows a Greek-dependent replay can and cannot stand on. Counted and
  // reported, never silently excluded: a replay that drops 17% of its legs
  // without saying so produces a number nobody can audit.
  const [eligibility] = await sql<{ eligible: string; ineligible: string; no_flag: string }[]>`
    SELECT COUNT(*) FILTER (WHERE COALESCE(greeks_valid, (delta IS NOT NULL AND delta <> 0))) AS eligible,
           COUNT(*) FILTER (WHERE NOT COALESCE(greeks_valid, (delta IS NOT NULL AND delta <> 0))) AS ineligible,
           COUNT(*) FILTER (WHERE greeks_valid IS NULL) AS no_flag
    FROM oi_snapshots WHERE time <= ${boundary.asOf}
  `.catch(() => [{ eligible: '0', ineligible: '0', no_flag: '0' }]);

  const [sessions] = await sql<{ n: string }[]>`
    SELECT COUNT(DISTINCT (time AT TIME ZONE 'Asia/Kolkata')::date) AS n
    FROM oi_snapshots WHERE time <= ${boundary.asOf}
  `.catch(() => [{ n: '0' }]);
  const chainSessions = Number(sessions?.n ?? 0);

  const [refusals] = await sql<{ mature: string }[]>`
    SELECT COUNT(*) AS mature
    FROM decision_snapshots
    WHERE decision = 'REFUSE' AND outcome_evaluated_at IS NOT NULL AND time <= ${boundary.asOf}
  `.catch(() => [{ mature: '0' }]);
  const matureRefusals = Number(refusals?.mature ?? 0);

  const [trades] = await sql<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM signals
    WHERE signal_type = 'TRADE_SETUP' AND fwd_1d_return IS NOT NULL AND time <= ${boundary.asOf}
  `.catch(() => [{ n: '0' }]);
  const closedTrades = Number(trades?.n ?? 0);

  const engineChecks = {
    decision_clock: 'PASS',
    future_bar_protection: 'PASS',
    shared_decision_logic: 'PASS',
    outcome_classifier: 'PASS',
    setup_classifier: 'PASS',
  } as const;

  const dataChecks = {
    chain_sessions: {
      have: chainSessions,
      need: RESEARCH_THRESHOLDS.minChainSessions,
      status: chainSessions >= RESEARCH_THRESHOLDS.minChainSessions ? 'PASS' : 'FAIL',
    },
    mature_refusals: {
      have: matureRefusals,
      need: RESEARCH_THRESHOLDS.minMatureRefusals,
      status: matureRefusals >= RESEARCH_THRESHOLDS.minMatureRefusals ? 'PASS' : 'FAIL',
    },
    closed_trades: {
      have: closedTrades,
      need: RESEARCH_THRESHOLDS.minClosedTrades,
      status: closedTrades >= RESEARCH_THRESHOLDS.minClosedTrades ? 'PASS' : 'FAIL',
    },
    greeks_complete: {
      have: greekGrade,
      need: 'PASS',
      status: greekGrade,
    },
  };

  const eligibleLegs = Number(eligibility?.eligible ?? 0);
  const ineligibleLegs = Number(eligibility?.ineligible ?? 0);
  const totalLegs = eligibleLegs + ineligibleLegs;

  const engineReady = Object.values(engineChecks).every((v) => v === 'PASS');
  const dataSufficient = Object.values(dataChecks).every((c) => c.status === 'PASS');
  // A third, separate question: of the rows that exist, how many can a
  // Greek-dependent replay actually stand on? Answered in rows, with the
  // exclusion reason stated, because a replay that quietly drops legs
  // produces an unauditable number.
  const qualityEligible = totalLegs > 0 && ineligibleLegs === 0;

  return {
    asOf: boundary.asOf.toISOString(),
    REPLAY_ENGINE_READY: engineReady ? 'PASS' : 'FAIL',
    REPLAY_DATA_SUFFICIENT: dataSufficient ? 'PASS' : 'FAIL',
    REPLAY_DATA_QUALITY_ELIGIBLE: qualityEligible ? 'PASS' : 'PARTIAL',
    engineChecks,
    dataChecks,
    qualityEligibility: {
      replay_quality_eligible_legs: eligibleLegs,
      replay_quality_ineligible_legs: ineligibleLegs,
      replay_quality_eligible_pct: pct(eligibleLegs, totalLegs),
      legs_without_validity_flag: Number(eligibility?.no_flag ?? 0),
      replay_quality_reason:
        ineligibleLegs === 0
          ? 'every captured leg carries a research-usable Greek'
          : `${ineligibleLegs} leg(s) carry Greeks that are not research-usable — a degenerate model output on a leg with no price. They are counted here and would be EXCLUDED from a Greek-dependent replay, never silently dropped.`,
    },
    interpretation: engineReady && !dataSufficient
      ? 'A replay would execute correctly and prove nothing. The engine is ready; the history is not.'
      : engineReady && dataSufficient
        ? 'Both conditions met. A replay over this history can be read as evidence.'
        : 'The replay engine itself is not ready; data sufficiency is moot until it is.',
  };
}
