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

import type { OptionChainStrike, OptionType, BiasDirection, TradeSetup, PositionSize } from '@fno/shared';
import { DEFAULT_RISK_CONFIG } from '@fno/shared';

// 30% premium stop for an intraday hold — standard retail heuristic for
// long options. A positional hold (days/weeks) needs a wider stop since
// the same option's premium ordinarily swings further over that horizon
// on theta/vega alone; a 30% stop tuned for same-session moves would get
// shaken out by routine day-to-day noise long before the thesis actually
// played out. Caller passes the mode-appropriate value; this default
// covers the (more common) unspecified/intraday case.
const DEFAULT_SL_PREMIUM_PCT = 0.3;
// market-bias.ts's confidence is the share of DECISIVE votes (flats
// excluded) agreeing with the verdict, pro-rated down when fewer than 6
// indicators have an opinion at all. 65 therefore means roughly a 2:1
// supermajority among indicators that actually took a side, on a decent
// body of evidence, before a live entry/SL/target gets generated.
//
// This comment previously described a 6-vote engine with ~16.7% steps and
// warned that confidence counted "agreement, not margin over dissent" —
// both stale. The engine now runs 10 baseline votes plus event votes, and
// the metric itself was reworked to exclude flats precisely because
// counting them made a unanimous-but-quiet read score LOWER than a
// contested one. 65 is a meaningfully different (and more honest) bar than
// it was when this number was first chosen.
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

// ============================================================
// MINIMUM REWARD:RISK — the floor this module was missing
// ============================================================
// There was a ceiling (above) but never a floor, so setups risking ₹20
// to make ₹12 (R:R 0.6) were emitted as tradeable. Every setup in a
// live sample sat between 0.4 and 0.7, which is not a coincidence —
// it's the geometry: the stop was a fixed % of the FULL option premium
// (weeks of time value for a 25-DTE contract) while the target is
// delta × a fraction of ONE day's expected move. Two different time
// scales, so the ratio between them was an accident, not a choice.
//
// The recorded outcomes confirmed what that implies: across 166 tracked
// setups, profit factor 0.60, average return -4.48%, and 95 of 119
// closed setups EXPIRED without touching either leg. At R:R 0.6 the
// breakeven win rate is ~63% (~69% after costs) against an actual
// profitable-close rate of 40% — mathematically unwinnable.
//
// Fixed by making the two legs commensurate: the target still comes
// from delta × realistically-achievable move (shrinking it further is
// what caused the "targets never get hit" problem in the first place),
// and the STOP is now sized to whatever width that target can actually
// support — bounded below by MIN_SL_PREMIUM_PCT so it can't end up
// inside the noise, and still bounded above by the existing VIX/expiry
// premium stop. When no stop width satisfies both bounds, the setup is
// refused outright rather than emitted at a losing ratio.
// Exported for the same reason MAX_RISK_REWARD is: market-bias.ts re-applies
// this identical bar to setups already locked in Redis on every poll, so
// landing this fix immediately flushes the previously-generated sub-1.0 R:R
// setups instead of leaving them live until the day rolls over.
export const MIN_RISK_REWARD = 1.5;
// A stop tighter than this is inside the friction: ~3% round-trip costs
// plus a bid-ask spread that's allowed up to 5% of mid on the ATM leg
// means anything under ~15% of premium gets taken out by the cost of
// trading rather than by the market being wrong.
const MIN_SL_PREMIUM_PCT = 0.15;

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
// its % impact depends on lot size — this is a rough, broker-independent
// rule of thumb surfaced as a note, not a number the UI should present
// as precise (real costs vary by broker/plan), unlike position sizing
// below, which now IS a structured field once a real lot size is known.
const ESTIMATED_ROUND_TRIP_COST_PCT = 3; // brokerage-equivalent + STT + residual spread, as a % of entry premium

// Position sizing: quantity chosen so a stop-out risks a fixed % of
// trading capital, whatever the SL's own % of premium happens to be —
// previously out of scope (this module had no lot size to work with), but
// without it the premium-%-based SL silently became the user's real
// capital risk whenever they bought a fixed lot count regardless of stop
// width. DEFAULT_RISK_CONFIG is this app's only source for capital/risk%
// today (no per-user settings UI exists yet) — same single-user-terminal
// assumption the rest of this app already makes.
function calculatePositionSize(entry: number, stopLoss: number, lotSize: number): PositionSize | null {
  const riskPerUnit = Math.abs(entry - stopLoss);
  if (riskPerUnit <= 0 || lotSize <= 0) return null;

  const capital = DEFAULT_RISK_CONFIG.tradingCapital;
  const riskPct = DEFAULT_RISK_CONFIG.maxRiskPerTrade;
  const maxRiskAmount = capital * (riskPct / 100);
  const riskPerLot = riskPerUnit * lotSize;
  const riskBasedLots = Math.max(0, Math.floor(maxRiskAmount / riskPerLot));

  // Second, independent bound: what this position actually COSTS. Sizing on
  // the stop alone is inversely proportional to stop width, so a tighter
  // stop buys more lots for the same nominal risk — and for a naked long,
  // whose real maximum loss is the whole premium rather than the stop
  // distance, that quietly scales up the tail risk instead of holding it
  // flat. Whichever bound is stricter wins.
  const maxPremiumAmount = capital * (DEFAULT_RISK_CONFIG.maxPremiumPerTradePct / 100);
  const premiumPerLot = entry * lotSize;
  const premiumBasedLots = premiumPerLot > 0 ? Math.max(0, Math.floor(maxPremiumAmount / premiumPerLot)) : riskBasedLots;

  const lots = Math.min(riskBasedLots, premiumBasedLots);
  const quantity = lots * lotSize;
  const riskAmount = round2(quantity * riskPerUnit);

  const premiumOutlay = round2(quantity * entry);

  return {
    lots,
    quantity,
    riskAmount,
    riskPct: capital > 0 ? round2((riskAmount / capital) * 100) : 0,
    premiumOutlay,
    premiumPct: capital > 0 ? round2((premiumOutlay / capital) * 100) : 0,
    limitedBy: premiumBasedLots < riskBasedLots ? 'PREMIUM' : 'RISK',
    capital,
    lotSize,
  };
}

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
  dte: number | null = null,
  lotSize: number = 1
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
  return buildNakedLong(strikes, atmStrike, direction, side, confidence, expectedMovePoints, slPremiumPct, vix, dte, lotSize);
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
  dte: number | null = null,
  lotSize: number = 1
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
  const target = round2(entry + deltaMove);
  const grossReward = target - entry;

  // Costs are charged against BOTH legs when judging whether the ratio is
  // worth taking: a win pays the round trip out of the reward, a loss pays
  // it on top of the stop. Deliberately used for the GATE only, never
  // written into the displayed `riskReward` — brokerage is a flat rupee
  // amount per order so its % impact varies with lot size, and this stays
  // a broker-independent rule of thumb rather than a number the UI should
  // present as precise (same reasoning as the note in `reason` below).
  const roundTripCost = entry * (ESTIMATED_ROUND_TRIP_COST_PCT / 100);
  const netReward = grossReward - roundTripCost;
  if (netReward <= 0) {
    return {
      available: false,
      reason: `Projected target (${target.toFixed(2)}) doesn't clear the ~${ESTIMATED_ROUND_TRIP_COST_PCT}% round-trip cost of trading it — no edge left after costs.`,
    };
  }

  // Widest stop that still leaves MIN_RISK_REWARD after costs, solving
  // (grossReward - cost) / (stopWidth + cost) >= MIN_RISK_REWARD.
  const rrStopWidth = netReward / MIN_RISK_REWARD - roundTripCost;
  const maxStopWidth = entry * effectiveSlPct;
  const minStopWidth = entry * MIN_SL_PREMIUM_PCT;
  const stopWidth = Math.min(maxStopWidth, rrStopWidth);

  if (stopWidth < minStopWidth) {
    const impliedRr = round2(netReward / (minStopWidth + roundTripCost));
    return {
      available: false,
      reason:
        `Reward:risk after costs (${impliedRr.toFixed(2)}) is below the ${MIN_RISK_REWARD} minimum even at the tightest tradeable stop ` +
        `(${Math.round(MIN_SL_PREMIUM_PCT * 100)}% of premium). The ${deltaMove.toFixed(2)}-point projected move can't pay for the risk — skip, don't size down.`,
    };
  }

  const stopLoss = round2(entry - stopWidth);
  const risk = entry - stopLoss;
  const reward = grossReward;
  const riskReward = risk > 0 ? round2(reward / risk) : 0;
  const riskRewardNet = round2(netReward / (risk + roundTripCost));

  if (riskReward > MAX_RISK_REWARD) {
    return {
      available: false,
      reason: `Computed reward:risk (${riskReward.toFixed(2)}) exceeds the ${MAX_RISK_REWARD} plausibility ceiling — likely bad upstream Greeks/IV data this tick, not a real setup.`,
    };
  }

  const effectiveStopPct = entry > 0 ? risk / entry : 0;
  const estimatedCost = round2(roundTripCost);
  const positionSize = calculatePositionSize(entry, stopLoss, lotSize);
  const oneLotRiskPct = lotSize > 0 && positionSize && positionSize.capital > 0 ? round2(((entry - stopLoss) * lotSize / positionSize.capital) * 100) : null;

  let sizingNote: string;
  if (!positionSize) {
    sizingNote = ' Position size unavailable — no valid lot size for this contract.';
  } else if (positionSize.lots === 0) {
    // Two different bounds can force this, and saying the wrong one is
    // actively misleading: a high-priced contract can breach the premium
    // cap while its stop-based risk is comfortably UNDER the risk target,
    // in which case the old "risks ~X%, above the N% target" wording
    // reported a number that wasn't above anything.
    const oneLotPremium = round2(entry * lotSize);
    const oneLotPremiumPct = positionSize.capital > 0 ? round2((oneLotPremium / positionSize.capital) * 100) : 0;
    const capitalLabel = `₹${(positionSize.capital / 100000).toFixed(1)}L default capital`;
    sizingNote =
      oneLotPremiumPct > DEFAULT_RISK_CONFIG.maxPremiumPerTradePct
        ? ` Even 1 lot (${lotSize} qty) costs ₹${oneLotPremium.toFixed(0)} in premium — ${oneLotPremiumPct}% of ${capitalLabel}, above the ${DEFAULT_RISK_CONFIG.maxPremiumPerTradePct}% premium-per-trade cap, so no lot count fits; skip this one.`
        : ` Even 1 lot (${lotSize} qty) risks ~${oneLotRiskPct}% of ${capitalLabel} — above the ${DEFAULT_RISK_CONFIG.maxRiskPerTrade}% target, so no lot count keeps this trade within it; size down or skip.`;
  } else {
    sizingNote =
      ` Suggested size: ${positionSize.lots} lot(s) (${positionSize.quantity} qty) risks ₹${positionSize.riskAmount.toFixed(0)} ` +
      `(${positionSize.riskPct}% of ₹${(positionSize.capital / 100000).toFixed(1)}L default capital) if SL hits` +
      (positionSize.limitedBy === 'PREMIUM' ? `, capped by the ${DEFAULT_RISK_CONFIG.maxPremiumPerTradePct}% premium-per-trade limit rather than by that stop` : '') +
      `. Premium outlay ₹${positionSize.premiumOutlay.toFixed(0)} (${positionSize.premiumPct}%) — that, not the stop-based figure, is what a gap through the stop or an expiry-day collapse actually costs.`;
  }

  return {
    available: true,
    structureType: 'NAKED_LONG',
    side,
    strike: atmStrike,
    entry,
    stopLoss,
    target,
    riskReward,
    positionSize: positionSize ?? undefined,
    reason:
      `${direction} bias at ${confidence}/100 confidence — ATM ${side} ${atmStrike} @ ${entry.toFixed(2)}${hasQuote ? ' (bid-ask mid)' : ''}. ` +
      `Target ${target.toFixed(2)} from delta (${leg.delta.toFixed(2)}) × IV-implied expected move (${expectedMovePoints.toFixed(0)} pts). ` +
      `SL ${stopLoss.toFixed(2)} — a ${Math.round(effectiveStopPct * 100)}% premium stop, sized so the trade clears ${MIN_RISK_REWARD}:1 reward:risk after costs` +
      (stopWidth < maxStopWidth ? ` (tighter than the ${Math.round(effectiveSlPct * 100)}% ceiling${vixNote}${expiryNote} this setup would otherwise allow)` : `${vixNote}${expiryNote}`) +
      `. R:R ${riskReward.toFixed(2)} gross, ~${riskRewardNet.toFixed(2)} after costs.` +
      (dte != null ? ` DTE ${dte}.` : '') +
      ` The entry/SL/target figures themselves are pre-cost — brokerage, STT, and slippage beyond this mid-price entry typically run ~${ESTIMATED_ROUND_TRIP_COST_PCT}% of premium round-trip (~${estimatedCost.toFixed(2)} here), a rough broker-dependent estimate, which is why it gates the setup rather than being subtracted from the displayed prices.` +
      sizingNote,
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
