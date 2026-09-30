// Percent-move census: intraday zigzag swings of >= 0.5%, 1%, 1.5%, measured
// low->high or high->low, confined to a single session. This is a
// descriptive/hindsight census of what moves existed in the data — not a
// trigger, and not used for any look-ahead trading decision.

import type { LoadedSymbol } from '../backtest/harness.js';

export interface ZigzagLeg {
  session: string;
  fromTime: string;
  toTime: string;
  fromPrice: number;
  toPrice: number;
  pct: number;
  direction: 'UP' | 'DOWN';
}

function zigzagSession(bars: { time: number; high: number; low: number }[], thresholdPct: number): ZigzagLeg[] {
  if (bars.length < 2) return [];
  const legs: ZigzagLeg[] = [];
  let pivotIdx = 0;
  let pivotPrice = (bars[0].high + bars[0].low) / 2;
  let direction: 'UP' | 'DOWN' | null = null;
  let extremeIdx = 0;
  let extremePrice = pivotPrice;
  for (let i = 1; i < bars.length; i++) {
    const hi = bars[i].high;
    const lo = bars[i].low;
    if (direction !== 'DOWN') {
      if (hi > extremePrice) { extremePrice = hi; extremeIdx = i; }
      const dropPct = ((extremePrice - lo) / extremePrice) * 100;
      if (dropPct >= thresholdPct) {
        if (direction === 'UP' || direction === null) {
          legs.push({ session: '', fromTime: '', toTime: '', fromPrice: pivotPrice, toPrice: extremePrice, pct: ((extremePrice - pivotPrice) / pivotPrice) * 100, direction: 'UP' });
        }
        direction = 'DOWN';
        pivotIdx = extremeIdx; pivotPrice = extremePrice;
        extremeIdx = i; extremePrice = lo;
        continue;
      }
    }
    if (direction !== 'UP') {
      if (lo < extremePrice || direction === null) { if (lo < extremePrice) { extremePrice = lo; extremeIdx = i; } }
      const risePct = ((hi - extremePrice) / extremePrice) * 100;
      if (risePct >= thresholdPct) {
        if (direction === 'DOWN') {
          legs.push({ session: '', fromTime: '', toTime: '', fromPrice: pivotPrice, toPrice: extremePrice, pct: ((extremePrice - pivotPrice) / pivotPrice) * 100, direction: 'DOWN' });
        }
        direction = 'UP';
        pivotIdx = extremeIdx; pivotPrice = extremePrice;
        extremeIdx = i; extremePrice = hi;
      }
    }
  }
  return legs;
}

export interface PercentMoveSummary {
  threshold: number;
  count: number;
  top20: Array<{ session: string; pct: number; direction: string; fromPrice: number; toPrice: number }>;
}

export function zigzagMoves(loaded: LoadedSymbol): PercentMoveSummary[] {
  const thresholds = [0.5, 1, 1.5];
  const out: PercentMoveSummary[] = [];
  const { series } = loaded;
  for (const th of thresholds) {
    const all: Array<{ session: string; pct: number; direction: string; fromPrice: number; toPrice: number }> = [];
    for (let s = 0; s < series.sessionStarts.length; s++) {
      if (loaded.masked.has(series.sessionDates[s])) continue;
      const start = series.sessionStarts[s];
      const end = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : series.bars.length);
      const sessionBars = series.bars.slice(start, end);
      const legs = zigzagSession(sessionBars, th);
      for (const leg of legs) all.push({ session: series.sessionDates[s], pct: Math.abs(leg.pct), direction: leg.direction, fromPrice: leg.fromPrice, toPrice: leg.toPrice });
    }
    all.sort((a, b) => b.pct - a.pct);
    out.push({ threshold: th, count: all.length, top20: all.slice(0, 20) });
  }
  return out;
}
