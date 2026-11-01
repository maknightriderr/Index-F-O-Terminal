import {describe,it,expect,vi} from 'vitest';
import {freshAdapterState} from '../fresh-start/adapter-state.js';
import {FreshOperationalReporter,freshOperationalEvidence} from '../fresh-start/operational-evidence.js';

const state=()=>({...structuredClone(freshAdapterState),status:'WAITING_FOR_MARKET',recovered:true,monitorRunning:true,entriesArmed:false,entryBlockers:['OUTSIDE_VERIFIED_SESSION']});
describe('automatic operational evidence with no trading authority',()=>{
 it('projects only explicit safe fields; never includes raw errors, keys, contracts or source payloads',()=>{
   const s=state();s.error='secret raw provider response';
   (s as any).apiKey='private-key';s.entryBlockers=['OUTSIDE_VERIFIED_SESSION','OUTSIDE_VERIFIED_SESSION','error secret raw provider response'];
   s.eventSources={macro:{status:'BLOCKED_EVENT_PROVIDER_CONFIGURATION',apiKey:'private-key',events:[{secret:'payload'}]},issuer:{status:'BLOCKED_ISSUER_SOURCE_RESPONSE',failureCode:'HTTP_403'}} as any;
   const before=JSON.stringify(s),e=freshOperationalEvidence(s),serialized=JSON.stringify(e);
   expect(e).toMatchObject({status:'WAITING_FOR_MARKET',entriesArmed:false,liveOrdersAllowed:false,sources:{issuer:{status:'BLOCKED_ISSUER_SOURCE_RESPONSE',failureCode:'HTTP_403'}}});
   expect(e.entryBlockers).toEqual(['OUTSIDE_VERIFIED_SESSION','UNAVAILABLE']);expect(e.markets).toHaveLength(4);
   for(const forbidden of ['private-key','secret','payload','apiKey'])expect(serialized).not.toContain(forbidden);
   expect(JSON.stringify(s)).toBe(before);
 });
 it('coalesces flapping readiness to the latest state at the next eligible scan and does not log unchanged ticks',()=>{
   let now=1000;const emit=vi.fn(),reporter=new FreshOperationalReporter(emit,()=>now),s=state();reporter.report(s);expect(emit).toHaveBeenCalledOnce();
   now+=10000;s.status='PAPER_ARMED_DATA_BLOCKED';reporter.report(s);s.status='FORWARD_PAPER_RUNNING';s.entriesArmed=true;
   now+=49999;reporter.report(s);expect(emit).toHaveBeenCalledOnce();now++;reporter.report(s);expect(emit).toHaveBeenCalledTimes(2);expect(emit.mock.calls[1][0]).toMatchObject({status:'FORWARD_PAPER_RUNNING',entriesArmed:true});
   now+=600000;s.lastCheckAt=now;s.barCallbacks++;reporter.report(s);expect(emit).toHaveBeenCalledTimes(2);
 });
 it('detects market and issuer failures even if the aggregate status is unchanged',()=>{
   let now=1000;const emit=vi.fn(),reporter=new FreshOperationalReporter(emit,()=>now),s=state();reporter.report(s);
   now+=60000;s.marketReadiness[3].blockers=['BLOCKED_MCX_BOOK_QUANTITY_UNITS'];reporter.report(s);
   now+=60000;s.eventSources={issuer:{status:'BLOCKED_ISSUER_SOURCE_RESPONSE',failureCode:'HTTP_403'}} as any;reporter.report(s);expect(emit).toHaveBeenCalledTimes(3);
 });
 it('bounds blocker lists, ignores reordered duplicates and refuses backward clock/logging side effects',()=>{
   let now=1000;const emit=vi.fn(),reporter=new FreshOperationalReporter(emit,()=>now),s=state();s.entryBlockers=['B','A','A'];reporter.report(s);
   now+=60000;s.entryBlockers=['A','B'];reporter.report(s);expect(emit).toHaveBeenCalledOnce();now=500;s.status='BLOCKED_ADAPTER';reporter.report(s);expect(emit).toHaveBeenCalledOnce();
   s.entryBlockers=Array.from({length:200},(_,i)=>`BLOCKED_${i}`);expect(freshOperationalEvidence(s).entryBlockers).toHaveLength(32);
   const before=JSON.stringify(s);const broken=new FreshOperationalReporter(()=>{throw Error('logger unavailable');});expect(()=>broken.report(s)).not.toThrow();expect(JSON.stringify(s)).toBe(before);
 });
});
