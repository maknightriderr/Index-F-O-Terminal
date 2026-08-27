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

import { IV_RANK_HIGH_THRESHOLD, type OptionChainStrike, type OptionType, type BiasDirection, type TradeSetup } from '@fno/shared';

// 30% premium stop for an intraday hold — standard retail heuristic for
// long options. A positional hold (days/weeks) needs a wider stop since
// the same option's premium ordinarily swings further over that horizon
// on theta/vega alone; a 30% stop tuned for same-session moves would get
// shaken out by routine day-to-day noise long before the thesis actually
// played out. Caller passes the mode-appropriate value; this default
// covers the (more common) unspecified/intraday case.
const DEFAULT_SL_PREMIUM_PCT = 0.3;
// market-bias.ts's direction comes from 6 votes; confidence = % of them
// agreeing with the verdict, in steps of ~16.7 (15/17/33/50/67/83/95 after
// clamping). 50 only requires a bare 3-of-6 — indistinguishable from a
// genuinely contested 3-for/2-against/1-flat split, since confidence counts
// agreement, not margin over dissent. 65 requires a real supermajority
// (>=4 of 6 actively agreeing) before a live entry/SL/target gets generated.
const MIN_CONFIDENCE = 65;
// A real single-leg long-option bet essentially never justifies a
// reward:risk this large — with SL fixed at a 30%-of-entry stop, the risk
// leg is small by construction, so even a moderately-inflated target
// balloons R:R fast. If the delta × expected-move projection implies more
// than this, the upstream Greeks/IV data is bad, not the trade. Caught
// live twice: a diverging Newton-Raphson IV solver producing a "500% IV"
// (~28x target), and — after that fix — the same solver getting stuck in
// a 2-point oscillation and returning 0, which downstream fabricated a
// hard delta of 1.00 on an ordinary ATM option and doubled its target,
// landing at "only" 3.7x entry / 9.01 R:R — comfortably inside the old,
// too-loose 5x-target-multiple cap (equivalent to letting R:R run to
// 13.3), so it went undetected. R:R is the more direct, self-documenting
// thing to bound since it's the number actually shown to the user.
// Exported so callers holding onto a previously-generated TradeSetup (the
// sticky-setup cache in market-bias.ts) can apply the identical plausibility
// bar when deciding whether to keep trusting it, rather than a second,
// possibly-drifting copy of the same threshold.
export const MAX_RISK_REWARD = 6;

export function buildTradeSetup(
  strikes: OptionChainStrike[],
  atmStrike: number,
  direction: BiasDirection,
  confidence: number,
  expectedMovePoints: number,
  ivRank: number | null = null,
  slPremiumPct: number = DEFAULT_SL_PREMIUM_PCT
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
  // A naked long option is a bad trade in a high-IV regime regardless of
  // directional conviction — you're paying rich premium that mean-reverts
  // against you even if the direction call is right. Strategy Scanner
  // already reaches this conclusion independently (recommends selling
  // premium / spreads above this same threshold); without this gate,
  // Trade Setup would contradict it on the same symbol at the same time.
  // Only gates when ivRank is actually known — indices/MCX symbols outside
  // the F&O universe scan pass ivRank=null and keep today's behavior.
  if (ivRank != null && ivRank >= IV_RANK_HIGH_THRESHOLD) {
    return {
      available: false,
      reason: `IV Rank (${ivRank.toFixed(0)}) is elevated (>=${IV_RANK_HIGH_THRESHOLD}) — a naked long option is a poor risk here since rich premium can mean-revert against you even if the direction call is right. Check Strategy Scanner for a premium-selling / spread setup instead.`,
    };
  }

  const atmEntry = strikes.find((s) => s.strike === atmStrike);
  const side: OptionType = direction === 'BULLISH' ? 'CE' : 'PE';
  const leg = side === 'CE' ? atmEntry?.call : atmEntry?.put;

  if (!leg || leg.ltp <= 0) {
    return { available: false, reason: `No live ${side} quote at the ATM strike (${atmStrike}) to build a setup from.` };
  }

  // Defense-in-depth: delta must be in [-1, 1]. If upstream sanitization
  // missed an edge case and a broker-garbage delta leaked through, refuse
  // to project a target from it rather than handing out a 90x R:R number.
  if (!isFinite(leg.delta) || Math.abs(leg.delta) > 1) {
    return { available: false, reason: `ATM ${side} delta (${leg.delta}) is out of range — upstream Greeks data is unreliable this tick.` };
  }

  const deltaMove = Math.abs(leg.delta) * Math.max(expectedMovePoints, 0);
  if (deltaMove <= 0) {
    return { available: false, reason: `No usable delta/expected-move data at the ATM strike (${atmStrike}) to project a target.` };
  }

  const entry = leg.ltp;
  const stopLoss = round2(entry * (1 - slPremiumPct));
  const target = round2(entry + deltaMove);
  const risk = entry - stopLoss;
  const reward = target - entry;
  const riskReward = risk > 0 ? round2(reward / risk) : 0;

  if (riskReward > MAX_RISK_REWARD) {
    return {
      available: false,
      reason: `Computed reward:risk (${riskReward.toFixed(2)}) exceeds the ${MAX_RISK_REWARD} plausibility ceiling — likely bad upstream Greeks/IV data this tick, not a real setup.`,
    };
  }

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
      `SL ${stopLoss.toFixed(2)} — a ${Math.round(slPremiumPct * 100)}% premium stop.`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
