// ============================================================
// STRUCTURE ENGINE — candle labels for a setup (pure, descriptive)
// ============================================================
// Names the candles of a structure setup the way a chart reader would:
//
//   sweep candle   1-bar sweep: HAMMER (bullish, at a sell-side pool) /
//                  SHOOTING_STAR (bearish, at a buy-side pool) when the
//                  rejection wick is ≥ 2× the body and the opposite wick is
//                  ≤ ½ the body; else PIN_BAR when the rejection wick is
//                  ≥ 2× the body and the close is in the outer third of the
//                  range; else REJECTION (a sweep, but not a clean shape).
//                  2-bar sweep: TWEEZER_BOTTOM / TWEEZER_TOP when the two
//                  bars' extremes are within 0.1 ATR; else TWO_BAR_SWEEP.
//   displacement   BULLISH_ENGULFING / BEARISH_ENGULFING when its body
//                  covers the previous bar's body; else MOMENTUM_CANDLE.
//   combination    MORNING_STAR / EVENING_STAR when the sweep bar, a
//                  small-bodied bar and the displacement are consecutive.
//
// LABELS ONLY. Nothing here feeds a sweep, displacement, zone, fill, stop,
// T1, LATE or MISSED decision; the score adds a small, capped bonus for a
// clean rejection (scoreStructureSetup), and the score never gates.
//
// LOOK-AHEAD: reads only bars from the bar before the sweep through the
// displacement bar — all at or before the confirmation bar. The geometry
// (body, wicks, range) is the candlestick detector's own.
// ============================================================

import { candleGeometry, type Candle } from '../candlestick-patterns/index.js';
import type { PoolKind, StructureDirection } from './index.js';

export type SweepCandlePattern = 'HAMMER' | 'SHOOTING_STAR' | 'PIN_BAR' | 'REJECTION' | 'TWEEZER_BOTTOM' | 'TWEEZER_TOP' | 'TWO_BAR_SWEEP';
export type DisplacementCandlePattern = 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING' | 'MOMENTUM_CANDLE';
export type StructureComboPattern = 'MORNING_STAR' | 'EVENING_STAR';

export interface StructureCandlePatterns {
  sweepPattern: SweepCandlePattern;
  /** Null until the displacement has printed. */
  displacementPattern: DisplacementCandlePattern | null;
  combo: StructureComboPattern | null;
  /** Human text, e.g. "Hammer sweep of PDL → bullish engulfing". */
  label: string;
}

/** Definitions of the shapes (descriptive thresholds, not tuned on outcomes). */
export const CANDLE_LABEL_RULES = {
  /** Rejection wick ≥ this × the body (hammer, shooting star, pin bar). */
  wickBodyMult: 2,
  /** Hammer / shooting star: the opposite wick ≤ this × the body (the candlestick detector's own ratio). */
  oppositeWickBodyMult: 0.5,
  /** Pin bar: the close sits in this outer fraction of the range, on the rejection side. */
  pinCloseOuterFrac: 1 / 3,
  /** Tweezer: the two bars' extremes are within this much ATR. */
  tweezerTolAtr: 0.1,
  /** Morning / evening star: the middle bar's body is at most this much ATR. */
  starMiddleBodyAtr: 0.3,
} as const;

/** The sweep candle is a clean rejection (the score's +4). */
export const CLEAN_REJECTION_PATTERNS: readonly SweepCandlePattern[] = ['HAMMER', 'SHOOTING_STAR', 'PIN_BAR', 'TWEEZER_BOTTOM', 'TWEEZER_TOP'];

const POOL_SHORT: Record<PoolKind, string> = {
  PREV_DAY_HIGH: 'PDH',
  PREV_DAY_LOW: 'PDL',
  EQUAL_HIGHS: 'EQH',
  EQUAL_LOWS: 'EQL',
  SESSION_HIGH: 'the session high',
  SESSION_LOW: 'the session low',
  OPENING_RANGE_HIGH: 'the opening-range high',
  OPENING_RANGE_LOW: 'the opening-range low',
  SWING_HIGH: 'a swing high',
  SWING_LOW: 'a swing low',
};

const SWEEP_TEXT: Record<SweepCandlePattern, string> = {
  HAMMER: 'Hammer sweep of',
  SHOOTING_STAR: 'Shooting-star sweep of',
  PIN_BAR: 'Pin-bar sweep of',
  REJECTION: 'Rejection sweep of',
  TWEEZER_BOTTOM: 'Tweezer bottom at',
  TWEEZER_TOP: 'Tweezer top at',
  TWO_BAR_SWEEP: 'Two-bar sweep of',
};

const DISPLACEMENT_TEXT: Record<DisplacementCandlePattern, string> = {
  BULLISH_ENGULFING: 'bullish engulfing',
  BEARISH_ENGULFING: 'bearish engulfing',
  MOMENTUM_CANDLE: 'momentum candle',
};

const COMBO_TEXT: Record<StructureComboPattern, string> = { MORNING_STAR: 'morning star', EVENING_STAR: 'evening star' };

/** The setup fields the labels read (a StructureSetup satisfies it). */
export interface CandleLabelInput {
  direction: StructureDirection;
  pool: { kind: PoolKind };
  sweep: { index: number; bars: 1 | 2 };
  displacement: { index: number } | null;
  /** ATR at the sweep (the engine's own). */
  atr: number;
}

function classifyOneBarSweep(c: Candle, bullish: boolean): SweepCandlePattern {
  const R = CANDLE_LABEL_RULES;
  const span = candleGeometry.range(c);
  if (!(span > 0)) return 'REJECTION';
  const b = candleGeometry.body(c);
  const rejectWick = bullish ? candleGeometry.lowerWick(c) : candleGeometry.upperWick(c);
  const otherWick = bullish ? candleGeometry.upperWick(c) : candleGeometry.lowerWick(c);
  if (rejectWick >= R.wickBodyMult * b && otherWick <= R.oppositeWickBodyMult * b) return bullish ? 'HAMMER' : 'SHOOTING_STAR';
  const closeFrac = (c.close - c.low) / span;
  const outer = bullish ? closeFrac >= 1 - R.pinCloseOuterFrac : closeFrac <= R.pinCloseOuterFrac;
  if (rejectWick >= R.wickBodyMult * b && outer) return 'PIN_BAR';
  return 'REJECTION';
}

/**
 * The single-bar sweep-candle shapes (HAMMER / SHOOTING_STAR / PIN_BAR /
 * REJECTION), exposed for reuse outside sweep classification — e.g. the
 * REJECTION_CLOSE entry rule (structure-engine/rejection-close.ts) names the
 * candle that confirms entry the same way a sweep candle is named.
 */
export function classifyCandleShape(c: Candle, bullish: boolean): SweepCandlePattern {
  return classifyOneBarSweep(c, bullish);
}

function classifyDisplacement(d: Candle, prev: Candle | undefined, bullish: boolean): DisplacementCandlePattern {
  if (prev) {
    const dLo = Math.min(d.open, d.close);
    const dHi = Math.max(d.open, d.close);
    const pLo = Math.min(prev.open, prev.close);
    const pHi = Math.max(prev.open, prev.close);
    if (dLo <= pLo && dHi >= pHi) return bullish ? 'BULLISH_ENGULFING' : 'BEARISH_ENGULFING';
  }
  return 'MOMENTUM_CANDLE';
}

/**
 * Names the setup's candles. Pure; reads bars[sweep.index − 1 ..
 * displacement.index] only (bars at or before the confirmation bar), so
 * appending later bars never changes the result.
 */
export function classifyStructureCandles(bars: readonly Candle[], setup: CandleLabelInput): StructureCandlePatterns {
  const R = CANDLE_LABEL_RULES;
  const bullish = setup.direction === 'BULLISH';
  const j = setup.sweep.index;
  let sweepPattern: SweepCandlePattern;
  if (setup.sweep.bars === 2 && j - 1 >= 0) {
    const a = bars[j - 1];
    const b = bars[j];
    const gap = bullish ? Math.abs(a.low - b.low) : Math.abs(a.high - b.high);
    sweepPattern = gap <= R.tweezerTolAtr * setup.atr ? (bullish ? 'TWEEZER_BOTTOM' : 'TWEEZER_TOP') : 'TWO_BAR_SWEEP';
  } else {
    sweepPattern = classifyOneBarSweep(bars[j], bullish);
  }

  let displacementPattern: DisplacementCandlePattern | null = null;
  let combo: StructureComboPattern | null = null;
  const d = setup.displacement?.index;
  if (d != null && d < bars.length) {
    displacementPattern = classifyDisplacement(bars[d], bars[d - 1], bullish);
    if (d === j + 2 && candleGeometry.body(bars[j + 1]) <= R.starMiddleBodyAtr * setup.atr) combo = bullish ? 'MORNING_STAR' : 'EVENING_STAR';
  }

  const pool = POOL_SHORT[setup.pool.kind] ?? setup.pool.kind.replace(/_/g, ' ').toLowerCase();
  let label = `${SWEEP_TEXT[sweepPattern]} ${pool}`;
  if (displacementPattern) label += ` → ${DISPLACEMENT_TEXT[displacementPattern]}`;
  if (combo) label += ` (${COMBO_TEXT[combo]})`;
  return { sweepPattern, displacementPattern, combo, label };
}

/** Readable name of a pattern code, for reports and screens ("PIN_BAR" → "pin bar"). */
export function candlePatternText(p: string | null | undefined): string {
  return p ? p.replace(/_/g, ' ').toLowerCase() : '—';
}
