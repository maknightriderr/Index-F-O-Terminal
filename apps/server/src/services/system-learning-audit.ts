// ============================================================
// DAILY SELF-AUDIT
// ============================================================
// Runs the audits the system already has, feeds their failures to the
// learning engine, re-runs the standing regression cases, and records one
// audit-run row so that "no findings" is distinguishable from "never ran".
//
// ORDER MATTERS, and it is the spec's order:
//
//   data processing -> contract validation -> system audit -> learning
//   -> recurrence -> regression validation -> daily report
//
// The job is gated on the capture interval having had time to produce the
// day's data; running it before the source data is complete would generate
// staleness findings about its own earliness.
//
// Nothing here is read by the trading engine, and nothing here can change
// trading behaviour.
// ============================================================

import { sql } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { isMarketOpen } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { createReportAsOf, checkBoundaries, type SectionBoundary } from './report-boundary.js';
import { getSnapshotPopulations } from './snapshot-populations.js';
import { snapshotLineage, greekCoverage, nullZeroAudit } from './data-integrity.js';
import { chainCompleteness } from './capture-diagnostics.js';
import { captureSchemaStatus } from './ensure-capture-schema.js';
import { dataQualitySummary } from './data-quality.js';
import { auditProtectedConstants, PROTECTED_CONSTANTS } from './protected-constants.js';
import { STRIKES_EACH_SIDE, CAPTURE_INTERVAL_MS } from './market-state-capture.js';
import { LineageContractError } from './lineage-contract.js';
import {
  detectPopulationFaults,
  detectBoundaryFaults,
  detectPopulationContractFaults,
  detectLineageContractFaults,
  detectDataQualityFaults,
  detectSchemaFaults,
  detectProtectedConstantFaults,
  detectRunSnapshotFaults,
  detectStalenessFaults,
  detectDuplicateFaults,
  DETECTOR_NAMES,
  type DetectorResult,
  type Finding,
} from './learning-detectors.js';
import {
  ingestFinding,
  runRegressionCases,
  sweepResolutions,
  verifyProtections,
  ensureRegressionCase,
  type IngestContext,
  type IngestOutcome,
} from './learning-engine.js';
import { readFileSync } from 'node:fs';

// Ticks more often than the audit runs, because the gate is no longer the
// clock: it is "not yet completed for this date AND the source data is
// ready". A shorter tick only means the audit starts sooner once both are
// true, and the completion check makes extra ticks free.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000;

/**
 * The earliest the day's capture could plausibly be complete.
 *
 * A floor, not the trigger. The previous version used only `hour >= 19`,
 * which meant a process restarting repeatedly before 19:00 never ran the
 * audit at all — the redis claim was never attempted, so nothing recorded
 * that the day had been missed.
 */
const AUDIT_EARLIEST_IST_HOUR = 19;

/** The logical identity of an audit, with the date, for idempotency. */
export const AUDIT_TYPE = 'SYSTEM_LEARNING';
export const AUDIT_VERSION = 'v1';

let started = false;

export function startSystemLearningAudit(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  const tick = () => {
    maybeRun(provider).catch((err: any) =>
      logger.warn({ error: err.message }, 'System learning audit failed')
    );
  };
  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
}

function istDate(at: Date): string {
  return at.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function istHour(at: Date): number {
  return Number(at.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }));
}

/**
 * Whether the logical audit for a date has already completed.
 *
 * Read from the audit-run table, not from redis. Redis is the concurrency
 * lock; the table is the record. A redis key that expired, or a redis that
 * was flushed, must not make a completed audit look un-run — and a claimed
 * key that then crashed must not make an un-run audit look done.
 */
async function alreadyCompleted(eventDate: string): Promise<boolean> {
  const rows = await sql<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM system_audit_runs
    WHERE event_date = ${eventDate}
      AND audit_type = ${AUDIT_TYPE}
      AND audit_version = ${AUDIT_VERSION}
      AND status IN ('SUCCESS', 'PARTIAL')
      AND already_completed = FALSE
  `.catch(() => [{ n: '0' }]);
  return Number(rows[0]?.n ?? 0) > 0;
}

export interface ReadinessVerdict {
  ready: boolean;
  note: string;
}

/**
 * Whether the day's source data is in.
 *
 * Asked of the data, not the clock. An audit that runs before capture has
 * finished reports staleness caused by its own earliness — a finding about
 * the auditor, recorded as a finding about the system.
 *
 * Readiness means: the market has closed everywhere, and the newest snapshot
 * is from today. A day with no snapshot at all is NOT treated as ready,
 * because the correct finding then is "capture wrote nothing", which the
 * staleness detector raises during market hours where it is actionable.
 */
export async function sourceDataReady(at: Date): Promise<ReadinessVerdict> {
  if (marketOpenAnywhere(at)) {
    return { ready: false, note: 'an Indian exchange is still open; the day is not complete' };
  }
  if (istHour(at) < AUDIT_EARLIEST_IST_HOUR) {
    return {
      ready: false,
      note: `before ${AUDIT_EARLIEST_IST_HOUR}:00 IST the day's capture cannot be complete`,
    };
  }
  const [row] = await sql<{ t: Date | null }[]>`
    SELECT MAX(time) AS t FROM oi_snapshots WHERE time <= ${at}
  `.catch(() => [{ t: null }]);
  if (row?.t == null) {
    return { ready: false, note: 'no option-chain snapshot exists at all' };
  }
  const newestDay = istDate(new Date(row.t));
  const today = istDate(at);
  if (newestDay !== today) {
    return {
      ready: false,
      note: `the newest snapshot is from ${newestDay}, not ${today} — capture has not run today, so auditing today would measure yesterday`,
    };
  }
  return { ready: true, note: `capture has written for ${today}` };
}

/**
 * Runs the audit when, and only when, it has not completed for this date and
 * the source data is ready.
 *
 * The condition is no longer "the clock says 19:00". That version missed the
 * day entirely if the process happened to be restarting through the window;
 * this one keeps checking until both conditions hold, so the audit executes
 * exactly once for the logical date whenever that becomes possible.
 *
 * Redis still provides the concurrency lock, so two workers ticking at the
 * same instant cannot both start. It is a lock, not the record of completion.
 */
async function maybeRun(provider: MarketDataProvider): Promise<void> {
  const now = new Date();
  const day = istDate(now);

  if (await alreadyCompleted(day)) return;

  const readiness = await sourceDataReady(now);
  if (!readiness.ready) return;

  // Short TTL: this is a lock against concurrent starts, not a day-long
  // claim. A crashed run must be retryable within the same day, which a
  // 36-hour claim prevented.
  const claimed = await redis.set(`system_learning_audit_lock:${day}`, '1', 'EX', 30 * 60, 'NX');
  if (claimed !== 'OK') return;

  try {
    await runSystemAudit({ trigger: 'SCHEDULED' });
  } finally {
    await redis.del(`system_learning_audit_lock:${day}`).catch(() => undefined);
  }
}

export interface AuditRunSummary {
  audit_run_id: number | null;
  event_date: string;
  report_as_of: string | null;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'ALREADY_COMPLETED';
  /** TRUE when this request was declined because the logical audit had run. */
  already_completed: boolean;
  source_data_ready: boolean | null;
  source_data_note: string | null;
  /** Findings the contract in force permits. Not defects. */
  expected_findings: number;
  detectors_run: number;
  detectors_failed: number;
  detector_errors: { detector: string; error: string }[];
  findings: number;
  new_errors: number;
  recurrences: number;
  protection_failures: number;
  regression_failures: number;
  regression_cases_run: number;
  /** Cases created by this cycle, which cannot yet regress. */
  regression_cases_created_this_cycle: number;
  /** Failing, but never green — an open fault rather than a regression. */
  regression_cases_never_passed: number;
  resolved: number;
  monitoring: number;
  needs_review: number;
  outcomes: IngestOutcome[];
  error: string | null;
}

function sourceCommit(): string | null {
  // Railway injects the deployed commit; locally there is none, and guessing
  // one would attach a finding to the wrong code.
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ??
    process.env.GIT_COMMIT?.slice(0, 12) ??
    null
  );
}

/**
 * The audit itself. Exported so the CLI and the API can run it on demand.
 */
export async function runSystemAudit(opts: {
  trigger: string;
  /** Re-run a date that already completed. Records a new run; never duplicates counts. */
  force?: boolean;
}): Promise<AuditRunSummary> {
  const boundary = createReportAsOf();
  const startedAt = boundary.asOf;
  const eventDate = istDate(startedAt);
  const commit = sourceCommit();

  const summary: AuditRunSummary = {
    audit_run_id: null,
    event_date: eventDate,
    report_as_of: startedAt.toISOString(),
    status: 'SUCCESS',
    already_completed: false,
    source_data_ready: null,
    source_data_note: null,
    expected_findings: 0,
    detectors_run: 0,
    detectors_failed: 0,
    detector_errors: [],
    findings: 0,
    new_errors: 0,
    recurrences: 0,
    protection_failures: 0,
    regression_failures: 0,
    regression_cases_run: 0,
    regression_cases_created_this_cycle: 0,
    regression_cases_never_passed: 0,
    resolved: 0,
    monitoring: 0,
    needs_review: 0,
    outcomes: [],
    error: null,
  };

  // IDEMPOTENCY. A logical audit is (date, type, version). A second request
  // for one that already completed records that it was asked for and declined
  // — it does not re-ingest findings, which would advance audit_runs_seen and
  // every count derived from runs for no new information.
  if (!opts.force && (await alreadyCompleted(eventDate))) {
    const [existing] = await sql<Record<string, any>[]>`
      SELECT audit_run_id, status, findings, new_errors, recurrences,
             protection_failures, regression_failures, detectors_run, detectors_failed
      FROM system_audit_runs
      WHERE event_date = ${eventDate} AND audit_type = ${AUDIT_TYPE}
        AND audit_version = ${AUDIT_VERSION} AND status IN ('SUCCESS', 'PARTIAL')
        AND already_completed = FALSE
      ORDER BY audit_run_id DESC LIMIT 1
    `.catch(() => []);

    await sql`
      INSERT INTO system_audit_runs (
        started_at, finished_at, event_date, report_as_of, status, audit_type,
        audit_version, trigger_source, already_completed, source_commit
      ) VALUES (
        ${startedAt}, NOW(), ${eventDate}, ${startedAt}, 'ALREADY_COMPLETED',
        ${AUDIT_TYPE}, ${AUDIT_VERSION}, ${opts.trigger}, TRUE, ${commit}
      )
    `.catch(() => undefined);

    logger.info(
      { trigger: opts.trigger, eventDate, existingRun: existing?.audit_run_id ?? null },
      'System learning audit already completed for this date — declined'
    );

    return {
      ...summary,
      audit_run_id: existing?.audit_run_id ?? null,
      status: 'ALREADY_COMPLETED',
      already_completed: true,
      findings: Number(existing?.findings ?? 0),
      new_errors: Number(existing?.new_errors ?? 0),
      recurrences: Number(existing?.recurrences ?? 0),
      protection_failures: Number(existing?.protection_failures ?? 0),
      regression_failures: Number(existing?.regression_failures ?? 0),
      detectors_run: Number(existing?.detectors_run ?? 0),
      detectors_failed: Number(existing?.detectors_failed ?? 0),
    };
  }

  // A FORCED re-run supersedes the completed run rather than sitting beside
  // it. Two authoritative runs for one logical audit is the thing the unique
  // index exists to prevent, and it is also just untrue: only one of them
  // describes the current state of the system.
  //
  // This is the path for "the detector was wrong, re-run the day" — an
  // explicit operator action, recorded as such, never something the scheduler
  // does. The superseded row stays, so the history of what was concluded
  // before the re-run is not lost.
  if (opts.force) {
    await sql`
      UPDATE system_audit_runs SET
        already_completed = TRUE,
        source_data_note = COALESCE(source_data_note, '') ||
          ' | superseded by a forced re-run at ' || ${startedAt.toISOString()}
      WHERE event_date = ${eventDate} AND audit_type = ${AUDIT_TYPE}
        AND audit_version = ${AUDIT_VERSION}
        AND status IN ('SUCCESS', 'PARTIAL') AND already_completed = FALSE
    `.catch(async () => {
      // Older schema without the note column: the supersede itself is what
      // matters, so it is retried without the annotation rather than skipped.
      await sql`
        UPDATE system_audit_runs SET already_completed = TRUE
        WHERE event_date = ${eventDate} AND audit_type = ${AUDIT_TYPE}
          AND audit_version = ${AUDIT_VERSION}
          AND status IN ('SUCCESS', 'PARTIAL') AND already_completed = FALSE
      `.catch(() => undefined);
    });
    logger.warn(
      { eventDate, trigger: opts.trigger },
      'System learning audit FORCED — the previously completed run for this date is superseded'
    );
  }

  const readiness = await sourceDataReady(startedAt);
  summary.source_data_ready = readiness.ready;
  summary.source_data_note = readiness.note;

  const [runRow] = await sql<{ audit_run_id: number }[]>`
    INSERT INTO system_audit_runs (
      started_at, event_date, report_as_of, status, source_commit,
      audit_type, audit_version, trigger_source, source_data_ready, source_data_note
    )
    VALUES (
      ${startedAt}, ${eventDate}, ${startedAt}, 'RUNNING', ${commit},
      ${AUDIT_TYPE}, ${AUDIT_VERSION}, ${opts.trigger},
      ${readiness.ready}, ${readiness.note}
    )
    RETURNING audit_run_id
  `.catch(() => [{ audit_run_id: 0 }]);
  summary.audit_run_id = runRow?.audit_run_id ?? null;

  const results: DetectorResult[] = [];

  try {
    // ---- 1. contract validation: one boundary, one population calculation ----
    const populations = await getSnapshotPopulations(boundary.asOf);
    const lineage = await snapshotLineage(boundary, populations);

    const [greeks, nullZero, chains, dq] = await Promise.all([
      greekCoverage(boundary).catch(() => null),
      nullZeroAudit(boundary).catch(() => null),
      chainCompleteness(24, boundary).catch(() => null),
      dataQualitySummary(new Date(boundary.asOf.getTime() - 24 * 3600_000)).catch(() => null),
    ]);

    const sections: SectionBoundary[] = [
      { section: 'populations', as_of: populations.as_of, kind: 'query_bound' },
      { section: 'lineage', as_of: (lineage as any)?.asOf ?? null, kind: 'query_bound' },
      { section: 'chains', as_of: (chains as any)?.asOf ?? null, kind: 'query_bound' },
      { section: 'greeks', as_of: (greeks as any)?.asOf ?? null, kind: 'query_bound' },
      { section: 'nullZero', as_of: (nullZero as any)?.asOf ?? null, kind: 'query_bound' },
    ];
    const boundaryContract = checkBoundaries(boundary.asOf, sections);

    // ---- 2. supporting reads the detectors need ----
    const [lastSnapshot] = await sql<{ t: Date | null }[]>`
      SELECT MAX(time) AS t FROM oi_snapshots WHERE time <= ${boundary.asOf}
    `.catch(() => [{ t: null }]);

    const duplicates = await scanDuplicates(boundary.asOf);

    // ---- 3. detection ----
    results.push(detectPopulationFaults(lineage as any));
    results.push(detectBoundaryFaults(boundaryContract as any));
    results.push(
      detectPopulationContractFaults({
        population_calculation_invocation_count: 1,
        as_of_consistent: boundaryContract.as_of_consistent,
        as_of_values: { report_as_of: boundary.asOf.toISOString(), population_as_of: populations.as_of },
      })
    );
    results.push(
      detectLineageContractFaults({
        lineage_era_started_at: populations.lineage_era_started_at,
        lineage_era_source: populations.lineage_era_source,
        authoritative: true,
        runtime_activation_timestamp_unverified: false,
      })
    );
    results.push(detectDataQualityFaults({ greeks, nullZero, chains, dataQualityLast24h: dq }));
    results.push(detectSchemaFaults(captureSchemaStatus() as any));
    results.push(detectProtectedConstantFaults(runProtectedConstantAudit()));
    results.push(detectRunSnapshotFaults(populations.runToSnapshotRelationship as any));
    results.push(
      detectStalenessFaults({
        reportAsOf: boundary.asOf.toISOString(),
        lastSnapshotAt: lastSnapshot?.t ? new Date(lastSnapshot.t).toISOString() : null,
        captureIntervalMinutes: Math.round(CAPTURE_INTERVAL_MS / 60_000),
        marketOpen: marketOpenAnywhere(boundary.asOf),
      })
    );
    results.push(detectDuplicateFaults(duplicates));

    summary.detectors_run = results.length;
    for (const r of results) {
      if (r.error != null) {
        summary.detectors_failed++;
        summary.detector_errors.push({ detector: r.detector, error: r.error });
      }
    }
    if (summary.detectors_failed > 0) summary.status = 'PARTIAL';

    // ---- 4. learning + recurrence ----
    const findings: Finding[] = results.flatMap((r) => r.findings);
    summary.findings = findings.length;

    const ctx: IngestContext = {
      detectedAt: startedAt,
      eventDate,
      reportAsOf: startedAt.toISOString(),
      sourceCommit: commit,
      environment: process.env.NODE_ENV ?? 'development',
      auditRunId: summary.audit_run_id,
    };

    const seen = new Map<string, string>();
    for (const f of findings) {
      const outcome = await ingestFinding(f, ctx);
      if (outcome == null) continue;
      summary.outcomes.push(outcome);
      seen.set(f.signature, f.actual);
      // An observation the contract permits is not a new error and not a
      // recurrence, however often it is seen.
      if (outcome.expectedByContract) {
        summary.expected_findings++;
      } else {
        if (outcome.disposition === 'NEW') summary.new_errors++;
        if (outcome.disposition === 'RECURRENCE') summary.recurrences++;
        if (outcome.protectionFailed) summary.protection_failures++;
      }

      // Every DEFECT gets a standing case on first sight. Creating it only
      // after a fix would leave the window in which the fault is most likely
      // to recur — before anyone has done anything — with no check at all.
      //
      // An EXPECTED finding gets none: a case asserting that legacy zeros do
      // not exist would fail forever against data that is supposed to be
      // there, and would report as a regression failure every cycle.
      if (!outcome.expectedByContract) {
        await ensureRegressionCase({
          testId: `RC:${f.signature}`,
          eventId: outcome.eventId,
          testName: f.title,
          category: f.category,
          signature: f.signature,
          description: f.description,
          assertionKey: f.assertionKey,
          expectedBehavior: f.expected,
          previousBehavior: f.actual,
          // The reproduction input, so the fault can be re-created once the
          // live data has moved on.
          fixture: {
            assertionKey: f.assertionKey,
            expected: f.expected,
            observed: f.actual,
            evidence: f.evidence,
            contract_generation: f.contractGeneration ?? null,
            report_as_of: ctx.reportAsOf,
            source_commit: ctx.sourceCommit,
          },
          inputCondition: `${f.module}${f.component ? ` / ${f.component}` : ''} at report_as_of ${ctx.reportAsOf}`,
          // Deterministic only when the fixture alone decides the outcome.
          // A finding whose evidence is a live row count is not reproducible
          // from the fixture, and claiming otherwise would be worse than
          // admitting it.
          deterministic: false,
        }).catch(() => undefined);
      }
    }

    // ---- 5. regression validation ----
    // startedAt is passed twice on purpose: it is both the evaluation instant
    // and the cycle boundary, so a case this cycle just created is skipped
    // rather than counted as a regression against a fix that never existed.
    const regression = await runRegressionCases(seen, startedAt, startedAt);
    summary.regression_cases_run = regression.filter((r) => !r.skipped).length;
    summary.regression_cases_created_this_cycle = regression.filter((r) => r.skipped).length;
    // A REGRESSION is a case that was green and went red. A case that has
    // never been green is an open fault, counted separately — otherwise this
    // number becomes a second, worse count of open bugs.
    summary.regression_failures = regression.filter((r) => !r.passed && !r.skipped && !r.neverPassed).length;
    summary.regression_cases_never_passed = regression.filter((r) => r.neverPassed && !r.skipped).length;

    // ---- 6. resolution sweep + protection verification ----
    // The sweep is over DEFECTS. An expected finding has nothing to resolve.
    const sweep = await sweepResolutions(new Set(seen.keys()), startedAt);
    summary.resolved = sweep.resolved;
    summary.monitoring = sweep.monitoring;
    summary.needs_review = sweep.needsReview;
    await verifyProtections(new Set(seen.keys()), startedAt);
  } catch (err: any) {
    // A contract error means the audit could not establish its own footing.
    // Recorded as FAILED rather than as "no findings", because the two mean
    // opposite things and only one of them is good news.
    summary.status = 'FAILED';
    summary.error =
      err instanceof LineageContractError
        ? `lineage contract unavailable: ${err.message}`
        : err.message;
    logger.error({ error: summary.error, trigger: opts.trigger }, 'System learning audit could not complete');
  }

  await sql`
    UPDATE system_audit_runs SET
      finished_at = NOW(), status = ${summary.status},
      detectors_run = ${summary.detectors_run}, detectors_failed = ${summary.detectors_failed},
      findings = ${summary.findings}, new_errors = ${summary.new_errors},
      recurrences = ${summary.recurrences}, protection_failures = ${summary.protection_failures},
      regression_failures = ${summary.regression_failures}, error = ${summary.error}
    WHERE audit_run_id = ${summary.audit_run_id}
  `.catch(() => undefined);

  logger.info(
    {
      trigger: opts.trigger,
      findings: summary.findings,
      new: summary.new_errors,
      recurrences: summary.recurrences,
      protectionFailures: summary.protection_failures,
      regressionFailures: summary.regression_failures,
      status: summary.status,
    },
    'System learning audit complete'
  );

  return summary;
}

/** Any Indian exchange open at this instant. */
function marketOpenAnywhere(at: Date): boolean {
  try {
    return (['NSE', 'BSE', 'MCX'] as const).some((ex) => isMarketOpen(ex, at));
  } catch {
    return false;
  }
}

/**
 * The protected-constants audit, run against the files on disk.
 *
 * Reads source rather than importing, so a constant that was changed is
 * detected even though the running process was built before the change.
 */
function runProtectedConstantAudit(): ReturnType<typeof auditProtectedConstants> | null {
  try {
    const roots = ['../../../../', '../../../../../'];
    const read = (rel: string): string => {
      for (const r of roots) {
        try {
          return readFileSync(new URL(`${r}${rel}`, import.meta.url), 'utf-8');
        } catch {
          /* try the next layout */
        }
      }
      throw new Error(`could not read ${rel}`);
    };
    return auditProtectedConstants(read);
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Protected-constants audit could not read source — not treated as a pass');
    return null;
  }
}

/**
 * Duplicate scan over the keys that are supposed to identify one row.
 *
 * Every count in the population model is over these tables, so a duplicate
 * here silently double-counts a denominator rather than failing loudly.
 */
async function scanDuplicates(asOf: Date): Promise<{ table: string; key: string; n: number }[]> {
  const checks: { table: string; key: string; query: () => Promise<{ n: string }[]> }[] = [
    {
      table: 'oi_snapshots',
      key: 'time,exchange,symbol,expiry,strike,option_type',
      query: () => sql<{ n: string }[]>`
        SELECT COUNT(*) AS n FROM (
          SELECT 1 FROM oi_snapshots WHERE time <= ${asOf}
          GROUP BY time, exchange, symbol, expiry, strike, option_type
          HAVING COUNT(*) > 1
        ) d
      `,
    },
    {
      table: 'capture_runs',
      key: 'id',
      query: () => sql<{ n: string }[]>`
        SELECT COUNT(*) AS n FROM (
          SELECT 1 FROM capture_runs GROUP BY id HAVING COUNT(*) > 1
        ) d
      `,
    },
    {
      table: 'decision_snapshots',
      key: 'decision_id',
      query: () => sql<{ n: string }[]>`
        SELECT COUNT(*) AS n FROM (
          SELECT 1 FROM decision_snapshots WHERE time <= ${asOf}
          GROUP BY decision_id HAVING COUNT(*) > 1
        ) d
      `,
    },
  ];

  const out: { table: string; key: string; n: number }[] = [];
  for (const c of checks) {
    try {
      const [row] = await c.query();
      out.push({ table: c.table, key: c.key, n: Number(row?.n ?? 0) });
    } catch {
      // A table that does not exist on this schema is not a duplicate
      // finding; it is simply not checkable here.
    }
  }
  return out;
}

/** What the audit covers, for the report's own honesty about its scope. */
export const AUDIT_SCOPE = {
  detectors: DETECTOR_NAMES,
  protected_constants_checked: PROTECTED_CONSTANTS.length,
  strikes_each_side: STRIKES_EACH_SIDE,
  earliest_ist_hour: AUDIT_EARLIEST_IST_HOUR,
  audit_type: AUDIT_TYPE,
  audit_version: AUDIT_VERSION,
  note:
    'Every check here is an existing audit re-read, never a second measurement of the same thing. No trading judgement is made: the audit reports measurable contract violations only.',
} as const;
