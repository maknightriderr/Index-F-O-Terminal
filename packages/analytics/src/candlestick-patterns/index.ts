// ============================================================
// CANDLESTICK PATTERN DETECTION
// ============================================================
// Individual-candle and small-cluster reversal patterns from raw
// OHLC — geometric checks against real body/wick proportions, not
// a black box. Complements patterns/index.ts (which detects
// multi-swing geometric structures like Double Top/H&S) — this
// module looks at the last 1-3 candles instead.
//
// Deliberately pure: no support/resistance context baked in here.
// A hammer means more at a support level, but "is this candle near
// support" already has an answer upstream (OI walls, pivots) — this
// module just answers "is this candle shape a real signal," and the
// caller combines the two.
// ============================================================

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type CandlestickPatternType =
  | 'HAMMER'
  | 'INVERTED_HAMMER'
  | 'SHOOTING_STAR'
  | 'HANGING_MAN'
  | 'BULLISH_ENGULFING'
  | 'BEARISH_ENGULFING'
  | 'MORNING_STAR'
  | 'EVENING_STAR'
  | 'DOJI';

export interface DetectedCandlestickPattern {
  pattern: CandlestickPatternType;
  direction: 'BULLISH' | 'BEARISH';
  confidence: number; // 0-100
  /** Index into the candles array of the pattern's confirming (most recent) candle. */
  atIndex: number;
}

const DOJI_BODY_RATIO = 0.1; // body <= 10% of range counts as a doji
const TREND_LOOKBACK = 5; // bars used to judge "was this a downtrend/uptrend" context

function body(c: Candle): number {
  return Math.abs(c.close - c.open);
}
function range(c: Candle): number {
  return c.high - c.low;
}
function upperWick(c: Candle): number {
  return c.high - Math.max(c.open, c.close);
}
function lowerWick(c: Candle): number {
  return Math.min(c.open, c.close) - c.low;
}
function isBullish(c: Candle): boolean {
  return c.close > c.open;
}
function isBearish(c: Candle): boolean {
  return c.close < c.open;
}

/**
 * Was the market trending down/up into candle `i`, judged by comparing its
 * open against the average close of the preceding TREND_LOOKBACK bars.
 * A single-candle reversal pattern (hammer, shooting star) only means
 * something in the context of an existing trend to reverse.
 */
function precedingTrend(candles: Candle[], i: number): 'UP' | 'DOWN' | 'NONE' {
  if (i < TREND_LOOKBACK) return 'NONE';
  const priorCloses = candles.slice(i - TREND_LOOKBACK, i).map((c) => c.close);
  const avg = priorCloses.reduce((a, b) => a + b, 0) / priorCloses.length;
  if (candles[i].open < avg * 0.999) return 'DOWN';
  if (candles[i].open > avg * 1.001) return 'UP';
  return 'NONE';
}

/**
 * Detects the single most recent, most relevant candlestick pattern in the
 * given series. Checks 3-candle patterns first (most specific / highest
 * conviction), then 2-candle engulfing, then single-candle shapes — returns
 * the first match found looking backward from the most recent candle, or
 * null if nothing in the last few bars cleanly matches one.
 */
export function detectCandlestickPattern(candles: Candle[]): DetectedCandlestickPattern | null {
  const n = candles.length;
  if (n < 2) return null;

  // --- 3-candle: Morning Star / Evening Star ---
  if (n >= 3) {
    const [a, b, c] = candles.slice(n - 3);
    const aBody = body(a);
    const bBody = body(b);
    const cBody = body(c);

    // Morning Star: big bearish, small-bodied middle candle gapping down,
    // big bullish closing well into the first candle's body.
    if (
      isBearish(a) &&
      aBody > 0 &&
      bBody < aBody * 0.4 &&
      Math.max(b.open, b.close) < a.close + aBody * 0.2 &&
      isBullish(c) &&
      cBody > aBody * 0.5 &&
      c.close > a.open - aBody * 0.5
    ) {
      return { pattern: 'MORNING_STAR', direction: 'BULLISH', confidence: 75, atIndex: n - 1 };
    }

    // Evening Star: mirror.
    if (
      isBullish(a) &&
      aBody > 0 &&
      bBody < aBody * 0.4 &&
      Math.min(b.open, b.close) > a.close - aBody * 0.2 &&
      isBearish(c) &&
      cBody > aBody * 0.5 &&
      c.close < a.open + aBody * 0.5
    ) {
      return { pattern: 'EVENING_STAR', direction: 'BEARISH', confidence: 75, atIndex: n - 1 };
    }
  }

  // --- 2-candle: Engulfing ---
  {
    const prev = candles[n - 2];
    const cur = candles[n - 1];
    const prevBody = body(prev);

    if (prevBody > 0 && isBearish(prev) && isBullish(cur) && cur.open <= prev.close && cur.close >= prev.open) {
      return { pattern: 'BULLISH_ENGULFING', direction: 'BULLISH', confidence: 65, atIndex: n - 1 };
    }
    if (prevBody > 0 && isBullish(prev) && isBearish(cur) && cur.open >= prev.close && cur.close <= prev.open) {
      return { pattern: 'BEARISH_ENGULFING', direction: 'BEARISH', confidence: 65, atIndex: n - 1 };
    }
  }

  // --- Single-candle shapes ---
  {
    const cur = candles[n - 1];
    const curRange = range(cur);
    if (curRange <= 0) return null;

    const curBody = body(cur);
    const upper = upperWick(cur);
    const lower = lowerWick(cur);
    const trend = precedingTrend(candles, n - 1);

    // Doji: negligible body relative to range — indecision, most
    // meaningful at a trend extreme, so direction mirrors the trend it
    // interrupts (a doji in an uptrend flags possible bearish exhaustion).
    // Hammer / Hanging Man: long lower wick (>=2x body), small/no upper
    // wick, body in the upper part of the range. Bullish reversal after a
    // downtrend (Hammer); bearish warning after an uptrend (Hanging Man).
    // Checked before Doji below — a hammer's defining trait is a *small
    // body*, which would otherwise also satisfy the generic doji ratio;
    // the wick asymmetry here is the more specific, correct classification.
    if (lower >= curBody * 2 && upper <= curBody * 0.5) {
      if (trend === 'DOWN') return { pattern: 'HAMMER', direction: 'BULLISH', confidence: 60, atIndex: n - 1 };
      if (trend === 'UP') return { pattern: 'HANGING_MAN', direction: 'BEARISH', confidence: 55, atIndex: n - 1 };
    }

    // Inverted Hammer / Shooting Star: long upper wick (>=2x body),
    // small/no lower wick, body in the lower part of the range. Bullish
    // reversal after a downtrend (Inverted Hammer); bearish reversal after
    // an uptrend (Shooting Star).
    if (upper >= curBody * 2 && lower <= curBody * 0.5) {
      if (trend === 'DOWN') return { pattern: 'INVERTED_HAMMER', direction: 'BULLISH', confidence: 55, atIndex: n - 1 };
      if (trend === 'UP') return { pattern: 'SHOOTING_STAR', direction: 'BEARISH', confidence: 60, atIndex: n - 1 };
    }

    // Doji: negligible body relative to range with wicks on both sides
    // (ruling out the single-direction wick dominance already claimed by
    // hammer/shooting-star above) — indecision, most meaningful at a trend
    // extreme, so direction mirrors the trend it interrupts (a doji in an
    // uptrend flags possible bearish exhaustion).
    if (curBody <= curRange * DOJI_BODY_RATIO) {
      if (trend === 'UP') return { pattern: 'DOJI', direction: 'BEARISH', confidence: 45, atIndex: n - 1 };
      if (trend === 'DOWN') return { pattern: 'DOJI', direction: 'BULLISH', confidence: 45, atIndex: n - 1 };
      return null; // doji with no trend context isn't an actionable signal
    }
  }

  return null;
}
