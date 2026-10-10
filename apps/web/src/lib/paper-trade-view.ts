// ============================================================
// PAPER TRADE VIEW-MODEL — filters and counts over the server's own records
// ============================================================
// The server (apps/server/src/services/paper-trades.ts) computes every figure of a
// trade (R, estimated cost, status, cohort). This only SELECTS and COUNTS those
// records for display; it never recomputes a trade, a stop, a target or an outcome.
// ============================================================

import type { PaperTradeView } from '@fno/shared';

export type StateFilter = 'ALL' | 'OPEN' | 'CLOSED' | 'EXPIRED' | 'WIN' | 'LOSS';
export type PeriodFilter = 'ALL' | 'HISTORICAL' | 'RELIABLE';

export interface TradeFilters {
  state: StateFilter;
  period: PeriodFilter;
  /** Strategy / source family; '' = all. */
  family: string;
  /** Strategy (logic) version; '' = all. */
  version: string;
  exchange: string;
  /** Case-insensitive symbol contains; '' = all. */
  symbol: string;
  /** false = hide trades that do not count in performance (voided, lost, off-session, spread, open). */
  includeExcluded: boolean;
}

export const DEFAULT_FILTERS: TradeFilters = { state: 'ALL', period: 'ALL', family: '', version: '', exchange: '', symbol: '', includeExcluded: true };

export function filterTrades(trades: readonly PaperTradeView[], f: TradeFilters): PaperTradeView[] {
  const sym = f.symbol.trim().toUpperCase();
  return trades.filter((t) => {
    if (f.state === 'OPEN' && t.state !== 'OPEN') return false;
    if (f.state === 'CLOSED' && t.state === 'OPEN') return false;
    if (f.state === 'EXPIRED' && t.state !== 'EXPIRED') return false;
    if (f.state === 'WIN' && t.state !== 'WIN') return false;
    if (f.state === 'LOSS' && t.state !== 'LOSS') return false;
    if (f.period === 'RELIABLE' && !t.measurementReliable) return false;
    if (f.period === 'HISTORICAL' && t.measurementReliable) return false;
    if (f.family && (t.family ?? 'UNRECORDED') !== f.family) return false;
    if (f.version && (t.logicVersion ?? 'UNRECORDED') !== f.version) return false;
    if (f.exchange && t.exchange !== f.exchange) return false;
    if (sym && !t.symbol.toUpperCase().includes(sym)) return false;
    // "Excluded" means a closed trade that does not count; an open trade is shown (it has not been judged yet).
    if (!f.includeExcluded && t.state !== 'OPEN' && !t.includedInPerformance) return false;
    return true;
  });
}

export interface TradeCounts {
  shown: number;
  open: number;
  openTracked: number;
  openUntracked: number;
  win: number;
  loss: number;
  expired: number;
  /** Closed trades that count in performance. */
  includedClosed: number;
  /** Closed trades that do not, by reason. */
  excluded: Record<string, number>;
}

/** Counts of exactly the rows given (the denominators shown beside the table). */
export function countTrades(trades: readonly PaperTradeView[]): TradeCounts {
  const c: TradeCounts = { shown: trades.length, open: 0, openTracked: 0, openUntracked: 0, win: 0, loss: 0, expired: 0, includedClosed: 0, excluded: {} };
  for (const t of trades) {
    if (t.state === 'OPEN') {
      c.open++;
      if (t.status === 'OPEN_TRACKED') c.openTracked++;
      else if (t.status === 'OPEN_UNTRACKED') c.openUntracked++;
      continue;
    }
    if (t.state === 'WIN') c.win++;
    else if (t.state === 'LOSS') c.loss++;
    else c.expired++;
    if (t.includedInPerformance) c.includedClosed++;
    else {
      const key = t.status === 'CLOSED' ? 'OTHER' : t.status;
      c.excluded[key] = (c.excluded[key] ?? 0) + 1;
    }
  }
  return c;
}

/** Distinct values of a field, for a filter's options ('UNRECORDED' for a missing one). */
export function distinct(trades: readonly PaperTradeView[], pick: (t: PaperTradeView) => string | null): string[] {
  return [...new Set(trades.map((t) => pick(t) ?? 'UNRECORDED'))].sort();
}

/** "NIFTY 25000 CE · 20 Oct" (a spread or an unpriced trade just shows what is recorded). */
export function contractLabel(t: Pick<PaperTradeView, 'symbol' | 'strike' | 'side' | 'expiry' | 'structureType'>): string {
  if (t.structureType === 'SPREAD') return `${t.symbol} spread`;
  const parts = [t.symbol, t.strike != null ? String(t.strike) : null, t.side];
  const expiry = t.expiry ? new Date(`${t.expiry}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }) : null;
  return `${parts.filter(Boolean).join(' ')}${expiry ? ` · ${expiry}` : ''}`;
}

/** Newest first. */
export const byMintedDesc = (a: PaperTradeView, b: PaperTradeView): number => b.mintedAt - a.mintedAt;
