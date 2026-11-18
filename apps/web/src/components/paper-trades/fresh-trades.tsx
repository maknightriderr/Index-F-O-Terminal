'use client';

// ============================================================
// NEW-ENGINE PAPER TRADES — one row per trade: date, strategy, contract, result and why (owner, 18 Nov)
// ============================================================
// Read from the fresh-start status positions exactly as the server stored them; nothing is recomputed except
// net R (net P&L over the risk reserved at entry) and the plain-language result.
// ============================================================

import React from 'react';
import { istDateLabel, paperReasonText, paperResult } from '@fno/shared';
import { ResultBadge } from '@/components/ui/status-badge';
import { formatIstTime } from '@/lib/format';

interface FreshState { candidate?: { direction?: string }; contract?: { id?: string }; entry?: number; exitPrice?: number; exitReason?: string; netPnl?: number; originalRiskCurrency?: number; openedAt?: number }
interface Row { strategy: string; status: string; state: unknown }

const money = (v: number | null) => (v == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format(v));

export function freshTradeRows(positions: readonly Row[], names: Record<string, string>) {
  return positions.map((p) => {
    const st = ((typeof p.state === 'string' ? JSON.parse(p.state) : p.state) ?? {}) as FreshState;
    const open = p.status !== 'CLOSED', net = typeof st.netPnl === 'number' ? st.netPnl : null, risk = st.originalRiskCurrency ?? 0;
    const netR = net != null && risk > 0 ? Math.round((net / risk) * 100) / 100 : null;
    return {
      openedAt: st.openedAt ?? null, strategy: names[p.strategy] ?? p.strategy, contract: st.contract?.id ?? '—', direction: st.candidate?.direction ?? null,
      entry: st.entry ?? null, exit: st.exitPrice ?? null, net: open ? null : net, netR: open ? null : netR,
      result: paperResult({ open, netR, netPnl: net }), reason: open ? null : paperReasonText(st.exitReason),
    };
  }).sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
}

export function FreshTrades({ positions, names }: { positions: readonly Row[]; names: Record<string, string> }) {
  const rows = freshTradeRows(positions, names);
  if (!rows.length) return <p className="mt-4 text-sm text-[var(--text-secondary)]">No new-engine paper trade yet.</p>;
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="mb-2 text-left font-medium">Paper trades · new engine ({rows.length})</caption>
        <thead><tr className="border-b border-[var(--border)] text-xs text-[var(--text-secondary)]">{['Date', 'Strategy', 'Contract', 'Entry → exit', 'Net P&L', 'Net R', 'Result'].map((h) => <th key={h} className="py-2 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-[var(--border)] align-top">
              <td className="whitespace-nowrap py-2 pr-3">{r.openedAt ? <>{istDateLabel(r.openedAt)}<div className="text-xs text-[var(--text-secondary)]">{formatIstTime(r.openedAt, false)}</div></> : '—'}</td>
              <td className="py-2 pr-3">{r.strategy}{r.direction && <div className="text-xs text-[var(--text-secondary)]">{r.direction === 'BULLISH' ? '▲ bullish' : '▼ bearish'}</div>}</td>
              <td className="py-2 pr-3 font-mono text-xs">{r.contract}</td>
              <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{r.entry ?? '—'} → {r.exit ?? '—'}</td>
              <td className={`whitespace-nowrap py-2 pr-3 tabular-nums ${r.net == null ? '' : r.net > 0 ? 'text-[var(--status-ok)]' : r.net < 0 ? 'text-[var(--status-bad)]' : ''}`}>{money(r.net)}</td>
              <td className="py-2 pr-3 tabular-nums">{r.netR == null ? '—' : `${r.netR > 0 ? '+' : ''}${r.netR}R`}</td>
              <td className="py-2 pr-3"><ResultBadge result={r.result} reason={r.reason} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">Simulated paper trades after estimated costs. EXPIRED = closed without its stop or target (time, session end or an invalidated setup).</p>
    </div>
  );
}
