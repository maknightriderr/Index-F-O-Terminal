import React from 'react';
import type {FreshStartStatus} from '@fno/shared';
import {formatIstDateTime} from '@/lib/format';

export function PublicCalendarSources({sources,now}:{sources:NonNullable<FreshStartStatus['eventSources']>;now:number}){
  const rows=[...(sources.publicMacro?[{...sources.publicMacro,label:'US inflation and labour · BLS'}]:[]),...(sources.commodity??[]).map(s=>({...s,label:s.product==='CRUDEOIL'?'Crude Oil · EIA petroleum':'Natural Gas · EIA storage'}))];
  if(!rows.length)return null;
  const time=(at:number|null)=>at==null?'—':`${formatIstDateTime(at,now)} IST`;
  return <div className="mt-4 overflow-x-auto">
    <table className="w-full text-left text-xs"><caption className="mb-2 text-left font-medium">Public release schedules · partial event coverage</caption>
      <thead><tr className="border-b border-[var(--border)]">{['Schedule','Observation','Last fetch (IST)','Next published release (IST)','Snapshot'].map(label=><th key={label} scope="col" className="whitespace-nowrap p-2">{label}</th>)}</tr></thead>
      <tbody>{rows.map(row=>{
        const current=row.snapshotId!=null&&row.fetchedAt!=null&&row.expiresAt!=null&&row.fetchedAt<=now&&now<=row.expiresAt;
        return <tr key={row.source} className="border-b border-[var(--border)]">
          <th scope="row" className="whitespace-nowrap p-2">{row.label}</th>
          <td className="min-w-48 p-2">{current?'Observed · limited scope':row.failureCode?row.failureCode.replaceAll('_',' '):row.fetchedAt!=null?'Expired / clock mismatch':'Not yet observed'}<span className="mt-1 block text-[var(--text-secondary)]">Complete event coverage pending</span></td>
          <td className="whitespace-nowrap p-2">{time(row.fetchedAt)}</td>
          <td className="whitespace-nowrap p-2">{current?time(row.nextReleaseAt):'—'}</td>
          <td className="p-2">{row.snapshotId?<details><summary className="cursor-pointer">Observation ID</summary><code className="mt-1 block max-w-64 break-all">{row.snapshotId}</code></details>:'—'}</td>
        </tr>;
      })}</tbody>
    </table>
    <p className="mt-2 text-xs text-[var(--text-secondary)]">Source: U.S. Bureau of Labor Statistics and U.S. Energy Information Administration. These schedules cover selected releases only. They do not verify India/RBI, other macro events or complete commodity-event coverage, and do not enable paper entries.</p>
  </div>;
}
