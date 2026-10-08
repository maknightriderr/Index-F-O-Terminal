'use client';

// ============================================================
// SIGNAL DIAGNOSTICS — Order Blocks (OB-2.0) and Order Flow / OF1, shadow
// ============================================================
// What the repaired order-block detector would have done beside the live
// vote, how much Dhan order flow arrived (and whether its delta is exact or
// inferred), and every OF1 candidate — none of which trades.
// ============================================================

import React, { useEffect, useState } from 'react';
import { api, type DiagnosticsFilter } from '@/lib/api';

/** Mirrors apps/server/src/services/order-flow-metrics.ts orderFlowReport(). */
export interface OrderFlowReport {
  note: string;
  settings: { orderBlockMode: string; of1Enabled: boolean; of1Trading: boolean; orderFlowSymbols: string[] };
  feed: { status: string; deltaMode: string; deltaModeReason: string; instruments: Record<string, { tradingSymbol: string }>; packets: number; trades: number; lastPacketAt: number | null; lastError: string | null };
  flowBars: Array<{ deltaMode: string; unavailableReason: string | null; bars: number }>;
  of1: {
    candidates: number; bullish: number; bearish: number; exact: number; inferred: number; wouldTradeIfLive: number;
    graded: number; targets: number; stops: number; openAtClose: number; avgR: number | null; avgMfeR: number | null; avgMaeR: number | null; existingTradedSameBar: number;
    bySubtype: Array<{ subtype: string; n: number; avgR: number | null }>;
    existingWinners: Array<{ source: string; n: number }>;
  };
  orderBlocks: {
    byState: Array<{ state: string; n: number; held: number; failed: number; avgMfeAtr: number | null; avgMaeAtr: number | null }>;
    decisions: number; legacySignals: number; v2Signals: number; wouldChangeIndicatorDirection: number;
  };
}

const muted = 'text-gray-500 light:text-slate-500';
const fmt = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toFixed(d));

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className={`text-[10px] uppercase tracking-wide ${muted}`}>{label}</div>
      <div className="text-base font-semibold tabular-nums text-gray-100 light:text-slate-900">{value}</div>
      {hint && <div className={`text-[10px] ${muted}`}>{hint}</div>}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (rows.length === 0) return <p className={`text-xs italic ${muted}`}>Nothing recorded yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className={muted}>{head.map((h) => <th key={h} className="text-left font-medium py-1 pr-3 whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody className="text-gray-300 light:text-slate-700">
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-800/60 light:border-slate-100">{r.map((c, j) => <td key={j} className="py-1 pr-3 whitespace-nowrap">{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OrderFlowPanel({ filter }: { filter: DiagnosticsFilter }) {
  const [data, setData] = useState<OrderFlowReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(filter);
  useEffect(() => {
    let cancelled = false;
    api
      .getOrderFlowReport(filter)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(e?.message ?? 'Could not load the order-flow report.'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (error) return <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</div>;
  if (!data) return null;
  const { feed, of1, orderBlocks: ob } = data;
  const bars = (mode: string) => data.flowBars.filter((b) => b.deltaMode === mode).reduce((a, b) => a + b.bars, 0);
  return (
    <section className="bg-gray-900/40 light:bg-white border border-gray-800/60 light:border-slate-200 rounded-lg p-4 space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-gray-200 light:text-slate-800">Order blocks and order flow (shadow)</h3>
        <p className={`text-[11px] ${muted}`}>
          Recorded beside the live system, never traded. Order blocks: {data.settings.orderBlockMode}; OF1: {data.settings.of1Enabled ? 'recording' : 'off'}, trading {data.settings.of1Trading ? 'on' : 'off'}.
        </p>
      </header>

      <div className="space-y-2">
        <h4 className={`text-[11px] uppercase tracking-wide ${muted}`}>Repaired order blocks (OB-2.0) vs the live vote</h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Decision bars" value={ob.decisions} />
          <Stat label="Live (old) vote fired" value={ob.legacySignals} />
          <Stat label="OB-2.0 signals" value={ob.v2Signals} />
          <Stat label="Would change direction" value={ob.wouldChangeIndicatorDirection} hint="if OB-2.0 replaced the old vote" />
        </div>
        <Table
          head={['Block state', 'Blocks', 'Held ≥ 1 ATR', 'Failed', 'Avg MFE (ATR)', 'Avg MAE (ATR)']}
          rows={ob.byState.map((r) => [r.state, r.n, r.held, r.failed, fmt(r.avgMfeAtr), fmt(r.avgMaeAtr)])}
        />
      </div>

      <div className="space-y-2">
        <h4 className={`text-[11px] uppercase tracking-wide ${muted}`}>Dhan order-flow feed</h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Feed" value={feed.status} hint={Object.values(feed.instruments).map((i) => i.tradingSymbol).join(', ') || undefined} />
          <Stat label="Bars: exact delta" value={bars('EXACT')} />
          <Stat label="Bars: inferred delta" value={bars('INFERRED')} hint="sides inferred from bid / ask — not exchange delta" />
          <Stat label="Bars: unavailable" value={bars('UNAVAILABLE')} />
        </div>
        <p className={`text-[11px] ${muted}`}>{feed.deltaModeReason}{feed.lastError ? ` Last error: ${feed.lastError}` : ''}</p>
      </div>

      <div className="space-y-2">
        <h4 className={`text-[11px] uppercase tracking-wide ${muted}`}>OF1 — order flow confirmation (shadow)</h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Candidates" value={of1.candidates} hint={`${of1.bullish} bullish · ${of1.bearish} bearish`} />
          <Stat label="Would trade if live" value={of1.wouldTradeIfLive} />
          <Stat label="Graded: avg R" value={fmt(of1.avgR)} hint={`${of1.targets} target · ${of1.stops} stop · ${of1.openAtClose} open`} />
          <Stat label="An existing engine traded the same bar" value={of1.existingTradedSameBar} hint={`of ${of1.graded} graded`} />
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Table head={['Subtype', 'Candidates', 'Avg R']} rows={of1.bySubtype.map((r) => [r.subtype, r.n, fmt(r.avgR)])} />
          <Table head={['Existing winner on the same bar', 'Times']} rows={of1.existingWinners.map((r) => [r.source, r.n])} />
        </div>
      </div>
    </section>
  );
}
