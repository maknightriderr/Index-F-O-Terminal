import {freshProductionState} from './adapter-state.js';
import { freshPerformanceFromTotals, FRESH_PACK_VERSION } from '@fno/analytics';
import { sql } from '../../lib/db.js';
import { FRESH_CONFIG, freshEntriesEnabled } from '../../config/fresh-start.js';
import { LEGACY_NEW_ENTRIES_ENABLED } from '../../config/legacy-entry-policy.js';
import { schemaFileReady } from '../ensure-capture-schema.js';
export async function freshStartStatus() {
    const schemaReady = schemaFileReady('047_fresh_start_paper.sql');
    const positions = schemaReady ? await sql<any[]> `SELECT strategy,version,session,status,state,net_pnl FROM fresh_paper_positions ORDER BY opened_at DESC LIMIT 1001` : [];
    const candidates = schemaReady ? await sql<any[]> `SELECT id,at,strategy,decision,code,evidence FROM fresh_candidates WHERE version=${FRESH_PACK_VERSION} ORDER BY at DESC LIMIT 100` : [];
    const aggregate = schemaReady ? await sql<any[]> `
    SELECT strategy,count(*)::int AS filled,
      count(*) FILTER(WHERE status='CLOSED')::int AS closed,
      count(*) FILTER(WHERE status='OPEN')::int AS open,
      count(*) FILTER(WHERE status='EXIT_PENDING')::int AS pending,
      0 AS unmeasured,
      count(*) FILTER(WHERE status='CLOSED' AND net_pnl>0)::int AS wins,
      count(*) FILTER(WHERE status='CLOSED' AND net_pnl<0)::int AS losses,
      count(*) FILTER(WHERE status='CLOSED' AND net_pnl=0)::int AS flat,
      coalesce(sum(greatest(net_pnl,0)) FILTER(WHERE status='CLOSED'),0) AS "grossProfit",
      coalesce(-sum(least(net_pnl,0)) FILTER(WHERE status='CLOSED'),0) AS "grossLoss",
      sum(net_pnl) FILTER(WHERE status='CLOSED') AS "netPnl",
      avg(net_pnl/reserved_risk) FILTER(WHERE status='CLOSED') AS "expectancyR",
      count(DISTINCT session) FILTER(WHERE status='CLOSED')::int AS "independentSessions"
    FROM fresh_paper_positions WHERE version=${FRESH_PACK_VERSION} GROUP BY strategy
  ` : [];
    const reviews = schemaReady ? await sql<any[]> `SELECT position_id,status,response,completed_at FROM fresh_paper_reviews WHERE version=${FRESH_PACK_VERSION} ORDER BY completed_at DESC NULLS LAST LIMIT 50` : [];
    const resolved=new Set(['CAPITAL_CONFIGURATION','EXPLICIT_PAPER_ACTIVATION_APPROVAL']);
    const adapter=freshProductionState(),adapterSchemaReady=schemaFileReady('048_fresh_start_adapter.sql'),calendarSchemaReady=schemaFileReady('049_fresh_start_calendars.sql');
    const adapterDecisions=adapterSchemaReady?await sql<any[]>`SELECT candidate_id,at,strategy,code FROM fresh_adapter_decisions WHERE version=${FRESH_PACK_VERSION} ORDER BY at DESC LIMIT 50`:[];
    const evaluations=adapterSchemaReady?await sql<any[]>`SELECT id,at,instrument,session,result->'refusals' AS refusals FROM fresh_evaluations WHERE version=${FRESH_PACK_VERSION} ORDER BY at DESC LIMIT 20`:[];
    return { activationRequested:FRESH_CONFIG.activationRequested,activationApproved:FRESH_CONFIG.activationApproved,feedQualification:adapter,eventSources:adapter.eventSources,calendarSchemaReady,marketReadiness:adapter.marketReadiness,discovery:adapter.discovery,requiredEventConfiguration:adapter.requiredEventConfiguration,adapterDecisions,evaluations,engineConfigured:FRESH_CONFIG.enabled,brokeragePerOrder:20,adapterSchemaReady, reviews, version: FRESH_CONFIG.version, implementationApproved: true, enabled: freshEntriesEnabled(), legacyNewEntries: LEGACY_NEW_ENTRIES_ENABLED,
        legacyExitsPreserved: true, liveOrdersAllowed: false, schemaReady, capital: FRESH_CONFIG.capital,
        blockers: [...(!schemaReady||!adapterSchemaReady||!calendarSchemaReady ? ['FRESH_SCHEMA_UNAVAILABLE'] : []),...adapter.entryBlockers,...(!adapter.recovered?['QUALIFIED_SHARED_FEED_ADAPTER']:[])],
        capabilities: FRESH_CONFIG.requirements.map(id => ({ id, status: resolved.has(id)?'APPROVED':['CURRENT_EXCHANGE_AND_BROKER_COSTS','PRICING_MODEL_AND_SCENARIOS'].includes(id)?'IMPLEMENTED_NOT_FULLY_QUALIFIED':'NEEDS_VERIFICATION' })),
        strategies: FRESH_CONFIG.strategies.map(s=>({...s,enabled:s.enabled&&freshEntriesEnabled()})), performance: freshPerformanceFromTotals(aggregate),
        positions: positions.slice(0, 1000).map(p => ({ strategy: p.strategy, version: p.version, session: p.session, status: p.status, state: p.state })),
        positionsTruncated: positions.length > 1000, candidates, evidence: 'OBSERVED_QUOTE_PAPER_ONLY', performanceValidated: false };
}
