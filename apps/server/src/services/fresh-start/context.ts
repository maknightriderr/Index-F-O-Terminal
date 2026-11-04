import {getSessionWindow,HOLIDAY_CALENDAR_YEARS,type Exchange,type OHLCV} from '@fno/shared';
import type {FreshBar,FreshContext} from '@fno/analytics';
export const freshIstDay=(at:number)=>new Date(at).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
export function freshExpirySessions(session:string,expiry:string,exchange:Exchange='NSE'):number|null {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(session)||!/^\d{4}-\d{2}-\d{2}$/.test(expiry)||expiry<session)return null;
  const a=Date.parse(session+'T12:00:00+05:30'),b=Date.parse(expiry+'T12:00:00+05:30');if(!Number.isFinite(a)||!Number.isFinite(b)||freshIstDay(a)!==session||freshIstDay(b)!==expiry||b-a>60*86400000||![session,expiry].every(day=>HOLIDAY_CALENDAR_YEARS.includes(Number(day.slice(0,4)))&&getSessionWindow(exchange,day)!==null))return null;
  let n=0;for(let d=a+86400000;d<=b;d+=86400000){const day=freshIstDay(d);if(!HOLIDAY_CALENDAR_YEARS.includes(Number(day.slice(0,4))))return null;if(getSessionWindow(exchange,day))n++;}return n;
}
export function freshBars(rows:readonly OHLCV[],minutes:number,receivedAt:number):FreshBar[]{
  const map=new Map<number,FreshBar>();for(const x of rows){const time=Date.parse(x.timestamp);
    if(![time,x.open,x.high,x.low,x.close,x.volume].every(Number.isFinite)||time+minutes*60000>receivedAt||x.volume<0||x.low<=0||x.high<Math.max(x.open,x.close,x.low)||x.low>Math.min(x.open,x.close))continue;
    if(map.has(time))throw Error('DUPLICATE_BROKER_CANDLE');map.set(time,{time,availableAt:receivedAt,open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume});
  }return [...map.values()].sort((a,b)=>a.time-b.time);
}
export function mergeFreshBars(old:readonly FreshBar[],incoming:readonly FreshBar[],limit:number):FreshBar[]{
  const map=new Map(old.map(x=>[x.time,x]));for(const b of incoming){const prior=map.get(b.time),same=prior&&['open','high','low','close','volume'].every(k=>prior[k as keyof FreshBar]===b[k as keyof FreshBar]);map.set(b.time,same?{...b,availableAt:prior.availableAt}:b);}return [...map.values()].sort((a,b)=>a.time-b.time).slice(-limit);
}
/** Longest run of no-trade bars filled per gap: 5 one-minute bars, 2 five-minute bars. Longer gaps stay gaps (an outage). */
export const FRESH_GAP_FILL_LIMIT:Readonly<Record<number,number>>=Object.freeze({60000:5,300000:2});
/**
 * Broker candle APIs omit a minute in which nothing traded, and the strategies require a contiguous session (MISSING_BARS
 * was the top refusal on 2 Nov: 318 of ~1,000 evaluations, mostly quiet MCX contracts). A short gap between two real
 * bars of the same session is filled with flat bars at the previous close and zero volume — what a no-trade interval is.
 * A filled bar becomes available only when the next real bar did (no lookahead). A short gap at the session open is
 * filled from the previous real close (or, with no earlier bar loaded, the first traded price). Gaps longer than the limit and the tail after the last real bar are never filled.
 */
export function fillFreshGaps(bars:readonly FreshBar[],stepMs:number,exchange:Exchange='NSE'):FreshBar[]{
  const limit=FRESH_GAP_FILL_LIMIT[stepMs]??0;if(!limit||bars.length===0)return [...bars];
  const out:FreshBar[]=[];
  for(let i=0;i<bars.length;i++){
    const b=bars[i],prev=out.at(-1),s=getSessionWindow(exchange,freshIstDay(b.time));
    if(prev&&s&&b.time>=s.open&&b.time+stepMs<=s.close){
      // Within the session: start from the previous bar of the same session, or from the open when this is the first one.
      const start=prev.time>=s.open?prev.time+stepMs:s.open,missing=(b.time-start)/stepMs;
      if(Number.isInteger(missing)&&missing>0&&missing<=limit)for(let t=start;t<b.time;t+=stepMs)out.push({time:t,availableAt:b.availableAt,open:prev.close,high:prev.close,low:prev.close,close:prev.close,volume:0});
    }else if(!prev&&s&&b.time>s.open&&b.time+stepMs<=s.close){
      // No earlier bar loaded (the minute history starts at today's open): the first traded price is the only known level.
      const missing=(b.time-s.open)/stepMs;
      if(Number.isInteger(missing)&&missing<=limit)for(let t=s.open;t<b.time;t+=stepMs)out.push({time:t,availableAt:b.availableAt,open:b.open,high:b.open,low:b.open,close:b.open,volume:0});
    }
    out.push(b);
  }
  return out;
}
export function freshTrendBars(bars:readonly FreshBar[],exchange:Exchange='NSE'):FreshBar[]{
  const groups=new Map<number,FreshBar[]>();for(const b of bars){const s=getSessionWindow(exchange,freshIstDay(b.time));if(!s||b.time<s.open||b.time+300000>s.close)continue;const t=s.open+Math.floor((b.time-s.open)/900000)*900000;groups.set(t,[...(groups.get(t)??[]),b]);}
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).filter(([t,a])=>a.length===3&&a.every((b,i)=>b.time===t+i*300000)).map(([time,a])=>({time,availableAt:Math.max(...a.map(x=>x.availableAt)),open:a[0].open,high:Math.max(...a.map(x=>x.high)),low:Math.min(...a.map(x=>x.low)),close:a[2].close,volume:a.reduce((s,x)=>s+x.volume,0)}));
}
/** Share of a session's five-minute bars the previous-day high/low needs (sweep strategy's PDH/PDL). */
export const FRESH_PREVIOUS_SESSION_COVERAGE=0.9;
/**
 * The previous session's high/low is usable when its bars cover >= 90% of the session and reach within 30 minutes of
 * both the open and the close. It used to require EVERY bar, so a quiet contract with a few no-trade intervals (or a
 * gap longer than the fill limit) lost its PDH/PDL for the whole day: SWEEP_NO_PREVIOUS_SESSION on 37% of 4 Nov sweep
 * evaluations after 12:30.
 */
export function freshPreviousSessionUsable(bars:readonly FreshBar[],s:{open:number;close:number}|null):boolean{
  if(!s||!bars.length)return false;const slots=(s.close-s.open)/300000,inside=bars.filter(x=>x.time>=s.open&&x.time+300000<=s.close&&(x.time-s.open)%300000===0);
  return inside.length>=FRESH_PREVIOUS_SESSION_COVERAGE*slots&&inside[0].time-s.open<=1800000&&s.close-(inside[inside.length-1].time+300000)<=1800000;
}
export function buildFreshReferenceContext(args:{now:number;instrument:string;sourceEpoch:string;bars5:readonly FreshBar[];bars1:readonly FreshBar[];eventClear:boolean;referenceVerified:boolean;exchange?:Exchange}):FreshContext|null {
  const exchange=args.exchange??'NSE',date=freshIstDay(args.now),session=getSessionWindow(exchange,date);if(!session||!HOLIDAY_CALENDAR_YEARS.includes(Number(date.slice(0,4))))return null;
  const five=args.bars5.filter(x=>{const d=freshIstDay(x.time),s=getSessionWindow(exchange,d);return HOLIDAY_CALENDAR_YEARS.includes(Number(d.slice(0,4)))&&s!=null&&x.time>=s.open&&x.time+300000<=s.close&&(x.time-s.open)%300000===0;});
  const historical=five.filter(x=>x.time<session.open&&x.availableAt<=args.now),byDay=new Map<string,FreshBar[]>();for(const b of historical){const d=freshIstDay(b.time);byDay.set(d,[...(byDay.get(d)??[]),b]);}
  const dates=[...byDay.keys()].sort().slice(-20),rvol:Record<number,number[]>={},opening:number[]=[];
  for(const day of dates){const s=getSessionWindow(exchange,day);if(!s)continue;const bars=byDay.get(day)!;for(const b of bars){const slot=(b.time-s.open)/300000;if(Number.isInteger(slot))(rvol[slot]??=[]).push(b.volume);}const first=bars.filter(x=>x.time<s.open+900000);if(first.length===3&&first.every((x,i)=>x.time===s.open+i*300000))opening.push(first.reduce((n,x)=>n+x.volume,0));}
  let previous:string|null=null;for(let i=1;i<=14;i++){const d=freshIstDay(Date.parse(date+'T12:00:00+05:30')-i*86400000);if(getSessionWindow(exchange,d)){previous=d;break;}}
  const ps=previous?getSessionWindow(exchange,previous):null,pd=previous?byDay.get(previous)??[]:[],complete=freshPreviousSessionUsable(pd,ps);
  return {now:args.now,session:date,sessionOpen:session.open,sessionClose:session.close,instrument:args.instrument,sourceEpoch:args.sourceEpoch,bars5:five.slice(-300),bars15:freshTrendBars(five,exchange).slice(-300),bars1:args.bars1.filter(x=>x.time>=session.open&&x.time+60000<=session.close),rvolReferences:rvol,openingVolumeReferences:opening,previousHigh:complete?Math.max(...pd.map(x=>x.high)):0,previousLow:complete?Math.min(...pd.map(x=>x.low)):0,levels:[],referenceVerified:args.referenceVerified,eventClear:args.eventClear,calendarVerified:true};
}
