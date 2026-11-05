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

/** Database and table sizes in MB (logged so growth is visible without database access). */
export async function freshStorageFigures(db: Sql): Promise<Record<string, number>> {
  const [r] = await db<any[]>`SELECT pg_database_size(current_database()) AS db, pg_total_relation_size('fresh_evaluations') AS evaluations, pg_total_relation_size('fresh_adapter_decisions') AS adapter, pg_total_relation_size('fresh_candidates') AS candidates`;
  const mb = (x: unknown) => Math.round(Number(x) / 1_048_576);
  return { databaseMb: mb(r.db), evaluationsMb: mb(r.evaluations), adapterDecisionsMb: mb(r.adapter), candidatesMb: mb(r.candidates) };
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
      logger.info({ event: 'freshMaintenance', trimmed, retentionDays: FRESH_EVALUATION_INPUT_RETENTION_DAYS, ms: Date.now() - t0, before, after: await freshStorageFigures(sql) }, 'Fresh-start nightly maintenance: old evaluation inputs trimmed (results, trades and decisions kept)');
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
