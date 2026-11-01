import {sql} from '../../lib/db.js';
import type {FreshDb} from './store.js';
import {FRESH_RESEARCH_PROTOCOL,freshProtocolDigest} from '../../config/fresh-research.js';
export const RESEARCH_SOURCES=[
 {table:'ohlcv',evidence:'SIGNAL_BARS',limit:'OHLC bars do not establish individual-option bid/ask execution.'},
 {table:'bar_archive',evidence:'SIGNAL_BARS',limit:'Archived bars/rolling futures are not a fixed-contract option execution dataset.'},
 {table:'market_ticks',evidence:'PRICE_OBSERVATIONS',limit:'Price rows alone do not verify depth, event/receipt time, source epoch or quantity units.'},
 {table:'paper_execution_observations',evidence:'LEGACY_EXECUTION_DIAGNOSTICS',limit:'Legacy observations cannot be pooled with the fresh strategy cohort.'},
 {table:'fresh_evaluations',evidence:'RECORDED_SIGNAL_CONTEXT',limit:'Decision contexts support causal signal replay, not a continuous option quote backtest.'},
 {table:'fresh_paper_events',evidence:'FORWARD_PAPER_LEDGER',limit:'Entry/latest observations do not prove complete historical quote coverage.'},
 {table:'fresh_paper_positions',evidence:'FORWARD_PAPER_RESULTS',limit:'Closed positions alone are not a historical execution backtest or point-in-time universe.'},
] as const;
export async function readFreshResearchInventory(db:FreshDb=sql as unknown as FreshDb){
 return db.begin(async tx=>{
  await tx.unsafe('SET TRANSACTION READ ONLY');
  await tx.unsafe("SET LOCAL statement_timeout='1500ms'");
  const catalog=await tx.unsafe(`SELECT c.relname,CASE WHEN c.reltuples<0 THEN NULL ELSE c.reltuples::double precision END AS estimated_rows
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind IN ('r','p')`,[RESEARCH_SOURCES.map(s=>s.table)]);
  const rows=[];
  for(const source of RESEARCH_SOURCES){
   const found=catalog.find(r=>r.relname===source.table);
   // Only literal allowlisted table names; EXISTS reads no prices, outcomes or holdout rows.
   const present=found?(await tx.unsafe(`SELECT EXISTS(SELECT 1 FROM public.${source.table}) AS present`))[0]?.present===true:false;
   rows.push({...source,available:!!found,hasRows:present,estimatedRows:found?.estimated_rows??null});
  }
  const registry=await tx.unsafe("SELECT to_regclass('public.fresh_research_protocols') IS NOT NULL AS available");
  const registered=registry[0]?.available?(await tx.unsafe('SELECT digest,registered_at FROM fresh_research_protocols WHERE id=$1',[FRESH_RESEARCH_PROTOCOL.id]))[0]:null;
  return {observedAt:Date.now(),sources:rows,protocol:{...FRESH_RESEARCH_PROTOCOL,digest:freshProtocolDigest(),registered:registered?.digest===freshProtocolDigest(),registeredAt:registered?.registered_at?new Date(registered.registered_at).toISOString():null},
   blockers:['HISTORICAL_DATASET_NOT_QUALIFIED','HOLDOUT_BLINDNESS_NOT_ENFORCED','OBSERVED_SESSION_VALIDATION_PENDING','MCX_DEPTH_UNITS_NOT_QUALIFIED'],
   note:'Schema/presence inventory only. Row estimates may be stale or exclude hypertable chunks; no period, universe, data completeness, fresh-version membership or execution qualification is inferred. No outcomes are read.'};
 });
}
type Inventory=Awaited<ReturnType<typeof readFreshResearchInventory>>;
let cached:Inventory|null=null,inFlight:Promise<Inventory|null>|null=null,nextAttempt=0;
export async function freshResearchReadiness(){
 if(inFlight)return inFlight;
 if(Date.now()<nextAttempt)return cached;
 nextAttempt=Date.now()+900000;
 inFlight=readFreshResearchInventory().then(r=>{cached=r;return r;}).catch(()=>{cached=null;return null;}).finally(()=>{inFlight=null;});
 return inFlight;
}
export async function registerFreshResearchProtocol(db:FreshDb=sql as unknown as FreshDb,fixtureTime?:number){
 if(fixtureTime!==undefined&&!Number.isFinite(fixtureTime))throw Error('INVALID_PROTOCOL_CLOCK');
 await db.unsafe('INSERT INTO fresh_research_protocols(id,digest,body,registered_at) SELECT $1,$2,$3::jsonb,coalesce($5::timestamptz,clock_timestamp()) WHERE coalesce($5::timestamptz,clock_timestamp()) < $4::timestamptz ON CONFLICT DO NOTHING',[FRESH_RESEARCH_PROTOCOL.id,freshProtocolDigest(),JSON.stringify(FRESH_RESEARCH_PROTOCOL),FRESH_RESEARCH_PROTOCOL.captureStart,fixtureTime===undefined?null:new Date(fixtureTime).toISOString()]);
 const [row]=await db.unsafe('SELECT digest FROM fresh_research_protocols WHERE id=$1',[FRESH_RESEARCH_PROTOCOL.id]);
 if(!row)throw Error('PROTOCOL_NOT_REGISTERED_IN_ADVANCE');
 if(row.digest!==freshProtocolDigest())throw Error('RESEARCH_PROTOCOL_DIGEST_MISMATCH');
 await inFlight;cached=null;nextAttempt=0;
}
