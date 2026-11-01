import {FRESH_RISK_PER_TRADE,freshQuoteCode,freshRoundTripFees,type FreshQuote,type FreshFeePolicy} from '@fno/analytics';
const record=(x:unknown):Record<string,any>=>x!=null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:{};
const number=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
const time=(x:unknown)=>x instanceof Date?x.getTime():number(x)?x:typeof x==='string'?Date.parse(x):NaN;
const close=(a:unknown,b:unknown)=>number(a)&&number(b)&&Math.abs(a-b)<=1e-6;
export interface FreshIntegrityRow {id:string;contract:string;positionStatus:string;verdict:'CONSISTENT'|'INCOMPLETE'|'INCONSISTENT';phase:'ENTRY_ONLY'|'EXIT_PENDING'|'CLOSED';eventEvidenceClass:string;issues:string[];missing:string[];}
/** Read-only first/latest-event consistency checks. Never reconstructs fills or certifies actual execution/profitability. */
export function inspectFreshLedger(input:unknown):FreshIntegrityRow {
  const r=record(input),p=record(r.state),k=record(p.contract),c=record(p.candidate),entry=record(r.entry_evidence),request=record(entry.request),initialContract=record(request.contract),admission=record(entry.admission),q=record(request.quote),last=record(r.last_evidence);
  const issues:string[]=[],missing:string[]=[];
  const present=(ok:boolean,code:string)=>{if(!ok)missing.push(code);return ok;};
  const compare=(a:unknown,b:unknown,code:string)=>{if(number(a)&&number(b)){if(!close(a,b))issues.push(code);}else missing.push(`${code}_EVIDENCE_MISSING`);};
  const calendar=record(record(k.evidence).eventCalendar),coverage=record(calendar.coverage),entryCalendar=record(record(record(request.contract).evidence).eventCalendar);
  if(!Object.keys(p).length)missing.push('POSITION_STATE_MISSING');
  if(!['OPEN','EXIT_PENDING','CLOSED'].includes(r.status))missing.push('POSITION_STATUS_UNRECOGNIZED');
  compare(p.lastEventAt,time(r.last_at),'LATEST_EVENT_TIME_MISMATCH');
  for(const [a,b,code] of [[p.id,r.id,'POSITION_ID_MISMATCH'],[c.version,r.version,'STRATEGY_VERSION_MISMATCH'],[c.strategy,r.strategy,'STRATEGY_ID_MISMATCH'],[p.state,r.status,'POSITION_STATUS_MISMATCH']]){
    if(typeof a!=='string'||typeof b!=='string')missing.push(`${code}_EVIDENCE_MISSING`);else if(a!==b)issues.push(code);
  }
  if(r.entry_kind!=='ENTRY_FILL')missing.push('ENTRY_FILL_EVENT_MISSING');
  if(!Object.keys(last).length)missing.push('LATEST_EVENT_EVIDENCE_MISSING');
  const sized=present(number(p.quantity)&&p.quantity>0&&Number.isInteger(p.quantity)&&number(k.lotQuantity)&&k.lotQuantity>0&&Number.isInteger(k.lotQuantity)&&number(k.multiplier)&&k.multiplier>0,'SIZING_EVIDENCE_MISSING');
  for(const field of ['id','source','sourceEpoch','market']){
    if(typeof k[field]==='string'&&typeof initialContract[field]==='string'){if(k[field]!==initialContract[field])issues.push(`FROZEN_CONTRACT_${field.toUpperCase()}_CHANGED`);}else missing.push(`FROZEN_CONTRACT_${field.toUpperCase()}_MISSING`);
  }
  for(const field of ['metadataVerified','modelVerified','feesVerified']){if(k[field]===false||initialContract[field]===false)issues.push('CONTRACT_NOT_QUALIFIED_AT_FILL');else if(k[field]!==true||initialContract[field]!==true)missing.push('CONTRACT_QUALIFICATION_EVIDENCE_MISSING');}
  compare(k.lotQuantity,initialContract.lotQuantity,'FROZEN_LOT_QUANTITY_CHANGED');compare(k.multiplier,initialContract.multiplier,'FROZEN_MULTIPLIER_CHANGED');
  if(JSON.stringify(Object.entries(record(k.feePolicy)).sort())!==JSON.stringify(Object.entries(record(initialContract.feePolicy)).sort()))issues.push('FROZEN_FEE_POLICY_CHANGED');
  compare(k.explicitRoundTripCostPerUnit,admission.explicitCostPerUnit,'FROZEN_INITIAL_COST_CHANGED');
  compare(r.reserved_premium,admission.premiumCurrency,'ENTRY_RESERVED_PREMIUM_CHANGED');
  if(sized&&p.quantity%k.lotQuantity!==0)issues.push('NON_WHOLE_LOT_QUANTITY');
  compare(p.quantity,admission.quantity,'ENTRY_QUANTITY_CHANGED');compare(p.entry,admission.entry,'ENTRY_PREMIUM_CHANGED');
  compare(p.originalRiskCurrency,admission.initialRiskCurrency,'INITIAL_RISK_CHANGED');compare(p.originalRiskCurrency,r.reserved_risk,'RESERVED_RISK_MISMATCH');
  compare(p.emergencyStop,admission.emergencyStop,'INITIAL_PREMIUM_STOP_CHANGED');
  if(number(p.emergencyStop)&&number(p.entry)&&(p.emergencyStop<0||p.emergencyStop>=p.entry))issues.push('INITIAL_PREMIUM_STOP_INVALID');
  present(number(p.currentStop),'CURRENT_PREMIUM_STOP_MISSING');
  if(number(admission.explicitCostPerUnit)&&admission.explicitCostPerUnit<0)issues.push('NEGATIVE_MODELED_COST');
  if(number(p.currentStop)&&number(p.emergencyStop)&&p.currentStop<p.emergencyStop)issues.push('PREMIUM_STOP_LOOSENED');
  if(sized&&number(p.entry))compare(p.entry*p.quantity*k.multiplier,r.reserved_premium,'RESERVED_PREMIUM_MISMATCH');
  if(present(number(request.capital)&&request.capital>0&&number(p.originalRiskCurrency)&&p.originalRiskCurrency>0,'RISK_CAP_EVIDENCE_MISSING')&&p.originalRiskCurrency>request.capital*FRESH_RISK_PER_TRADE+1e-6)issues.push('PLANNED_RISK_CAP_EXCEEDED');
  compare(p.openedAt,request.now,'ENTRY_DECISION_TIME_MISMATCH');compare(p.openedAt,time(r.entry_at),'ENTRY_EVENT_TIME_MISMATCH');compare(p.openedAt,time(r.opened_at),'ENTRY_ROW_TIME_MISMATCH');
  if(present(number(request.arrivalAt)&&number(c.at),'ENTRY_ARRIVAL_EVIDENCE_MISSING')){
    if(request.arrivalAt<c.at+250||!number(q.eventAt)||!number(q.receivedAt)||q.eventAt<request.arrivalAt||q.receivedAt<request.arrivalAt)issues.push('ENTRY_BEFORE_ALLOWED_ARRIVAL');
  }
  if(Object.keys(q).length&&typeof k.id==='string'&&typeof k.source==='string'&&typeof k.sourceEpoch==='string'&&number(p.openedAt)){
    if(freshQuoteCode(q as FreshQuote,k.id,k.source,k.sourceEpoch,p.openedAt)!==null)issues.push('ENTRY_QUOTE_INELIGIBLE');
    compare(p.entry,q.ask+q.tick,'ENTRY_ASK_TICK_MISMATCH');if(sized&&q.askUnits<p.quantity)issues.push('ENTRY_DEPTH_INSUFFICIENT');
  }else missing.push('ENTRY_QUOTE_IDENTITY_MISSING');
  if(number(c.expiresAt)&&number(p.openedAt)&&p.openedAt>c.expiresAt)issues.push('ENTRY_AFTER_SETUP_EXPIRY');
  const policy=record(calendar.policy),entryPolicy=record(entryCalendar.policy),entryCoverage=record(entryCalendar.coverage);
  if(typeof policy.id==='string'||typeof entryPolicy.id==='string'){if(typeof policy.id!=='string'||typeof entryPolicy.id!=='string')missing.push('FROZEN_EVENT_POLICY_EVIDENCE_MISSING');else if(policy.id!==entryPolicy.id)issues.push('FROZEN_EVENT_POLICY_CHANGED');}
  if(typeof coverage.evidenceClass==='string'||typeof entryCoverage.evidenceClass==='string'){if(typeof coverage.evidenceClass!=='string'||typeof entryCoverage.evidenceClass!=='string')missing.push('FROZEN_EVENT_CLASS_EVIDENCE_MISSING');else if(coverage.evidenceClass!==entryCoverage.evidenceClass)issues.push('FROZEN_EVENT_CLASS_CHANGED');}
  if(coverage.evidenceClass==='EVENT_DATA_UNVERIFIED'&&(policy.allowMissingMacroCoverage!==true||!Array.isArray(coverage.waived)||coverage.waived.length===0))issues.push('UNVERIFIED_EVENT_EXCEPTION_UNRECORDED');
  const closed=r.status==='CLOSED',pending=r.status==='EXIT_PENDING';
  if(closed){
    if(number(p.estimatedFees)&&p.estimatedFees<0)issues.push('NEGATIVE_CLOSED_FEES');
    present(typeof p.exitReason==='string'&&p.exitReason.length>0,'EXIT_REASON_MISSING');
    if(r.last_kind!=='EXIT_FILL')missing.push('EXIT_FILL_EVENT_MISSING');
    const exit=record(last.quote),decision=last.at;
    if(Object.keys(exit).length&&number(decision)&&typeof k.id==='string'&&typeof k.source==='string'){
      if(freshQuoteCode(exit as FreshQuote,k.id,k.source,last.monitorEpoch??k.sourceEpoch,decision)!==null)issues.push('EXIT_QUOTE_INELIGIBLE');
      if(sized&&exit.bidUnits<p.quantity)issues.push('EXIT_DEPTH_INSUFFICIENT');
      if(!number(p.exitTriggeredAt)||exit.receivedAt<p.exitTriggeredAt+250||exit.eventAt<p.exitTriggeredAt+250)issues.push('EXIT_BEFORE_ALLOWED_ARRIVAL');
      compare(p.exitPrice,Math.max(0,exit.bid-exit.tick),'EXIT_BID_TICK_MISMATCH');
      compare(decision,time(r.closed_at),'CLOSE_ROW_TIME_MISMATCH');compare(decision,time(r.last_at),'EXIT_EVENT_TIME_MISMATCH');compare(decision,p.lastEventAt,'LATEST_OBSERVATION_TIME_MISMATCH');
    }else missing.push('EXIT_QUOTE_EVIDENCE_MISSING');
    if(number(p.estimatedFees)&&number(p.entry)&&number(p.exitPrice)&&sized){
      try{
        const modeled=initialContract.feePolicy?freshRoundTripFees(p.entry,p.exitPrice,p.quantity,k.multiplier,initialContract.feePolicy as FreshFeePolicy):admission.explicitCostPerUnit*p.quantity*k.multiplier;
        if(number(modeled))compare(p.estimatedFees,modeled,'FROZEN_FEE_MODEL_MISMATCH');else missing.push('FROZEN_FEE_MODEL_MISSING');
      }catch{missing.push('FROZEN_FEE_MODEL_MISSING');}
      compare(p.netPnl,(p.exitPrice-p.entry)*p.quantity*k.multiplier-p.estimatedFees,'NET_PNL_ARITHMETIC_MISMATCH');compare(p.netPnl,r.net_pnl,'NET_PNL_ROW_MISMATCH');
    }else missing.push('NET_PNL_COST_EVIDENCE_MISSING');
  }else{
    if(p.netPnl!=null||p.exitPrice!=null||r.net_pnl!=null||r.closed_at!=null)issues.push('UNFINISHED_POSITION_HAS_REALIZED_RESULT');
    if(pending){if(!number(p.exitTriggeredAt))missing.push('EXIT_TRIGGER_EVIDENCE_MISSING');if(r.last_kind!=='EXIT_PENDING')issues.push('PENDING_EXIT_EVENT_MISMATCH');}
    else if(!['ENTRY_FILL','OBSERVATION'].includes(r.last_kind))missing.push('OPEN_LATEST_EVENT_MISSING');
  }
  return {id:typeof r.id==='string'?r.id:'UNAVAILABLE',contract:typeof k.id==='string'?k.id:'UNAVAILABLE',positionStatus:typeof r.status==='string'?r.status:'UNAVAILABLE',verdict:issues.length?'INCONSISTENT':missing.length?'INCOMPLETE':'CONSISTENT',phase:closed?'CLOSED':pending?'EXIT_PENDING':'ENTRY_ONLY',eventEvidenceClass:typeof coverage.evidenceClass==='string'?coverage.evidenceClass:'EVENT_POLICY_UNRECORDED',issues:[...new Set(issues)],missing:[...new Set(missing)]};
}
export function freshIntegrityReport(input:readonly unknown[]){
  const rows=input.slice(0,100).map(inspectFreshLedger);
  return {version:'FRESH_LEDGER_CONSISTENCY_V1',scope:'LATEST_100_CURRENT_VERSION' as const,sampled:rows.length,sampleTruncated:input.length>100,consistent:rows.filter(r=>r.verdict==='CONSISTENT').length,incomplete:rows.filter(r=>r.verdict==='INCOMPLETE').length,inconsistent:rows.filter(r=>r.verdict==='INCONSISTENT').length,closedChecked:rows.filter(r=>r.verdict==='CONSISTENT'&&r.phase==='CLOSED').length,rows,note:'Recorded first/latest ledger evidence only. This does not prove all intermediate observations, first-quote completeness, actual broker fills, charges or profitability.'};
}
