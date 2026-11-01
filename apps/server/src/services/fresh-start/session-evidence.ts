import {getSessionWindow,HOLIDAY_CALENDAR_YEARS,type FreshSessionEvidence} from '@fno/shared';
import {FRESH_MARKETS,freshMarketExchange,type FreshMarket} from './markets.js';
import {inspectFreshLedger} from './integrity.js';
const object=(x:unknown):Record<string,any>=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:{};
const label=(x:unknown,fallback:string)=>typeof x==='string'&&x.length>0?x:fallback;
/** Bounded, read-only coverage of recorded lifecycles. Counts are evidence, never promotion criteria. */
export function freshSessionEvidence(input:readonly unknown[]):FreshSessionEvidence {
  const sample=input.slice(0,100),cohorts=new Map<string,FreshSessionEvidence['cohorts'][number]>();
  let unclassified=0;
  for(const raw of sample){
    const r=object(raw),p=object(r.state),contract=object(p.contract),calendar=object(object(contract.evidence).eventCalendar);
    const market=contract.market as FreshMarket;
    if(!FRESH_MARKETS.includes(market)){unclassified++;continue;}
    const strategy=label(r.strategy,'STRATEGY_UNRECORDED'),policyId=label(object(calendar.policy).id,'LEGACY_EVENT_POLICY_UNRECORDED'),evidenceClass=label(object(calendar.coverage).evidenceClass,'EVENT_POLICY_UNRECORDED');
    const key=JSON.stringify([market,strategy,policyId,evidenceClass]);
    let cohort=cohorts.get(key);
    if(!cohort){cohort={market,strategy,policyId,evidenceClass,sampled:0,entryOnly:0,pending:0,closed:0,incomplete:0,inconsistent:0,sessionTimingUnproven:0,consistentSessionClosed:0,sessions:[]};cohorts.set(key,cohort);}
    cohort.sampled++;
    const checked=inspectFreshLedger(r);
    if(checked.verdict==='INCOMPLETE')cohort.incomplete++;
    if(checked.verdict==='INCONSISTENT')cohort.inconsistent++;
    if(r.status==='OPEN')cohort.entryOnly++;
    if(r.status==='EXIT_PENDING')cohort.pending++;
    if(r.status==='CLOSED')cohort.closed++;
    const day=r.session;
    // Verify date round-trip before calendar lookup; JS normalizes impossible dates.
    const validDay=typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day&&HOLIDAY_CALENDAR_YEARS.includes(Number(day.slice(0,4)));
    const window=validDay?getSessionWindow(freshMarketExchange(market),day):null;
    const entry=p.openedAt,exit=p.lastEventAt;
    const inside=window!==null&&object(p.candidate).session===day&&object(object(r.entry_evidence).request).session===day&&typeof entry==='number'&&Number.isFinite(entry)&&entry>=window.open&&entry<window.close&&(r.status!=='CLOSED'||(typeof exit==='number'&&Number.isFinite(exit)&&exit>=entry&&exit<=window.close));
    if(!inside)cohort.sessionTimingUnproven++;
    if(inside&&r.status==='CLOSED'&&checked.verdict==='CONSISTENT'){
      cohort.consistentSessionClosed++;
      if(!cohort.sessions.includes(day))cohort.sessions.push(day);
    }
  }
  const rows=[...cohorts.values()].sort((a,b)=>JSON.stringify([a.market,a.strategy,a.policyId,a.evidenceClass]).localeCompare(JSON.stringify([b.market,b.strategy,b.policyId,b.evidenceClass])));
  for(const c of rows)c.sessions.sort();
  return {version:'FRESH_SESSION_EVIDENCE_V1',scope:'LATEST_100_CURRENT_VERSION',sampled:sample.length,sampleTruncated:input.length>100,unclassified,markets:FRESH_MARKETS.map(market=>({market,sampled:rows.filter(c=>c.market===market).reduce((n,c)=>n+c.sampled,0),consistentSessionClosed:rows.filter(c=>c.market===market).reduce((n,c)=>n+c.consistentSessionClosed,0)})),cohorts:rows,note:'Newest 100 recorded positions only; sessions are distinct dates within each strategy/event cohort, not statistically independent samples. Consistent session records do not certify unit semantics, model calibration, full tape capture, actual execution or profitability. No automatic qualification or rule changes.'};
}
