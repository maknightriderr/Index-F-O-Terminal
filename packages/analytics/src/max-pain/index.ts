// ============================================================
// MAX PAIN CALCULATION ENGINE
// ============================================================
// Max Pain = the strike price at which option writers would
// face the least financial loss. It's calculated as the strike
// where the total value of all outstanding puts and calls
// would cause the greatest monetary loss.
// ============================================================

import type { OptionChainStrike, MaxPainData } from '@fno/shared';

/**
 * Calculate Max Pain for a set of option chain strikes.
 *
 * For each strike, we calculate the total payout (pain) that
 * writers would face if the underlying expired at that price.
 * Max Pain is the strike with the minimum total payout.
 */
export function calculateMaxPain(
  strikes: OptionChainStrike[],
  spotPrice: number,
  symbol: string,
  expiry: string
): MaxPainData {
  if (strikes.length === 0) {
    return {
      symbol,
      expiry,
      maxPain: spotPrice,
      distanceFromSpot: 0,
      spotPrice,
      timestamp: Date.now(),
    };
  }

  let minPain = Infinity;
  let maxPainStrike = spotPrice;

  // For each possible expiry price (each strike), calculate total pain
  for (const targetStrike of strikes) {
    let totalPain = 0;

    for (const s of strikes) {
      // Call pain: If expiry price > strike, call buyers profit
      if (s.call && s.call.oi > 0) {
        const callIntrinsic = Math.max(0, targetStrike.strike - s.strike);
        totalPain += callIntrinsic * s.call.oi;
      }

      // Put pain: If expiry price < strike, put buyers profit
      if (s.put && s.put.oi > 0) {
        const putIntrinsic = Math.max(0, s.strike - targetStrike.strike);
        totalPain += putIntrinsic * s.put.oi;
      }
    }

    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = targetStrike.strike;
    }
  }

  return {
    symbol,
    expiry,
    maxPain: maxPainStrike,
    distanceFromSpot: maxPainStrike - spotPrice,
    spotPrice,
    timestamp: Date.now(),
  };
}

/**
 * Calculate pain at each strike (for visualization).
 * Returns an array of { strike, callPain, putPain, totalPain }.
 */
export function calculatePainAtStrikes(
  strikes: OptionChainStrike[]
): Array<{ strike: number; callPain: number; putPain: number; totalPain: number }> {
  const results: Array<{ strike: number; callPain: number; putPain: number; totalPain: number }> = [];

  for (const targetStrike of strikes) {
    let callPain = 0;
    let putPain = 0;

    for (const s of strikes) {
      if (s.call && s.call.oi > 0) {
        callPain += Math.max(0, targetStrike.strike - s.strike) * s.call.oi;
      }
      if (s.put && s.put.oi > 0) {
        putPain += Math.max(0, s.strike - targetStrike.strike) * s.put.oi;
      }
    }

    results.push({
      strike: targetStrike.strike,
      callPain,
      putPain,
      totalPain: callPain + putPain,
    });
  }

  return results;
}
