// ============================================================
// DIRECTIONAL TRADE SETUP
// ============================================================
// Builds the actual, actionable structure for the current bias — always
// a single-leg long option (naked CE/PE), never a spread. This is a
// deliberate trading-style choice, not a placeholder: the user is an
// option BUYER, not a spread trader, so Trade Setup only ever proposes
// what they'd actually take. An earlier version of this file routed
// ivRank-known symbols through a defined-risk spread instead (backtested
// better on average), but that overrode the user's own stated style
// without asking — reverted. `evaluateSpreadProgress` below is kept
// only so any spread setups already recorded from that period keep
// resolving correctly; nothing here builds a new one. Gated on bias
// confidence so it stays silent rather than emitting a call on a
// weak/mixed read.
//
// This is a transparent heuristic over real numbers, not investment
// advice or a prediction — `reason` always explains exactly how the
// numbers were derived so it can be checked, not just trusted.
// ============================================================

import type { OptionChainStrike, OptionType, BiasDirection, TradeSetup } from '@fno/shared';

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
// Only applies to the naked-long path — a spread's max profit/loss are
// geometrically bounded by real strike widths and real current premiums,
// not a delta×expected-move projection that can run away the same way.
// Exported so callers holding onto a previously-generated TradeSetup (the
// sticky-setup cache in market-bias.ts) can apply the identical plausibility
// bar when deciding whether to keep trusting it, rather than a second,
// possibly-drifting copy of the same threshold.
export const MAX_RISK_REWARD = 6;

// VIX-adjusted SL: a stop sized for VIX~15 (a typical calm reading) gets
// widened as VIX rises above that, since higher-VIX regimes mean the same
// option's premium swings further on ordinary noise alone — a stop tuned
// for a calm market gets stopped out prematurely in a volatile one purely
// from noise, not because the thesis was wrong. Never tightens below the
// base for VIX under 15. Capped so an extreme VIX spike can't blow the SL
// out past a sane ceiling.
const VIX_BASELINE = 15;
const VIX_SL_SENSITIVITY = 15; // every this-many points of VIX above baseline adds another 100% to the SL widening factor
// Was 0.7 (70%) — found in a backtest review that a widened-but-never-hit
// stop let INTRADAY naked longs on high-VIX/expiry-day symbols bleed 40-55%
// of premium before the day rolled over and force-closed them as EXPIRED,
// never having technically touched a "stop" that was itself widened almost
// to that same level. Tightened so the worst case is a real stop-out with
// capital actually protected, not a slow bleed to a number barely different
// from having no stop at all.
const MAX_SL_PREMIUM_PCT = 0.45;

// A 0-DTE (or 1-DTE) option's premium swings ±50-100% routinely on gamma
// alone as dealers hedge into the close — a stop sized for a normal T-3/T-5
// day gets stopped out by ordinary expiry-day noise, not because the thesis
// was wrong. Stacks with (and is still bounded by) the VIX widening above.
const EXPIRY_DAY_MAX_DTE = 1;
const EXPIRY_DAY_SL_WIDEN_FACTOR = 1.5;

// Bid-ask spread as a % of mid premium. Above this on the ATM leg, the quote
// is too thin to trust an entry/SL/target off of — refuse the setup rather
// than size a "trade" around a price nobody could actually get filled at.
const MAX_ATM_SPREAD_PCT = 5;

// Nothing about entry/SL/target/riskReward above accounts for what it
// actually costs to trade this — brokerage, STT, and the bid-ask spread
// beyond the mid-price this setup is sized from all eat into the real
// P&L. Deliberately NOT threaded into a structured field or subtracted
// from riskReward itself: brokerage is a flat rupee amount per order, so
// its % impact depends on lot size, which this module doesn't have (and
// pulling it in would drag this into position-sizing territory — out of
// scope, see market-bias.ts's own file header). This is a rough,
// broker-independent rule of thumb surfaced as a note, not a number the
// UI should present as precise — real costs vary by broker/plan.
const ESTIMATED_ROUND_TRIP_COST_PCT = 3; // brokerage-equivalent + STT + residual spread, as a % of entry premium

// A defined-risk spread's max profit/loss are only realized if held to (or
// very near) expiry — exiting early at a fraction of each is the standard
// retail practice. Nothing here builds a new spread setup any more (see
// file header), but any spread already sitting in a user's sticky-setup
// cache from before that change still needs these to resolve correctly.
const SPREAD_TARGET_PCT_OF_MAX_PROFIT = 0.6;
const SPREAD_STOP_PCT_OF_MAX_LOSS = 0.6;

export function buildTradeSetup(
  strikes: OptionChainStrike[],
  atmStrike: number,
  direction: BiasDirection,
  confidence: number,
  expectedMovePoints: number,
  slPremiumPct: number = DEFAULT_SL_PREMIUM_PCT,
  vix: number | null = null,
  dte: number | null = null
): TradeSetup {
  if (confidence < MIN_CONFIDENCE) {
    return {
      available: false,
      reason: `Bias confidence (${confidence}/100) is below the ${MIN_CONFIDENCE} threshold needed for a setup — signals are too mixed.`,
    };
  }

  if (direction === 'NEUTRAL') {
    return { available: false, reason: 'Market bias is neutral — no high-conviction directional setup right now.' };
  }

  const side: OptionType = direction === 'BULLISH' ? 'CE' : 'PE';
  return buildNakedLong(strikes, atmStrike, direction, side, confidence, expectedMovePoints, slPremiumPct, vix, dte);
}

// ============================================================
// NAKED LONG (the only structure Trade Setup builds — see file header)
// ============================================================

function buildNakedLong(
  strikes: OptionChainStrike[],
  atmStrike: number,
  direction: BiasDirection,
  side: OptionType,
  confidence: number,
  expectedMovePoints: number,
  slPremiumPct: number,
  vix: number | null,
  dte: number | null = null
): TradeSetup {
  const atmEntry = strikes.find((s) => s.strike === atmStrike);
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

  // Liquidity gate: refuse to size a setup off a quote nobody could actually
  // trade at. Only gates when the broker is actually publishing a two-sided
  // market (bid and ask both > 0) — if depth data is simply absent, fall
  // through to the LTP-only behavior below rather than blocking every setup
  // on symbols the depth feed doesn't cover.
  const hasQuote = leg.bid > 0 && leg.ask > 0;
  const mid = hasQuote ? (leg.bid + leg.ask) / 2 : leg.ltp;
  const atmSpreadPct = hasQuote ? ((leg.ask - leg.bid) / mid) * 100 : null;
  if (atmSpreadPct != null && atmSpreadPct > MAX_ATM_SPREAD_PCT) {
    return {
      available: false,
      reason: `ATM ${side} ${atmStrike} bid-ask spread (${atmSpreadPct.toFixed(1)}% of mid) is too wide to trade — likely illiquid this tick.`,
    };
  }

  // Widen the stop for an elevated-VIX regime — the same option swings
  // further on ordinary noise alone when VIX is high, so a calm-market
  // stop gets hit prematurely. Never tightens below the base for VIX<=15,
  // and capped so an extreme spike can't blow the SL past a sane ceiling.
  let effectiveSlPct = slPremiumPct;
  let vixNote = '';
  if (vix != null && vix > VIX_BASELINE) {
    const widenFactor = 1 + (vix - VIX_BASELINE) / VIX_SL_SENSITIVITY;
    effectiveSlPct = Math.min(slPremiumPct * widenFactor, MAX_SL_PREMIUM_PCT);
    vixNote = ` (widened from ${Math.round(slPremiumPct * 100)}% for VIX ${vix.toFixed(1)})`;
  }

  // Further widen on expiry day (or the day before) — 0/1-DTE gamma makes
  // the base+VIX stop too tight regardless of VIX level, since the swings
  // are structural (dealer hedging into the close), not just volatility.
  let expiryNote = '';
  if (dte != null && dte <= EXPIRY_DAY_MAX_DTE) {
    const widened = Math.min(effectiveSlPct * EXPIRY_DAY_SL_WIDEN_FACTOR, MAX_SL_PREMIUM_PCT);
    if (widened > effectiveSlPct) {
      expiryNote = ` (further widened for ${dte}-DTE expiry-day gamma)`;
      effectiveSlPct = widened;
    }
  }

  // Mid-price entry — more realistic than LTP, which can be stale on a thin
  // book and far from where an order would actually fill.
  const entry = round2(mid);
  const stopLoss = round2(entry * (1 - effectiveSlPct));
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

  const estimatedCost = round2(entry * (ESTIMATED_ROUND_TRIP_COST_PCT / 100));

  return {
    available: true,
    structureType: 'NAKED_LONG',
    side,
    strike: atmStrike,
    entry,
    stopLoss,
    target,
    riskReward,
    reason:
      `${direction} bias at ${confidence}/100 confidence — ATM ${side} ${atmStrike} @ ${entry.toFixed(2)}${hasQuote ? ' (bid-ask mid)' : ''}. ` +
      `Target ${target.toFixed(2)} from delta (${leg.delta.toFixed(2)}) × IV-implied expected move (${expectedMovePoints.toFixed(0)} pts). ` +
      `SL ${stopLoss.toFixed(2)} — a ${Math.round(effectiveSlPct * 100)}% premium stop${vixNote}${expiryNote}.` +
      (dte != null ? ` DTE ${dte}.` : '') +
      ` None of the numbers above subtract real trading costs — brokerage, STT, and slippage beyond this mid-price entry typically run ~${ESTIMATED_ROUND_TRIP_COST_PCT}% of premium round-trip (~${estimatedCost.toFixed(2)} here), a rough estimate that varies by broker, not a precise deduction.`,
  };
}

// ============================================================
// Sticky-setup outcome evaluation (used by market-bias.ts every poll)
// ============================================================

/**
 * Current mark-to-market value of a stored setup's position, and whether
 * target/stop have been reached — unified across naked longs and spreads.
 * For a naked long, `currentValue` is just the option's current LTP. For a
 * spread, it's the net cost to close right now: Σ(bought legs' current
 * price) - Σ(sold legs' current price) — the same formula shape as
 * `netPremium` itself, just with live prices instead of entry prices, so
 * `currentValue - netPremium` is P&L in both the debit and credit case.
 */
export interface SetupProgress {
  currentValue: number | null;
  hitTarget: boolean;
  hitStop: boolean;
}

export function evaluateNakedLongProgress(currentLtp: number | null, stopLoss: number, target: number): SetupProgress {
  return {
    currentValue: currentLtp,
    hitTarget: currentLtp != null && currentLtp >= target,
    hitStop: currentLtp != null && currentLtp <= stopLoss,
  };
}

export function evaluateSpreadProgress(
  legCurrentPrices: Array<{ action: 'BUY' | 'SELL'; price: number | null }>,
  netPremium: number,
  maxProfit: number,
  maxLoss: number
): SetupProgress {
  if (legCurrentPrices.some((l) => l.price == null)) {
    return { currentValue: null, hitTarget: false, hitStop: false };
  }
  const currentValue = round2(
    legCurrentPrices.reduce((sum, l) => sum + (l.action === 'BUY' ? l.price! : -l.price!), 0)
  );
  const pnl = round2(currentValue - netPremium);
  return {
    currentValue,
    hitTarget: pnl >= SPREAD_TARGET_PCT_OF_MAX_PROFIT * maxProfit,
    hitStop: pnl <= -SPREAD_STOP_PCT_OF_MAX_LOSS * maxLoss,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
