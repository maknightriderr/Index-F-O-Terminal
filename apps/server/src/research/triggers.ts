// ============================================================
// SETUP-FAMILY TRIGGERS C (pullback continuation), D (failed breakout),
// E (range reversal), and CONTROL (random entry). Pre-registered, simple,
// not tuned. Each evaluator reads bars[0..i] only (closed bar i) and
// returns a trigger with entry = bar i's close, a structural stop and a
// nearest-level target, or null.
//
// Families A (structure engine) and B (momentum-break) are NOT
// re-implemented here — the diagnosis reuses the existing, already-run
// momentum-report.json / structure-report.json OOS trade logs for their
// stats, per the task's "reuse, don't reinvent" instruction.
// ============================================================

import type { LoadedSymbol } from '../backtest/harness.js';
import { buildContext, trendAt, levelsAt, type SymbolContext } from './context.js';

export type Direction = 'BULLISH' | 'BEARISH';

export interface SimpleTrigger {
  family: 'C' | 'D' | 'E' | 'CONTROL';
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  reasonBlocked?: string; // only set by the "why not" helpers, not on a firing trigger
}

const STOP_BUFFER_ATR = 0.1;

// ---------------- C: pullback continuation ----------------

export function evaluatePullback(loaded: LoadedSymbol, ctx: SymbolContext, i: number): SimpleTrigger | null {
  if (i < 5) return null;
  const trend = trendAt(loaded, ctx, i);
  if (!trend) return null;
  const atr = ctx.atr14[i];
  if (!atr) return null;
  const bars = loaded.series.bars;
  const s = loaded.series.sessionIdx[i];
  const sessionStart = loaded.series.sessionStarts[s];
  const j = i - 1; // the pullback (touch) bar
  if (j <= sessionStart) return null;
  const vwap = levelsAt(loaded, j)?.find((l) => l.kind === 'VWAP')?.price ?? null;
  const ema20j = ctx.ema20[j];
  const touchesLevel = (level: number | null) => level != null && bars[j].low <= level && bars[j].high >= level;
  const touched = touchesLevel(vwap) || touchesLevel(Number.isFinite(ema20j) ? ema20j : null);
  if (!touched) return null;
  const bar = bars[i];
  if (trend === 'BULLISH') {
    if (!(bar.close > bars[j].high)) return null;
    const stop = bars[j].low - STOP_BUFFER_ATR * atr;
    const target = sessionExtreme(loaded, i, 'HIGH');
    if (!(target > bar.close)) return null;
    return { family: 'C', direction: 'BULLISH', entry: bar.close, stop, target };
  } else {
    if (!(bar.close < bars[j].low)) return null;
    const stop = bars[j].high + STOP_BUFFER_ATR * atr;
    const target = sessionExtreme(loaded, i, 'LOW');
    if (!(target < bar.close)) return null;
    return { family: 'C', direction: 'BEARISH', entry: bar.close, stop, target };
  }
}

function sessionExtreme(loaded: LoadedSymbol, i: number, which: 'HIGH' | 'LOW'): number {
  const { series } = loaded;
  const s = series.sessionIdx[i];
  const start = series.sessionStarts[s];
  let ext = which === 'HIGH' ? -Infinity : Infinity;
  for (let j = start; j <= i; j++) {
    ext = which === 'HIGH' ? Math.max(ext, series.bars[j].high) : Math.min(ext, series.bars[j].low);
  }
  return ext;
}

// ---------------- D: failed breakout ----------------

export function evaluateFailedBreakout(loaded: LoadedSymbol, ctx: SymbolContext, i: number): SimpleTrigger | null {
  const bars = loaded.series.bars;
  const s = loaded.series.sessionIdx[i];
  const sessionStart = loaded.series.sessionStarts[s];
  if (i - sessionStart < 2) return null;
  for (let lag = 1; lag <= 2; lag++) {
    const j = i - lag;
    if (j <= sessionStart) continue;
    const levels = levelsAt(loaded, j).filter((l) =>
      ['PREV_DAY_HIGH', 'PREV_DAY_LOW', 'OPENING_RANGE_HIGH', 'OPENING_RANGE_LOW', 'DAY_HIGH', 'DAY_LOW'].includes(l.kind)
    );
    const closeJ = bars[j].close;
    for (const level of levels) {
      const isHighLevel = level.kind.endsWith('HIGH');
      const brokeUp = isHighLevel && closeJ > level.price;
      const brokeDown = !isHighLevel && closeJ < level.price;
      if (!brokeUp && !brokeDown) continue;
      // must be back inside AT bar i (not before) — the break closed beyond at j, reclaim closes back inside at i
      const backInside = brokeUp ? bars[i].close < level.price : bars[i].close > level.price;
      if (!backInside) continue;
      // the break extreme is the highest high / lowest low between j and i inclusive
      let extreme = brokeUp ? -Infinity : Infinity;
      for (let k = j; k <= i; k++) extreme = brokeUp ? Math.max(extreme, bars[k].high) : Math.min(extreme, bars[k].low);
      const atrAtI = ctx.atr14[i];
      if (!atrAtI) continue;
      const buffer = STOP_BUFFER_ATR * atrAtI;
      const direction: Direction = brokeUp ? 'BEARISH' : 'BULLISH';
      const stop = brokeUp ? extreme + buffer : extreme - buffer;
      // target: opposite side of the range (the paired level if present) else the next level
      const opposite = levels.find((l) => l.kind === (isHighLevel ? level.kind.replace('HIGH', 'LOW') : level.kind.replace('LOW', 'HIGH')));
      const target = opposite ? opposite.price : direction === 'BULLISH' ? bars[i].close + 2 * atrAtI : bars[i].close - 2 * atrAtI;
      if (direction === 'BULLISH' && !(target > bars[i].close)) continue;
      if (direction === 'BEARISH' && !(target < bars[i].close)) continue;
      return { family: 'D', direction, entry: bars[i].close, stop, target };
    }
  }
  return null;
}

// ---------------- E: range reversal ----------------

export function evaluateRangeReversal(loaded: LoadedSymbol, ctx: SymbolContext, i: number): SimpleTrigger | null {
  const adxNow = ctx.adx56[i];
  const atr = ctx.atr14[i];
  if (!Number.isFinite(adxNow) || adxNow >= 20 || !atr) return null;
  const bars = loaded.series.bars;
  const s = loaded.series.sessionIdx[i];
  const start = loaded.series.sessionStarts[s];
  if (i - start < 2) return null;
  // session range so far < 1.5x daily ATR
  let hi = -Infinity, lo = Infinity;
  for (let j = start; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
  if (!(hi - lo < 1.5 * atr)) return null;
  const levels = levelsAt(loaded, i - 1).filter((l) => ['OPENING_RANGE_HIGH', 'OPENING_RANGE_LOW', 'DAY_HIGH', 'DAY_LOW'].includes(l.kind));
  const bar = bars[i];
  const body = Math.abs(bar.close - bar.open);
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  const range = bar.high - bar.low;
  if (!(range > 0)) return null;
  for (const level of levels) {
    const isHighBoundary = level.kind.endsWith('HIGH');
    const touchesBoundary = bar.low <= level.price && bar.high >= level.price;
    if (!touchesBoundary) continue;
    if (isHighBoundary) {
      // rejection off the top: long upper wick, close in outer(lower) third, bearish reversal
      if (!(upperWick >= 2 * body)) continue;
      const closeFrac = (bar.close - bar.low) / range;
      if (!(closeFrac <= 0.34)) continue;
      const stop = bar.high + STOP_BUFFER_ATR * atr;
      const vwap = levelsAt(loaded, i)?.find((l) => l.kind === 'VWAP')?.price;
      const mid = (hi + lo) / 2;
      const target = vwap ?? mid;
      if (!(target < bar.close)) continue;
      return { family: 'E', direction: 'BEARISH', entry: bar.close, stop, target };
    } else {
      if (!(lowerWick >= 2 * body)) continue;
      const closeFrac = (bar.high - bar.close) / range;
      if (!(closeFrac <= 0.34)) continue;
      const stop = bar.low - STOP_BUFFER_ATR * atr;
      const vwap = levelsAt(loaded, i)?.find((l) => l.kind === 'VWAP')?.price;
      const mid = (hi + lo) / 2;
      const target = vwap ?? mid;
      if (!(target > bar.close)) continue;
      return { family: 'E', direction: 'BULLISH', entry: bar.close, stop, target };
    }
  }
  return null;
}

// ---------------- CONTROL: random entry ----------------

// Deterministic PRNG (mulberry32) seeded per symbol so the control is
// reproducible without look-ahead (it never reads any bar data at all).
export function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fires with probability `rate` per eligible bar; direction is a coin flip. Stop 1 ATR, target 2 ATR (fixed, not tuned). */
export function evaluateControl(loaded: LoadedSymbol, ctx: SymbolContext, i: number, rand: () => number, rate: number): SimpleTrigger | null {
  if (rand() >= rate) return null;
  const atr = ctx.atr14[i];
  if (!atr) return null;
  const dir: Direction = rand() < 0.5 ? 'BULLISH' : 'BEARISH';
  const close = loaded.series.bars[i].close;
  const stop = dir === 'BULLISH' ? close - atr : close + atr;
  const target = dir === 'BULLISH' ? close + 2 * atr : close - 2 * atr;
  return { family: 'CONTROL', direction: dir, entry: close, stop, target };
}

export function buildAllContexts(loadedList: LoadedSymbol[]): Map<string, SymbolContext> {
  const map = new Map<string, SymbolContext>();
  for (const l of loadedList) map.set(l.spec.symbol, buildContext(l));
  return map;
}
