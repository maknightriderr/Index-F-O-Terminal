// ============================================================
// EMA TREND STRUCTURE
// ============================================================
// A classic trend-following filter: price > EMA20 > EMA50 (or the mirror
// for a downtrend) means the short and long moving averages are actually
// stacked in the trade's favor, not just "price went up recently." Slope
// is checked separately — a flat, tangled EMA20 sitting right on price is
// a chop signature even when the stacking order technically holds for one
// bar, so `aligned` alone isn't enough to call this a real trend structure;
// callers should require `aligned && slopeOk` for a genuine setup.
// ============================================================

import { ema } from '../indicators/index.js';

const FLAT_SLOPE_TOLERANCE = 0.001; // EMA20 must move at least 0.1% over the lookback to count as sloping
const SLOPE_LOOKBACK = 5; // bars back to measure EMA20's own slope over

export interface EmaTrendStructure {
  ema20: number;
  ema50: number;
  /** True when close/EMA20/EMA50 are stacked bullish or bearish in order. */
  aligned: boolean;
  /** Direction of the stack when aligned; null when EMAs are tangled/crossed. */
  direction: 'BULLISH' | 'BEARISH' | null;
  /** True when EMA20 is actually sloping (not flat) in `direction`'s favor. */
  slopeOk: boolean;
}

export function detectEmaTrendStructure(closes: number[]): EmaTrendStructure | null {
  const ema20Series = ema(closes, 20);
  const ema50Series = ema(closes, 50);
  if (ema20Series.length === 0 || ema50Series.length === 0) return null;

  const ema20 = ema20Series[ema20Series.length - 1];
  const ema50 = ema50Series[ema50Series.length - 1];
  const close = closes[closes.length - 1];
  if (ema20 == null || ema50 == null || close == null) return null;

  const bullishStack = close > ema20 && ema20 > ema50;
  const bearishStack = close < ema20 && ema20 < ema50;
  const direction = bullishStack ? 'BULLISH' : bearishStack ? 'BEARISH' : null;

  const priorEma20 = ema20Series[ema20Series.length - 1 - SLOPE_LOOKBACK] ?? ema20Series[0];
  const slope = priorEma20 > 0 ? (ema20 - priorEma20) / priorEma20 : 0;
  const slopeOk =
    direction === 'BULLISH' ? slope > FLAT_SLOPE_TOLERANCE : direction === 'BEARISH' ? slope < -FLAT_SLOPE_TOLERANCE : false;

  return { ema20, ema50, aligned: direction != null, direction, slopeOk };
}
