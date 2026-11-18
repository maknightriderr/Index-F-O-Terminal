// ============================================================
// TODAY — the pure view-model behind the Today screen (redesign phase 2)
// ============================================================
// Everything here only SELECTS and COMBINES records the server already produced: index quotes, engine bias
// snapshots, 5-minute bars, both engines' paper trades, alerts and health. Nothing is recomputed that the server
// owns (R, costs, outcomes); a missing input stays missing ("—"), never zero.
// ============================================================

import { paperReasonText, paperResult, type PaperResult, type PaperTradeView } from '@fno/shared';
import type { PositionView } from './command-center';

export const IST_MS = 19_800_000;
export const istDayOf = (t: number) => new Date(t + IST_MS).toISOString().slice(0, 10);
/** Epoch ms of an IST wall-clock time on `day` (YYYY-MM-DD), e.g. ("2026-11-18", "09:15"). */
export const istAt = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+05:30`);

export type PulseExchange = 'NSE' | 'BSE' | 'MCX';
export interface PulseInstrument { symbol: string; exchange: PulseExchange }
/** The instruments on the market pulse: the indices the terminal quotes and the MCX products the engines trade. */
export const PULSE_INSTRUMENTS: readonly PulseInstrument[] = [
  { symbol: 'NIFTY', exchange: 'NSE' }, { symbol: 'BANKNIFTY', exchange: 'NSE' }, { symbol: 'FINNIFTY', exchange: 'NSE' },
  { symbol: 'MIDCPNIFTY', exchange: 'NSE' }, { symbol: 'SENSEX', exchange: 'BSE' },
  { symbol: 'CRUDEOIL', exchange: 'MCX' }, { symbol: 'GOLD', exchange: 'MCX' }, { symbol: 'SILVER', exchange: 'MCX' }, { symbol: 'NATURALGAS', exchange: 'MCX' },
];

export interface Bar { time: number; open: number; high: number; low: number; close: number }
export interface PulseRow {
  symbol: string; exchange: PulseExchange;
  last: number | null; changePct: number | null; changeBasis: 'DAY' | 'SESSION_OPEN' | null;
  low: number | null; high: number | null;
  bars: Bar[];
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null; confidence: number | null; regime: string | null; pcr: number | null;
  assessedAt: number | null; stale: boolean;
}
export interface PulseInputs {
  quote?: { ltp: number; changePercent: number; low: number; high: number } | null;
  bars?: Bar[];
  bias?: { direction: string | null; confidence: number | null; regime: string | null; assessedAt: number | null; pcr?: number | null } | null;
}
const STALE_BIAS_MS = 3 * 86_400_000;

/** One pulse row: the quote when the terminal has one, else the bars (MCX: change from the session's first bar). */
export function pulseRow(i: PulseInstrument, x: PulseInputs, now: number): PulseRow {
  const bars = x.bars ?? [];
  const q = x.quote ?? null;
  let last: number | null = null, changePct: number | null = null, low: number | null = null, high: number | null = null, basis: PulseRow['changeBasis'] = null;
  if (q && Number.isFinite(q.ltp)) { last = q.ltp; changePct = q.changePercent; low = q.low; high = q.high; basis = 'DAY'; }
  else if (bars.length) {
    last = bars[bars.length - 1].close;
    changePct = bars[0].open ? ((last - bars[0].open) / bars[0].open) * 100 : null;
    low = Math.min(...bars.map((b) => b.low)); high = Math.max(...bars.map((b) => b.high)); basis = 'SESSION_OPEN';
  }
  const b = x.bias ?? null;
  const dir = b?.direction === 'BULLISH' || b?.direction === 'BEARISH' || b?.direction === 'NEUTRAL' ? b.direction : null;
  return {
    symbol: i.symbol, exchange: i.exchange, last, changePct, changeBasis: basis, low, high, bars,
    direction: dir, confidence: b?.confidence ?? null, regime: b?.regime ?? null, pcr: b?.pcr ?? null,
    assessedAt: b?.assessedAt ?? null, stale: b?.assessedAt != null && now - b.assessedAt > STALE_BIAS_MS,
  };
}

const pct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;

/** One plain sentence on the market and the paper book, only from what is on screen. Null when nothing is known. */
export function marketRead(rows: readonly PulseRow[], book: { closed: number; wins: number; open: number; day?: string }): string | null {
  const idx = rows.filter((r) => r.exchange !== 'MCX' && r.changePct != null && !r.stale);
  const mcx = rows.filter((r) => r.exchange === 'MCX' && r.direction);
  if (!idx.length && !mcx.length) return null;
  const parts: string[] = [];
  if (idx.length) {
    const up = idx.filter((r) => r.changePct! > 0).length, dn = idx.filter((r) => r.changePct! < 0).length;
    const worst = [...idx].sort((a, b) => a.changePct! - b.changePct!)[0], best = [...idx].sort((a, b) => b.changePct! - a.changePct!)[0];
    const nifty = idx.find((r) => r.symbol === 'NIFTY');
    const lead = dn === idx.length ? 'Indices fell' : up === idx.length ? 'Indices rose' : `Indices were mixed (${up} up, ${dn} down)`;
    parts.push(`${lead}${nifty ? `: NIFTY ${pct(nifty.changePct!)}` : ''}${worst && worst.symbol !== nifty?.symbol && worst.changePct! < 0 ? `, ${worst.symbol} ${pct(worst.changePct!)}` : best && best.symbol !== nifty?.symbol && best.changePct! > 0 ? `, ${best.symbol} ${pct(best.changePct!)}` : ''}.`);
    const biased = rows.filter((r) => r.exchange !== 'MCX' && r.direction && !r.stale);
    const bear = biased.filter((r) => r.direction === 'BEARISH').length, bull = biased.filter((r) => r.direction === 'BULLISH').length;
    if (biased.length) parts.push(`The engine leans ${bear >= bull ? 'bearish' : 'bullish'} on ${Math.max(bear, bull)} of ${biased.length} indices.`);
  }
  if (mcx.length) {
    const names = (d: string) => mcx.filter((r) => r.direction === d).map((r) => r.symbol.toLowerCase().replace('naturalgas', 'natural gas').replace('crudeoil', 'crude'));
    const bear = names('BEARISH'), bull = names('BULLISH');
    const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
    parts.push(`MCX: ${[bear.length ? `bearish on ${list(bear)}` : '', bull.length ? `bullish on ${list(bull)}` : ''].filter(Boolean).join(', ')}.`);
  }
  parts.push(`Paper book: ${book.closed} closed${book.day ? ` ${book.day}` : ' today'}${book.closed ? `, ${book.wins ? `${book.wins} winner${book.wins === 1 ? '' : 's'}` : 'no winner yet'}` : ''}, ${book.open} open.`);
  return parts.join(' ');
}

// ---- Paper: both engines, one list ----

export type FeedState = 'NEW' | 'ACTIVE' | 'PROFIT' | 'LOSS' | 'EXPIRED' | 'FLAT';
export interface FeedItem {
  at: number; closedAt: number | null; symbol: string; exchange: string; engine: 'Legacy' | 'New engine' | 'Signal';
  strategy: string; contract: string; state: FeedState; why: string; r: number | null;
  /** Where the row opens: an instrument workspace or the paper trades page. */
  open: { kind: 'asset'; symbol: string; exchange: PulseExchange } | { kind: 'page'; tab: string };
}

const fromResult = (r: PaperResult): FeedState => (r === 'OPEN' ? 'ACTIVE' : r);
const exchangeOf = (x: string): PulseExchange => (x === 'BSE' || x === 'MCX' ? x : 'NSE');

export function legacyFeed(trades: readonly PaperTradeView[], day: string): FeedItem[] {
  return trades.filter((t) => istDayOf(t.mintedAt) === day).map((t) => {
    const open = t.state === 'OPEN';
    const res = paperResult({ open, state: t.state, closeReason: t.closeReason, netR: t.netR });
    return {
      at: t.mintedAt, closedAt: t.exitAt ?? null, symbol: t.symbol, exchange: t.exchange, engine: 'Legacy', strategy: t.family ?? t.strategyLabel,
      contract: t.strike != null && t.side ? `${t.side} ${t.strike}` : '—', state: fromResult(res),
      why: open ? 'Paper position open · marked to the latest bid' : paperReasonText(t.closeReason) ?? 'Closed', r: t.netR,
      open: { kind: 'asset', symbol: t.symbol, exchange: exchangeOf(t.exchange) },
    };
  });
}

export function freshFeed(positions: readonly PositionView[], day: string, name: (id: string) => string): FeedItem[] {
  return positions.filter((p) => p.session === day).map((p) => {
    const open = p.status !== 'CLOSED';
    const res = paperResult({ open, netR: p.r, netPnl: p.netPnl });
    return {
      at: p.openedAt, closedAt: p.closedAt, symbol: p.contract, exchange: p.market.startsWith('MCX') ? 'MCX' : p.market.startsWith('BSE') ? 'BSE' : 'NSE', engine: 'New engine', strategy: name(p.strategy),
      contract: p.contract, state: fromResult(res), why: open ? 'Paper position open · marked to the latest bid' : paperReasonText(p.exitReason) ?? 'Closed', r: p.r,
      open: { kind: 'page', tab: 'paper-trades' },
    };
  });
}

export interface AlertLike { symbol: string; type: string; message: string; createdAt: number | string; triggeredAt?: number | string | null }
export const alertTime = (a: AlertLike): number => {
  const v = a.triggeredAt ?? a.createdAt;
  return typeof v === 'number' ? v : Date.parse(String(v));
};
/** A structure the engine confirmed today and is watching for its entry trigger (from the alert stream). */
export function watchFeed(alerts: readonly AlertLike[], day: string): FeedItem[] {
  return alerts.filter((a) => a.type === 'STRUCTURE_CONFIRMED' && Number.isFinite(alertTime(a)) && istDayOf(alertTime(a)) === day).map((a) => ({
    at: alertTime(a), closedAt: null, symbol: a.symbol, exchange: '', engine: 'Signal', strategy: 'Structure', contract: '—', state: 'NEW' as const,
    why: 'Structure confirmed · waiting for the entry trigger', r: null, open: { kind: 'asset' as const, symbol: a.symbol, exchange: exchangeOf(/MCX/.test(a.message) ? 'MCX' : 'NSE') },
  }));
}

export const sortFeed = (items: readonly FeedItem[]) => [...items].sort((a, b) => b.at - a.at);

export interface BookToday { closed: number; wins: number; losses: number; expired: number; open: number; netR: number; trades: number; byEngine: Record<string, number> }
export function bookToday(items: readonly FeedItem[]): BookToday {
  const trades = items.filter((i) => i.engine !== 'Signal');
  const closed = trades.filter((i) => i.state !== 'ACTIVE');
  const byEngine: Record<string, number> = {};
  for (const t of trades) byEngine[t.engine] = (byEngine[t.engine] ?? 0) + 1;
  return {
    closed: closed.length, wins: closed.filter((i) => i.state === 'PROFIT').length, losses: closed.filter((i) => i.state === 'LOSS').length,
    expired: closed.filter((i) => i.state === 'EXPIRED').length, open: trades.length - closed.length,
    netR: closed.reduce((a, i) => a + (i.r ?? 0), 0), trades: trades.length, byEngine,
  };
}

/** Cumulative net R through the day, one step per close (in close order). */
export function rCurve(items: readonly FeedItem[], start: number): Array<{ t: number; r: number }> {
  const closes = items.filter((i) => i.engine !== 'Signal' && i.state !== 'ACTIVE' && i.r != null).map((i) => ({ t: i.closedAt ?? i.at, r: i.r! })).sort((a, b) => a.t - b.t);
  let acc = 0;
  return [{ t: start, r: 0 }, ...closes.map((c) => ({ t: c.t, r: (acc += c.r) }))];
}

// ---- Scorecard ----

export interface ScoreRow { strategy: string; engine: 'Legacy' | 'New engine'; trades: number; winRate: number; netR: number }
export function scorecard(trades: readonly PaperTradeView[], positions: readonly PositionView[], name: (id: string) => string): ScoreRow[] {
  const groups = new Map<string, { engine: ScoreRow['engine']; rs: number[] }>();
  for (const t of trades) if (t.netR != null && t.family) { const k = `L:${t.family}`; const g = groups.get(k) ?? { engine: 'Legacy' as const, rs: [] }; g.rs.push(t.netR); groups.set(k, g); }
  for (const p of positions) if (p.status === 'CLOSED' && p.r != null) { const k = `N:${name(p.strategy)}`; const g = groups.get(k) ?? { engine: 'New engine' as const, rs: [] }; g.rs.push(p.r); groups.set(k, g); }
  return [...groups.entries()].map(([k, g]) => ({ strategy: k.slice(2), engine: g.engine, trades: g.rs.length, winRate: Math.round((g.rs.filter((r) => r > 0).length / g.rs.length) * 100), netR: g.rs.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.netR - a.netR);
}

/**
 * The session the Today screen shows: today once anything happened today or a session has opened; before the first
 * session of the day (or on a holiday), the latest earlier day that has paper activity, so the screen is never blank
 * at 07:00. `days` are the IST days that have records.
 */
export function displayDay(now: number, days: readonly string[], firstOpenToday: number | null): { day: string; live: boolean } {
  const today = istDayOf(now);
  if (days.includes(today) || (firstOpenToday != null && now >= firstOpenToday)) return { day: today, live: true };
  const earlier = [...days].filter((d) => d < today).sort();
  return earlier.length ? { day: earlier[earlier.length - 1], live: false } : { day: today, live: true };
}
