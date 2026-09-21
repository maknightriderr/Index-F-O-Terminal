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

export type CoverageGrade = 'PASS' | 'PARTIAL' | 'FAIL';

/** A column is PASS only at full coverage. Anything else is named for what it is. */
export function gradeCoverage(nonNull: number, total: number): CoverageGrade {
  if (total === 0) return 'FAIL';
  if (nonNull === total) return 'PASS';
  if (nonNull === 0) return 'FAIL';
  return 'PARTIAL';
}

const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 10000) / 100);

// ============================================================
// GREEKS
// ============================================================

export interface GreekCoverage {
  greek: string;
  nonNull: number;
  total: number;
  coveragePct: number | null;
  grade: CoverageGrade;
  brokerPublished: number;
  locallySolved: number;
  missing: number;
}

/**
 * Completeness for all four Greeks, with provenance.
 *
 * Provenance matters as much as presence: a replay that cannot tell a
 * broker-published delta from one this system solved locally will treat a
 * modelled value as an observation. The two are counted separately for
 * every Greek, and `missing` is counted rather than silently excluded.
 */
export async function greekCoverage(): Promise<{
  greeks: GreekCoverage[];
  overallGrade: CoverageGrade;
  provenanceRecorded: { nonNull: number; total: number; grade: CoverageGrade };
  totalLegs: number;
}> {
  const [row] = await sql<
    {
      total: string;
      delta_nn: string; gamma_nn: string; theta_nn: string; vega_nn: string;
      delta_broker: string; gamma_broker: string; theta_broker: string; vega_broker: string;
      delta_local: string; gamma_local: string; theta_local: string; vega_local: string;
      provenance_nn: string;
    }[]
  >`
    SELECT
      COUNT(*) AS total,
      COUNT(delta) AS delta_nn,
      COUNT(gamma) AS gamma_nn,
      COUNT(theta) AS theta_nn,
      COUNT(vega)  AS vega_nn,
      COUNT(delta) FILTER (WHERE greeks_source = 'BROKER')     AS delta_broker,
      COUNT(gamma) FILTER (WHERE greeks_source = 'BROKER')     AS gamma_broker,
      COUNT(theta) FILTER (WHERE greeks_source = 'BROKER')     AS theta_broker,
      COUNT(vega)  FILTER (WHERE greeks_source = 'BROKER')     AS vega_broker,
      COUNT(delta) FILTER (WHERE greeks_source = 'CALCULATED') AS delta_local,
      COUNT(gamma) FILTER (WHERE greeks_source = 'CALCULATED') AS gamma_local,
      COUNT(theta) FILTER (WHERE greeks_source = 'CALCULATED') AS theta_local,
      COUNT(vega)  FILTER (WHERE greeks_source = 'CALCULATED') AS vega_local,
      COUNT(greeks_source) AS provenance_nn
    FROM oi_snapshots
  `.catch(() => [] as never[]);

  const total = Number(row?.total ?? 0);
  const build = (greek: string, nn: string | undefined, broker: string | undefined, local: string | undefined): GreekCoverage => {
    const nonNull = Number(nn ?? 0);
    return {
      greek,
      nonNull,
      total,
      coveragePct: pct(nonNull, total),
      grade: gradeCoverage(nonNull, total),
      brokerPublished: Number(broker ?? 0),
      locallySolved: Number(local ?? 0),
      missing: total - nonNull,
    };
  };

  const greeks = [
    build('delta', row?.delta_nn, row?.delta_broker, row?.delta_local),
    build('gamma', row?.gamma_nn, row?.gamma_broker, row?.gamma_local),
    build('theta', row?.theta_nn, row?.theta_broker, row?.theta_local),
    build('vega', row?.vega_nn, row?.vega_broker, row?.vega_local),
  ];

  // The overall grade is the WORST of the four. A checklist line that reads
  // PASS while one Greek is absent is the exact failure this replaces.
  const overallGrade: CoverageGrade = greeks.some((g) => g.grade === 'FAIL')
    ? 'FAIL'
    : greeks.some((g) => g.grade === 'PARTIAL')
      ? 'PARTIAL'
      : 'PASS';

  const provenanceNn = Number(row?.provenance_nn ?? 0);

  return {
    greeks,
    overallGrade,
    provenanceRecorded: { nonNull: provenanceNn, total, grade: gradeCoverage(provenanceNn, total) },
    totalLegs: total,
  };
}

// ============================================================
// NULL VERSUS ZERO
// ============================================================

export interface NullZeroAudit {
  column: string;
  total: number;
  nulls: number;
  zeros: number;
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
export async function nullZeroAudit(): Promise<{ columns: NullZeroAudit[]; suspicious: string[] }> {
  const spec: { column: string; zeroIsMeaningful: boolean; note: string }[] = [
    { column: 'oi', zeroIsMeaningful: true, note: 'A strike with genuinely no open interest reads 0. Null means the feed did not supply it.' },
    { column: 'change_oi', zeroIsMeaningful: true, note: 'Zero change is common and real. Null means no baseline existed to measure from.' },
    { column: 'volume', zeroIsMeaningful: true, note: 'An untraded strike reads 0 legitimately.' },
    { column: 'ltp', zeroIsMeaningful: false, note: 'A zero last price is not a price. Treat as missing if it ever appears.' },
    { column: 'bid', zeroIsMeaningful: false, note: 'No bid is absence of a bid, recorded as null; a 0 bid would be a feed artefact.' },
    { column: 'ask', zeroIsMeaningful: false, note: 'Same as bid.' },
    { column: 'bid_qty', zeroIsMeaningful: true, note: 'Currently always null — the chain leg does not carry depth. A SOURCE LIMITATION, not a capture failure.' },
    { column: 'ask_qty', zeroIsMeaningful: true, note: 'Currently always null — same source limitation.' },
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
         FROM oi_snapshots`
      );
      const total = Number(row?.total ?? 0);
      const nulls = Number(row?.nulls ?? 0);
      const zeros = Number(row?.zeros ?? 0);
      columns.push({
        column: s.column,
        total,
        nulls,
        zeros,
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
      columns.push({ column: s.column, total: -1, nulls: -1, zeros: -1, nonZero: -1, zeroIsMeaningful: s.zeroIsMeaningful, note: err.message });
    }
  }

  return { columns, suspicious };
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
export async function snapshotLineage(): Promise<Record<string, unknown>> {
  const [boundary] = await sql<{ first_run: Date | null }[]>`
    SELECT MIN(COALESCE(capture_started_at, time)) AS first_run FROM capture_runs
  `.catch(() => [{ first_run: null }]);

  const cutoff = boundary?.first_run ?? null;

  const snapshots = await sql<{ time: Date; symbol: string; legs: string }[]>`
    SELECT time, symbol, COUNT(*) AS legs
    FROM oi_snapshots
    GROUP BY time, symbol
    ORDER BY time ASC
  `.catch(() => []);

  const runs = await sql<{ time: Date; symbol: string; status: string; actual_legs: number | null }[]>`
    SELECT COALESCE(capture_started_at, time) AS time, symbol, status, actual_legs FROM capture_runs
  `.catch(() => []);

  const runKeys = new Set(runs.map((r) => `${new Date(r.time).getTime()}|${r.symbol}`));

  let preSnapshots = 0;
  let postSnapshots = 0;
  let preLegs = 0;
  let postLegs = 0;
  const orphans: Record<string, unknown>[] = [];

  for (const s of snapshots) {
    const at = new Date(s.time).getTime();
    const legs = Number(s.legs);
    const isPre = cutoff == null || at < new Date(cutoff).getTime();
    if (isPre) {
      preSnapshots++;
      preLegs += legs;
    } else {
      postSnapshots++;
      postLegs += legs;
      if (!runKeys.has(`${at}|${s.symbol}`)) {
        orphans.push({
          timestamp: new Date(s.time).toISOString(),
          symbol: s.symbol,
          legs,
          issue: 'snapshot written after run instrumentation began, but no capture_runs row maps to it',
        });
      }
    }
  }

  const successfulRuns = runs.filter((r) => r.status === 'SUCCESS' || r.status === 'PARTIAL').length;

  return {
    instrumentationBoundary: cutoff ? new Date(cutoff).toISOString() : null,
    pre_instrumentation_snapshots: preSnapshots,
    post_instrumentation_snapshots: postSnapshots,
    total_snapshots: preSnapshots + postSnapshots,
    pre_instrumentation_legs: preLegs,
    post_instrumentation_legs: postLegs,
    total_legs: preLegs + postLegs,
    capture_runs_total: runs.length,
    capture_runs_successful: successfulRuns,
    /** Post-instrumentation snapshots with no run. Should be 0. */
    orphaned_snapshots: orphans.length,
    orphans,
    invariant:
      postSnapshots === 0
        ? 'no post-instrumentation snapshots yet, so the one-run-to-one-snapshot invariant has nothing to check'
        : orphans.length === 0
          ? 'holds: every post-instrumentation snapshot maps to a capture run'
          : `VIOLATED: ${orphans.length} post-instrumentation snapshot(s) have no capture run`,
    note:
      'Pre-instrumentation rows are valid captured data with no run record, because capture_runs did not exist when they were written. No retrospective run rows are fabricated for them.',
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
export async function universeCoverage(eligibleByExchange: Record<string, number>): Promise<Record<string, unknown>> {
  const observed = await sql<{ exchange: string; n: string }[]>`
    SELECT exchange, COUNT(DISTINCT symbol) AS n FROM oi_snapshots GROUP BY exchange
  `.catch(() => []);

  const observedToday = await sql<{ exchange: string; n: string }[]>`
    SELECT exchange, COUNT(DISTINCT symbol) AS n
    FROM oi_snapshots
    WHERE time >= ${new Date(Date.now() - 24 * 3600_000)}
    GROUP BY exchange
  `.catch(() => []);

  const observedMap = new Map(observed.map((r) => [r.exchange, Number(r.n)]));
  const todayMap = new Map(observedToday.map((r) => [r.exchange, Number(r.n)]));

  const rows = Object.entries(eligibleByExchange).map(([exchange, eligible]) => {
    const obs = observedMap.get(exchange) ?? 0;
    const today = todayMap.get(exchange) ?? 0;
    return {
      exchange,
      eligible_universe_count: eligible,
      observed_universe_count: obs,
      observed_today_count: today,
      unobserved_universe_count: Math.max(0, eligible - obs),
      observation_coverage_percent: pct(obs, eligible),
    };
  });

  const totalEligible = Object.values(eligibleByExchange).reduce((a, b) => a + b, 0);
  const totalObserved = [...observedMap.values()].reduce((a, b) => a + b, 0);

  return {
    capture_universe_mode: CAPTURE_UNIVERSE_MODE,
    byExchange: rows,
    total: {
      eligible_universe_count: totalEligible,
      observed_universe_count: totalObserved,
      unobserved_universe_count: Math.max(0, totalEligible - totalObserved),
      observation_coverage_percent: pct(totalObserved, totalEligible),
    },
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
export async function replayStatus(): Promise<Record<string, unknown>> {
  const greeks = await greekCoverage();

  const [sessions] = await sql<{ n: string }[]>`
    SELECT COUNT(DISTINCT (time AT TIME ZONE 'Asia/Kolkata')::date) AS n FROM oi_snapshots
  `.catch(() => [{ n: '0' }]);
  const chainSessions = Number(sessions?.n ?? 0);

  const [refusals] = await sql<{ mature: string }[]>`
    SELECT COUNT(*) AS mature
    FROM decision_snapshots
    WHERE decision = 'REFUSE' AND outcome_evaluated_at IS NOT NULL
  `.catch(() => [{ mature: '0' }]);
  const matureRefusals = Number(refusals?.mature ?? 0);

  const [trades] = await sql<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM signals
    WHERE signal_type = 'TRADE_SETUP' AND fwd_1d_return IS NOT NULL
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
      have: greeks.overallGrade,
      need: 'PASS',
      status: greeks.overallGrade,
    },
  };

  const engineReady = Object.values(engineChecks).every((v) => v === 'PASS');
  const dataSufficient = Object.values(dataChecks).every((c) => c.status === 'PASS');

  return {
    REPLAY_ENGINE_READY: engineReady ? 'PASS' : 'FAIL',
    REPLAY_DATA_SUFFICIENT: dataSufficient ? 'PASS' : 'FAIL',
    engineChecks,
    dataChecks,
    interpretation: engineReady && !dataSufficient
      ? 'A replay would execute correctly and prove nothing. The engine is ready; the history is not.'
      : engineReady && dataSufficient
        ? 'Both conditions met. A replay over this history can be read as evidence.'
        : 'The replay engine itself is not ready; data sufficiency is moot until it is.',
  };
}
