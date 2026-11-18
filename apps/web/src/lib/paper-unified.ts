// ============================================================
// ONE PAPER BLOTTER — both engines' paper trades as one list (redesign, Paper workspace)
// ============================================================
// Legacy trades (GET /api/paper-trades) and new-engine positions (fresh-start status) are mapped onto one row shape.
// Nothing is recomputed that the server owns: R, costs, outcomes and reasons are the records' own. A value one engine
// does not record (legacy closed rupees) stays missing, never zero.
// ============================================================

import { istDateLabel, paperReasonText, paperResult, type PaperResult, type PaperTradeView } from '@fno/shared';
import type { PositionView } from './command-center';
import { contractLabel } from './paper-trade-view';

export type Engine = 'Legacy' | 'New engine';
export interface BlotterRow {
  key: string;
  engine: Engine;
  openedAt: number;
  closedAt: number | null;
  day: string; // YYYY-MM-DD (IST)
  dateLabel: string;
  strategy: string;
  symbol: string;
  contract: string;
  exchange: string;
  direction: 'BULLISH' | 'BEARISH' | null;
  entry: number | null;
  exit: number | null;
  /** Latest mark of an open trade, when the monitor has one. */
  mark: number | null;
  netR: number | null;
  netInr: number | null;
  result: PaperResult;
  reason: string | null;
  open: boolean;
  /** Not counted in performance (voided, tracking lost, off-session…), with the server's words. */
  excluded: string | null;
  legacy?: PaperTradeView;
  fresh?: PositionView;
}

const IST = 19_800_000;
const istDay = (t: number) => new Date(t + IST).toISOString().slice(0, 10);

export function fromLegacy(t: PaperTradeView): BlotterRow {
  const open = t.state === 'OPEN';
  return {
    key: `L:${t.id}`, engine: 'Legacy', openedAt: t.mintedAt, closedAt: t.exitAt ?? null, day: istDay(t.mintedAt), dateLabel: istDateLabel(t.mintedAt),
    strategy: t.family ?? t.strategyLabel, symbol: t.symbol, contract: contractLabel(t), exchange: t.exchange,
    direction: t.direction === 'BULLISH' || t.direction === 'BEARISH' ? t.direction : null,
    entry: t.entry ?? null, exit: t.exitPrice ?? null, mark: open ? t.live?.premium ?? null : null,
    netR: open ? t.live?.unrealisedNetR ?? null : t.netR, netInr: open ? t.live?.unrealisedPnlInr ?? null : null,
    result: paperResult({ open, state: t.state, closeReason: t.closeReason, netR: t.netR }), reason: open ? null : paperReasonText(t.closeReason),
    open, excluded: !open && !t.includedInPerformance ? t.excludedReason ?? 'not counted in performance' : null, legacy: t,
  };
}

export function fromFresh(p: PositionView, name: (id: string) => string): BlotterRow {
  const open = p.status !== 'CLOSED';
  const exchange = p.market.startsWith('MCX') ? 'MCX' : p.market.startsWith('BSE') ? 'BSE' : 'NSE';
  return {
    key: `N:${p.id}`, engine: 'New engine', openedAt: p.openedAt, closedAt: p.closedAt, day: p.session, dateLabel: istDateLabel(p.openedAt),
    strategy: name(p.strategy), symbol: p.contract, contract: p.contract + (p.expiry ? ` · ${p.expiry}` : ''), exchange, direction: p.direction ?? null,
    entry: p.entry, exit: p.exit, mark: open ? p.markBid : null, netR: open ? null : p.r, netInr: open ? null : p.netPnl,
    result: paperResult({ open, netR: p.r, netPnl: p.netPnl }), reason: open ? null : paperReasonText(p.exitReason),
    open, excluded: null, fresh: p,
  };
}

export type BlotterView = 'OPEN' | 'TODAY' | 'ALL';
export interface BlotterFilter { view: BlotterView; engine: 'ALL' | Engine; result: 'ALL' | 'PROFIT' | 'LOSS' | 'EXPIRED'; query: string }
export const DEFAULT_BLOTTER: BlotterFilter = { view: 'TODAY', engine: 'ALL', result: 'ALL', query: '' };

export function blotter(rows: readonly BlotterRow[], f: BlotterFilter, today: string): BlotterRow[] {
  const q = f.query.trim().toUpperCase();
  return rows.filter((r) => {
    if (f.view === 'OPEN' && !r.open) return false;
    if (f.view === 'TODAY' && r.day !== today && !r.open) return false;
    if (f.engine !== 'ALL' && r.engine !== f.engine) return false;
    if (f.result !== 'ALL' && r.result !== f.result) return false;
    if (q && !`${r.symbol} ${r.contract} ${r.strategy}`.toUpperCase().includes(q)) return false;
    return true;
  }).sort((a, b) => b.openedAt - a.openedAt);
}

export interface EngineSummary { trades: number; closed: number; wins: number; winRate: number | null; netR: number }
export interface BlotterSummary { open: number; today: { closed: number; netR: number; wins: number; losses: number; expired: number }; window: Record<Engine, EngineSummary>; best: { strategy: string; netR: number } | null; worst: { strategy: string; netR: number } | null }

/** Headline figures: open now, today's closes, and per engine over the last `days` days (closed, counted trades). */
export function summarize(rows: readonly BlotterRow[], today: string, now: number, days = 30): BlotterSummary {
  const since = now - days * 86_400_000;
  // Today's figures count what performance counts: a voided / lost / off-session trade is listed, never summed.
  const closedToday = rows.filter((r) => !r.open && r.day === today && !r.excluded);
  const window = { Legacy: { trades: 0, closed: 0, wins: 0, winRate: null, netR: 0 }, 'New engine': { trades: 0, closed: 0, wins: 0, winRate: null, netR: 0 } } as Record<Engine, EngineSummary>;
  const byStrategy = new Map<string, number>();
  for (const r of rows) {
    if (r.openedAt < since) continue;
    const w = window[r.engine];
    w.trades++;
    if (r.open || r.excluded || r.netR == null) continue;
    w.closed++; w.netR += r.netR; if (r.netR > 0) w.wins++;
    const k = `${r.strategy} (${r.engine === 'Legacy' ? 'legacy' : 'new'})`;
    byStrategy.set(k, (byStrategy.get(k) ?? 0) + r.netR);
  }
  for (const e of Object.values(window)) e.winRate = e.closed ? Math.round((e.wins / e.closed) * 100) : null;
  const ranked = [...byStrategy.entries()].sort((a, b) => b[1] - a[1]);
  return {
    open: rows.filter((r) => r.open).length,
    today: { closed: closedToday.length, netR: closedToday.reduce((a, r) => a + (r.netR ?? 0), 0), wins: closedToday.filter((r) => r.result === 'PROFIT').length, losses: closedToday.filter((r) => r.result === 'LOSS').length, expired: closedToday.filter((r) => r.result === 'EXPIRED').length },
    window,
    best: ranked.length ? { strategy: ranked[0][0], netR: ranked[0][1] } : null,
    worst: ranked.length > 1 ? { strategy: ranked[ranked.length - 1][0], netR: ranked[ranked.length - 1][1] } : null,
  };
}
