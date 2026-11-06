// 6 Nov: setups were found but died at the adapter (books rotated away, 2 s window, synchronous parity, silent gaps).
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {blackScholesPrice,FRESH_ENTRY_WINDOW_MS,FRESH_PACK_VERSION,type FreshCandidate} from '@fno/analytics';
import {FreshPaperStore,type FreshDb} from '../fresh-start/store.js';
import {FreshSharedFeed,FRESH_FEED_STALL_MS} from '../fresh-start/feed.js';
import {FreshEventSource} from '../fresh-start/event-source.js';
import {FRESH_PAPER_EVENT_POLICY} from '../../config/fresh-event-policy.js';
import {FreshProductionAdapter,FRESH_PARITY_RELAXED,type FreshReference} from '../fresh-start/adapter.js';
import {freshRotatingBookRefs,FRESH_PINNED_BOOK_MARKETS} from '../fresh-start/worker.js';

let pg:PGlite;
function client(db:any):FreshDb{return {unsafe:async(q,p=[])=>((await db.query(q,p.map((x:any)=>x instanceof Date?x.toISOString():x))).rows),begin:fn=>db.transaction((tx:any)=>fn(client(tx)))};}
beforeAll(async()=>{pg=new PGlite();await pg.exec(readFileSync(new URL('../../../../../database/init/047_fresh_start_paper.sql',import.meta.url),'utf8'));await pg.exec(readFileSync(new URL('../../../../../database/init/048_fresh_start_adapter.sql',import.meta.url),'utf8'));},30000);
afterAll(async()=>pg.close());

async function setup(){
  const start=Date.parse('2026-10-30T06:00:00Z'),wall=Date.now();
  // Exchange time follows the wall clock, so the adapter's 1 s retry sleeps advance it.
  let offset=0;const now=()=>start+(Date.now()-wall)+offset;let emit:(ticks:any[])=>void=()=>{};
  const manager={onTick:(f:any)=>{emit=f;return ()=>{};},onRecovering:()=>()=>{},subscribe:async()=>{},unsubscribe:()=>{}};
  const feed=new FreshSharedFeed(manager as any,now);feed.start();
  const expiry='2026-11-03',expiryAt=Date.parse(expiry+'T15:30:00+05:30');
  const master=[24950,25000,25050].flatMap((strike,i)=>['CE','PE'].map((optionType,j)=>({token:String(100+i*2+j),name:'NIFTY',symbol:`NIFTY${strike}${optionType}`,exchange:'NSE',segment:'FO',instrumentType:'OPTIDX',expiry,strike,optionType,lotSize:25,tickSize:.05,contractUnits:{source:'ANGEL_MASTER_PRICE_V1',brokerLotQuantity:25,premiumUnitsPerLot:25,quantityVerified:true,tickVerified:true}}))) as any[];
  const signal={token:'1',name:'NIFTY',segment:'FO',exchange:'NSE',instrumentType:'FUTIDX',expiry:'2026-11-24',lotSize:25,tickSize:.05} as any;
  const ref:FreshReference={id:'NSE_FO:1',name:'NIFTY',signal,spot:{token:'2',exchangeSegment:'NSE_CM'},market:'NSE_INDEX_OPTIONS',riskGroup:'INDEX'};
  await feed.reserve([{token:'1',exchange:'NSE',exchangeSegment:'NSE_FO'},{token:'2',exchange:'NSE',exchangeSegment:'NSE_CM'},...master.map(x=>({token:x.token,exchange:'NSE' as const,exchangeSegment:'NSE_FO' as const}))],250);
  const tick=(token:string,ltp:number,at:number,segment='NSE_FO',bid?:number,ask?:number)=>({token,exchange:'NSE',exchangeSegment:segment,exchangeTimestamp:at,timestamp:at,ltp,bid,ask,bidQty:1000,askQty:1000});
  const refs=(at=now())=>emit([tick('1',25000,at),tick('2',25000,at,'NSE_CM')]);
  const books=(strikes=[24950,25000,25050],at=now())=>emit(master.filter(x=>strikes.includes(x.strike)).map(x=>{const mid=.999*blackScholesPrice({spotPrice:25000,strikePrice:x.strike,timeToExpiry:(expiryAt-at)/31536000000,riskFreeRate:0,iv:.1,optionType:x.optionType});return tick(x.token,mid,at,'NSE_FO',mid-.05,mid+.05);}));
  const refusal=vi.fn(async(..._:any[])=>{});
  const store=new FreshPaperStore(client(pg),()=>true,now);
  const adapter=new FreshProductionAdapter(feed,new FreshEventSource(undefined,vi.fn() as any,now,null,undefined,null,{blackout:()=>null,evidence:()=>null,view:()=>null} as any,null,FRESH_PAPER_EVENT_POLICY),store,{references:()=>new Map([[ref.id,ref]]),master:()=>master,capital:500000,legacyRisk:async()=>false,audit:async()=>{},refusal,watch:async()=>{},now,ivRank:async()=>null});
  const candidate=(window:number):FreshCandidate=>({id:`c-${window}`,version:FRESH_PACK_VERSION,strategy:'NEW_ORB_RETEST_V1',parentId:'p',direction:'BULLISH',instrument:ref.id,sourceEpoch:feed.sourceEpoch,session:'2026-10-30',at:now(),expiresAt:now()+window,origin:now()-300000,referenceEntry:25000,stop:24950,target:25400,atr:100,evidence:{}});
  return {feed,adapter,refusal,refs,books,candidate,master,now,skip:(ms:number)=>{offset+=ms;}};
}

describe('fresh-start entry window and adapter evidence (6 Nov)',()=>{
  it('gives a candidate a 20 s window to find books (was 2 s)',()=>{expect(FRESH_ENTRY_WINDOW_MS).toBe(20_000);expect(FRESH_PARITY_RELAXED).toEqual({maxAgeMs:10_000,maxSkewMs:10_000});});

  it('retries pricing while the window lasts and selects a contract once books arrive',async()=>{
    await pg.exec('TRUNCATE fresh_paper_events,fresh_paper_positions,fresh_candidates,fresh_parent_moves,fresh_paper_accounts CASCADE');
    const s=await setup();s.refs();const c=s.candidate(20_000);
    // No option book at the bar close; the books arrive ~0.6 s later (references kept live).
    setTimeout(()=>{s.refs();s.books();},600);
    const prepared=await s.adapter.prepare(c);
    expect(prepared,JSON.stringify(s.refusal.mock.calls)).not.toBeNull();expect(s.refusal).not.toHaveBeenCalled();
    s.feed.close();
  },15_000);

  it('records why no contract was evaluated instead of a generic refusal',async()=>{
    const s=await setup();s.refs();s.books([24950,25000]);
    // Only two strikes have books: parity needs three. The window leaves no time for a retry.
    expect(await s.adapter.prepare(s.candidate(3500))).toBeNull();
    expect(s.refusal).toHaveBeenCalledWith(expect.anything(),'NO_FRESH_PARITY_PAIRS',expect.objectContaining({attempts:1,misses:[expect.objectContaining({expiry:'2026-11-03',code:'NO_FRESH_PARITY_PAIRS',pairs:2})]}));
    s.feed.close();
  });

  it('fits the parity basis on books up to 10 s old while the traded quote stays fresh',async()=>{
    await pg.exec('TRUNCATE fresh_paper_events,fresh_paper_positions,fresh_candidates,fresh_parent_moves,fresh_paper_accounts CASCADE');
    const s=await setup(),t0=s.now();s.books([24950,25050],t0);s.skip(6000);
    // 24950 / 25050 books are 6 s old; only the 25000 books (the traded strike) are fresh.
    s.refs();s.books([25000]);
    expect(s.feed.quote('NSE_FO:100',.05)).toBeNull();expect(s.feed.modelQuote('NSE_FO:100',.05,10_000)).not.toBeNull();expect(s.feed.modelQuote('NSE_FO:100',.05,5_000)).toBeNull();
    const prepared=await s.adapter.prepare(s.candidate(3500));
    expect(prepared,JSON.stringify(s.refusal.mock.calls)).not.toBeNull();
    s.feed.close();
  });
});

describe('fresh-start feed watchdog',()=>{
  it('reports a stall only while ticks arrive and none is accepted for 60 s',()=>{
    let now=1_000_000,emit:(t:any[])=>void=()=>{};
    const feed=new FreshSharedFeed({onTick:(f:any)=>{emit=f;return ()=>{};},onRecovering:()=>()=>{},subscribe:async()=>{},unsubscribe:()=>{}} as any,()=>now);feed.start();
    const t=(lag:number)=>({token:'1',exchange:'NSE',exchangeSegment:'NSE_FO',exchangeTimestamp:now-lag,timestamp:now,ltp:100});
    emit([t(0)]);now+=FRESH_FEED_STALL_MS+1;expect(feed.stalled()).toBe(false); // silence is not a stall
    emit([t(30_000)]);expect(feed.stalled()).toBe(true); // arriving, every tick dropped
    feed.resetStallClock();expect(feed.stalled()).toBe(false);
    now+=FRESH_FEED_STALL_MS;emit([t(30_000)]);expect(feed.stalled()).toBe(true);
    emit([t(0)]);expect(feed.stalled()).toBe(false);
  });
});

describe('fresh-start book plan',()=>{
  const ref=(id:string,market:string):FreshReference=>({id,name:id,market,signal:{token:id} as any,spot:{token:id,exchangeSegment:'NSE_CM'},riskGroup:id} as any);
  const refs=[ref('NIFTY','NSE_INDEX_OPTIONS'),ref('SENSEX','BSE_VERIFIED_OPTIONS'),...['A','B','C','D'].map(x=>ref(x,'NSE_STOCK_OPTIONS')),...['CRUDE','GOLD'].map(x=>ref(x,'MCX_VERIFIED_FUTURES_OPTIONS'))];
  it('keeps index books out of the rotation, covers each rotating market and puts a fresh setup first',()=>{
    expect([...FRESH_PINNED_BOOK_MARKETS].sort()).toEqual(['BSE_VERIFIED_OPTIONS','NSE_INDEX_OPTIONS']);
    const plain=freshRotatingBookRefs(refs,0,new Set(),2);expect(plain.map(r=>r.market).sort()).toEqual(['MCX_VERIFIED_FUTURES_OPTIONS','NSE_STOCK_OPTIONS']);
    const urgent=freshRotatingBookRefs(refs,0,new Set(['D']),2);expect(urgent[0].id).toBe('D');expect(urgent).toHaveLength(2);
    expect(freshRotatingBookRefs(refs,0,new Set(),0)).toEqual([]);
    expect(freshRotatingBookRefs(refs,0,new Set(),10).some(r=>FRESH_PINNED_BOOK_MARKETS.has(r.market))).toBe(false);
  });
});
