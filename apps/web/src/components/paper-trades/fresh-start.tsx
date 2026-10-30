'use client';
import React, { useEffect, useState } from 'react';
import type { FreshStartStatus } from '@fno/shared';
import { api } from '@/lib/api';
import { Section } from '@/components/ui/card';
import { formatIstDateTime } from '@/lib/format';
const names: Record<string, string> = { NEW_ORB_RETEST_V1: 'Opening range retest', NEW_VWAP_PULLBACK_V1: 'VWAP pullback', NEW_PREVIOUS_SESSION_SWEEP_V1: 'Previous-session sweep', NEW_FIRST_OPENING_PULLBACK_V1: 'First opening pullback' };
const money = (v: number | null) => v == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(v);
export function FreshStartPanel() {
    const [data, setData] = useState<FreshStartStatus | null>(null), [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        const load = () => api.getFreshStartStatus().then(x => {
            if (active) {
                setData(x);
                setError(null);
            }
        }).catch(() => {
            if (active)
                setError('Fresh-start status is unavailable. Entry state cannot be verified.');
        });
        void load();
        const timer = setInterval(() => void load(), 30000);
        return () => { active = false; clearInterval(timer); };
    }, []);
    return <Section title="Fresh start · Options buying" subtitle="Separate paper cohort. Results use completed quote-backed fills after estimated costs; candidates are not trades.">
    {error && <p role="alert" className="text-sm text-[var(--warning)]">{error}</p>}
    {!data && !error && <p className="text-sm text-[var(--text-secondary)]">Loading fresh-start status…</p>}
    {data && <>
      <div className="flex flex-wrap gap-2 text-xs font-semibold" aria-label="Fresh-start state">
        <span className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">{data.enabled ? 'Paper entries enabled' : 'New paper entries disabled'}</span>
        <span className="rounded border border-[var(--border)] px-3 py-2">Legacy entries {data.legacyNewEntries ? 'enabled' : 'retired'} · held-trade exits preserved</span>
        <span className="rounded border border-[var(--border)] px-3 py-2">{data.version} · Unvalidated</span>
      </div>
      <p className="mt-3 text-sm text-[var(--text-secondary)]">Implementation approved. Paper activation is pending. Capital: {money(data.capital)}. A high win rate is an objective to test, with no performance guarantee.</p>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Fresh strategy validation and net paper profit and loss</caption><thead><tr className="border-b border-[var(--border)] text-xs text-[var(--text-secondary)]">{['Strategy', 'State', 'Fills / closed', 'Wins / losses / flat', 'Open / pending', 'Net P&L', 'Net R / trade', 'Win rate', 'Sessions', 'Validation'].map(x => <th key={x} scope="col" className="whitespace-nowrap p-2">{x}</th>)}</tr></thead><tbody>{data.performance.map(r => <tr key={r.strategy} className="border-b border-[var(--border)]"><th scope="row" className="p-2 font-medium">{names[r.strategy] ?? r.strategy}</th><td className="p-2">{data.strategies.find(s => s.id === r.strategy)?.enabled ? 'Enabled' : 'Disabled'}</td><td className="p-2">{r.filled} / {r.closed}</td><td className="p-2">{r.wins} / {r.losses} / {r.flat}</td><td className="p-2">{r.open} / {r.pending}</td><td className="whitespace-nowrap p-2">{money(r.netPnl)}</td><td className="p-2">{r.expectancyR == null ? '—' : r.expectancyR.toFixed(2)}</td><td className="p-2">{r.winRate == null ? '—' : `${(r.winRate * 100).toFixed(1)}%`}</td><td className="p-2">{r.independentSessions}</td><td className="p-2">Not validated</td></tr>)}</tbody></table></div>
      <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">Activation requirements ({data.blockers.length})</summary><ul className="mt-2 space-y-1 text-xs text-[var(--text-secondary)]">{data.blockers.map(b => <li key={b}>{b.replaceAll('_', ' ')}</li>)}</ul></details>
      {(data.reviews?.length ?? 0) > 0 && <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">Automatic fresh-start reviews · explanation only</summary><ul className="mt-2 space-y-3">{data.reviews.map(r => <li key={r.position_id}><p className="text-xs text-[var(--text-secondary)]">{r.status} · {r.position_id}</p><p className="whitespace-pre-wrap">{r.response?.text ?? 'Queued for automatic review. Provider limits are retried automatically.'}</p></li>)}</ul></details>}
      {data.candidates.length > 0 && <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">Recent candidate decisions</summary><ul className="mt-2 space-y-1 text-xs">{data.candidates.map(c => <li key={c.id}>{formatIstDateTime(Date.parse(c.at), Date.now())} · {names[c.strategy] ?? c.strategy} · {c.decision} · {c.code}</li>)}</ul></details>}
    </>}
  </Section>;
}
