// ============================================================
// API ROUTES — SYSTEM LEARNING / SELF-AUDIT
// ============================================================
// Read-only except for the review endpoint, which records a human decision.
//
// There is no endpoint that applies a trading-logic change. The review
// endpoint records consent; making the change remains a person's job with a
// commit attached to it. That is the whole safety model, and it is enforced
// by there being no code here that could do otherwise.
// ============================================================

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
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
  recordReview,
  type ReviewDecision,
} from '../services/learning-engine.js';
import { runSystemAudit, AUDIT_SCOPE } from '../services/system-learning-audit.js';
import {
  CATEGORY_GROUPS,
  categoryGroup,
  TRADING_LOGIC_CATEGORIES,
  AUTO_SAFE_SCOPES,
  REPEATED_FAILURE_THRESHOLD,
  CLASSIFICATIONS,
  EVIDENCE_QUALITY_MEANING,
  isExpected,
} from '../services/learning-taxonomy.js';

const VALID_DECISIONS: ReviewDecision[] = ['APPROVE', 'REJECT', 'MODIFY', 'DEFER', 'EXPECTED'];

function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function createLearningRoutes(): Router {
  const router = Router();

  /**
   * GET /api/learning/summary
   *
   * The daily headline, plus the two questions the report exists to answer:
   * why did the system fail, and are we learning.
   */
  router.get('/summary', async (req: Request, res: Response) => {
    try {
      const date = typeof req.query.date === 'string' ? req.query.date : istToday();
      const [events, stats, alerts, today, d7, d30, all, lastRun] = await Promise.all([
        eventsForDate(date),
        learningStats(),
        repeatedFailureAlerts(),
        failureGroups(1),
        failureGroups(7),
        failureGroups(30),
        failureGroups(36500),
        sql<Record<string, unknown>[]>`
          SELECT audit_run_id, started_at, finished_at, event_date::text AS event_date,
                 status, detectors_run, detectors_failed, findings, new_errors,
                 recurrences, protection_failures, regression_failures, error
          FROM system_audit_runs ORDER BY started_at DESC LIMIT 1
        `.catch(() => []),
      ]);

      // EXPECTED is not open: the contract permits it, so there is nothing
      // to work on. It stays visible in its own count rather than inflating
      // the defect numbers.
      const open = events.filter((e) => !['RESOLVED', 'CLOSED_EXPECTED', 'EXPECTED'].includes(e.status));
      const expected = events.filter((e) => isExpected(e.status));
      const roll = (rows: { group: string; n: number }[]) => {
        const m: Record<string, number> = {};
        for (const g of Object.values(CATEGORY_GROUPS)) m[g] = 0;
        for (const r of rows) m[r.group] = (m[r.group] ?? 0) + r.n;
        return m;
      };

      res.json({
        success: true,
        data: {
          date,
          /**
           * Whether the audit actually ran. Without this, "0 errors" is
           * ambiguous between a clean day and a job that never fired — and
           * only one of those is good news.
           */
          last_audit_run: lastRun[0] ?? null,
          audit_ran_today: (lastRun[0] as any)?.event_date === date,
          counts: {
            total_issues: events.length,
            new_errors: events.filter((e) => e.status === 'NEW').length,
            /**
             * DAYS seen, never audit runs, and never an expected finding.
             * Counting runs made "recurring" mean "the audit ran twice".
             */
            recurring: events.filter(
              (e) => (e.audit_days_seen ?? e.occurrence_count) > 1 && !isExpected(e.status)
            ).length,
            expected: expected.length,
            resolved: events.filter((e) => e.status === 'RESOLVED').length,
            needs_review: events.filter((e) => e.status === 'NEEDS_HUMAN_REVIEW').length,
            protection_failures: events.filter(
              (e) =>
                e.protection_id != null &&
                (e.audit_days_seen ?? e.occurrence_count) > 1 &&
                !isExpected(e.status)
            ).length,
            regression_failures: events.filter((e) => e.regression_test_status === 'FAIL').length,
            open_never_passed: events.filter((e) => e.regression_test_status === 'OPEN').length,
            open,
          },
          /**
           * The verdict vocabulary, published so a reader can see that
           * "expected" is a classification with evidence behind it rather
           * than a category things get dropped into.
           */
          classifications: CLASSIFICATIONS,
          evidence_quality_meaning: EVIDENCE_QUALITY_MEANING,
          counter_semantics: {
            audit_days_seen:
              'distinct audit DAYS this fault was seen. This is the recurrence number and the only one used for recurrence.',
            audit_runs_seen:
              'times the audit observed it across all runs. Reported for transparency; audit execution frequency is not defect recurrence.',
          },
          why_did_the_system_fail: {
            today: roll(today),
            last_7_days: roll(d7),
            last_30_days: roll(d30),
            all_time: roll(all),
          },
          learning: stats,
          repeated_failure_alerts: alerts,
          repeated_failure_threshold: REPEATED_FAILURE_THRESHOLD,
          safety: {
            trading_logic_categories: TRADING_LOGIC_CATEGORIES,
            auto_safe_scopes: AUTO_SAFE_SCOPES,
            note:
              'A finding in a trading-logic category is detected, explained and proposed only. There is no endpoint, job or code path in this engine that applies a trading-logic change; the review endpoint records human consent, it does not act on it.',
          },
          scope: AUDIT_SCOPE,
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning summary failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** GET /api/learning/events?date=YYYY-MM-DD */
  router.get('/events', async (req: Request, res: Response) => {
    try {
      const date = typeof req.query.date === 'string' ? req.query.date : istToday();
      const events = await eventsForDate(date);
      res.json({
        success: true,
        data: {
          date,
          events: events.map((e) => ({ ...e, category_group: CATEGORY_GROUPS[categoryGroup(e.category)] })),
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning events failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** GET /api/learning/recurring */
  router.get('/recurring', async (_req: Request, res: Response) => {
    try {
      const events = await recurringEvents(2);
      res.json({
        success: true,
        data: {
          events: events.map((e) => ({
            ...e,
            category_group: CATEGORY_GROUPS[categoryGroup(e.category)],
            /**
             * The distinction the whole engine turns on: a fault coming back
             * when nothing guarded it is a gap, a fault coming back when
             * something did is a protection that does not work.
             */
            protection_status:
              e.protection_id == null
                ? 'NONE'
                : (e.audit_days_seen ?? e.occurrence_count) > 1
                  ? 'FAILED'
                  : 'ACTIVE',
          })),
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning recurring failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/learning/expected
   *
   * Findings the contract in force permits. Kept visible with their evidence
   * rather than suppressed: the record has to be able to answer why each was
   * originally detected and which generation makes it valid.
   */
  router.get('/expected', async (_req: Request, res: Response) => {
    try {
      const events = await expectedEvents();
      res.json({
        success: true,
        data: {
          events: events.map((e) => ({
            ...e,
            category_group: CATEGORY_GROUPS[categoryGroup(e.category)],
            why_detected: e.description,
            why_expected: e.classification_reason,
            which_contract: e.contract_generation,
          })),
          note:
            'These are real observations with a contract-aware verdict, not suppressed findings. If the contract governing those rows changes, the same observation becomes a defect again.',
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning expected failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** GET /api/learning/unresolved */
  router.get('/unresolved', async (_req: Request, res: Response) => {
    try {
      const events = await unresolvedEvents();
      res.json({
        success: true,
        data: {
          events: events.map((e) => ({
            ...e,
            category_group: CATEGORY_GROUPS[categoryGroup(e.category)],
            blocked_by: e.review_note,
            root_cause_known: e.root_cause != null,
          })),
          note:
            'A finding stays here until its root cause is established, a fix is recorded, and a protection exists where one is possible. The symptom going quiet is not resolution.',
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning unresolved failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** GET /api/learning/regressions */
  router.get('/regressions', async (_req: Request, res: Response) => {
    try {
      const rows = await regressionRows();
      res.json({
        success: true,
        data: {
          cases: rows,
          failing: rows.filter((r) => r.status === 'FAIL'),
          note:
            'Each case names an assertion the audit re-evaluates every cycle. A case whose fault reappears is reported as a REGRESSION FAILURE, not as a new discovery.',
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning regressions failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** GET /api/learning/protections */
  router.get('/protections', async (_req: Request, res: Response) => {
    try {
      const rows = await protectionRows();
      res.json({
        success: true,
        data: {
          protections: rows,
          failed: rows.filter((r) => Number(r.failure_count ?? 0) > 0),
          note:
            'failure_count is the number of times the fault recurred AFTER this protection was recorded. Any value above zero means the protection does not work, whatever it asserts.',
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning protections failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** GET /api/learning/review — the human approval queue */
  router.get('/review', async (_req: Request, res: Response) => {
    try {
      const events = await reviewQueue();
      res.json({
        success: true,
        data: {
          queue: events.map((e) => ({
            event_id: e.event_id,
            issue: e.error_title,
            category: e.category,
            category_group: CATEGORY_GROUPS[categoryGroup(e.category)],
            module: e.module,
            severity: e.severity,
            occurrences: e.occurrence_count,
            first_seen: e.first_seen_at,
            latest: e.last_seen_at,
            evidence: { expected: e.expected_value, actual: e.actual_value, commit: e.source_commit },
            root_cause: e.root_cause,
            root_cause_known: e.root_cause != null,
            impact: e.description,
            suggested_fix: e.fix_description,
            risk: e.severity,
            affected_modules: [e.module, e.component].filter(Boolean),
            regression_test: e.regression_test,
            expected_behavior: e.expected_value,
            approval_status: e.human_approved ? 'APPROVED' : 'PENDING',
          })),
          actions: VALID_DECISIONS,
          note:
            'Approving an item records that a human consented to the change. It does not make the change: no code path in this engine edits a trading module.',
        },
      });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning review queue failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** POST /api/learning/review/:id */
  router.post('/review/:id', async (req: Request, res: Response) => {
    try {
      const eventId = Number(req.params.id);
      if (!Number.isInteger(eventId) || eventId <= 0) {
        res.status(400).json({ success: false, error: 'event id must be a positive integer' });
        return;
      }
      const decision = String(req.body?.decision ?? '').toUpperCase() as ReviewDecision;
      if (!VALID_DECISIONS.includes(decision)) {
        res.status(400).json({
          success: false,
          error: `decision must be one of ${VALID_DECISIONS.join(', ')}`,
        });
        return;
      }
      const reviewer = String(req.body?.reviewer ?? '').trim();
      if (reviewer === '') {
        // An approval with no name attached is not an approval anybody can be
        // held to, which defeats the point of the gate.
        res.status(400).json({ success: false, error: 'reviewer is required — an unattributed approval is not one' });
        return;
      }

      const result = await recordReview({
        eventId,
        decision,
        reviewer,
        note: typeof req.body?.note === 'string' ? req.body.note : null,
        fixDescription: typeof req.body?.fix_description === 'string' ? req.body.fix_description : null,
      });
      if (!result.ok) {
        res.status(404).json({ success: false, error: result.message });
        return;
      }
      logger.info({ eventId, decision, reviewer }, 'Learning review recorded');
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning review failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/learning/audit — run the audit on demand.
   *
   * Read-only with respect to trading data: it runs the same detectors the
   * scheduled job does and writes only learning records.
   */
  router.post('/audit', async (req: Request, res: Response) => {
    try {
      // ?force=true re-runs a date that already completed, superseding the
      // previous run. Deliberately opt-in and never what the scheduler does:
      // the default is idempotent, and a forced re-run is an operator saying
      // "the detector was wrong, evaluate the day again".
      const force = req.query.force === 'true' || req.body?.force === true;
      const summary = await runSystemAudit({ trigger: force ? 'MANUAL_FORCED' : 'MANUAL', force });
      res.json({ success: true, data: summary });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Manual learning audit failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** GET /api/learning/history?days=30 */
  router.get('/history', async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
      const runs = await sql<Record<string, unknown>[]>`
        SELECT audit_run_id, started_at, finished_at, event_date::text AS event_date, status,
               detectors_run, detectors_failed, findings, new_errors, recurrences,
               protection_failures, regression_failures, source_commit, error
        FROM system_audit_runs
        WHERE started_at >= NOW() - (${days} || ' days')::interval
        ORDER BY started_at DESC
      `.catch(() => []);
      res.json({ success: true, data: { days, runs } });
    } catch (err: any) {
      logger.error({ error: err.message }, 'Learning history failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
