// ============================================================
// DIRECTIONAL TRADE SETUP
// ============================================================
// A single-leg long-option setup derived entirely from live data:
// side from the market bias direction, strike at-the-money, target
// from the option's own delta applied to the IV-implied expected
// move (not an arbitrary risk:reward ratio), stop-loss as a
// standard premium-percentage stop. Gated on bias confidence so it
// stays silent rather than emitting a call on a weak/mixed read.
//
// This is a transparent heuristic over real numbers, not investment
// advice or a prediction — `reason` always explains exactly how the
// numbers were derived so it can be checked, not just trusted.
// ============================================================

import type { OptionChainStrike, OptionType, BiasDirection, TradeSetup } from '@fno/shared';

const SL_PREMIUM_PCT = 0.3; // 30% premium stop — standard retail heuristic for long options
// market-bias.ts's direction comes from 6 votes; confidence = % of them
// agreeing with the verdict, in steps of ~16.7 (15/17/33/50/67/83/95 after
// clamping). 50 only requires a bare 3-of-6 — indistinguishable from a
// genuinely contested 3-for/2-against/1-flat split, since confidence counts
// agreement, not margin over dissent. 65 requires a real supermajority
// (>=4 of 6 actively agreeing) before a live entry/SL/target gets generated.
const MIN_CONFIDENCE = 65;

export function buildTradeSetup(
  strikes: OptionChainStrike[],
  atmStrike: number,
  direction: BiasDirection,
  confidence: number,
  expectedMovePoints: number
): TradeSetup {
  if (direction === 'NEUTRAL') {
    return { available: false, reason: 'Market bias is neutral — no high-conviction directional setup right now.' };
  }
  if (confidence < MIN_CONFIDENCE) {
    return {
      available: false,
      reason: `Bias confidence (${confidence}/100) is below the ${MIN_CONFIDENCE} threshold needed for a setup — signals are too mixed.`,
    };
  }

  const atmEntry = strikes.find((s) => s.strike === atmStrike);
  const side: OptionType = direction === 'BULLISH' ? 'CE' : 'PE';
  const leg = side === 'CE' ? atmEntry?.call : atmEntry?.put;

  if (!leg || leg.ltp <= 0) {
    return { available: false, reason: `No live ${side} quote at the ATM strike (${atmStrike}) to build a setup from.` };
  }

  const deltaMove = Math.abs(leg.delta) * Math.max(expectedMovePoints, 0);
  if (deltaMove <= 0) {
    return { available: false, reason: `No usable delta/expected-move data at the ATM strike (${atmStrike}) to project a target.` };
  }

  const entry = leg.ltp;
  const stopLoss = round2(entry * (1 - SL_PREMIUM_PCT));
  const target = round2(entry + deltaMove);
  const risk = entry - stopLoss;
  const reward = target - entry;
  const riskReward = risk > 0 ? round2(reward / risk) : 0;

  return {
    available: true,
    side,
    strike: atmStrike,
    entry,
    stopLoss,
    target,
    riskReward,
    reason:
      `${direction} bias at ${confidence}/100 confidence — ATM ${side} ${atmStrike} @ ${entry.toFixed(2)}. ` +
      `Target ${target.toFixed(2)} from delta (${leg.delta.toFixed(2)}) × IV-implied expected move (${expectedMovePoints.toFixed(0)} pts). ` +
      `SL ${stopLoss.toFixed(2)} — a ${Math.round(SL_PREMIUM_PCT * 100)}% premium stop.`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
