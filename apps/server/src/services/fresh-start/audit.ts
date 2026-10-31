import {createHash} from 'node:crypto';
import {FRESH_PACK_VERSION,type FreshContext,type FreshCandidate,type FreshEvaluation} from '@fno/analytics';
import {sql} from '../../lib/db.js';
export async function auditFreshEvaluation(context:FreshContext,result:FreshEvaluation){
  const id=createHash('sha256').update(`${FRESH_PACK_VERSION}:${context.instrument}:${context.session}:${context.sourceEpoch}:${context.bars5.at(-1)?.time}`).digest('hex');
  await sql`INSERT INTO fresh_evaluations(id,version,at,instrument,session,source_epoch,input,result) VALUES(${id},${FRESH_PACK_VERSION},${new Date(context.now)},${context.instrument},${context.session},${context.sourceEpoch},${sql.json(context as any)},${sql.json(result as any)}) ON CONFLICT DO NOTHING`;
}
export async function auditFreshAdapter(c:FreshCandidate,code:string,evidence:Record<string,unknown>={}){
  await sql`INSERT INTO fresh_adapter_decisions(candidate_id,version,at,strategy,code,evidence) VALUES(${c.id},${c.version},${new Date()},${c.strategy},${code},${sql.json({candidate:c,...evidence} as any)}) ON CONFLICT DO NOTHING`;
}

export async function persistFreshCalendarSnapshot(s:import('./event-source.js').FreshCalendarSnapshot){
  await sql`INSERT INTO fresh_calendar_snapshots(id,source,observed_at,valid_until,evidence) VALUES(${s.id},${s.source},${new Date(s.fetchedAt)},${new Date(s.expiresAt)},${sql.json(s as any)}) ON CONFLICT DO NOTHING`;
}
