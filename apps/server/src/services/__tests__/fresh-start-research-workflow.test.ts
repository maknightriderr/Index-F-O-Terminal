import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {evaluateFreshStrategies} from '@fno/analytics';
import {replayFreshResearch} from '../fresh-start/research-replay.js';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import type {FreshDb} from '../fresh-start/store.js';
import {readFreshResearchInventory,registerFreshResearchProtocol} from '../fresh-start/research-inventory.js';
import {parseFreshResearchBundle,runFreshResearch} from '../fresh-start/research-runner.js';
import {exportFreshResearchContexts} from '../fresh-start/research-export.js';
import {FRESH_RESEARCH_PROTOCOL as protocol,freshProtocolDigest} from '../../config/fresh-research.js';
let pg:PGlite;
function client(db:any):FreshDb{return {unsafe:async(q,p=[])=>((await db.query(q,p)).rows),begin:fn=>db.transaction((tx:any)=>fn(client(tx)))};}
const now=Date.parse('2027-07-04T12:00:00+05:30');
function bundle(policy='STRICT_EVENT_COVERAGE_V1'){
 const cohort={market:'NSE_INDEX_OPTIONS',strategy:'NEW_ORB_RETEST_V1',direction:'BULLISH',timeframe:'5m',eventPolicyId:policy,eventEvidenceClass:'EVENT_COVERAGE_VERIFIED'};
 const entryAt=Date.parse('2027-01-05T10:00:00+05:30');
 return {schema:'FRESH_RESEARCH_BUNDLE_V1',protocolDigest:freshProtocolDigest(),cohort,evidence:'OBSERVED_QUOTE_BACKTEST',parametersFrozenAt:Date.parse('2026-11-01T10:00:00+05:30'),outcomesPreviouslyInspected:false,
  capabilities:{fixedContractQuotes:true,pointInTimeUniverse:true,costsVerified:true,calendarsVerified:true},trades:[{...cohort,id:'one',version:protocol.version,session:'2027-01-05',entryAt,exitAt:entryAt+600000,netPnl:100,initialRisk:100}],forwardTrades:[] as any[],equityPath:[{at:entryAt,equity:500000},{at:entryAt+600000,equity:500100}],unresolved:0};
}
beforeAll(async()=>{pg=new PGlite();for(const name of ['047_fresh_start_paper.sql','048_fresh_start_adapter.sql','050_fresh_research.sql','050_fresh_research.sql'])await pg.exec(readFileSync(new URL(`../../../../../database/init/${name}`,import.meta.url),'utf8'));await pg.exec('CREATE TABLE market_ticks(time timestamptz,bid double precision,ask double precision); INSERT INTO market_ticks VALUES(now(),100,101)');},30000);
afterAll(async()=>pg.close());
describe('data inventory and durable research inspection',()=>{
 it('refuses first registration after collection starts rather than backdating a protocol',async()=>{
  const isolated=new PGlite();try{
   await isolated.exec(readFileSync(new URL('../../../../../database/init/050_fresh_research.sql',import.meta.url),'utf8'));
   await expect(registerFreshResearchProtocol(client(isolated),Date.parse('2026-11-03T00:00:00+05:30'))).rejects.toThrow('PROTOCOL_NOT_REGISTERED_IN_ADVANCE');
   expect((await isolated.query<any>('SELECT count(*)::int AS n FROM fresh_research_protocols')).rows[0].n).toBe(0);
  }finally{await isolated.close();}
 });
 it('exports only a bounded current-version signal window and never touches paper outcome tables',async()=>{
  const db=client(pg),at=Date.parse('2026-11-02T10:00:00+05:30');
  const context={now:at,session:'2026-11-02',sessionOpen:at-2700000,sessionClose:at+19800000,instrument:'NSE_FO:1',sourceEpoch:'epoch',bars5:[],bars15:[],bars1:[],rvolReferences:{},openingVolumeReferences:[],levels:[],previousHigh:0,previousLow:0,referenceVerified:false,eventClear:false,calendarVerified:true};
  await db.unsafe('INSERT INTO fresh_evaluations(id,version,at,instrument,session,source_epoch,input,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)',['replay',protocol.version,new Date(at).toISOString(),'NSE_FO:1','2026-11-02','epoch',JSON.stringify(context),JSON.stringify(evaluateFreshStrategies(context))]);
  const rows=await exportFreshResearchContexts(db,at-1,at+1,at+2);expect(rows).toHaveLength(1);expect(replayFreshResearch(rows).matched).toBe(1);expect(Object.keys(rows[0]).sort()).toEqual(['id','input','result','version']);
  await expect(exportFreshResearchContexts(db,at+3,at+4,at+5)).rejects.toThrow('NO_RECORDED_CONTEXTS_IN_WINDOW');
  await expect(exportFreshResearchContexts(db,at,at+3,at+2)).rejects.toThrow('INVALID_EXPORT_WINDOW');
 });
 it('registers a write-once protocol before collection and inventories schema/presence without reading outcomes',async()=>{
  const db=client(pg);await registerFreshResearchProtocol(db,Date.parse('2026-11-01T10:00:00+05:30'));await registerFreshResearchProtocol(db,Date.parse('2026-11-01T10:00:00+05:30'));
  const queries:string[]=[];const tracked:FreshDb={...db,begin:fn=>db.begin(tx=>fn({...tx,unsafe:async(q,p)=>{queries.push(q);return tx.unsafe(q,p);}}))};
  const inventory=await readFreshResearchInventory(tracked);expect(inventory.protocol.registered).toBe(true);expect(inventory.sources.find(s=>s.table==='market_ticks')).toMatchObject({hasRows:true,evidence:'PRICE_OBSERVATIONS'});expect(inventory.sources.find(s=>s.table==='bar_archive')).toMatchObject({available:false,hasRows:false,estimatedRows:null});expect(inventory.sources.find(s=>s.table==='fresh_paper_positions')).toMatchObject({available:true,hasRows:false});
  expect(queries[0]).toBe('SET TRANSACTION READ ONLY');expect(queries.some(q=>/SELECT \*|net_pnl|COUNT\(\*\)/i.test(q))).toBe(false);
  await expect(db.unsafe('UPDATE fresh_research_protocols SET digest=$1 WHERE id=$2',['changed',protocol.id])).rejects.toThrow('cannot be updated');
  await expect(db.unsafe('DELETE FROM fresh_research_protocols WHERE id=$1',[protocol.id])).rejects.toThrow('cannot be updated');
 });
 it('rejects immature/empty/future/mixed/duplicate evidence before claiming inspection',()=>{
  expect(()=>parseFreshResearchBundle(bundle(),Date.parse('2026-11-01'))).toThrow('PROSPECTIVE_PERIOD_NOT_COMPLETE');
  const empty=bundle();empty.trades=[];expect(()=>parseFreshResearchBundle(empty,now)).toThrow('HOLDOUT_SAMPLE_EMPTY');
  const mixed=bundle();mixed.trades[0].market='NSE_STOCK_OPTIONS';expect(()=>parseFreshResearchBundle(mixed,now)).toThrow('MIXED_RESEARCH_COHORT');
  const dup=bundle();dup.forwardTrades=[dup.trades[0]];expect(()=>parseFreshResearchBundle(dup,now)).toThrow('DUPLICATE_RESEARCH_TRADE');
  const late=bundle();late.parametersFrozenAt=Date.parse(protocol.captureStart);expect(()=>parseFreshResearchBundle(late,now)).toThrow('PARAMETERS_NOT_FROZEN_IN_ADVANCE');
  const badDay=bundle();badDay.trades[0].session='2027-01-06';expect(()=>parseFreshResearchBundle(badDay,now)).toThrow('INVALID_RESEARCH_TIME');
 });
 it('claims the holdout once, persists the report, returns exact stored replays and refuses a revised dataset',async()=>{
  const db=client(pg),input=bundle(),before=JSON.stringify(input);
  const [a,b]=await Promise.allSettled([runFreshResearch(db,input,now),runFreshResearch(db,input,now)]);
  expect([a,b].some(r=>r.status==='fulfilled')).toBe(true);
  const saved=await runFreshResearch(db,input,now);expect(saved.replayedStoredReport).toBe(true);expect(saved.inspectionRecorded).toBe(true);expect(saved.periods.holdout).toMatchObject({completed:1,wins:1,losses:0,netPnl:100,expectancyR:1,sessions:1});expect(saved.periods.development.netPnl).toBeNull();expect(saved.gate.promoted).toBe(false);expect(saved.gate.eligibleForHumanReview).toBe(false);expect(saved.gate.blockers).toContain('HOLDOUT_BLINDNESS_NOT_ENFORCED');expect(JSON.stringify(input)).toBe(before);
  const changed=bundle();changed.trades[0].netPnl=99999;await expect(runFreshResearch(db,changed,now)).rejects.toThrow('HOLDOUT_DATASET_ALREADY_INSPECTED');
  expect((await db.unsafe('SELECT count(*)::int AS n FROM fresh_research_runs'))[0].n).toBe(1);
  await expect(db.unsafe("UPDATE fresh_research_runs SET dataset_digest='changed' WHERE protocol_id=$1",[protocol.id])).rejects.toThrow('immutable');
  await expect(db.unsafe('DELETE FROM fresh_research_runs WHERE protocol_id=$1',[protocol.id])).rejects.toThrow('cannot be deleted');
 });
 it('retains a failed inspection receipt instead of silently treating the sample as untouched',async()=>{
  const input=bundle('FAILURE_TEST_POLICY'),db=client(pg);
  const broken:FreshDb={...db,unsafe:async(q,p)=>{if(q.includes("status='COMPLETE'"))throw Error('storage failure');return db.unsafe(q,p);}};
  await expect(runFreshResearch(broken,input,now)).rejects.toThrow('storage failure');
  await expect(runFreshResearch(db,input,now)).rejects.toThrow('HOLDOUT_INSPECTION_INCOMPLETE');
 });
});
