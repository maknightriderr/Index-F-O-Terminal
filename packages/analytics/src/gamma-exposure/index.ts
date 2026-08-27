// ============================================================
// GAMMA EXPOSURE (GEX)
// ============================================================
// Estimates dealer gamma positioning per strike from live OI and
// gamma — not literal dealer books (no one outside the market
// makers has that), but the standard retail proxy: assume dealers
// are net long the calls they've sold (positive gamma contribution)
// and net short the puts they've sold (negative gamma contribution),
// the same convention used by SqueezeMetrics-style GEX charts.
//
// Net positive GEX: dealers are net long gamma, so they hedge by
// selling into rallies and buying dips — dampens moves, market
// tends to mean-revert. Net negative GEX: dealers are net short
// gamma, so they hedge by buying into rallies and selling dips —
// amplifies moves, market tends to trend. This is a heuristic
// reading of positioning, not a certainty — real dealer books can
// differ from the "sold calls, sold puts" assumption.
// ============================================================

import type { OptionChainStrike, GammaExposureRegime, StrikeGex, GammaExposureResult } from '@fno/shared';

const CONTRACT_MULTIPLIER = 100; // standard NSE F&O lot-independent multiplier used in the GEX convention itself (not the symbol's actual lot size)
const SCALE = 1e7; // crores of rupees

export function calculateGammaExposure(strikes: OptionChainStrike[], spotPrice: number): GammaExposureResult {
  const spotSq = spotPrice * spotPrice;

  const perStrike: StrikeGex[] = strikes.map((s) => {
    const callContribution = s.call && s.call.oi > 0 && isFinite(s.call.gamma) ? s.call.gamma * s.call.oi : 0;
    const putContribution = s.put && s.put.oi > 0 && isFinite(s.put.gamma) ? s.put.gamma * s.put.oi : 0;
    const gex = ((callContribution - putContribution) * spotSq * CONTRACT_MULTIPLIER) / SCALE;
    return { strike: s.strike, gex: round2(gex) };
  });

  const netGex = round2(perStrike.reduce((sum, p) => sum + p.gex, 0));

  let gammaWallStrike: number | null = null;
  let maxAbs = 0;
  for (const p of perStrike) {
    if (Math.abs(p.gex) > maxAbs) {
      maxAbs = Math.abs(p.gex);
      gammaWallStrike = p.strike;
    }
  }

  const regime: GammaExposureRegime = netGex > 0 ? 'LONG_GAMMA' : netGex < 0 ? 'SHORT_GAMMA' : 'NEUTRAL';

  return { netGex, regime, gammaWallStrike, perStrike };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
