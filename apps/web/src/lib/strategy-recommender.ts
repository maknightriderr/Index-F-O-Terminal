// ============================================================
// STRATEGY RECOMMENDER
// ============================================================
// A lightweight, transparent heuristic — same philosophy as the
// universe-wide bias/score composite in fno-scanner.ts: derived
// purely from fields the scanner already computes (direction,
// score, IV Rank, ATM theta, PCR), no historical candles or ADX
// (that's what the full per-asset Market Regime card on the asset
// workspace tab is for). Not a recommendation to trade; a starting
// point for which strategy shape fits the current bias + IV regime.
// ============================================================

import type { FnoScannerRow } from '@fno/shared';

export type StrategyCategory = 'DIRECTIONAL' | 'NEUTRAL';
export type RiskProfile = 'DEFINED_RISK' | 'UNDEFINED_RISK';

export interface StrategyRecommendation {
  strategy: string;
  category: StrategyCategory;
  riskProfile: RiskProfile;
  rationale: string;
}

const IV_HIGH_THRESHOLD = 60;
const IV_LOW_THRESHOLD = 40;

export function recommendStrategy(row: FnoScannerRow): StrategyRecommendation | null {
  const { direction, score, ivRank, atmTheta, pcr } = row;
  const highIv = ivRank != null && ivRank >= IV_HIGH_THRESHOLD;
  const lowIv = ivRank != null && ivRank <= IV_LOW_THRESHOLD;
  const ivKnown = ivRank != null;
  // atmTheta is a single representative ATM leg (averaged with gamma/vega
  // upstream in fno-scanner.ts) — a straddle holds one of each side, so its
  // combined decay is double a single leg's.
  const thetaNote = atmTheta !== 0 ? ` ATM straddle is bleeding ₹${Math.abs(atmTheta * 2).toFixed(2)}/day.` : '';

  if (direction === 'BULLISH') {
    if (highIv) {
      return {
        strategy: 'Bull Put Spread',
        category: 'DIRECTIONAL',
        riskProfile: 'DEFINED_RISK',
        rationale: `Bullish bias (score ${score}), IV Rank ${ivRank} is rich — sell put premium below spot rather than pay up for calls.${thetaNote}`,
      };
    }
    return {
      strategy: 'Bull Call Spread',
      category: 'DIRECTIONAL',
      riskProfile: 'DEFINED_RISK',
      rationale: `Bullish bias (score ${score})${ivKnown ? `, IV Rank ${ivRank} is cheap` : ', IV Rank not yet available'} — buy calls while premium isn't expensive, cap cost with a spread.${thetaNote}`,
    };
  }

  if (direction === 'BEARISH') {
    if (highIv) {
      return {
        strategy: 'Bear Call Spread',
        category: 'DIRECTIONAL',
        riskProfile: 'DEFINED_RISK',
        rationale: `Bearish bias (score ${score}), IV Rank ${ivRank} is rich — sell call premium above spot rather than pay up for puts.${thetaNote}`,
      };
    }
    return {
      strategy: 'Bear Put Spread',
      category: 'DIRECTIONAL',
      riskProfile: 'DEFINED_RISK',
      rationale: `Bearish bias (score ${score})${ivKnown ? `, IV Rank ${ivRank} is cheap` : ', IV Rank not yet available'} — buy puts while premium isn't expensive, cap cost with a spread.${thetaNote}`,
    };
  }

  // NEUTRAL
  if (highIv) {
    return {
      strategy: 'Iron Condor',
      category: 'NEUTRAL',
      riskProfile: 'DEFINED_RISK',
      rationale: `No directional edge (score ${score}) but IV Rank ${ivRank} is rich — sell premium on both sides, defined risk via the wings.${thetaNote} PCR ${pcr > 0 ? pcr.toFixed(2) : 'n/a'}.`,
    };
  }

  if (lowIv) {
    return null; // neutral bias + cheap premium: no attractive edge either buying or selling
  }

  return null;
}
