'use client';

import React, { useState } from 'react';
import { formatIndianNumber } from '@fno/shared';
import type { WinRateBucket, TradeSetupRecord } from '@fno/shared';
import { useBacktesting } from '@/lib/use-backtesting';
import { useAssetTabsStore } from '@/stores';

type PeriodTab = 'daily' | 'weekly' | 'monthly' | 'yearly';

const PERIOD_LABELS: Record<PeriodTab, string> = {
  daily: 'Day-wise',
  weekly: 'Week-wise',
  monthly: 'Month-wise',
  yearly: 'Year-wise',
};

export function BacktestingPage() {
  const { analytics, history, loading, isLive } = useBacktesting();
  const [periodTab, setPeriodTab] = useState<PeriodTab>('daily');
  const openTab = useAssetTabsStore((s) => s.openTab);

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">Backtesting</h1>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            Win-rate analysis of every trade setup the system has actually generated — captured live, not simulated. Coverage grows with what gets viewed/scanned; there's no way to backfill history.
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-[11px] text-gray-500 light:text-slate-500">
          <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600 light:bg-slate-300'}`} />
          {isLive ? 'Live' : loading ? 'Loading…' : 'Unreachable'}
        </span>
      </div>

      {!isLive && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium">
          ⚠️ Backend unreachable — nothing to show right now.
        </div>
      )}

      {analytics && (
        <>
          <OverallSummary bucket={analytics.overall} />

          <div className="pt-1">
            <h2 className="text-sm font-bold text-gray-200 light:text-slate-800">Win Rate Over Time</h2>
            <p className="text-[11px] text-gray-500 light:text-slate-500 mt-0.5">Grouped by the day each setup was generated — a setup counts toward the period it opened in, not when it resolved.</p>
          </div>

          <div className="flex gap-2">
            {(Object.keys(PERIOD_LABELS) as PeriodTab[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriodTab(p)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                  periodTab === p ? 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700' : 'bg-gray-800/50 light:bg-slate-100 text-gray-400 light:text-slate-500'
                }`}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>

          <WinRateTable buckets={analytics[periodTab]} periodLabel={PERIOD_LABELS[periodTab]} />

          <div className="pt-1">
            <h2 className="text-sm font-bold text-gray-200 light:text-slate-800">By Symbol</h2>
            <p className="text-[11px] text-gray-500 light:text-slate-500 mt-0.5">Every symbol the system has generated at least one trade setup for.</p>
          </div>
          <SymbolTable symbols={analytics.bySymbol} onOpen={(s) => openTab(s, 'NSE')} />
        </>
      )}

      <div className="pt-1">
        <h2 className="text-sm font-bold text-gray-200 light:text-slate-800">Recent Trade Setups</h2>
        <p className="text-[11px] text-gray-500 light:text-slate-500 mt-0.5">Every setup the system has locked in, newest first, with its outcome once resolved.</p>
      </div>
      <TradeSetupHistoryTable history={history} loading={loading} onOpen={(s) => openTab(s, 'NSE')} />
    </div>
  );
}

// --- Shared card ---

function Card({ children, accent = 'border-t-amber-500/50' }: { children: React.ReactNode; accent?: string }) {
  return (
    <div className={`bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 ${accent} rounded-xl p-4 shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)]`}>
      {children}
    </div>
  );
}

// --- Overall summary ---

function OverallSummary({ bucket }: { bucket: WinRateBucket }) {
  if (bucket.total === 0) {
    return (
      <Card>
        <p className="text-xs text-gray-500 light:text-slate-500 py-4 text-center">
          No trade setups generated yet. They get created as soon as a symbol with a confident enough bias is viewed (or via the Institutional Flow scanner for NIFTY/BANKNIFTY) — check back after some trading activity.
        </p>
      </Card>
    );
  }

  const winRateColor = bucket.winRatePercent == null ? 'text-gray-400' : bucket.winRatePercent >= 55 ? 'text-emerald-400' : bucket.winRatePercent >= 40 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Card accent="border-t-cyan-500/50">
        <div className="text-[10px] font-semibold text-gray-500 light:text-slate-500 uppercase tracking-wider mb-1.5">Win Rate</div>
        <div className={`text-3xl font-bold tabular-nums ${winRateColor}`}>{bucket.winRatePercent != null ? `${bucket.winRatePercent}%` : '—'}</div>
        <div className="text-[10px] text-gray-500 light:text-slate-500 mt-1">{bucket.wins}W / {bucket.losses}L</div>
      </Card>
      <Card>
        <div className="text-[10px] font-semibold text-gray-500 light:text-slate-500 uppercase tracking-wider mb-1.5">Total Setups</div>
        <div className="text-3xl font-bold tabular-nums text-gray-100 light:text-slate-900">{bucket.total}</div>
      </Card>
      <Card>
        <div className="text-[10px] font-semibold text-gray-500 light:text-slate-500 uppercase tracking-wider mb-1.5">Wins</div>
        <div className="text-3xl font-bold tabular-nums text-emerald-400">{bucket.wins}</div>
      </Card>
      <Card>
        <div className="text-[10px] font-semibold text-gray-500 light:text-slate-500 uppercase tracking-wider mb-1.5">Losses</div>
        <div className="text-3xl font-bold tabular-nums text-red-400">{bucket.losses}</div>
      </Card>
      <Card>
        <div className="text-[10px] font-semibold text-gray-500 light:text-slate-500 uppercase tracking-wider mb-1.5">Avg Return</div>
        <div className={`text-3xl font-bold tabular-nums ${bucket.avgReturnPercent == null ? 'text-gray-400' : bucket.avgReturnPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {bucket.avgReturnPercent != null ? `${bucket.avgReturnPercent >= 0 ? '+' : ''}${bucket.avgReturnPercent}%` : '—'}
        </div>
        <div className="text-[10px] text-gray-500 light:text-slate-500 mt-1">{bucket.expired} expired · {bucket.open} open</div>
      </Card>
    </div>
  );
}

// --- Win rate by period table ---

function WinRateTable({ buckets, periodLabel }: { buckets: WinRateBucket[]; periodLabel: string }) {
  return (
    <Card>
      {buckets.length === 0 ? (
        <p className="text-xs text-gray-500 light:text-slate-500 py-6 text-center">No {periodLabel.toLowerCase()} data yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 light:text-slate-500 uppercase tracking-wider text-[10px]">
                <th className="text-left px-2 py-1.5 font-medium">Period</th>
                <th className="text-right px-2 py-1.5 font-medium">Setups</th>
                <th className="text-right px-2 py-1.5 font-medium">Wins</th>
                <th className="text-right px-2 py-1.5 font-medium">Losses</th>
                <th className="text-right px-2 py-1.5 font-medium">Expired</th>
                <th className="text-right px-2 py-1.5 font-medium">Open</th>
                <th className="text-right px-3 py-1.5 font-medium">Win Rate</th>
                <th className="text-right px-2 py-1.5 font-medium">Avg Return</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.period} className="border-t border-gray-800/40 light:border-slate-200">
                  <td className="px-2 py-2 font-medium text-gray-200 light:text-slate-800">{b.period}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-gray-400 light:text-slate-500">{b.total}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-emerald-400">{b.wins}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-red-400">{b.losses}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-gray-500 light:text-slate-400">{b.expired}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-gray-500 light:text-slate-400">{b.open}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 justify-end">
                      <div className="w-14 h-1.5 bg-gray-800 light:bg-slate-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full bar-animated ${b.winRatePercent != null && b.winRatePercent >= 50 ? 'bg-emerald-500' : 'bg-red-500'}`}
                          style={{ width: `${b.winRatePercent ?? 0}%` }}
                        />
                      </div>
                      <span className="font-semibold text-gray-200 light:text-slate-800 tabular-nums w-10 text-right">
                        {b.winRatePercent != null ? `${b.winRatePercent}%` : '—'}
                      </span>
                    </div>
                  </td>
                  <td className={`text-right px-2 py-2 tabular-nums font-medium ${b.avgReturnPercent == null ? 'text-gray-500' : b.avgReturnPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {b.avgReturnPercent != null ? `${b.avgReturnPercent >= 0 ? '+' : ''}${b.avgReturnPercent}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// --- Per-symbol table ---

function SymbolTable({ symbols, onOpen }: { symbols: Array<WinRateBucket & { symbol: string }>; onOpen: (symbol: string) => void }) {
  return (
    <Card>
      {symbols.length === 0 ? (
        <p className="text-xs text-gray-500 light:text-slate-500 py-6 text-center">No symbols yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 light:text-slate-500 uppercase tracking-wider text-[10px]">
                <th className="text-left px-2 py-1.5 font-medium">Symbol</th>
                <th className="text-right px-2 py-1.5 font-medium">Setups</th>
                <th className="text-right px-2 py-1.5 font-medium">W / L</th>
                <th className="text-right px-3 py-1.5 font-medium">Win Rate</th>
                <th className="text-right px-2 py-1.5 font-medium">Avg Return</th>
              </tr>
            </thead>
            <tbody>
              {symbols.map((s) => (
                <tr key={s.symbol} onClick={() => onOpen(s.symbol)} className="border-t border-gray-800/40 light:border-slate-200 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors">
                  <td className="px-2 py-2 font-semibold text-gray-200 light:text-slate-800">{s.symbol}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-gray-400 light:text-slate-500">{s.total}</td>
                  <td className="text-right px-2 py-2 tabular-nums">
                    <span className="text-emerald-400">{s.wins}</span>
                    <span className="text-gray-600 light:text-slate-400"> / </span>
                    <span className="text-red-400">{s.losses}</span>
                  </td>
                  <td className={`text-right px-3 py-2 tabular-nums font-semibold ${s.winRatePercent == null ? 'text-gray-400' : s.winRatePercent >= 55 ? 'text-emerald-400' : s.winRatePercent >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>
                    {s.winRatePercent != null ? `${s.winRatePercent}%` : '—'}
                  </td>
                  <td className={`text-right px-2 py-2 tabular-nums font-medium ${s.avgReturnPercent == null ? 'text-gray-500' : s.avgReturnPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {s.avgReturnPercent != null ? `${s.avgReturnPercent >= 0 ? '+' : ''}${s.avgReturnPercent}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// --- Trade setup history ---

const OUTCOME_STYLE: Record<string, string> = {
  WIN: 'text-emerald-400 bg-emerald-500/10',
  LOSS: 'text-red-400 bg-red-500/10',
  EXPIRED: 'text-gray-400 bg-gray-500/10',
};

function TradeSetupHistoryTable({ history, loading, onOpen }: { history: TradeSetupRecord[]; loading: boolean; onOpen: (symbol: string) => void }) {
  return (
    <Card>
      {history.length === 0 ? (
        <p className="text-xs text-gray-500 light:text-slate-500 py-6 text-center">
          {loading ? 'Loading…' : 'No trade setups recorded yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 light:text-slate-500 uppercase tracking-wider text-[10px]">
                <th className="text-left px-2 py-1.5 font-medium">Generated</th>
                <th className="text-left px-2 py-1.5 font-medium">Symbol</th>
                <th className="text-center px-2 py-1.5 font-medium">Side</th>
                <th className="text-right px-2 py-1.5 font-medium">Strike</th>
                <th className="text-right px-2 py-1.5 font-medium">Entry</th>
                <th className="text-right px-2 py-1.5 font-medium">SL</th>
                <th className="text-right px-2 py-1.5 font-medium">Target</th>
                <th className="text-right px-2 py-1.5 font-medium">R:R</th>
                <th className="text-center px-2 py-1.5 font-medium">Outcome</th>
                <th className="text-right px-2 py-1.5 font-medium">Return</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id} onClick={() => onOpen(r.symbol)} className="border-t border-gray-800/40 light:border-slate-200 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors">
                  <td className="px-2 py-2 text-gray-400 light:text-slate-500 whitespace-nowrap">
                    {new Date(r.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-2 py-2 font-semibold text-gray-200 light:text-slate-800">{r.symbol}</td>
                  <td className="text-center px-2 py-2 font-medium">{r.side}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-gray-300 light:text-slate-700">{formatIndianNumber(r.strike, 0)}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-gray-300 light:text-slate-700">{r.entry.toFixed(2)}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-red-400/80">{r.stopLoss.toFixed(2)}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-emerald-400/80">{r.target.toFixed(2)}</td>
                  <td className="text-right px-2 py-2 tabular-nums text-gray-400 light:text-slate-500">{r.riskReward.toFixed(2)}</td>
                  <td className="text-center px-2 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${r.outcome ? OUTCOME_STYLE[r.outcome] : 'text-cyan-400 bg-cyan-500/10'}`}>
                      {r.outcome ?? 'OPEN'}
                    </span>
                  </td>
                  <td className={`text-right px-2 py-2 tabular-nums font-medium ${r.returnPercent == null ? 'text-gray-500' : r.returnPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {r.returnPercent != null ? `${r.returnPercent >= 0 ? '+' : ''}${r.returnPercent.toFixed(2)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
