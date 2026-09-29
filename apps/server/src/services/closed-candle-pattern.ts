// ============================================================
// CONSENSUS CANDLESTICK READ — closed bars only (pure)
// ============================================================
// The consensus engine names the last candlestick shape (hammer, engulfing,
// morning star, ...) for its reasoning text, its recorded context and the
// strategy label. It used to read candles15m.slice(-15), which ends with the
// STILL-FORMING bar: a hammer could appear mid-bar and be gone when the bar
// closed. It now reads CLOSED bars only, with the same rule the momentum and
// structure engines use (closedBarsAt: a bar is closed once open + interval
// ≤ now), so the forming bar can neither produce nor erase a pattern.
// Labelling only — the pattern never votes or gates.
// ============================================================

import { closedBarsAt, detectCandlestickPattern, type DetectedCandlestickPattern } from '@fno/analytics';
import type { OHLCV } from '@fno/shared';

/** Candles the detector sees: its trend context (5 bars) plus up to 3-candle patterns, with margin. */
export const CANDLE_PATTERN_LOOKBACK = 15;

/** The candles that had CLOSED at `now` (ascending input; only the tail is trimmed). */
export function closedCandlesAt(candles: readonly OHLCV[], now: number, barMs: number): OHLCV[] {
  const timed = candles.map((c) => ({ time: Date.parse(c.timestamp), c }));
  return closedBarsAt(timed, now, barMs).map((x) => x.c);
}

/** The candlestick pattern on the last CLOSED bar at `now` (null when none). */
export function closedCandlestickPattern(candles: readonly OHLCV[], now: number, barMs: number): DetectedCandlestickPattern | null {
  return detectCandlestickPattern(closedCandlesAt(candles, now, barMs).slice(-CANDLE_PATTERN_LOOKBACK));
}
