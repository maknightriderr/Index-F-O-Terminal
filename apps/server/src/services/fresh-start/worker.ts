import {randomUUID} from 'node:crypto';
import { recordGammaChain, setDhanPaperHandler, type DhanPaperRequest, type DhanGammaPaperRequest } from '../dhan-engine-shadow.js';
import { DHAN_ENGINE_SHADOW, DHAN_ENGINE_PAPER } from '../../config/order-flow-flags.js';
import { flowLastTrade } from '../order-flow-store.js';
import { dhanPaperCandidate, dhanGammaCandidate, freshMcxFlowDiagnostic, type FreshMcxFlowDiagnostic } from '@fno/analytics';
import {logger} from '../../lib/logger.js';
import {getSessionWindow,HOLIDAY_CALENDAR_YEARS,FO_SEGMENT,CM_SEGMENT,type Exchange,type Instrument} from '@fno/shared';
import {evaluateFreshStrategies,FRESH_SHADOW_STRATEGIES,type FreshBar} from '@fno/analytics';
import type {MarketDataProvider} from '../../providers/interface.js';
import type {SubscriptionManager,SubscriptionTarget} from '../../lib/subscription-manager.js';
import {sql} from '../../lib/db.js';
import {redis,scanKeys} from '../../lib/redis.js';
import {schemaFileReady} from '../ensure-capture-schema.js';
import {FRESH_CONFIG,freshEntriesEnabled} from '../../config/fresh-start.js';
import {FreshSharedFeed,FRESH_FEED_MAX_TARGETS} from './feed.js';
import {createFreshEventSource} from './event-source.js';
import {FreshProductionAdapter,type FreshReference} from './adapter.js';
import {FreshPaperStore} from './store.js';
import {FreshPositionMonitor} from './monitor.js';
import {freshContractUnits} from './contract-units.js';
import {ivRankFor} from '../fno-scanner.js';
import {FreshRuntime} from './runtime.js';
import {flowFiveMinuteBars,footprintsFor,flowBarStart,FLOW_BAR_MS} from '../order-flow-store.js';
import type {FreshContext} from '@fno/analytics';
import {logFreshDecisionSummary} from './decision-summary.js';
import {freshEventClearStocks,freshRankStocks,FRESH_MARKETS,freshMarketBlockers,freshBookSupportsLot,discoverFreshMarkets,freshDiscoveryWindow,freshReferenceOptions,freshExpiryDayOptions,freshGammaBookWindow,freshReferenceExchange,freshReferenceSpotId,freshEventMarket,freshMarketExchange,freshIndexKey,type FreshMarket} from './markets.js';
import {freshAdapterState as state} from './adapter-state.js';
import {observedFreshOi,freshParseScan,freshStockIntel,freshStocksInPlay,freshInPlayDirection,freshIndexIntel,FRESH_INDEX_HEAVYWEIGHTS,FRESH_SCAN_KEY,type FreshScan,type FreshFuturesSample} from './intel.js';
import {buildOptionChain} from '../option-chain.js';
import type {FreshOiSample} from '@fno/analytics';
import {FreshOperationalReporter} from './operational-evidence.js';
import {registerFreshResearchProtocol,freshResearchReadiness} from './research-inventory.js';
import {freshIstDay,freshBars,mergeFreshBars,buildFreshReferenceContext,fillFreshGaps} from './context.js';
import {auditFreshAdapter,auditFreshEvaluation,persistFreshCalendarSnapshot} from './audit.js';
/** One reference's candle history; every bar comes from `source` so volumes are comparable (5 Nov volume audit). */
type History={five:FreshBar[];one:FreshBar[];lastSeen:number;source:'DHAN'|'ANGEL';emptyFetches:number};
/** Angel One historical API time: "YYYY-MM-DD HH:mm" in IST (the format every other caller uses). */
/**
 * How long one set of option books stays subscribed before the window moves on. It was 30 s, which re-subscribed
 * ~18 option tokens a minute on the shared WebSocket (2 Nov audit); 2 minutes cuts that churn by 4x while every
 * selected reference still gets its books several times in each 30-minute selection.
 */
/** How often today's decisions are summarised to the log (decision-summary.ts). */
export const FRESH_DECISION_SUMMARY_MS=900_000;
export const FRESH_BOOK_ROTATION_MS=120_000;
/** Index option books stay subscribed all session (6 Nov: rotating 8 slices left most index setups without books). */
export const FRESH_PINNED_BOOK_MARKETS:ReadonlySet<string>=new Set(['NSE_INDEX_OPTIONS','BSE_VERIFIED_OPTIONS']);
/**
 * Token plan (7 Nov): this consumer may hold up to FRESH_FEED_MAX_TARGETS tokens, never more than the shared
 * connection's free headroom allows, with FRESH_TOKEN_SPARE kept free. Priority when the budget is short: held
 * positions, references, pinned index books, then rotating slices (urgent setups first, each market's minimum, the rest).
 */
export const FRESH_TOKEN_SPARE=10;
export const FRESH_MAX_ROTATING_BOOK_SLICES=8;
/** Each rotating market's minimum slices while it is open (6 Nov: MCX's six products shared one slice during NSE hours
 * and showed 0 observed books all day; after the NSE close they had 35). */
export const FRESH_ROTATION_MIN_SLICES:Readonly<Record<string,number>>=Object.freeze({NSE_STOCK_OPTIONS:1,MCX_VERIFIED_FUTURES_OPTIONS:2});
/** How long a reference with a fresh setup keeps its books ahead of the rotation. */
export const FRESH_URGENT_BOOK_MS=5*60_000;
/** The leading stocks in play whose option books go ahead of the rotation (2 leaders + 2 laggards, alternating). */
export const FRESH_IN_PLAY_BOOK_SLICES=4;
/** Index future / chain OI samples are kept this long (the strategy reads 30 min of futures and ~15 min of chain OI). */
export const FRESH_INDEX_SAMPLE_KEEP_MS=35*60_000;
/** Indices whose option books hold their two nearest tradable expiries (owner, 7 Nov); the others hold the nearest. */
export const FRESH_TWO_EXPIRY_INDICES:ReadonlySet<string>=new Set(['NIFTY','SENSEX']);
/** At most one watchdog reconnect in this window. */
export const FRESH_FEED_RECONNECT_GAP_MS=10*60_000;
/** The tokens this consumer may plan for: its cap, bounded by what the shared connection has free (950 limit). */
export function freshTokenCapacity(ownTokens:number,sharedTokens:number,sharedLimit=950):number{
  return Math.max(0,Math.min(FRESH_FEED_MAX_TARGETS,ownTokens+sharedLimit-sharedTokens)-FRESH_TOKEN_SPARE);
}
/** Rotating book references: urgent ones first, then each market's minimum from the rotation window, then the rest. */
export function freshRotatingBookRefs(refs:readonly FreshReference[],rotation:number,urgent:ReadonlySet<string>,slots:number):FreshReference[]{
  const others=refs.filter(r=>!FRESH_PINNED_BOOK_MARKETS.has(r.market)),out:FreshReference[]=[],add=(r:FreshReference|undefined)=>{if(r&&out.length<slots&&!out.includes(r))out.push(r);};
  for(const r of others)if(urgent.has(r.id))add(r);
  const window=freshDiscoveryWindow(others,rotation,20).selected;
  for(const market of FRESH_MARKETS){const minimum=FRESH_ROTATION_MIN_SLICES[market]??1,have=out.filter(r=>r.market===market).length;for(const r of window.filter(x=>x.market===market&&!out.includes(x)).slice(0,Math.max(0,minimum-have)))add(r);}
  for(const r of window)add(r);
  return out;
}
export function freshAngelTime(ms:number):string{
  const d=new Date(ms+19800000),pad=(n:number)=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/**
 * Five-minute history seeded per reference. It must hold at least FRESH_MIN_VOLUME_SESSIONS (15) earlier sessions:
 * every strategy needs relative volume (rvol: this bar's volume against the same slot on the last 15–20 sessions)
 * and the opening-pullback needs 15 opening-volume references. 2 Nov–3 Nov the seed was 12 calendar days (~8
 * sessions), so rvol was never available and no setup could ever qualify — zero candidates on two full days.
 * 35 calendar days ≈ 24 NSE sessions (≥ 20 after holidays); one Dhan/Angel call per reference per day.
 */
export const FRESH_HISTORY_SEED_DAYS = 35;
/** After a failed history fetch a reference waits this long before the next attempt (no hammering a rate limit). */
/** Consecutive empty candle answers from a reference's pinned feed before its history is dropped and reseeded. */
export const FRESH_PINNED_EMPTY_LIMIT=3;
/** A mini MCX contract the feed does not carry reads its parent product's order flow (marked proxy). */
/** The flow contract a reference without its own reads (marked proxy): the parent MCX product, or for BSE indices the
 * NSE index with the same heavyweights (7 Nov: the Dhan feed carries NSE F&O and MCX only, not BSE). */
export const FRESH_FLOW_PROXY:Readonly<Record<string,string>>=Object.freeze({CRUDEOILM:'CRUDEOIL',NATGASMINI:'NATURALGAS',SENSEX:'NIFTY',BANKEX:'BANKNIFTY'});
/** The benchmark whose intraday volume shape a reference with too little own volume history borrows (context.ts). */
export function freshVolumeBenchmarkName(ref:Pick<FreshReference,'name'|'market'>):string|null{
  const b=ref.market==='NSE_INDEX_OPTIONS'?'NIFTY':ref.market==='BSE_VERIFIED_OPTIONS'?'SENSEX':ref.market==='MCX_VERIFIED_FUTURES_OPTIONS'?({...FRESH_FLOW_PROXY,GOLDM:'GOLD',SILVERM:'SILVER'} as Record<string,string>)[ref.name]??null:null;
  return b&&b!==ref.name?b:null;
}
/** 1.8 shadow: today's five-minute inferred order flow for a reference, from the Dhan feed (undefined when not covered). */
/** The flow symbol a reference reads (its own, else its proxy), or null when the feed carries neither. */
export function freshFlowSymbol(name:string,from:number,to:number):string|null{
  for(const symbol of [name,FRESH_FLOW_PROXY[name]].filter((x):x is string=>!!x))if(flowFiveMinuteBars(symbol,from,to+1))return symbol;
  return null;
}
/** The last 15-minute footprint closed by `now` of a flow symbol, as relative reads (no price levels), or null. */
export async function freshFootprint15(symbol:string,now:number):Promise<FreshContext['footprint15']>{
  const barTime=flowBarStart(now)-FLOW_BAR_MS;
  try{
    const fp=(await footprintsFor(symbol,[barTime])).get(barTime);
    if(!fp||fp.deltaMode==='UNAVAILABLE'||!(fp.trades>0))return null;
    return {barTime,deltaPct:fp.deltaPct!=null&&Number.isFinite(fp.deltaPct)?fp.deltaPct:null,buyImbalances:fp.buyImbalances??0,sellImbalances:fp.sellImbalances??0,trades:fp.trades};
  }catch{return null;}
}
export function freshOrderFlowFor(name:string,from:number,to:number):FreshContext['orderFlow']{
  // The reference's own contract when the feed carries it, else the parent product's (marked proxy).
  for(const symbol of [name,FRESH_FLOW_PROXY[name]].filter((x):x is string=>!!x)){const f=flowFiveMinuteBars(symbol,from,to+1);if(f)return {source:'DHAN_INFERRED',instrument:f.instrument,proxy:symbol!==name,bars:f.bars};}
  return undefined;
}
export const FRESH_HISTORY_RETRY_MS = 60_000;
export const FRESH_MCX_DIAGNOSTIC_LOG_MS = 5 * 60_000;
export class FreshPaperWorker {
  /** First summary ~immediately after start, then every 15 minutes. */
  private summaryAt=0;
  /** MCX flow diagnostic (owner, 9 Nov): the latest flow numbers per commodity, logged every 5 minutes; decides nothing. */
  private mcxDiag=new Map<string,FreshMcxFlowDiagnostic&{at:number}>();private mcxDiagLoggedAt=0;
  private operationalReporter=new FreshOperationalReporter(evidence=>logger.info(evidence,'Fresh-start operational evidence; readiness and paper-only blockers observed'));
  private feed:FreshSharedFeed;private events=createFreshEventSource(persistFreshCalendarSnapshot);private store=new FreshPaperStore(undefined,()=>!this.stopped&&freshEntriesEnabled());private monitor:FreshPositionMonitor;private runtime:FreshRuntime;
  private refs=new Map<string,FreshReference>();private master:Instrument[]=[];private masterDay='';private histories=new Map<string,History>();private lagReadAt=0;private shortlist:SubscriptionTarget[]=[];
  private positions:Awaited<ReturnType<FreshPaperStore['recover']>>=[];private timers:ReturnType<typeof setInterval>[]=[];private removeObservation:(()=>void)|null=null;private scanning=false;private ready=false;private stopped=false;private lastScan=0;private discovery:ReturnType<typeof discoverFreshMarkets>|null=null;private selectionAt=0;private cursor=0;private selected:FreshReference[]=[];private selectionExchangeKey='';private historyCursor=0;private historyFailures=new Map<string,string>();private historyRetryAt=new Map<string,number>();private subscriptionReady=false;private urgentBooks=new Map<string,number>();private scanSnapshot:FreshScan|null=null;private oiChains=new Map<string,FreshOiSample[]>();private futSamples=new Map<string,FreshFuturesSample[]>();private indexSampleAt=0;private chainsBusy=false;private scanReadAt=0;private stocksAt=0;private inPlay:string[]=[];private readonly feedClientId=`fresh-start:production:${randomUUID()}`;private reconnectAt=0;
  constructor(private provider:MarketDataProvider,private subscriptions:SubscriptionManager){
    this.feed=new FreshSharedFeed(subscriptions,Date.now,this.feedClientId);this.monitor=new FreshPositionMonitor(this.feed,this.store);
    const adapter=new FreshProductionAdapter(this.feed,this.events,this.store,{references:()=>this.refs,master:()=>this.master,capital:FRESH_CONFIG.capital??0,legacyRisk:()=>this.legacyRisk(),audit:auditFreshEvaluation,refusal:auditFreshAdapter,ivRank:(name,expiry,ivPct)=>ivRankFor(name,expiry,ivPct),watch:async rows=>{this.positions=rows;this.monitor.watch(rows);await this.syncTargets();}});
    this.runtime=new FreshRuntime(this.store,adapter,()=>FRESH_CONFIG.activationApproved&&state.entriesArmed);
  }
  start(){
    state.entriesArmed=false;state.recovered=false;state.monitorRunning=false;state.scannerRunning=false;state.status='RECOVERING_POSITIONS';state.entryBlockers=['BLOCKED_POSITION_RECOVERY'];
    this.feed.start();this.removeObservation=this.feed.onObservation(()=>{if(this.ready)this.pollMonitor();});
    // Dhan engine v2 phase 4: DHAN_* setup signals are priced and entered through this worker's adapter and store.
    if(DHAN_ENGINE_PAPER)setDhanPaperHandler(r=>this.dhanPaper(r),symbol=>!this.refs.size||[...this.refs.values()].some(x=>x.name===symbol));
    // Registered synchronously so the service supervisor owns every timer, including during recovery.
    this.timers=[setInterval(()=>{if(this.ready)this.pollMonitor();},250),setInterval(()=>void this.scan(),1000)];
    return this.bootstrap();
  }
  private async bootstrap(){
    if(!schemaFileReady('047_fresh_start_paper.sql')||!schemaFileReady('048_fresh_start_adapter.sql')||!schemaFileReady('049_fresh_start_calendars.sql'))throw Error('BLOCKED_FRESH_SCHEMA');
    try{await this.runtime.recover();}catch(error){state.entriesArmed=false;state.status='BLOCKED_RECOVERY';state.entryBlockers=['BLOCKED_POSITION_RECOVERY'];this.operationalReporter.report(state);throw error;}if(this.stopped)return;
    this.ready=true;state.recovered=true;state.monitorRunning=true;state.scannerRunning=true;state.status='DISCOVERY_STARTING';
    // One public-calendar preflight after recovery; never await it or infer entry permission.
    // The source's in-flight/cadence guard coalesces a simultaneous open-session refresh.
    void this.events.refresh({macro:false,issuer:FRESH_CONFIG.markets.includes('NSE_STOCK_OPTIONS'),commodity:FRESH_CONFIG.markets.includes('MCX_VERIFIED_FUTURES_OPTIONS'),publicMacro:true}).then(()=>{
      if(this.stopped)return;state.eventSources=this.events.view();
      logger.info({event:'freshPublicCalendarPreflight',paperEventPolicy:FRESH_CONFIG.eventPolicy,freeGlobal:state.eventSources.freeGlobal,issuer:state.eventSources.issuer,commodity:state.eventSources.commodity,publicMacro:state.eventSources.publicMacro,officialMacro:state.eventSources.officialMacro},'Fresh-start public calendar preflight completed; paper event policy recorded');
    },()=>{if(!this.stopped)logger.warn({event:'freshPublicCalendarPreflightFailed'},'Fresh-start public calendar preflight failed; missing coverage remains explicitly labeled');});
    if(schemaFileReady('050_fresh_research.sql'))void registerFreshResearchProtocol().then(()=>freshResearchReadiness()).then(inventory=>{if(!this.stopped&&inventory)logger.info({event:'freshResearchInventory',research:inventory},'Fresh-start research preparation observed; no outcomes read');}).catch(()=>{if(!this.stopped)logger.warn({event:'freshResearchPreparationUnavailable'},'Fresh-start research metadata unavailable; trading and exits unchanged');});
    void this.scan();
  }
  private pollMonitor(){this.monitor.tick();const held=this.monitor.summary();state.heldPositions=held.open;state.oldestExitPendingAt=held.oldestExitPendingAt;state.marks=this.monitor.marks();if(!this.monitor.healthy){state.entriesArmed=false;if(!state.entryBlockers.includes('BLOCKED_EXIT_PERSISTENCE'))state.entryBlockers.push('BLOCKED_EXIT_PERSISTENCE');}}
  /** Stocks given priority by a DHAN_* signal (reference id -> until). */
  private dhanPriority=new Map<string,number>();
  /** Each prioritised stock replaces the last selected stock that is neither in play nor itself prioritised. */
  private withDhanPriority(selected:FreshReference[],now:number):FreshReference[]{
    for(const [id,until] of this.dhanPriority)if(until<=now)this.dhanPriority.delete(id);
    if(!this.dhanPriority.size)return selected;
    const out=[...selected];
    for(const id of this.dhanPriority.keys()){
      if(out.some(r=>r.id===id))continue;
      const ref=this.refs.get(id);if(!ref||ref.market!=='NSE_STOCK_OPTIONS')continue;
      let k=-1;for(let i=out.length-1;i>=0;i--){const r=out[i];if(r.market==='NSE_STOCK_OPTIONS'&&!this.inPlay.includes(r.id)&&!this.dhanPriority.has(r.id)){k=i;break;}}
      if(k>=0)out[k]=ref;
    }
    return out;
  }
  /** Dhan engine v2 phase 4: a DHAN_* SIGNAL on a futures contract -> a candidate on the matching paper reference. */
  private async dhanPaper(r:DhanPaperRequest|DhanGammaPaperRequest):Promise<{decision:string;candidateId:string|null}>{
    if(!this.ready||this.stopped)return {decision:'PAPER_WORKER_NOT_READY',candidateId:null};
    if(r.gamma){
      // Expiry gamma (8 Nov): the index option reference, a premium-defined exit (30% stop, 15:15 time exit).
      const ref=[...this.refs.values()].find(x=>x.name===r.symbol&&(x.market==='NSE_INDEX_OPTIONS'||x.market==='BSE_VERIFIED_OPTIONS'));
      if(!ref)return {decision:'DHAN_NO_PAPER_REFERENCE',candidateId:null};
      const signal=this.feed.underlying(ref.id),now=Date.now(),day=freshIstDay(now),session=getSessionWindow(freshReferenceExchange(ref),day);
      if(!signal)return {decision:'DHAN_REFERENCE_NOT_SUBSCRIBED',candidateId:null};
      if(!session)return {decision:'DHAN_NO_SESSION',candidateId:null};
      const built=dhanGammaCandidate({index:r.symbol,result:r.gamma,at:r.at,reference:{id:ref.id,sourceEpoch:this.feed.sourceEpoch,price:signal.price,at:signal.at},session:day,sessionClose:session.close,now});
      if(!built.ok)return {decision:built.code,candidateId:null};
      return {decision:await this.runtime.onExternalCandidate(built.candidate),candidateId:built.candidate.id};
    }
    const ref=[...this.refs.values()].find(x=>x.name===r.symbol&&(x.market==='NSE_INDEX_OPTIONS'||x.market==='NSE_STOCK_OPTIONS'||x.market==='BSE_VERIFIED_OPTIONS'||x.market==='MCX_VERIFIED_FUTURES_OPTIONS'));
    if(!ref)return {decision:'DHAN_NO_PAPER_REFERENCE',candidateId:null};
    // Its option books first in the next plans; a stock not subscribed takes a stock slot and is waited for (<= 30 s).
    this.urgentBooks.set(ref.id,Date.now()+FRESH_URGENT_BOOK_MS);
    if(!this.feed.underlying(ref.id)&&ref.market==='NSE_STOCK_OPTIONS'){
      this.dhanPriority.set(ref.id,Date.now()+5*60_000);
      for(let k=0;k<30&&!this.stopped&&!this.feed.underlying(ref.id);k++)await new Promise(res=>setTimeout(res,1000));
    }
    const signal=this.feed.underlying(ref.id),futures=flowLastTrade(r.symbol),now=Date.now(),day=freshIstDay(now),session=getSessionWindow(freshReferenceExchange(ref),day);
    if(!signal)return {decision:'DHAN_REFERENCE_NOT_SUBSCRIBED',candidateId:null};
    if(!futures)return {decision:'DHAN_PRICE_UNAVAILABLE',candidateId:null};
    if(!session)return {decision:'DHAN_NO_SESSION',candidateId:null};
    const built=dhanPaperCandidate({symbol:r.symbol,result:r.result,barTime:r.barTime,decidedAt:r.decidedAt,atr:r.atr,futures,reference:{id:ref.id,sourceEpoch:this.feed.sourceEpoch,price:signal.price,at:signal.at,kind:ref.signal.segment==='CM'?'SPOT':'FUTURES'},session:day,sessionClose:session.close,now});
    if(!built.ok)return {decision:built.code,candidateId:null};
    return {decision:await this.runtime.onExternalCandidate(built.candidate),candidateId:built.candidate.id};
  }
  stop(){setDhanPaperHandler(null);this.stopped=true;this.ready=false;for(const t of this.timers)clearInterval(t);this.removeObservation?.();this.feed.close();state.entriesArmed=false;state.monitorRunning=false;state.scannerRunning=false;}
  private async legacyRisk(){try{const [r]=await sql`SELECT count(*)::int AS n FROM signals WHERE signal_type='TRADE_SETUP' AND inputs->>'outcome' IS NULL AND coalesce(inputs->>'voided','')<>'true'`;if(r.n>0)return true;for(const key of await scanKeys('trade_setup:*')){const raw=await redis.get(key);if(!raw)continue;const value=JSON.parse(raw);if(!value||typeof value!=='object'||typeof value.available!=='boolean'||value.available)return true;}return false;}catch{return true;}}
  /** How many of these tokens no other client holds: releasing them frees shared headroom (a shared token does not). */
  private exclusiveOwn(targets:readonly SubscriptionTarget[]){return this.subscriptions.exclusiveCount(this.feedClientId,targets);}
  private async syncTargets(){
    const held:SubscriptionTarget[]=[];for(const p of this.positions)for(const id of [p.state.contract.id,p.state.candidate.instrument]){const m=/^(NSE_FO|NSE_CM|BSE_FO|BSE_CM|MCX_FO):(\d+)$/.exec(id);if(!m)throw Error('BLOCKED_HELD_CONTRACT_IDENTITY');held.push({exchange:m[1].startsWith('MCX')?'MCX':m[1].startsWith('BSE')?'BSE':'NSE',exchangeSegment:m[1] as SubscriptionTarget['exchangeSegment'],token:m[2]});}
    const unique=(a:SubscriptionTarget[])=>[...new Map(a.map(t=>[`${t.exchangeSegment}:${t.token}`,t])).values()];
    this.subscriptionReady=true;let wanted=unique([...held,...this.shortlist]);const key=(x:SubscriptionTarget)=>`${x.exchangeSegment}:${x.token}`,wantedKeys=new Set(wanted.map(key)),own=new Set(this.feed.subscribedTargets.map(key)),released=this.exclusiveOwn(this.feed.subscribedTargets.filter(x=>!wantedKeys.has(key(x)))),available=950-this.subscriptions.getStatus().subscriptionCount+released;
    if(wanted.length>FRESH_FEED_MAX_TARGETS||wanted.filter(x=>!own.has(`${x.exchangeSegment}:${x.token}`)).length>available){state.entriesArmed=false;this.subscriptionReady=false;state.entryBlockers.push('BLOCKED_SHARED_SUBSCRIPTION_HEADROOM');wanted=unique(held);}
    await this.feed.syncTargets(wanted,FRESH_FEED_MAX_TARGETS);
  }
  private async loadMaster(day:string){
    if(day===this.masterDay)return;const master=await this.provider.getInstrumentMaster();if(this.stopped)return;if(!master.length)throw Error('BLOCKED_INSTRUMENT_MASTER');
    this.discovery=discoverFreshMarkets(master,day);this.master=master;
    // Which option names have no exact pricing reference, and which index rows of that exchange look closest — so a
    // missing spot (e.g. SENSEX50) can be mapped from the master's own data instead of a guessed token.
    const pricing=this.discovery.unmapped.filter(u=>u.code==='BLOCKED_EXACT_PRICING_REFERENCE');
    logger.info({event:'freshDiscoveryUnmapped',unmapped:this.discovery.unmapped.slice(0,40),indexCandidates:pricing.map(u=>{const ex=freshMarketExchange(u.market),key=freshIndexKey(u.name);return {name:u.name,candidates:master.filter(x=>x.exchange===ex&&x.segment==='CM'&&x.instrumentType==='INDEX'&&(freshIndexKey(x.name).slice(0,3)===key.slice(0,3)||freshIndexKey(x.symbol).slice(0,3)===key.slice(0,3))).slice(0,15).map(x=>({token:x.token,name:x.name,symbol:x.symbol}))};})},'Fresh-start discovery: references without an exact mapping');this.refs=new Map(this.discovery.references.map(r=>[r.id,r]));this.masterDay=day;this.histories.clear();this.selectionAt=0;this.cursor=0;
  }

  /** Swaps the window's round-robin stocks for the same number of the most active F&O stocks (one quote call). */
  /** Feed watchdog (see FRESH_FEED_STALL_MS): ticks arrive but none is accepted, so ask for a new upstream connection. */
  private watchFeed(){
    if(!this.feed.stalled()||Date.now()-this.reconnectAt<FRESH_FEED_RECONNECT_GAP_MS)return;
    this.reconnectAt=Date.now();this.feed.resetStallClock();const tickLag=this.feed.tickLagStats();state.tickLag=tickLag;
    logger.warn({event:'freshFeedWatchdog',tickLag},'Fresh-start feed watchdog: ticks arriving but none accepted for 60 s; reconnecting the upstream feed');
    void this.subscriptions.refreshConnection().catch((error:unknown)=>logger.warn({event:'freshFeedWatchdogFailed',error:error instanceof Error?error.message:String(error)},'Fresh-start feed watchdog reconnect failed'));
  }
  /** Process memory and the worker's in-memory caches, every 15 minutes (5 Nov cost review: backend RSS 2-8 GB). */
  private logMemory(){
    try{
      const m=process.memoryUsage(),mb=(x:number)=>Math.round(x/1_048_576);let five=0,one=0;for(const h of this.histories.values()){five+=h.five.length;one+=h.one.length;}
      logger.info({event:'freshMemory',rssMb:mb(m.rss),heapUsedMb:mb(m.heapUsed),heapTotalMb:mb(m.heapTotal),externalMb:mb(m.external),arrayBuffersMb:mb(m.arrayBuffers),histories:{references:this.histories.size,fiveMinuteBars:five,oneMinuteBars:one},master:this.master.length,references:this.refs.size,feed:this.feed.sizes()},'Fresh-start memory');
    }catch{/* diagnostics only */}
  }
  private async activeStocks(selected:FreshReference[]):Promise<FreshReference[]>{
    const slots=selected.filter(r=>r.market==='NSE_STOCK_OPTIONS').length,stocks=this.discovery!.references.filter(r=>r.market==='NSE_STOCK_OPTIONS');
    if(!slots||!stocks.length)return selected;
    try{
      const quotes=await this.provider.getQuote(CM_SEGMENT.NSE,stocks.map(r=>r.signal.token),'FULL');
      // Rank only stocks the event rules let trade now. The most active stocks on a results day are the ones reporting
      // (5 Nov: 8 of 9 selected stocks refused BLOCKED_EVENT_DATA all day). If no stock is clear (an issuer source is
      // down), rank them all as before; the per-evaluation event check still applies either way.
      const now=Date.now(),day=freshIstDay(now),clear=freshEventClearStocks(stocks,r=>this.events.clearance(now,day,'STOCK',r.name)===null);
      const ranked=freshRankStocks(clear,new Map(quotes.map(q=>[q.token,q])));
      state.activeStocksEventBlocked=stocks.length-clear.length;
      if(!quotes.length)return selected;
      state.activeStocks=ranked.slice(0,slots).map(r=>r.name);
      return [...selected.filter(r=>r.market!=='NSE_STOCK_OPTIONS'),...ranked.slice(0,slots)];
    }catch{return selected;}
  }
  /** Samples each index's nearest-expiry option chain OI (shared chain cache with the bias engine); never throws. */
  private async refreshChains(refs:readonly FreshReference[]){
    if(this.chainsBusy)return;this.chainsBusy=true;
    try{
      for(const r of refs){
        if(this.stopped)return;
        try{
          const chain=await buildOptionChain(this.provider,r.name,freshReferenceExchange(r)),at=chain.timestamp;
          if(!Number.isFinite(at)||at>Date.now()||!chain.expiry)continue;
          const strikes=chain.strikes.map(x=>({strike:x.strike,callOi:observedFreshOi(x.call),putOi:observedFreshOi(x.put)})).filter(x=>Number.isFinite(x.strike)&&x.strike>0);
          if(strikes.length)this.oiChains.set(r.id,[...(this.oiChains.get(r.id)??[]).filter(x=>at-x.at<=FRESH_INDEX_SAMPLE_KEEP_MS),{at,expiry:chain.expiry,strikes}]);
          // Dhan engine v2 expiry-gamma module (shadow): its own day-long chain samples; never throws, never trades.
          if(strikes.length&&DHAN_ENGINE_SHADOW)void recordGammaChain(r.name,chain,at,Date.now(),null,this.histories.get(r.id));
        }catch(err){/* this index's OI stays as it was; the strategy refuses IDX_OI_UNAVAILABLE once it is stale */
          logger.info({event:'freshChainRefreshFailed',index:r.name,error:err instanceof Error?err.message:String(err)},'Fresh-start: option chain refresh failed for an index (OI stays as it was)');}
      }
    }finally{this.chainsBusy=false;}
  }
  /** The selection with its stock slots given to stocks in play first (see intel.ts), the rest unchanged. */
  private withStocksInPlay(selected:FreshReference[],now:number,day:string):FreshReference[]{
    const slots=selected.filter(r=>r.market==='NSE_STOCK_OPTIONS').length,stocks=this.discovery?.references.filter(r=>r.market==='NSE_STOCK_OPTIONS')??[];
    const inPlay=freshStocksInPlay(this.scanSnapshot,stocks,now,slots,new Set(this.inPlay),r=>this.events.clearance(now,day,'STOCK',r.name)===null);
    this.inPlay=inPlay.map(r=>r.id);
    state.stocksInPlay=inPlay.map(r=>{const x=freshStockIntel(this.scanSnapshot,r,now);return {name:r.name,direction:x?freshInPlayDirection(x):0,relativeStrength:x?.relativeStrength??null,oi:x?.oiInterpretation??null};});
    if(!inPlay.length)return selected;
    const rest=selected.filter(r=>r.market==='NSE_STOCK_OPTIONS'&&!inPlay.includes(r));
    return [...selected.filter(r=>r.market!=='NSE_STOCK_OPTIONS'),...inPlay,...rest].slice(0,selected.length);
  }
  private async context(ref:FreshReference,now:number,open:number){
    // Angel One's candle API takes "YYYY-MM-DD HH:mm" IST; ISO strings were rejected with HTTP 400 and the provider returned
    // [] silently, so no fresh-start strategy ever received bars (2 Nov audit).
    const old=this.histories.get(ref.id),params={exchange:freshReferenceExchange(ref),segment:ref.signal.segment,token:ref.signal.token,toDate:freshAngelTime(now)};
    // Every bar of a reference comes from ONE feed (Dhan when it serves the contract, else Angel One): relative volume
    // compares bars with each other, and two feeds' volume conventions must never mix inside one series.
    const fiveFrom=freshAngelTime(old?Math.max(open,old.lastSeen-300000):now-FRESH_HISTORY_SEED_DAYS*86400000);
    let source:'DHAN'|'ANGEL'=old?.source??'DHAN';
    let five=await this.provider.getHistoricalData({...params,interval:'FIVE_MINUTE',fromDate:fiveFrom,source});
    if(this.stopped)throw Error('WORKER_STOPPED');
    if(!old&&(!Array.isArray(five)||five.length===0)){source='ANGEL';five=await this.provider.getHistoricalData({...params,interval:'FIVE_MINUTE',fromDate:fiveFrom,source});if(this.stopped)throw Error('WORKER_STOPPED');}
    // The provider returns [] on a failed call; an empty seed is a failure, not an empty market.
    if(!old&&(!Array.isArray(five)||five.length===0))throw Error('REFERENCE_HISTORY_UNAVAILABLE');
    const one=await this.provider.getHistoricalData({...params,interval:'ONE_MINUTE',fromDate:freshAngelTime(open),source});
    if(this.stopped)throw Error('WORKER_STOPPED');
    // A pinned feed that keeps answering nothing is dropped after FRESH_PINNED_EMPTY_LIMIT calls: the next scan reseeds
    // the whole series (again Dhan first, else Angel One), so the switch never mixes feeds inside the history.
    const empty=(!Array.isArray(five)||five.length===0)&&(!Array.isArray(one)||one.length===0),emptyFetches=old&&empty?old.emptyFetches+1:0;
    if(old&&emptyFetches>=FRESH_PINNED_EMPTY_LIMIT){this.histories.delete(ref.id);throw Error('REFERENCE_HISTORY_UNAVAILABLE');}
    const receivedAt=Date.now(),bars5=mergeFreshBars(old?.five??[],freshBars(five,5,receivedAt),4000),bars1=mergeFreshBars(old?.one??[],freshBars(one,1,receivedAt),1440),lastSeen=bars5.at(-1)?.time??0;
    this.histories.delete(ref.id);this.histories.set(ref.id,{five:bars5,one:bars1,lastSeen,source,emptyFetches});
    while(this.histories.size>40)this.histories.delete(this.histories.keys().next().value!);
    const signalLive=!!this.feed.underlying(ref.id),spotLive=!!this.feed.underlying(freshReferenceSpotId(ref));
    const benchName=freshVolumeBenchmarkName(ref),benchRef=benchName?this.selected.find(r=>r.name===benchName&&r.market===ref.market):undefined,volumeBenchmark=benchRef?this.histories.get(benchRef.id)?.five:undefined;
    const ex=freshReferenceExchange(ref),c=buildFreshReferenceContext({now:receivedAt,exchange:ex,instrument:ref.id,sourceEpoch:this.feed.sourceEpoch,bars5:fillFreshGaps(bars5,300000,ex),bars1:fillFreshGaps(bars1,60000,ex),eventClear:this.events.clearance(receivedAt,freshIstDay(receivedAt),freshEventMarket(ref.market),ref.name)===null,referenceVerified:signalLive&&spotLive,...(volumeBenchmark?{volumeBenchmark:fillFreshGaps(volumeBenchmark,300000,ex)}:{}),referenceDetail:signalLive&&spotLive?undefined:!signalLive&&!spotLive?'SIGNAL_AND_SPOT_STALE':!signalLive?'SIGNAL_STALE':'SPOT_STALE',recentReleases:this.events.releases(receivedAt,freshEventMarket(ref.market),ref.name),orderFlow:freshOrderFlowFor(ref.name,open,receivedAt)});
    if(c)c.eventEvidence=this.events.evidence(receivedAt,freshEventMarket(ref.market),ref.name);
    // 2.0: the stock's universe-scan inputs as of this evaluation (null when no scan row is fresh enough).
    if(c&&ref.market==='NSE_STOCK_OPTIONS')c.stockIntel=freshStockIntel(this.scanSnapshot,ref,receivedAt);
    if(c&&ref.market==='MCX_VERIFIED_FUTURES_OPTIONS'){c.commodity=true;const flowSymbol=freshFlowSymbol(ref.name,open,receivedAt);c.footprint15=flowSymbol?await freshFootprint15(flowSymbol,receivedAt):null;try{this.mcxDiag.set(ref.name,{at:receivedAt,...freshMcxFlowDiagnostic(c)});}catch{/* diagnostic only */}}
    if(c&&FRESH_PINNED_BOOK_MARKETS.has(ref.market))c.indexIntel=freshIndexIntel(ref.name,this.scanSnapshot,this.futSamples.get(ref.id)??[],this.oiChains.get(ref.id)??[],receivedAt);
    return {context:c,newClose:!!old&&lastSeen>old.lastSeen,lastSeen};
  }
  private logMcxDiagnostic(now:number){
    if(now-this.mcxDiagLoggedAt<FRESH_MCX_DIAGNOSTIC_LOG_MS)return;
    for(const [k,v] of this.mcxDiag)if(now-v.at>15*60000)this.mcxDiag.delete(k);
    if(!this.mcxDiag.size)return;
    this.mcxDiagLoggedAt=now;
    logger.info({event:'freshMcxFlowDiagnostic',thresholds:{setupDeltaPct:15,barDeltaOpposesPct:-15,classifiedSharePct:50,coveragePct:15,trades:15},contracts:Object.fromEntries([...this.mcxDiag].map(([k,v])=>[k,{...v,at:new Date(v.at).toISOString()}]))},'MCX flow diagnostic: the numbers behind NEW_MCX_FLOW_V1 flow checks (log only, decides nothing)');
  }
  /** The armed state is decided once per scan (no transient disarm at its start: entries that arrive between the
   *  fresh worker's own steps — Dhan engine candidates, a pricing that finishes mid-scan — must not read a false
   *  PAPER_DISABLED). Every path that ends a scan early disarms explicitly (closed market, stop, errors). */
  private async scan(){
    if(!this.ready||this.stopped||this.scanning||Date.now()-this.lastScan<10000)return;this.scanning=true;this.lastScan=Date.now();state.lastCheckAt=this.lastScan;state.entryBlockers=[];
    try{
      const now=Date.now(),day=freshIstDay(now),sessions=new Map<Exchange,ReturnType<typeof getSessionWindow>>((['NSE','BSE','MCX'] as Exchange[]).map(e=>[e,getSessionWindow(e,day)]));
      if(!HOLIDAY_CALENDAR_YEARS.includes(Number(day.slice(0,4))))throw Error('BLOCKED_CALENDAR_YEAR');
      const openExchanges=new Set([...sessions].filter(([,s])=>s&&now>=s.open&&now<s.close).map(([e])=>e));
      state.eventCode=this.events.clearance(Date.now(),day,'INDEX')??(this.events.evidence(Date.now(),'INDEX').coverage.evidenceClass==='EVENT_DATA_UNVERIFIED'?'PAPER_EVENT_DATA_UNVERIFIED':'CLEAR');
      if(!openExchanges.size){state.entriesArmed=false;state.status='WAITING_FOR_MARKET';state.observedExecutableBooks=0;state.optionContracts=0;state.entryBlockers=['OUTSIDE_VERIFIED_SESSION'];for(const m of state.marketReadiness){m.sessionOpen=false;m.eligibleReferences=0;m.observedExecutableBooks=0;m.blockers=['OUTSIDE_VERIFIED_SESSION',...freshMarketBlockers(m.market)];m.blockers.push(...this.events.blockers(now,day,freshEventMarket(m.market)));state.eventSources=this.events.view();}this.shortlist=[];await this.syncTargets();return;}
      if(!this.provider.isAuthenticated())throw Error('BLOCKED_BROKER_AUTH');
      await this.loadMaster(day);if(this.stopped)return;void this.events.refresh({macro:openExchanges.has('NSE')||openExchanges.has('BSE'),issuer:openExchanges.has('NSE')&&this.discovery!.counts.NSE_STOCK_OPTIONS>0,commodity:openExchanges.has('MCX')&&this.discovery!.counts.MCX_VERIFIED_FUTURES_OPTIONS>0}).then(()=>{if(!this.stopped)state.eventSources=this.events.view();},()=>{if(!this.stopped){state.entriesArmed=false;state.eventCode='BLOCKED_EVENT_REFRESH';state.entryBlockers=[...new Set([...state.entryBlockers,'BLOCKED_EVENT_REFRESH'])];}});state.eventSources=this.events.view();
      const exchangeKey=[...openExchanges].sort().join(',');
      if(!this.selectionAt||now-this.selectionAt>=1800000||exchangeKey!==this.selectionExchangeKey){const window=freshDiscoveryWindow(this.discovery!.references.filter(r=>openExchanges.has(freshReferenceExchange(r))),this.cursor);this.selected=openExchanges.has('NSE')?await this.activeStocks(window.selected):window.selected;this.cursor=window.nextCursor;this.selectionAt=now;this.stocksAt=0;this.selectionExchangeKey=exchangeKey;}
      // 2.0 stocks in play: every 5 minutes the stock slots go to the stocks leading / lagging NIFTY with aligned OI
      // (intel.ts); slots it cannot fill keep the activity ranking. A missing or stale scan keeps the current selection.
      if(now-this.scanReadAt>=60_000){this.scanReadAt=now;this.scanSnapshot=freshParseScan(await Promise.resolve().then(()=>redis.get(FRESH_SCAN_KEY)).catch(()=>null))??this.scanSnapshot;}
      if(openExchanges.has('NSE')&&now-this.stocksAt>=300_000){this.stocksAt=now;this.selected=this.withStocksInPlay(this.selected,now,day);}
      // Dhan engine (8 Nov): a stock with a fresh DHAN_* signal takes a stock slot for a few minutes, so it is priced.
      this.selected=this.withDhanPriority(this.selected,now);
      const refs=this.selected.filter(r=>openExchanges.has(freshReferenceExchange(r)));
      for(const r of refs)this.feed.pairReference(r.id,freshReferenceSpotId(r));
      // Option books (6 Nov): index option books (NSE + BSE, nearest tradable expiry) stay subscribed all session;
      // stocks and MCX share the remaining slots in a 2-minute rotation, a reference with a fresh setup first.
      for(const [id,until] of this.urgentBooks)if(until<=now)this.urgentBooks.delete(id);
      let slices:{ref:FreshReference;options:Instrument[]}[]=[];
      const planBooks=async()=>{
        const optionsFor=(ref:FreshReference,expiryLimit:number)=>freshReferenceOptions(this.master,ref,day,this.feed.underlying(freshReferenceSpotId(ref))?.price??null,expiryLimit);
        const refTokens=new Set(refs.flatMap(r=>[r.id,freshReferenceSpotId(r)])).size,heldTokens=new Set(this.positions.flatMap(p=>[p.state.contract.id,p.state.candidate.instrument])).size;
        const capacity=freshTokenCapacity(this.exclusiveOwn(this.feed.subscribedTargets),this.subscriptions.getStatus().subscriptionCount);
        let free=capacity-refTokens-heldTokens;const pinned:typeof slices=[];
        for(const ref of refs.filter(r=>FRESH_PINNED_BOOK_MARKETS.has(r.market))){const options=optionsFor(ref,FRESH_TWO_EXPIRY_INDICES.has(ref.name)?2:1);if(options.length<=free){pinned.push({ref,options});free-=options.length;}}
        // Expiry gamma (8 Nov): on an index's expiry day, 13:10-15:20 IST, its expiry-day contracts too (the module trades them).
        if(DHAN_ENGINE_PAPER&&freshGammaBookWindow(now))for(const slice of pinned){if(!FRESH_TWO_EXPIRY_INDICES.has(slice.ref.name))continue;const extra=freshExpiryDayOptions(this.master,slice.ref,day,this.feed.underlying(freshReferenceSpotId(slice.ref))?.price??null).filter(x=>!slice.options.some(o=>o.token===x.token));if(extra.length&&extra.length<=free){slice.options=[...slice.options,...extra];free-=extra.length;}}
        const slots=Math.max(0,Math.min(FRESH_MAX_ROTATING_BOOK_SLICES,Math.floor(free/20)));
        slices=[...pinned,...freshRotatingBookRefs(refs,Math.floor(now/FRESH_BOOK_ROTATION_MS),new Set([...this.urgentBooks.keys(),...this.inPlay.slice(0,FRESH_IN_PLAY_BOOK_SLICES)]),slots).map(ref=>({ref,options:optionsFor(ref,2)}))];
        state.bookPlan={capacity,refTokens,heldTokens,slots,tokens:refTokens+heldTokens+slices.reduce((n,x)=>n+x.options.length,0),slices:slices.map(x=>({name:x.ref.name,market:x.ref.market,options:x.options.length,pinned:FRESH_PINNED_BOOK_MARKETS.has(x.ref.market)}))};
        // MCX depth unit inference needs each MCX book's verified lot (feed.ts registerMcxDepth).
        for(const {ref,options} of slices)if(ref.market==='MCX_VERIFIED_FUTURES_OPTIONS')for(const x of options){const u=freshContractUnits(x);if(u)this.feed.registerMcxDepth(`${FO_SEGMENT.MCX}:${x.token}`,ref.name,u.lotQuantity);}
        state.mcxDepthUnits=this.feed.mcxDepthModes();
        this.shortlist=[...refs.flatMap(r=>[{token:r.signal.token,exchange:freshReferenceExchange(r),exchangeSegment:r.signal.segment==='FO'?FO_SEGMENT[freshReferenceExchange(r)]:r.spot.exchangeSegment},{token:r.spot.token,exchange:freshReferenceExchange(r),exchangeSegment:r.spot.exchangeSegment}]),...slices.flatMap(({ref,options})=>options.map(x=>({token:x.token,exchange:freshReferenceExchange(ref),exchangeSegment:FO_SEGMENT[freshReferenceExchange(ref)]})))];
        await this.syncTargets();
      };
      this.positions=await this.store.recover();this.monitor.watch(this.positions);await planBooks();
      this.watchFeed();
      // 2.0 index intel: every minute, each index future's price / OI, and (in the background) its option chain's OI.
      if(now-this.indexSampleAt>=60_000){this.indexSampleAt=now;const indexRefs=refs.filter(r=>FRESH_PINNED_BOOK_MARKETS.has(r.market));
        for(const r of indexRefs){const oi=this.feed.openInterest(r.id),px=this.feed.underlying(r.id);if(oi&&px)this.futSamples.set(r.id,[...(this.futSamples.get(r.id)??[]).filter(x=>now-x.at<=FRESH_INDEX_SAMPLE_KEEP_MS),{at:oi.at,price:px.price,oi:oi.oi}]);}
        // Chain OI only for indices with a breadth table: the others refuse on breadth first, so their chains would be
        // provider calls (rate-limited) that nothing reads.
        void this.refreshChains(indexRefs.filter(r=>FRESH_INDEX_HEAVYWEIGHTS[r.name]!=null));}
      if(now-this.lagReadAt>=60000){state.tickLag=this.feed.tickLagStats();this.lagReadAt=now;}
      state.referenceContracts=refs.length;state.optionContracts=slices.reduce((n,s)=>n+s.options.length,0);state.sourceEpoch=this.feed.sourceEpoch;
      const legacyOpen=await this.legacyRisk(),monitorHealthy=this.monitor.healthy;
      const blockersFor=(ref:FreshReference)=>{
        const codes=[...(ref.capabilityBlockers??[])];const historyFailure=this.historyFailures.get(ref.id);if(historyFailure)codes.push(historyFailure);codes.push(...this.events.blockers(Date.now(),day,freshEventMarket(ref.market),ref.name));
        if(!this.feed.underlying(ref.id)||!this.feed.underlying(freshReferenceSpotId(ref)))codes.push('WAITING_FOR_EXACT_REFERENCES');
        const slice=slices.find(s=>s.ref.id===ref.id),books=(slice?.options??[]).filter(x=>{const q=this.feed.quote(`${FO_SEGMENT[freshReferenceExchange(ref)]}:${x.token}`,x.tickSize);return freshBookSupportsLot(x,q);}).length;
        if(!books)codes.push('WAITING_FOR_OBSERVED_BOOKS');if(legacyOpen)codes.push('LEGACY_POSITION_OR_INVENTORY_UNAVAILABLE');if(!monitorHealthy)codes.push('BLOCKED_EXIT_PERSISTENCE');if(!this.subscriptionReady)codes.push('BLOCKED_SHARED_SUBSCRIPTION_HEADROOM');return [...new Set(codes)];
      };
      for(const m of state.marketReadiness){const marketRefs=refs.filter(r=>r.market===m.market),exchange=m.market.startsWith('MCX')?'MCX':m.market.startsWith('BSE')?'BSE':'NSE';m.universe=this.discovery!.counts[m.market];m.selected=marketRefs.length;m.references=marketRefs.filter(r=>this.feed.underlying(r.id)).length;m.optionContracts=slices.filter(s=>s.ref.market===m.market).reduce((n,s)=>n+s.options.length,0);m.observedExecutableBooks=slices.filter(s=>s.ref.market===m.market).flatMap(s=>s.options).filter(x=>{const q=this.feed.quote(`${FO_SEGMENT[exchange]}:${x.token}`,x.tickSize);return freshBookSupportsLot(x,q);}).length;m.sessionOpen=openExchanges.has(exchange);m.eligibleReferences=marketRefs.filter(r=>blockersFor(r).length===0).length;m.blockers=m.sessionOpen?[...new Set(marketRefs.flatMap(blockersFor))]:['OUTSIDE_VERIFIED_SESSION'];if(m.sessionOpen)m.blockers=[...new Set([...m.blockers,...this.discovery!.unmapped.filter(x=>x.market===m.market).map(x=>x.code)])];if(!marketRefs.length&&m.sessionOpen)m.blockers.push(m.universe?'WAITING_FOR_DISCOVERY_WINDOW':'NO_VERIFIED_MASTER_REFERENCE');}
      state.observedExecutableBooks=state.marketReadiness.reduce((n,m)=>n+m.observedExecutableBooks,0);
      state.entryBlockers=[...new Set(state.marketReadiness.flatMap(m=>m.blockers))];state.entriesArmed=state.marketReadiness.some(m=>m.eligibleReferences>0);
      // Per-reference blockers, so a market-wide code (e.g. one product's units) never hides which instrument is stuck.
      state.referenceBlockers=refs.slice(0,40).map(r=>({id:r.id,name:r.name,market:r.market,codes:blockersFor(r),signalAgeMs:this.feed.tickAge(r.id),spotAgeMs:this.feed.tickAge(freshReferenceSpotId(r))}));
      state.discovery={...state.discovery,at:now,totalReferences:this.refs.size,unmapped:this.discovery!.unmapped.length,selected:refs.length,historyCache:this.histories.size};
      let historyRequests=0;
      const start=refs.length?this.historyCursor%refs.length:0,historyRefs=[...refs.slice(start),...refs.slice(0,start)];
      for(const ref of historyRefs){
        const session=sessions.get(freshReferenceExchange(ref))!;if(!session)continue;
        const expected=session.open+(Math.floor((Date.now()-session.open)/300000)-1)*300000;if(expected<session.open)continue;
        if((this.histories.get(ref.id)?.lastSeen??0)>=expected)continue;
        if((this.historyRetryAt.get(ref.id)??0)>Date.now())continue;
        if(historyRequests>=4)break;historyRequests++;this.historyCursor=(refs.findIndex(r=>r.id===ref.id)+1)%refs.length;
        let h:Awaited<ReturnType<FreshPaperWorker['context']>>;try{h=await this.context(ref,Date.now(),session.open);this.historyFailures.delete(ref.id);this.historyRetryAt.delete(ref.id);}catch{if(this.stopped)return;this.historyFailures.set(ref.id,'REFERENCE_HISTORY_UNAVAILABLE');this.historyRetryAt.set(ref.id,Date.now()+FRESH_HISTORY_RETRY_MS);while(this.historyRetryAt.size>80)this.historyRetryAt.delete(this.historyRetryAt.keys().next().value!);while(this.historyFailures.size>40)this.historyFailures.delete(this.historyFailures.keys().next().value!);state.lastDecision='REFERENCE_HISTORY_UNAVAILABLE';continue;}if(!h.context)continue;
        if(!h.newClose){await auditFreshEvaluation(h.context,evaluateFreshStrategies(h.context));state.lastDecision='HISTORY_SEED_NO_RETROACTIVE_ENTRY';continue;}
        const currentExpected=session.open+(Math.floor((Date.now()-session.open)/300000)-1)*300000;
        if(h.lastSeen!==currentExpected){state.lastDecision='MISSING_CURRENT_CLOSED_BAR';continue;}
        state.barCallbacks++;let blockers=blockersFor(ref),urgent=false;
        // A setup on a reference whose books are not subscribed right now (stocks / MCX rotate): subscribe them at once
        // and let the candidate's entry window (FRESH_ENTRY_WINDOW_MS) wait for the first books, instead of losing it.
        if(blockers.length===1&&blockers[0]==='WAITING_FOR_OBSERVED_BOOKS'&&evaluateFreshStrategies(h.context).candidates.some(c=>!FRESH_SHADOW_STRATEGIES.has(c.strategy))){
          this.urgentBooks.set(ref.id,Date.now()+FRESH_URGENT_BOOK_MS);await planBooks();urgent=true;
          blockers=blockersFor(ref).filter(code=>code!=='WAITING_FOR_OBSERVED_BOOKS');
          logger.info({event:'freshUrgentBooks',instrument:ref.id,name:ref.name,market:ref.market,subscribed:slices.some(x=>x.ref.id===ref.id),blockers},'Fresh-start: setup without observed books; its option books subscribed for the entry window');
        }
        if((state.entriesArmed||urgent)&&blockers.length===0){
          // A queue deadline (evaluation started > 2 s after the context) must not read as an adapter failure.
          // Not awaited (7 Nov): pricing waits up to the entry window (20 s) for books and must not stall the scan; the
          // runtime's queues bound the concurrency, and a failure is recorded, never thrown into the scan.
          const context=h.context;void this.runtime.onClosedReference(context).then(decision=>{state.lastDecision=decision;},async(error:unknown)=>{state.lastDecision=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'EVALUATION_FAILED';await auditFreshEvaluation(context,evaluateFreshStrategies(context)).catch(()=>undefined);});
        }else{await auditFreshEvaluation(h.context,evaluateFreshStrategies(h.context));state.lastDecision=blockers[0]??'BLOCKED_REQUIRED_CAPABILITY';}
      }
      state.discovery.historyCache=this.histories.size;state.status=state.entriesArmed?'FORWARD_PAPER_RUNNING':'PAPER_ARMED_DATA_BLOCKED';state.error=null;
    }catch(error){if(this.stopped)return;state.entriesArmed=false;state.status='BLOCKED_ADAPTER';state.error=error instanceof Error&&/^BLOCKED_[A-Z_]+$/.test(error.message)?error.message:'ADAPTER_INPUT_OR_STORAGE_UNAVAILABLE';state.entryBlockers=[state.error];for(const m of state.marketReadiness){m.eligibleReferences=0;m.blockers=[...new Set([...m.blockers,state.error])];}}finally{this.scanning=false;if(!this.stopped){this.operationalReporter.report(state);const t=Date.now();if(t-this.summaryAt>=FRESH_DECISION_SUMMARY_MS){this.summaryAt=t;void logFreshDecisionSummary(t);this.logMemory();}this.logMcxDiagnostic(t);}}
  }
}
