import {z} from 'zod';
import {createHash} from 'node:crypto';
import {evaluateFreshStrategies,FRESH_PACK_VERSION} from '@fno/analytics';
const n=z.number().finite(),positive=n.positive();
const bar=z.object({time:positive,availableAt:positive,open:positive,high:positive,low:positive,close:positive,volume:n.nonnegative()}).strict();
const context=z.object({now:positive,session:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),sessionOpen:positive,sessionClose:positive,instrument:z.string().min(1),sourceEpoch:z.string().min(1),bars5:z.array(bar).max(4000),bars15:z.array(bar).max(4000),bars1:z.array(bar).max(1440),rvolReferences:z.record(z.array(n.nonnegative()).max(100)).refine(r=>Object.keys(r).length<=500),openingVolumeReferences:z.array(n.nonnegative()).max(100),levels:z.array(z.object({price:positive,knownAt:positive,role:z.enum(['SUPPORT','RESISTANCE']),kind:z.string()})).max(500),previousHigh:n,previousLow:n,referenceVerified:z.boolean(),eventClear:z.boolean(),eventEvidence:z.record(z.unknown()).optional(),calendarVerified:z.boolean()}).strict();
const records=z.array(z.object({id:z.string().min(1).max(200),version:z.literal(FRESH_PACK_VERSION),input:context,result:z.unknown()}).strict()).min(1).max(1000);
function canonical(x:any):string{return JSON.stringify(x&&typeof x==='object'?Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])):x);}
/** Stored decision replay only: no prices/fills/results are reconstructed or promoted. */
export function replayFreshResearch(raw:unknown){
 const rows=records.parse(raw),ids=new Set<string>();let prior=0;
 const results=rows.map(r=>{
  if(ids.has(r.id)||r.input.now<prior||r.input.session!==new Date(r.input.now).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}))throw Error('INVALID_REPLAY_ORDER_OR_IDENTITY');
  ids.add(r.id);prior=r.input.now;
  const evaluation=evaluateFreshStrategies(r.input as Parameters<typeof evaluateFreshStrategies>[0]);
  return {id:r.id,matchesStoredDecision:canonical(evaluation)===canonical(r.result),candidateCount:evaluation.candidates.length,refusalCount:evaluation.refusals.length};
 });
 return {version:FRESH_PACK_VERSION,evidence:'SIGNAL_REPLAY_ONLY',datasetDigest:createHash('sha256').update(canonical(rows)).digest('hex'),sampled:results.length,matched:results.filter(r=>r.matchesStoredDecision).length,mismatched:results.filter(r=>!r.matchesStoredDecision).length,rows:results,
  note:'Replay uses stored inputs and frozen decision time; it tests current-version decision reproducibility, not input completeness, historical option fills, trading edge or profitability.'};
}
