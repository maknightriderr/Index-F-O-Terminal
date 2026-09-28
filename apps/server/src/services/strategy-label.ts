// ============================================================
// STRATEGY LABEL — a labelling pass, not a detector (Phase 1)
// ============================================================
// Maps readings the bias engine has ALREADY computed and voted on into the
// strategy taxonomy the loss-attribution work groups by:
//
//   LIQUIDITY_SWEEP | EQ_REJECTION | BOS | CHOCH | TREND_CONTINUATION |
//   VWAP_RECLAIM | BREAKOUT | MEAN_REVERSION | OPTION_FLOW | OTHER
//
// Every input is something market-bias.ts already had in hand before this is
// called: the setup classifier's triggers (which already encode the
// market-structure event, liquidity sweep, chart patterns, FVG/order-block,
// RSI divergence, Bollinger/VCP breakout, Supertrend flip and EMA trend,
// each only when it agrees with the direction), the premium/discount zone,
// the last candlestick pattern, and the three positioning votes. Nothing
// here detects anything new, and no rule reads the result — it is written
// to the decision record for grouping.
//
// Kept in its own pure module (rather than inline in market-bias.ts) so it
// can be unit-tested without the engine's Redis/DB/broker imports.
//
// Where no specific reading qualifies the label is OTHER, never a guess —
// the same rule the setup classifier follows, for the same reason: a wrong
// label pollutes a strategy's expectancy far more quietly than a missing one.
// ============================================================

export type StrategyLabel =
  | 'LIQUIDITY_SWEEP'
  | 'EQ_REJECTION'
  | 'BOS'
  | 'CHOCH'
  | 'TREND_CONTINUATION'
  | 'VWAP_RECLAIM'
  | 'BREAKOUT'
  | 'MEAN_REVERSION'
  | 'OPTION_FLOW'
  | 'OTHER';

/** Priority order — most specific first. `primary` is the first that qualified. */
export const STRATEGY_LABEL_PRIORITY: readonly StrategyLabel[] = [
  'LIQUIDITY_SWEEP',
  'CHOCH',
  'BOS',
  'EQ_REJECTION',
  'VWAP_RECLAIM',
  'BREAKOUT',
  'TREND_CONTINUATION',
  'MEAN_REVERSION',
  'OPTION_FLOW',
] as const;

export interface StrategyLabelInput {
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** classifySetup()'s allTriggers — each already direction-checked by the classifier. */
  setupTriggers: readonly string[];
  /** classifyPremiumDiscount().zone. */
  premiumDiscountZone?: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' | null;
  /** detectCandlestickPattern()'s last pattern. */
  candlePattern?: { pattern: string; direction: 'BULLISH' | 'BEARISH' } | null;
  /** The three positioning votes (-1/0/+1). */
  positioning?: { futuresOi: number; pcr: number; optionOiFlow: number } | null;
}

export interface StrategyLabelResult {
  labels: StrategyLabel[];
  primary: StrategyLabel;
}

// Chart-pattern triggers are spelled PATTERN_<TIER>_<NAME> by the classifier.
const BREAKOUT_PATTERNS = ['TRIANGLE'];
const CONTINUATION_PATTERNS = ['FLAG', 'CHANNEL'];
const REVERSION_PATTERNS = ['DOUBLE_TOP', 'DOUBLE_BOTTOM', 'HEAD_AND_SHOULDERS', 'WEDGE'];

function patternName(trigger: string): string | null {
  const m = /^PATTERN_(SHORT|LONG)_(.+)$/.exec(trigger);
  return m ? m[2] : null;
}

export function classifyStrategyLabels(input: StrategyLabelInput): StrategyLabelResult {
  const found = new Set<StrategyLabel>();
  const triggers = new Set(input.setupTriggers);
  const directionSign = input.direction === 'BULLISH' ? 1 : input.direction === 'BEARISH' ? -1 : 0;

  if (triggers.has('LIQUIDITY_SWEEP')) found.add('LIQUIDITY_SWEEP');
  if (triggers.has('CHOCH')) found.add('CHOCH');
  if (triggers.has('BOS')) found.add('BOS');

  // Rejection at equilibrium: price sits in the middle of its recent range
  // and the last candle is a reversal shape pointing the trade's way. Both
  // readings are computed upstream already; this only names the combination.
  if (
    directionSign !== 0 &&
    input.premiumDiscountZone === 'EQUILIBRIUM' &&
    input.candlePattern != null &&
    input.candlePattern.direction === input.direction
  ) {
    found.add('EQ_REJECTION');
  }

  if (triggers.has('VWAP_RECLAIM')) found.add('VWAP_RECLAIM');

  if (triggers.has('VCP_BREAKOUT_CONFIRMED') || triggers.has('BOLLINGER_BREAKOUT_CONFIRMED')) found.add('BREAKOUT');
  if (triggers.has('EMA_TREND_ALIGNED') || triggers.has('SUPERTREND_FLIP_CONFIRMED')) found.add('TREND_CONTINUATION');
  if (triggers.has('FVG_ACTIVE') || triggers.has('ORDER_BLOCK_ACTIVE') || triggers.has('RSI_DIVERGENCE')) found.add('MEAN_REVERSION');

  for (const trigger of triggers) {
    const name = patternName(trigger);
    if (!name) continue;
    if (BREAKOUT_PATTERNS.some((p) => name.includes(p))) found.add('BREAKOUT');
    else if (CONTINUATION_PATTERNS.some((p) => name.includes(p))) found.add('TREND_CONTINUATION');
    else if (REVERSION_PATTERNS.some((p) => name.includes(p))) found.add('MEAN_REVERSION');
  }

  // Positioning unanimously behind the direction: futures OI, PCR and option
  // OI flow all voting the trade's way.
  const p = input.positioning;
  if (directionSign !== 0 && p && p.futuresOi === directionSign && p.pcr === directionSign && p.optionOiFlow === directionSign) {
    found.add('OPTION_FLOW');
  }

  const labels = STRATEGY_LABEL_PRIORITY.filter((l) => found.has(l));
  return labels.length > 0 ? { labels, primary: labels[0] } : { labels: ['OTHER'], primary: 'OTHER' };
}
