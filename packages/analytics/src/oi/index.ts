// ============================================================
// OI CLASSIFICATION ENGINE
// ============================================================
// Classifies Open Interest activity based on price and OI changes.
// Uses context-specific logic for futures vs options.
// ============================================================

import type {
  OIInterpretation,
  OptionType,
  OptionChainStrike,
  PositionMomentum,
  OiSideActivity,
  OiTrapAnalysis,
  OiTrapSide,
} from '@fno/shared';

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

// --- Position Momentum (which side is building / reducing) ---

/**
 * Aggregates OI and OI-change across every strike in view, per side, and
 * classifies each side with the same classifyFuturesOI/classifyOptionOI
 * logic already used per-leg — no new classification rule, just rolled up.
 */
export function analyzePositionMomentum(
  strikes: OptionChainStrike[],
  underlyingChangePercent: number
): PositionMomentum {
  let callOi = 0;
  let putOi = 0;
  let callOiChange = 0;
  let putOiChange = 0;

  for (const s of strikes) {
    if (s.call) {
      callOi += s.call.oi;
      callOiChange += s.call.changeOi;
    }
    if (s.put) {
      putOi += s.put.oi;
      putOiChange += s.put.changeOi;
    }
  }

  const activityOf = (oiChange: number, totalOi: number): OiSideActivity => {
    if (totalOi <= 0) return 'FLAT';
    const pctOfOi = (oiChange / totalOi) * 100;
    if (pctOfOi > 1) return 'BUILDING';
    if (pctOfOi < -1) return 'REDUCING';
    return 'FLAT';
  };

  return {
    callOi,
    putOi,
    callOiChange,
    putOiChange,
    callInterpretation: classifyOptionOI({ priceChange: underlyingChangePercent, oiChange: callOiChange }, 'CE'),
    putInterpretation: classifyOptionOI({ priceChange: underlyingChangePercent, oiChange: putOiChange }, 'PE'),
    callActivity: activityOf(callOiChange, callOi),
    putActivity: activityOf(putOiChange, putOi),
  };
}

// --- OI Trapping ---

/**
 * Flags when spot is pushing through (or sitting right at) the strike
 * carrying the heaviest OI on a side — the "wall" writers on that side
 * were leaning on. Call writers profit while spot stays below their
 * strike; when spot pushes up through it, they're underwater and a
 * short-covering squeeze can accelerate the move (and symmetrically for
 * put writers on the downside). This only needs the current chain — no
 * separate premium-history feed — so it stays reliable even when a
 * symbol's OI-baseline history is thin (a new listing, first day, etc).
 */
export function analyzeOiTrap(strikes: OptionChainStrike[], spotPrice: number): OiTrapAnalysis {
  let callWall: { strike: number; oi: number } | null = null;
  let putWall: { strike: number; oi: number } | null = null;

  for (const s of strikes) {
    if (s.call && (!callWall || s.call.oi > callWall.oi)) callWall = { strike: s.strike, oi: s.call.oi };
    if (s.put && (!putWall || s.put.oi > putWall.oi)) putWall = { strike: s.strike, oi: s.put.oi };
  }

  const BREACH_BUFFER_PCT = -0.2; // strike counts as "under pressure" once spot is within 0.2% of it

  const callTrap: OiTrapSide =
    callWall && callWall.strike > 0
      ? (() => {
          const breachPct = ((spotPrice - callWall!.strike) / callWall!.strike) * 100;
          return breachPct > BREACH_BUFFER_PCT
            ? { active: true, strike: callWall!.strike, strength: clamp(Math.round(50 + breachPct * 50), 10, 100) }
            : { active: false, strike: callWall!.strike, strength: 0 };
        })()
      : { active: false, strike: null, strength: 0 };

  const putTrap: OiTrapSide =
    putWall && putWall.strike > 0
      ? (() => {
          const breachPct = ((putWall!.strike - spotPrice) / putWall!.strike) * 100;
          return breachPct > BREACH_BUFFER_PCT
            ? { active: true, strike: putWall!.strike, strength: clamp(Math.round(50 + breachPct * 50), 10, 100) }
            : { active: false, strike: putWall!.strike, strength: 0 };
        })()
      : { active: false, strike: null, strength: 0 };

  const summary =
    callTrap.active && putTrap.active
      ? `Spot is pressuring both the call wall (${callWall!.strike}) and put wall (${putWall!.strike}) — heavy OI writers on both sides are under pressure.`
      : callTrap.active
      ? `Call writers concentrated at ${callWall!.strike} are under pressure — a short-covering squeeze can accelerate upside.`
      : putTrap.active
      ? `Put writers concentrated at ${putWall!.strike} are under pressure — unwinding can accelerate downside.`
      : 'No OI wall is currently under pressure — spot sits comfortably between the call and put walls.';

  return { call: callTrap, put: putTrap, summary };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
