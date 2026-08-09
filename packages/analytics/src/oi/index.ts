// ============================================================
// OI CLASSIFICATION ENGINE
// ============================================================
// Classifies Open Interest activity based on price and OI changes.
// Uses context-specific logic for futures vs options.
// ============================================================

import type { OIInterpretation, OptionType } from '@fno/shared';

interface OIClassificationInput {
  priceChange: number;
  oiChange: number;
  volumeChange?: number;
}

/**
 * Classify Futures OI activity.
 *
 * Price ↑ + OI ↑ → Long Buildup
 * Price ↓ + OI ↑ → Short Buildup
 * Price ↑ + OI ↓ → Short Covering
 * Price ↓ + OI ↓ → Long Unwinding
 */
export function classifyFuturesOI(input: OIClassificationInput): OIInterpretation {
  const { priceChange, oiChange } = input;

  // Define thresholds to avoid noise
  const priceThreshold = 0.01; // 0.01% minimum move
  const oiThreshold = 0;

  const priceUp = priceChange > priceThreshold;
  const priceDown = priceChange < -priceThreshold;
  const oiUp = oiChange > oiThreshold;
  const oiDown = oiChange < -oiThreshold;

  if (priceUp && oiUp) return 'LONG_BUILDUP';
  if (priceDown && oiUp) return 'SHORT_BUILDUP';
  if (priceUp && oiDown) return 'SHORT_COVERING';
  if (priceDown && oiDown) return 'LONG_UNWINDING';

  return 'NEUTRAL';
}

/**
 * Classify Options OI activity.
 *
 * For CALL options:
 *   OI ↑ → Call Writing (typically bearish signal)
 *   OI ↓ → Call Unwinding
 *
 * For PUT options:
 *   OI ↑ → Put Writing (typically bullish signal)
 *   OI ↓ → Put Unwinding
 *
 * Context-specific: Does not blindly apply futures classification.
 * Considers price direction and option type together.
 */
export function classifyOptionOI(
  input: OIClassificationInput,
  optionType: OptionType
): OIInterpretation {
  const { priceChange, oiChange } = input;

  const oiUp = oiChange > 0;
  const oiDown = oiChange < 0;

  if (optionType === 'CE') {
    if (oiUp) return 'CALL_WRITING';
    if (oiDown) return 'CALL_UNWINDING';
  } else {
    if (oiUp) return 'PUT_WRITING';
    if (oiDown) return 'PUT_UNWINDING';
  }

  return 'NEUTRAL';
}

/**
 * Get a human-readable description and market implication.
 */
export function getOIDescription(interpretation: OIInterpretation): {
  description: string;
  implication: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  emoji: string;
} {
  switch (interpretation) {
    case 'LONG_BUILDUP':
      return { description: 'Long Buildup — New longs entering', implication: 'BULLISH', emoji: '🟢' };
    case 'SHORT_BUILDUP':
      return { description: 'Short Buildup — New shorts entering', implication: 'BEARISH', emoji: '🔴' };
    case 'SHORT_COVERING':
      return { description: 'Short Covering — Shorts exiting', implication: 'BULLISH', emoji: '🟡' };
    case 'LONG_UNWINDING':
      return { description: 'Long Unwinding — Longs exiting', implication: 'BEARISH', emoji: '🟡' };
    case 'CALL_WRITING':
      return { description: 'Call Writing — Selling calls', implication: 'BEARISH', emoji: '🔴' };
    case 'PUT_WRITING':
      return { description: 'Put Writing — Selling puts', implication: 'BULLISH', emoji: '🟢' };
    case 'CALL_UNWINDING':
      return { description: 'Call Unwinding — Closing call shorts', implication: 'BULLISH', emoji: '🟡' };
    case 'PUT_UNWINDING':
      return { description: 'Put Unwinding — Closing put shorts', implication: 'BEARISH', emoji: '🟡' };
    case 'NEUTRAL':
    default:
      return { description: 'Neutral — No significant OI activity', implication: 'NEUTRAL', emoji: '⚪' };
  }
}

/**
 * Detect unusual OI activity based on historical average.
 */
export function detectUnusualOI(
  currentOI: number,
  averageOI: number,
  stdDevOI: number,
  threshold: number = 2 // standard deviations
): { isUnusual: boolean; score: number; direction: 'HIGH' | 'LOW' | 'NORMAL' } {
  if (averageOI <= 0 || stdDevOI <= 0) {
    return { isUnusual: false, score: 0, direction: 'NORMAL' };
  }

  const zScore = (currentOI - averageOI) / stdDevOI;

  return {
    isUnusual: Math.abs(zScore) > threshold,
    score: Math.min(100, Math.abs(zScore) * 25),
    direction: zScore > threshold ? 'HIGH' : zScore < -threshold ? 'LOW' : 'NORMAL',
  };
}
