import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {blackScholesPrice,FRESH_PACK_VERSION,freshRoundTripFees,type FreshCandidate} from '@fno/analytics';
import {FreshPaperStore,type FreshDb} from '../fresh-start/store.js';
import {FreshSharedFeed} from '../fresh-start/feed.js';
import {FreshProductionAdapter,type FreshReference} from '../fresh-start/adapter.js';
import {FRESH_NSE_FEES} from '../fresh-start/fees.js';
let pg:PGlite;
function client(db:any):FreshDb{return {unsafe:async(q,p=[])=>((await db.query(q,p.map((x:any)=>x instanceof Date?x.toISOString():x))).rows),begin:fn=>db.transaction((tx:any)=>fn(client(tx)))};}
beforeAll(async()=>{pg=new PGlite();await pg.exec(readFileSync(new URL('../../../../../database/init/047_fresh_start_paper.sql',import.meta.url),'utf8'));const migration=readFileSync(new URL('../../../../../database/init/048_fresh_start_adapter.sql',import.meta.url),'utf8');await pg.exec(migration);await pg.exec(migration);},30000);
afterAll(async()=>pg.close());
describe('production contract adapter → durable entry → executable exit',()=>{
 it('selects a verified parity-calibrated contract before arrival, freezes sized risk and closes on a later full-size bid',async()=>{
  let now=Date.parse('2026-10-30T06:00:00Z'),emit:(ticks:any[])=>void=()=>{};
  const manager={onTick:(f:any)=>{emit=f;return ()=>{};},onRecovering:()=>()=>{},subscribe:async()=>{},unsubscribe:()=>{}};
  const feed=new FreshSharedFeed(manager as any,()=>now);feed.start();
  const expiry='2026-11-03',expiryAt=Date.parse(expiry+'T15:30:00+05:30'),t=(expiryAt-now)/31536000000;
  const master=[24950,25000,25050].flatMap((strike,i)=>['CE','PE'].map((optionType,j)=>({token:String(100+i*2+j),name:'NIFTY',symbol:`NIFTY${strike}${optionType}`,exchange:'NSE',segment:'FO',instrumentType:'OPTIDX',expiry,strike,optionType,lotSize:25,tickSize:.05,contractUnits:{source:'ANGEL_MASTER_PRICE_V1',brokerLotQuantity:25,premiumUnitsPerLot:25,quantityVerified:true,tickVerified:true}}))) as any[];
  const signal={token:'1',name:'NIFTY',segment:'FO',exchange:'NSE',instrumentType:'FUTIDX',expiry:'2026-11-24',lotSize:25,tickSize:.05} as any;
  const ref:FreshReference={id:'NSE_FO:1',name:'NIFTY',signal,spot:{token:'2',exchangeSegment:'NSE_CM'},market:'NSE_INDEX_OPTIONS',riskGroup:'INDEX'};
  await feed.reserve([{token:'1',exchange:'NSE',exchangeSegment:'NSE_FO'},{token:'2',exchange:'NSE',exchangeSegment:'NSE_CM'},...master.map(x=>({token:x.token,exchange:'NSE' as const,exchangeSegment:'NSE_FO' as const}))],250);
  const tick=(token:string,ltp:number,segment='NSE_FO',bid?:number,ask?:number)=>({token,exchange:'NSE',exchangeSegment:segment,exchangeTimestamp:now,timestamp:now,ltp,bid,ask,bidQty:1000,askQty:1000});
  emit([tick('1',25000),tick('2',25000,'NSE_CM'),...master.map(x=>{const mid=.999*blackScholesPrice({spotPrice:25000,strikePrice:x.strike,timeToExpiry:t,riskFreeRate:0,iv:.1,optionType:x.optionType});return tick(x.token,mid,'NSE_FO',mid-.05,mid+.05);})]);
  const c:FreshCandidate={id:'adapter-candidate',version:FRESH_PACK_VERSION,strategy:'NEW_ORB_RETEST_V1',parentId:'p',direction:'BULLISH',instrument:ref.id,sourceEpoch:feed.sourceEpoch,session:'2026-10-30',at:now,expiresAt:now+2000,origin:now-300000,referenceEntry:25000,stop:24950,target:25400,atr:100,evidence:{}};
  const store=new FreshPaperStore(client(pg),()=>true),refusal=vi.fn(async()=>{}),adapter=new FreshProductionAdapter(feed,{clearance:()=>null,evidence:()=>({macro:{id:'synthetic-macro'}})} as any,store,{references:()=>new Map([[ref.id,ref]]),master:()=>master,capital:500000,legacyRisk:async()=>false,audit:async()=>{},refusal,watch:async()=>{},now:()=>now});
  const prepared=await adapter.prepare(c);expect(prepared,JSON.stringify(refusal.mock.calls)).not.toBeNull();expect(await store.recover()).toEqual([]);
  const pending=prepared!.finish();now+=300;emit([tick('1',25000),...master.map(x=>{const mid=.999*blackScholesPrice({spotPrice:25000,strikePrice:x.strike,timeToExpiry:t,riskFreeRate:0,iv:.1,optionType:x.optionType});return tick(x.token,mid,'NSE_FO',mid-.05,mid+.05);})]);
  const request=await pending;expect(request).not.toBeNull();expect(request!.quote.eventAt).toBeGreaterThanOrEqual(c.at+250);expect(await store.enter(request!)).toMatchObject({ok:true,code:'FILLED'});
  const [held]=await store.recover();expect(held.state.originalRiskCurrency).toBeLessThanOrEqual(1250);expect(held.state.sessionCutoff).toBe(request!.cutoff);expect(held.state.contract.feePolicy).toEqual(FRESH_NSE_FEES);
  now+=1000;const event={at:now,underlying:25401,underlyingAt:now,quote:null,cutoff:request!.cutoff,barsSinceFill:1,trail:false};await store.observe(request!.accountId,c.id,event);expect((await store.recover())[0].state.state).toBe('EXIT_PENDING');
  now+=300;const q={...request!.quote,eventAt:now,receivedAt:now,bid:250,ask:250.05};await store.observe(request!.accountId,c.id,{...event,at:now,underlyingAt:now,quote:q});expect(await store.recover()).toEqual([]);
  const [closed]=await client(pg).unsafe('SELECT state FROM fresh_paper_positions WHERE id=$1',[c.id]);expect(closed.state.netPnl).toBeCloseTo((249.95-held.state.entry)*held.state.quantity-freshRoundTripFees(held.state.entry,249.95,held.state.quantity,1,FRESH_NSE_FEES),6);feed.close();
 });
});
