import {createHash} from 'node:crypto';
import {FreshFreeGlobalEvents,type FreeGlobalSnapshot} from './free-global-events.js';
import {FRESH_PAPER_EVENT_POLICY,STRICT_FRESH_EVENT_POLICY,WAIVABLE_PAPER_EVENT_GAPS,type FreshEventPolicy} from '../../config/fresh-event-policy.js';
import {FreshIssuerEvents,type IssuerCalendarSnapshot} from './issuer-events.js';
import {FreshEiaEvents,type EiaCalendarSnapshot} from './eia-events.js';
import {FreshBlsEvents,type BlsCalendarSnapshot} from './bls-events.js';
import {FreshOfficialMacroEvents,type OfficialMacroSnapshot} from './official-macro-events.js';
import axios from 'axios';
import {freshEventClearance,type FreshScheduledEvent} from '@fno/analytics';
import {freshIstDay} from './context.js';
export interface FreshEventConfig {provider:'TRADING_ECONOMICS';apiKey:string;coverageConfirmed:boolean;}
export function freshEventConfig():FreshEventConfig|undefined {
  return process.env.FRESH_EVENT_PROVIDER==='TRADING_ECONOMICS'&&process.env.FRESH_EVENT_API_KEY?{provider:'TRADING_ECONOMICS',apiKey:process.env.FRESH_EVENT_API_KEY,coverageConfirmed:process.env.FRESH_EVENT_COVERAGE_CONFIRMED==='true'}:undefined;
}
export function parseFreshEvents(data:unknown){
  if(!Array.isArray(data)||data.length>=1000)throw Error('INVALID_EVENT_RESPONSE');
  const ids=new Set<string>(),events:FreshScheduledEvent[]=[],uncertainSessions:string[]=[];
  for(const row of data){
    if(!row||typeof row!=='object')throw Error('INVALID_EVENT_ROW');
    const id=String(row.CalendarId??row.CalendarID??''),date=row.Date,importance=Number(row.Importance);
    if(!id||ids.has(id)||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(date)||![1,2,3].includes(importance)||typeof row.Country!=='string'||typeof row.Event!=='string')throw Error('INVALID_EVENT_ROW');
    ids.add(id);const day=date.slice(0,10),dayAt=Date.parse(day+'T00:00:00Z');if(!Number.isFinite(dayAt)||new Date(dayAt).toISOString().slice(0,10)!==day||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:[zZ]|[+-]\d{2}:?\d{2})?$/.test(date))throw Error('INVALID_EVENT_TIME');const at=Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(date)?date:date+'Z');if(!Number.isFinite(at))throw Error('INVALID_EVENT_TIME');
    if(importance===3){const session=freshIstDay(at);if(String(row.DateSpan)!=='0')uncertainSessions.push(session);events.push({at,session,kind:'INDEX_MACRO',issuer:null,impact:'HIGH'});}
  }
  return {events,uncertainSessions};
}
export interface MacroCalendarSnapshot {id:string;source:'TRADING_ECONOMICS';from:number;to:number;fetchedAt:number;expiresAt:number;events:FreshScheduledEvent[];uncertainSessions:string[];}
export type FreshCalendarSnapshot=MacroCalendarSnapshot|IssuerCalendarSnapshot|EiaCalendarSnapshot|BlsCalendarSnapshot|OfficialMacroSnapshot|FreeGlobalSnapshot;
export class FreshEventSource {
  private qualifiedAt:number|null=null;
  private snapshot:MacroCalendarSnapshot|null=null;
  private nextAttempt=0;private inFlight:Promise<void>|null=null;
  code='BLOCKED_EVENT_PROVIDER_CONFIGURATION';
  constructor(private config=freshEventConfig(),private get:typeof axios.get=axios.get,private now:()=>number=Date.now,private issuer:FreshIssuerEvents|null=null,private persist:(s:FreshCalendarSnapshot)=>Promise<void>=async()=>{},private eia:FreshEiaEvents|null=null,private bls:FreshBlsEvents|null=null,private official:FreshOfficialMacroEvents|null=null,private policy:FreshEventPolicy=STRICT_FRESH_EVENT_POLICY,private freeGlobal:FreshFreeGlobalEvents|null=null){}
  async refresh(needed:{macro:boolean;issuer:boolean;commodity?:boolean;publicMacro?:boolean}={macro:true,issuer:true}):Promise<void>{await Promise.all([needed.macro?this.refreshMacro():undefined,needed.issuer?this.issuer?.refresh():undefined,needed.commodity?this.eia?.refresh():undefined,(needed.publicMacro??(needed.macro||needed.commodity))?this.bls?.refresh():undefined,(needed.publicMacro??(needed.macro||needed.commodity))?this.official?.refresh():undefined,(needed.publicMacro??(needed.macro||needed.commodity))?this.freeGlobal?.refresh():undefined]);}
  private refreshMacro():Promise<void>{
    if(!this.config?.apiKey||!this.config.coverageConfirmed)return Promise.resolve();
    if(this.inFlight)return this.inFlight;
    const now=this.now();if(now<this.nextAttempt)return Promise.resolve();this.nextAttempt=now+60000;
    const fromDay=new Date(now-86400000).toISOString().slice(0,10),toDay=new Date(now+86400000).toISOString().slice(0,10);
    this.inFlight=(async()=>{try{
      const r=await this.get(`https://api.tradingeconomics.com/calendar/country/all/${fromDay}/${toDay}`,{params:{c:this.config!.apiKey,f:'json',importance:3},timeout:10000,maxRedirects:0,maxContentLength:1048576});
      if(r.status!==200)throw Error('EVENT_HTTP');
      const fetchedAt=this.now(),body={source:'TRADING_ECONOMICS' as const,...parseFreshEvents(r.data),from:Date.parse(fromDay+'T00:00:00Z'),to:Date.parse(toDay+'T23:59:59Z'),fetchedAt,expiresAt:fetchedAt+60000};
      const snapshot={id:createHash('sha256').update(JSON.stringify(body)).digest('hex'),...body};await this.persist(snapshot);this.qualifiedAt=this.now();this.snapshot=snapshot;this.code='EVENT_FEED_OBSERVED';
    }catch{this.snapshot=null;this.qualifiedAt=null;this.code='BLOCKED_EVENT_PROVIDER_RESPONSE';}finally{this.inFlight=null;}})();return this.inFlight;
  }
  private macroClearance(now:number,session:string){
    const s=this.snapshot;if(!s||now<s.fetchedAt||this.qualifiedAt==null||now<this.qualifiedAt||now>s.expiresAt)return this.code==='EVENT_FEED_OBSERVED'?'BLOCKED_EVENT_COVERAGE':this.code;
    if(s.uncertainSessions.includes(session))return 'BLOCKED_UNCERTAIN_EVENT_TIME';
    return freshEventClearance({now,session,market:'INDEX',issuer:null,coverage:{verified:true,from:s.from,to:s.to,source:'TRADING_ECONOMICS_CONFIRMED_COVERAGE'},events:s.events});
  }
  private rawBlockers(now:number,session:string,market:'INDEX'|'STOCK'|'COMMODITY',issuer:string|null=null):string[]{
    const publicBlackout=this.bls?.blackout(now),officialBlockers=[...(this.official?.blockers(now)??[]),...(this.freeGlobal?.blockers(now)??[])];
    if(market==='COMMODITY'){const blackout=this.eia?.blackout(now,issuer);return [...officialBlockers,...(publicBlackout?[publicBlackout]:[]),...(blackout?[blackout]:[]),'BLOCKED_COMMODITY_EVENT_COVERAGE'];}
    const codes:string[]=[...officialBlockers,...(publicBlackout?[publicBlackout]:[])];
    if(market==='STOCK'){
      const results=this.issuer?this.issuer.clearance(now,session,issuer,'RESULTS'):'BLOCKED_ISSUER_RESULTS_COVERAGE';
      const actions=this.issuer?this.issuer.clearance(now,session,issuer,'ACTIONS'):'BLOCKED_CORPORATE_ACTION_COVERAGE';
      if(results)codes.push(results);if(actions)codes.push(actions==='BLOCKED_ISSUER_RESULTS_COVERAGE'?'BLOCKED_CORPORATE_ACTION_COVERAGE':actions);
    }
    const macro=this.macroClearance(now,session);if(macro)codes.push(macro);return [...new Set(codes)];
  }
  assessment(now:number,session:string,market:'INDEX'|'STOCK'|'COMMODITY',issuer:string|null=null){
    const raw=this.rawBlockers(now,session,market,issuer),missing=raw.filter(code=>WAIVABLE_PAPER_EVENT_GAPS.includes(code)||['BLOCKED_ISSUER_RESULTS_COVERAGE','BLOCKED_CORPORATE_ACTION_COVERAGE'].includes(code));
    const waived=this.policy.allowMissingMacroCoverage?missing.filter(code=>WAIVABLE_PAPER_EVENT_GAPS.includes(code)):[];
    return {policy:{...this.policy},coverage:{evidenceClass:missing.length?'EVENT_DATA_UNVERIFIED' as const:'EVENT_COVERAGE_VERIFIED' as const,missing:[...missing],waived:[...waived]},blockers:raw.filter(code=>!waived.includes(code))};
  }
  blockers(now:number,session:string,market:'INDEX'|'STOCK'|'COMMODITY',issuer:string|null=null){return this.assessment(now,session,market,issuer).blockers;}
  clearance(now:number,session:string,market:'INDEX'|'STOCK'|'COMMODITY',issuer:string|null=null){return this.blockers(now,session,market,issuer)[0]??null;}
  evidence(now:number,market:'INDEX'|'STOCK'|'COMMODITY',issuer:string|null=null){
    const global=this.freeGlobal?.evidence(now),freeGlobalCalendar=global?{id:global.id,source:global.source,scope:global.scope,qualifiedAt:global.qualifiedAt,fetchedAt:global.fetchedAt,expiresAt:global.expiresAt,generatedAt:global.generatedAt,from:global.from,to:global.to,eventCount:global.events.length,payloadHash:global.payloadHash}:null;
    const s=this.snapshot,macro=s&&this.qualifiedAt!=null&&this.qualifiedAt<=now&&s.fetchedAt<=now&&now<=s.expiresAt?{id:s.id,source:s.source,qualifiedAt:this.qualifiedAt,fetchedAt:s.fetchedAt,expiresAt:s.expiresAt,from:s.from,to:s.to}:null;
    return {...this.assessment(now,freshIstDay(now),market,issuer),observedAt:now,market,issuer,macro,freeGlobalCalendar,publicMacroCalendar:this.bls?.evidence(now)??null,officialMacroCalendars:this.official?.evidence(now)??[],issuerCalendar:market==='STOCK'?this.issuer?.evidence(now)??null:null,commodityCalendar:market==='COMMODITY'?this.eia?.evidence(now,issuer)??null:null};
  }
  view(){const s=this.snapshot;return {macro:{source:'TRADING_ECONOMICS',qualifiedAt:this.qualifiedAt,status:!this.config?.apiKey?'BLOCKED_EVENT_PROVIDER_CONFIGURATION':!this.config.coverageConfirmed?'BLOCKED_EVENT_COVERAGE_CONFIRMATION':s&&this.now()>s.expiresAt?'BLOCKED_EVENT_COVERAGE':this.code,configured:!!this.config?.apiKey,coverageConfirmed:!!this.config?.coverageConfirmed,fetchedAt:s?.fetchedAt??null,expiresAt:s?.expiresAt??null,snapshotId:s?.id??null,nextAttemptAt:this.nextAttempt,eventCount:s?.events.length??null},issuer:this.issuer?.view()??null,commodity:this.eia?.view()??[],publicMacro:this.bls?.view()??null,officialMacro:this.official?.view()??[],freeGlobal:this.freeGlobal?.view()??null};}
}
export function createFreshEventSource(persist:(s:FreshCalendarSnapshot)=>Promise<void>){return new FreshEventSource(undefined,axios.get,Date.now,new FreshIssuerEvents(axios.get,Date.now,persist),persist,new FreshEiaEvents(axios.get,Date.now,persist),new FreshBlsEvents(axios.get,Date.now,persist),new FreshOfficialMacroEvents(axios.get,Date.now,persist),FRESH_PAPER_EVENT_POLICY,new FreshFreeGlobalEvents(axios.get,Date.now,persist));}
