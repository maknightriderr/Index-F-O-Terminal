// ============================================================
// EXPECTED MOVE CALCULATION
// ============================================================

import type { ExpectedMove } from '@fno/shared';

/**
 * Calculate Expected Move using IV and DTE.
 *
 * Formula: Expected Move = Spot × IV × √(DTE/365)
 *
 * This gives a 1-standard-deviation expected range.
 * ~68% probability that the underlying stays within this range.
 */
export function calculateExpectedMove(
  spotPrice: number,
  iv: number,        // annualized IV as decimal (e.g. 0.15 for 15%)
  dte: number,       // days to expiry
  symbol: string
): ExpectedMove {
  const timeComponent = Math.sqrt(dte / 365);
  const expectedMove = spotPrice * iv * timeComponent;

  return {
    symbol,
    spotPrice,
    iv: iv * 100, // Convert to percentage for display
    dte,
    expectedMove: roundTo(expectedMove, 2),
    upperBound: roundTo(spotPrice + expectedMove, 2),
    lowerBound: roundTo(spotPrice - expectedMove, 2),
    timestamp: Date.now(),
  };
}

/**
 * Calculate Expected Move for multiple timeframes.
 */
export function calculateMultiTimeframeExpectedMove(
  spotPrice: number,
  iv: number,
  symbol: string
): Record<string, ExpectedMove> {
  const timeframes = {
    '1D': 1,
    '1W': 5,   // 5 trading days
    '2W': 10,
    '1M': 21,  // ~21 trading days
  };

  const result: Record<string, ExpectedMove> = {};

  for (const [label, days] of Object.entries(timeframes)) {
    result[label] = calculateExpectedMove(spotPrice, iv, days, symbol);
  }

  return result;
}

function roundTo(value: number, decimals: number): number {
  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier) / multiplier;
}
