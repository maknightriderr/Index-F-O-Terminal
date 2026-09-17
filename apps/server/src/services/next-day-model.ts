// ============================================================
// NEXT-DAY MODEL
// ============================================================
// What the next session is likely to look like, stated only where daily
// history shows an edge that held out of sample. Researched on 17 Sep 2026
// against NIFTY and BANKNIFTY daily candles, 2023-24 (fit) vs 2025-26 (test):
//
//   - Direction (next close vs today's close): none of 12 price rules —
//     trend (close vs EMA20/50, EMA cross), momentum and reversal (1d, 5d),
//     RSI extremes, close location, big-day reversal — held an edge out of
//     sample. The best-looking in 2023-24 (close > EMA20, 57.8%, z 3.3) was
//     49.8% in 2025-26: it had only caught the bull market's up-day base
//     rate. The old engine's call (the intraday bias) was right 36% of the
//     time. So there is no direction call.
//   - Opening gap: where today closed in its range tilts the next open the
//     same way in all four samples, but walk-forward odds conditioned on it
//     scored no better than the plain trailing base rate (Brier NIFTY 0.4288
//     vs 0.4284, BANKNIFTY 0.4471 vs 0.4460 in 2025-26). So gap odds are the
//     trailing base rate, and no gap "lean" is claimed.
//   - Volatile session (next range > 1.3x the 20-day average range before
//     the basis day): 31-36% after a wide day vs 12-16% after a narrow one in
//     all four samples, and walk-forward odds by today's range beat the base
//     rate (Brier NIFTY 0.1605 vs 0.1633; predicted 35%+ -> 34% realised,
//     15-25% -> 16%). Bucket rates are shrunk toward the base rate with
//     VOLATILE_SHRINK pseudo-sessions (chosen on 2023-24).
//   - Trend day (|close - open| >= 60% of the range): ~30-38% whatever the
//     prior day looked like — reported as the plain base rate.
//
// Rates come from a trailing window, not the 2023-26 study, so they track
// the current regime (the gap-up base rate fell from 47% to 35% between the
// two periods). The expected close range is ±1σ from ATM IV over the calendar
// time to the next session's close.
// ============================================================

import { getSessionWindow } from '@fno/shared';
import type { OHLCV } from '@fno/shared';

export const NEXT_DAY_MODEL_VERSION = 'empirical-v2';
export const GAP_THRESHOLD_PCT = 0.15;
export const DIRECTION_FLAT_BAND_PCT = 0.15;
export const VOLATILE_RANGE_MULTIPLE = 1.3;
export const TREND_BODY_SHARE = 0.6;
const TRAILING_WINDOW = 250;
const MIN_BUCKET_SAMPLE = 30;
const RANGE_LOOKBACK = 20;
const VOLATILE_SHRINK = 25;

export interface DailyBar {
  date: string; // YYYY-MM-DD (IST)
  open: number;
  high: number;
  low: number;
  close: number;
}

export type CloseLocation = 'NEAR_HIGH' | 'MID' | 'NEAR_LOW';
export type RangeBucket = 'NARROW' | 'NORMAL' | 'WIDE';

export interface NextDayEstimate {
  basisDate: string;
  closeLocation: CloseLocation;
  rangeBucket: RangeBucket;
  gapUpPct: number;
  gapDownPct: number;
  flatOpenPct: number;
  gapSample: number;
  trendDayPct: number;
  trendSample: number;
  volatilePct: number;
  volatileSample: number;
  volatileConditioned: boolean;
  avgRangePct: number;
}

export function toDailyBars(candles: OHLCV[]): DailyBar[] {
  const byDate = new Map<string, DailyBar>();
  for (const c of candles) {
    const date = String(c.timestamp).slice(0, 10);
    if (!(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)) continue;
    byDate.set(date, { date, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function closeLocationOf(bar: DailyBar): CloseLocation {
  if (!(bar.high > bar.low)) return 'MID';
  const loc = (bar.close - bar.low) / (bar.high - bar.low);
  return loc >= 0.7 ? 'NEAR_HIGH' : loc <= 0.3 ? 'NEAR_LOW' : 'MID';
}

function rangePct(bar: DailyBar, reference: number): number {
  return ((bar.high - bar.low) / reference) * 100;
}

/** Average high-low range (% of close) of the RANGE_LOOKBACK bars before index i. */
export function avgRangeBefore(bars: DailyBar[], i: number): number | null {
  if (i < RANGE_LOOKBACK) return null;
  let sum = 0;
  for (let k = i - RANGE_LOOKBACK; k < i; k++) sum += rangePct(bars[k], bars[k].close);
  return sum / RANGE_LOOKBACK;
}

export function rangeBucketOf(bars: DailyBar[], i: number): RangeBucket | null {
  const avg = avgRangeBefore(bars, i);
  if (avg == null || !(avg > 0)) return null;
  const r = rangePct(bars[i], bars[i].close);
  return r < 0.7 * avg ? 'NARROW' : r > VOLATILE_RANGE_MULTIPLE * avg ? 'WIDE' : 'NORMAL';
}

export function gapPct(basis: DailyBar, next: DailyBar): number {
  return ((next.open - basis.close) / basis.close) * 100;
}

export function isTrendDay(bar: DailyBar): boolean {
  return bar.high > bar.low && Math.abs(bar.close - bar.open) / (bar.high - bar.low) >= TREND_BODY_SHARE;
}

/**
 * Whether the bar after `basisIndex` was a volatile session: its range above
 * VOLATILE_RANGE_MULTIPLE x the 20-day average range measured BEFORE the
 * basis day — the same average rangeBucketOf judges the basis day against.
 * Including the basis day in that average (as the first version did) raised
 * the bar right after wide days and hid the clustering this read is for.
 */
export function isVolatileNext(bars: DailyBar[], basisIndex: number): boolean | null {
  const avg = avgRangeBefore(bars, basisIndex);
  if (avg == null || basisIndex + 1 >= bars.length) return null;
  return rangePct(bars[basisIndex + 1], bars[basisIndex].close) > VOLATILE_RANGE_MULTIPLE * avg;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

/**
 * Estimates for the session after `bars[basisIndex]` from the TRAILING_WINDOW
 * completed day-pairs before it. Only history strictly before the basis day
 * is used, so the same function can re-score past predictions honestly.
 */
export function estimateNextDay(bars: DailyBar[], basisIndex = bars.length - 1): NextDayEstimate | null {
  if (basisIndex < RANGE_LOOKBACK + 2) return null;
  const basis = bars[basisIndex];
  const location = closeLocationOf(basis);
  const bucket = rangeBucketOf(bars, basisIndex) ?? 'NORMAL';

  const start = Math.max(RANGE_LOOKBACK, basisIndex - TRAILING_WINDOW);
  const pairs: number[] = [];
  for (let i = start; i < basisIndex; i++) pairs.push(i); // day i -> outcome i+1 (i+1 <= basisIndex)
  if (pairs.length < MIN_BUCKET_SAMPLE) return null;

  const gapStats = (idx: number[]) => {
    let up = 0, down = 0;
    for (const i of idx) {
      const g = gapPct(bars[i], bars[i + 1]);
      if (g > GAP_THRESHOLD_PCT) up++;
      else if (g < -GAP_THRESHOLD_PCT) down++;
    }
    return { up, down, n: idx.length };
  };
  const g = gapStats(pairs);
  const gapUpPct = pct(g.up, g.n);
  const gapDownPct = pct(g.down, g.n);

  const trendDays = pairs.filter((i) => isTrendDay(bars[i + 1])).length;

  const graded = pairs.filter((i) => isVolatileNext(bars, i) != null);
  const baseVolatile = graded.length > 0 ? graded.filter((i) => isVolatileNext(bars, i) === true).length / graded.length : 0;
  const sameRange = graded.filter((i) => rangeBucketOf(bars, i) === bucket);
  const volatileConditioned = sameRange.length >= MIN_BUCKET_SAMPLE;
  const sameRangeVolatile = sameRange.filter((i) => isVolatileNext(bars, i) === true).length;
  const volatileRate = volatileConditioned
    ? (sameRangeVolatile + VOLATILE_SHRINK * baseVolatile) / (sameRange.length + VOLATILE_SHRINK)
    : baseVolatile;

  return {
    basisDate: basis.date,
    closeLocation: location,
    rangeBucket: bucket,
    gapUpPct,
    gapDownPct,
    flatOpenPct: Math.max(0, 100 - gapUpPct - gapDownPct),
    gapSample: g.n,
    trendDayPct: pct(trendDays, pairs.length),
    trendSample: pairs.length,
    volatilePct: Math.round(volatileRate * 100),
    volatileSample: volatileConditioned ? sameRange.length : graded.length,
    volatileConditioned,
    avgRangePct: avgRangeBefore(bars, basisIndex) ?? 0,
  };
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Next NSE session date after `date` (skips weekends and listed holidays). */
export function nextSessionDate(date: string): string {
  let d = shiftDate(date, 1);
  for (let i = 0; i < 14 && !getSessionWindow('NSE', d); i++) d = shiftDate(d, 1);
  return d;
}

/** Calendar days from `date`'s close to the next session's close — the horizon the IV range covers. */
export function calendarDaysToNextClose(date: string): number {
  const here = getSessionWindow('NSE', date);
  const next = getSessionWindow('NSE', nextSessionDate(date));
  if (!here || !next) return 1;
  return Math.max(1, (next.close - here.close) / (24 * 60 * 60 * 1000));
}

export function describeLocation(l: CloseLocation): string {
  return l === 'NEAR_HIGH' ? 'near the top of its range' : l === 'NEAR_LOW' ? 'near the bottom of its range' : 'mid-range';
}

export function describeRange(b: RangeBucket): string {
  return b === 'WIDE' ? 'wide' : b === 'NARROW' ? 'narrow' : 'normal';
}
