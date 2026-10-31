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
    ids.add(id);const at=Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(date)?date:date+'Z');if(!Number.isFinite(at))throw Error('INVALID_EVENT_TIME');
    if(importance===3){const session=freshIstDay(at);if(String(row.DateSpan)!=='0')uncertainSessions.push(session);events.push({at,session,kind:'INDEX_MACRO',issuer:null,impact:'HIGH'});}
  }
  return {events,uncertainSessions};
}
export class FreshEventSource {
  private snapshot:({from:number;to:number;fetchedAt:number}&ReturnType<typeof parseFreshEvents>)|null=null;
  private nextAttempt=0;private inFlight:Promise<void>|null=null;
  code='BLOCKED_EVENT_PROVIDER_CONFIGURATION';
  constructor(private config=freshEventConfig(),private get:typeof axios.get=axios.get,private now:()=>number=Date.now){}
  refresh():Promise<void>{
    if(!this.config?.apiKey||!this.config.coverageConfirmed)return Promise.resolve();
    if(this.inFlight)return this.inFlight;
    const now=this.now();if(now<this.nextAttempt)return Promise.resolve();this.nextAttempt=now+60000;
    const fromDay=new Date(now-86400000).toISOString().slice(0,10),toDay=new Date(now+86400000).toISOString().slice(0,10);
    this.inFlight=(async()=>{try{
      const r=await this.get(`https://api.tradingeconomics.com/calendar/country/all/${fromDay}/${toDay}`,{params:{c:this.config!.apiKey,f:'json',importance:3},timeout:10000,maxRedirects:0,maxContentLength:1048576});
      if(r.status!==200)throw Error('EVENT_HTTP');
      this.snapshot={...parseFreshEvents(r.data),from:Date.parse(fromDay+'T00:00:00Z'),to:Date.parse(toDay+'T23:59:59Z'),fetchedAt:this.now()};this.code='EVENT_FEED_OBSERVED';
    }catch{this.snapshot=null;this.code='BLOCKED_EVENT_PROVIDER_RESPONSE';}finally{this.inFlight=null;}})();return this.inFlight;
  }
  clearance(now:number,session:string,market:'INDEX'|'STOCK'|'COMMODITY',issuer:string|null=null){
    if(market==='COMMODITY')return 'BLOCKED_COMMODITY_EVENT_COVERAGE';
    if(market==='STOCK')return 'BLOCKED_ISSUER_RESULTS_COVERAGE';
    const s=this.snapshot;if(!s||now<s.fetchedAt||now-s.fetchedAt>60000)return this.code==='EVENT_FEED_OBSERVED'?'BLOCKED_EVENT_COVERAGE':this.code;
    if(s.uncertainSessions.includes(session))return 'BLOCKED_UNCERTAIN_EVENT_TIME';
    return freshEventClearance({now,session,market,issuer,coverage:{verified:true,from:s.from,to:s.to,source:'TRADING_ECONOMICS_CONFIRMED_COVERAGE'},events:s.events});
  }
}
