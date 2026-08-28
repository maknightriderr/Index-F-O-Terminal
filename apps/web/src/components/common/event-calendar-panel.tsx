'use client';

import React, { useMemo } from 'react';
import { calculateDTE } from '@fno/shared';
import type { OptionChain, FuturesChainResponse, CorporateAction } from '@fno/shared';

// Scoped to what we actually have real data for: F&O expiry dates (options
// + futures, from the already-fetched option chain/futures response) and
// this symbol's own corporate actions (dividend/bonus/split/rights/buyback,
// from NSE's public corporate-filings data) — no fabricated dates.
// Earnings/RBI/macro events aren't tracked (no reliable free data source
// for them), so this deliberately doesn't pretend to be a general economic
// calendar.
interface CalendarEvent {
  date: string; // ISO yyyy-mm-dd
  dte: number;
  label: string;
  kind: 'OPTION_WEEKLY' | 'OPTION_MONTHLY' | 'FUTURES' | 'CORPORATE_ACTION';
}

function buildEvents(chain: OptionChain | null, futures: FuturesChainResponse | null, corporateActions: CorporateAction[]): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  // Only future-or-today corporate actions belong on a "what's coming up"
  // calendar — the symbol's endpoint returns full history (past+future).
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  for (const a of corporateActions) {
    if (a.exDate < today) continue;
    events.push({ date: a.exDate, dte: calculateDTE(a.exDate), label: a.purpose || a.type, kind: 'CORPORATE_ACTION' });
  }

  if (chain) {
    // The monthly expiry isn't flagged by the broker directly — within each
    // (year, month) group of listed expiries, the LATEST date is the
    // monthly one and everything earlier in that month is weekly. Derived
    // from the actual dates rather than a hardcoded "last Thursday" rule,
    // which has changed before and shouldn't be guessed at here.
    const byMonth = new Map<string, string[]>();
    for (const exp of chain.availableExpiries) {
      const d = new Date(exp);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key)!.push(exp);
    }
    const monthly = new Set<string>();
    for (const dates of byMonth.values()) {
      monthly.add(dates.reduce((a, b) => (a > b ? a : b)));
    }
    for (const exp of chain.availableExpiries) {
      events.push({
        date: exp,
        dte: calculateDTE(exp),
        label: monthly.has(exp) ? 'Monthly Options Expiry' : 'Weekly Options Expiry',
        kind: monthly.has(exp) ? 'OPTION_MONTHLY' : 'OPTION_WEEKLY',
      });
    }
  }

  if (futures) {
    const FUT_LABEL: Record<string, string> = { current: 'Current-Month Futures Expiry', next: 'Next-Month Futures Expiry', far: 'Far-Month Futures Expiry' };
    for (const c of futures.contracts) {
      events.push({ date: c.expiry, dte: c.dte, label: FUT_LABEL[c.expiryLabel] ?? 'Futures Expiry', kind: 'FUTURES' });
    }
  }

  return events.sort((a, b) => a.dte - b.dte);
}

const KIND_DOT: Record<CalendarEvent['kind'], string> = {
  OPTION_WEEKLY: 'bg-cyan-400',
  OPTION_MONTHLY: 'bg-violet-400',
  FUTURES: 'bg-amber-400',
  CORPORATE_ACTION: 'bg-emerald-400',
};

export function EventCalendarPanel({
  chain,
  futures,
  corporateActions = [],
  symbol,
}: {
  chain: OptionChain | null;
  futures: FuturesChainResponse | null;
  corporateActions?: CorporateAction[];
  symbol: string;
}) {
  const events = useMemo(() => buildEvents(chain, futures, corporateActions), [chain, futures, corporateActions]);

  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 border-t-fuchsia-500/50 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] hover:border-gray-700/80 light:hover:border-slate-300 transition-all duration-200 p-4">
      <h3 className="text-xs font-bold text-gray-300 light:text-slate-700 uppercase tracking-wide mb-1">
        Event Calendar <span className="text-gray-500 light:text-slate-500 font-medium normal-case">— {symbol}</span>
      </h3>
      <p className="text-[10px] text-gray-600 light:text-slate-400 mb-3 leading-snug">
        F&amp;O expiries and corporate actions (dividend/bonus/split/rights/buyback) — earnings/RBI/macro dates aren&apos;t tracked yet.
      </p>

      {events.length === 0 && (
        <div className="text-xs text-gray-500 light:text-slate-500 py-6 text-center">No upcoming events for {symbol} yet.</div>
      )}

      {events.length > 0 && (
        <div className="space-y-1.5">
          {events.map((e, i) => {
            const isCorpAction = e.kind === 'CORPORATE_ACTION';
            const isImminent = e.dte <= 1;
            const rowClass = isImminent
              ? isCorpAction
                ? 'bg-amber-500/10 border border-amber-500/20'
                : 'bg-red-500/10 border border-red-500/20'
              : 'bg-gray-900/40 light:bg-slate-100';
            const badgeClass = isImminent
              ? isCorpAction
                ? 'bg-amber-500/20 text-amber-400'
                : 'bg-red-500/20 text-red-400'
              : 'bg-gray-800/70 light:bg-slate-200 text-gray-400 light:text-slate-600';
            const badgeTitle = isImminent
              ? isCorpAction
                ? 'Ex-date — must hold the stock before this date to be entitled'
                : 'Expiry-day gamma risk — dealer hedging can pin or whipsaw price'
              : undefined;
            return (
              <div key={`${e.date}-${e.kind}-${i}`} className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 ${rowClass}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${KIND_DOT[e.kind]}`} />
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-gray-200 light:text-slate-800 truncate">{e.label}</div>
                    <div className="text-[10px] text-gray-500 light:text-slate-500">
                      {new Date(e.date).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}
                    </div>
                  </div>
                </div>
                <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full tabular-nums ${badgeClass}`} title={badgeTitle}>
                  {e.dte === 0 ? 'Today' : e.dte === 1 ? '1d' : `${e.dte}d`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
