import React from 'react';
import type {FreshStartStatus} from '@fno/shared';
export function LedgerIntegrity({report}:{report:FreshStartStatus['integrity']}){
  if(!report)return null;
  return <section aria-label="Recorded paper-fill consistency" className="mt-4 rounded border border-[var(--border)] p-3 text-xs">
    <h4 className="font-semibold">Recorded paper-fill consistency</h4>
    <p className="mt-1 text-[var(--text-secondary)]">Latest {report.sampled} current-version records · consistent {report.consistent} · incomplete evidence {report.incomplete} · inconsistent {report.inconsistent} · consistent closed records {report.closedChecked}</p>
    {report.sampled===0?<p className="mt-2">No filled paper records have been checked yet.</p>:<details className="mt-2"><summary className="cursor-pointer font-medium">Inspect recorded checks</summary><div className="mt-2 overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Recent recorded paper ledger checks</caption><thead><tr className="border-b border-[var(--border)]">{['Position / contract','Lifecycle','Recorded consistency','Event evidence','Issues / missing proof'].map(h=><th key={h} scope="col" className="whitespace-nowrap p-2">{h}</th>)}</tr></thead><tbody>{report.rows.map(r=><tr key={r.id} className="border-b border-[var(--border)]"><th scope="row" className="max-w-64 break-all p-2 font-medium">{r.id}<span className="block">{r.contract}</span></th><td className="whitespace-nowrap p-2">{r.positionStatus} · {r.phase.replaceAll('_',' ')}</td><td className="p-2">{r.verdict}</td><td className="p-2">{r.eventEvidenceClass}</td><td className="min-w-56 p-2">{[...r.issues,...r.missing].map(x=>x.replaceAll('_',' ')).join(' · ')||'Recorded checks agree; sample limitations apply'}</td></tr>)}</tbody></table></div></details>}
    {report.sampleTruncated&&<p className="mt-2 text-[var(--warning)]">Only the newest 100 records are reviewed here; older history is outside this sample.</p>}
    <p className="mt-2 text-[var(--text-secondary)]">{report.note} This report is read-only and does not change entries, exits, history or account counters.</p>
  </section>;
}
