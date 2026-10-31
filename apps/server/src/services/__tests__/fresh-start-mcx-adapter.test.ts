import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
vi.mock('../fresh-start/mcx-policy.js',async importOriginal=>({...await importOriginal<typeof import('../fresh-start/mcx-policy.js')>(),freshMcxPaperPolicyApproved:vi.fn(()=>true)}));
import {freshMcxPaperPolicyApproved} from '../fresh-start/mcx-policy.js';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {blackScholesPrice,FRESH_PACK_VERSION,freshRoundTripFees,type FreshCandidate} from '@fno/analytics';
import {FreshPaperStore,type FreshDb} from '../fresh-start/store.js';
import {FreshSharedFeed} from '../fresh-start/feed.js';
import {FreshProductionAdapter,type FreshReference} from '../fresh-start/adapter.js';
import {freshFeePolicyFor} from '../fresh-start/fees.js';
const MCX_FEES=freshFeePolicyFor({exchange:'MCX',segment:'FO',instrumentType:'OPTFUT',name:'CRUDEOIL'},'2026-11-02')!.policy;
let pg:PGlite;
function client(db:any):FreshDb{return {unsafe:async(q,p=[])=>((await db.query(q,p.map((x:any)=>x instanceof Date?x.toISOString():x))).rows),begin:fn=>db.transaction((tx:any)=>fn(client(tx)))};}
beforeAll(async()=>{pg=new PGlite();await pg.exec(readFileSync(new URL('../../../../../database/init/047_fresh_start_paper.sql',import.meta.url),'utf8'));const migration=readFileSync(new URL('../../../../../database/init/048_fresh_start_adapter.sql',import.meta.url),'utf8');await pg.exec(migration);await pg.exec(migration);},30000);
afterAll(async()=>pg.close());
describe('MCX exact-future proposal gate → durable observed-quote paper round trip',()=>{
 it('selects a verified parity-calibrated contract before arrival, freezes sized risk and closes on a later full-size bid',async()=>{
  let now=Date.parse('2026-11-02T06:00:00Z'),emit:(ticks:any[])=>void=()=>{};
  const manager={onTick:(f:any)=>{emit=f;return ()=>{};},onRecovering:()=>()=>{},subscribe:async()=>{},unsubscribe:()=>{}};
  const feed=new FreshSharedFeed(manager as any,()=>now);feed.start();
  const expiry='2026-11-17',expiryAt=Date.parse(expiry+'T23:55:00+05:30'),t=(expiryAt-now)/31536000000;
  const master=[5950,6000,6050].flatMap((strike,i)=>['CE','PE'].map((optionType,j)=>({token:String(100+i*2+j),name:'CRUDEOIL',symbol:`CRUDEOIL${strike}${optionType}`,exchange:'MCX',segment:'FO',instrumentType:'OPTFUT',expiry,strike,optionType,lotSize:100,tickSize:.1,contractUnits:{source:'ANGEL_MASTER_PRICE_V1',brokerLotQuantity:100,premiumUnitsPerLot:100,quantityVerified:true,tickVerified:true}}))) as any[];
  const signal={token:'1',name:'CRUDEOIL',segment:'FO',exchange:'MCX',instrumentType:'FUTCOM',expiry:'2026-11-19',lotSize:100,tickSize:.1} as any;
  const ref:FreshReference={id:'MCX_FO:1',name:'CRUDEOIL',signal,spot:{token:'1',exchangeSegment:'MCX_FO'},market:'MCX_VERIFIED_FUTURES_OPTIONS',riskGroup:'MCX:CRUDEOIL'};
  await feed.reserve([{token:'1',exchange:'MCX',exchangeSegment:'MCX_FO'},{token:'2',exchange:'MCX',exchangeSegment:'MCX_FO'},...master.map(x=>({token:x.token,exchange:'MCX' as const,exchangeSegment:'MCX_FO' as const}))],250);
  const tick=(token:string,ltp:number,segment='MCX_FO',bid?:number,ask?:number)=>({token,exchange:'MCX',exchangeSegment:segment,exchangeTimestamp:now,timestamp:now,ltp,bid,ask,bidQty:1000,askQty:1000});
  emit([tick('1',6000),tick('2',6000,'MCX_FO'),...master.map(x=>{const mid=.999*blackScholesPrice({spotPrice:6000,strikePrice:x.strike,timeToExpiry:t,riskFreeRate:0,iv:.09,optionType:x.optionType});return tick(x.token,mid,'MCX_FO',mid-.05,mid+.05);})]);
  const c:FreshCandidate={id:'adapter-candidate',version:FRESH_PACK_VERSION,strategy:'NEW_ORB_RETEST_V1',parentId:'p',direction:'BULLISH',instrument:ref.id,sourceEpoch:feed.sourceEpoch,session:'2026-11-02',at:now,expiresAt:now+2000,origin:now-300000,referenceEntry:6000,stop:5950,target:6400,atr:100,evidence:{}};
  const store=new FreshPaperStore(client(pg),()=>true),refusal=vi.fn(async(_c:FreshCandidate,_code:string,_evidence?:Record<string,unknown>)=>{}),adapter=new FreshProductionAdapter(feed,{clearance:()=>null,evidence:()=>({macro:{id:'synthetic-macro'}})} as any,store,{references:()=>new Map([[ref.id,ref]]),master:()=>[signal,...master],capital:500000,legacyRisk:async()=>false,audit:async()=>{},refusal,watch:async()=>{},now:()=>now});
  vi.mocked(freshMcxPaperPolicyApproved).mockReturnValue(false);expect(await adapter.prepare(c)).toBeNull();expect(refusal).toHaveBeenLastCalledWith(c,'MARKET_PRODUCT_POLICY_NOT_QUALIFIED',expect.any(Object));
  vi.mocked(freshMcxPaperPolicyApproved).mockReturnValue(true);ref.signal.exchange='NSE';expect(await adapter.prepare(c)).toBeNull();expect(refusal).toHaveBeenLastCalledWith(c,'BLOCKED_EXACT_REFERENCE',expect.any(Object));ref.signal.exchange='MCX';
  for(const row of master)row.contractUnits.quantityVerified=false;expect(await adapter.prepare(c)).toBeNull();for(const row of master)row.contractUnits.quantityVerified=true;
  expect(await adapter.prepare(c)).toBeNull();expect(refusal.mock.calls.at(-1)?.[2]).toMatchObject({refusals:expect.arrayContaining([expect.objectContaining({code:'ZERO_PERMITTED_LOTS'})])});
  // A separate synthetic tight-stop case fits the unchanged INR 1,250 risk cap.
  c.stop=5998;const prepared=await adapter.prepare(c);expect(prepared,JSON.stringify(refusal.mock.calls)).not.toBeNull();expect(await store.recover()).toEqual([]);
  const pending=prepared!.finish();now+=300;emit([tick('1',6000),...master.map(x=>{const mid=.999*blackScholesPrice({spotPrice:6000,strikePrice:x.strike,timeToExpiry:t,riskFreeRate:0,iv:.09,optionType:x.optionType});return tick(x.token,mid,'MCX_FO',mid-.05,mid+.05);})]);
  const request=await pending;expect(request).not.toBeNull();expect(request!.quote.eventAt).toBeGreaterThanOrEqual(c.at+250);expect(await store.enter(request!)).toMatchObject({ok:true,code:'FILLED'});
  const [held]=await store.recover();expect(held.state.contract.evidence?.optionFuturesLink).toMatchObject({futureToken:'1',optionExpiry:'2026-11-17'});expect(held.state.contract.evidence?.futureContract).toBe('MCX_FO:1');expect(held.state.contract.marketPolicy).toBe('MCX_EXACT_FUTURE_3_15_PAPER_V1');expect(held.state.contract.id).toMatch(/^MCX_FO:/);expect(request!.riskGroup).toBe('MCX:CRUDEOIL');expect(held.state.originalRiskCurrency).toBeLessThanOrEqual(1250);expect(held.state.sessionCutoff).toBe(request!.cutoff);expect(held.state.contract.feePolicy).toEqual(MCX_FEES);expect(held.state.contract.evidence?.fees).toMatchObject({tax:'CTT',product:'CRUDEOIL',basis:'PREMIUM_TURNOVER',flatPremiumRoundTripEstimate:{brokerage:40}});
  now+=1000;const event={at:now,underlying:6401,underlyingAt:now,quote:null,cutoff:request!.cutoff,barsSinceFill:1,trail:false};await store.observe(request!.accountId,c.id,event);expect((await store.recover())[0].state.state).toBe('EXIT_PENDING');
  now+=300;const q={...request!.quote,eventAt:now,receivedAt:now,bid:250,ask:250.1};await store.observe(request!.accountId,c.id,{...event,at:now,underlyingAt:now,quote:q});expect(await store.recover()).toEqual([]);
  const [closed]=await client(pg).unsafe('SELECT state FROM fresh_paper_positions WHERE id=$1',[c.id]);expect(closed.state.netPnl).toBeCloseTo((249.9-held.state.entry)*held.state.quantity-freshRoundTripFees(held.state.entry,249.9,held.state.quantity,1,MCX_FEES),6);feed.close();
 });
});
