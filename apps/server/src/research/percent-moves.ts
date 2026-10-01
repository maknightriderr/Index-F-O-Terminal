// Percent-move census: intraday zigzag swings of >= 0.5%, 1%, 1.5%, measured
// low->high or high->low, confined to a single session. This is a
// descriptive/hindsight census of what moves existed in the data — not a
// trigger, and not used for any look-ahead trading decision.
//
// BUGFIX (second pass): the original implementation shared one `extremePrice`
// variable between the "watching for a drop from a high" and "watching for a
// rise from a low" branches. During the initial, undecided phase of each
// session (before the first confirmed leg), BOTH branches ran on every bar,
// and each one's write clobbered the other's tracked extreme on the very
// next iteration — so the running high/low most sessions needed to clear the
// 1%/1.5% threshold was almost never actually reached, undercounting legs by
// roughly two orders of magnitude (4 legs >=1% for NIFTY across ~245
// sessions, confirmed wrong against a direct high-low-range check). Fixed by
// keeping two independent trackers (runningHigh/runningLow) at all times, and
// by flushing the final, still-open leg at session end (previously a
// same-sized monotonic move that was never "reversed" before the close was
// silently dropped).

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

interface Bar { time: number; high: number; low: number }

export function zigzagSession(bars: readonly Bar[], thresholdPct: number, session = ''): ZigzagLeg[] {
  if (bars.length < 2) return [];
  const legs: ZigzagLeg[] = [];
  let dir: 'UP' | 'DOWN' | null = null;
  let pivotPrice = (bars[0].high + bars[0].low) / 2;
  let pivotIdx = 0;
  let runningHigh = bars[0].high;
  let runningHighIdx = 0;
  let runningLow = bars[0].low;
  let runningLowIdx = 0;

  const push = (fromIdx: number, toIdx: number, fromPrice: number, toPrice: number, d: 'UP' | 'DOWN') => {
    legs.push({
      session,
      fromTime: new Date(bars[fromIdx].time).toISOString(),
      toTime: new Date(bars[toIdx].time).toISOString(),
      fromPrice,
      toPrice,
      pct: ((toPrice - fromPrice) / fromPrice) * 100,
      direction: d,
    });
  };

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    // Two independent extreme trackers — never shared, so neither branch can
    // clobber the other's state during the undecided (dir === null) phase.
    if (dir !== 'DOWN') {
      if (bar.high > runningHigh) { runningHigh = bar.high; runningHighIdx = i; }
    }
    if (dir !== 'UP') {
      if (bar.low < runningLow) { runningLow = bar.low; runningLowIdx = i; }
    }
    // Down-flip: price has dropped thresholdPct% off the running high.
    if (dir !== 'DOWN') {
      const dropPct = ((runningHigh - bar.low) / runningHigh) * 100;
      if (dropPct >= thresholdPct) {
        if (dir === 'UP') push(pivotIdx, runningHighIdx, pivotPrice, runningHigh, 'UP');
        dir = 'DOWN';
        pivotIdx = runningHighIdx; pivotPrice = runningHigh;
        runningLow = bar.low; runningLowIdx = i;
        continue;
      }
    }
    // Up-flip: price has risen thresholdPct% off the running low.
    if (dir !== 'UP') {
      const risePct = ((bar.high - runningLow) / runningLow) * 100;
      if (risePct >= thresholdPct) {
        if (dir === 'DOWN') push(pivotIdx, runningLowIdx, pivotPrice, runningLow, 'DOWN');
        dir = 'UP';
        pivotIdx = runningLowIdx; pivotPrice = runningLow;
        runningHigh = bar.high; runningHighIdx = i;
      }
    }
  }
  // Flush the still-open final leg at session end, if it is itself >= threshold
  // (a monotonic run into the close that never got a big-enough reversal to
  // "confirm" — it still happened, so it counts as a swing).
  if (dir === 'UP') {
    const pct = ((runningHigh - pivotPrice) / pivotPrice) * 100;
    if (pct >= thresholdPct) push(pivotIdx, runningHighIdx, pivotPrice, runningHigh, 'UP');
  } else if (dir === 'DOWN') {
    const pct = ((pivotPrice - runningLow) / pivotPrice) * 100;
    if (pct >= thresholdPct) push(pivotIdx, runningLowIdx, pivotPrice, runningLow, 'DOWN');
  } else {
    // Never flipped at all: check the single best candidate move either way.
    const upPct = ((runningHigh - pivotPrice) / pivotPrice) * 100;
    const downPct = ((pivotPrice - runningLow) / pivotPrice) * 100;
    if (upPct >= thresholdPct && upPct >= downPct) push(pivotIdx, runningHighIdx, pivotPrice, runningHigh, 'UP');
    else if (downPct >= thresholdPct) push(pivotIdx, runningLowIdx, pivotPrice, runningLow, 'DOWN');
  }
  return legs;
}

export interface PercentMoveSummary {
  threshold: number;
  count: number;
  top20: Array<{ session: string; pct: number; direction: string; fromPrice: number; toPrice: number; fromTime: string; toTime: string }>;
}

export function zigzagMoves(loaded: LoadedSymbol): PercentMoveSummary[] {
  const thresholds = [0.5, 1, 1.5];
  const out: PercentMoveSummary[] = [];
  const { series } = loaded;
  for (const th of thresholds) {
    const all: PercentMoveSummary['top20'] = [];
    for (let s = 0; s < series.sessionStarts.length; s++) {
      if (loaded.masked.has(series.sessionDates[s])) continue;
      const start = series.sessionStarts[s];
      const end = s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : series.bars.length;
      const sessionBars = series.bars.slice(start, end);
      const legs = zigzagSession(sessionBars, th, series.sessionDates[s]);
      for (const leg of legs) all.push({ session: leg.session, pct: Math.abs(leg.pct), direction: leg.direction, fromPrice: leg.fromPrice, toPrice: leg.toPrice, fromTime: leg.fromTime, toTime: leg.toTime });
    }
    all.sort((a, b) => b.pct - a.pct);
    out.push({ threshold: th, count: all.length, top20: all.slice(0, 20) });
  }
  return out;
}
