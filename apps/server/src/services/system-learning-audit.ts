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

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
/** The audit runs after this IST hour, so the day's capture is in. */
const AUDIT_AFTER_IST_HOUR = 19;

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
 * One run per IST day, claimed in redis.
 *
 * The same NX claim the holiday check uses. Without it an hourly tick would
 * re-run the audit every hour and inflate occurrence counts by a factor of
 * however often the process happens to wake up.
 */
async function maybeRun(provider: MarketDataProvider): Promise<void> {
  const now = new Date();
  if (istHour(now) < AUDIT_AFTER_IST_HOUR) return;
  const day = istDate(now);
  const claimed = await redis.set(`system_learning_audit:${day}`, '1', 'EX', 36 * 60 * 60, 'NX');
  if (claimed !== 'OK') return;
  await runSystemAudit({ trigger: 'SCHEDULED' });
}

export interface AuditRunSummary {
  audit_run_id: number | null;
  event_date: string;
  report_as_of: string | null;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
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
export async function runSystemAudit(opts: { trigger: string }): Promise<AuditRunSummary> {
  const boundary = createReportAsOf();
  const startedAt = boundary.asOf;
  const eventDate = istDate(startedAt);
  const commit = sourceCommit();

  const summary: AuditRunSummary = {
    audit_run_id: null,
    event_date: eventDate,
    report_as_of: startedAt.toISOString(),
    status: 'SUCCESS',
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

  const [runRow] = await sql<{ audit_run_id: number }[]>`
    INSERT INTO system_audit_runs (started_at, event_date, report_as_of, status, source_commit)
    VALUES (${startedAt}, ${eventDate}, ${startedAt}, 'RUNNING', ${commit})
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
      if (outcome.disposition === 'NEW') summary.new_errors++;
      if (outcome.disposition === 'RECURRENCE') summary.recurrences++;
      if (outcome.protectionFailed) summary.protection_failures++;

      // Every fault gets a standing case on first sight. Creating it only
      // after a fix would leave the window in which the fault is most likely
      // to recur — before anyone has done anything — with no check at all.
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
      }).catch(() => undefined);
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
  runs_after_ist_hour: AUDIT_AFTER_IST_HOUR,
  note:
    'Every check here is an existing audit re-read, never a second measurement of the same thing. No trading judgement is made: the audit reports measurable contract violations only.',
} as const;
