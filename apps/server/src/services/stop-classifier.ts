// ============================================================
// STOP CLASSIFICATION
// ============================================================
// Was the thesis wrong, or was the instrument behaving badly?
//
// Pure, and in its own module for the same reason the outcome classifier is:
// this is the piece with the judgement in it, and a unit test should be able
// to ask it whether a 0.9-ATR excursion against a 4.5-ATR stop is a decay
// stop without standing up a database pool to find out.
//
// Everything it reads is state captured at the instant the stop fired.
// Nothing is reconstructed, and nothing is guessed: when the inputs are
// missing the answer is UNKNOWN, recorded as such. That matters because six
// of the seventeen historical stops are permanently unclassifiable, and the
// temptation to fill those gaps with a plausible label is exactly what would
// make the resulting statistics worthless.
// ============================================================

import type { Exchange, TradingMode, BiasDirection } from '@fno/shared';

export type StopClassification =
  | 'THESIS_INVALIDATION'
  | 'OPTION_DECAY'
  | 'IV_EFFECT'
  | 'LIQUIDITY_SWEEP'
  | 'EXECUTION'
  | 'NORMAL_VOLATILITY'
  | 'UNKNOWN';

export interface StopEventInput {
  setupId?: string | null;
  symbol: string;
  exchange: Exchange;
  mode?: TradingMode | null;
  direction?: BiasDirection | null;

  underlyingPrice?: number | null;
  underlyingAtEntry?: number | null;
  optionPrice?: number | null;
  entryPrice?: number | null;
  stopPrice?: number | null;
  targetPrice?: number | null;

  atr?: number | null;
  stopInAtr?: number | null;
  targetInAtr?: number | null;

  mfe?: number | null;
  mae?: number | null;
  mfeAtr?: number | null;
  maeAtr?: number | null;
  holdMinutes?: number | null;

  iv?: number | null;
  ivAtEntry?: number | null;
  delta?: number | null;
  theta?: number | null;
  bid?: number | null;
  ask?: number | null;
  oi?: number | null;
  volume?: number | null;

  marketRegime?: string | null;
  setupType?: string | null;
  tradeHealth?: string | null;
  context?: Record<string, unknown>;
}

export interface StopClassificationResult {
  classification: StopClassification;
  basis: string;
}

/**
 * How far the underlying must have moved against the position, in ATR,
 * before a stop counts as a genuine invalidation rather than noise. Below
 * this the stop fired inside the instrument's ordinary range.
 */
const NOISE_ATR = 1;

/**
 * An IV collapse this large, with the underlying nowhere near the
 * invalidation level, is the vol move closing the trade rather than the
 * thesis failing.
 */
const IV_COLLAPSE_PCT = 15;

/** A spread this wide at exit means the recorded fill is not the market's view. */
const EXECUTION_SPREAD_PCT = 20;

/**
 * Classifies a stop from the state captured at the moment it fired.
 *
 * Order matters and is from most to least specific. The underlying
 * comparison comes first because it answers the primary question; the
 * instrument explanations are only reached when the underlying did NOT
 * reach the level, which is exactly the case they are meant to explain.
 */
export function classifyStop(input: StopEventInput): StopClassificationResult {
  const { maeAtr, stopInAtr } = input;

  if (maeAtr == null || stopInAtr == null) {
    return {
      classification: 'UNKNOWN',
      basis:
        'No adverse excursion or stop-distance in ATR was recorded at fire time, so there is nothing to compare the ' +
        'underlying move against. Not inferred from anything else.',
    };
  }

  // The underlying went as far as the stop represented: the thesis broke.
  if (maeAtr >= stopInAtr) {
    if (stopInAtr < NOISE_ATR) {
      return {
        classification: 'NORMAL_VOLATILITY',
        basis: `The underlying reached the stop level, but that level sat only ${stopInAtr.toFixed(2)} ATR away — inside the instrument's ordinary range, so reaching it is not evidence the thesis was wrong.`,
      };
    }
    return {
      classification: 'THESIS_INVALIDATION',
      basis: `The underlying moved ${maeAtr.toFixed(2)} ATR against the position, past the ${stopInAtr.toFixed(2)} ATR the stop represented. The thesis was invalidated before the stop fired.`,
    };
  }

  // From here the underlying did NOT reach the level, so something about the
  // instrument closed the trade.
  const spreadPct =
    input.bid != null && input.ask != null && input.bid > 0 && input.ask > input.bid
      ? ((input.ask - input.bid) / ((input.ask + input.bid) / 2)) * 100
      : null;

  if (spreadPct != null && spreadPct > EXECUTION_SPREAD_PCT) {
    return {
      classification: 'EXECUTION',
      basis: `The underlying only reached ${maeAtr.toFixed(2)} of the ${stopInAtr.toFixed(2)} ATR the stop represented, and the bid-ask was ${spreadPct.toFixed(0)}% of mid at exit — the stop fired on a quote nobody could have traded at.`,
    };
  }

  if (input.iv != null && input.ivAtEntry != null && input.ivAtEntry > 0) {
    const ivChangePct = ((input.iv - input.ivAtEntry) / input.ivAtEntry) * 100;
    if (ivChangePct <= -IV_COLLAPSE_PCT) {
      return {
        classification: 'IV_EFFECT',
        basis: `The underlying only reached ${maeAtr.toFixed(2)} of the ${stopInAtr.toFixed(2)} ATR the stop represented, while implied volatility fell ${Math.abs(ivChangePct).toFixed(0)}% from entry. The vol move closed the trade, not the direction.`,
      };
    }
  }

  return {
    classification: 'OPTION_DECAY',
    basis: `The underlying only reached ${maeAtr.toFixed(2)} of the ${stopInAtr.toFixed(2)} ATR the stop represented, with no IV collapse or spread blowout to explain it. The premium lost its value to time rather than to direction.`,
  };
}

/** The thresholds the classification turns on, exported for the report and the tests. */
export const STOP_THRESHOLDS = { NOISE_ATR, IV_COLLAPSE_PCT, EXECUTION_SPREAD_PCT };
