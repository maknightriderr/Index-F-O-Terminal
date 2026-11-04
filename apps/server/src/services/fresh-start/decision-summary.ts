// Why did (or didn't) the fresh-start engine trade today? A periodic, bounded summary of today's recorded decisions,
// grouped by code, written to the platform log so it can be read without database access (2 Nov: no paper trades).
import { FRESH_PACK_VERSION } from '@fno/analytics';
import { sql } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { schemaFileReady } from '../ensure-capture-schema.js';

/** IST session start (00:00 IST) for the given instant. */
export function istDayStart(now: number): Date {
  const d = new Date(now + 19_800_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 19_800_000);
}

export async function logFreshDecisionSummary(now = Date.now()): Promise<void> {
  if (!schemaFileReady('047_fresh_start_paper.sql') || !schemaFileReady('048_fresh_start_adapter.sql')) return;
  const since = istDayStart(now);
  try {
    const [evaluations, refusals, candidates, adapter, positions] = await Promise.all([
      sql<any[]>`SELECT instrument, count(*)::int AS n FROM fresh_evaluations WHERE version=${FRESH_PACK_VERSION} AND at >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
      sql<any[]>`SELECT r->>'strategy' AS strategy, r->>'code' AS code, r->>'detail' AS detail, count(*)::int AS n FROM fresh_evaluations e, jsonb_array_elements(coalesce(e.result->'refusals','[]'::jsonb)) r WHERE e.version=${FRESH_PACK_VERSION} AND e.at >= ${since} GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 80`,
      sql<any[]>`SELECT strategy, decision, code, count(*)::int AS n FROM fresh_candidates WHERE version=${FRESH_PACK_VERSION} AND at >= ${since} GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 40`,
      sql<any[]>`SELECT strategy, code, count(*)::int AS n FROM fresh_adapter_decisions WHERE version=${FRESH_PACK_VERSION} AND at >= ${since} GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40`,
      sql<any[]>`SELECT count(*)::int AS n FROM fresh_paper_positions WHERE version=${FRESH_PACK_VERSION} AND opened_at >= ${since}`,
    ]);
    logger.info({ event: 'freshDecisionSummary', since: since.toISOString(), evaluations, refusals, candidates, adapter, positionsOpened: positions[0]?.n ?? 0 }, 'Fresh-start decisions today, grouped by code');
  } catch (err: any) {
    logger.warn({ event: 'freshDecisionSummary', error: err?.message }, 'Fresh-start decision summary unavailable');
  }
}
