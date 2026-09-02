// ============================================================
// FAIR VALUE GAP (FVG) DETECTION
// ============================================================
// ICT/Smart-Money-Concepts "imbalance" — a 3-candle pattern where an
// impulsive middle candle leaves a price zone nothing has traded through:
// candle[i-2]'s high sits below candle[i]'s low (bullish gap, up-move), or
// candle[i-2]'s low sits above candle[i]'s high (bearish gap, down-move).
// Price often later retraces into that untraded zone before continuing —
// a bullish gap tends to act as support on the way back down into it, a
// bearish gap as resistance on the way back up. This module only answers
// the geometric question ("where are the gaps, are they still open");
// market-bias.ts decides what a live price sitting inside one means for
// direction, the same split candlestick-patterns/index.ts uses.
// ============================================================

export type FvgType = 'BULLISH' | 'BEARISH';

export interface FairValueGap {
  type: FvgType;
  /** Upper edge of the gap zone. */
  top: number;
  /** Lower edge of the gap zone. */
  bottom: number;
  /** Index of the impulse (middle) candle in the 3-candle pattern that created this gap. */
  atIndex: number;
  /** True once any later candle's range has traded back into the zone (touched or crossed it) — the standard "mitigated" definition. */
  filled: boolean;
}

/**
 * Finds every FVG in the given candle series and marks which are already
 * filled. Pass closed candles only (exclude a still-forming current bar) —
 * a live/current price should be tested against the result via
 * `testActiveFvg`, not folded into this scan, so "is price inside an
 * unfilled gap right now" and "did a later candle already fill this gap"
 * stay two separate questions instead of the current bar answering both
 * at once.
 */
export function detectFairValueGaps(highs: number[], lows: number[]): FairValueGap[] {
  const n = Math.min(highs.length, lows.length);
  const gaps: FairValueGap[] = [];

  for (let i = 2; i < n; i++) {
    const farHigh = highs[i - 2];
    const farLow = lows[i - 2];
    const nearHigh = highs[i];
    const nearLow = lows[i];
    if (farHigh == null || farLow == null || nearHigh == null || nearLow == null) continue;

    if (farHigh < nearLow) {
      gaps.push({ type: 'BULLISH', top: nearLow, bottom: farHigh, atIndex: i - 1, filled: false });
    } else if (farLow > nearHigh) {
      gaps.push({ type: 'BEARISH', top: farLow, bottom: nearHigh, atIndex: i - 1, filled: false });
    }
  }

  for (const gap of gaps) {
    // A gap's own 3-candle window ends at atIndex+1 — only a candle after
    // that can "fill" it (the candle that created it obviously doesn't).
    for (let j = gap.atIndex + 2; j < n; j++) {
      const h = highs[j];
      const l = lows[j];
      if (h == null || l == null) continue;
      if (h >= gap.bottom && l <= gap.top) {
        gap.filled = true;
        break;
      }
    }
  }

  return gaps;
}

export interface FvgTest {
  gap: FairValueGap;
  /** 0 = price just touching the zone's near edge, 1 = fully through to the far edge. */
  penetrationPct: number;
}

/**
 * Is a live price currently sitting inside the most recent still-open gap?
 * Only the single most recent unfilled gap is checked — on a choppy series
 * several stale unfilled zones can pile up, and treating "inside ANY of
 * them" as one signal would mix a live, relevant zone with old ones the
 * market has long since moved past.
 */
export function testActiveFvg(gaps: FairValueGap[], currentPrice: number): FvgTest | null {
  const unfilled = gaps.filter((g) => !g.filled);
  if (unfilled.length === 0) return null;

  const latest = unfilled[unfilled.length - 1];
  if (currentPrice > latest.top || currentPrice < latest.bottom) return null;

  const span = latest.top - latest.bottom;
  const raw = latest.type === 'BULLISH' ? (latest.top - currentPrice) / span : (currentPrice - latest.bottom) / span;
  return { gap: latest, penetrationPct: Math.max(0, Math.min(1, raw)) };
}
