// ============================================================
// PENDING OUTCOMES — a trade's close is never silently lost (2026-10-09)
// ============================================================
// When the database refuses a trade's outcome write (seen 2026-10-08: the
// volume filled and every write failed for ~40 minutes), the close used to be
// logged and dropped while the Redis slot moved on. The row then stayed "open"
// and state recovery revived it at the next restart, to be closed again hours
// later at a meaningless price. Now the close is queued in Redis and applied
// as soon as the database accepts writes — by the price-monitor sweep and,
// first of all, before state recovery on boot. Applying is idempotent (only
// an OPEN row is closed).
// ============================================================

import { sql } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

export const PENDING_OUTCOMES_KEY = 'pending_trade_outcomes';

export interface PendingOutcome {
  signalId: string;
  patch: Record<string, unknown>;
  returnPercent: number | null;
  queuedAt?: number;
}

export async function queuePendingOutcome(p: PendingOutcome): Promise<void> {
  await redis.rpush(PENDING_OUTCOMES_KEY, JSON.stringify({ ...p, queuedAt: p.queuedAt ?? Date.now() }));
}

/** Apply every queued close the database now accepts; the rest stay queued. Returns how many were applied. */
export async function drainPendingOutcomes(): Promise<{ applied: number; remaining: number }> {
  const raw = await redis.lrange(PENDING_OUTCOMES_KEY, 0, -1);
  let applied = 0;
  for (const item of raw) {
    let p: PendingOutcome;
    try {
      p = JSON.parse(item);
    } catch {
      await redis.lrem(PENDING_OUTCOMES_KEY, 1, item);
      continue;
    }
    try {
      await sql`
        UPDATE signals SET inputs = inputs || ${sql.json({ ...p.patch, outcomeQueuedAt: p.queuedAt ?? null } as any)}, fwd_1d_return = ${p.returnPercent}
        WHERE id = ${p.signalId} AND (inputs->>'outcome') IS NULL
      `;
      await redis.lrem(PENDING_OUTCOMES_KEY, 1, item);
      applied++;
    } catch (err: any) {
      logger.warn({ error: err.message, signalId: p.signalId }, 'Pending outcome: database still refusing — kept queued');
      break;
    }
  }
  if (applied) logger.info({ applied }, 'Pending outcomes applied');
  return { applied, remaining: raw.length - applied };
}
