import {randomUUID} from 'node:crypto';
import {logger} from '../../lib/logger.js';
import {getSessionWindow,HOLIDAY_CALENDAR_YEARS,FO_SEGMENT,type Exchange,type Instrument} from '@fno/shared';
import {evaluateFreshStrategies,type FreshBar} from '@fno/analytics';
import type {MarketDataProvider} from '../../providers/interface.js';
import type {SubscriptionManager,SubscriptionTarget} from '../../lib/subscription-manager.js';
import {sql} from '../../lib/db.js';
import {redis,scanKeys} from '../../lib/redis.js';
import {schemaFileReady} from '../ensure-capture-schema.js';
import {FRESH_CONFIG,freshEntriesEnabled} from '../../config/fresh-start.js';
import {FreshSharedFeed} from './feed.js';
import {createFreshEventSource} from './event-source.js';
import {FreshProductionAdapter,type FreshReference} from './adapter.js';
import {FreshPaperStore} from './store.js';
import {FreshPositionMonitor} from './monitor.js';
import {freshContractUnits} from './contract-units.js';
import {ivRankFor} from '../fno-scanner.js';
import {FreshRuntime} from './runtime.js';
import {logFreshDecisionSummary} from './decision-summary.js';
import {FRESH_MARKETS,freshMarketBlockers,freshBookSupportsLot,discoverFreshMarkets,freshDiscoveryWindow,freshReferenceOptions,freshReferenceExchange,freshReferenceSpotId,freshEventMarket,freshMarketExchange,freshIndexKey,type FreshMarket} from './markets.js';
import {freshAdapterState as state} from './adapter-state.js';
import {FreshOperationalReporter} from './operational-evidence.js';
import {registerFreshResearchProtocol,freshResearchReadiness} from './research-inventory.js';
import {freshIstDay,freshBars,mergeFreshBars,buildFreshReferenceContext,fillFreshGaps} from './context.js';
import {auditFreshAdapter,auditFreshEvaluation,persistFreshCalendarSnapshot} from './audit.js';
type History={five:FreshBar[];one:FreshBar[];lastSeen:number};
/** Angel One historical API time: "YYYY-MM-DD HH:mm" in IST (the format every other caller uses). */
/**
 * How long one set of option books stays subscribed before the window moves on. It was 30 s, which re-subscribed
 * ~18 option tokens a minute on the shared WebSocket (2 Nov audit); 2 minutes cuts that churn by 4x while every
 * selected reference still gets its books several times in each 30-minute selection.
 */
/** How often today's decisions are summarised to the log (decision-summary.ts). */
export const FRESH_DECISION_SUMMARY_MS=900_000;
export const FRESH_BOOK_ROTATION_MS=120_000;
export function freshAngelTime(ms:number):string{
  const d=new Date(ms+19800000),pad=(n:number)=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/**
 * Five-minute history seeded per reference: 12 calendar days (~8 sessions) covers the strategies' warm-up (100
 * five-minute and 75 fifteen-minute bars) with margin; 45 days fetched ~3,400 bars per reference per seed.
 */
export const FRESH_HISTORY_SEED_DAYS = 12;
/** After a failed history fetch a reference waits this long before the next attempt (no hammering a rate limit). */
export const FRESH_HISTORY_RETRY_MS = 60_000;
export class FreshPaperWorker {
  /** First summary ~immediately after start, then every 15 minutes. */
  private summaryAt=0;
  private operationalReporter=new FreshOperationalReporter(evidence=>logger.info(evidence,'Fresh-start operational evidence; readiness and paper-only blockers observed'));
  private feed:FreshSharedFeed;private events=createFreshEventSource(persistFreshCalendarSnapshot);private store=new FreshPaperStore(undefined,()=>!this.stopped&&freshEntriesEnabled());private monitor:FreshPositionMonitor;private runtime:FreshRuntime;
  private refs=new Map<string,FreshReference>();private master:Instrument[]=[];private masterDay='';private histories=new Map<string,History>();private shortlist:SubscriptionTarget[]=[];
  private positions:Awaited<ReturnType<FreshPaperStore['recover']>>=[];private timers:ReturnType<typeof setInterval>[]=[];private removeObservation:(()=>void)|null=null;private scanning=false;private ready=false;private stopped=false;private lastScan=0;private discovery:ReturnType<typeof discoverFreshMarkets>|null=null;private selectionAt=0;private cursor=0;private selected:FreshReference[]=[];private selectionExchangeKey='';private historyCursor=0;private historyFailures=new Map<string,string>();private historyRetryAt=new Map<string,number>();private subscriptionReady=false;
  constructor(private provider:MarketDataProvider,private subscriptions:SubscriptionManager){
    this.feed=new FreshSharedFeed(subscriptions,Date.now,`fresh-start:production:${randomUUID()}`);this.monitor=new FreshPositionMonitor(this.feed,this.store);
    const adapter=new FreshProductionAdapter(this.feed,this.events,this.store,{references:()=>this.refs,master:()=>this.master,capital:FRESH_CONFIG.capital??0,legacyRisk:()=>this.legacyRisk(),audit:auditFreshEvaluation,refusal:auditFreshAdapter,ivRank:(name,expiry,ivPct)=>ivRankFor(name,expiry,ivPct),watch:async rows=>{this.positions=rows;this.monitor.watch(rows);await this.syncTargets();}});
    this.runtime=new FreshRuntime(this.store,adapter,()=>FRESH_CONFIG.activationApproved&&state.entriesArmed);
  }
  start(){
    state.entriesArmed=false;state.recovered=false;state.monitorRunning=false;state.scannerRunning=false;state.status='RECOVERING_POSITIONS';state.entryBlockers=['BLOCKED_POSITION_RECOVERY'];
    this.feed.start();this.removeObservation=this.feed.onObservation(()=>{if(this.ready)this.pollMonitor();});
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
  stop(){this.stopped=true;this.ready=false;for(const t of this.timers)clearInterval(t);this.removeObservation?.();this.feed.close();state.entriesArmed=false;state.monitorRunning=false;state.scannerRunning=false;}
  private async legacyRisk(){try{const [r]=await sql`SELECT count(*)::int AS n FROM signals WHERE signal_type='TRADE_SETUP' AND inputs->>'outcome' IS NULL AND coalesce(inputs->>'voided','')<>'true'`;if(r.n>0)return true;for(const key of await scanKeys('trade_setup:*')){const raw=await redis.get(key);if(!raw)continue;const value=JSON.parse(raw);if(!value||typeof value!=='object'||typeof value.available!=='boolean'||value.available)return true;}return false;}catch{return true;}}
  private async syncTargets(){
    const held:SubscriptionTarget[]=[];for(const p of this.positions)for(const id of [p.state.contract.id,p.state.candidate.instrument]){const m=/^(NSE_FO|NSE_CM|BSE_FO|BSE_CM|MCX_FO):(\d+)$/.exec(id);if(!m)throw Error('BLOCKED_HELD_CONTRACT_IDENTITY');held.push({exchange:m[1].startsWith('MCX')?'MCX':m[1].startsWith('BSE')?'BSE':'NSE',exchangeSegment:m[1] as SubscriptionTarget['exchangeSegment'],token:m[2]});}
    const unique=(a:SubscriptionTarget[])=>[...new Map(a.map(t=>[`${t.exchangeSegment}:${t.token}`,t])).values()];
    this.subscriptionReady=true;let wanted=unique([...held,...this.shortlist]);const own=new Set(this.feed.subscribedTargets.map(x=>`${x.exchangeSegment}:${x.token}`)),available=950-this.subscriptions.getStatus().subscriptionCount;
    if(wanted.length>250||wanted.filter(x=>!own.has(`${x.exchangeSegment}:${x.token}`)).length>available){state.entriesArmed=false;this.subscriptionReady=false;state.entryBlockers.push('BLOCKED_SHARED_SUBSCRIPTION_HEADROOM');wanted=unique(held);}
    await this.feed.syncTargets(wanted,250);
  }
  private async loadMaster(day:string){
    if(day===this.masterDay)return;const master=await this.provider.getInstrumentMaster();if(this.stopped)return;if(!master.length)throw Error('BLOCKED_INSTRUMENT_MASTER');
    this.discovery=discoverFreshMarkets(master,day);this.master=master;
    // Which option names have no exact pricing reference, and which index rows of that exchange look closest — so a
    // missing spot (e.g. SENSEX50) can be mapped from the master's own data instead of a guessed token.
    const pricing=this.discovery.unmapped.filter(u=>u.code==='BLOCKED_EXACT_PRICING_REFERENCE');
    logger.info({event:'freshDiscoveryUnmapped',unmapped:this.discovery.unmapped.slice(0,40),indexCandidates:pricing.map(u=>{const ex=freshMarketExchange(u.market),key=freshIndexKey(u.name);return {name:u.name,candidates:master.filter(x=>x.exchange===ex&&x.segment==='CM'&&x.instrumentType==='INDEX'&&(freshIndexKey(x.name).slice(0,3)===key.slice(0,3)||freshIndexKey(x.symbol).slice(0,3)===key.slice(0,3))).slice(0,15).map(x=>({token:x.token,name:x.name,symbol:x.symbol}))};})},'Fresh-start discovery: references without an exact mapping');this.refs=new Map(this.discovery.references.map(r=>[r.id,r]));this.masterDay=day;this.histories.clear();this.selectionAt=0;this.cursor=0;
  }

  private async context(ref:FreshReference,now:number,open:number){
    // Angel One's candle API takes "YYYY-MM-DD HH:mm" IST; ISO strings were rejected with HTTP 400 and the provider returned
    // [] silently, so no fresh-start strategy ever received bars (2 Nov audit).
    const old=this.histories.get(ref.id),params={exchange:freshReferenceExchange(ref),segment:ref.signal.segment,token:ref.signal.token,toDate:freshAngelTime(now)};
    const one=await this.provider.getHistoricalData({...params,interval:'ONE_MINUTE',fromDate:freshAngelTime(open)});
    if(this.stopped)throw Error('WORKER_STOPPED');
    const five=await this.provider.getHistoricalData({...params,interval:'FIVE_MINUTE',fromDate:freshAngelTime(old?Math.max(open,old.lastSeen-300000):now-FRESH_HISTORY_SEED_DAYS*86400000)});
    if(this.stopped)throw Error('WORKER_STOPPED');
    // The provider returns [] on a failed call; an empty seed is a failure, not an empty market.
    if(!old&&(!Array.isArray(five)||five.length===0))throw Error('REFERENCE_HISTORY_UNAVAILABLE');
    const receivedAt=Date.now(),bars5=mergeFreshBars(old?.five??[],freshBars(five,5,receivedAt),4000),bars1=mergeFreshBars(old?.one??[],freshBars(one,1,receivedAt),1440),lastSeen=bars5.at(-1)?.time??0;
    this.histories.delete(ref.id);this.histories.set(ref.id,{five:bars5,one:bars1,lastSeen});
    while(this.histories.size>40)this.histories.delete(this.histories.keys().next().value!);
    const ex=freshReferenceExchange(ref),c=buildFreshReferenceContext({now:receivedAt,exchange:ex,instrument:ref.id,sourceEpoch:this.feed.sourceEpoch,bars5:fillFreshGaps(bars5,300000,ex),bars1:fillFreshGaps(bars1,60000,ex),eventClear:this.events.clearance(receivedAt,freshIstDay(receivedAt),freshEventMarket(ref.market),ref.name)===null,referenceVerified:!!this.feed.underlying(ref.id)&&!!this.feed.underlying(freshReferenceSpotId(ref))});
    if(c)c.eventEvidence=this.events.evidence(receivedAt,freshEventMarket(ref.market),ref.name);
    return {context:c,newClose:!!old&&lastSeen>old.lastSeen,lastSeen};
  }
  private async scan(){
    if(!this.ready||this.stopped||this.scanning||Date.now()-this.lastScan<10000)return;this.scanning=true;this.lastScan=Date.now();state.lastCheckAt=this.lastScan;state.entriesArmed=false;state.entryBlockers=[];
    try{
      const now=Date.now(),day=freshIstDay(now),sessions=new Map<Exchange,ReturnType<typeof getSessionWindow>>((['NSE','BSE','MCX'] as Exchange[]).map(e=>[e,getSessionWindow(e,day)]));
      if(!HOLIDAY_CALENDAR_YEARS.includes(Number(day.slice(0,4))))throw Error('BLOCKED_CALENDAR_YEAR');
      const openExchanges=new Set([...sessions].filter(([,s])=>s&&now>=s.open&&now<s.close).map(([e])=>e));
      state.eventCode=this.events.clearance(Date.now(),day,'INDEX')??(this.events.evidence(Date.now(),'INDEX').coverage.evidenceClass==='EVENT_DATA_UNVERIFIED'?'PAPER_EVENT_DATA_UNVERIFIED':'CLEAR');
      if(!openExchanges.size){state.status='WAITING_FOR_MARKET';state.observedExecutableBooks=0;state.optionContracts=0;state.entryBlockers=['OUTSIDE_VERIFIED_SESSION'];for(const m of state.marketReadiness){m.sessionOpen=false;m.eligibleReferences=0;m.observedExecutableBooks=0;m.blockers=['OUTSIDE_VERIFIED_SESSION',...freshMarketBlockers(m.market)];m.blockers.push(...this.events.blockers(now,day,freshEventMarket(m.market)));state.eventSources=this.events.view();}this.shortlist=[];await this.syncTargets();return;}
      if(!this.provider.isAuthenticated())throw Error('BLOCKED_BROKER_AUTH');
      await this.loadMaster(day);if(this.stopped)return;void this.events.refresh({macro:openExchanges.has('NSE')||openExchanges.has('BSE'),issuer:openExchanges.has('NSE')&&this.discovery!.counts.NSE_STOCK_OPTIONS>0,commodity:openExchanges.has('MCX')&&this.discovery!.counts.MCX_VERIFIED_FUTURES_OPTIONS>0}).then(()=>{if(!this.stopped)state.eventSources=this.events.view();},()=>{if(!this.stopped){state.entriesArmed=false;state.eventCode='BLOCKED_EVENT_REFRESH';state.entryBlockers=[...new Set([...state.entryBlockers,'BLOCKED_EVENT_REFRESH'])];}});state.eventSources=this.events.view();
      const exchangeKey=[...openExchanges].sort().join(',');
      if(!this.selectionAt||now-this.selectionAt>=1800000||exchangeKey!==this.selectionExchangeKey){const window=freshDiscoveryWindow(this.discovery!.references.filter(r=>openExchanges.has(freshReferenceExchange(r))),this.cursor);this.selected=window.selected;this.cursor=window.nextCursor;this.selectionAt=now;this.selectionExchangeKey=exchangeKey;}
      const refs=this.selected.filter(r=>openExchanges.has(freshReferenceExchange(r)));
      // Eight simultaneous option slices (<=160 books) plus <=40 reference interests fit this consumer's 250-token cap.
      const bookWindow=freshDiscoveryWindow(refs,Math.floor(now/FRESH_BOOK_ROTATION_MS),20).selected,bookRefs:FreshReference[]=[];
      for(const market of FRESH_MARKETS){const ref=bookWindow.find(r=>r.market===market);if(ref)bookRefs.push(ref);}
      for(const ref of bookWindow)if(bookRefs.length<8&&!bookRefs.some(r=>r.id===ref.id))bookRefs.push(ref);
      const slices=bookRefs.map(ref=>({ref,options:freshReferenceOptions(this.master,ref,day,this.feed.underlying(freshReferenceSpotId(ref))?.price??null)}));
      // MCX depth unit inference needs each MCX book's verified lot (feed.ts registerMcxDepth).
      for(const {ref,options} of slices)if(ref.market==='MCX_VERIFIED_FUTURES_OPTIONS')for(const x of options){const u=freshContractUnits(x);if(u)this.feed.registerMcxDepth(`${FO_SEGMENT.MCX}:${x.token}`,ref.name,u.lotQuantity);}
      state.mcxDepthUnits=this.feed.mcxDepthModes();
      this.shortlist=[...refs.flatMap(r=>[{token:r.signal.token,exchange:freshReferenceExchange(r),exchangeSegment:r.signal.segment==='FO'?FO_SEGMENT[freshReferenceExchange(r)]:r.spot.exchangeSegment},{token:r.spot.token,exchange:freshReferenceExchange(r),exchangeSegment:r.spot.exchangeSegment}]),...slices.flatMap(({ref,options})=>options.map(x=>({token:x.token,exchange:freshReferenceExchange(ref),exchangeSegment:FO_SEGMENT[freshReferenceExchange(ref)]})))];
      this.positions=await this.store.recover();this.monitor.watch(this.positions);await this.syncTargets();
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
        state.barCallbacks++;const blockers=blockersFor(ref);
        if(state.entriesArmed&&blockers.length===0)state.lastDecision=await this.runtime.onClosedReference(h.context);else{await auditFreshEvaluation(h.context,evaluateFreshStrategies(h.context));state.lastDecision=blockers[0]??'BLOCKED_REQUIRED_CAPABILITY';}
      }
      state.discovery.historyCache=this.histories.size;state.status=state.entriesArmed?'FORWARD_PAPER_RUNNING':'PAPER_ARMED_DATA_BLOCKED';state.error=null;
    }catch(error){if(this.stopped)return;state.entriesArmed=false;state.status='BLOCKED_ADAPTER';state.error=error instanceof Error&&/^BLOCKED_[A-Z_]+$/.test(error.message)?error.message:'ADAPTER_INPUT_OR_STORAGE_UNAVAILABLE';state.entryBlockers=[state.error];for(const m of state.marketReadiness){m.eligibleReferences=0;m.blockers=[...new Set([...m.blockers,state.error])];}}finally{this.scanning=false;if(!this.stopped){this.operationalReporter.report(state);const t=Date.now();if(t-this.summaryAt>=FRESH_DECISION_SUMMARY_MS){this.summaryAt=t;void logFreshDecisionSummary(t);}}}
  }
}
