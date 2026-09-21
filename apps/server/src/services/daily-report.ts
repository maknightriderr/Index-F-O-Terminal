// ============================================================
// DAILY CAPTURE-QUALITY REPORT
// ============================================================
// End-of-day assembly of everything the capture and decision record hold.
//
// Two rules govern every figure here, and they are the whole point of the
// module rather than caveats on it:
//
//   EVERY PERCENTAGE CARRIES ITS SAMPLE SIZE. A win rate with no N beside
//   it is not a statistic, it is a number that looks like one. So each
//   breakdown returns `n` alongside its rates, and the renderer has no way
//   to show one without the other.
//
//   MATURE AND IMMATURE OBSERVATIONS ARE NEVER MIXED. A refusal that has
//   not aged past its evaluation horizon has no outcome yet. Counting it as
//   a good rejection because it has not been graded would make every filter
//   look better the more recently it fired.
//
// Nothing in this module is read by the trading engine. It cannot influence
// a decision, and the `exploratory` flag on small samples exists so a reader
// cannot mistake an n=3 bucket for evidence.
// ============================================================

import { sql } from '../lib/db.js';
import { INTRADAY_HORIZON_MS, POSITIONAL_HORIZON_MS } from './missed-winner-audit.js';

/** Below this, a breakdown is flagged exploratory and must not drive a decision. */
export const MIN_SAMPLE_FOR_INFERENCE = 30;

export interface BucketStat {
  bucket: string;
  n: number;
  /** Null rather than 0 when nothing has been graded — an ungraded bucket has no rate. */
  winRate: number | null;
  avgR: number | null;
  medianR: number | null;
  mfeAtr: number | null;
  maeAtr: number | null;
  targetHitRate: number | null;
  stopRate: number | null;
  missedWinnerRate: number | null;
  mature: number;
  immature: number;
  exploratory: boolean;
}

const round = (n: number | null, d = 3): number | null =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

interface DecisionRow {
  decision: string;
  mode: string;
  time: Date;
  outcome_class: string | null;
  outcome_r: string | null;
  outcome_mfe_atr: string | null;
  outcome_mae_atr: string | null;
  outcome_hit_target: boolean | null;
  outcome_hit_stop: boolean | null;
  session_bucket: string | null;
  setup_family: string | null;
  setup_type: string | null;
  target_atr: string | null;
  regime: string | null;
  option_quality_grade: string | null;
  graded: boolean;
}

const num = (v: string | number | null): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Builds one bucket's statistics.
 *
 * Rates are computed over GRADED rows only; `n` reports every row in the
 * bucket, and `mature`/`immature` say how that splits. A bucket where
 * nothing has been graded returns nulls for every rate rather than zeros,
 * because "no wins yet" and "zero percent win rate" are different claims.
 */
function bucketStat(bucket: string, rows: DecisionRow[], now: number): BucketStat {
  let mature = 0;
  let immature = 0;
  for (const r of rows) {
    const horizon = r.mode === 'POSITIONAL' ? POSITIONAL_HORIZON_MS : INTRADAY_HORIZON_MS;
    if (now - new Date(r.time).getTime() >= horizon) mature++;
    else immature++;
  }

  const graded = rows.filter((r) => r.graded && r.outcome_class !== 'UNKNOWN');
  const rs = graded.map((r) => num(r.outcome_r)).filter((x): x is number => x != null);
  const wins = rs.filter((x) => x > 0).length;
  const mfes = graded.map((r) => num(r.outcome_mfe_atr)).filter((x): x is number => x != null);
  const maes = graded.map((r) => num(r.outcome_mae_atr)).filter((x): x is number => x != null);
  const targets = graded.filter((r) => r.outcome_hit_target === true).length;
  const stops = graded.filter((r) => r.outcome_hit_stop === true).length;
  const missed = graded.filter((r) => r.outcome_class === 'MISSED_WINNER').length;

  return {
    bucket,
    n: rows.length,
    winRate: rs.length > 0 ? round((wins / rs.length) * 100, 1) : null,
    avgR: rs.length > 0 ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    medianR: round(median(rs)),
    mfeAtr: mfes.length > 0 ? round(mfes.reduce((a, b) => a + b, 0) / mfes.length) : null,
    maeAtr: maes.length > 0 ? round(maes.reduce((a, b) => a + b, 0) / maes.length) : null,
    targetHitRate: graded.length > 0 ? round((targets / graded.length) * 100, 1) : null,
    stopRate: graded.length > 0 ? round((stops / graded.length) * 100, 1) : null,
    missedWinnerRate: graded.length > 0 ? round((missed / graded.length) * 100, 1) : null,
    mature,
    immature,
    exploratory: graded.length < MIN_SAMPLE_FOR_INFERENCE,
  };
}

function groupBy(rows: DecisionRow[], key: (r: DecisionRow) => string | null, now: number): BucketStat[] {
  const groups = new Map<string, DecisionRow[]>();
  for (const r of rows) {
    const k = key(r) ?? 'UNKNOWN';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.entries()]
    .map(([bucket, rs]) => bucketStat(bucket, rs, now))
    .sort((a, b) => b.n - a.n);
}

/**
 * The end-of-day report.
 *
 * `sinceHours` defaults to a full day. Passing a longer window is how the
 * same breakdowns are read over the accumulating record, which is the only
 * way any of these buckets will ever reach a usable sample size.
 */
export async function dailyReport(sinceHours = 24): Promise<Record<string, unknown>> {
  const now = Date.now();
  const since = new Date(now - sinceHours * 3600_000);

  const rows = await sql<DecisionRow[]>`
    SELECT decision, mode, time, outcome_class, outcome_r, outcome_mfe_atr, outcome_mae_atr,
           outcome_hit_target, outcome_hit_stop, session_bucket, setup_family, setup_type,
           target_atr, regime, option_quality_grade,
           (outcome_evaluated_at IS NOT NULL) AS graded
    FROM decision_snapshots
    WHERE time >= ${since}
  `.catch(() => []);

  const takes = rows.filter((r) => r.decision === 'TAKE');
  const refusals = rows.filter((r) => r.decision === 'REFUSE');

  const [captureHealth, decisionHealth, quality, stops, shadow] = await Promise.all([
    captureHealthSection(since),
    decisionHealthSection(since),
    dataQualitySection(since),
    stopSection(since),
    shadowSection(since),
  ]);

  return {
    window: { sinceHours, since: since.toISOString(), asOf: new Date(now).toISOString() },
    minimumSampleForInference: MIN_SAMPLE_FOR_INFERENCE,
    captureHealth,
    decisionHealth,
    dataQuality: quality,
    stops,
    liveVsShadow: shadow,
    breakdowns: {
      // Every one of these carries n, mature/immature and an exploratory flag.
      bySessionBucket: groupBy(rows, (r) => r.session_bucket, now),
      bySetupFamily: groupBy(rows, (r) => r.setup_family, now),
      bySetupType: groupBy(rows, (r) => r.setup_type, now),
      byTargetDistanceAtr: groupBy(rows, (r) => targetAtrBucket(num(r.target_atr)), now),
      byRegime: groupBy(rows, (r) => r.regime, now),
      byOptionQuality: groupBy(rows, (r) => r.option_quality_grade, now),
    },
    totals: {
      decisions: rows.length,
      takes: takes.length,
      refusals: refusals.length,
    },
    caveats: [
      'Every rate is computed over GRADED observations only; n counts every observation in the bucket.',
      'A bucket with fewer graded observations than the minimum is flagged exploratory and is not evidence.',
      'Rates are null, never zero, where nothing has been graded — "no wins yet" and "a zero percent win rate" are different claims.',
      'Mature and immature observations are counted separately and never pooled.',
      'Nothing in this report is read by the trading engine.',
    ],
  };
}

function targetAtrBucket(atr: number | null): string {
  if (atr == null) return 'UNKNOWN';
  if (atr < 2) return '0-2';
  if (atr < 3) return '2-3';
  if (atr < 4) return '3-4';
  if (atr < 5) return '4-5';
  if (atr < 6) return '5-6';
  return '6+';
}

async function captureHealthSection(since: Date): Promise<Record<string, unknown>> {
  const count = async (table: string): Promise<number> => {
    try {
      const [row] = await sql.unsafe<{ n: string }[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE time >= $1`, [
        since.toISOString(),
      ]);
      return Number(row?.n ?? 0);
    } catch {
      return -1;
    }
  };

  const runs = await sql<{ status: string; n: string; missing: string | null }[]>`
    SELECT status, COUNT(*) AS n, SUM(GREATEST(COALESCE(expected_legs, 0) - COALESCE(actual_legs, 0), 0)) AS missing
    FROM capture_runs
    WHERE time >= ${since}
    GROUP BY status
  `.catch(() => []);

  return {
    optionLegRows: await count('oi_snapshots'),
    futuresRows: await count('futures_snapshots'),
    positioningRows: await count('pcr_history'),
    marketTicks: await count('market_ticks'),
    decisionSnapshots: await count('decision_snapshots'),
    captureRuns: runs.map((r) => ({ status: r.status, n: Number(r.n), missingLegs: Number(r.missing ?? 0) })),
    completeIntervals: Number(runs.find((r) => r.status === 'SUCCESS')?.n ?? 0),
    partialIntervals: Number(runs.find((r) => r.status === 'PARTIAL')?.n ?? 0),
    failedIntervals: Number(runs.find((r) => r.status === 'FAILED')?.n ?? 0),
    // A run still reading ATTEMPT is a capture that died mid-flight.
    abandonedIntervals: Number(runs.find((r) => r.status === 'ATTEMPT')?.n ?? 0),
  };
}

async function decisionHealthSection(since: Date): Promise<Record<string, unknown>> {
  const byDecision = await sql<{ decision: string; n: string }[]>`
    SELECT decision, COUNT(*) AS n FROM decision_snapshots WHERE time >= ${since} GROUP BY decision
  `.catch(() => []);
  const byReason = await sql<{ reason_code: string | null; n: string }[]>`
    SELECT reason_code, COUNT(*) AS n
    FROM decision_snapshots
    WHERE time >= ${since} AND decision = 'REFUSE'
    GROUP BY reason_code ORDER BY COUNT(*) DESC
  `.catch(() => []);

  const reasons = Object.fromEntries(byReason.map((r) => [r.reason_code ?? 'UNSPECIFIED', Number(r.n)]));
  return {
    take: Number(byDecision.find((d) => d.decision === 'TAKE')?.n ?? 0),
    refuse: Number(byDecision.find((d) => d.decision === 'REFUSE')?.n ?? 0),
    refusalReasons: reasons,
    dataQualityBlocks: reasons.NO_QUOTE ?? 0,
    cooldownBlocks: (reasons.POST_LOSS_COOLDOWN ?? 0) + (reasons.SAME_SYMBOL_SIDE ?? 0),
    circuitBreakerBlocks: reasons.RISK_OFF ?? 0,
  };
}

async function dataQualitySection(since: Date): Promise<Record<string, unknown>> {
  const rows = await sql<{ issue: string; severity: string; n: string; symbols: string[] }[]>`
    SELECT issue, severity, COUNT(*) AS n, array_agg(DISTINCT symbol) FILTER (WHERE symbol IS NOT NULL) AS symbols
    FROM data_quality_events
    WHERE time >= ${since}
    GROUP BY issue, severity ORDER BY COUNT(*) DESC
  `.catch(() => []);

  return {
    events: rows.map((r) => ({
      issue: r.issue,
      severity: r.severity,
      n: Number(r.n),
      symbols: r.symbols ?? [],
    })),
    warnCount: rows.filter((r) => r.severity === 'WARN').reduce((a, r) => a + Number(r.n), 0),
    severeCount: rows.filter((r) => r.severity === 'SEVERE').reduce((a, r) => a + Number(r.n), 0),
    symbolsAffected: [...new Set(rows.flatMap((r) => r.symbols ?? []))],
  };
}

async function stopSection(since: Date): Promise<Record<string, unknown>> {
  const rows = await sql<{ classification: string | null; n: string }[]>`
    SELECT classification, COUNT(*) AS n FROM stop_events WHERE time >= ${since}
    GROUP BY classification ORDER BY COUNT(*) DESC
  `.catch(() => []);
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  return {
    total,
    byClassification: Object.fromEntries(rows.map((r) => [r.classification ?? 'NULL', Number(r.n)])),
    note:
      total === 0
        ? 'No stops fired in this window. The six historical unclassifiable stops are not included and are never rewritten.'
        : 'Classified at fire time from captured state, not reconstructed afterwards.',
  };
}

async function shadowSection(since: Date): Promise<Record<string, unknown>> {
  const rows = await sql<{ agrees: boolean | null; decision: string; n: string }[]>`
    SELECT shadow_agrees_with_live AS agrees, decision, COUNT(*) AS n
    FROM decision_snapshots
    WHERE time >= ${since}
    GROUP BY shadow_agrees_with_live, decision
  `.catch(() => []);

  const agree = rows.filter((r) => r.agrees === true).reduce((a, r) => a + Number(r.n), 0);
  const disagree = rows.filter((r) => r.agrees === false).reduce((a, r) => a + Number(r.n), 0);
  const notComparable = rows.filter((r) => r.agrees == null).reduce((a, r) => a + Number(r.n), 0);

  const disagreements = await sql<
    { decision: string; shadow_refuse_reasons: string | null; outcome_class: string | null; n: string }[]
  >`
    SELECT decision, shadow_refuse_reasons, outcome_class, COUNT(*) AS n
    FROM decision_snapshots
    WHERE time >= ${since} AND shadow_agrees_with_live = false
    GROUP BY decision, shadow_refuse_reasons, outcome_class
    ORDER BY COUNT(*) DESC
  `.catch(() => []);

  return {
    agree,
    disagree,
    notComparable,
    agreementRate: agree + disagree > 0 ? round((agree / (agree + disagree)) * 100, 1) : null,
    disagreements: disagreements.map((d) => ({
      liveDecision: d.decision,
      shadowWouldRefuseBecause: d.shadow_refuse_reasons,
      outcome: d.outcome_class ?? 'NOT YET GRADED',
      n: Number(d.n),
    })),
    note:
      'Measurement only. Agreement with live behaviour is NOT evidence for promoting a shadow rule — a rule that ' +
      'agrees with live everywhere adds nothing, and one that disagrees is only right if the outcomes say so.',
  };
}
