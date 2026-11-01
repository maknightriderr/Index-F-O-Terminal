import React from 'react';
import type {FreshResearchReadiness} from '@fno/shared';
import {formatIstDateTime} from '@/lib/format';
export function ResearchReadiness({report}:{report:FreshResearchReadiness|null|undefined}){
 if(report===undefined)return null;
 if(report===null)return <p className="mt-4 text-xs text-[var(--warning)]">Research inventory unavailable; dataset coverage and protocol registration are not verified.</p>;
 const p=report.protocol;
 return <section aria-label="Research preparation" className="mt-4 rounded border border-[var(--border)] p-3 text-xs">
  <h4 className="font-semibold">Research preparation · performance unvalidated</h4>
  <p className="mt-1">{p.id} · {p.registered?'Protocol registered before collection':'Protocol registration not verified'} · {p.version}</p>
  <p className="mt-1 text-[var(--text-secondary)]">Inventory observed {formatIstDateTime(report.observedAt)} IST. Existing data is classified below; table presence does not qualify a backtest.</p>
  <div className="mt-2 overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Research data inventory</caption><thead><tr>{['Source','Data present','Estimated rows','Evidence / limitation'].map(h=><th key={h} scope="col" className="p-2">{h}</th>)}</tr></thead><tbody>{report.sources.map(s=><tr key={s.table} className="border-t border-[var(--border)]"><th scope="row" className="p-2 font-medium">{s.table}</th><td className="p-2">{!s.available?'Table unavailable':s.hasRows?'Rows observed':'Empty'}</td><td className="p-2">{s.estimatedRows==null?'Unknown':s.estimatedRows.toLocaleString()}</td><td className="p-2">{s.evidence}<span className="block text-[var(--text-secondary)]">{s.limit}</span></td></tr>)}</tbody></table></div>
  <dl className="mt-3 grid gap-2 sm:grid-cols-3"><div><dt className="font-medium">Development (IST)</dt><dd>{formatIstDateTime(Date.parse(p.captureStart))} → {formatIstDateTime(Date.parse(p.developmentEnd))}</dd></div><div><dt className="font-medium">Validation ends (IST)</dt><dd>{formatIstDateTime(Date.parse(p.validationEnd))}</dd></div><div><dt className="font-medium">Prospective holdout ends (IST)</dt><dd>{formatIstDateTime(Date.parse(p.holdoutEnd))}</dd></div></dl>
  <p className="mt-2 text-[var(--warning)]">Holdout blindness is not enforced by the visible paper dashboard. Previously viewed outcomes cannot be claimed untouched.</p>
  <p className="mt-2">Pending: {report.blockers.map(b=>b.replaceAll('_',' ')).join(' · ')}</p>
  <p className="mt-2 text-[var(--text-secondary)]">{p.note} {report.note}</p>
 </section>;
}
