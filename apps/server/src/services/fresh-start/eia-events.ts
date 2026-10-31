import axios from 'axios';
import {createHash} from 'node:crypto';
export const EIA_URLS={oil:'https://www.eia.gov/petroleum/supply/weekly/includes/wpsr-calendar.json',gas:'https://ir.eia.gov/ngs/ngs.html',gasSchedule:'https://ir.eia.gov/ngs/schedule.html'} as const;
type Product='CRUDEOIL'|'NATURALGAS';
export interface EiaCalendarSnapshot {id:string;source:'EIA_WPSR_PUBLIC_V1'|'EIA_WNGSR_PUBLIC_V1';product:Product;requestedAt:number;fetchedAt:number;expiresAt:number;urls:string[];payloadHash:string;events:Array<{at:number;day:string}>;scope:'SINGLE_EIA_WEEKLY_REPORT_ONLY';sourceQuality:{sourceRows:number;excludedOutOfWindowRows:number;excludedRelationshipWarnings:number};}
const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
const isoDay=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const ny=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
/** Exact IANA-zone roundtrip; rejects ambiguous/nonexistent wall times rather than guessing DST. */
export function eiaEasternTime(day:string,time:string):number {
  if(!isoDay(day)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('INVALID_EIA_TIME');
  const base=Date.parse(`${day}T${time}:00Z`),matches=[4,5].map(hours=>base+hours*3600000).filter(at=>{const p=Object.fromEntries(ny.formatToParts(at).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`===day&&`${p.hour}:${p.minute}`===time;});
  if(matches.length!==1)throw Error('AMBIGUOUS_EIA_TIME');return matches[0];
}
function englishDay(value:string){const m=/^(\w+) (\d{1,2}), (\d{4})$/.exec(value);if(!m||!months.includes(m[1]))throw Error('INVALID_EIA_DATE');const day=`${m[3]}-${String(months.indexOf(m[1])+1).padStart(2,'0')}-${m[2].padStart(2,'0')}`;if(!isoDay(day))throw Error('INVALID_EIA_DATE');return day;}
function clock(value:string){const m=/^(\d{1,2}):([0-5]\d) ([ap])\.m\.$/.exec(value);if(!m||Number(m[1])<1||Number(m[1])>12)throw Error('INVALID_EIA_TIME');return `${String(Number(m[1])%12+(m[3]==='p'?12:0)).padStart(2,'0')}:${m[2]}`;}
const text=(s:string)=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
function cleanHtml(s:unknown){if(typeof s!=='string'||s.length>1048576)throw Error('INVALID_EIA_HTML');return s.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');}
function snapshot(product:Product,events:EiaCalendarSnapshot['events'],requestedAt:number,fetchedAt:number,payload:string,sourceQuality={sourceRows:events.length,excludedOutOfWindowRows:0,excludedRelationshipWarnings:0}):EiaCalendarSnapshot {
  if(![requestedAt,fetchedAt].every(Number.isFinite)||requestedAt>fetchedAt||fetchedAt-requestedAt>=60000)throw Error('INVALID_EIA_AVAILABILITY');
  const sorted=events.sort((a,b)=>a.at-b.at);if(new Set(sorted.map(x=>x.at)).size!==sorted.length||!sorted.some(x=>x.at<=requestedAt)||!sorted.some(x=>x.at>requestedAt))throw Error('EIA_SCHEDULE_DOES_NOT_BRACKET_NOW');
  const body={source:product==='CRUDEOIL'?'EIA_WPSR_PUBLIC_V1' as const:'EIA_WNGSR_PUBLIC_V1' as const,product,requestedAt,fetchedAt,expiresAt:requestedAt+600000,urls:product==='CRUDEOIL'?[EIA_URLS.oil]:[EIA_URLS.gas,EIA_URLS.gasSchedule],payloadHash:createHash('sha256').update(payload).digest('hex'),events:sorted.filter(x=>Math.abs(x.at-requestedAt)<=14*86400000),scope:'SINGLE_EIA_WEEKLY_REPORT_ONLY' as const,sourceQuality};
  if(!body.events.some(x=>x.at<=requestedAt)||!body.events.some(x=>x.at>requestedAt))throw Error('STALE_EIA_SCHEDULE');
  return {id:createHash('sha256').update(JSON.stringify(body)).digest('hex'),...body};
}
/** Official explicit-date JSON, not a locally synthesized Wednesday recurrence. */
export function parseEiaPetroleum(data:unknown,requestedAt:number,fetchedAt:number){
  if(!Array.isArray(data)||data.length<4||data.length>=1000)throw Error('INVALID_EIA_CALENDAR');
  const rows:Array<{at:number;day:string;next:string;dataGap:number}>=[];
  for(const row of data){
    if(!row||typeof row!=='object'||!isoDay(row.release_date)||!isoDay(row.next_release_date)||!isoDay(row.data_for_date)||typeof row.release_time!=='string'||typeof row.holiday_delayed!=='boolean'||row.holiday_name!==null&&typeof row.holiday_name!=='string'||!Number.isSafeInteger(row.blackout_minutes)||row.blackout_minutes<0||row.blackout_minutes>120||row.data_for_date>=row.release_date||row.next_release_date<=row.release_date||Date.parse(row.next_release_date)-Date.parse(row.release_date)>14*86400000)throw Error('INVALID_EIA_CALENDAR_ROW');
    rows.push({at:eiaEasternTime(row.release_date,row.release_time),day:row.release_date,next:row.next_release_date,dataGap:Date.parse(row.release_date)-Date.parse(row.data_for_date)});
  }
  // This observer qualifies only a bounded current window. Old supplemental/revision rows
  // are not a linear historical release calendar; retain their warnings instead of using them.
  const active=rows.filter(x=>Math.abs(x.at-requestedAt)<=14*86400000);
  for(let i=0;i<active.length;i++)if(active[i].dataGap>14*86400000||i>0&&active[i-1].next!==active[i].day)throw Error('INVALID_EIA_CURRENT_RELEASE_CHAIN');
  const excludedRelationshipWarnings=rows.filter((x,i)=>!active.includes(x)&&(x.dataGap>14*86400000||i>0&&rows[i-1].next!==x.day)).length;
  return snapshot('CRUDEOIL',active.map(({at,day})=>({at,day})),requestedAt,fetchedAt,JSON.stringify(data),{sourceRows:rows.length,excludedOutOfWindowRows:rows.length-active.length,excludedRelationshipWarnings});
}
/** Next gas date comes from the current report; only its published standard/holiday schedule supplies its time. */
export function parseEiaNaturalGas(report:unknown,schedule:unknown,requestedAt:number,fetchedAt:number){
  const html=cleanHtml(report),calendar=cleanHtml(schedule),paragraphs=[...html.matchAll(/<h2\b[^>]*>\s*Weekly Natural Gas Storage Report\s*<\/h2>\s*<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  if(paragraphs.length!==1||!text(calendar).includes('10:30 a.m. eastern time on Thursdays')||!text(calendar).includes('All times are eastern.'))throw Error('INVALID_EIA_GAS_HEADER');
  const fields=/^for week ending (\w+ \d{1,2}, \d{4}) \| Released: (\w+ \d{1,2}, \d{4}) at (\d{1,2}:[0-5]\d [ap]\.m\.) \| Next Release: (\w+ \d{1,2}, \d{4})$/.exec(text(paragraphs[0][1]));if(!fields)throw Error('INVALID_EIA_GAS_DATES');
  const overrides=new Map<string,string>(),years=new Set<string>();
  for(const row of calendar.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const cells=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>text(x[1]));if(!cells.length)continue;
    if(cells.length!==4)throw Error('INVALID_EIA_GAS_SCHEDULE');
    const day=englishDay(cells[0].replace(/ - \(Updated\)$/,''));if(overrides.has(day)||!cells[3]||new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long'}).format(Date.parse(day+'T12:00:00Z'))!==cells[1])throw Error('INVALID_EIA_GAS_SCHEDULE');
    overrides.set(day,clock(cells[2]));years.add(day.slice(0,4));
  }
  const dataDay=englishDay(fields[1]),releasedDay=englishDay(fields[2]),nextDay=englishDay(fields[4]);
  if(!years.has(nextDay.slice(0,4))||!years.has(releasedDay.slice(0,4))||dataDay>=releasedDay||Date.parse(releasedDay)-Date.parse(dataDay)>14*86400000||nextDay<=releasedDay||Date.parse(nextDay)-Date.parse(releasedDay)>14*86400000)throw Error('EIA_GAS_RANGE_UNVERIFIED');
  const time=overrides.get(nextDay)??(new Date(nextDay+'T12:00:00Z').getUTCDay()===4?'10:30':null);if(!time)throw Error('EIA_GAS_RELEASE_TIME_UNVERIFIED');
  return snapshot('NATURALGAS',[{at:eiaEasternTime(releasedDay,clock(fields[3])),day:releasedDay},{at:eiaEasternTime(nextDay,time),day:nextDay}],requestedAt,fetchedAt,String(report)+'\n'+String(schedule));
}
export class FreshEiaEvents {
  private snapshots=new Map<Product,EiaCalendarSnapshot>();private qualified=new Map<Product,number>();private failures=new Map<Product,string>();private inFlight:Promise<void>|null=null;private nextAttempt=0;
  constructor(private get:typeof axios.get=axios.get,private now:()=>number=Date.now,private persist:(s:EiaCalendarSnapshot)=>Promise<void>=async()=>{}){}
  /** At most three canonical reads each five minutes. Redirects only follow EIA's documented same-host gas release delivery. */
  refresh():Promise<void>{if(this.inFlight)return this.inFlight;if(this.now()<this.nextAttempt)return Promise.resolve();this.nextAttempt=this.now()+300000;
    const fetch=async(url:string)=>{const started=this.now();let target=url;for(let hop=0;hop<3;hop++){
      const timeout=10000-(this.now()-started);if(timeout<=0)throw Error('EIA_SOURCE_TIMEOUT');
      const r=await this.get(target,{headers:{'User-Agent':'FNO-PaperCalendar/1.0 (+https://github.com/maknightriderr/Index-F-O-Terminal)',Accept:'application/json,text/html'},timeout,maxRedirects:0,maxContentLength:1048576,validateStatus:s=>s===200||s===302});
      if(r.status===200)return r.data;
      if(r.status!==302||url!==EIA_URLS.gas||typeof r.headers?.location!=='string')throw Error('EIA_UNEXPECTED_REDIRECT');
      const next=new URL(r.headers.location,target);if(next.protocol!=='https:'||next.hostname!=='ir.eia.gov'||next.port||next.username||next.password||next.pathname!=='/secure/ngs/ngs.html')throw Error('EIA_UNEXPECTED_REDIRECT');target=next.href;
    }throw Error('EIA_REDIRECT_LIMIT');};
    this.inFlight=(async()=>{for(const product of ['CRUDEOIL','NATURALGAS'] as const){const requestedAt=this.now();try{
      const s=product==='CRUDEOIL'?parseEiaPetroleum(await fetch(EIA_URLS.oil),requestedAt,this.now()):await(async()=>{const report=await fetch(EIA_URLS.gas),schedule=await fetch(EIA_URLS.gasSchedule);return parseEiaNaturalGas(report,schedule,requestedAt,this.now());})();
      try{await this.persist(s);}catch{throw Error('EIA_SNAPSHOT_PERSISTENCE_FAILED');}const qualifiedAt=this.now();if(qualifiedAt<s.fetchedAt||qualifiedAt>s.expiresAt)throw Error('EIA_PERSISTENCE_TIME_INVALID');this.snapshots.set(product,s);this.qualified.set(product,qualifiedAt);this.failures.delete(product);
    }catch(error){this.snapshots.delete(product);this.qualified.delete(product);const code=axios.isAxiosError(error)?error.response?.status?`EIA_HTTP_${error.response.status}`:error.code==='ECONNABORTED'?'EIA_SOURCE_TIMEOUT':'EIA_SOURCE_NETWORK_UNAVAILABLE':error instanceof Error&&/^(?:EIA_|INVALID_EIA_|AMBIGUOUS_EIA_|STALE_EIA_)[A-Z_]+$/.test(error.message)?error.message:'EIA_SOURCE_OR_PERSISTENCE_UNAVAILABLE';this.failures.set(product,code);}}})().finally(()=>{this.nextAttempt=this.now()+300000;this.inFlight=null;});return this.inFlight;
  }
  evidence(now:number,product:string|null){const s=this.snapshots.get(product as Product),qualifiedAt=this.qualified.get(product as Product);return s&&qualifiedAt!=null&&qualifiedAt<=now&&s.fetchedAt<=now&&now<=s.expiresAt?{id:s.id,source:s.source,qualifiedAt,fetchedAt:s.fetchedAt,expiresAt:s.expiresAt,scope:s.scope,sourceQuality:{...s.sourceQuality},urls:[...s.urls],events:s.events.map(e=>({...e}))}:null;}
  blackout(now:number,product:string|null){const s=this.evidence(now,product);return s?.events.some(e=>Math.abs(now-e.at)<=900000)?product==='CRUDEOIL'?'EIA_PETROLEUM_BLACKOUT':'EIA_NATURAL_GAS_BLACKOUT':null;}
  view(){return (['CRUDEOIL','NATURALGAS'] as const).map(product=>{const s=this.evidence(this.now(),product);return {product,source:product==='CRUDEOIL'?'EIA_WPSR_PUBLIC_V1':'EIA_WNGSR_PUBLIC_V1',status:s?'SINGLE_REPORT_SCHEDULE_OBSERVED':this.snapshots.get(product)&&this.now()>this.snapshots.get(product)!.expiresAt?'EIA_SCHEDULE_STALE':this.failures.has(product)?'EIA_SOURCE_OR_PERSISTENCE_UNAVAILABLE':'EIA_SCHEDULE_UNAVAILABLE',failureCode:this.failures.get(product)??null,snapshotId:s?.id??null,fetchedAt:s?.fetchedAt??null,expiresAt:s?.expiresAt??null,nextReleaseAt:s?.events.find(e=>e.at>this.now())?.at??null,nextAttemptAt:this.nextAttempt,completeCommodityCoverage:false};});}
}
