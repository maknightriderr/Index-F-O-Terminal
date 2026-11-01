import axios from 'axios';
import {createHash} from 'node:crypto';
export const FREE_GLOBAL_CALENDAR_URL='https://showmytrades.com/api/public/calendar/v1';
const istDay=(at:number)=>new Date(at).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
function utc(value:unknown){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/.test(value))throw Error('FREE_GLOBAL_INVALID_TIME');
  const at=Date.parse(value);if(!Number.isFinite(at)||new Date(at).toISOString().slice(0,10)!==value.slice(0,10))throw Error('FREE_GLOBAL_INVALID_TIME');return at;
}
export interface FreeGlobalSnapshot {
  id:string;source:'SHOWMYTRADES_PUBLIC_V1';url:string;scope:'THIRD_PARTY_NINE_CURRENCY_HIGH_IMPACT_ONLY';
  requestedAt:number;fetchedAt:number;expiresAt:number;generatedAt:number;from:number;to:number;payloadHash:string;
  events:Array<{id:string;at:number;currency:string;title:string;status:string;movedFrom:number|null}>;uncertainDays:string[];
}
/** Supplemental reported schedules only; no INR, commodity inventory or completeness attestation. */
export function parseFreeGlobalCalendar(data:any,requestedAt:number,fetchedAt:number):FreeGlobalSnapshot {
  if(!data||typeof data!=='object'||!Array.isArray(data.events)||!Number.isSafeInteger(data.count)||data.count!==data.events.length||data.count>=1000||![requestedAt,fetchedAt].every(Number.isFinite)||requestedAt>fetchedAt||fetchedAt-requestedAt>=60000)throw Error('FREE_GLOBAL_INVALID_RESPONSE');
  const server=utc(data.server_time_iso),generatedAt=utc(data.generated_at),from=utc(data.from),to=utc(data.to);
  if(!Number.isSafeInteger(data.server_time)||server!==data.server_time*1000||Math.abs(server-fetchedAt)>30000||generatedAt>fetchedAt||fetchedAt-generatedAt>=900000||from>requestedAt-900000||to<fetchedAt+900000||to-from>31*86400000)throw Error('FREE_GLOBAL_CLOCK_OR_WINDOW_UNVERIFIED');
  const ids=new Set<string>(),uncertain=new Set<string>(),events:FreeGlobalSnapshot['events']=[];
  for(const row of data.events){
    if(!row||typeof row!=='object'||typeof row.id!=='string'||!row.id||row.id.length>200||ids.has(row.id)||!['USD','EUR','GBP','JPY','AUD','NZD','CAD','CHF','CNY'].includes(row.currency)||row.impact!=='high'||!['scheduled','moved','tentative'].includes(row.status)||typeof row.title!=='string'||!row.title||row.title.length>300||typeof row.confidence!=='string'||row.confidence.length>80)throw Error('FREE_GLOBAL_INVALID_EVENT');
    const at=utc(row.time);if(!Number.isSafeInteger(row.ts)||row.ts*1000!==at||at<from||at>to)throw Error('FREE_GLOBAL_INVALID_EVENT');
    const movedFrom=row.status==='moved'?utc(row.moved_from):null;if(row.status!=='moved'&&row.moved_from!=='')throw Error('FREE_GLOBAL_INVALID_MOVE');
    if(row.status==='tentative'||row.confidence!=='sources_agree'){uncertain.add(istDay(at));if(movedFrom!=null)uncertain.add(istDay(movedFrom));}
    ids.add(row.id);events.push({id:row.id,at,currency:row.currency,title:row.title,status:row.status,movedFrom});
  }
  events.sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
  const body={source:'SHOWMYTRADES_PUBLIC_V1' as const,url:FREE_GLOBAL_CALENDAR_URL,scope:'THIRD_PARTY_NINE_CURRENCY_HIGH_IMPACT_ONLY' as const,requestedAt,fetchedAt,expiresAt:Math.min(requestedAt+900000,generatedAt+900000),generatedAt,from,to,payloadHash:createHash('sha256').update(JSON.stringify(data)).digest('hex'),events,uncertainDays:[...uncertain].sort()};
  return {id:createHash('sha256').update(JSON.stringify(body)).digest('hex'),...body};
}
export class FreshFreeGlobalEvents {
  private snapshot:FreeGlobalSnapshot|null=null;private qualifiedAt:number|null=null;private failureCode:string|null=null;private nextAttempt=0;private inFlight:Promise<void>|null=null;
  constructor(private get:typeof axios.get=axios.get,private now:()=>number=Date.now,private persist:(s:FreeGlobalSnapshot)=>Promise<void>=async()=>{}){}
  refresh():Promise<void>{
    if(this.inFlight)return this.inFlight;if(this.now()<this.nextAttempt)return Promise.resolve();this.nextAttempt=this.now()+900000;
    this.inFlight=(async()=>{const requestedAt=this.now();try{
      const r=await this.get(FREE_GLOBAL_CALENDAR_URL,{params:{impact:'high',days:2},headers:{'User-Agent':'FNO-PaperCalendar/1.0 (+https://github.com/maknightriderr/Index-F-O-Terminal)',Accept:'application/json'},timeout:10000,maxRedirects:0,maxContentLength:1048576});if(r.status!==200)throw Error('FREE_GLOBAL_HTTP_UNAVAILABLE');
      const s=parseFreeGlobalCalendar(r.data,requestedAt,this.now());try{await this.persist(s);}catch{throw Error('FREE_GLOBAL_PERSISTENCE_FAILED');}
      const at=this.now();if(at<s.fetchedAt||at>s.expiresAt)throw Error('FREE_GLOBAL_PERSISTENCE_TIME_INVALID');this.snapshot=s;this.qualifiedAt=at;this.failureCode=null;
    }catch(error){this.snapshot=null;this.qualifiedAt=null;this.failureCode=axios.isAxiosError(error)?error.response?.status?`FREE_GLOBAL_HTTP_${error.response.status}`:error.code==='ECONNABORTED'?'FREE_GLOBAL_TIMEOUT':'FREE_GLOBAL_NETWORK_UNAVAILABLE':error instanceof Error&&/^FREE_GLOBAL_[A-Z_]+$/.test(error.message)?error.message:'FREE_GLOBAL_SOURCE_UNAVAILABLE';}})().finally(()=>{this.nextAttempt=this.snapshot?Math.min(this.now()+900000,Math.max(this.now()+60000,this.snapshot.expiresAt-60000)):this.now()+900000;this.inFlight=null;});return this.inFlight;
  }
  evidence(now:number){const s=this.snapshot;return s&&this.qualifiedAt!=null&&this.qualifiedAt<=now&&s.fetchedAt<=now&&now<=s.expiresAt?{...s,qualifiedAt:this.qualifiedAt,events:s.events.map(e=>({...e})),uncertainDays:[...s.uncertainDays]}:null;}
  blockers(now:number){const s=this.evidence(now);if(!s)return [];if(s.uncertainDays.includes(istDay(now)))return ['FREE_GLOBAL_EVENT_TIME_UNCERTAIN'];return s.events.some(e=>Math.abs(e.at-now)<=900000||e.movedFrom!=null&&Math.abs(e.movedFrom-now)<=900000)?['FREE_GLOBAL_RELEASE_BLACKOUT']:[];}
  view(){const s=this.evidence(this.now());return {source:'SHOWMYTRADES_PUBLIC_V1',status:s?'PARTIAL_THIRD_PARTY_SCHEDULE_OBSERVED':this.snapshot&&this.now()>this.snapshot.expiresAt?'FREE_GLOBAL_SCHEDULE_STALE':this.failureCode?'FREE_GLOBAL_SOURCE_UNAVAILABLE':'FREE_GLOBAL_NOT_OBSERVED',failureCode:this.failureCode,snapshotId:s?.id??null,fetchedAt:s?.fetchedAt??null,expiresAt:s?.expiresAt??null,nextAttemptAt:this.nextAttempt,nextReleaseAt:s?.events.find(e=>e.at>this.now())?.at??null,eventCount:s?.events.length??null,completeMacroCoverage:false};}
}
