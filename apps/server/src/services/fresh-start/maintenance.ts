// ============================================================
// FRESH-START NIGHTLY MAINTENANCE — evaluation input retention and storage figures (5 Nov: Railway cost review)
// ============================================================
// Every evaluation stores its full input context (five-minute and one-minute bars, volume references) for audit and
// research replay: ~150 KB a row, every 5 minutes per reference, so fresh_evaluations grew ~0.5 GB a week. Once a
// night, outside every exchange session, inputs older than FRESH_EVALUATION_INPUT_RETENTION_DAYS are replaced by a
// small marker. The evaluation RESULT (refusals, gates, candidates) is kept, as are every candidate, adapter decision,
// paper position and event: nothing a report or a trade reads is removed. Research export skips trimmed rows.
// ============================================================

import { sql } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';
import { schemaFileReady } from '../ensure-capture-schema.js';

export const FRESH_EVALUATION_INPUT_RETENTION_DAYS = 10;
/** Rows per UPDATE, and the most batches in one night (a bounded, interruptible job). */
export const FRESH_TRIM_BATCH = 2000;
export const FRESH_TRIM_MAX_BATCHES = 100;
/**
 * Dhan engine v2 (7 Nov): recorded order-flow events (order_flow_events, compressed per 15-minute bar) older than this
 * are deleted nightly. FLOW_EVENT_RETENTION_DAYS overrides it (7-365); the per-bar footprints in order_flow_bars stay.
 */
export function flowEventRetentionDays(raw: string | undefined = process.env.FLOW_EVENT_RETENTION_DAYS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 7 && n <= 365 ? n : 30;
}
export const FLOW_EVENT_DELETE_BATCH = 5000;
const FLOW_EVENTS_MIGRATION = '052_order_flow_events.sql';
/** Run window, IST hours [from, to): after MCX's last close (23:55 in US winter), before any pre-open. */
const RUN_FROM_HOUR = 2;
const RUN_TO_HOUR = 6;
const TICK_MS = 15 * 60_000;
const CLAIM_KEY = (date: string) => `fresh:maintenance:run:${date}`;

/** Pure: the IST date of `now` when it falls in the run window, else null. */
export function freshMaintenanceRunDate(now: number): string | null {
  const ist = new Date(now + 5.5 * 3600_000), h = ist.getUTCHours();
  return h >= RUN_FROM_HOUR && h < RUN_TO_HOUR ? ist.toISOString().slice(0, 10) : null;
}

type Sql = typeof sql;

/** Replaces inputs older than the retention with a marker, in bounded batches. Returns the number of rows trimmed. */
export async function trimFreshEvaluationInputs(db: Sql, now: number): Promise<number> {
  const cutoff = new Date(now - FRESH_EVALUATION_INPUT_RETENTION_DAYS * 86_400_000), at = new Date(now).toISOString();
  let total = 0;
  for (let i = 0; i < FRESH_TRIM_MAX_BATCHES; i++) {
    const rows = await db<{ id: string }[]>`UPDATE fresh_evaluations SET input = jsonb_build_object('trimmedAt', ${at}::text, 'instrument', instrument) WHERE id IN (SELECT id FROM fresh_evaluations WHERE at < ${cutoff} AND NOT (input ? 'trimmedAt') ORDER BY at LIMIT ${FRESH_TRIM_BATCH}) RETURNING id`;
    total += rows.length;
    if (rows.length < FRESH_TRIM_BATCH) break;
  }
  return total;
}

/** Deletes recorded order-flow events older than the retention, in bounded batches. Returns the rows deleted. */
export async function trimFlowEvents(db: Sql, now: number, days: number = flowEventRetentionDays()): Promise<number> {
  const cutoff = new Date(now - days * 86_400_000);
  let total = 0;
  for (let i = 0; i < FRESH_TRIM_MAX_BATCHES; i++) {
    const rows = await db<{ symbol: string }[]>`DELETE FROM order_flow_events WHERE (symbol, exchange, bar_time) IN (SELECT symbol, exchange, bar_time FROM order_flow_events WHERE bar_time < ${cutoff} ORDER BY bar_time LIMIT ${FLOW_EVENT_DELETE_BATCH}) RETURNING symbol`;
    total += rows.length;
    if (rows.length < FLOW_EVENT_DELETE_BATCH) break;
  }
  return total;
}

/** The ten largest tables (with their indexes and TOAST) in MB, largest first; read only. */
export async function largestTables(db: Sql, limit = 10): Promise<Array<{ table: string; mb: number; rows: number | null }>> {
  const rows = await db<any[]>`SELECT n.nspname AS schema, c.relname AS table, pg_total_relation_size(c.oid) AS bytes, c.reltuples AS rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY pg_total_relation_size(c.oid) DESC LIMIT ${limit}`;
  return rows.map((r) => ({ table: r.schema === 'public' ? r.table : `${r.schema}.${r.table}`, mb: Math.round(Number(r.bytes) / 1_048_576), rows: r.rows == null || Number(r.rows) < 0 ? null : Math.round(Number(r.rows)) }));
}

/** Database and table sizes in MB (logged so growth is visible without database access). */
export async function freshStorageFigures(db: Sql): Promise<Record<string, number | null>> {
  const [r] = await db<any[]>`SELECT pg_database_size(current_database()) AS db, pg_total_relation_size('fresh_evaluations') AS evaluations, pg_total_relation_size('fresh_adapter_decisions') AS adapter, pg_total_relation_size('fresh_candidates') AS candidates, pg_total_relation_size(to_regclass('order_flow_events')) AS flow_events, pg_total_relation_size(to_regclass('order_flow_bars')) AS flow_bars`;
  const mb = (x: unknown) => (x == null ? null : Math.round(Number(x) / 1_048_576));
  return { databaseMb: mb(r.db), evaluationsMb: mb(r.evaluations), adapterDecisionsMb: mb(r.adapter), candidatesMb: mb(r.candidates), flowEventsMb: mb(r.flow_events), flowBarsMb: mb(r.flow_bars) };
}

let started = false;
export function startFreshMaintenance(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    const date = freshMaintenanceRunDate(Date.now());
    if (!date || !schemaFileReady('048_fresh_start_adapter.sql')) return;
    // Claimed before the work so a restart in the window never runs it twice; released on failure for a retry.
    if (!(await redis.set(CLAIM_KEY(date), 'running', 'EX', 2 * 86_400, 'NX'))) return;
    try {
      const before = await freshStorageFigures(sql), t0 = Date.now(), trimmed = await trimFreshEvaluationInputs(sql, t0);
      // Dhan engine v2: recorded flow events past their retention (the footprints themselves are kept).
      const flowEventsDeleted = schemaFileReady(FLOW_EVENTS_MIGRATION) ? await trimFlowEvents(sql, t0) : null;
      logger.info({ event: 'freshMaintenance', largestTables: await largestTables(sql).catch(() => null), trimmed, retentionDays: FRESH_EVALUATION_INPUT_RETENTION_DAYS, flowEventsDeleted, flowEventRetentionDays: flowEventRetentionDays(), ms: Date.now() - t0, before, after: await freshStorageFigures(sql) }, 'Fresh-start nightly maintenance: old evaluation inputs trimmed, old order-flow events deleted (results, trades, decisions and footprints kept)');
      await redis.set(CLAIM_KEY(date), 'done', 'EX', 2 * 86_400);
    } catch (err) {
      await redis.del(CLAIM_KEY(date)).catch(() => undefined);
      throw err;
    }
  };
  const safeTick = () => void tick().catch((err: any) => logger.warn({ error: err.message }, 'Fresh-start nightly maintenance failed (retried next tick)'));
  setTimeout(() => {
    safeTick();
    setInterval(safeTick, TICK_MS);
  }, 120_000);
  logger.info({ window: `${RUN_FROM_HOUR}:00-${RUN_TO_HOUR}:00 IST`, retentionDays: FRESH_EVALUATION_INPUT_RETENTION_DAYS }, 'Fresh-start nightly maintenance started');
}
