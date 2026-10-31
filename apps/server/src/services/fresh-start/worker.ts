import {getSessionWindow,HOLIDAY_CALENDAR_YEARS,KNOWN_INDEX_TOKENS,type Instrument} from '@fno/shared';
import {evaluateFreshStrategies,type FreshBar} from '@fno/analytics';
import type {MarketDataProvider} from '../../providers/interface.js';
import type {SubscriptionManager,SubscriptionTarget} from '../../lib/subscription-manager.js';
import {sql} from '../../lib/db.js';
import {redis,scanKeys} from '../../lib/redis.js';
import {schemaFileReady} from '../ensure-capture-schema.js';
import {FRESH_CONFIG} from '../../config/fresh-start.js';
import {FreshSharedFeed} from './feed.js';
import {FreshEventSource} from './event-source.js';
import {FreshProductionAdapter,type FreshReference} from './adapter.js';
import {FreshPaperStore} from './store.js';
import {FreshPositionMonitor} from './monitor.js';
import {FreshRuntime} from './runtime.js';
import {qualificationContracts} from './qualification.js';
import {freshAdapterState as state} from './adapter-state.js';
import {freshIstDay,freshBars,mergeFreshBars,buildFreshReferenceContext} from './context.js';
import {auditFreshAdapter,auditFreshEvaluation} from './audit.js';
type History={five:FreshBar[];one:FreshBar[];lastSeen:number};
export class FreshPaperWorker {
  private feed:FreshSharedFeed;private events=new FreshEventSource();private store=new FreshPaperStore();private monitor:FreshPositionMonitor;private runtime:FreshRuntime;
  private refs=new Map<string,FreshReference>();private master:Instrument[]=[];private masterDay='';private histories=new Map<string,History>();private shortlist:SubscriptionTarget[]=[];
  private positions:Awaited<ReturnType<FreshPaperStore['recover']>>=[];private timers:ReturnType<typeof setInterval>[]=[];private removeObservation:(()=>void)|null=null;private scanning=false;private ready=false;private stopped=false;private lastScan=0;
  constructor(private provider:MarketDataProvider,private subscriptions:SubscriptionManager){
    this.feed=new FreshSharedFeed(subscriptions,Date.now,'fresh-start:production');this.monitor=new FreshPositionMonitor(this.feed,this.store);
    const adapter=new FreshProductionAdapter(this.feed,this.events,this.store,{references:()=>this.refs,master:()=>this.master,capital:FRESH_CONFIG.capital??0,legacyRisk:()=>this.legacyRisk(),audit:auditFreshEvaluation,refusal:auditFreshAdapter,watch:async rows=>{this.positions=rows;this.monitor.watch(rows);await this.syncTargets();}});
    this.runtime=new FreshRuntime(this.store,adapter,()=>FRESH_CONFIG.activationApproved&&state.entriesArmed);
  }
  start(){
    this.feed.start();this.removeObservation=this.feed.onObservation(()=>{if(this.ready)this.pollMonitor();});
    // Registered synchronously so the service supervisor owns every timer, including during recovery.
    this.timers=[setInterval(()=>{if(this.ready)this.pollMonitor();},250),setInterval(()=>void this.scan(),1000)];
    return this.bootstrap();
  }
  private async bootstrap(){
    if(!schemaFileReady('047_fresh_start_paper.sql')||!schemaFileReady('048_fresh_start_adapter.sql'))throw Error('BLOCKED_FRESH_SCHEMA');
    try{await this.runtime.recover();}catch(error){state.entriesArmed=false;state.status='BLOCKED_RECOVERY';state.entryBlockers=['BLOCKED_POSITION_RECOVERY'];throw error;}if(this.stopped)return;
    this.ready=true;state.recovered=true;state.monitorRunning=true;state.scannerRunning=true;await this.scan();
  }
  private pollMonitor(){this.monitor.tick();if(!this.monitor.healthy){state.entriesArmed=false;if(!state.entryBlockers.includes('BLOCKED_EXIT_PERSISTENCE'))state.entryBlockers.push('BLOCKED_EXIT_PERSISTENCE');}}
  stop(){this.stopped=true;this.ready=false;for(const t of this.timers)clearInterval(t);this.removeObservation?.();this.feed.close();state.entriesArmed=false;state.monitorRunning=false;state.scannerRunning=false;}
  private async legacyRisk(){try{const [r]=await sql`SELECT count(*)::int AS n FROM signals WHERE signal_type='TRADE_SETUP' AND inputs->>'outcome' IS NULL AND coalesce(inputs->>'voided','')<>'true'`;if(r.n>0)return true;for(const key of await scanKeys('trade_setup:*')){const raw=await redis.get(key);if(!raw)continue;const value=JSON.parse(raw);if(!value||typeof value!=='object'||typeof value.available!=='boolean'||value.available)return true;}return false;}catch{return true;}}
  private async syncTargets(){
    const held:SubscriptionTarget[]=[];for(const p of this.positions)for(const id of [p.state.contract.id,p.state.candidate.instrument]){const m=/^(NSE_FO|NSE_CM):(\d+)$/.exec(id);if(!m)throw Error('BLOCKED_HELD_CONTRACT_IDENTITY');held.push({exchange:'NSE',exchangeSegment:m[1] as 'NSE_FO'|'NSE_CM',token:m[2]});}
    const unique=(a:SubscriptionTarget[])=>[...new Map(a.map(t=>[`${t.exchangeSegment}:${t.token}`,t])).values()];
    let wanted=unique([...held,...this.shortlist]);const own=new Set(this.feed.subscribedTargets.map(x=>`${x.exchangeSegment}:${x.token}`)),available=950-this.subscriptions.getStatus().subscriptionCount;
    if(wanted.length>250||wanted.filter(x=>!own.has(`${x.exchangeSegment}:${x.token}`)).length>available){state.entriesArmed=false;state.entryBlockers.push('BLOCKED_SHARED_SUBSCRIPTION_HEADROOM');wanted=unique(held);}
    await this.feed.syncTargets(wanted,250);
  }
  private async loadMaster(day:string){
    if(day===this.masterDay)return;const master=await this.provider.getInstrumentMaster();if(!master.length)throw Error('BLOCKED_INSTRUMENT_MASTER');
    const refs=new Map<string,FreshReference>();for(const name of ['NIFTY','BANKNIFTY']){const signal=qualificationContracts(master,name,day,null).future,token=KNOWN_INDEX_TOKENS[name];if(!signal||!token)throw Error('BLOCKED_EXACT_REFERENCES');const id=`NSE_FO:${signal.token}`;refs.set(id,{id,name,signal,spot:{token,exchangeSegment:'NSE_CM'},market:'NSE_INDEX_OPTIONS',riskGroup:'NSE_INDEX_CORRELATED'});}
    this.master=master;this.refs=refs;this.masterDay=day;this.histories.clear();
  }
  private async context(ref:FreshReference,now:number,open:number){
    const old=this.histories.get(ref.id),params={exchange:'NSE' as const,segment:'FO' as const,token:ref.signal.token,toDate:new Date(now).toISOString()};
    const one=await this.provider.getHistoricalData({...params,interval:'ONE_MINUTE',fromDate:new Date(open).toISOString()});
    const five=await this.provider.getHistoricalData({...params,interval:'FIVE_MINUTE',fromDate:new Date(old?Math.max(open,now-900000):now-45*86400000).toISOString()});
    const receivedAt=Date.now(),bars5=mergeFreshBars(old?.five??[],freshBars(five,5,receivedAt),4000),bars1=mergeFreshBars(old?.one??[],freshBars(one,1,receivedAt),500),lastSeen=bars5.at(-1)?.time??0;
    this.histories.set(ref.id,{five:bars5,one:bars1,lastSeen});
    const c=buildFreshReferenceContext({now:receivedAt,instrument:ref.id,sourceEpoch:this.feed.sourceEpoch,bars5,bars1,eventClear:this.events.clearance(receivedAt,freshIstDay(receivedAt),'INDEX')===null,referenceVerified:!!this.feed.underlying(ref.id)&&!!this.feed.underlying(`NSE_CM:${ref.spot.token}`)});
    return {context:c,newClose:!!old&&lastSeen>old.lastSeen,lastSeen};
  }
  private async scan(){
    if(!this.ready||this.stopped||this.scanning||Date.now()-this.lastScan<10000)return;this.scanning=true;this.lastScan=Date.now();state.lastCheckAt=this.lastScan;state.entriesArmed=false;state.entryBlockers=[];
    try{
      const now=Date.now(),day=freshIstDay(now),session=getSessionWindow('NSE',day);
      if(!HOLIDAY_CALENDAR_YEARS.includes(Number(day.slice(0,4))))throw Error('BLOCKED_CALENDAR_YEAR');
      if(!session||now<session.open||now>=session.close){state.status='WAITING_FOR_MARKET';state.observedExecutableBooks=0;state.optionContracts=0;state.entryBlockers=['OUTSIDE_VERIFIED_SESSION'];this.shortlist=[];await this.syncTargets();return;}
      if(!this.provider.isAuthenticated())throw Error('BLOCKED_BROKER_AUTH');
      await this.loadMaster(day);await this.events.refresh();
      state.eventCode=this.events.clearance(Date.now(),day,'INDEX')??'CLEAR';
      const refs=[...this.refs.values()],options=refs.flatMap(r=>qualificationContracts(this.master,r.name,day,this.feed.underlying(`NSE_CM:${r.spot.token}`)?.price??null).options);
      this.shortlist=[...refs.flatMap(r=>[{token:r.signal.token,exchange:'NSE' as const,exchangeSegment:'NSE_FO' as const},{token:r.spot.token,exchange:'NSE' as const,exchangeSegment:'NSE_CM' as const}]),...options.map(x=>({token:x.token,exchange:'NSE' as const,exchangeSegment:'NSE_FO' as const}))];
      this.positions=await this.store.recover();this.monitor.watch(this.positions);await this.syncTargets();
      state.referenceContracts=refs.length;state.optionContracts=options.length;state.sourceEpoch=this.feed.sourceEpoch;
      state.observedExecutableBooks=options.filter(x=>{const q=this.feed.quote(`NSE_FO:${x.token}`,x.tickSize);return q&&q.bidUnits>=x.lotSize&&q.askUnits>=x.lotSize;}).length;
      if(state.eventCode!=='CLEAR')state.entryBlockers.push(state.eventCode);
      if(await this.legacyRisk())state.entryBlockers.push('LEGACY_POSITION_OR_INVENTORY_UNAVAILABLE');
      if(!this.monitor.healthy)state.entryBlockers.push('BLOCKED_EXIT_PERSISTENCE');
      if(!state.observedExecutableBooks)state.entryBlockers.push('WAITING_FOR_OBSERVED_BOOKS');
      state.entriesArmed=state.entryBlockers.length===0;
      for(const ref of refs){
        const expected=session.open+(Math.floor((Date.now()-session.open)/300000)-1)*300000;if(expected<session.open)continue;
        if((this.histories.get(ref.id)?.lastSeen??0)>=expected)continue;
        const h=await this.context(ref,Date.now(),session.open);if(!h.context)continue;
        if(!h.newClose){await auditFreshEvaluation(h.context,evaluateFreshStrategies(h.context));state.lastDecision='HISTORY_SEED_NO_RETROACTIVE_ENTRY';continue;}
        const currentExpected=session.open+(Math.floor((Date.now()-session.open)/300000)-1)*300000;
        if(h.lastSeen!==currentExpected){state.lastDecision='MISSING_CURRENT_CLOSED_BAR';continue;}
        state.barCallbacks++;if(state.entriesArmed)state.lastDecision=await this.runtime.onClosedReference(h.context);else{await auditFreshEvaluation(h.context,evaluateFreshStrategies(h.context));state.lastDecision='BLOCKED_REQUIRED_CAPABILITY';}
      }
      state.status=state.entriesArmed?'FORWARD_PAPER_RUNNING':'PAPER_ARMED_DATA_BLOCKED';state.error=null;
    }catch(error){state.entriesArmed=false;state.status='BLOCKED_ADAPTER';state.error=error instanceof Error&&/^BLOCKED_[A-Z_]+$/.test(error.message)?error.message:'ADAPTER_INPUT_OR_STORAGE_UNAVAILABLE';state.entryBlockers=[state.error];}finally{this.scanning=false;}
  }
}
