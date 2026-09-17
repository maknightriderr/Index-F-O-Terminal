// ============================================================
// STRATEGY RECOMMENDER
// ============================================================
// A lightweight, transparent heuristic derived purely from fields the F&O
// scanner already computes (direction, confidence, score, IV Rank, ATM
// theta) — no historical candles, ADX or reward:risk. Not a trade signal;
// the full per-asset Trade Setup is the validated path.
//
// Buying structures only. The trade-setup engine is built for an option
// buyer (naked longs), and this scanner used to recommend credit spreads
// and iron condors — premium selling the user doesn't trade. Rich IV now
// steers toward a debit spread (the short leg offsets the expensive
// premium) instead of toward selling; mixed or neutral reads get nothing.
// ============================================================

import { IV_RANK_HIGH_THRESHOLD, type FnoScannerRow } from '@fno/shared';

export type StrategyCategory = 'DIRECTIONAL';
export type RiskProfile = 'DEFINED_RISK';

export interface StrategyRecommendation {
  strategy: string;
  category: StrategyCategory;
  riskProfile: RiskProfile;
  rationale: string;
}

/** Below this the scanner's three reads (price, futures OI, PCR) disagree too much to lean either way. */
export const STRATEGY_MIN_CONFIDENCE = 60;

export function recommendStrategy(row: FnoScannerRow): StrategyRecommendation | null {
  const { direction, confidence, score, ivRank, atmTheta } = row;
  if (direction === 'NEUTRAL' || confidence < STRATEGY_MIN_CONFIDENCE) return null;

  const highIv = ivRank != null && ivRank >= IV_RANK_HIGH_THRESHOLD;
  const ivText = ivRank == null ? 'IV Rank not yet available' : highIv ? `IV Rank ${ivRank} is rich` : `IV Rank ${ivRank} is not stretched`;
  const thetaNote = atmTheta !== 0 ? ` An ATM leg decays about ₹${Math.abs(atmTheta).toFixed(2)}/day.` : '';
  const bullish = direction === 'BULLISH';
  const side = bullish ? 'call' : 'put';
  const lean = `${bullish ? 'Bullish' : 'Bearish'} lean (confidence ${confidence}, score ${score})`;

  if (highIv) {
    return {
      strategy: bullish ? 'Bull Call Spread (debit)' : 'Bear Put Spread (debit)',
      category: 'DIRECTIONAL',
      riskProfile: 'DEFINED_RISK',
      rationale: `${lean}, ${ivText} — buy the ATM ${side} and sell a further OTM ${side} so the short leg pays for part of the expensive premium.${thetaNote}`,
    };
  }
  return {
    strategy: bullish ? 'Long Call (ATM)' : 'Long Put (ATM)',
    category: 'DIRECTIONAL',
    riskProfile: 'DEFINED_RISK',
    rationale: `${lean}, ${ivText} — premium isn't expensive, so a plain ATM ${side} keeps the full move.${thetaNote}`,
  };
}
