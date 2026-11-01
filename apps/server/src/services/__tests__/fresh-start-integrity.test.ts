import {describe,it,expect} from 'vitest';
import {freshSessionEvidence} from '../fresh-start/session-evidence.js';
import {inspectFreshLedger,freshIntegrityReport} from '../fresh-start/integrity.js';
const at=Date.parse('2026-11-02T06:00:00Z');
function row(closed=false,multiplier=1,quantity=25){
  const contract={id:'NSE_FO:1',market:'NSE_INDEX_OPTIONS',source:'ANGEL',sourceEpoch:'entry-epoch',lotQuantity:quantity,multiplier,metadataVerified:true,modelVerified:true,feesVerified:true,explicitRoundTripCostPerUnit:1,evidence:{eventCalendar:{policy:{id:'PAPER_EVENT_UNVERIFIED_V1',allowMissingMacroCoverage:true},coverage:{evidenceClass:'EVENT_DATA_UNVERIFIED',waived:['BLOCKED_EVENT_PROVIDER_CONFIGURATION']}}}};
  const quote={contract:contract.id,source:'ANGEL',epoch:'entry-epoch',eventAt:at+300,receivedAt:at+300,bid:99.9,ask:100,askUnits:1000,bidUnits:1000,tick:.05};
  const candidate={version:'NEW-INTRADAY-1.3',strategy:'NEW_ORB_RETEST_V1',at,expiresAt:at+2000};
  const admission={quantity,entry:100.05,initialRiskCurrency:100,emergencyStop:75,explicitCostPerUnit:1,premiumCurrency:100.05*quantity*multiplier};
  const state:any={id:'one',contract:structuredClone(contract),candidate,quantity,entry:admission.entry,originalRiskCurrency:100,emergencyStop:75,currentStop:75,openedAt:at+300,lastEventAt:at+300,state:'OPEN',exitPrice:null,netPnl:null,exitTriggeredAt:null};
  const entry={request:{quote,contract,candidate,capital:500000,now:at+300,arrivalAt:at+250},admission};
  const r:any={id:'one',strategy:candidate.strategy,version:candidate.version,status:'OPEN',revision:0,state,reserved_risk:100,reserved_premium:admission.premiumCurrency,opened_at:new Date(at+300),closed_at:null,net_pnl:null,entry_kind:'ENTRY_FILL',entry_at:new Date(at+300),entry_evidence:entry,last_kind:'ENTRY_FILL',last_at:new Date(at+300),last_evidence:entry};
  if(closed){const decision=at+2000,exit={...quote,eventAt:decision,receivedAt:decision,bid:120,ask:120.1};state.state=r.status='CLOSED';state.lastEventAt=decision;state.exitTriggeredAt=at+1000;state.exitReason='TARGET';state.exitPrice=119.95;state.estimatedFees=quantity*multiplier;state.netPnl=(state.exitPrice-state.entry)*quantity*multiplier-state.estimatedFees;r.net_pnl=state.netPnl;r.closed_at=new Date(decision);r.last_at=new Date(decision);r.last_kind='EXIT_FILL';r.last_evidence={at:decision,quote:exit};r.revision=2;}
  return r;
}
describe('recorded paper-ledger consistency, not execution certification',()=>{
 it('distinguishes entry-only consistency from a completed lifecycle without treating the approved event warning as a defect',()=>{expect(inspectFreshLedger(row())).toMatchObject({verdict:'CONSISTENT',phase:'ENTRY_ONLY',eventEvidenceClass:'EVENT_DATA_UNVERIFIED'});expect(inspectFreshLedger(row(true))).toMatchObject({verdict:'CONSISTENT',phase:'CLOSED'});expect(freshIntegrityReport([row(),row(true)])).toMatchObject({sampled:2,consistent:2,closedChecked:1});});
 it('validates full premium multipliers rather than assuming one broker quantity equals one premium unit',()=>{expect(inspectFreshLedger(row(true,100,1)).verdict).toBe('CONSISTENT');const r=row(true,100,1);r.state.contract.multiplier=1;expect(inspectFreshLedger(r).issues).toContain('FROZEN_MULTIPLIER_CHANGED');});
 it('detects early/stale/mismatched/depth-ineligible entry quotes',()=>{for(const change of [(r:any)=>r.entry_evidence.request.arrivalAt=at+100,(r:any)=>r.entry_evidence.request.quote.receivedAt=at+200,(r:any)=>r.entry_evidence.request.quote.epoch='other',(r:any)=>r.entry_evidence.request.quote.askUnits=1,(r:any)=>r.state.entry=100]){const r=row();change(r);expect(inspectFreshLedger(r).verdict).toBe('INCONSISTENT');}});
 it('rejects invalid recorded stops/costs, explicit qualification failures and a drifting latest-event timestamp',()=>{for(const change of [(r:any)=>{r.state.emergencyStop=r.entry_evidence.admission.emergencyStop=-1;},(r:any)=>r.state.contract.metadataVerified=false,(r:any)=>{r.state.contract.explicitRoundTripCostPerUnit=r.entry_evidence.admission.explicitCostPerUnit=-1;},(r:any)=>r.state.lastEventAt+=1000]){const r=row();change(r);expect(inspectFreshLedger(r).verdict).toBe('INCONSISTENT');}});
 it('detects non-whole lots, changed frozen risk, planned risk-cap breaches and incorrect reserved premium',()=>{for(const change of [(r:any)=>r.state.quantity=26,(r:any)=>r.state.originalRiskCurrency=0,(r:any)=>r.entry_evidence.request.capital=1000,(r:any)=>r.reserved_premium=1,(r:any)=>r.state.currentStop=70]){const r=row();change(r);expect(inspectFreshLedger(r).verdict).toBe('INCONSISTENT');}});
 it('detects altered fee/P&L math even if state and row both report the same incorrect profit',()=>{const r=row(true);r.state.netPnl=r.net_pnl=99999;expect(inspectFreshLedger(r).issues).toContain('NET_PNL_ARITHMETIC_MISMATCH');const fee=row(true);fee.state.estimatedFees=0;fee.state.netPnl=fee.net_pnl=(fee.state.exitPrice-fee.state.entry)*fee.state.quantity;expect(inspectFreshLedger(fee).issues).toContain('FROZEN_FEE_MODEL_MISMATCH');});
 it('detects missing terminal evidence and quote/latency/depth failures while accepting a documented monitor reconnect epoch',()=>{const r=row(true);r.last_evidence.monitorEpoch=r.last_evidence.quote.epoch='monitor-reconnected';expect(inspectFreshLedger(r).verdict).toBe('CONSISTENT');for(const change of [(r:any)=>r.last_evidence.quote.receivedAt=at+1100,(r:any)=>r.last_evidence.quote.bidUnits=1,(r:any)=>r.state.exitPrice=121,(r:any)=>r.last_evidence.quote.contract='wrong']){const x=row(true);change(x);expect(inspectFreshLedger(x).verdict).toBe('INCONSISTENT');}const x=row(true);x.last_evidence={};expect(inspectFreshLedger(x).verdict).toBe('INCOMPLETE');});
 it('keeps a pending exit unresolved rather than inventing profit or a completed lifecycle',()=>{const r=row();r.state.state=r.status='EXIT_PENDING';r.state.exitTriggeredAt=at+500;r.last_kind='EXIT_PENDING';r.last_evidence={at:at+1000,quote:null};r.state.lastEventAt=at+1000;r.last_at=new Date(at+1000);r.revision=1;expect(inspectFreshLedger(r)).toMatchObject({verdict:'CONSISTENT',phase:'EXIT_PENDING'});r.net_pnl=0;expect(inspectFreshLedger(r).issues).toContain('UNFINISHED_POSITION_HAS_REALIZED_RESULT');});
 it('detects changed/lost event provenance, treats absent legacy labels as unrecorded, and never mutates evidence',()=>{const r=row();r.state.contract.evidence.eventCalendar.policy.id='changed';expect(inspectFreshLedger(r).issues).toContain('FROZEN_EVENT_POLICY_CHANGED');delete r.state.contract.evidence.eventCalendar.policy;expect(inspectFreshLedger(r).missing).toContain('FROZEN_EVENT_POLICY_EVIDENCE_MISSING');const old=row();delete old.state.contract.evidence;delete old.entry_evidence.request.contract.evidence;const before=JSON.stringify(old);expect(inspectFreshLedger(old).eventEvidenceClass).toBe('EVENT_POLICY_UNRECORDED');expect(JSON.stringify(old)).toBe(before);});
 it('reports malformed/missing history as incomplete and exposes the bounded sample without claiming all history passed',()=>{expect(inspectFreshLedger({})).toMatchObject({verdict:'INCOMPLETE'});expect(freshIntegrityReport([])).toMatchObject({sampled:0,consistent:0});expect(freshIntegrityReport(Array.from({length:101},()=>row()))).toMatchObject({sampled:100,sampleTruncated:true,closedChecked:0});});
});


describe('bounded recorded market-session evidence',()=>{
 const sessionRow=(closed=false)=>{const r={...row(closed),session:'2026-11-02'};r.state.candidate.session=r.entry_evidence.request.session=r.session;return r;};
 it('shows all four markets with no completed evidence for empty or entry-only samples',()=>{
   const empty=freshSessionEvidence([]);expect(empty.markets).toHaveLength(4);expect(empty.markets.every(m=>m.consistentSessionClosed===0)).toBe(true);
   const r=freshSessionEvidence([sessionRow()]);expect(r.cohorts[0]).toMatchObject({entryOnly:1,closed:0,consistentSessionClosed:0,sessions:[]});
 });
 it('separates event classes, policies, strategies and markets; repeated dates are not independent sessions',()=>{
   const a=sessionRow(true),b=sessionRow(true),c=sessionRow(true),d=sessionRow(true),e=sessionRow(true);
   c.state.contract.evidence.eventCalendar.coverage.evidenceClass=c.entry_evidence.request.contract.evidence.eventCalendar.coverage.evidenceClass='EVENT_COVERAGE_VERIFIED';
   d.state.contract.evidence.eventCalendar.policy.id=d.entry_evidence.request.contract.evidence.eventCalendar.policy.id='other-policy';
   e.strategy=e.state.candidate.strategy='OTHER_STRATEGY';
   const report=freshSessionEvidence([a,b,c,d,e]);expect(report.cohorts).toHaveLength(4);expect(report.cohorts.find(x=>x.sampled===2)).toMatchObject({consistentSessionClosed:2,sessions:['2026-11-02']});
   const bse=sessionRow(true);bse.state.contract.market=bse.entry_evidence.request.contract.market='BSE_VERIFIED_OPTIONS';
   expect(freshSessionEvidence([a,bse]).markets.filter(x=>x.sampled>0)).toHaveLength(2);
 });
 it('withholds consistent session counts for corrupt P&L, missing proof and invalid session timing',()=>{
   const corrupt=sessionRow(true);corrupt.net_pnl=99999;
   const missing=sessionRow(true);missing.entry_evidence={};
   for(const day of ['2026-11-01','2026-02-30','2035-11-02','invalid',undefined]){
     const bad=sessionRow(true);bad.session=day;
     const result=freshSessionEvidence([corrupt,missing,bad]);expect(result.cohorts[0]).toMatchObject({inconsistent:1,incomplete:1,sessionTimingUnproven:2,consistentSessionClosed:0,sessions:[]});
   }
   const late=sessionRow(true);late.state.lastEventAt=Date.parse('2026-11-02T12:00:00Z');
   expect(freshSessionEvidence([late]).cohorts[0]).toMatchObject({sessionTimingUnproven:1,consistentSessionClosed:0});
 });
 it('does not assign unknown markets to NSE, backfill missing labels or count older records',()=>{
   const unknown=sessionRow(true);delete unknown.state.contract.market;
   const legacy=sessionRow(true);delete legacy.state.contract.evidence;delete legacy.entry_evidence.request.contract.evidence;
   const before=JSON.stringify(legacy);const r=freshSessionEvidence([unknown,legacy]);expect(r.unclassified).toBe(1);expect(r.cohorts[0]).toMatchObject({policyId:'LEGACY_EVENT_POLICY_UNRECORDED',evidenceClass:'EVENT_POLICY_UNRECORDED'});expect(JSON.stringify(legacy)).toBe(before);
   expect(freshSessionEvidence(Array.from({length:101},()=>sessionRow(true)))).toMatchObject({sampled:100,sampleTruncated:true});
 });
});
