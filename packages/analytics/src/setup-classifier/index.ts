// ============================================================
// SETUP CLASSIFICATION
// ============================================================
// Names the setup the engine ALREADY detected. It detects nothing itself.
//
// This is the difference that makes the module safe: every input below is a
// reading the bias engine had already computed and already voted on before
// this function was called. Classification reads those readings and returns
// a label. It cannot see anything the engine did not see, it cannot change
// what the engine concluded, and its output is written to the decision
// record and to nothing else.
//
// WHY IT EXISTS
//
// Setup-specific expectancy — which kinds of setup actually pay, and which
// should eventually be restricted — cannot be computed at all without this,
// no matter how many observations accumulate. Every trade in the recorded
// book is untyped, so the question "do liquidity-sweep reversals work
// better than flag breakouts" has never been answerable, and would still be
// unanswerable a year from now if the tagging never landed.
//
// WHY IT RETURNS UNKNOWN SO READILY
//
// A fabricated setup label is worse than a missing one. A missing label
// shows up as UNKNOWN and gets excluded from a setup-specific breakdown
// with its sample size visible. A guessed label quietly pollutes the
// expectancy of whichever family it was guessed into, and nothing
// downstream can tell it apart from a real detection. So the rule here is
// that a setup is named only when a specific detector actually fired.
// ============================================================

export type SetupFamily =
  | 'BREAKOUT'
  | 'REVERSAL'
  | 'CONTINUATION'
  | 'MEAN_REVERSION'
  | 'STRUCTURE'
  | 'UNKNOWN';

export type SetupType =
  | 'VCP_BREAKOUT'
  | 'BOLLINGER_BREAKOUT'
  | 'LIQUIDITY_SWEEP_REVERSAL'
  | 'BOS_CONTINUATION'
  | 'CHOCH_REVERSAL'
  | 'FVG_RETEST'
  | 'ORDER_BLOCK_RETEST'
  | 'BULL_FLAG'
  | 'BEAR_FLAG'
  | 'INVERSE_HS'
  | 'HEAD_AND_SHOULDERS'
  | 'DOUBLE_BOTTOM'
  | 'DOUBLE_TOP'
  | 'TRIANGLE_BREAKOUT'
  | 'WEDGE_REVERSAL'
  | 'CHANNEL_CONTINUATION'
  | 'VWAP_RECLAIM'
  | 'SUPERTREND_FLIP'
  | 'EMA_TREND_CONTINUATION'
  | 'RSI_DIVERGENCE_REVERSAL'
  | 'UNKNOWN';

/**
 * Readings the bias engine had already produced when it decided. Every one
 * is optional: a decision made without a given detector available simply
 * does not get classified on it.
 */
export interface SetupClassificationInput {
  /** Direction the engine concluded, used only to pick the matching side of a two-sided pattern. */
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** Multi-swing chart pattern name on the short tier, as detectPattern named it. */
  shortPattern?: string | null;
  /** Same on the long tier. */
  longPattern?: string | null;
  /** VCP base detected, and whether its breakout was volume-confirmed. */
  vcpDetected?: boolean;
  vcpBreakoutConfirmed?: boolean;
  /** Last market-structure event, as analyzeMarketStructure classified it. */
  structureEvent?: { type: 'BOS' | 'CHOCH'; direction: 'BULLISH' | 'BEARISH' } | null;
  /** A liquidity sweep on the last closed bar. */
  liquiditySweep?: { type: 'BUY_SIDE' | 'SELL_SIDE' } | null;
  /** Price currently inside a fair-value gap. */
  activeFvg?: { direction: 'BULLISH' | 'BEARISH' } | null;
  /** Price currently inside an order block. */
  activeOrderBlock?: { type: 'BULLISH' | 'BEARISH' } | null;
  /** Short-tier Supertrend flipped on this bar AND the flip was volume-confirmed. */
  supertrendFlipConfirmed?: boolean;
  /** Bollinger breakout, volume-confirmed. */
  bollingerBreakout?: boolean;
  /** EMA20/50 stacked AND sloping. */
  emaTrendAligned?: boolean;
  /** Price crossed back through session VWAP in the bias direction. */
  vwapReclaim?: boolean;
  /** RSI divergence against price. */
  rsiDivergence?: { direction: 'BULLISH' | 'BEARISH' } | null;
}

export interface SetupClassification {
  setupType: SetupType;
  setupFamily: SetupFamily;
  /** The single detector that decided the label. */
  primaryTrigger: string;
  /** Everything that fired, in priority order, so a later analysis can see what else was true. */
  allTriggers: string[];
  detail: Record<string, unknown>;
}

const FAMILY: Record<SetupType, SetupFamily> = {
  VCP_BREAKOUT: 'BREAKOUT',
  BOLLINGER_BREAKOUT: 'BREAKOUT',
  TRIANGLE_BREAKOUT: 'BREAKOUT',
  LIQUIDITY_SWEEP_REVERSAL: 'REVERSAL',
  CHOCH_REVERSAL: 'REVERSAL',
  WEDGE_REVERSAL: 'REVERSAL',
  INVERSE_HS: 'REVERSAL',
  HEAD_AND_SHOULDERS: 'REVERSAL',
  DOUBLE_BOTTOM: 'REVERSAL',
  DOUBLE_TOP: 'REVERSAL',
  RSI_DIVERGENCE_REVERSAL: 'REVERSAL',
  BOS_CONTINUATION: 'CONTINUATION',
  BULL_FLAG: 'CONTINUATION',
  BEAR_FLAG: 'CONTINUATION',
  CHANNEL_CONTINUATION: 'CONTINUATION',
  EMA_TREND_CONTINUATION: 'CONTINUATION',
  SUPERTREND_FLIP: 'CONTINUATION',
  FVG_RETEST: 'MEAN_REVERSION',
  ORDER_BLOCK_RETEST: 'MEAN_REVERSION',
  VWAP_RECLAIM: 'MEAN_REVERSION',
  UNKNOWN: 'UNKNOWN',
};

/** Chart-pattern names, as the pattern detector spells them, to a setup type. */
const PATTERN_MAP: Record<string, SetupType> = {
  BULLISH_FLAG: 'BULL_FLAG',
  BEARISH_FLAG: 'BEAR_FLAG',
  INVERSE_HEAD_AND_SHOULDERS: 'INVERSE_HS',
  HEAD_AND_SHOULDERS: 'HEAD_AND_SHOULDERS',
  DOUBLE_BOTTOM: 'DOUBLE_BOTTOM',
  DOUBLE_TOP: 'DOUBLE_TOP',
  ASCENDING_TRIANGLE: 'TRIANGLE_BREAKOUT',
  DESCENDING_TRIANGLE: 'TRIANGLE_BREAKOUT',
  SYMMETRIC_TRIANGLE: 'TRIANGLE_BREAKOUT',
  RISING_WEDGE: 'WEDGE_REVERSAL',
  FALLING_WEDGE: 'WEDGE_REVERSAL',
  ASCENDING_CHANNEL: 'CHANNEL_CONTINUATION',
  DESCENDING_CHANNEL: 'CHANNEL_CONTINUATION',
  HORIZONTAL_CHANNEL: 'CHANNEL_CONTINUATION',
};

/**
 * Names the setup, or returns UNKNOWN.
 *
 * Priority runs from the most specific detection to the least. A liquidity
 * sweep reversal is a more specific statement than "the EMAs are stacked",
 * so when both are true the sweep is the label and the EMA reading still
 * appears in allTriggers. That ordering is a reporting choice and nothing
 * else — no rule reads it.
 */
export function classifySetup(input: SetupClassificationInput): SetupClassification {
  const triggers: string[] = [];
  const bullish = input.direction === 'BULLISH';
  let setupType: SetupType = 'UNKNOWN';
  let primaryTrigger = 'NONE';

  const take = (type: SetupType, trigger: string) => {
    triggers.push(trigger);
    if (setupType === 'UNKNOWN') {
      setupType = type;
      primaryTrigger = trigger;
    }
  };

  // A sweep that closed back through the level it pierced, in the direction
  // the engine is trading. The most specific thing in this list.
  if (input.liquiditySweep) {
    const sweepAgrees =
      (input.liquiditySweep.type === 'SELL_SIDE' && bullish) ||
      (input.liquiditySweep.type === 'BUY_SIDE' && !bullish);
    if (sweepAgrees) take('LIQUIDITY_SWEEP_REVERSAL', 'LIQUIDITY_SWEEP');
  }

  // A confirmed VCP breakout — confirmed meaning the engine's own
  // completed-bar volume check passed, not merely that a base was present.
  if (input.vcpBreakoutConfirmed) take('VCP_BREAKOUT', 'VCP_BREAKOUT_CONFIRMED');

  if (input.structureEvent) {
    const agrees = input.structureEvent.direction === input.direction;
    if (agrees) {
      if (input.structureEvent.type === 'CHOCH') take('CHOCH_REVERSAL', 'CHOCH');
      else take('BOS_CONTINUATION', 'BOS');
    }
  }

  // Named chart patterns, short tier first: it is the tier the intraday
  // engine decides on.
  for (const [pattern, tier] of [
    [input.shortPattern, 'SHORT'],
    [input.longPattern, 'LONG'],
  ] as const) {
    if (!pattern) continue;
    const mapped = PATTERN_MAP[pattern.toUpperCase().replace(/[\s-]+/g, '_')];
    if (mapped) take(mapped, `PATTERN_${tier}_${pattern.toUpperCase().replace(/[\s-]+/g, '_')}`);
  }

  if (input.activeFvg && input.activeFvg.direction === input.direction) {
    take('FVG_RETEST', 'FVG_ACTIVE');
  }

  if (input.activeOrderBlock) {
    const agrees = (input.activeOrderBlock.type === 'BULLISH') === bullish;
    if (agrees) take('ORDER_BLOCK_RETEST', 'ORDER_BLOCK_ACTIVE');
  }

  if (input.rsiDivergence && input.rsiDivergence.direction === input.direction) {
    take('RSI_DIVERGENCE_REVERSAL', 'RSI_DIVERGENCE');
  }

  if (input.bollingerBreakout) take('BOLLINGER_BREAKOUT', 'BOLLINGER_BREAKOUT_CONFIRMED');
  if (input.supertrendFlipConfirmed) take('SUPERTREND_FLIP', 'SUPERTREND_FLIP_CONFIRMED');
  if (input.vwapReclaim) take('VWAP_RECLAIM', 'VWAP_RECLAIM');
  if (input.emaTrendAligned) take('EMA_TREND_CONTINUATION', 'EMA_TREND_ALIGNED');

  return {
    setupType,
    setupFamily: FAMILY[setupType],
    primaryTrigger,
    allTriggers: triggers,
    detail: {
      direction: input.direction,
      shortPattern: input.shortPattern ?? null,
      longPattern: input.longPattern ?? null,
      vcpDetected: input.vcpDetected ?? false,
      vcpBreakoutConfirmed: input.vcpBreakoutConfirmed ?? false,
      structureEvent: input.structureEvent ?? null,
      liquiditySweep: input.liquiditySweep ?? null,
      triggerCount: triggers.length,
    },
  };
}

/**
 * Session position buckets, for the early-session investigation.
 *
 * Returns the bucket only — the guard that refuses the first hour is
 * elsewhere and unchanged. This exists so the question "does early-session
 * behaviour actually differ" can be answered forward, rather than from the
 * single retrospective cut it was originally built on.
 */
export type SessionBucket = '0-15' | '15-30' | '30-45' | '45-60' | '60-90' | '90-120' | '120+' | 'UNKNOWN';

export function sessionBucket(minutesFromOpen: number | null | undefined): SessionBucket {
  if (minutesFromOpen == null || !Number.isFinite(minutesFromOpen) || minutesFromOpen < 0) return 'UNKNOWN';
  if (minutesFromOpen < 15) return '0-15';
  if (minutesFromOpen < 30) return '15-30';
  if (minutesFromOpen < 45) return '30-45';
  if (minutesFromOpen < 60) return '45-60';
  if (minutesFromOpen < 90) return '60-90';
  if (minutesFromOpen < 120) return '90-120';
  return '120+';
}

/** ATR buckets for the target-distance analysis. Reporting only. */
export type TargetBucket = '0-2' | '2-3' | '3-4' | '4-5' | '5-6' | '6+' | 'UNKNOWN';

export function targetBucket(targetAtr: number | null | undefined): TargetBucket {
  if (targetAtr == null || !Number.isFinite(targetAtr) || targetAtr < 0) return 'UNKNOWN';
  if (targetAtr < 2) return '0-2';
  if (targetAtr < 3) return '2-3';
  if (targetAtr < 4) return '3-4';
  if (targetAtr < 5) return '4-5';
  if (targetAtr < 6) return '5-6';
  return '6+';
}
