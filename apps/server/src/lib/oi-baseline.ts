// ============================================================
// DAILY OI BASELINE
// ============================================================
// Angel One's tick/quote data exposes absolute OI, not a delta.
// We baseline the first OI value seen for a token each trading
// day in Redis and derive changeOi = current - baseline.
// ============================================================

import { redis } from './redis.js';
import { logger } from './logger.js';

const BASELINE_TTL_SECONDS = 60 * 60 * 24 * 2; // survive into the next day's first read

/**
 * Falls back to changeOi = 0 (rather than throwing) if Redis is unreachable —
 * a cache outage shouldn't take down option-chain/futures responses, it
 * should just mean change-OI is temporarily unavailable.
 */
export async function computeChangeOi(token: string, currentOi: number): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `oi_baseline:${token}:${day}`;

  try {
    // Only establish a baseline from a real (non-zero) OI reading. A 0
    // usually means the quote hadn't populated OI yet (e.g. a call that
    // raced provider auth) — with NX, writing that bogus 0 would lock it
    // in for the rest of the day, making every later changeOi equal the
    // full current OI instead of an actual delta.
    if (currentOi > 0) {
      await redis.set(key, currentOi, 'EX', BASELINE_TTL_SECONDS, 'NX');
    }
    // Set only if absent, then read whatever is stored — whether we just set
    // it or a concurrent request beat us to it.
    const stored = await redis.get(key);
    const baseline = stored !== null ? parseInt(stored, 10) : currentOi;

    return currentOi - baseline;
  } catch (err: any) {
    logger.warn({ error: err.message, token }, 'OI baseline unavailable (Redis down?) — changeOi defaulted to 0');
    return 0;
  }
}
