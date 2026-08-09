// ============================================================
// REDIS CLIENT
// ============================================================

import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 2,
  lazyConnect: false,
  retryStrategy: (attempt: number) => Math.min(attempt * 500, 5000),
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err: Error) => logger.error({ error: err.message }, 'Redis error'));

export async function pingRedis(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
  try {
    const start = Date.now();
    await redis.ping();
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (error: any) {
    return { healthy: false, error: error.message };
  }
}
