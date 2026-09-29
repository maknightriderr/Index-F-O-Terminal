// ============================================================
// STRUCTURE ENGINE — REJECTION_CLOSE entry rule (pure, single-bar)
// ============================================================
// STRUCTURE_ENTRY_MODE = 'REJECTION_CLOSE' (apps/server config/trading-flags.ts)
// asks, on each CLOSED entry-timeframe bar after CONFIRMED, whether that bar
// is a rejection of the zone rather than a mere touch:
//
// PRE-REGISTERED RULE (fixed before any backtest result was seen — do not
// tune it after seeing results):
//   traded into the zone and closed back on the trade side of the zone's
//   near edge — the edge price reaches FIRST coming from the sweep side:
//     Bullish: low ≤ zone top AND close > zone top.
//     Bearish: high ≥ zone bottom AND close < zone bottom.
//   That close must also sit in the outer half of the bar's own range (the
//   upper half for bullish, the lower half for bearish) — a decisive close,
//   not a marginal one.
//   Entry is that bar's close. The stop is unchanged (the sweep extreme ±
//   buffer, already fixed at CONFIRMED).
//
// Pure and single-bar: reads only the one bar passed in, so appending later
// bars never changes what this bar decided (no look-ahead). The caller (the
// backtest harness's CLOSE_CONFIRM order, or structure-live.ts) is
// responsible for scanning bars in order, applying invalidation (a close
// beyond the sweep extreme, unchanged) and "T1 reached first = MISSED" with
// its own priority, exactly as the harness's LIMIT/TOUCH scan already does
// for touched-vs-reached.
// ============================================================

import { classifyCandleShape, type SweepCandlePattern } from './candle-labels.js';
import type { StructureDirection } from './index.js';

export interface RejectionCloseBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface RejectionCloseZone {
  near: number;
  far: number;
  kind: 'FVG' | 'DISP_50';
}

export interface RejectionCloseFill {
  /** The bar's close — the entry price. */
  entry: number;
  /** The rejection candle's own single-bar shape. */
  shape: SweepCandlePattern;
  /** e.g. "Hammer at FVG". */
  label: string;
}

const SHAPE_TEXT: Record<SweepCandlePattern, string> = {
  HAMMER: 'Hammer',
  SHOOTING_STAR: 'Shooting star',
  PIN_BAR: 'Pin bar',
  REJECTION: 'Rejection candle',
  TWEEZER_BOTTOM: 'Tweezer bottom',
  TWEEZER_TOP: 'Tweezer top',
  TWO_BAR_SWEEP: 'Two-bar rejection',
};

/**
 * Whether `bar` is a REJECTION_CLOSE entry for this zone/direction. Null when
 * it is not — the caller then checks invalidation and target-reached itself.
 */
export function rejectionCloseFill(bar: RejectionCloseBar, zone: RejectionCloseZone, direction: StructureDirection): RejectionCloseFill | null {
  const range = bar.high - bar.low;
  if (!(range > 0)) return null;
  const top = Math.max(zone.near, zone.far);
  const bottom = Math.min(zone.near, zone.far);
  const closeFrac = (bar.close - bar.low) / range;
  if (direction === 'BULLISH') {
    if (!(bar.low <= top && bar.close > top)) return null;
    if (closeFrac < 0.5) return null;
  } else {
    if (!(bar.high >= bottom && bar.close < bottom)) return null;
    if (closeFrac > 0.5) return null;
  }
  const shape = classifyCandleShape(bar, direction === 'BULLISH');
  return { entry: bar.close, shape, label: `${SHAPE_TEXT[shape]} at ${zone.kind === 'FVG' ? 'FVG' : 'the 50% zone'}` };
}
