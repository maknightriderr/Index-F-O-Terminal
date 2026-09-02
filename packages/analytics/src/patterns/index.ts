// ============================================================
// CHART PATTERN DETECTION
// ============================================================
// Swing-point (fractal) based detection of classic technical
// patterns from real OHLC candles — geometric checks against
// actual price data, not a black box. Returns the single most
// recent/relevant pattern found, or null if nothing in the
// recent swing structure cleanly matches one (a noisy chart with
// no clean pattern should report nothing, not force a guess).
//
// Scope is deliberately bounded to patterns identifiable from
// swing highs/lows over the last ~100 candles: double top/bottom,
// head & shoulders (+ inverse), the three triangle types, rising/
// falling wedges, and bullish/bearish flags. This is the standard
// textbook set reliably detectable without visual/ML pattern
// matching.
// ============================================================

export type ChartPatternType =
  | 'DOUBLE_TOP'
  | 'DOUBLE_BOTTOM'
  | 'HEAD_AND_SHOULDERS'
  | 'INVERSE_HEAD_AND_SHOULDERS'
  | 'ASCENDING_TRIANGLE'
  | 'DESCENDING_TRIANGLE'
  | 'SYMMETRIC_TRIANGLE'
  | 'RISING_WEDGE'
  | 'FALLING_WEDGE'
  | 'BULLISH_FLAG'
  | 'BEARISH_FLAG';

export interface SwingPoint {
  index: number;
  price: number;
}

export interface DetectedPattern {
  pattern: ChartPatternType;
  direction: 'BULLISH' | 'BEARISH';
  confidence: number; // 0-100
  /** Index into the candle array where the pattern's last confirming point sits. */
  atIndex: number;
}

const PEAK_TOLERANCE_PCT = 0.02; // peaks/troughs within 2% count as "equal height"
const MIN_DEPTH_PCT = 0.015; // a trough/peak between two equal points must differ by at least 1.5% to count as real structure

/**
 * Fractal swing points: a bar is a peak if it's strictly higher than
 * `lookback` bars on both sides (same for troughs on lows). Standard
 * Williams Fractal shape; lookback=2 is the conventional 5-bar fractal.
 */
export function findSwingPoints(
  highs: number[],
  lows: number[],
  lookback: number = 2
): { peaks: SwingPoint[]; troughs: SwingPoint[] } {
  const peaks: SwingPoint[] = [];
  const troughs: SwingPoint[] = [];

  for (let i = lookback; i < highs.length - lookback; i++) {
    let isPeak = true;
    let isTrough = true;
    for (let j = 1; j <= lookback; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isPeak = false;
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) isTrough = false;
    }
    if (isPeak) peaks.push({ index: i, price: highs[i] });
    if (isTrough) troughs.push({ index: i, price: lows[i] });
  }

  return { peaks, troughs };
}

function pctDiff(a: number, b: number): number {
  const avg = (a + b) / 2;
  return avg > 0 ? Math.abs(a - b) / avg : 1;
}

function confidenceFromTightness(diffPct: number, tolerance: number): number {
  // Closer to a perfect match (diff near 0) scores higher; right at the
  // tolerance boundary scores at the floor. Kept in [55, 92] — never
  // claims certainty, never drops below "this is why it matched at all".
  const closeness = 1 - Math.min(1, diffPct / tolerance);
  return Math.round(55 + closeness * 37);
}

/**
 * Detects the single most recent pattern from the tail of the swing
 * structure. Checked in roughly the order a chartist would look —
 * reversal patterns (double top/bottom, H&S) before continuation
 * shapes (triangles, wedges, flags) — and returns the first match.
 *
 * `volumes`, when provided, adjusts the returned confidence for whether
 * volume behaved the way classical TA expects while the pattern formed
 * (H&S/triangles/flags all textbook-expect volume drying up through the
 * pattern, confirming on the eventual breakout) — declining volume
 * nudges confidence up, rising volume (less classic) nudges it down.
 * Applied post-hoc against a fixed lookback ending at the pattern's own
 * atIndex rather than threaded into each individual sub-detector (which
 * would need every one of the 7 pattern functions below to separately
 * track and expose its own start index) — a deliberate simplification,
 * not a claim that every pattern's true formation window is exactly
 * this length.
 */
export function detectPattern(highs: number[], lows: number[], closes: number[], volumes?: number[]): DetectedPattern | null {
  if (highs.length < 15) return null;

  const { peaks, troughs } = findSwingPoints(highs, lows);

  const doubleTop = detectDoubleTop(peaks, troughs);
  if (doubleTop) return withVolumeConfirmation(doubleTop, volumes);

  const doubleBottom = detectDoubleBottom(peaks, troughs);
  if (doubleBottom) return withVolumeConfirmation(doubleBottom, volumes);

  const hs = detectHeadAndShoulders(peaks, troughs);
  if (hs) return withVolumeConfirmation(hs, volumes);

  const ihs = detectInverseHeadAndShoulders(peaks, troughs);
  if (ihs) return withVolumeConfirmation(ihs, volumes);

  const triangle = detectTriangle(peaks, troughs, closes);
  if (triangle) return withVolumeConfirmation(triangle, volumes);

  const wedge = detectWedge(peaks, troughs);
  if (wedge) return withVolumeConfirmation(wedge, volumes);

  const flag = detectFlag(highs, lows, closes);
  if (flag) return withVolumeConfirmation(flag, volumes);

  return null;
}

const VOLUME_CONFIRMATION_LOOKBACK = 20; // bars treated as "the pattern's formation window" for the volume-trend check
const MAX_VOLUME_CONFIDENCE_ADJUSTMENT = 8; // +/- cap so this never swings a match past believable

function withVolumeConfirmation(pattern: DetectedPattern, volumes: number[] | undefined): DetectedPattern {
  if (!volumes || volumes.length === 0) return pattern;

  const end = Math.min(pattern.atIndex, volumes.length - 1);
  const start = Math.max(0, end - VOLUME_CONFIRMATION_LOOKBACK + 1);
  if (end - start < 3) return pattern; // too short a window for a trend read to mean anything

  const mid = start + Math.floor((end - start) / 2);
  const early = volumes.slice(start, mid + 1);
  const late = volumes.slice(mid + 1, end + 1);
  const avgEarly = early.reduce((a, b) => a + b, 0) / early.length;
  const avgLate = late.length > 0 ? late.reduce((a, b) => a + b, 0) / late.length : avgEarly;
  if (avgEarly <= 0) return pattern;

  // Positive = volume declined through the window (textbook), negative =
  // it rose (atypical) — scaled and capped into a small confidence nudge.
  const declinePct = (avgEarly - avgLate) / avgEarly;
  const adjustment = Math.max(-MAX_VOLUME_CONFIDENCE_ADJUSTMENT, Math.min(MAX_VOLUME_CONFIDENCE_ADJUSTMENT, Math.round(declinePct * 20)));
  if (adjustment === 0) return pattern;

  return { ...pattern, confidence: Math.max(50, Math.min(95, pattern.confidence + adjustment)) };
}

// --- Double Top / Bottom ---

function detectDoubleTop(peaks: SwingPoint[], troughs: SwingPoint[]): DetectedPattern | null {
  if (peaks.length < 2) return null;
  const [p1, p2] = peaks.slice(-2);
  const between = troughs.filter((t) => t.index > p1.index && t.index < p2.index);
  if (between.length === 0) return null;
  const neckline = Math.min(...between.map((t) => t.price));

  const heightDiff = pctDiff(p1.price, p2.price);
  const depth = (Math.min(p1.price, p2.price) - neckline) / neckline;
  if (heightDiff > PEAK_TOLERANCE_PCT || depth < MIN_DEPTH_PCT) return null;

  return {
    pattern: 'DOUBLE_TOP',
    direction: 'BEARISH',
    confidence: confidenceFromTightness(heightDiff, PEAK_TOLERANCE_PCT),
    atIndex: p2.index,
  };
}

function detectDoubleBottom(peaks: SwingPoint[], troughs: SwingPoint[]): DetectedPattern | null {
  if (troughs.length < 2) return null;
  const [t1, t2] = troughs.slice(-2);
  const between = peaks.filter((p) => p.index > t1.index && p.index < t2.index);
  if (between.length === 0) return null;
  const neckline = Math.max(...between.map((p) => p.price));

  const depthDiff = pctDiff(t1.price, t2.price);
  const height = (neckline - Math.max(t1.price, t2.price)) / neckline;
  if (depthDiff > PEAK_TOLERANCE_PCT || height < MIN_DEPTH_PCT) return null;

  return {
    pattern: 'DOUBLE_BOTTOM',
    direction: 'BULLISH',
    confidence: confidenceFromTightness(depthDiff, PEAK_TOLERANCE_PCT),
    atIndex: t2.index,
  };
}

// --- Head & Shoulders ---

function detectHeadAndShoulders(peaks: SwingPoint[], troughs: SwingPoint[]): DetectedPattern | null {
  if (peaks.length < 3) return null;
  const [ls, head, rs] = peaks.slice(-3);
  if (!(head.price > ls.price && head.price > rs.price)) return null;

  const shoulderDiff = pctDiff(ls.price, rs.price);
  if (shoulderDiff > PEAK_TOLERANCE_PCT) return null;

  const neck1 = troughs.filter((t) => t.index > ls.index && t.index < head.index);
  const neck2 = troughs.filter((t) => t.index > head.index && t.index < rs.index);
  if (neck1.length === 0 || neck2.length === 0) return null;
  const necklineDiff = pctDiff(Math.min(...neck1.map((t) => t.price)), Math.min(...neck2.map((t) => t.price)));
  if (necklineDiff > PEAK_TOLERANCE_PCT * 1.5) return null;

  return {
    pattern: 'HEAD_AND_SHOULDERS',
    direction: 'BEARISH',
    confidence: confidenceFromTightness(shoulderDiff, PEAK_TOLERANCE_PCT),
    atIndex: rs.index,
  };
}

function detectInverseHeadAndShoulders(peaks: SwingPoint[], troughs: SwingPoint[]): DetectedPattern | null {
  if (troughs.length < 3) return null;
  const [ls, head, rs] = troughs.slice(-3);
  if (!(head.price < ls.price && head.price < rs.price)) return null;

  const shoulderDiff = pctDiff(ls.price, rs.price);
  if (shoulderDiff > PEAK_TOLERANCE_PCT) return null;

  const neck1 = peaks.filter((p) => p.index > ls.index && p.index < head.index);
  const neck2 = peaks.filter((p) => p.index > head.index && p.index < rs.index);
  if (neck1.length === 0 || neck2.length === 0) return null;
  const necklineDiff = pctDiff(Math.max(...neck1.map((p) => p.price)), Math.max(...neck2.map((p) => p.price)));
  if (necklineDiff > PEAK_TOLERANCE_PCT * 1.5) return null;

  return {
    pattern: 'INVERSE_HEAD_AND_SHOULDERS',
    direction: 'BULLISH',
    confidence: confidenceFromTightness(shoulderDiff, PEAK_TOLERANCE_PCT),
    atIndex: rs.index,
  };
}

// --- Triangles ---
// Needs the trend of the last 2 peaks and last 2 troughs: flat+rising =
// ascending, falling+flat = descending, falling+rising (converging) =
// symmetric.

const FLAT_SLOPE_TOLERANCE = 0.01; // within 1% counts as "flat"

function detectTriangle(peaks: SwingPoint[], troughs: SwingPoint[], closes: number[]): DetectedPattern | null {
  if (peaks.length < 2 || troughs.length < 2) return null;
  const [p1, p2] = peaks.slice(-2);
  const [t1, t2] = troughs.slice(-2);

  const peakSlope = (p2.price - p1.price) / p1.price;
  const troughSlope = (t2.price - t1.price) / t1.price;

  const peaksFlat = Math.abs(peakSlope) <= FLAT_SLOPE_TOLERANCE;
  const peaksFalling = peakSlope < -FLAT_SLOPE_TOLERANCE;
  const troughsFlat = Math.abs(troughSlope) <= FLAT_SLOPE_TOLERANCE;
  const troughsRising = troughSlope > FLAT_SLOPE_TOLERANCE;

  const atIndex = Math.max(p2.index, t2.index);
  const tightness = 1 - Math.min(1, (Math.abs(peakSlope) + Math.abs(troughSlope)) / (FLAT_SLOPE_TOLERANCE * 4));
  const confidence = Math.round(55 + Math.max(0, tightness) * 30);

  if (peaksFlat && troughsRising) {
    return { pattern: 'ASCENDING_TRIANGLE', direction: 'BULLISH', confidence, atIndex };
  }
  if (troughsFlat && peaksFalling) {
    return { pattern: 'DESCENDING_TRIANGLE', direction: 'BEARISH', confidence, atIndex };
  }
  if (peaksFalling && troughsRising) {
    // Continuation pattern — direction follows the trend into the triangle.
    const trendDirection = closes[closes.length - 1] >= closes[Math.max(0, closes.length - 20)] ? 'BULLISH' : 'BEARISH';
    return { pattern: 'SYMMETRIC_TRIANGLE', direction: trendDirection, confidence, atIndex };
  }

  return null;
}

// --- Wedges ---
// Both trendlines move the same direction but converge: rising wedge
// (peaks rising slower than troughs close in) is bearish, falling wedge
// (troughs falling slower than peaks close in) is bullish.

function detectWedge(peaks: SwingPoint[], troughs: SwingPoint[]): DetectedPattern | null {
  if (peaks.length < 2 || troughs.length < 2) return null;
  const [p1, p2] = peaks.slice(-2);
  const [t1, t2] = troughs.slice(-2);

  const peakSlope = (p2.price - p1.price) / p1.price;
  const troughSlope = (t2.price - t1.price) / t1.price;
  const atIndex = Math.max(p2.index, t2.index);

  const bothRising = peakSlope > FLAT_SLOPE_TOLERANCE && troughSlope > FLAT_SLOPE_TOLERANCE;
  const bothFalling = peakSlope < -FLAT_SLOPE_TOLERANCE && troughSlope < -FLAT_SLOPE_TOLERANCE;
  // The peak line and trough line converge (the gap between them narrows
  // over time) whenever the peak line's slope is below the trough line's —
  // true regardless of whether both are rising or both are falling.
  const converging = peakSlope < troughSlope;
  const convergence = troughSlope - peakSlope;

  if (bothRising && converging) {
    return { pattern: 'RISING_WEDGE', direction: 'BEARISH', confidence: confidenceFromTightness(1 / (1 + convergence * 20), 1), atIndex };
  }
  if (bothFalling && converging) {
    return { pattern: 'FALLING_WEDGE', direction: 'BULLISH', confidence: confidenceFromTightness(1 / (1 + convergence * 20), 1), atIndex };
  }

  return null;
}

// --- Flags / Pennants ---
// A strong directional "pole" over the recent-but-not-latest window,
// followed by a tight sideways consolidation in the most recent bars.

const POLE_MOVE_THRESHOLD = 0.05; // >=5% move to count as a pole
const FLAG_RANGE_THRESHOLD = 0.03; // consolidation range must stay within 3%

function detectFlag(highs: number[], lows: number[], closes: number[]): DetectedPattern | null {
  const n = closes.length;
  if (n < 20) return null;

  const flagBars = 6;
  const poleBars = 12;

  const flagWindow = closes.slice(n - flagBars);
  const flagHigh = Math.max(...highs.slice(n - flagBars));
  const flagLow = Math.min(...lows.slice(n - flagBars));
  const flagRange = flagLow > 0 ? (flagHigh - flagLow) / flagLow : 1;
  if (flagRange > FLAG_RANGE_THRESHOLD) return null;

  const poleStart = closes[Math.max(0, n - flagBars - poleBars)];
  const poleEnd = closes[n - flagBars - 1] ?? closes[0];
  if (poleStart <= 0) return null;
  const poleMove = (poleEnd - poleStart) / poleStart;

  if (poleMove >= POLE_MOVE_THRESHOLD) {
    return {
      pattern: 'BULLISH_FLAG',
      direction: 'BULLISH',
      confidence: confidenceFromTightness(flagRange, FLAG_RANGE_THRESHOLD),
      atIndex: n - 1,
    };
  }
  if (poleMove <= -POLE_MOVE_THRESHOLD) {
    return {
      pattern: 'BEARISH_FLAG',
      direction: 'BEARISH',
      confidence: confidenceFromTightness(flagRange, FLAG_RANGE_THRESHOLD),
      atIndex: n - 1,
    };
  }

  return null;
}
