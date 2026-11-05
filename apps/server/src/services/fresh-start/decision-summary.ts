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
    // Data refusals (no setup check reached) per instrument over the last 30 minutes, with the short input named:
    // one row per evaluation (every strategy carries the same code), so a stuck instrument is visible by name.
    const recent = new Date(now - 1_800_000);
    const [evaluations, refusals, candidates, adapter, positions, flowOutcomes, dataRefusals, adapterDetail] = await Promise.all([
      sql<any[]>`SELECT instrument, count(*)::int AS n FROM fresh_evaluations WHERE version=${FRESH_PACK_VERSION} AND at >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
      sql<any[]>`SELECT r->>'strategy' AS strategy, r->>'code' AS code, r->>'detail' AS detail, count(*)::int AS n FROM fresh_evaluations e, jsonb_array_elements(coalesce(e.result->'refusals','[]'::jsonb)) r WHERE e.version=${FRESH_PACK_VERSION} AND e.at >= ${since} GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 80`,
      sql<any[]>`SELECT strategy, decision, code, count(*)::int AS n FROM fresh_candidates WHERE version=${FRESH_PACK_VERSION} AND at >= ${since} GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 40`,
      sql<any[]>`SELECT strategy, code, count(*)::int AS n FROM fresh_adapter_decisions WHERE version=${FRESH_PACK_VERSION} AND at >= ${since} GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40`,
      sql<any[]>`SELECT count(*)::int AS n FROM fresh_paper_positions WHERE version=${FRESH_PACK_VERSION} AND opened_at >= ${since}`,
      // Order-flow SHADOW tags on every closed trade of this version: did ALIGNED trades do better than OPPOSED ones?
      sql<any[]>`SELECT strategy, coalesce(state#>>'{candidate,evidence,orderFlow,alignment}','UNTAGGED') AS flow, count(*)::int AS trades, count(*) FILTER (WHERE net_pnl > 0)::int AS wins, round(coalesce(sum(net_pnl),0)::numeric, 0)::float AS net, round(avg(net_pnl / nullif((state->>'originalRiskCurrency')::numeric, 0))::numeric, 2)::float AS avg_r FROM fresh_paper_positions WHERE version=${FRESH_PACK_VERSION} AND status='CLOSED' GROUP BY 1,2 ORDER BY 1,2 LIMIT 60`,
      sql<any[]>`SELECT e.instrument, r->>'code' AS code, r->>'detail' AS detail, count(*)::int AS n FROM fresh_evaluations e, jsonb_array_elements(coalesce(e.result->'refusals','[]'::jsonb)) r WHERE e.version=${FRESH_PACK_VERSION} AND e.at >= ${recent} AND r->>'strategy'='NEW_ORB_RETEST_V1' AND r->>'code' NOT IN ('SETUP_CONDITIONS_NOT_MET','CHOPPY_REGIME','TARGET_TOO_CLOSE') GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 40`,
      // Every setup the engine found today that did not become a paper trade: instrument, levels, and why each option
      // contract was refused (5 Nov: momentum / flag setups died at contract selection and the summary could not say where).
      sql<any[]>`SELECT to_char(at AT TIME ZONE 'Asia/Kolkata','HH24:MI') AS ist, strategy, code, evidence#>>'{candidate,instrument}' AS instrument, evidence#>>'{candidate,direction}' AS direction, evidence#>>'{candidate,referenceEntry}' AS entry, evidence#>>'{candidate,stop}' AS stop, evidence#>>'{candidate,target}' AS target, (SELECT jsonb_object_agg(k, n) FROM (SELECT x->>'code' AS k, count(*) AS n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(evidence->'refusals')='array' THEN evidence->'refusals' ELSE '[]'::jsonb END) x GROUP BY 1) q) AS "contractCodes", evidence->'expiries' AS expiries, evidence->'strikes' AS strikes FROM fresh_adapter_decisions WHERE version=${FRESH_PACK_VERSION} AND at >= ${since} ORDER BY at DESC LIMIT 20`,
    ]);
    logger.info({ event: 'freshDecisionSummary', adapterDetail, since: since.toISOString(), evaluations, refusals, candidates, adapter, positionsOpened: positions[0]?.n ?? 0, orderFlowShadow: flowOutcomes, dataRefusalsLast30Min: dataRefusals }, 'Fresh-start decisions today, grouped by code');
  } catch (err: any) {
    logger.warn({ event: 'freshDecisionSummary', error: err?.message }, 'Fresh-start decision summary unavailable');
  }
}
