// ============================================================
// SHORT-TTL REDIS CACHE
// ============================================================
// Wraps an expensive compute (an Angel One round-trip, usually) with
// a short-lived Redis cache. Exists because several endpoints
// independently rebuild the same option chain / futures / historical
// data within seconds of each other (e.g. the option-chain poll and
// the market-bias poll both need the same NIFTY chain) — without
// this, every one of those is a fresh broker round-trip, which is
// both slow and burns into Angel One's per-endpoint rate limits
// (historical data and Greeks are limited far more strictly than
// quotes, and get a plain 403 once tripped).
// ============================================================

import { redis } from './redis.js';
import { logger } from './logger.js';

/**
 * Falls back to calling `compute` uncached if Redis is unreachable —
 * a cache outage should degrade performance, not take down the endpoint.
 */
export async function cached<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err: any) {
    logger.warn({ error: err.message, key }, 'Cache read failed, computing fresh');
  }

  const value = await compute();

  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err: any) {
    logger.warn({ error: err.message, key }, 'Cache write failed');
  }

  return value;
}
