import {describe,it,expect,vi,afterEach} from 'vitest';
const mocks=vi.hoisted(()=>({evaluate:vi.fn()}));
vi.mock('@fno/analytics',async original=>({...await original<object>(),evaluateFreshStrategies:mocks.evaluate}));
vi.mock('../../lib/redis.js',()=>({scanKeys:vi.fn(async()=>[])}));
import {FreshRuntime} from '../fresh-start/runtime.js';
afterEach(()=>vi.useRealTimers());
describe('contract planning before first-ask arbitration',()=>{
 it('waits for only the winning candidate and attaches a watch immediately after durable entry',async()=>{
  vi.useFakeTimers();const now=Date.parse('2026-10-30T06:00:00Z');vi.setSystemTime(now);
  const low={id:'low',at:now,expiresAt:now+2000,origin:now-300000,strategy:'NEW_ORB_RETEST_V1'},high={...low,id:'high',strategy:'NEW_VWAP_PULLBACK_V1'};mocks.evaluate.mockReturnValue({candidates:[low,high],refusals:[]});
  const noQuote=vi.fn(()=>new Promise<any>(()=>{})),fill=vi.fn(async()=>({candidate:high})),store={recover:vi.fn(async()=>[]),observe:vi.fn(),enter:vi.fn(async()=>({ok:true,code:'FILLED'}))};
  const adapter={qualified:true,build:vi.fn(),prepare:vi.fn(async(c:any)=>({candidate:c,netRR:c.id==='high'?2.5:1.8,finish:c.id==='high'?fill:noQuote})),watch:vi.fn(async()=>{}),audit:vi.fn(async()=>{}),decision:vi.fn(async()=>{})};
  const runtime=new FreshRuntime(store as any,adapter as any,()=>true);await runtime.recover();expect(await runtime.onClosedReference({now} as any)).toBe('FILLED');expect(noQuote).not.toHaveBeenCalled();expect(fill).toHaveBeenCalledOnce();expect(adapter.decision).toHaveBeenCalledWith(low,'ANOTHER_CANDIDATE_SELECTED');expect(adapter.watch).toHaveBeenCalledTimes(2);expect(store.enter).toHaveBeenCalledOnce();expect(adapter.build).not.toHaveBeenCalled();
 });
 it('gives the earlier confirmation priority over a later candidate with higher modeled RR',async()=>{
  vi.useFakeTimers();const now=Date.parse('2026-10-30T06:00:00Z');vi.setSystemTime(now);const early={id:'early',at:now-100,expiresAt:now+1900,origin:now-300000,strategy:'NEW_ORB_RETEST_V1'},late={...early,id:'late',at:now,strategy:'NEW_VWAP_PULLBACK_V1'};mocks.evaluate.mockReturnValue({candidates:[late,early],refusals:[]});const finish=vi.fn(async(_candidate:any)=>null),adapter={qualified:true,build:vi.fn(),prepare:async(c:any)=>({candidate:c,netRR:c.id==='late'?9:1.6,finish:()=>{finish(c);return Promise.resolve(null);}}),watch:async()=>{},audit:async()=>{},decision:async()=>{}};const runtime=new FreshRuntime({recover:async()=>[],observe:vi.fn()} as any,adapter as any,()=>true);await runtime.recover();await runtime.onClosedReference({now} as any);expect(finish).toHaveBeenCalledWith(early);expect(finish).toHaveBeenCalledOnce();
 });
});
