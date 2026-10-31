import axios from 'axios';
import {createHash} from 'node:crypto';
export const OFFICIAL_MACRO_URLS={rbi:'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=62422',bea:'https://apps.bea.gov/API/signup/release_dates.json'} as const;
type Source='RBI_MPC_PLAN_2026_27_V1'|'BEA_SELECTED_RELEASES_V1';
export interface OfficialMacroSnapshot {
  id:string;source:Source;url:string;requestedAt:number;fetchedAt:number;expiresAt:number;payloadHash:string;
  scope:'PUBLISHED_MPC_MEETING_DAYS_ONLY'|'SELECTED_BEA_RELEASES_ONLY';
  events:Array<{day:string;at:number|null;precision:'DATE_ONLY'|'INSTANT';release:string}>;
  sourceRows:number;excludedRows:number;duplicateRows:number;publisherUpdatedAt?:string;
}
const istDay=(at:number)=>new Date(at).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
const validDay=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const clean=(s:string)=>s.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
function snapshot(body:Omit<OfficialMacroSnapshot,'id'|'payloadHash'|'expiresAt'>,payload:string,until=Infinity):OfficialMacroSnapshot {
  if(![body.requestedAt,body.fetchedAt].every(Number.isFinite)||body.requestedAt>body.fetchedAt||body.fetchedAt-body.requestedAt>=60000)throw Error('OFFICIAL_MACRO_INVALID_AVAILABILITY');
  const value={...body,expiresAt:Math.min(body.requestedAt+600000,until),payloadHash:createHash('sha256').update(payload).digest('hex')};
  return {id:createHash('sha256').update(JSON.stringify(value)).digest('hex'),...value};
}
/** The pinned notice publishes meeting days, NOT policy-announcement times or amendment coverage. */
export function parseRbiMpcPlan(data:unknown,requestedAt:number,fetchedAt:number):OfficialMacroSnapshot {
  if(typeof data!=='string'||Buffer.byteLength(data)>1048576||!clean(data).includes('Meeting Schedule of the Monetary Policy Committee for 2026-2027'))throw Error('RBI_PLAN_IDENTITY_UNVERIFIED');
  const html=data.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  const tables=[...html.matchAll(/<table\b[^>]*class=["']tablebg["'][^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/gi)].map(m=>m[1]).filter(t=>clean(t).includes('Dates of meetings of Monetary Policy Committee for 2026-27'));
  if(tables.length!==1)throw Error('RBI_PLAN_STRUCTURE_UNVERIFIED');
  const rows=[...tables[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>clean(m[1]));
  if(rows.length!==7||rows[0]!=='Dates of meetings of Monetary Policy Committee for 2026-27')throw Error('RBI_PLAN_MEETINGS_UNVERIFIED');
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const events:OfficialMacroSnapshot['events']=[];let last='';
  for(const row of rows.slice(1)){
    const m=/^(\w+) (\d{1,2}), (\d{1,2}) and (\d{1,2}), (\d{4})$/.exec(row);
    if(!m||!months.includes(m[1])||Number(m[3])!==Number(m[2])+1||Number(m[4])!==Number(m[3])+1)throw Error('RBI_PLAN_MEETINGS_UNVERIFIED');
    for(const dayNumber of m.slice(2,5)){
      const day=`${m[5]}-${String(months.indexOf(m[1])+1).padStart(2,'0')}-${dayNumber.padStart(2,'0')}`;
      if(!validDay(day)||day<'2026-04-01'||day>'2027-03-31'||day<=last)throw Error('RBI_PLAN_DATES_UNVERIFIED');
      events.push({day,at:null,precision:'DATE_ONLY',release:'RBI_MPC_MEETING_DAY'});last=day;
    }
  }
  const today=istDay(requestedAt);if(today<'2026-04-01'||today>'2027-03-31'||!events.some(e=>e.day<today)||!events.some(e=>e.day>=today))throw Error('RBI_PLAN_CURRENT_RANGE_UNVERIFIED');
  return snapshot({source:'RBI_MPC_PLAN_2026_27_V1',url:OFFICIAL_MACRO_URLS.rbi,requestedAt,fetchedAt,scope:'PUBLISHED_MPC_MEETING_DAYS_ONLY',sourceRows:6,excludedRows:0,duplicateRows:0,events},data,Date.parse('2027-04-01T00:00:00+05:30')-1);
}
/** Official BEA UTC timestamps; no next-month recurrence or timezone assumption. */
export function parseBeaReleases(data:unknown,requestedAt:number,fetchedAt:number):OfficialMacroSnapshot {
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length>100)throw Error('BEA_CALENDAR_INVALID_RESPONSE');
  const selected:Record<string,string>={'Gross Domestic Product':'US_GDP','Personal Income and Outlays':'US_PERSONAL_INCOME_OUTLAYS'};
  const events:OfficialMacroSnapshot['events']=[];let sourceRows=0,duplicateRows=0;
  let publisherUpdatedAt:string|undefined;
  for(const [title,value] of Object.entries(data)){
    if(title==='file_last_updated'){
      if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/.test(value)||!validDay(value.slice(0,10))||value.slice(0,10)>new Date(requestedAt).toISOString().slice(0,10))throw Error('BEA_PUBLICATION_METADATA_INVALID');
      publisherUpdatedAt=value;continue; // Published without a zone: retain verbatim, never assign a UTC availability time.
    }
    const dates=(value as {release_dates?:unknown})?.release_dates;
    if(!Array.isArray(dates)||dates.length>1000)throw Error('BEA_CALENDAR_INVALID_ROWS');
    const seen=new Set<number>();
    for(const raw of dates){
      sourceRows++;if(sourceRows>10000||typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00(?:Z|\+00:00)$/.test(raw)||!validDay(raw.slice(0,10)))throw Error('BEA_CALENDAR_INVALID_TIME');
      const at=Date.parse(raw);if(!Number.isFinite(at))throw Error('BEA_CALENDAR_INVALID_TIME');
      if(seen.has(at)){duplicateRows++;continue;}seen.add(at);
      if(Object.hasOwn(selected,title)&&Math.abs(at-requestedAt)<=45*86400000)events.push({day:istDay(at),at,precision:'INSTANT',release:selected[title]});
    }
  }
  for(const release of Object.values(selected))if(!events.some(e=>e.release===release&&e.at!<=requestedAt)||!events.some(e=>e.release===release&&e.at!>requestedAt))throw Error('BEA_CURRENT_RELEASES_UNVERIFIED');
  events.sort((a,b)=>a.at!-b.at!||a.release.localeCompare(b.release));
  return snapshot({source:'BEA_SELECTED_RELEASES_V1',url:OFFICIAL_MACRO_URLS.bea,requestedAt,fetchedAt,scope:'SELECTED_BEA_RELEASES_ONLY',sourceRows,excludedRows:sourceRows-events.length,duplicateRows,publisherUpdatedAt,events},JSON.stringify(data));
}
export class FreshOfficialMacroEvents {
  private snapshots=new Map<Source,OfficialMacroSnapshot>();private qualified=new Map<Source,number>();private failures=new Map<Source,string>();
  private inFlight:Promise<void>|null=null;private nextAttempt=0;
  constructor(private get:typeof axios.get=axios.get,private now:()=>number=Date.now,private persist:(s:OfficialMacroSnapshot)=>Promise<void>=async()=>{}){}
  refresh():Promise<void>{
    if(this.inFlight)return this.inFlight;if(this.now()<this.nextAttempt)return Promise.resolve();this.nextAttempt=this.now()+300000;
    const sources=[{id:'RBI_MPC_PLAN_2026_27_V1' as const,url:OFFICIAL_MACRO_URLS.rbi,parse:parseRbiMpcPlan},{id:'BEA_SELECTED_RELEASES_V1' as const,url:OFFICIAL_MACRO_URLS.bea,parse:parseBeaReleases}];
    this.inFlight=Promise.all(sources.map(async source=>{const requestedAt=this.now();try{
      const r=await this.get(source.url,{headers:{'User-Agent':'FNO-PaperCalendar/1.0 (+https://github.com/maknightriderr/Index-F-O-Terminal)',Accept:'application/json,text/html'},timeout:10000,maxRedirects:0,maxContentLength:1048576});
      if(r.status!==200)throw Error('OFFICIAL_MACRO_HTTP_UNAVAILABLE');
      const s=source.parse(r.data,requestedAt,this.now());try{await this.persist(s);}catch{throw Error('OFFICIAL_MACRO_PERSISTENCE_FAILED');}
      const qualifiedAt=this.now();if(qualifiedAt<s.fetchedAt||qualifiedAt>s.expiresAt)throw Error('OFFICIAL_MACRO_PERSISTENCE_TIME_INVALID');
      this.snapshots.set(source.id,s);this.qualified.set(source.id,qualifiedAt);this.failures.delete(source.id);
    }catch(error){
      this.snapshots.delete(source.id);this.qualified.delete(source.id);
      const code=axios.isAxiosError(error)?error.response?.status?`OFFICIAL_MACRO_HTTP_${error.response.status}`:error.code==='ECONNABORTED'?'OFFICIAL_MACRO_TIMEOUT':'OFFICIAL_MACRO_NETWORK_UNAVAILABLE':error instanceof Error&&/^(?:RBI_|BEA_|OFFICIAL_MACRO_)[A-Z_]+$/.test(error.message)?error.message:'OFFICIAL_MACRO_SOURCE_UNAVAILABLE';this.failures.set(source.id,code);
    }})).then(()=>{}).finally(()=>{this.nextAttempt=this.now()+300000;this.inFlight=null;});return this.inFlight;
  }
  evidence(now:number){return [...this.snapshots.values()].filter(s=>{const q=this.qualified.get(s.source);return q!=null&&q<=now&&s.fetchedAt<=now&&now<=s.expiresAt;}).map(s=>({...s,qualifiedAt:this.qualified.get(s.source)!,events:s.events.map(e=>({...e}))}));}
  blockers(now:number){const today=istDay(now),codes:string[]=[];for(const s of this.evidence(now))for(const e of s.events){if(e.precision==='DATE_ONLY'&&e.day===today)codes.push('RBI_MEETING_TIME_UNCERTAIN');if(e.precision==='INSTANT'&&e.at!=null&&Math.abs(e.at-now)<=900000)codes.push('BEA_RELEASE_BLACKOUT');}return [...new Set(codes)];}
  view(){return (['RBI_MPC_PLAN_2026_27_V1','BEA_SELECTED_RELEASES_V1'] as const).map(source=>{const s=this.evidence(this.now()).find(s=>s.source===source),next=s?.events.find(e=>e.precision==='DATE_ONLY'?e.day>=istDay(this.now()):e.at!>this.now());return {source,status:s?'LIMITED_OFFICIAL_SCHEDULE_OBSERVED':this.snapshots.has(source)&&this.now()>this.snapshots.get(source)!.expiresAt?'OFFICIAL_MACRO_SCHEDULE_STALE':this.failures.has(source)?'OFFICIAL_MACRO_SOURCE_UNAVAILABLE':'OFFICIAL_MACRO_NOT_OBSERVED',failureCode:this.failures.get(source)??null,snapshotId:s?.id??null,fetchedAt:s?.fetchedAt??null,expiresAt:s?.expiresAt??null,nextAttemptAt:this.nextAttempt,nextReleaseAt:next?.at??null,nextEventDay:next?.day??null,eventCount:s?.events.length??null,completeMacroCoverage:false};});}
}
