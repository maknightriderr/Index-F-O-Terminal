// ============================================================
// MOMENTUM-BREAK BACKTEST (pure harness)
// ============================================================
// Replays the snapshots written by fetch-history.ts bar by bar through the
// same detector the live engine runs (@fno/analytics momentum-break), with
// no look-ahead: the detector sees bars up to and including the closed
// trigger bar, entry is that bar's close, and the grading walks only the
// bars after it (gradePath, the missed-winner audit's own loop).
//
// Live session rules applied: the 60-minute opening guard, the 60-minute
// closing guard (against each date's real close, so MCX's 23:30/23:55 DST
// switch is honoured), and one open trade per symbol at a time. Exits:
// stop (wins ties), target, a 15m close back through the broken level
// (LEVEL_RECLAIMED), or the session's last bar. 0.1R is deducted per trade.
//
// Data hygiene (documented in the report, not tuned):
//   - bars that had not closed when the snapshot was taken are dropped;
//   - bars outside the exchange session window are dropped;
//   - THIN sessions (< half the symbol's median bar count — half-day
//     sessions, and the sparse final weeks of an illiquid expiring MCX
//     contract) take no entries;
//   - ROLL sessions on a stitched futures price series take no entries,
//     nor does the session after. A roll date is where the stitched
//     near-month hands over: session volume at least ROLL_VOLUME_JUMP× the
//     previous full session's (the expiring contract drains, the new one
//     trades). It is masked when the inter-session gap on that date exceeds
//     ROLL_GAP_ATR × ATR — the plan's rule.
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateMomentumBreak,
  isLevelReclaimed,
  momentumAtrAt,
  prepareMomentumSeries,
  istSlotOf,
  type MomentumBar,
  type MomentumBreakSignal,
  type MomentumBreakVariant,
  type MomentumSeries,
} from '@fno/analytics';
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

export type ExitKind = 'STOP' | 'TARGET' | 'LEVEL_RECLAIMED' | 'SESSION_END';

export interface BacktestTrade {
  symbol: string;
  date: string;
  /** Decision instant (trigger bar close), ISO. */
  decidedAt: string;
  /** IST hour of the decision. */
  hour: number;
  signal: MomentumBreakSignal;
  exit: ExitKind;
  exitPrice: number;
  exitAt: string;
  grossR: number;
  netR: number;
}

export interface ReplayWindow {
  /** Inclusive session-date bounds, YYYY-MM-DD. */
  from: string;
  to: string;
}

/**
 * One symbol, one variant, one period. Entries only on non-masked sessions
 * inside the window; a trade can run to its own session's end.
 */
export function replaySymbol(loaded: LoadedSymbol, variant: MomentumBreakVariant, window: ReplayWindow): BacktestTrade[] {
  const { series, spec } = loaded;
  const { bars } = series;
  const trades: BacktestTrade[] = [];
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
    if (decidedAt - w.open < OPENING_GUARD_MIN * 60000) continue;
    if (w.close - decidedAt < CLOSING_GUARD_MIN * 60000) continue;

    const { signal } = evaluateMomentumBreak(series, i, variant);
    if (!signal) continue;

    const sessionEnd = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : bars.length) - 1;
    const after = bars.slice(i + 1, sessionEnd + 1);
    if (after.length === 0) continue;
    const dir = signal.direction === 'BULLISH' ? 1 : -1;
    const path = gradePath(after, dir, signal.entry, signal.stop, signal.target, {
      invalidateOnClose: (b) => isLevelReclaimed(signal.direction, signal.levelPrice, b.close),
    });
    const exitIdx = path.exitIndex != null ? i + 1 + path.exitIndex : sessionEnd;
    const exit: ExitKind = path.hitStop ? 'STOP' : path.hitTarget ? 'TARGET' : path.invalidated ? 'LEVEL_RECLAIMED' : 'SESSION_END';
    const grossR = path.settledR;
    trades.push({
      symbol: spec.symbol,
      date,
      decidedAt: new Date(decidedAt).toISOString(),
      hour: Number(istSlotOf(decidedAt).slice(0, 2)),
      signal,
      exit,
      exitPrice: path.exitPrice ?? bars[exitIdx].close,
      exitAt: new Date(bars[exitIdx].time + BAR_MS).toISOString(),
      grossR: round3(grossR),
      netR: round3(grossR - COST_R),
    });
    busyUntil = exitIdx;
  }
  return trades;
}

export interface TradeStats {
  trades: number;
  winRate: number | null;
  avgNetR: number | null;
  totalNetR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
}

export function statsOf(trades: readonly BacktestTrade[]): TradeStats {
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

export function groupStats<K extends string | number>(trades: readonly BacktestTrade[], key: (t: BacktestTrade) => K): Array<{ key: K; stats: TradeStats }> {
  const groups = new Map<K, BacktestTrade[]>();
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
export function chooseVariant(results: Array<{ variant: MomentumBreakVariant; stats: TradeStats }>): MomentumBreakVariant {
  let best = results[0];
  for (const r of results.slice(1)) {
    if ((r.stats.avgNetR ?? -Infinity) > (best.stats.avgNetR ?? -Infinity)) best = r;
  }
  return best.variant;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
