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
  // Unlike OI itself (always >= 0), changeOi is SIGNED — negative means
  // unwinding. A ratio is only a meaningful "how much more put OI built
  // vs call OI built" reading when both sides are actually building; if
  // either is flat or unwinding, a straight division can produce a
  // negative or wildly inflated number with no PCR-like interpretation
  // (e.g. calls barely +10 while puts are -5000 gives PCR -500). 0 is
  // the same "no signal" sentinel oiPCR/volumePCR already use when their
  // own denominator is non-positive.
  const changeOiPCR = totalCallChangeOI > 0 && totalPutChangeOI > 0 ? totalPutChangeOI / totalCallChangeOI : 0;
  const nearAtmPCR = nearAtmCallOI > 0 ? nearAtmPutOI / nearAtmCallOI : 0;

  // Interpretation based on OI PCR. Moderate readings follow the
  // standard convention (elevated puts = bullish hedging/writing,
  // elevated calls = bearish) — but a genuinely EXTREME PCR in either
  // direction is more often read as contrarian: one-sided positioning
  // that crowded tends to precede a reversal rather than confirm
  // continuation, so the label flips back the other way at the extremes
  // rather than calling PCR 2.5 "BULLISH" the same as PCR 1.1.
  const PCR_EXTREME_HIGH = 1.5;
  const PCR_EXTREME_LOW = 0.4;
  let interpretation: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  if (oiPCR >= PCR_EXTREME_HIGH) {
    interpretation = 'BEARISH';
  } else if (oiPCR <= PCR_EXTREME_LOW) {
    interpretation = 'BULLISH';
  } else if (oiPCR > 1.0) {
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

// A PCR move of 0.15 is a ~30% relative shift at a base of 0.5 but only
// ~5% at a base of 3.0 — an absolute threshold made reversals trivially
// easy to trigger at low PCR and nearly impossible at high PCR. Floored
// so a near-zero base doesn't turn a trivial absolute move into a huge
// relative one.
const MIN_PCR_REVERSAL_BASE = 0.3;

/**
 * Detect PCR reversal — a significant RELATIVE change in PCR level, not
 * a fixed absolute move (see MIN_PCR_REVERSAL_BASE above for why).
 */
export function detectPCRReversal(
  currentPCR: number,
  previousPCR: number,
  relativeThreshold: number = 0.15
): { isReversal: boolean; direction: 'UP' | 'DOWN' | 'NONE'; magnitude: number } {
  const change = currentPCR - previousPCR;
  const base = Math.max(Math.abs(previousPCR), MIN_PCR_REVERSAL_BASE);
  const relativeChange = Math.abs(change) / base;

  if (relativeChange >= relativeThreshold) {
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
