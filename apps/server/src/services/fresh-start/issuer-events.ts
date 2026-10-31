import axios from 'axios';
import {createHash} from 'node:crypto';
import {freshIstDay} from './context.js';
export interface IssuerCalendarSnapshot {
  id:string;source:'NSE_PUBLIC_RANGE_V1';requestedAt:number;fetchedAt:number;expiresAt:number;
  eventFrom:string;eventTo:string;actionFrom:string;actionTo:string;
  results:Array<{issuer:string;day:string}>;
  uncertain:Array<{issuer:string;day:string}>;
  actions:Array<{issuer:string;day:string;adjustment:boolean}>;
  responseCounts:{events:number;meetings:number;actions:number};
}
const months:Record<string,string>={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
export function issuerCalendarDay(value:unknown):string {
  if(typeof value!=='string')throw Error('INVALID_ISSUER_DATE');
  let day=value;
  const m=/^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if(m){if(!months[m[2]])throw Error('INVALID_ISSUER_DATE');day=`${m[3]}-${months[m[2]]}-${m[1]}`;}
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw Error('INVALID_ISSUER_DATE');
  return day;
}
function array(value:unknown){if(!Array.isArray(value)||value.length>=10000)throw Error('INVALID_OR_TRUNCATED_ISSUER_RESPONSE');return value;}
function symbol(value:unknown){if(typeof value!=='string'||!/^[A-Z0-9&._-]{1,40}$/.test(value))throw Error('INVALID_ISSUER_SYMBOL');return value;}
const dayShift=(day:string,n:number)=>new Date(Date.parse(day+'T12:00:00+05:30')+n*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
const dmy=(day:string)=>day.split('-').reverse().join('-');
/** Strictly parse complete explicit-range responses. Never silently drop a malformed row or assume a default latest-20 list covers the market. */
export function parseIssuerCalendar(input:{events:unknown;meetings:unknown;actions:unknown},range:{eventFrom:string;eventTo:string;actionFrom:string;actionTo:string},fetchedAt:number,requestedAt=fetchedAt):IssuerCalendarSnapshot {
  if(!Number.isFinite(fetchedAt)||!Number.isFinite(requestedAt)||requestedAt>fetchedAt||fetchedAt-requestedAt>=300000)throw Error('INVALID_ISSUER_AVAILABILITY');
  const events=array(input.events),meetings=array(input.meetings),actions=array(input.actions);if(!actions.length||(!events.length&&!meetings.length))throw Error('EMPTY_ISSUER_MARKET_RESPONSE');
  const results=new Map<string,{issuer:string;day:string}>(),uncertain=new Map<string,{issuer:string;day:string}>(),mappedActions=new Map<string,{issuer:string;day:string;adjustment:boolean}>();
  for(const [rows,board] of [[events,false],[meetings,true]] as const)for(const row of rows){
    if(!row||typeof row!=='object')throw Error('INVALID_ISSUER_ROW');
    const issuer=symbol(row[board?'bm_symbol':'symbol']),day=issuerCalendarDay(row[board?'bm_date':'date']),purpose=row[board?'bm_purpose':'purpose'],description=row.bm_desc;
    if(typeof purpose!=='string'||!purpose.trim()||description!=null&&typeof description!=='string'||day<range.eventFrom||day>range.eventTo)throw Error('INVALID_ISSUER_ROW');
    const text=`${purpose} ${description??''}`,key=`${issuer}:${day}`;
    if(/financial|results/i.test(text))results.set(key,{issuer,day});
    else if(/intimation|other business|general purpose/i.test(text))uncertain.set(key,{issuer,day});
    // Rescheduled/unknown meetings cannot erase a previously announced date silently.
    for(const field of ['oriiginalMeetingDate','originalMeetingDate','proposedMeetingDate'])if(row[field]!=null&&row[field]!==''&&row[field]!=='-'){
      const changed=issuerCalendarDay(row[field]);if(changed>=range.eventFrom&&changed<=range.eventTo)uncertain.set(`${issuer}:${changed}`,{issuer,day:changed});
    }
  }
  for(const row of actions){
    if(!row||typeof row!=='object')throw Error('INVALID_CORPORATE_ACTION_ROW');
    const issuer=symbol(row.symbol),day=issuerCalendarDay(row.exDate),purpose=row.subject;
    if(typeof purpose!=='string'||!purpose.trim()||day<range.actionFrom||day>range.actionTo)throw Error('INVALID_CORPORATE_ACTION_ROW');
    const adjustment=/split|sub.?divisi|bonus|rights|demerger|re.?organ|capital reduction|consolidation/i.test(purpose),key=`${issuer}:${day}`;
    mappedActions.set(key,{issuer,day,adjustment:adjustment||(mappedActions.get(key)?.adjustment??false)});
  }
  const sort=<T extends {issuer:string;day:string}>(a:T[])=>a.sort((a,b)=>a.issuer.localeCompare(b.issuer)||a.day.localeCompare(b.day));
  const body={source:'NSE_PUBLIC_RANGE_V1' as const,requestedAt,fetchedAt,expiresAt:requestedAt+300000,...range,results:sort([...results.values()]),uncertain:sort([...uncertain.values()]),actions:sort([...mappedActions.values()]),responseCounts:{events:events.length,meetings:meetings.length,actions:actions.length}};
  return {id:createHash('sha256').update(JSON.stringify(body)).digest('hex'),...body};
}
export interface IssuerSourceView {qualifiedAt:number|null;failureCode:string|null;source:string;status:string;fetchedAt:number|null;expiresAt:number|null;snapshotId:string|null;nextAttemptAt:number;responseCounts:IssuerCalendarSnapshot['responseCounts']|null;}
/** Public exchange metadata only. No broker credentials, paid source, challenge solving or stale-success fallback. */
export class FreshIssuerEvents {
  private qualifiedAt:number|null=null;
  private snapshot:IssuerCalendarSnapshot|null=null;private nextAttempt=0;private inFlight:Promise<void>|null=null;private cookie='';private cookieAt=0;
  private failureCode:string|null=null;
  private status='BLOCKED_ISSUER_SOURCE_NOT_OBSERVED';
  constructor(private get:typeof axios.get=axios.get,private now:()=>number=Date.now,private persist:(s:IssuerCalendarSnapshot)=>Promise<void>=async()=>{}){}
  refresh():Promise<void>{
    if(this.inFlight)return this.inFlight;const now=this.now();if(now<this.nextAttempt)return Promise.resolve();this.nextAttempt=now+60000;
    const today=freshIstDay(now),range={eventFrom:dayShift(today,-1),eventTo:dayShift(today,1),actionFrom:dayShift(today,-45),actionTo:dayShift(today,1)};
    this.inFlight=(async()=>{try{
      const headers={'User-Agent':'Mozilla/5.0',Accept:'application/json',Referer:'https://www.nseindia.com/companies-listing/corporate-filings-event-calendar'};
      if(!this.cookie||now-this.cookieAt>=3600000){const r=await this.get('https://www.nseindia.com',{headers:{...headers,Accept:'text/html'},timeout:15000,maxRedirects:0,maxContentLength:2000000});if(r.status!==200)throw Error('NSE_SESSION_UNAVAILABLE');const cookies=r.headers?.['set-cookie'];if(!Array.isArray(cookies)||!cookies.length)throw Error('NSE_SESSION_UNAVAILABLE');this.cookie=cookies.map(c=>c.split(';')[0]).join('; ');this.cookieAt=this.now();}
      const request=async(path:string,from:string,to:string)=>{const r=await this.get(`https://www.nseindia.com/api/${path}`,{headers:{...headers,Cookie:this.cookie},params:{index:'equities',from_date:dmy(from),to_date:dmy(to)},timeout:15000,maxRedirects:0,maxContentLength:8000000});if(r.status!==200)throw Error('NSE_ISSUER_HTTP');return r.data;};
      // Sequential requests keep source pressure bounded; one range request per endpoint, no per-stock fan-out.
      const events=await request('event-calendar',range.eventFrom,range.eventTo),meetings=await request('corporate-board-meetings',range.eventFrom,range.eventTo),actions=await request('corporates-corporateActions',range.actionFrom,range.actionTo);
      const snapshot=parseIssuerCalendar({events,meetings,actions},range,this.now(),now);try{await this.persist(snapshot);}catch{throw Error('ISSUER_SNAPSHOT_PERSISTENCE_FAILED');}this.failureCode=null;this.qualifiedAt=this.now();this.snapshot=snapshot;this.status='ISSUER_RANGE_OBSERVED';this.nextAttempt=Math.min(this.now()+180000,snapshot.expiresAt-60000);
    }catch(error){this.failureCode=axios.isAxiosError(error)?error.response?.status?`HTTP_${error.response.status}`:error.code==='ECONNABORTED'?'SOURCE_TIMEOUT':'SOURCE_NETWORK_UNAVAILABLE':error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'SOURCE_RESPONSE_UNAVAILABLE';this.snapshot=null;this.qualifiedAt=null;this.cookie='';this.status='BLOCKED_ISSUER_SOURCE_RESPONSE';this.nextAttempt=this.now()+60000;}finally{this.inFlight=null;}})();return this.inFlight;
  }
  clearance(now:number,day:string,issuer:string|null,kind:'RESULTS'|'ACTIONS'|'ALL'='ALL'):string|null{
    const s=this.snapshot;if(!issuer||!s||now<s.fetchedAt||this.qualifiedAt==null||now<this.qualifiedAt||now>s.expiresAt||day!==freshIstDay(now)||day<s.eventFrom||day>s.eventTo||day<s.actionFrom||day>s.actionTo)return 'BLOCKED_ISSUER_RESULTS_COVERAGE';
    if(kind!=='ACTIONS'){
      if(s.results.some(x=>x.issuer===issuer&&x.day===day))return 'ISSUER_RESULTS_DAY';
      if(s.uncertain.some(x=>x.issuer===issuer&&x.day===day))return 'BLOCKED_ISSUER_EVENT_PURPOSE';
    }
    if(kind!=='RESULTS'){
      if(s.actions.some(x=>x.issuer===issuer&&x.day===day))return 'CORPORATE_ACTION_DAY';
      if(s.actions.some(x=>x.issuer===issuer&&x.day<day&&x.adjustment))return 'BLOCKED_ADJUSTED_STOCK_HISTORY';
    }
    return null;
  }
  evidence(now:number){const s=this.snapshot;return s&&this.qualifiedAt!=null&&this.qualifiedAt<=now&&s.fetchedAt<=now&&now<=s.expiresAt?{id:s.id,source:s.source,qualifiedAt:this.qualifiedAt,fetchedAt:s.fetchedAt,expiresAt:s.expiresAt,eventFrom:s.eventFrom,eventTo:s.eventTo,actionFrom:s.actionFrom,actionTo:s.actionTo}:null;}
  view():IssuerSourceView{const s=this.snapshot;return {source:'NSE_PUBLIC_RANGE_V1',qualifiedAt:this.qualifiedAt,failureCode:this.failureCode,status:s&&this.now()<s.fetchedAt?'BLOCKED_ISSUER_SOURCE_CLOCK':s&&this.now()>s.expiresAt?'BLOCKED_ISSUER_SOURCE_STALE':this.status,fetchedAt:s?.fetchedAt??null,expiresAt:s?.expiresAt??null,snapshotId:s?.id??null,nextAttemptAt:this.nextAttempt,responseCounts:s?.responseCounts??null};}
}
