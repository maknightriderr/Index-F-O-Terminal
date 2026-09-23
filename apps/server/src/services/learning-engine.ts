// ============================================================
// LEARNING ENGINE
// ============================================================
// Takes findings from the detectors and turns them into durable knowledge:
// is this new or has it happened before, did a protection exist, did that
// protection just fail, may it be resolved, does a person have to look.
//
// The one thing this module will not do is change trading behaviour. It has
// no import from any trading module, and the only write path for a finding
// in the trading path goes through the human-approval columns.
//
// Nothing here is read by the trading engine.
// ============================================================

import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import {
  canResolve,
  isOpen,
  isExpected,
  isStableSignature,
  protectionApplicable,
  isRepeatedFailure,
  learningEffectiveness,
  severityRank,
} from './learning-taxonomy.js';
import type { Finding as DetectorFinding } from './learning-detectors.js';

/** Re-exported so callers need one import for the shape they pass in. */
export type { Finding } from './learning-detectors.js';

export interface IngestContext {
  detectedAt: Date;
  /** IST-local audit day, so a report covers one trading day. */
  eventDate: string;
  reportAsOf: string | null;
  sourceCommit: string | null;
  environment: string;
  auditRunId: number | null;
}

export type Disposition = 'NEW' | 'RECURRENCE' | 'REPEAT_SAME_DAY';

export interface IngestOutcome {
  signature: string;
  eventId: number;
  disposition: Disposition;
  /** Distinct audit DAYS seen. The recurrence number. */
  occurrenceCount: number;
  /** Times the audit observed it, across all runs. Not recurrence. */
  auditRunsSeen: number;
  classification: string | null;
  expectedByContract: boolean;
  /** True when this sighting arrived after a protection was recorded. */
  protectionFailed: boolean;
  protectionId: string | null;
  status: string;
  humanApprovalRequired: boolean;
}

// ------------------------------------------------------------
// INGEST
// ------------------------------------------------------------

/**
 * Records one finding, collapsing it onto the existing row for its signature.
 *
 * The collapse is the point. Inserting a row per sighting would make
 * occurrence_count a synonym for "number of audit cycles" and bury the
 * distinction between a fault seen once and one seen every hour. Every
 * sighting is still kept, in system_learning_occurrences.
 */
export async function ingestFinding(f: DetectorFinding, ctx: IngestContext): Promise<IngestOutcome | null> {
  const stability = isStableSignature(f.signature);
  if (!stability.stable) {
    // Refused rather than stored. A signature carrying a measured value would
    // never match its own next occurrence, so storing it would silently
    // disable recurrence detection for that fault — the failure mode this
    // whole engine exists to avoid.
    logger.error(
      { signature: f.signature, reason: stability.reason },
      'Learning engine: refusing a finding with an unstable error signature'
    );
    return null;
  }

  const existing = await sql<{
    event_id: number;
    occurrence_count: number;
    recurrence_count: number;
    status: string;
    protection_id: string | null;
    first_seen_at: Date;
    event_date: string;
    root_cause: string | null;
    fix_applied: boolean;
    fix_description: string | null;
    regression_test_status: string | null;
    human_approved: boolean;
    audit_runs_seen: number | null;
  }[]>`
    SELECT event_id, occurrence_count, recurrence_count, status, protection_id,
           first_seen_at, event_date::text AS event_date, root_cause,
           fix_applied, fix_description, regression_test_status, human_approved,
           audit_runs_seen
    FROM system_learning_events
    WHERE error_signature = ${f.signature}
    ORDER BY event_id DESC
    LIMIT 1
  `;

  const prior = existing[0];

  /**
   * Where a brand-new finding starts.
   *
   * An observation the contract in force permits goes straight to EXPECTED
   * with its evidence: it is not a defect, so holding it in
   * NEEDS_HUMAN_REVIEW would queue a person against a fix that must never be
   * written. Anything else with no established cause goes to human review,
   * because a cause is never invented.
   */
  const initialStatus: string =
    f.expectedByContract === true
      ? 'EXPECTED'
      : f.rootCause == null
        ? 'NEEDS_HUMAN_REVIEW'
        : 'NEW';

  // A protection recorded on the prior row means this sighting is evidence
  // that the protection does not work.
  //
  // An EXPECTED finding is excluded: nothing was protecting against it,
  // because it is not a fault.
  const protectionId = prior?.protection_id ?? null;
  const protectionFailed =
    prior != null && protectionId != null && f.expectedByContract !== true;

  let eventId: number;
  let disposition: Disposition;
  let occurrenceCount: number;
  let auditRunsSeen: number;
  let status: string;

  if (prior == null) {
    const inserted = await sql<{ event_id: number }[]>`
      INSERT INTO system_learning_events (
        detected_at, event_date, category, module, component, symbol, expiry,
        error_signature, error_title, description,
        expected_value, actual_value, difference, severity,
        root_cause, root_cause_confidence,
        first_seen_at, last_seen_at, occurrence_count, recurrence_count,
        audit_runs_seen, audit_days_seen,
        classification, classification_reason, contract_generation,
        expected_by_contract, evidence_quality,
        fix_required, status,
        human_approval_required,
        source_commit, source_report_as_of, evidence, environment
      ) VALUES (
        ${ctx.detectedAt}, ${ctx.eventDate}, ${f.category}, ${f.module}, ${f.component ?? null},
        ${f.symbol ?? null}, ${f.expiry ?? null},
        ${f.signature}, ${f.title}, ${f.description},
        ${f.expected}, ${f.actual}, ${f.difference ?? null}, ${f.severity},
        ${f.rootCause}, ${f.rootCauseConfidence ?? null},
        ${ctx.detectedAt}, ${ctx.detectedAt}, 1, 0,
        1, 1,
        ${f.classification ?? null}, ${f.classificationReason ?? null},
        ${f.contractGeneration ?? null}, ${f.expectedByContract ?? null},
        ${f.evidenceQuality ?? null},
        ${f.expectedByContract === true ? false : true}, ${initialStatus},
        ${f.humanApprovalRequired},
        ${ctx.sourceCommit}, ${ctx.reportAsOf}, ${sql.json(f.evidence as any)}, ${ctx.environment}
      )
      RETURNING event_id
    `;
    eventId = inserted[0].event_id;
    disposition = 'NEW';
    occurrenceCount = 1;
    auditRunsSeen = 1;
    status = initialStatus;
  } else {
    // Same audit day means the same condition still standing, not a fresh
    // recurrence — otherwise a persistent fault would inflate its own
    // recurrence count once per cycle and drown the genuinely repeating ones.
    const sameDay = prior.event_date === ctx.eventDate;
    disposition = sameDay ? 'REPEAT_SAME_DAY' : 'RECURRENCE';

    // occurrence_count counts DAYS the fault was seen, not audit cycles.
    //
    // Incrementing per cycle made it count how often somebody ran the audit
    // while the fault was open: verifying this engine by calling the manual
    // endpoint in a loop took seven faults to 742 "occurrences" and tripped
    // every repeated-failure alert. "First seen 15 Sep, 8 occurrences" is
    // only a meaningful sentence if the 8 means eight days.
    //
    // Every individual sighting is still recorded in
    // system_learning_occurrences, so nothing is lost — the full history is
    // there for anything that wants to count cycles.
    occurrenceCount = sameDay ? prior.occurrence_count : prior.occurrence_count + 1;
    const recurrenceCount = prior.recurrence_count + (sameDay ? 0 : 1);

    // audit_runs_seen counts every sighting. It is the number
    // occurrence_count used to be, kept because it is worth having — just
    // never as recurrence.
    auditRunsSeen = (prior.audit_runs_seen ?? prior.occurrence_count) + 1;

    // An observation the contract permits stays EXPECTED however often it is
    // seen. Seeing legacy zeros again tomorrow is not a recurring defect; it
    // is the same history, still there.
    status = f.expectedByContract === true
      ? 'EXPECTED'
      : isExpected(prior.status)
        // Previously expected, now NOT permitted: the contract governing
        // those rows changed, which is a genuine new defect.
        ? 'NEW'
        : isOpen(prior.status)
          ? prior.root_cause == null
            ? 'NEEDS_HUMAN_REVIEW'
            : sameDay
              ? prior.status
              : 'RECURRENCE'
          : 'RECURRENCE';

    await sql`
      UPDATE system_learning_events SET
        last_seen_at = ${ctx.detectedAt},
        event_date = ${ctx.eventDate},
        occurrence_count = ${occurrenceCount},
        recurrence_count = ${recurrenceCount},
        audit_runs_seen = ${auditRunsSeen},
        audit_days_seen = ${occurrenceCount},
        classification = ${f.classification ?? null},
        classification_reason = ${f.classificationReason ?? null},
        contract_generation = ${f.contractGeneration ?? null},
        expected_by_contract = ${f.expectedByContract ?? null},
        evidence_quality = ${f.evidenceQuality ?? null},
        root_cause = COALESCE(${f.rootCause ?? null}, root_cause),
        fix_required = ${f.expectedByContract === true ? false : true},
        actual_value = ${f.actual},
        difference = ${f.difference ?? null},
        severity = ${f.severity},
        status = ${status},
        source_commit = ${ctx.sourceCommit},
        source_report_as_of = ${ctx.reportAsOf},
        evidence = ${sql.json(f.evidence as any)},
        human_approval_required = ${f.humanApprovalRequired},
        updated_at = NOW()
      WHERE event_id = ${prior.event_id}
    `;
    eventId = prior.event_id;
  }

  await sql`
    INSERT INTO system_learning_occurrences (
      event_id, error_signature, detected_at, event_date,
      actual_value, difference, after_protection, protection_id,
      source_commit, source_report_as_of, evidence
    ) VALUES (
      ${eventId}, ${f.signature}, ${ctx.detectedAt}, ${ctx.eventDate},
      ${f.actual}, ${f.difference ?? null}, ${protectionFailed}, ${protectionId},
      ${ctx.sourceCommit}, ${ctx.reportAsOf}, ${sql.json(f.evidence as any)}
    )
  `;

  if (protectionFailed && protectionId != null) {
    await sql`
      UPDATE system_protections SET
        failure_count = failure_count + 1,
        last_failed_at = ${ctx.detectedAt},
        updated_at = NOW()
      WHERE protection_id = ${protectionId}
    `;
  }

  // A proposed protection is registered but NOT attached to the event as a
  // live protection: attaching it here would let the engine claim the fault
  // is protected the instant it is detected, before anything was actually
  // done. Attachment happens when a fix is recorded.
  if (f.proposedProtection != null) {
    await registerProtection({
      protectionId: `${f.signature}#${f.proposedProtection.type}`,
      signature: f.signature,
      type: f.proposedProtection.type,
      title: f.proposedProtection.title,
      rule: f.proposedProtection.rule,
      module: f.module,
      implementedIn: f.proposedProtection.implementedIn,
      attachToEvent: false,
    });
  }

  return {
    signature: f.signature,
    eventId,
    disposition,
    occurrenceCount,
    auditRunsSeen,
    classification: f.classification ?? null,
    expectedByContract: f.expectedByContract === true,
    protectionFailed,
    protectionId,
    status,
    humanApprovalRequired: f.humanApprovalRequired,
  };
}

// ------------------------------------------------------------
// PROTECTIONS
// ------------------------------------------------------------

export async function registerProtection(input: {
  protectionId: string;
  signature: string;
  type: string;
  title: string;
  rule: string;
  module?: string | null;
  implementedIn: string;
  /** True only when a fix has actually been recorded. */
  attachToEvent: boolean;
}): Promise<void> {
  await sql`
    INSERT INTO system_protections (
      protection_id, error_signature, protection_type, title, rule, module, implemented_in
    ) VALUES (
      ${input.protectionId}, ${input.signature}, ${input.type}, ${input.title},
      ${input.rule}, ${input.module ?? null}, ${input.implementedIn}
    )
    ON CONFLICT (protection_id) DO UPDATE
      SET title = EXCLUDED.title,
          rule = EXCLUDED.rule,
          implemented_in = EXCLUDED.implemented_in,
          updated_at = NOW()
  `;
  if (input.attachToEvent) {
    await sql`
      UPDATE system_learning_events
      SET protection_id = ${input.protectionId}, protection_type = ${input.type},
          status = CASE WHEN status IN ('FIXED', 'FIX_PROPOSED') THEN 'PROTECTED' ELSE status END,
          updated_at = NOW()
      WHERE error_signature = ${input.signature}
    `;
  }
}

/** Marks a protection verified for this cycle — the fault did not reappear. */
export async function verifyProtections(signaturesSeen: Set<string>, at: Date): Promise<void> {
  const rows = await sql<{ protection_id: string; error_signature: string }[]>`
    SELECT protection_id, error_signature FROM system_protections WHERE active = TRUE
  `;
  const clean = rows.filter((r) => !signaturesSeen.has(r.error_signature)).map((r) => r.protection_id);
  if (clean.length === 0) return;
  await sql`
    UPDATE system_protections SET last_verified_at = ${at}, updated_at = NOW()
    WHERE protection_id = ANY(${clean})
  `;
}

// ------------------------------------------------------------
// REGRESSION CASES
// ------------------------------------------------------------

/**
 * Creates the standing check for a fault, if it does not already exist.
 *
 * `assertionKey` is what makes this a test rather than a note: the audit
 * evaluates it every cycle against live output. A regression case with
 * nothing evaluating it would report PASS forever by saying nothing, which is
 * worse than having no case at all.
 */
/**
 * Creates the standing check for a fault.
 *
 * Throws on failure. The caller decides what to do about it, and must not
 * discard it: a regression case that silently fails to be created leaves the
 * fault with no standing check while the record claims one exists.
 */
export async function ensureRegressionCase(input: {
  testId: string;
  eventId: number;
  testName: string;
  category: string;
  signature: string;
  description: string;
  assertionKey: string;
  expectedBehavior: string;
  previousBehavior: string;
  /** The input that produced the fault, for deterministic reproduction. */
  fixture?: Record<string, unknown> | null;
  inputCondition?: string | null;
  deterministic?: boolean;
}): Promise<void> {
  await sql`
    INSERT INTO system_regression_cases (
      test_id, learning_event_id, test_name, category, error_signature, description,
      assertion_key, expected_behavior, actual_previous_behavior, status
    ) VALUES (
      ${input.testId}, ${input.eventId}, ${input.testName}, ${input.category},
      ${input.signature}, ${input.description}, ${input.assertionKey},
      ${input.expectedBehavior}, ${input.previousBehavior}, 'CREATED'
    )
    ON CONFLICT (test_id) DO NOTHING
  `;
  // The fixture is written separately and idempotently, so re-running the
  // audit refreshes the reproduction input without resetting the case's
  // pass/fail history.
  //
  // Logged on failure rather than swallowed. A silent catch in the engine
  // whose whole purpose is to make failures visible is the one place it is
  // least acceptable — and it already cost something: a regression case
  // silently failed to be created for every finding after migration 015, and
  // nothing said so.
  await sql`
    UPDATE system_regression_cases SET
      fixture = ${input.fixture == null ? null : sql.json(input.fixture as any)},
      input_condition = COALESCE(${input.inputCondition ?? null}, input_condition),
      deterministic = ${input.deterministic ?? false},
      updated_at = NOW()
    WHERE test_id = ${input.testId}
  `.catch((err: any) =>
    logger.warn(
      { testId: input.testId, error: err.message },
      'Learning engine: regression fixture could not be stored'
    )
  );
  await sql`
    UPDATE system_learning_events
    SET regression_test = ${input.testId}, updated_at = NOW()
    WHERE event_id = ${input.eventId} AND regression_test IS NULL
  `;
}

export interface RegressionOutcome {
  testId: string;
  signature: string;
  assertionKey: string;
  passed: boolean;
  /** True when the case was created by this same cycle and cannot yet regress. */
  skipped: boolean;
  /**
   * True when the assertion is failing but has NEVER passed.
   *
   * That is a fault still open since it was found, not a regression. Only a
   * case that was once green can regress, and conflating the two makes
   * "regression failures" count open bugs — which is a number the system
   * already reports, under a name that means something else.
   */
  neverPassed: boolean;
  observed: string;
}

/**
 * Re-runs every stored case against this cycle's findings.
 *
 * A case fails when its signature appears in the current findings: the fault
 * it was created for is back. That is a regression by definition, and it is
 * reported as one rather than as a fresh discovery.
 *
 * A case CREATED BY THIS CYCLE is skipped, not failed. Cases are created on
 * first sight of a fault, so without this every new finding would also report
 * a regression failure against a case that has never passed — and
 * "regression failures" would stop meaning "something we fixed came back",
 * which is the only thing it is useful for. Such a case moves to CREATED and
 * is evaluated from the next cycle onward.
 */
export async function runRegressionCases(
  signaturesSeen: Map<string, string>,
  at: Date,
  /** Cases created at or after this instant belong to the current cycle. */
  cycleStartedAt: Date = at
): Promise<RegressionOutcome[]> {
  const cases = await sql<{
    test_id: string; error_signature: string; assertion_key: string;
    created_at: Date; pass_count: number;
  }[]>`
    SELECT test_id, error_signature, assertion_key, created_at, pass_count
    FROM system_regression_cases
  `;

  const outcomes: RegressionOutcome[] = [];
  for (const c of cases) {
    const observed = signaturesSeen.get(c.error_signature);
    const passed = observed == null;

    // Created this cycle and never yet green: it is the record of a new
    // fault, not evidence that a fix regressed.
    const bornThisCycle =
      new Date(c.created_at).getTime() >= cycleStartedAt.getTime() && c.pass_count === 0;
    if (!passed && bornThisCycle) {
      outcomes.push({
        testId: c.test_id,
        signature: c.error_signature,
        assertionKey: c.assertion_key,
        passed: false,
        skipped: true,
        neverPassed: true,
        observed: observed ?? '',
      });
      await sql`
        UPDATE system_regression_cases SET
          status = 'CREATED', current_behavior = ${observed ?? ''}, updated_at = NOW()
        WHERE test_id = ${c.test_id}
      `;
      continue;
    }

    // Failing, but never green: the fault has simply never been fixed. Real
    // regressions are the ones that were green and went red.
    const neverPassed = !passed && c.pass_count === 0;

    outcomes.push({
      testId: c.test_id,
      signature: c.error_signature,
      assertionKey: c.assertion_key,
      passed,
      skipped: false,
      neverPassed,
      observed: observed ?? 'fault not present',
    });

    if (passed) {
      await sql`
        UPDATE system_regression_cases SET
          status = 'PASS', last_run_at = ${at}, pass_count = pass_count + 1,
          never_passed = FALSE,
          current_behavior = 'fault not present', updated_at = NOW()
        WHERE test_id = ${c.test_id}
      `;
    } else {
      // OPEN means "never been green"; FAIL means "was green, went red".
      // Only the second is a regression, and only the second should push the
      // event back to RECURRENCE — a fault that was never fixed has not
      // recurred, it has simply not gone away.
      await sql`
        UPDATE system_regression_cases SET
          status = ${neverPassed ? 'OPEN' : 'FAIL'}, last_run_at = ${at},
          fail_count = fail_count + 1, last_failed_at = ${at},
          current_behavior = ${observed ?? ''}, updated_at = NOW()
        WHERE test_id = ${c.test_id}
      `;
      if (!neverPassed) {
        await sql`
          UPDATE system_learning_events SET
            regression_test_status = 'FAIL', status = 'RECURRENCE', updated_at = NOW()
          WHERE error_signature = ${c.error_signature}
        `;
      } else {
        await sql`
          UPDATE system_learning_events SET
            regression_test_status = 'OPEN', updated_at = NOW()
          WHERE error_signature = ${c.error_signature}
        `;
      }
    }
  }
  return outcomes;
}

// ------------------------------------------------------------
// RESOLUTION SWEEP
// ------------------------------------------------------------

/**
 * Moves findings that did NOT reappear toward resolution — but only as far as
 * their evidence allows.
 *
 * A fault being absent this cycle is not a fix. Without a root cause and a
 * recorded fix it moves to MONITORING or NEEDS_HUMAN_REVIEW and stays there;
 * the alternative is a system that resolves every intermittent fault the
 * first quiet day and learns nothing.
 */
export async function sweepResolutions(signaturesSeen: Set<string>, at: Date): Promise<{
  resolved: number;
  monitoring: number;
  needsReview: number;
}> {
  // EXPECTED is excluded from the sweep entirely.
  //
  // Found live: the sweep pulled in the rows migration 015 had just
  // reclassified, ran the DEFECT checklist against them, and moved them from
  // EXPECTED to FIX_PROPOSED — queueing a fix for an observation the contract
  // permits. The state has to be stable across a sweep or it is not a state,
  // just a label the next cycle overwrites.
  const open = await sql<{
    event_id: number; error_signature: string; category: string; status: string;
    root_cause: string | null; fix_applied: boolean; fix_description: string | null;
    protection_id: string | null; regression_test_status: string | null;
    human_approval_required: boolean; human_approved: boolean;
    expected_by_contract: boolean | null; evidence_quality: string | null;
    verification_status: string | null;
  }[]>`
    SELECT event_id, error_signature, category, status, root_cause, fix_applied,
           fix_description, protection_id, regression_test_status,
           human_approval_required, human_approved,
           expected_by_contract, evidence_quality, verification_status
    FROM system_learning_events
    WHERE status NOT IN ('RESOLVED', 'CLOSED_EXPECTED', 'EXPECTED')
      AND COALESCE(expected_by_contract, FALSE) = FALSE
  `;

  let resolved = 0;
  let monitoring = 0;
  let needsReview = 0;

  for (const e of open) {
    // Still firing: leave it where the ingest put it.
    if (signaturesSeen.has(e.error_signature)) continue;

    const verdict = canResolve({
      rootCause: e.root_cause,
      fixApplied: e.fix_applied,
      fixDescription: e.fix_description,
      protectionId: e.protection_id,
      regressionStatus: e.regression_test_status,
      protectionApplicable: protectionApplicable(e.category),
      humanApprovalRequired: e.human_approval_required,
      humanApproved: e.human_approved,
      // Passed through, so a row carrying the contract verdict is never run
      // through the defect checklist even if it reaches here.
      expectedByContract: e.expected_by_contract === true,
      evidenceQuality: e.evidence_quality,
      verificationStatus: e.verification_status,
    });

    if (verdict.suggestedStatus === e.status) continue;

    await sql`
      UPDATE system_learning_events SET
        status = ${verdict.suggestedStatus},
        review_note = ${verdict.blockers.length > 0 ? verdict.blockers.join(' | ') : null},
        updated_at = NOW()
      WHERE event_id = ${e.event_id}
    `;

    if (verdict.suggestedStatus === 'RESOLVED') resolved++;
    else if (verdict.suggestedStatus === 'MONITORING') monitoring++;
    else if (verdict.suggestedStatus === 'NEEDS_HUMAN_REVIEW') needsReview++;
  }

  return { resolved, monitoring, needsReview };
}

// ------------------------------------------------------------
// HUMAN REVIEW
// ------------------------------------------------------------

export type ReviewDecision = 'APPROVE' | 'REJECT' | 'MODIFY' | 'DEFER' | 'EXPECTED';

/**
 * Records a human decision. The ONLY path by which a trading-path finding
 * can move past proposal.
 *
 * Note what is absent: no branch here edits source, and nothing calls into a
 * trading module. Approval records consent for a person to make a change; it
 * does not make one.
 */
export async function recordReview(input: {
  eventId: number;
  decision: ReviewDecision;
  reviewer: string;
  note?: string | null;
  fixDescription?: string | null;
}): Promise<{ ok: boolean; status: string; message: string }> {
  const rows = await sql<{ category: string; human_approval_required: boolean; error_signature: string }[]>`
    SELECT category, human_approval_required, error_signature
    FROM system_learning_events WHERE event_id = ${input.eventId}
  `;
  if (rows.length === 0) return { ok: false, status: 'NOT_FOUND', message: `no learning event ${input.eventId}` };

  const status =
    input.decision === 'APPROVE' ? 'FIX_PROPOSED'
    : input.decision === 'REJECT' ? 'MONITORING'
    : input.decision === 'MODIFY' ? 'NEEDS_HUMAN_REVIEW'
    : input.decision === 'DEFER' ? 'MONITORING'
    : 'CLOSED_EXPECTED';

  await sql`
    UPDATE system_learning_events SET
      human_approved = ${input.decision === 'APPROVE'},
      human_approved_at = ${input.decision === 'APPROVE' ? new Date() : null},
      approved_by = ${input.reviewer},
      review_decision = ${input.decision},
      review_note = ${input.note ?? null},
      fix_description = COALESCE(${input.fixDescription ?? null}, fix_description),
      status = ${status},
      updated_at = NOW()
    WHERE event_id = ${input.eventId}
  `;

  return {
    ok: true,
    status,
    message:
      input.decision === 'APPROVE'
        ? 'Approved. The change is now cleared for a person to make — this engine does not apply trading-logic changes itself.'
        : input.decision === 'EXPECTED'
          ? 'Closed as expected behaviour. It will not be reported as a fault again unless the signature changes.'
          : `Recorded as ${input.decision}.`,
  };
}

// ------------------------------------------------------------
// QUERIES FOR REPORTING
// ------------------------------------------------------------

export interface LearningEventRow {
  event_id: number;
  detected_at: string;
  event_date: string;
  category: string;
  category_group?: string;
  module: string | null;
  component: string | null;
  symbol: string | null;
  error_signature: string;
  error_title: string;
  description: string | null;
  expected_value: string | null;
  actual_value: string | null;
  severity: string;
  root_cause: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  recurrence_count: number;
  status: string;
  protection_id: string | null;
  protection_type: string | null;
  regression_test: string | null;
  regression_test_status: string | null;
  human_approval_required: boolean;
  human_approved: boolean;
  fix_applied: boolean;
  fix_description: string | null;
  review_note: string | null;
  source_commit: string | null;
  classification?: string | null;
  classification_reason?: string | null;
  contract_generation?: string | null;
  expected_by_contract?: boolean | null;
  evidence_quality?: string | null;
  verification_status?: string | null;
  /** Distinct audit DAYS seen. The recurrence number. */
  audit_days_seen?: number;
  /** Times the audit observed it. Not recurrence. */
  audit_runs_seen?: number;
}

const EVENT_COLUMNS = sql`
  event_id, detected_at, event_date::text AS event_date, category, module, component,
  symbol, error_signature, error_title, description, expected_value, actual_value,
  severity, root_cause, first_seen_at, last_seen_at, occurrence_count, recurrence_count,
  status, protection_id, protection_type, regression_test, regression_test_status,
  human_approval_required, human_approved, fix_applied, fix_description, review_note,
  source_commit,
  classification, classification_reason, contract_generation, expected_by_contract,
  evidence_quality, verification_status,
  COALESCE(audit_days_seen, occurrence_count) AS audit_days_seen,
  COALESCE(audit_runs_seen, occurrence_count) AS audit_runs_seen
`;

export async function eventsForDate(eventDate: string): Promise<LearningEventRow[]> {
  return sql<LearningEventRow[]>`
    SELECT ${EVENT_COLUMNS} FROM system_learning_events
    WHERE event_date = ${eventDate}
    ORDER BY severity DESC, occurrence_count DESC, event_id DESC
  `.catch(() => []);
}

export async function recurringEvents(minDays = 2): Promise<LearningEventRow[]> {
  // DAYS seen, not audit runs, and never an EXPECTED finding: seeing legacy
  // zeros again tomorrow is the same history, not a recurring defect.
  return sql<LearningEventRow[]>`
    SELECT ${EVENT_COLUMNS} FROM system_learning_events
    WHERE COALESCE(audit_days_seen, occurrence_count) >= ${minDays}
      AND status NOT IN ('EXPECTED', 'CLOSED_EXPECTED')
    ORDER BY COALESCE(audit_days_seen, occurrence_count) DESC, last_seen_at DESC
  `.catch(() => []);
}

export async function unresolvedEvents(): Promise<LearningEventRow[]> {
  // EXPECTED is excluded: the contract permits it, so there is nothing to
  // resolve and nothing a person should be queued against.
  return sql<LearningEventRow[]>`
    SELECT ${EVENT_COLUMNS} FROM system_learning_events
    WHERE status NOT IN ('RESOLVED', 'CLOSED_EXPECTED', 'EXPECTED')
    ORDER BY severity DESC, COALESCE(audit_days_seen, occurrence_count) DESC
  `.catch(() => []);
}

/** Findings the contract in force permits, kept visible rather than hidden. */
export async function expectedEvents(): Promise<LearningEventRow[]> {
  return sql<LearningEventRow[]>`
    SELECT ${EVENT_COLUMNS} FROM system_learning_events
    WHERE status IN ('EXPECTED', 'CLOSED_EXPECTED')
    ORDER BY last_seen_at DESC
  `.catch(() => []);
}

export async function reviewQueue(): Promise<LearningEventRow[]> {
  return sql<LearningEventRow[]>`
    SELECT ${EVENT_COLUMNS} FROM system_learning_events
    WHERE human_approval_required = TRUE AND human_approved = FALSE
      AND status NOT IN ('RESOLVED', 'CLOSED_EXPECTED', 'EXPECTED')
    ORDER BY severity DESC, occurrence_count DESC
  `.catch(() => []);
}

export async function protectionRows(): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`
    SELECT protection_id, error_signature, protection_type, title, rule, module,
           implemented_in, active, failure_count, last_failed_at, last_verified_at, created_at
    FROM system_protections ORDER BY failure_count DESC, created_at DESC
  `.catch(() => []);
}

export async function regressionRows(): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`
    SELECT test_id, learning_event_id, test_name, category, error_signature, description,
           assertion_key, expected_behavior, actual_previous_behavior, current_behavior,
           status, last_run_at, pass_count, fail_count, last_failed_at, created_at,
           -- Selected, not just written. A column the table carries but the
           -- API never returns is the same reporting gap as not having it:
           -- OPEN vs FAIL was recorded and then invisible to every reader.
           never_passed, deterministic, input_condition
    FROM system_regression_cases ORDER BY status DESC, last_run_at DESC NULLS LAST
  `.catch(() => []);
}

/** The counts behind "are we learning?", computed from the record itself. */
export async function learningStats(): Promise<ReturnType<typeof learningEffectiveness>> {
  const [row] = await sql<{
    unique_error_classes: string; protected_classes: string; regression_covered_classes: string;
    recurring_classes: string; unresolved_classes: string; resolved_classes: string;
    needs_human_review: string; expected_classes: string; recurring_after_protection: string;
    total_occurrences: string; total_audit_runs_seen: string;
  }[]>`
    SELECT
      COUNT(DISTINCT error_signature) AS unique_error_classes,
      COUNT(DISTINCT error_signature) FILTER (WHERE protection_id IS NOT NULL) AS protected_classes,
      COUNT(DISTINCT error_signature) FILTER (WHERE regression_test IS NOT NULL) AS regression_covered_classes,
      -- Recurrence is DAYS seen, never audit runs. Counting runs made
      -- "recurring" mean "somebody ran the audit twice".
      COUNT(DISTINCT error_signature) FILTER (WHERE COALESCE(audit_days_seen, occurrence_count) > 1) AS recurring_classes,
      -- EXPECTED is excluded from unresolved: an observation the contract
      -- permits is not an open defect.
      COUNT(DISTINCT error_signature) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED_EXPECTED','EXPECTED')) AS unresolved_classes,
      COUNT(DISTINCT error_signature) FILTER (WHERE status = 'RESOLVED') AS resolved_classes,
      COUNT(DISTINCT error_signature) FILTER (WHERE status = 'NEEDS_HUMAN_REVIEW') AS needs_human_review,
      COUNT(DISTINCT error_signature) FILTER (WHERE status IN ('EXPECTED','CLOSED_EXPECTED')) AS expected_classes,
      -- Protected classes that came back anyway: the only measure of a
      -- protection that does not work.
      COUNT(DISTINCT error_signature) FILTER (
        WHERE protection_id IS NOT NULL AND COALESCE(audit_days_seen, occurrence_count) > 1
      ) AS recurring_after_protection,
      COALESCE(SUM(COALESCE(audit_days_seen, occurrence_count)), 0) AS total_occurrences,
      COALESCE(SUM(COALESCE(audit_runs_seen, occurrence_count)), 0) AS total_audit_runs_seen
    FROM system_learning_events
  `.catch(() => [
    {
      unique_error_classes: '0', protected_classes: '0', regression_covered_classes: '0',
      recurring_classes: '0', unresolved_classes: '0', resolved_classes: '0',
      needs_human_review: '0', expected_classes: '0', recurring_after_protection: '0',
      total_occurrences: '0', total_audit_runs_seen: '0',
    },
  ]);

  const [prot] = await sql<{ n: string }[]>`
    SELECT COALESCE(SUM(failure_count), 0) AS n FROM system_protections
  `.catch(() => [{ n: '0' }]);

  return learningEffectiveness({
    unique_error_classes: Number(row.unique_error_classes),
    protected_classes: Number(row.protected_classes),
    regression_covered_classes: Number(row.regression_covered_classes),
    recurring_classes: Number(row.recurring_classes),
    protection_failures: Number(prot.n),
    unresolved_classes: Number(row.unresolved_classes),
    resolved_classes: Number(row.resolved_classes),
    needs_human_review: Number(row.needs_human_review),
    total_occurrences: Number(row.total_occurrences),
    expected_classes: Number(row.expected_classes),
    recurring_after_protection: Number(row.recurring_after_protection),
    total_audit_runs_seen: Number(row.total_audit_runs_seen),
  });
}

/** "Why did the system fail?" — grouped counts over a window of days. */
export async function failureGroups(days: number): Promise<{ group: string; category: string; n: number }[]> {
  const rows = await sql<{ category: string; n: string }[]>`
    SELECT category, COUNT(*) AS n
    FROM system_learning_occurrences o
    JOIN system_learning_events e USING (event_id)
    WHERE o.detected_at >= NOW() - (${days} || ' days')::interval
    GROUP BY category
  `.catch(() => []);
  const { categoryGroup, CATEGORY_GROUPS } = await import('./learning-taxonomy.js');
  return rows.map((r) => ({
    group: CATEGORY_GROUPS[categoryGroup(r.category)],
    category: r.category,
    n: Number(r.n),
  }));
}

/** The loud warning for a fault that keeps coming back. */
export async function repeatedFailureAlerts(): Promise<Record<string, unknown>[]> {
  const rows = await sql<{
    error_signature: string; error_title: string; category: string; occurrence_count: number;
    audit_days_seen: number | null; audit_runs_seen: number | null;
    first_seen_at: string; last_seen_at: string; protection_id: string | null;
    failure_count: number | null; human_approval_required: boolean; status: string;
  }[]>`
    SELECT e.error_signature, e.error_title, e.category, e.occurrence_count,
           e.audit_days_seen, e.audit_runs_seen, e.status,
           e.first_seen_at, e.last_seen_at, e.protection_id,
           p.failure_count, e.human_approval_required
    FROM system_learning_events e
    LEFT JOIN system_protections p ON p.protection_id = e.protection_id
    WHERE COALESCE(e.audit_days_seen, e.occurrence_count) >= 1
      AND e.status NOT IN ('EXPECTED', 'CLOSED_EXPECTED')
    ORDER BY COALESCE(e.audit_days_seen, e.occurrence_count) DESC
  `.catch(() => []);

  return rows
    .filter((r) => isRepeatedFailure(r.audit_days_seen ?? r.occurrence_count))
    .map((r) => ({
      error_signature: r.error_signature,
      error: r.error_title,
      category: r.category,
      /** Days seen. The recurrence number. */
      occurrences: r.audit_days_seen ?? r.occurrence_count,
      /** Times the audit observed it. Not recurrence. */
      audit_runs_seen: r.audit_runs_seen ?? r.occurrence_count,
      first_seen: r.first_seen_at,
      latest: r.last_seen_at,
      existing_protection: r.protection_id != null,
      protection_effectiveness:
        r.protection_id == null ? 'NONE' : (r.failure_count ?? 0) > 0 ? 'FAILED' : 'UNPROVEN',
      recommendation: r.human_approval_required
        ? 'Human approval is required before any trading-logic modification. Review the evidence and decide.'
        : 'Root-cause investigation required. The existing protection has not stopped this.',
      human_approval_required: r.human_approval_required,
    }));
}

export function severityOrder(a: string, b: string): number {
  return severityRank(b) - severityRank(a);
}
