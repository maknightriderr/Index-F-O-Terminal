// ============================================================
// POSTGRES / TIMESCALEDB CLIENT
// ============================================================
// The schema is owned by database/init/*.sql (mounted into the
// Postgres container on first boot). This module just provides
// a query client against that schema — no ORM/migrations here.
// ============================================================

import postgres from 'postgres';
import { config } from './config.js';
import { logger } from './logger.js';

export const sql = postgres(config.database.url, {
  max: 10,
  idle_timeout: 30,
  onnotice: () => {}, // Suppress NOTICE spam (e.g. "relation already exists")
});

export async function pingDb(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
  try {
    const start = Date.now();
    await sql`SELECT 1`;
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (error: any) {
    logger.error({ error: error.message }, 'Database health check failed');
    return { healthy: false, error: error.message };
  }
}
