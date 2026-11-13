import {createHash} from 'node:crypto';
import {z} from 'zod';
import {freshValidationGate,partitionFreshResearch,type FreshResearchTrade,FRESH_ALL_STRATEGIES,FRESH_PACK_VERSION} from '@fno/analytics';
import {FRESH_RESEARCH_PROTOCOL as protocol,freshProtocolDigest} from '../../config/fresh-research.js';
import {FRESH_MARKETS} from './markets.js';
import type {FreshDb} from './store.js';
const finite=z.number().finite(),positive=finite.positive();
const eventClass=z.enum(['EVENT_DATA_UNVERIFIED','EVENT_COVERAGE_VERIFIED','EVENT_POLICY_UNRECORDED']);
const cohortSchema=z.object({market:z.enum(FRESH_MARKETS),strategy:z.enum(FRESH_ALL_STRATEGIES),direction:z.enum(['BULLISH','BEARISH']),timeframe:z.literal('5m'),eventPolicyId:z.string().min(1).max(128),eventEvidenceClass:eventClass}).strict();
const tradeSchema=cohortSchema.extend({id:z.string().min(1).max(200),version:z.literal(FRESH_PACK_VERSION),session:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),entryAt:positive,exitAt:positive,netPnl:finite,initialRisk:positive}).strict();
const bundleSchema=z.object({schema:z.literal('FRESH_RESEARCH_BUNDLE_V1'),protocolDigest:z.string().length(64),cohort:cohortSchema,
 evidence:z.enum(['SIGNAL_ONLY','MODELED_FILL','OBSERVED_QUOTE_BACKTEST','FORWARD_PAPER_LEDGER']),
 parametersFrozenAt:positive,outcomesPreviouslyInspected:z.boolean(),
 capabilities:z.object({fixedContractQuotes:z.boolean(),pointInTimeUniverse:z.boolean(),costsVerified:z.boolean(),calendarsVerified:z.boolean()}).strict(),
 trades:z.array(tradeSchema).max(20000),forwardTrades:z.array(tradeSchema).max(20000),
 equityPath:z.array(z.object({at:positive,equity:positive}).strict()).max(50000),unresolved:z.number().int().nonnegative(),
}).strict();
export function parseFreshResearchBundle(raw:unknown,now:number){
 const b=bundleSchema.parse(raw),start=Date.parse(protocol.captureStart),holdoutEnd=Date.parse(protocol.holdoutEnd);
 if(b.protocolDigest!==freshProtocolDigest())throw Error('PROTOCOL_DIGEST_MISMATCH');
 if(!Number.isFinite(now)||now<=holdoutEnd)throw Error('PROSPECTIVE_PERIOD_NOT_COMPLETE');
 if(b.parametersFrozenAt>=start)throw Error('PARAMETERS_NOT_FROZEN_IN_ADVANCE');
 const cohort=JSON.stringify(b.cohort),ids=new Set<string>();
 for(const t of [...b.trades,...b.forwardTrades]){
  if(JSON.stringify(cohortSchema.strip().parse(t))!==cohort)throw Error('MIXED_RESEARCH_COHORT');
  if(ids.has(t.id))throw Error('DUPLICATE_RESEARCH_TRADE');ids.add(t.id);
  if(t.entryAt<start||t.entryAt>=t.exitAt||t.exitAt>now||new Date(t.entryAt).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})!==t.session)throw Error('INVALID_RESEARCH_TIME');
 }
 if(b.forwardTrades.some(t=>t.entryAt>Date.parse(protocol.validationEnd)&&t.entryAt<=holdoutEnd))throw Error('FORWARD_SAMPLE_OVERLAPS_HOLDOUT');
 if(!b.trades.some(t=>t.entryAt>Date.parse(protocol.validationEnd)&&t.exitAt<=holdoutEnd))throw Error('HOLDOUT_SAMPLE_EMPTY');
 if(b.equityPath.some(p=>p.at<start||p.at>now))throw Error('EQUITY_OUTSIDE_PROTOCOL');
 return b;
}
/** Off-session batch only. Claim inspection durably before returning/processing any holdout results. */
export async function runFreshResearch(db:FreshDb,raw:unknown,now=Date.now()){
 const b=parseFreshResearchBundle(raw,now),cohort=JSON.stringify(b.cohort),digest=createHash('sha256').update(JSON.stringify(b)).digest('hex');
 const [registered]=await db.unsafe('SELECT digest,registered_at FROM fresh_research_protocols WHERE id=$1',[protocol.id]);
 if(registered?.digest!==freshProtocolDigest()||new Date(registered.registered_at).getTime()>=Date.parse(protocol.captureStart))throw Error('PROTOCOL_NOT_REGISTERED_IN_ADVANCE');
 const claimed=await db.unsafe("INSERT INTO fresh_research_runs(protocol_id,cohort,dataset_digest,status) VALUES($1,$2,$3,'RUNNING') ON CONFLICT DO NOTHING RETURNING protocol_id",[protocol.id,cohort,digest]);
 if(!claimed.length){
  const [old]=await db.unsafe('SELECT dataset_digest,status,result FROM fresh_research_runs WHERE protocol_id=$1 AND cohort=$2',[protocol.id,cohort]);
  if(old?.dataset_digest!==digest)throw Error('HOLDOUT_DATASET_ALREADY_INSPECTED');
  if(old.status!=='COMPLETE')throw Error('HOLDOUT_INSPECTION_INCOMPLETE');
  return {...old.result,replayedStoredReport:true};
 }
 try{
  const manifest={id:digest,frozenAt:new Date(registered.registered_at).getTime(),parametersFrozenAt:b.parametersFrozenAt,developmentEnd:Date.parse(protocol.developmentEnd),validationEnd:Date.parse(protocol.validationEnd),holdoutEnd:Date.parse(protocol.holdoutEnd),holdoutInspected:false,evidence:b.evidence==='FORWARD_PAPER_LEDGER'?'MODELED_FILL' as const:b.evidence,...b.capabilities};
  const gate=freshValidationGate({trades:b.trades as FreshResearchTrade[],strategy:b.cohort.strategy,manifest,equityPath:b.equityPath,unresolved:b.unresolved,forwardTrades:b.forwardTrades.length,forwardSessions:new Set(b.forwardTrades.map(t=>t.session)).size});
  const split=partitionFreshResearch(b.trades as FreshResearchTrade[],manifest);
  const summary=(trades:readonly FreshResearchTrade[])=>({completed:trades.length,wins:trades.filter(t=>t.netPnl>0).length,losses:trades.filter(t=>t.netPnl<0).length,flat:trades.filter(t=>t.netPnl===0).length,netPnl:trades.length?trades.reduce((n,t)=>n+t.netPnl,0):null,expectancyR:trades.length?trades.reduce((n,t)=>n+t.netPnl/t.initialRisk,0)/trades.length:null,sessions:new Set(trades.map(t=>t.session)).size});
  const periods={development:summary(split.development),validation:summary(split.validation),holdout:summary(split.holdout),forward:summary(b.forwardTrades),crossBoundary:split.crossBoundary.length,afterProtocol:split.afterProtocol.length};
  const blockers=[...gate.blockers,'HOLDOUT_BLINDNESS_NOT_ENFORCED','DECLARED_DATASET_CAPABILITIES_NOT_INDEPENDENTLY_QUALIFIED',...(b.outcomesPreviouslyInspected?['HOLDOUT_PREVIOUSLY_INSPECTED']:[])];
  const result={protocolId:protocol.id,protocolDigest:freshProtocolDigest(),datasetDigest:digest,cohort:b.cohort,evidence:b.evidence,periods,inspectionRecorded:true,replayedStoredReport:false,gate:{...gate,blockers:[...new Set(blockers)],eligibleForHumanReview:false,promoted:false},
   note:'Declared dataset capabilities are not independently certified. Existing visible paper outcomes are not assumed untouched; an inspected cohort cannot authorize future parameter tuning or automatic promotion.'};
  await db.unsafe("UPDATE fresh_research_runs SET status='COMPLETE',result=$1::text::jsonb WHERE protocol_id=$2 AND cohort=$3 AND status='RUNNING'",[JSON.stringify(result),protocol.id,cohort]);
  return result;
 }catch(error){await db.unsafe("UPDATE fresh_research_runs SET status='FAILED',result=$1::text::jsonb WHERE protocol_id=$2 AND cohort=$3 AND status='RUNNING'",[JSON.stringify({error:'RESEARCH_REPORT_FAILED',inspectionRecorded:true}),protocol.id,cohort]);throw error;}
}
