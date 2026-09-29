// ============================================================
// BACKTEST HARNESS (pure, strategy-agnostic)
// ============================================================
// Generalised out of momentum-backtest.ts so a second setup family can be
// replayed with exactly the same data hygiene, session rules, cost and
// statistics. A strategy supplies:
//
//   variants          the pre-registered parameter sets
//   evaluate          a signal decided on closed bar i (reads bars ≤ i), or null
//   toOrder           MARKET at the decision bar's close, or a LIMIT that may
//                     fill in the next N bars
//   invalidateOnClose the strategy's close-based exit (LEVEL_RECLAIMED, ...)
//   groupKeys         how its report slices trades
//
// MARKET orders run exactly the loop momentum-break shipped with (its report
// is byte-identical; momentum-harness-refactor.test.ts holds that): opening
// and closing guards on the decision time, entry at the decision bar's close,
// gradePath over the bars after it, one open trade per symbol.
//
// LIMIT orders:
//   - bars i+1 … i+N are scanned for the first touch of the entry; the fill
//     is AT the entry price (never better, even through a gap);
//   - a bar that reaches the target before any touch is MISSED (no trade);
//     a bar that touches both is taken as a FILL (the conservative reading);
//   - the session guards apply at the FILL bar (a live fill is when a setup
//     is minted, and the live session gate refuses it there);
//   - on the fill bar the stop counts and the target does not — a fill bar
//     that also reaches the stop is a full loss; its close can still trigger
//     the strategy's invalidation exit;
//   - from the next bar on, gradePath grades it like any other trade;
//   - busyUntil covers the pending window, so nothing else is taken while an
//     order rests.
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { istSlotOf, momentumAtrAt, prepareMomentumSeries, type MomentumBar, type MomentumSeries } from '@fno/analytics';
import { getSessionWindow, type Exchange } from '@fno/shared';
import { gradePath } from '../services/grade-path.js';

export const COST_R = 0.1;
export const OPENING_GUARD_MIN = 60;
export const CLOSING_GUARD_MIN = 60;
export const THIN_SESSION_FRACTION = 0.5;
export const ROLL_VOLUME_JUMP = 2.5;
export const ROLL_GAP_ATR = 3;

const BAR_MS = 15 * 60 * 1000;

export interface SymbolSpec {
  symbol: string;
  exchange: Exchange;
  /** Snapshot supplying price (and volume unless volumeFile is set). */
  priceFile: string;
  /** Snapshot supplying volume, bar for bar (index futures for index spot). */
  volumeFile?: string;
  /** The price series is a stitched futures contract, so it has roll gaps. */
  futuresPrice: boolean;
}

export const BACKTEST_SYMBOLS: SymbolSpec[] = [
  { symbol: 'NIFTY', exchange: 'NSE', priceFile: 'NIFTY_INDEX', volumeFile: 'NIFTY_FUT', futuresPrice: false },
  { symbol: 'BANKNIFTY', exchange: 'NSE', priceFile: 'BANKNIFTY_INDEX', volumeFile: 'BANKNIFTY_FUT', futuresPrice: false },
  { symbol: 'SENSEX', exchange: 'BSE', priceFile: 'SENSEX_INDEX', volumeFile: 'SENSEX_FUT', futuresPrice: false },
  { symbol: 'CRUDEOIL', exchange: 'MCX', priceFile: 'CRUDEOIL', futuresPrice: true },
  { symbol: 'GOLD', exchange: 'MCX', priceFile: 'GOLD', futuresPrice: true },
];

interface SnapshotFile {
  name: string;
  fetchedAt: string;
  bars: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
}

export function readSnapshot(dir: string, name: string): SnapshotFile | null {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as SnapshotFile;
}

export interface LoadedSymbol {
  spec: SymbolSpec;
  series: MomentumSeries;
  /** Session dates that take no entries, with why. */
  masked: Map<string, 'THIN' | 'ROLL' | 'AFTER_ROLL'>;
  rolls: Array<{ date: string; gap: number; gapAtr: number; volumeJump: number; masked: boolean }>;
  droppedPartial: number;
  droppedOutOfSession: number;
  volumeCoverage: number;
  firstBar: string | null;
  lastBar: string | null;
}

/** Index spot + its future's volume, matched on the bar timestamp (the live withBorrowedVolume rule). */
export function borrowVolume(price: MomentumBar[], volume: MomentumBar[]): MomentumBar[] {
  const byTime = new Map(volume.map((b) => [b.time, b.volume]));
  return price.map((b) => ({ ...b, volume: byTime.get(b.time) ?? 0 }));
}

function toBars(snap: SnapshotFile): MomentumBar[] {
  return snap.bars
    .map((b) => ({ time: Date.parse(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }))
    .filter((b) => Number.isFinite(b.time))
    .sort((a, b) => a.time - b.time);
}

export function loadSymbol(dir: string, spec: SymbolSpec): LoadedSymbol | null {
  const priceSnap = readSnapshot(dir, spec.priceFile);
  if (!priceSnap) return null;
  const fetchedAt = Date.parse(priceSnap.fetchedAt);
  let bars = toBars(priceSnap);
  if (spec.volumeFile) {
    const volSnap = readSnapshot(dir, spec.volumeFile);
    if (!volSnap) return null;
    bars = borrowVolume(bars, toBars(volSnap));
  }
  const before = bars.length;
  bars = bars.filter((b) => b.time + BAR_MS <= fetchedAt);
  const droppedPartial = before - bars.length;
  const inSession = bars.filter((b) => {
    const date = new Date(b.time + 330 * 60 * 1000).toISOString().slice(0, 10);
    const w = getSessionWindow(spec.exchange, date);
    return w != null && b.time >= w.open && b.time < w.close;
  });
  const droppedOutOfSession = bars.length - inSession.length;
  const series = prepareMomentumSeries(inSession);
  const { masked, rolls } = sessionMasks(series, spec.futuresPrice);
  const withVol = inSession.filter((b) => b.volume > 0).length;
  return {
    spec,
    series,
    masked,
    rolls,
    droppedPartial,
    droppedOutOfSession,
    volumeCoverage: inSession.length > 0 ? withVol / inSession.length : 0,
    firstBar: inSession[0] ? new Date(inSession[0].time).toISOString() : null,
    lastBar: inSession.length ? new Date(inSession[inSession.length - 1].time).toISOString() : null,
  };
}

export function sessionMasks(series: MomentumSeries, futuresPrice: boolean): Pick<LoadedSymbol, 'masked' | 'rolls'> {
  const masked: LoadedSymbol['masked'] = new Map();
  const rolls: LoadedSymbol['rolls'] = [];
  const nSessions = series.sessionStarts.length;
  const sizes = series.sessionStarts.map((start, s) => (s + 1 < nSessions ? series.sessionStarts[s + 1] : series.bars.length) - start);
  const sorted = [...sizes].sort((a, b) => a - b);
  const medianSize = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const thin = sizes.map((n) => n < THIN_SESSION_FRACTION * medianSize);
  thin.forEach((t, s) => t && masked.set(series.sessionDates[s], 'THIN'));
  if (!futuresPrice) return { masked, rolls };

  const volumeOf = (s: number) => {
    let v = 0;
    const end = s + 1 < nSessions ? series.sessionStarts[s + 1] : series.bars.length;
    for (let j = series.sessionStarts[s]; j < end; j++) v += series.bars[j].volume;
    return v;
  };
  for (let s = 1; s < nSessions; s++) {
    // Previous FULL session: a half-day or sparse session would fake a jump.
    let p = s - 1;
    while (p >= 0 && thin[p]) p--;
    if (p < 0) continue;
    const prevVol = volumeOf(p);
    const vol = volumeOf(s);
    if (!(prevVol > 0) || vol < ROLL_VOLUME_JUMP * prevVol) continue;
    const start = series.sessionStarts[s];
    const gap = series.bars[start].open - series.bars[start - 1].close;
    const atrAtOpen = momentumAtrAt(series, start);
    const gapAtr = atrAtOpen ? Math.abs(gap) / atrAtOpen : 0;
    const isMasked = gapAtr > ROLL_GAP_ATR;
    rolls.push({ date: series.sessionDates[s], gap: Math.round(gap * 100) / 100, gapAtr: Math.round(gapAtr * 10) / 10, volumeJump: Math.round((vol / prevVol) * 100) / 100, masked: isMasked });
    if (isMasked) {
      masked.set(series.sessionDates[s], 'ROLL');
      if (s + 1 < nSessions && !masked.has(series.sessionDates[s + 1])) masked.set(series.sessionDates[s + 1], 'AFTER_ROLL');
    }
  }
  return { masked, rolls };
}

// ---------------- strategy interface ----------------

export interface BacktestOrder {
  direction: 'BULLISH' | 'BEARISH';
  /** MARKET fills at the decision bar's close; LIMIT rests at `entry`. */
  type: 'MARKET' | 'LIMIT';
  entry: number;
  stop: number;
  target: number;
  /** LIMIT only: the order may fill in bars i+1 … i+fillWithinBars. */
  fillWithinBars?: number;
}

export interface BacktestStrategy<V extends { id: string }, S> {
  name: string;
  /** Every order this strategy places is of this type. */
  orderType: 'MARKET' | 'LIMIT';
  variants: readonly V[];
  /** A signal decided on closed bar i. Must read bars ≤ i only. */
  evaluate(loaded: LoadedSymbol, i: number, variant: V): S | null;
  toOrder(signal: S): BacktestOrder;
  /** The strategy's close-based exit, checked after stop and target on every bar. */
  invalidateOnClose(signal: S): (bar: { high: number; low: number; close: number }) => boolean;
  /** Exit label for the close-based exit. */
  invalidationExit: string;
  /** Whether the 60-minute opening guard applies (it always does at the decision for MARKET orders). */
  openingGuard(variant: V): boolean;
  /** Report slices: title → key of a trade. */
  groupKeys: Record<string, (t: BacktestTrade<S>) => string | number>;
}

export type ExitKind = 'STOP' | 'TARGET' | 'SESSION_END' | string;

export interface BacktestTrade<S = unknown> {
  symbol: string;
  date: string;
  /** Decision instant (the deciding bar's close), ISO. */
  decidedAt: string;
  /** IST hour of the decision. */
  hour: number;
  signal: S;
  exit: ExitKind;
  exitPrice: number;
  exitAt: string;
  grossR: number;
  netR: number;
  /** LIMIT orders only: when and where it filled, and excursions from the fill (R). */
  fill?: { at: string; price: number; barsWaited: number; hour: number };
  mfeR?: number;
  maeR?: number;
}

/** A LIMIT order that never became a trade, and why. */
export interface UnfilledOrder<S = unknown> {
  symbol: string;
  date: string;
  decidedAt: string;
  hour: number;
  signal: S;
  outcome: 'NO_FILL' | 'MISSED' | 'GUARDED' | 'SESSION_END';
}

export interface ReplayWindow {
  /** Inclusive session-date bounds, YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface ReplayResult<S> {
  trades: BacktestTrade<S>[];
  unfilled: UnfilledOrder<S>[];
}

/**
 * One symbol, one variant, one period. Entries only on non-masked sessions
 * inside the window; a trade can run to its own session's end.
 */
export function replayStrategy<V extends { id: string }, S>(
  loaded: LoadedSymbol,
  strategy: BacktestStrategy<V, S>,
  variant: V,
  window: ReplayWindow
): ReplayResult<S> {
  const { series, spec } = loaded;
  const { bars } = series;
  const trades: BacktestTrade<S>[] = [];
  const unfilled: UnfilledOrder<S>[] = [];
  let busyUntil = -1;
  for (let i = 1; i < bars.length; i++) {
    if (i <= busyUntil) continue;
    const s = series.sessionIdx[i];
    const date = series.sessionDates[s];
    if (date < window.from || date > window.to) continue;
    if (loaded.masked.has(date)) continue;
    const w = getSessionWindow(spec.exchange, date);
    if (!w) continue;
    const decidedAt = bars[i].time + BAR_MS;
    // MARKET: the guards judge the decision (exactly the shipped momentum loop).
    // LIMIT: they judge the fill, below.
    if (strategy.orderType === 'MARKET') {
      if (decidedAt - w.open < OPENING_GUARD_MIN * 60000) continue;
      if (w.close - decidedAt < CLOSING_GUARD_MIN * 60000) continue;
    }

    const probe = strategy.evaluate(loaded, i, variant);
    if (!probe) continue;
    const order = strategy.toOrder(probe);

    const sessionEnd = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : bars.length) - 1;
    const dir: 1 | -1 = order.direction === 'BULLISH' ? 1 : -1;
    const invalidate = strategy.invalidateOnClose(probe);
    const hour = Number(istSlotOf(decidedAt).slice(0, 2));
    const base = { symbol: spec.symbol, date, decidedAt: new Date(decidedAt).toISOString(), hour, signal: probe };

    if (order.type === 'MARKET') {
      const after = bars.slice(i + 1, sessionEnd + 1);
      if (after.length === 0) continue;
      const path = gradePath(after, dir, order.entry, order.stop, order.target, { invalidateOnClose: (b) => invalidate(b) });
      const exitIdx = path.exitIndex != null ? i + 1 + path.exitIndex : sessionEnd;
      const exit: ExitKind = path.hitStop ? 'STOP' : path.hitTarget ? 'TARGET' : path.invalidated ? strategy.invalidationExit : 'SESSION_END';
      const grossR = path.settledR;
      trades.push({
        ...base,
        exit,
        exitPrice: path.exitPrice ?? bars[exitIdx].close,
        exitAt: new Date(bars[exitIdx].time + BAR_MS).toISOString(),
        grossR: round3(grossR),
        netR: round3(grossR - COST_R),
      });
      busyUntil = exitIdx;
      continue;
    }

    // ---- LIMIT ----
    const lastScan = Math.min(i + (order.fillWithinBars ?? 1), sessionEnd);
    let fillIdx: number | null = null;
    let outcome: UnfilledOrder['outcome'] | null = null;
    let k = i + 1;
    for (; k <= lastScan; k++) {
      const touched = dir > 0 ? bars[k].low <= order.entry : bars[k].high >= order.entry;
      if (touched) { fillIdx = k; break; }
      const reached = dir > 0 ? bars[k].high >= order.target : bars[k].low <= order.target;
      if (reached) { outcome = 'MISSED'; break; }
    }
    if (fillIdx == null) {
      const endedBy = outcome ?? (lastScan === sessionEnd && lastScan < i + (order.fillWithinBars ?? 1) ? 'SESSION_END' : 'NO_FILL');
      unfilled.push({ ...base, outcome: endedBy });
      busyUntil = Math.min(k, lastScan);
      continue;
    }
    // The live session gate refuses the mint at the fill.
    const fillTime = bars[fillIdx].time;
    const blockedOpen = strategy.openingGuard(variant) && fillTime < w.open + OPENING_GUARD_MIN * 60000;
    const blockedClose = w.close - fillTime <= CLOSING_GUARD_MIN * 60000;
    if (blockedOpen || blockedClose) {
      unfilled.push({ ...base, outcome: 'GUARDED' });
      busyUntil = fillIdx;
      continue;
    }
    const risk = Math.abs(order.entry - order.stop);
    const fb = bars[fillIdx];
    const fill = { at: new Date(fillTime).toISOString(), price: order.entry, barsWaited: fillIdx - i, hour: Number(istSlotOf(fillTime).slice(0, 2)) };
    const fbAdverse = dir > 0 ? order.entry - fb.low : fb.high - order.entry;
    const fbFavour = dir > 0 ? fb.close - order.entry : order.entry - fb.close;
    let exitIdx: number;
    let exit: ExitKind;
    let exitPrice: number;
    let grossR: number;
    let mfe = Math.max(0, fbFavour);
    let mae = Math.max(0, fbAdverse);
    if (dir > 0 ? fb.low <= order.stop : fb.high >= order.stop) {
      exitIdx = fillIdx; exit = 'STOP'; exitPrice = order.stop; grossR = -1;
    } else if (invalidate(fb)) {
      exitIdx = fillIdx; exit = strategy.invalidationExit; exitPrice = fb.close; grossR = risk > 0 ? (dir * (fb.close - order.entry)) / risk : 0;
    } else {
      const after = bars.slice(fillIdx + 1, sessionEnd + 1);
      if (after.length === 0) {
        exitIdx = fillIdx; exit = 'SESSION_END'; exitPrice = fb.close; grossR = risk > 0 ? (dir * (fb.close - order.entry)) / risk : 0;
      } else {
        const path = gradePath(after, dir, order.entry, order.stop, order.target, { invalidateOnClose: (b) => invalidate(b) });
        exitIdx = path.exitIndex != null ? fillIdx + 1 + path.exitIndex : sessionEnd;
        exit = path.hitStop ? 'STOP' : path.hitTarget ? 'TARGET' : path.invalidated ? strategy.invalidationExit : 'SESSION_END';
        exitPrice = path.exitPrice ?? bars[exitIdx].close;
        grossR = path.settledR;
        mfe = Math.max(mfe, path.mfe);
        mae = Math.max(mae, path.mae);
      }
    }
    trades.push({
      ...base,
      exit,
      exitPrice,
      exitAt: new Date(bars[exitIdx].time + BAR_MS).toISOString(),
      grossR: round3(grossR),
      netR: round3(grossR - COST_R),
      fill,
      mfeR: risk > 0 ? round3(mfe / risk) : 0,
      maeR: risk > 0 ? round3(Math.min(mae, risk) / risk) : 0,
    });
    busyUntil = exitIdx;
  }
  return { trades, unfilled };
}

// ---------------- statistics ----------------

export interface TradeStats {
  trades: number;
  winRate: number | null;
  avgNetR: number | null;
  totalNetR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
}

export function statsOf(trades: readonly BacktestTrade<any>[]): TradeStats {
  const ordered = [...trades].sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1 : a.symbol < b.symbol ? -1 : 1));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let gains = 0;
  let losses = 0;
  let wins = 0;
  for (const t of ordered) {
    equity += t.netR;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (t.netR > 0) { gains += t.netR; wins++; } else losses += -t.netR;
  }
  const n = ordered.length;
  return {
    trades: n,
    winRate: n ? round3(wins / n) : null,
    avgNetR: n ? round3(equity / n) : null,
    totalNetR: round3(equity),
    profitFactor: losses > 0 ? round3(gains / losses) : gains > 0 ? Infinity : null,
    maxDrawdownR: round3(maxDd),
  };
}

export function groupStats<T extends BacktestTrade<any>, K extends string | number>(trades: readonly T[], key: (t: T) => K): Array<{ key: K; stats: TradeStats }> {
  const groups = new Map<K, T[]>();
  for (const t of trades) {
    const k = key(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, ts]) => ({ key: k, stats: statsOf(ts) }));
}

/** The pre-registered go-live bar. Fixed before any result was seen. */
export const GO_LIVE_BAR = { minTrades: 30, minAvgNetR: 0.1, minProfitFactor: 1.2 } as const;
/** Per-symbol allow-list rule: a symbol needs at least this many OOS trades and a non-negative OOS average. */
export const SYMBOL_MIN_OOS_TRADES = 10;

export function passesGoLiveBar(s: TradeStats): boolean {
  return (
    s.trades >= GO_LIVE_BAR.minTrades &&
    s.avgNetR != null &&
    s.avgNetR >= GO_LIVE_BAR.minAvgNetR &&
    s.profitFactor != null &&
    s.profitFactor >= GO_LIVE_BAR.minProfitFactor
  );
}

export function allowedSymbols(bySymbol: Array<{ key: string; stats: TradeStats }>): string[] {
  return bySymbol.filter((g) => g.stats.trades >= SYMBOL_MIN_OOS_TRADES && (g.stats.avgNetR ?? -1) >= 0).map((g) => g.key);
}

/** Chronological split: the first ⅔ of the session calendar is in-sample. Returns the first out-of-sample date. */
export function splitDate(sessionDates: readonly string[]): string {
  const sorted = [...new Set(sessionDates)].sort();
  return sorted[Math.floor((sorted.length * 2) / 3)];
}

/** In-sample choice: highest pooled average net R; ties keep the earlier-registered variant. */
export function chooseVariant<V>(results: Array<{ variant: V; stats: TradeStats }>): V {
  let best = results[0];
  for (const r of results.slice(1)) {
    if ((r.stats.avgNetR ?? -Infinity) > (best.stats.avgNetR ?? -Infinity)) best = r;
  }
  return best.variant;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
