import {createHash} from 'node:crypto';
import {FRESH_PACK_VERSION,type FreshContext,type FreshCandidate,type FreshEvaluation} from '@fno/analytics';
import {sql} from '../../lib/db.js';
import {logger} from '../../lib/logger.js';
export async function auditFreshEvaluation(context:FreshContext,result:FreshEvaluation){
  const id=createHash('sha256').update(`${FRESH_PACK_VERSION}:${context.instrument}:${context.session}:${context.sourceEpoch}:${context.bars5.at(-1)?.time}`).digest('hex');
  await sql`INSERT INTO fresh_evaluations(id,version,at,instrument,session,source_epoch,input,result) VALUES(${id},${FRESH_PACK_VERSION},${new Date(context.now)},${context.instrument},${context.session},${context.sourceEpoch},${sql.json(context as any)},${sql.json(result as any)}) ON CONFLICT DO NOTHING`;
}
export async function auditFreshAdapter(c:FreshCandidate,code:string,evidence:Record<string,unknown>={}){
  // One line per setup that did not become a paper trade, readable without database access.
  const refusals=Array.isArray(evidence.refusals)?evidence.refusals as Array<{code?:string}>:[],contractCodes:Record<string,number>={};for(const r of refusals){const k=r?.code??'UNKNOWN';contractCodes[k]=(contractCodes[k]??0)+1;}
  logger.info({event:'freshAdapterRefusal',instrument:c.instrument,strategy:c.strategy,direction:c.direction,entry:c.referenceEntry,stop:c.stop,target:c.target,code,contractCodes,strikes:evidence.strikes??null,expiries:evidence.expiries??null},'Fresh-start setup found but not traded: option contract selection refused');
  await sql`INSERT INTO fresh_adapter_decisions(candidate_id,version,at,strategy,code,evidence) VALUES(${c.id},${c.version},${new Date()},${c.strategy},${code},${sql.json({candidate:c,...evidence} as any)}) ON CONFLICT DO NOTHING`;
}

export async function persistFreshCalendarSnapshot(s:import('./event-source.js').FreshCalendarSnapshot){
  await sql`INSERT INTO fresh_calendar_snapshots(id,source,observed_at,valid_until,evidence) VALUES(${s.id},${s.source},${new Date(s.fetchedAt)},${new Date(s.expiresAt)},${sql.json(s as any)}) ON CONFLICT DO NOTHING`;
}
