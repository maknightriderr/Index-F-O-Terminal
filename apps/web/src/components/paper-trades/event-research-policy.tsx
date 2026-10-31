import React from 'react';
import type {FreshStartStatus} from '@fno/shared';
const labels:Record<string,string>={EVENT_DATA_UNVERIFIED:'Event data unverified',EVENT_COVERAGE_VERIFIED:'Event coverage verified',EVENT_POLICY_UNRECORDED:'Earlier event policy unrecorded'};
const obj=(v:unknown):Record<string,unknown>=>v!=null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const money=(n:number|null)=>n==null?'—':new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(n);
export function EventResearchPolicy({data,names}:{data:FreshStartStatus;names:Record<string,string>}){
  const research=data.eventPolicy?.allowMissingMacroCoverage;
  const rows=(data.eventCohorts??[]).flatMap(c=>c.performance.filter(p=>p.filled>0).map(p=>({...p,policyId:c.policyId,evidenceClass:c.evidenceClass})));
  if(!research&&!rows.length)return null;
  return <div className="mt-4 space-y-3">
    {research&&<div role="status" aria-label="Paper event policy" className="rounded border border-[var(--warning)] bg-[var(--bg-elevated)] p-3 text-sm">
      <p className="font-semibold">Paper research · incomplete event coverage allowed</p>
      <p className="mt-1">Missing macro/commodity calendar coverage does not block paper entries. Affected fills carry EVENT_DATA_UNVERIFIED. Known release blackouts and uncertain meeting days still block entries.</p>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">No paid calendar key is required. Quote freshness, lot/depth units, costs, position limits, stock issuer/corporate-action checks and exits remain mandatory. Other qualification gates can still prevent a trade.</p>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">Missing events can expose trades to sudden reversals, changing spreads and IV crush. These paper results do not establish performance with a complete event filter or real execution.</p>
    </div>}
    {rows.length>0?<div className="overflow-x-auto"><table className="w-full text-left text-xs"><caption className="mb-2 text-left font-medium">Paper results by event evidence cohort</caption>
      <thead><tr className="border-b border-[var(--border)]">{['Event evidence','Strategy','Fills / closed','Net P&L','Net R / trade','Win rate'].map(t=><th key={t} scope="col" className="whitespace-nowrap p-2">{t}</th>)}</tr></thead>
      <tbody>{rows.map(r=><tr key={`${r.policyId}:${r.evidenceClass}:${r.strategy}`} className="border-b border-[var(--border)]"><th scope="row" className="p-2" title={r.policyId}>{labels[r.evidenceClass]??r.evidenceClass}</th><td className="p-2">{names[r.strategy]??r.strategy}</td><td className="p-2">{r.filled} / {r.closed}</td><td className="whitespace-nowrap p-2">{money(r.netPnl)}</td><td className="p-2">{r.expectancyR==null?'—':r.expectancyR.toFixed(2)}</td><td className="p-2">{r.winRate==null?'—':`${(r.winRate*100).toFixed(1)}%`}</td></tr>)}</tbody>
    </table></div>:<p className="text-xs text-[var(--text-secondary)]">No fresh fills recorded yet. Event-evidence cohorts will be shown separately when paper trades fill.</p>}
    <p className="text-xs text-[var(--text-secondary)]">The strategy overview combines event cohorts for account visibility. Use the separate cohorts for comparisons; unverified event research is not an event-qualified validation sample.</p>
    {(data.positions?.length??0)>0&&<details className="text-xs"><summary className="cursor-pointer font-medium">Recent paper fills · event labels</summary><ul className="mt-2 space-y-1">{data.positions.slice(0,20).map((p,i)=>{const state=obj(p.state),contract=obj(state.contract),calendar=obj(obj(contract.evidence).eventCalendar),coverage=obj(calendar.coverage),evidence=typeof coverage.evidenceClass==='string'?coverage.evidenceClass:'EVENT_POLICY_UNRECORDED';return <li key={typeof state.id==='string'?state.id:i}>{names[p.strategy]??p.strategy} · {p.version} · {typeof contract.id==='string'?contract.id:'Contract unavailable'} · {p.status} · <strong>{evidence}</strong></li>;})}</ul>{data.positions.length>20&&<p className="mt-1">Showing the newest 20 of {data.positions.length}{data.positionsTruncated?'+':''} returned positions.</p>}</details>}
  </div>;
}
