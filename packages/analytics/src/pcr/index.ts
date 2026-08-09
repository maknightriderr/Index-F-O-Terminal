// ============================================================
// PCR CALCULATION ENGINE
// ============================================================

import type { OptionChainStrike } from '@fno/shared';

export interface PCRResult {
  oiPCR: number;
  volumePCR: number;
  changeOiPCR: number;
  nearAtmPCR: number;
  interpretation: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

/**
 * Calculate Put-Call Ratio from option chain strikes.
 *
 * PCR > 1.0 → More puts than calls → Generally bullish (more puts being written/hedged)
 * PCR < 0.7 → More calls than puts → Generally bearish
 * 0.7 ≤ PCR ≤ 1.0 → Neutral range
 */
export function calculatePCR(
  strikes: OptionChainStrike[],
  spotPrice?: number,
  nearATMRange: number = 5 // number of strikes around ATM
): PCRResult {
  let totalPutOI = 0;
  let totalCallOI = 0;
  let totalPutVolume = 0;
  let totalCallVolume = 0;
  let totalPutChangeOI = 0;
  let totalCallChangeOI = 0;

  let nearAtmPutOI = 0;
  let nearAtmCallOI = 0;

  // Sort strikes by distance from ATM if spot price is available
  const sortedStrikes = spotPrice
    ? [...strikes].sort((a, b) =>
        Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice)
      )
    : strikes;

  for (let i = 0; i < strikes.length; i++) {
    const s = strikes[i];

    if (s.put) {
      totalPutOI += s.put.oi;
      totalPutVolume += s.put.volume;
      totalPutChangeOI += s.put.changeOi;
    }
    if (s.call) {
      totalCallOI += s.call.oi;
      totalCallVolume += s.call.volume;
      totalCallChangeOI += s.call.changeOi;
    }
  }

  // Near-ATM PCR
  for (let i = 0; i < Math.min(nearATMRange, sortedStrikes.length); i++) {
    const s = sortedStrikes[i];
    if (s.put) nearAtmPutOI += s.put.oi;
    if (s.call) nearAtmCallOI += s.call.oi;
  }

  const oiPCR = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;
  const volumePCR = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 0;
  const changeOiPCR = totalCallChangeOI > 0 ? totalPutChangeOI / totalCallChangeOI : 0;
  const nearAtmPCR = nearAtmCallOI > 0 ? nearAtmPutOI / nearAtmCallOI : 0;

  // Interpretation based on OI PCR
  let interpretation: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  if (oiPCR > 1.0) {
    interpretation = 'BULLISH';
  } else if (oiPCR < 0.7) {
    interpretation = 'BEARISH';
  } else {
    interpretation = 'NEUTRAL';
  }

  return {
    oiPCR: roundTo(oiPCR, 3),
    volumePCR: roundTo(volumePCR, 3),
    changeOiPCR: roundTo(changeOiPCR, 3),
    nearAtmPCR: roundTo(nearAtmPCR, 3),
    interpretation,
  };
}

/**
 * Detect PCR reversal (significant change in PCR direction).
 */
export function detectPCRReversal(
  currentPCR: number,
  previousPCR: number,
  threshold: number = 0.15
): { isReversal: boolean; direction: 'UP' | 'DOWN' | 'NONE'; magnitude: number } {
  const change = currentPCR - previousPCR;

  if (Math.abs(change) >= threshold) {
    return {
      isReversal: true,
      direction: change > 0 ? 'UP' : 'DOWN',
      magnitude: Math.abs(change),
    };
  }

  return { isReversal: false, direction: 'NONE', magnitude: Math.abs(change) };
}

/**
 * Calculate PCR percentile against historical values.
 */
export function calculatePCRPercentile(
  currentPCR: number,
  historicalPCRValues: number[]
): number {
  if (historicalPCRValues.length === 0) return 50; // Default if no history

  const below = historicalPCRValues.filter(v => v < currentPCR).length;
  return roundTo((below / historicalPCRValues.length) * 100, 1);
}

function roundTo(value: number, decimals: number): number {
  const multiplier = Math.pow(10, decimals);
  return Math.round(value * multiplier) / multiplier;
}
