import {describe,it,expect,vi} from 'vitest';
import {FreshPositionMonitor,completeFreshBarsSinceFill} from '../fresh-start/monitor.js';
import {FRESH_PACK_VERSION,advanceFreshPosition} from '@fno/analytics';
import {FreshSharedFeed} from '../fresh-start/feed.js';
import {getSessionWindow} from '@fno/shared';
const session=getSessionWindow('NSE','2026-10-30')!,at=session.open+1800000;
function row(){return {id:'held',account_id:'account',revision:0,risk_group:'INDEX',state:{id:'held',candidate:{id:'held',parentId:'p',version:FRESH_PACK_VERSION,strategy:'NEW_ORB_RETEST_V1' as const,direction:'BULLISH' as const,instrument:'NSE_FO:1',sourceEpoch:'before-restart',session:'2026-10-30',at:at-300,referenceEntry:25000,stop:24900,target:25200,atr:100,expiresAt:at+1700,origin:at-300000,evidence:{}},contract:{id:'NSE_FO:2',source:'ANGEL',sourceEpoch:'before-restart',lotQuantity:25,multiplier:1,expiryTradableSessions:3,market:'NSE_INDEX_OPTIONS' as const,delta:.55,metadataVerified:true,modelVerified:true,feesVerified:true,targetPremiumScenarios:[200,190],invalidationPremiumScenarios:[80,75],explicitRoundTripCostPerUnit:1,evidence:{tickSize:.05}},quantity:25,entry:100,originalRiskCurrency:650,emergencyStop:75,currentStop:75,highBid:100,openedAt:at,lastEventAt:at,state:'OPEN' as const,exitTriggeredAt:null,exitReason:null,exitPrice:null,netPnl:null,maxUnderlyingFavorable:0,sessionCutoff:session.close}};}
describe('independent paper exit monitoring',()=>{
 it('counts actual completed aligned bars after a midbar fill',()=>{expect(completeFreshBarsSinceFill(session.open+60000,session.open+900000,session.open)).toBe(2);expect(completeFreshBarsSinceFill(session.open,session.open+900000,session.open)).toBe(3);});
 it('retains an observed target through a database failure and retries its exact event before later observations',async()=>{let now=at+1000;const observe=vi.fn().mockRejectedValueOnce(Error('db unavailable')).mockResolvedValue(true);const feed={sourceEpoch:'after-restart',underlying:()=>({price:25210,at:now}),quote:()=>({contract:'NSE_FO:2',source:'ANGEL',epoch:'after-restart',eventAt:now,receivedAt:now,bid:150,ask:150.05,bidUnits:25,askUnits:25,tick:.05})};const monitor=new FreshPositionMonitor(feed as any,{observe} as any,()=>now);monitor.watch([row()]);monitor.tick();await vi.waitFor(()=>expect(monitor.healthy).toBe(false));expect(observe.mock.calls[0][2].at).toBe(at+1000);now+=300;monitor.tick();await vi.waitFor(()=>expect(monitor.healthy).toBe(true));expect(observe.mock.calls[1][2].at).toBe(at+1000);expect(observe.mock.calls[2][2].at).toBe(at+1300);expect(observe.mock.calls[2][2].monitorEpoch).toBe('after-restart');});
 it('marks a forced cutoff pending even with no option quote, without inventing an exit price',async()=>{const observe=vi.fn(async(_account:string,_id:string,_event:any)=>true),feed={sourceEpoch:'now',underlying:()=>null,quote:()=>null};const monitor=new FreshPositionMonitor(feed as any,{observe} as any,()=>session.close-599999);monitor.watch([row()]);monitor.tick();await vi.waitFor(()=>expect(observe).toHaveBeenCalled());expect(observe.mock.calls[0][2].quote).toBeNull();expect(observe.mock.calls[0][2].cutoff).toBe(session.close);});
 it('persists the first favorable threshold crossing even between routine one-second samples',async()=>{let now=at+100;let price=25000;const observe=vi.fn(async(_account:string,_id:string,_event:any)=>true),feed={sourceEpoch:'new',underlying:()=>({price,at:now}),quote:()=>null};const monitor=new FreshPositionMonitor(feed as any,{observe} as any,()=>now);monitor.watch([row()]);monitor.tick();await vi.waitFor(()=>expect(observe).toHaveBeenCalledTimes(1));now+=100;price=25026;monitor.tick();await vi.waitFor(()=>expect(observe).toHaveBeenCalledTimes(2));expect(observe.mock.calls[1][2].underlying).toBe(25026);});
});

/** Synthetic shared-socket observations and an injected storage stall; not production fills/load. */
describe('paper monitor resilience under bounded shared-feed pressure',()=>{
 async function shared(){
   let now=at,emit:(ticks:any[])=>void=()=>{},recover:()=>void=()=>{};
   const manager={onTick:(fn:any)=>{emit=fn;return ()=>{};},onRecovering:(fn:any)=>{recover=fn;return ()=>{};},subscribe:vi.fn(async()=>{}),unsubscribe:vi.fn()};
   const feed=new FreshSharedFeed(manager as any,()=>now);
   feed.start();await feed.reserve(Array.from({length:250},(_,i)=>({token:String(i+1),exchange:'NSE' as const,exchangeSegment:'NSE_FO' as const})),250);
   const batch=(reference=25000,bidUnits=25,observedAt=now)=>emit(Array.from({length:250},(_,i)=>({token:String(i+1),exchange:'NSE',exchangeSegment:'NSE_FO',exchangeTimestamp:observedAt,timestamp:observedAt,ltp:i===0?reference:100,bid:100,ask:100.05,bidQty:bidUnits,askQty:25})));
   return {feed,manager,batch,recover,setNow:(value:number)=>{now=value;},now:()=>now};
 }
 it('bounds stalled storage queues while retaining a brief target and its first eligible exit among 100,000 ticks',async()=>{
   const s=await shared(),held=row();let saved=held.state as any,release!:()=>void;
   const blocked=new Promise<void>(resolve=>{release=resolve;}),persisted:any[]=[];
   const observe=vi.fn(async(_account:string,_id:string,event:any)=>{await blocked;persisted.push(event);saved=advanceFreshPosition(saved,event);return true;});
   const monitor=new FreshPositionMonitor(s.feed,{observe} as any,s.now);monitor.watch([held]);
   let largestQueue=0;
   try{
     for(let i=1;i<=400;i++){
       s.setNow(at+i*100);s.batch(i===300?25210:25000);monitor.tick();
       const queue=(monitor as any).queues.get(held.id)??[];largestQueue=Math.max(largestQueue,queue.length);expect(queue.length).toBeLessThanOrEqual(16);
     }
     expect(s.manager.subscribe).toHaveBeenCalledOnce();expect(observe).toHaveBeenCalledOnce();expect(largestQueue).toBe(16);
     expect([...(s.feed as any).books.values()].every((books:any)=>books.length<=100)).toBe(true);
     release();await vi.waitFor(()=>expect(saved.state).toBe('CLOSED'));
     expect(saved.exitReason).toBe('UNDERLYING_TARGET');expect(saved.exitTriggeredAt).toBe(at+30000);expect(saved.exitPrice).toBeCloseTo(99.95);
     expect(persisted.some(e=>e.underlying===25210&&e.at===at+30000)).toBe(true);
     expect(persisted.find(e=>e.at>=at+30300)?.at).toBe(at+30300);
     expect(persisted).toHaveLength(largestQueue);expect(new Set(persisted.map(e=>e.at)).size).toBe(persisted.length);expect(monitor.healthy).toBe(true);
   }finally{release();s.feed.close();}
 },15000);
 it('keeps a recovered pending exit unresolved through disconnect, stale data and insufficient depth until a fresh full-size book arrives',async()=>{
   const s=await shared(),held=row() as any;let saved=held.state;
   held.state.state='EXIT_PENDING';held.state.exitTriggeredAt=at-1000;held.state.exitReason='UNDERLYING_TARGET';
   const observe=vi.fn(async(_account:string,_id:string,event:any)=>{saved=advanceFreshPosition(saved,event);return true;});
   const monitor=new FreshPositionMonitor(s.feed,{observe} as any,s.now);monitor.watch([held]);
   try{
     s.batch();s.recover();s.setNow(at+5000);monitor.tick();await vi.waitFor(()=>expect(observe).toHaveBeenCalledTimes(1));expect(saved.state).toBe('EXIT_PENDING');expect(saved.exitPrice).toBeNull();
     s.setNow(at+6000);s.batch(25000,25,at);monitor.tick();await vi.waitFor(()=>expect(observe).toHaveBeenCalledTimes(2));expect(saved.state).toBe('EXIT_PENDING');
     s.setNow(at+7000);s.batch(25000,1);monitor.tick();await vi.waitFor(()=>expect(observe).toHaveBeenCalledTimes(3));expect(saved.state).toBe('EXIT_PENDING');
     s.setNow(at+8000);s.batch();monitor.tick();await vi.waitFor(()=>expect(saved.state).toBe('CLOSED'));
     expect(saved.exitPrice).toBeCloseTo(99.95);expect(saved.exitTriggeredAt).toBe(at-1000);expect(observe.mock.calls.at(-1)![2].monitorEpoch).toBe(s.feed.sourceEpoch);
   }finally{s.feed.close();}
 });
});
