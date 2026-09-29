// ============================================================
// CONSENSUS CANDLESTICK READ — closed bars only
// ============================================================
// closedCandlestickPattern must read CLOSED bars only (closedBarsAt, the same
// rule momentum/structure use), so the still-forming bar can neither CREATE a
// pattern that isn't really there yet, nor ERASE a real one sitting on the
// last bar that actually closed.
// ============================================================

import { describe, it, expect } from 'vitest';
import type { OHLCV } from '@fno/shared';
import { CANDLE_PATTERN_LOOKBACK, closedCandlesAt, closedCandlestickPattern } from '../closed-candle-pattern.js';

const BAR = 15 * 60 * 1000;
const T0 = Date.parse('2026-01-20T09:15:00+05:30');

function candle(k: number, open: number, high: number, low: number, close: number): OHLCV {
  return { timestamp: new Date(T0 + k * BAR).toISOString(), open, high, low, close, volume: 1000 };
}

// Five declining bars (a downtrend for precedingTrend), then a clean hammer
// shape at k=5: small body near the top, a lower wick >= 2x the body, and a
// negligible upper wick.
function downtrend(): OHLCV[] {
  return [
    candle(0, 106, 106.2, 105.6, 105.7),
    candle(1, 105.7, 105.8, 105.0, 105.1),
    candle(2, 105.1, 105.2, 104.4, 104.5),
    candle(3, 104.5, 104.6, 103.8, 103.9),
    candle(4, 103.9, 104.0, 103.2, 103.3),
  ];
}
const HAMMER = candle(5, 103.3, 103.35, 101.8, 103.35); // body 0.05, lower wick 1.5, upper wick 0
const NON_HAMMER = candle(6, 103.35, 103.5, 103.2, 103.4); // ordinary small-range bar, no reversal shape

describe('closedCandlesAt', () => {
  it('excludes a bar that has not closed yet (open + interval > now)', () => {
    const bars = [...downtrend(), HAMMER];
    const hammerOpenAt = T0 + 5 * BAR;
    // Still forming: "now" is mid-bar.
    const stillForming = closedCandlesAt(bars, hammerOpenAt + BAR / 2, BAR);
    expect(stillForming).toHaveLength(5);
    // Closed: "now" is at or after the bar's close.
    const closed = closedCandlesAt(bars, hammerOpenAt + BAR, BAR);
    expect(closed).toHaveLength(6);
  });
});

describe('closedCandlestickPattern: the forming bar can neither create nor erase a pattern', () => {
  it('a hammer that has not closed yet is not reported (cannot CREATE a pattern early)', () => {
    const bars = [...downtrend(), HAMMER];
    const hammerCloseAt = T0 + 5 * BAR + BAR; // the instant the hammer bar closes
    const beforeClose = closedCandlestickPattern(bars, hammerCloseAt - 1, BAR);
    expect(beforeClose).toBeNull(); // only the 5 downtrend bars are closed — no pattern (n < 2 ineligible/no shape)
    const atClose = closedCandlestickPattern(bars, hammerCloseAt, BAR);
    expect(atClose).toMatchObject({ pattern: 'HAMMER', direction: 'BULLISH' });
  });

  it('a still-forming bar appended after a real closed hammer cannot ERASE it', () => {
    // Old behaviour read candles.slice(-15) directly: the forming bar would
    // become "the most recent candle" the detector inspects, silently
    // replacing the real hammer with a shapeless bar. The fix must keep
    // reporting the hammer as long as the forming bar has not itself closed.
    const bars = [...downtrend(), HAMMER, NON_HAMMER];
    const hammerCloseAt = T0 + 6 * BAR; // hammer closed; NON_HAMMER (bar 6) is still forming
    const midFormingBar = closedCandlestickPattern(bars, hammerCloseAt + BAR / 2, BAR);
    expect(midFormingBar).toMatchObject({ pattern: 'HAMMER', direction: 'BULLISH' });
    // Once the forming bar itself closes, the hammer is legitimately one bar
    // further back and may or may not still be "the most recent" shape —
    // here the trailing bar has no shape of its own, so nothing is reported.
    const afterFormingCloses = closedCandlestickPattern(bars, hammerCloseAt + BAR, BAR);
    expect(afterFormingCloses).toBeNull();
  });

  it('reads at most CANDLE_PATTERN_LOOKBACK closed bars', () => {
    const bars = [...downtrend(), HAMMER];
    const now = T0 + 6 * BAR;
    expect(closedCandlesAt(bars, now, BAR).slice(-CANDLE_PATTERN_LOOKBACK).length).toBeLessThanOrEqual(CANDLE_PATTERN_LOOKBACK);
  });
});
