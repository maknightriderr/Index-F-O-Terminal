// ============================================================
// PLAN-VS-TRADE RECONCILIATION (audit 2026-10-18, REC-1)
// ============================================================
// Every closed option plan has a CLOSED event, the close the monitor decided:
// "WIN (TARGET) at 328.4". The trade row (signals) must hold the same outcome,
// reason and exit. Before the 9 Oct idempotent-close fix one row did not
// (8c7d3ec0: the plan's first close was a WIN at 328.4, the row was later
// overwritten at 261.3), and nothing would have noticed another.
//
// Once a day, while no exchange trades, every plan closed in the last 90 days
// is compared with its trade row. The report is kept for System Health
// (GET /api/diagnostics/reconciliation) and a NEW disagreement is sent to
// Telegram once. Read-only: it never corrects a row. A correction is a
// deliberate, reviewed change. Voided rows are listed apart: every statistic
// already excludes them.
// ============================================================

import { redis } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { notifyOperationalAlert } from './telegram.js';
import { schemaFileReady } from './ensure-capture-schema.js';

export const RECONCILE_REPORT_KEY = 'reconcile:plan-vs-trade:last';
const ALERTED_KEY = (signalId: string) => `reconcile:plan-vs-trade:alerted:${signalId}`;
const RUN_CLAIM_KEY = (date: string) => `reconcile:plan-vs-trade:run:${date}`;
const LOOKBACK_DAYS = 90;
/** A close queued during an outage is applied within minutes; younger plan closes are not judged yet. */
const SETTLE_MS = 30 * 60_000;
const TICK_MS = 15 * 60_000;
/** The run window, IST hours [from, to): after the last MCX close, before any pre-open. */
const RUN_FROM_HOUR = 1;
const RUN_TO_HOUR = 7;

export type ReconcileClass = 'AGREES' | 'TRADE_OPEN' | 'DIFFERS' | 'VOIDED' | 'UNPARSED';

export interface PlanTradeRow {
  signalId: string;
  firstClose: string | null;
  firstAt: number;
  closedEvents: number;
  outcome: string | null;
  closeReason: string | null;
  exitPrice: number | null;
  voided: boolean;
}

export interface ReconcileMismatch {
  signalId: string;
  cls: 'TRADE_OPEN' | 'DIFFERS';
  plan: string | null;
  trade: string;
}

export interface ReconcileReport {
  at: number;
  lookbackDays: number;
  plans: number;
  agrees: number;
  mismatches: ReconcileMismatch[];
  /** Voided rows whose plan recorded a close: excluded from statistics already; listed so the record is visible. */
  voided: Array<{ signalId: string; plan: string | null; trade: string }>;
  unparsed: number;
  multiClose: number;
}

const CLOSE_RE = /^(WIN|LOSS|EXPIRED) \(([A-Z0-9_]+)\)(?: at (-?\d+(?:\.\d+)?))?$/;
const tradeText = (r: PlanTradeRow) => (r.outcome == null ? 'open' : `${r.outcome} (${r.closeReason ?? '?'})${r.exitPrice != null ? ` at ${r.exitPrice}` : ''}`);

/** Pure: does the trade row hold the close its plan recorded first? */
export function classifyPlanTrade(r: PlanTradeRow, now: number): ReconcileClass | null {
  if (r.voided) return 'VOIDED';
  const m = CLOSE_RE.exec(r.firstClose?.trim() ?? '');
  if (!m) return 'UNPARSED';
  if (r.outcome == null) return now - r.firstAt >= SETTLE_MS ? 'TRADE_OPEN' : null;
  if (r.outcome !== m[1] || r.closeReason !== m[2]) return 'DIFFERS';
  if (m[3] != null && (r.exitPrice == null || Math.abs(r.exitPrice - Number(m[3])) > 0.005)) return 'DIFFERS';
  return 'AGREES';
}

/** Pure: the report over every plan-trade pair. */
export function reconcile(rows: readonly PlanTradeRow[], now: number): ReconcileReport {
  const report: ReconcileReport = { at: now, lookbackDays: LOOKBACK_DAYS, plans: rows.length, agrees: 0, mismatches: [], voided: [], unparsed: 0, multiClose: 0 };
  for (const r of rows) {
    if (r.closedEvents > 1) report.multiClose++;
    const cls = classifyPlanTrade(r, now);
    if (cls === 'AGREES') report.agrees++;
    else if (cls === 'UNPARSED') report.unparsed++;
    else if (cls === 'VOIDED') report.voided.push({ signalId: r.signalId, plan: r.firstClose, trade: tradeText(r) });
    else if (cls === 'TRADE_OPEN' || cls === 'DIFFERS') report.mismatches.push({ signalId: r.signalId, cls, plan: r.firstClose, trade: tradeText(r) });
  }
  return report;
}

async function loadPlanTradeRows(): Promise<PlanTradeRow[]> {
  const rows = await sql<{ signal_id: string; first_close: string | null; first_at: Date; closed_events: number; outcome: string | null; close_reason: string | null; exit_price: string | null; voided: boolean }[]>`
    WITH c AS (
      SELECT p.signal_id, (array_agg(e.reason ORDER BY e.at))[1] AS first_close, min(e.at) AS first_at, count(*)::int AS closed_events
      FROM option_plans p JOIN option_plan_events e ON e.plan_id = p.plan_id
      WHERE e.event_type = 'CLOSED' AND e.at > NOW() - ${`${LOOKBACK_DAYS} days`}::interval
      GROUP BY p.signal_id
    )
    SELECT c.signal_id, c.first_close, c.first_at, c.closed_events,
      s.inputs->>'outcome' AS outcome, s.inputs->>'closeReason' AS close_reason, s.inputs->>'exitPrice' AS exit_price,
      coalesce((s.inputs->>'voided') = 'true', false) AS voided
    FROM c JOIN signals s ON s.id = c.signal_id
  `;
  return rows.map((r) => ({
    signalId: r.signal_id,
    firstClose: r.first_close,
    firstAt: new Date(r.first_at).getTime(),
    closedEvents: Number(r.closed_events),
    outcome: r.outcome,
    closeReason: r.close_reason,
    exitPrice: r.exit_price != null && Number.isFinite(Number(r.exit_price)) ? Number(r.exit_price) : null,
    voided: r.voided === true,
  }));
}

/** Run once: compare, keep the report, alert on mismatches not alerted before. Returns the report. */
export async function runPlanTradeReconciliation(now = Date.now()): Promise<ReconcileReport | null> {
  if (!schemaFileReady('035_option_plans.sql')) return null;
  const report = reconcile(await loadPlanTradeRows(), now);
  await redis.set(RECONCILE_REPORT_KEY, JSON.stringify(report), 'EX', 8 * 86_400);
  const fresh: ReconcileMismatch[] = [];
  for (const m of report.mismatches) if (await redis.set(ALERTED_KEY(m.signalId), String(now), 'EX', 30 * 86_400, 'NX')) fresh.push(m);
  if (fresh.length > 0) {
    const lines = fresh.slice(0, 5).map((m) => `• ${m.signalId.slice(0, 8)}: plan says ${m.plan ?? '?'}, the trade row says ${m.trade}`);
    await notifyOperationalAlert(
      `Paper-trade record check: ${fresh.length} trade row(s) disagree with the close their plan recorded.\n${lines.join('\n')}${fresh.length > 5 ? `\n…and ${fresh.length - 5} more` : ''}\nNothing was changed. Review them on System Health.`
    );
  }
  logger.info({ plans: report.plans, agrees: report.agrees, mismatches: report.mismatches.length, newlyAlerted: fresh.length, voided: report.voided.length }, 'Plan-vs-trade reconciliation');
  return report;
}

export async function readReconciliationReport(): Promise<ReconcileReport | null> {
  const raw = await redis.get(RECONCILE_REPORT_KEY);
  try {
    return raw ? (JSON.parse(raw) as ReconcileReport) : null;
  } catch {
    return null;
  }
}

/** Pure: the IST date of `now` when it falls in the run window, else null. */
export function reconcileRunDate(now: number): string | null {
  const ist = new Date(now + 5.5 * 3600_000);
  const h = ist.getUTCHours();
  return h >= RUN_FROM_HOUR && h < RUN_TO_HOUR ? ist.toISOString().slice(0, 10) : null;
}

let started = false;
export function startRecordReconciliation(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    const date = reconcileRunDate(Date.now());
    if (!date) return;
    // Claimed before the work so a restart in the window never runs it twice; released on failure for a retry.
    if (!(await redis.set(RUN_CLAIM_KEY(date), 'running', 'EX', 2 * 86_400, 'NX'))) return;
    try {
      await runPlanTradeReconciliation();
      await redis.set(RUN_CLAIM_KEY(date), 'done', 'EX', 2 * 86_400);
    } catch (err) {
      await redis.del(RUN_CLAIM_KEY(date)).catch(() => undefined);
      throw err;
    }
  };
  const safeTick = () => void tick().catch((err: any) => logger.warn({ error: err.message }, 'Plan-vs-trade reconciliation failed (retried next tick)'));
  setTimeout(() => {
    safeTick();
    setInterval(safeTick, TICK_MS);
  }, 90_000);
  logger.info({ window: `${RUN_FROM_HOUR}:00-${RUN_TO_HOUR}:00 IST` }, 'Plan-vs-trade reconciliation started (once a day while no exchange trades)');
}
