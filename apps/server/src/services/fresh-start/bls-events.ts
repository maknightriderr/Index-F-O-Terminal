import axios from 'axios';
import {createHash} from 'node:crypto';
import {eiaEasternTime} from './eia-events.js';
export const BLS_CALENDAR_URL='https://www.bls.gov/schedule/news_release/bls.ics';
const releases:Record<string,string>={
  'Consumer Price Index':'US_CPI','Employment Situation':'US_EMPLOYMENT',
  'Producer Price Index':'US_PPI','Job Openings and Labor Turnover Survey':'US_JOLTS',
  'U.S. Import and Export Price Indexes':'US_IMPORT_EXPORT_PRICES','Real Earnings':'US_REAL_EARNINGS',
  'Employment Cost Index':'US_EMPLOYMENT_COST','Productivity and Costs':'US_PRODUCTIVITY',
};
export interface BlsCalendarSnapshot {
  id:string;source:'BLS_PUBLIC_ICS_V1';requestedAt:number;fetchedAt:number;expiresAt:number;
  url:string;payloadHash:string;scope:'SELECTED_BLS_RELEASES_ONLY';
  sourceRows:number;excludedRows:number;events:Array<{at:number;day:string;release:string}>;
}
/** Accept the explicit-date BLS feed, not a general iCalendar interpreter. Unknown scheduling semantics fail closed. */
export function parseBlsCalendar(data:unknown,requestedAt:number,fetchedAt:number):BlsCalendarSnapshot {
  if(typeof data!=='string'||Buffer.byteLength(data)>1048576||![requestedAt,fetchedAt].every(Number.isFinite)||requestedAt>fetchedAt||fetchedAt-requestedAt>=60000)throw Error('INVALID_BLS_PAYLOAD');
  const lines=data.replace(/\r\n/g,'\n').replace(/\n[ \t]/g,'').trim().split('\n');
  if(lines[0]!=='BEGIN:VCALENDAR'||lines.at(-1)!=='END:VCALENDAR')throw Error('INVALID_BLS_CALENDAR');
  const stack=['VCALENDAR'],uids=new Set<string>(),slots=new Set<string>(),events:BlsCalendarSnapshot['events']=[];
  let fields=new Map<string,string>(),sourceRows=0,version=false,origin=false;
  for(const line of lines.slice(1,-1)){
    if(!line.trim())continue;
    const colon=line.indexOf(':');if(colon<1)throw Error('INVALID_BLS_PROPERTY');
    const key=line.slice(0,colon),value=line.slice(colon+1);
    if(key==='BEGIN'){
      const parent=stack.at(-1);
      if(parent==='VCALENDAR'&&value==='VEVENT'){fields=new Map();stack.push(value);}
      else if(parent==='VCALENDAR'&&value==='VTIMEZONE'||parent==='VTIMEZONE'&&['STANDARD','DAYLIGHT'].includes(value))stack.push(value);
      else throw Error('INVALID_BLS_COMPONENT');
      continue;
    }
    if(key==='END'){
      if(stack.at(-1)!==value||stack.length===1)throw Error('INVALID_BLS_COMPONENT');
      stack.pop();
      if(value!=='VEVENT')continue;
      if(++sourceRows>=2000)throw Error('INVALID_BLS_EVENT_COUNT');
      const uid=fields.get('UID'),summary=fields.get('SUMMARY'),start=fields.get('DTSTART;TZID=US-Eastern');
      if(!uid||uid.length>200||uids.has(uid)||!summary||summary.length>300||!start||!/^\d{8}T\d{4}00$/.test(start))throw Error('INVALID_BLS_EVENT');
      uids.add(uid);
      const day=`${start.slice(0,4)}-${start.slice(4,6)}-${start.slice(6,8)}`;
      let at:number;try{at=eiaEasternTime(day,`${start.slice(9,11)}:${start.slice(11,13)}`);}catch{throw Error('INVALID_BLS_TIME');}
      const slot=`${summary}:${at}`;if(slots.has(slot))throw Error('INVALID_BLS_DUPLICATE');slots.add(slot);
      const release=Object.hasOwn(releases,summary)?releases[summary]:undefined;
      if(release&&Math.abs(at-requestedAt)<=45*86400000)events.push({at,day,release});
      continue;
    }
    if(stack.at(-1)==='VEVENT'){
      // A recurrence, revised instance, cancellation or floating/all-day start is never silently dropped.
      if(['RRULE','RDATE','EXDATE','RECURRENCE-ID','DTSTART','DTEND','DURATION','STATUS'].includes(key.split(';')[0])&&!(key==='DTSTART;TZID=US-Eastern'||key==='DURATION'&&value==='PT0M'||key==='STATUS'&&value==='CONFIRMED'))throw Error('UNSUPPORTED_BLS_SCHEDULE');
      if(fields.has(key))throw Error('INVALID_BLS_DUPLICATE_PROPERTY');fields.set(key,value);
    }else if(stack.length===1){
      if(key==='VERSION'){if(version||value!=='2.0')throw Error('INVALID_BLS_VERSION');version=true;}
      if(key==='PRODID'){if(origin||value!=='-//Department of Labor//Bureau of Labor Statistics//EN')throw Error('INVALID_BLS_ORIGIN');origin=true;}
      if(key==='METHOD'&&value!=='PUBLISH')throw Error('UNSUPPORTED_BLS_SCHEDULE');
    }
  }
  if(stack.length!==1||!version||!origin||!sourceRows)throw Error('INVALID_BLS_CALENDAR');
  // These monthly families must bracket observation within the bounded window.
  // This detects a stale/missing current feed; it is not proof of every macro release.
  for(const release of ['US_CPI','US_EMPLOYMENT','US_PPI','US_JOLTS'])if(!events.some(e=>e.release===release&&e.at<=requestedAt)||!events.some(e=>e.release===release&&e.at>requestedAt))throw Error('BLS_CURRENT_RELEASES_UNVERIFIED');
  events.sort((a,b)=>a.at-b.at||a.release.localeCompare(b.release));
  const body={source:'BLS_PUBLIC_ICS_V1' as const,requestedAt,fetchedAt,expiresAt:requestedAt+600000,url:BLS_CALENDAR_URL,payloadHash:createHash('sha256').update(data).digest('hex'),scope:'SELECTED_BLS_RELEASES_ONLY' as const,sourceRows,excludedRows:sourceRows-events.length,events};
  return {id:createHash('sha256').update(JSON.stringify(body)).digest('hex'),...body};
}
/** Supplemental public schedule. Never grants macro/commodity coverage or changes the authoritative provider. */
export class FreshBlsEvents {
  private snapshot:BlsCalendarSnapshot|null=null;private qualifiedAt:number|null=null;private failureCode:string|null=null;
  private nextAttempt=0;private inFlight:Promise<void>|null=null;
  constructor(private get:typeof axios.get=axios.get,private now:()=>number=Date.now,private persist:(s:BlsCalendarSnapshot)=>Promise<void>=async()=>{}){}
  refresh():Promise<void>{
    if(this.inFlight)return this.inFlight;if(this.now()<this.nextAttempt)return Promise.resolve();this.nextAttempt=this.now()+300000;
    this.inFlight=(async()=>{const requestedAt=this.now();try{
      const r=await this.get(BLS_CALENDAR_URL,{headers:{'User-Agent':'FNO-PaperCalendar/1.0 (+https://github.com/maknightriderr/Index-F-O-Terminal)',Accept:'text/calendar'},timeout:10000,maxRedirects:0,maxContentLength:1048576,responseType:'text'});
      if(r.status!==200)throw Error('BLS_HTTP_UNAVAILABLE');
      const s=parseBlsCalendar(r.data,requestedAt,this.now());
      try{await this.persist(s);}catch{throw Error('BLS_SNAPSHOT_PERSISTENCE_FAILED');}
      const at=this.now();if(at<s.fetchedAt||at>s.expiresAt)throw Error('BLS_PERSISTENCE_TIME_INVALID');
      this.snapshot=s;this.qualifiedAt=at;this.failureCode=null;
    }catch(error){
      this.snapshot=null;this.qualifiedAt=null;
      this.failureCode=axios.isAxiosError(error)?error.response?.status?`BLS_HTTP_${error.response.status}`:error.code==='ECONNABORTED'?'BLS_SOURCE_TIMEOUT':'BLS_SOURCE_NETWORK_UNAVAILABLE':error instanceof Error&&/^(?:BLS_|INVALID_BLS_|UNSUPPORTED_BLS_)[A-Z_]+$/.test(error.message)?error.message:'BLS_SOURCE_OR_PERSISTENCE_UNAVAILABLE';
    }})().finally(()=>{this.nextAttempt=this.now()+300000;this.inFlight=null;});return this.inFlight;
  }
  evidence(now:number){const s=this.snapshot;return s&&this.qualifiedAt!=null&&this.qualifiedAt<=now&&s.fetchedAt<=now&&now<=s.expiresAt?{...s,qualifiedAt:this.qualifiedAt,events:s.events.map(e=>({...e}))}:null;}
  blackout(now:number){return this.evidence(now)?.events.some(e=>Math.abs(e.at-now)<=900000)?'BLS_RELEASE_BLACKOUT':null;}
  view(){const s=this.evidence(this.now());return {source:'BLS_PUBLIC_ICS_V1',status:s?'SELECTED_RELEASE_SCHEDULE_OBSERVED':this.snapshot&&this.now()>this.snapshot.expiresAt?'BLS_SCHEDULE_STALE':this.failureCode?'BLS_SOURCE_OR_PERSISTENCE_UNAVAILABLE':'BLS_SCHEDULE_UNAVAILABLE',failureCode:this.failureCode,snapshotId:s?.id??null,fetchedAt:s?.fetchedAt??null,expiresAt:s?.expiresAt??null,nextAttemptAt:this.nextAttempt,nextReleaseAt:s?.events.find(e=>e.at>this.now())?.at??null,eventCount:s?.events.length??null,completeMacroCoverage:false};}
}
