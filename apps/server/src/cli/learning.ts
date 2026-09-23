// ============================================================
// CLI — SYSTEM LEARNING
// ============================================================
//   npm run learning -- daily        run the audit, then print the report
//   npm run learning -- today        today's findings, no audit run
//   npm run learning -- recurring    faults that have come back
//   npm run learning -- expected     observations the contract permits
//   npm run learning -- unresolved   open faults and what blocks each one
//   npm run learning -- regressions  standing cases and their verdicts
//   npm run learning -- protections  what guards what, and what has failed
//   npm run learning -- review       the human approval queue
//   npm run learning -- history      audit runs over time
//   npm run learning -- report       the full daily report
//
// The spec asked for `python -m audit.learning`. There is no Python in this
// repository — it is a TypeScript monorepo — so the verbs are identical and
// the entry point follows the existing `db:migrate` pattern (tsx against a
// src file). Adding a Python runtime to host one command would mean two
// toolchains to keep working for no gain.
// ============================================================

import { sql } from '../lib/db.js';
import {
  eventsForDate,
  recurringEvents,
  unresolvedEvents,
  expectedEvents,
  reviewQueue,
  protectionRows,
  regressionRows,
  learningStats,
  failureGroups,
  repeatedFailureAlerts,
} from '../services/learning-engine.js';
import { runSystemAudit } from '../services/system-learning-audit.js';
import { CATEGORY_GROUPS, categoryGroup, REPEATED_FAILURE_THRESHOLD } from '../services/learning-taxonomy.js';

const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n);
const rpad = (s: unknown, n: number) => String(s ?? '').padStart(n);
const rule = (n = 68) => '-'.repeat(n);

function head(title: string, date?: string): void {
  console.log(`\n${title}`);
  if (date) console.log(`Date: ${date}`);
  console.log(rule());
}

async function printSummary(date: string): Promise<void> {
  const [events, stats, alerts, groups, lastRun] = await Promise.all([
    eventsForDate(date),
    learningStats(),
    repeatedFailureAlerts(),
    failureGroups(1),
    sql<{ event_date: string; status: string; started_at: Date; findings: number }[]>`
      SELECT event_date::text AS event_date, status, started_at, findings
      FROM system_audit_runs ORDER BY started_at DESC LIMIT 1
    `.catch(() => []),
  ]);

  head('DAILY SYSTEM LEARNING', date);

  // Stated first, because "0 errors" and "the audit never ran" look identical
  // in every other line of this report.
  const run = lastRun[0];
  if (run == null) {
    console.log('AUDIT STATUS: never run');
  } else if (run.event_date !== date) {
    console.log(`AUDIT STATUS: has NOT run today (last run ${run.event_date}, ${run.status})`);
  } else {
    console.log(`AUDIT STATUS: ran today — ${run.status}`);
  }

  const openStates = ['RESOLVED', 'CLOSED_EXPECTED', 'EXPECTED'];
  console.log();
  const isExpectedRow = (e: { status: string }) => e.status === 'EXPECTED' || e.status === 'CLOSED_EXPECTED';
  const days = (e: { audit_days_seen?: number; occurrence_count: number }) =>
    e.audit_days_seen ?? e.occurrence_count;

  console.log(`Errors:              ${events.filter((e) => !isExpectedRow(e)).length}`);
  console.log(`New:                 ${events.filter((e) => e.status === 'NEW').length}`);
  // Days seen, never audit runs: a fault observed 136 times in one day is one
  // day observed, not a 136-occurrence recurring defect.
  console.log(`Recurring:           ${events.filter((e) => days(e) > 1 && !isExpectedRow(e)).length}`);
  console.log(`Expected:            ${events.filter(isExpectedRow).length}`);
  console.log(`Resolved:            ${events.filter((e) => e.status === 'RESOLVED').length}`);
  console.log(`Needs Review:        ${events.filter((e) => e.status === 'NEEDS_HUMAN_REVIEW').length}`);
  console.log(`Regression Failures: ${events.filter((e) => e.regression_test_status === 'FAIL').length}`);
  console.log(`Open never-passed:   ${events.filter((e) => e.regression_test_status === 'OPEN').length}`);
  console.log(`Open:                ${events.filter((e) => !openStates.includes(e.status)).length}`);

  if (groups.length > 0) {
    console.log('\nWHY DID THE SYSTEM FAIL? (today)');
    const roll: Record<string, number> = {};
    for (const g of groups) roll[g.group] = (roll[g.group] ?? 0) + g.n;
    for (const [g, n] of Object.entries(roll).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(g, 26)} ${rpad(n, 4)}`);
    }
  }

  const top = alerts[0] as any;
  if (top != null) {
    console.log(`\nTop recurrence:      ${top.error_signature}`);
    console.log(`Occurrences:         ${top.occurrences}`);
    console.log(`Protection:          ${top.existing_protection ? top.protection_effectiveness : 'NONE'}`);
  }

  console.log(`\nProtection failures: ${stats.stats.protection_failures}`);
  console.log(`Human approval required: ${(await reviewQueue()).length}`);
}

async function printLearningStats(): Promise<void> {
  const s = await learningStats();
  head('LEARNING STATUS');
  console.log(`Unique error classes:   ${rpad(s.stats.unique_error_classes, 5)}`);
  console.log(`Protected:              ${rpad(s.stats.protected_classes, 5)}`);
  console.log(`Regression-covered:     ${rpad(s.stats.regression_covered_classes, 5)}`);
  console.log(`Recurring:              ${rpad(s.stats.recurring_classes, 5)}`);
  console.log(`Protection failures:    ${rpad(s.stats.protection_failures, 5)}`);
  console.log(`Unresolved:             ${rpad(s.stats.unresolved_classes, 5)}`);
  console.log(`Needs human review:     ${rpad(s.stats.needs_human_review, 5)}`);
  console.log();
  console.log(`Protection coverage:    ${s.protection_coverage ?? 'n/a'}%   (${s.formula.protection_coverage})`);
  console.log(`Regression coverage:    ${s.regression_coverage ?? 'n/a'}%   (${s.formula.regression_coverage})`);
  console.log(`Recurrence rate:        ${s.recurrence_rate ?? 'n/a'}%   (${s.formula.recurrence_rate})`);
  console.log(`Avg occurrences/class:  ${s.average_occurrences_per_class ?? 'n/a'}`);
  console.log(`\n${s.formula.note}`);
}

async function printEvents(date: string): Promise<void> {
  const events = await eventsForDate(date);
  head(`ERRORS DETECTED — ${date}`);
  if (events.length === 0) {
    console.log('none recorded for this date');
    return;
  }
  for (const e of events) {
    console.log(`\n[${e.severity}] ${e.error_title}`);
    console.log(`  signature   ${e.error_signature}`);
    console.log(`  category    ${e.category} (${CATEGORY_GROUPS[categoryGroup(e.category)]})`);
    console.log(`  module      ${e.module ?? '-'}${e.component ? ` / ${e.component}` : ''}`);
    console.log(`  expected    ${e.expected_value ?? '-'}`);
    console.log(`  actual      ${e.actual_value ?? '-'}`);
    console.log(`  days seen   ${e.audit_days_seen ?? e.occurrence_count}  (audit runs ${e.audit_runs_seen ?? e.occurrence_count})`);
    if (e.classification) console.log(`  verdict     ${e.classification}`);
    if (e.contract_generation) console.log(`  contract    ${e.contract_generation}`);
    if (e.evidence_quality) console.log(`  evidence    ${e.evidence_quality}`);
    console.log(`  root cause  ${e.root_cause ?? 'NOT ESTABLISHED — routed to human review'}`);
    console.log(`  status      ${e.status}`);
    console.log(`  protection  ${e.protection_id ?? 'none'}`);
    console.log(`  regression  ${e.regression_test ?? 'none'}${e.regression_test_status ? ` (${e.regression_test_status})` : ''}`);
    if (e.human_approval_required) {
      console.log(`  APPROVAL    required${e.human_approved ? ' — approved' : ' — PENDING (trading path)'}`);
    }
  }
}

async function printRecurring(): Promise<void> {
  const events = await recurringEvents(2);
  head('RECURRING ERRORS');
  if (events.length === 0) {
    console.log('none — no fault has been seen more than once');
    return;
  }
  for (const e of events) {
    const status =
      e.protection_id == null ? 'NONE' : (e.audit_days_seen ?? e.occurrence_count) > 1 ? 'FAILED' : 'ACTIVE';
    console.log(`\n${e.error_title}`);
    console.log(`  signature    ${e.error_signature}`);
    console.log(`  days seen    ${e.audit_days_seen ?? e.occurrence_count}  (audit runs ${e.audit_runs_seen ?? e.occurrence_count})`);
    console.log(`  first seen   ${new Date(e.first_seen_at).toISOString()}`);
    console.log(`  latest       ${new Date(e.last_seen_at).toISOString()}`);
    console.log(`  protection   ${e.protection_id ?? 'none'}`);
    console.log(`  effectiveness ${status}`);
    if (status === 'FAILED') {
      console.log('  ** the existing protection did not stop this. Root-cause investigation required. **');
    }
    if ((e.audit_days_seen ?? e.occurrence_count) >= REPEATED_FAILURE_THRESHOLD) {
      console.log(`  ** REPEATED SYSTEM FAILURE (>= ${REPEATED_FAILURE_THRESHOLD} occurrences) **`);
    }
  }
}

async function printExpected(): Promise<void> {
  const events = await expectedEvents();
  head('EXPECTED UNDER CONTRACT');
  if (events.length === 0) {
    console.log('none');
    return;
  }
  console.log(
    'Real observations whose verdict is decided by the contract generation\n' +
    'that wrote the rows. Not suppressed, and not defects. If the governing\n' +
    'contract changes, the same observation becomes a defect again.\n'
  );
  for (const e of events) {
    console.log(`\n${e.error_title}`);
    console.log(`  signature     ${e.error_signature}`);
    console.log(`  why detected  ${e.description ?? '-'}`);
    console.log(`  why expected  ${e.classification_reason ?? '-'}`);
    console.log(`  contract      ${e.contract_generation ?? '-'}`);
    console.log(`  evidence      ${e.evidence_quality ?? '-'}`);
    console.log(`  first seen    ${new Date(e.first_seen_at).toISOString()}`);
    console.log(`  days seen     ${e.audit_days_seen ?? e.occurrence_count}  (audit runs ${e.audit_runs_seen ?? e.occurrence_count})`);
  }
}

async function printUnresolved(): Promise<void> {
  const events = await unresolvedEvents();
  head('UNRESOLVED ISSUES');
  if (events.length === 0) {
    console.log('none open');
    return;
  }
  for (const e of events) {
    console.log(`\n[${e.severity}] ${e.error_title}  (${e.status})`);
    console.log(`  signature   ${e.error_signature}`);
    console.log(`  root cause  ${e.root_cause ?? 'UNKNOWN'}`);
    console.log(`  blocked by  ${e.review_note ?? '-'}`);
    if (e.root_cause == null) {
      console.log('  evidence    expected/actual, source commit and snapshot are on the record');
      console.log(`              commit ${e.source_commit ?? 'unknown'}`);
      console.log(`  suggested   investigate ${e.module ?? 'the reporting module'} / ${e.component ?? 'the failing identity'}`);
    }
  }
}

async function printRegressions(): Promise<void> {
  const rows = await regressionRows();
  head('REGRESSION CASES');
  if (rows.length === 0) {
    console.log('none created yet');
    return;
  }
  console.log(`${pad('STATUS', 8)} ${pad('PASS', 5)} ${pad('FAIL', 5)} TEST`);
  for (const r of rows) {
    console.log(`${pad(r.status, 8)} ${pad(r.pass_count, 5)} ${pad(r.fail_count, 5)} ${r.test_id}`);
  }
  const failing = rows.filter((r) => r.status === 'FAIL');
  if (failing.length > 0) {
    console.log(`\nREGRESSION FAILURES: ${failing.length}`);
    for (const r of failing) {
      console.log(`  ${r.test_id}`);
      console.log(`    expected  ${r.expected_behavior}`);
      console.log(`    observed  ${r.current_behavior}`);
    }
  }
}

async function printProtections(): Promise<void> {
  const rows = await protectionRows();
  head('PROTECTIONS');
  if (rows.length === 0) {
    console.log('none registered');
    return;
  }
  for (const r of rows) {
    const failures = Number(r.failure_count ?? 0);
    console.log(`\n${r.protection_type}  ${r.title}`);
    console.log(`  id        ${r.protection_id}`);
    console.log(`  rule      ${r.rule}`);
    console.log(`  lives in  ${r.implemented_in}`);
    console.log(`  failures  ${failures}${failures > 0 ? '  ** INEFFECTIVE **' : ''}`);
  }
}

async function printReview(): Promise<void> {
  const events = await reviewQueue();
  head('HUMAN REVIEW QUEUE');
  if (events.length === 0) {
    console.log('empty — nothing is waiting on a person');
    return;
  }
  console.log(
    'These are trading-path findings. They have been detected, explained and\n' +
    'proposed. Nothing will be applied: this engine does not modify trading\n' +
    'logic, and approving an item records consent for a person to make the\n' +
    'change, not the change itself.\n'
  );
  for (const e of events) {
    console.log(`\n#${e.event_id}  [${e.severity}] ${e.error_title}`);
    console.log(`  category     ${e.category}`);
    console.log(`  module       ${e.module ?? '-'}`);
    console.log(`  occurrences  ${e.occurrence_count}`);
    console.log(`  expected     ${e.expected_value ?? '-'}`);
    console.log(`  actual       ${e.actual_value ?? '-'}`);
    console.log(`  root cause   ${e.root_cause ?? 'UNKNOWN'}`);
    console.log(`  suggested    ${e.fix_description ?? 'none recorded'}`);
    console.log(`  regression   ${e.regression_test ?? 'none'}`);
    console.log('  actions      APPROVE | REJECT | MODIFY | DEFER | EXPECTED');
    console.log(`               POST /api/learning/review/${e.event_id}`);
  }
}

async function printHistory(): Promise<void> {
  const runs = await sql<{
    event_date: string; started_at: Date; status: string; findings: number;
    new_errors: number; recurrences: number; protection_failures: number;
    regression_failures: number; detectors_failed: number;
  }[]>`
    SELECT event_date::text AS event_date, started_at, status, findings, new_errors,
           recurrences, protection_failures, regression_failures, detectors_failed
    FROM system_audit_runs ORDER BY started_at DESC LIMIT 30
  `.catch(() => []);
  head('AUDIT HISTORY');
  if (runs.length === 0) {
    console.log('no audit has run yet');
    return;
  }
  console.log(`${pad('DATE', 12)} ${pad('STATUS', 9)} ${pad('FOUND', 6)} ${pad('NEW', 5)} ${pad('RECUR', 6)} ${pad('PROT-F', 7)} ${pad('REG-F', 6)} DET-F`);
  for (const r of runs) {
    console.log(
      `${pad(r.event_date, 12)} ${pad(r.status, 9)} ${pad(r.findings, 6)} ${pad(r.new_errors, 5)} ` +
      `${pad(r.recurrences, 6)} ${pad(r.protection_failures, 7)} ${pad(r.regression_failures, 6)} ${r.detectors_failed}`
    );
  }
}

async function printFullReport(date: string): Promise<void> {
  console.log('\n===============================================================');
  console.log('  DAILY SYSTEM LEARNING / SELF-AUDIT');
  console.log('===============================================================');
  await printSummary(date);
  await printEvents(date);
  await printRecurring();
  await printExpected();
  await printProtections();
  await printRegressions();
  await printUnresolved();
  await printReview();
  await printLearningStats();
  console.log('\n' + rule());
  console.log('This engine records and proposes. It does not change trading logic.');
}

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? 'daily').toLowerCase();
  const date =
    process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? istToday();

  switch (cmd) {
    case 'daily': {
      const summary = await runSystemAudit({ trigger: 'CLI' });
      if (summary.already_completed) {
        console.log(
          `audit ALREADY_COMPLETED for ${summary.event_date} — declined rather than re-run.\n` +
          `Re-running would advance audit_runs_seen and every count derived from runs for no new information.`
        );
      } else {
        console.log(
          `audit ${summary.status}: ${summary.findings} finding(s), ${summary.new_errors} new, ` +
          `${summary.expected_findings} expected, ${summary.recurrences} recurrence(s)`
        );
        if (summary.source_data_ready === false) {
          console.log(`source data NOT ready: ${summary.source_data_note}`);
        }
      }
      if (summary.detector_errors.length > 0) {
        console.log('\nDETECTORS THAT COULD NOT EVALUATE (not the same as passing):');
        for (const d of summary.detector_errors) console.log(`  ${d.detector}: ${d.error}`);
      }
      if (summary.error) console.log(`\nAUDIT ERROR: ${summary.error}`);
      await printFullReport(summary.event_date);
      break;
    }
    case 'today':
      await printSummary(date);
      break;
    case 'events':
      await printEvents(date);
      break;
    case 'recurring':
      await printRecurring();
      break;
    case 'expected':
      await printExpected();
      break;
    case 'unresolved':
      await printUnresolved();
      break;
    case 'regressions':
      await printRegressions();
      break;
    case 'protections':
      await printProtections();
      break;
    case 'review':
      await printReview();
      break;
    case 'history':
      await printHistory();
      break;
    case 'stats':
      await printLearningStats();
      break;
    case 'report':
      await printFullReport(date);
      break;
    default:
      console.log('usage: npm run learning -- <daily|today|events|recurring|expected|unresolved|regressions|protections|review|history|stats|report> [YYYY-MM-DD]');
      process.exitCode = 1;
  }

  await sql.end({ timeout: 5 });
}

main().catch((err: any) => {
  console.error(`learning CLI failed: ${err.message}`);
  process.exitCode = 1;
  void sql.end({ timeout: 5 });
});
