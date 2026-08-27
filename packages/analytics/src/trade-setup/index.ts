// ============================================================
// DIRECTIONAL TRADE SETUP
// ============================================================
// Builds the actual, actionable structure for the current bias —
// a single-leg long option when IV Rank is unknown (indices/MCX/
// stocks outside the F&O universe scan, where Strategy Scanner has
// no opinion to align with), or the matching defined-risk spread
// once IV Rank is known — mirroring Strategy Scanner's own regime
// call for that exact symbol so the two features can't recommend
// different things for the same read. Gated on bias confidence so
// it stays silent rather than emitting a call on a weak/mixed read.
//
// This is a transparent heuristic over real numbers, not investment
// advice or a prediction — `reason` always explains exactly how the
// numbers were derived so it can be checked, not just trusted.
// ============================================================

import { IV_RANK_HIGH_THRESHOLD, type OptionChainStrike, type OptionType, type BiasDirection, type TradeSetup, type SpreadLeg } from '@fno/shared';

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
const MAX_SL_PREMIUM_PCT = 0.7;

// --- Spread construction constants ---
// Strike offsets are in ARRAY POSITIONS within the strikes list (already
// sorted by consecutive available strikes), not fixed price distances —
// robust across symbols with very different strike intervals (NIFTY's 50
// vs a small-cap's 2.5).
const DEBIT_SPREAD_WIDTH_STRIKES = 3; // buy ATM, sell this many strikes further OTM
const CREDIT_SPREAD_SHORT_OFFSET_STRIKES = 1; // short leg sits this many strikes OTM (near support/resistance), not naked at spot
const CREDIT_SPREAD_WIDTH_STRIKES = 3; // protective long leg sits this many strikes beyond the short leg

// A defined-risk spread's max profit/loss are only realized if held to (or
// very near) expiry — exiting early at a fraction of each is the standard
// retail practice, mirroring the naked-long's own "don't wait for the
// full projected move" philosophy via its 30%/40% premium stop.
const SPREAD_TARGET_PCT_OF_MAX_PROFIT = 0.6;
const SPREAD_STOP_PCT_OF_MAX_LOSS = 0.6;

export function buildTradeSetup(
  strikes: OptionChainStrike[],
  atmStrike: number,
  direction: BiasDirection,
  confidence: number,
  expectedMovePoints: number,
  ivRank: number | null = null,
  slPremiumPct: number = DEFAULT_SL_PREMIUM_PCT,
  vix: number | null = null
): TradeSetup {
  if (confidence < MIN_CONFIDENCE) {
    return {
      available: false,
      reason: `Bias confidence (${confidence}/100) is below the ${MIN_CONFIDENCE} threshold needed for a setup — signals are too mixed.`,
    };
  }

  const highIv = ivRank != null && ivRank >= IV_RANK_HIGH_THRESHOLD;

  if (direction === 'NEUTRAL') {
    if (highIv) {
      return buildIronCondor(strikes, atmStrike, confidence, ivRank!);
    }
    return { available: false, reason: 'Market bias is neutral — no high-conviction directional setup right now.' };
  }

  const side: OptionType = direction === 'BULLISH' ? 'CE' : 'PE';

  // Once IV Rank is known, always build the matching defined-risk spread
  // instead of a naked long — mirrors Strategy Scanner's own regime call
  // for this exact symbol (it never recommends a naked long, always a
  // spread), so the two features can't disagree on what to actually
  // trade. Only falls back to the naked long below when ivRank is
  // unknown — indices/MCX/stocks outside the F&O universe scan, which
  // Strategy Scanner doesn't cover either, so there's no competing
  // recommendation to align with.
  if (ivRank != null) {
    if (direction === 'BULLISH') {
      return highIv
        ? buildBullPutSpread(strikes, atmStrike, confidence, ivRank)
        : buildBullCallSpread(strikes, atmStrike, confidence, ivRank);
    }
    return highIv
      ? buildBearCallSpread(strikes, atmStrike, confidence, ivRank)
      : buildBearPutSpread(strikes, atmStrike, confidence, ivRank);
  }

  return buildNakedLong(strikes, atmStrike, direction, side, confidence, expectedMovePoints, slPremiumPct, vix);
}

// ============================================================
// NAKED LONG (ivRank unknown — indices, MCX, stocks outside the scan)
// ============================================================

function buildNakedLong(
  strikes: OptionChainStrike[],
  atmStrike: number,
  direction: BiasDirection,
  side: OptionType,
  confidence: number,
  expectedMovePoints: number,
  slPremiumPct: number,
  vix: number | null
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

  const entry = leg.ltp;
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
      `${direction} bias at ${confidence}/100 confidence — ATM ${side} ${atmStrike} @ ${entry.toFixed(2)}. ` +
      `Target ${target.toFixed(2)} from delta (${leg.delta.toFixed(2)}) × IV-implied expected move (${expectedMovePoints.toFixed(0)} pts). ` +
      `SL ${stopLoss.toFixed(2)} — a ${Math.round(effectiveSlPct * 100)}% premium stop${vixNote}.`,
  };
}

// ============================================================
// SPREADS (ivRank known)
// ============================================================

function strikeAtOffset(strikes: OptionChainStrike[], atmStrike: number, offset: number): OptionChainStrike | undefined {
  const atmIdx = strikes.findIndex((s) => s.strike === atmStrike);
  if (atmIdx === -1) return undefined;
  return strikes[atmIdx + offset];
}

function legLtp(entry: OptionChainStrike | undefined, side: OptionType): number | null {
  const leg = side === 'CE' ? entry?.call : entry?.put;
  return leg && leg.ltp > 0 ? leg.ltp : null;
}

function unavailableSpread(strategy: string, reason: string): TradeSetup {
  return { available: false, reason: `${strategy}: ${reason}` };
}

/** Debit vertical: buy near strike, sell a further OTM strike in the direction of the bet. */
function buildDebitSpread(
  strikes: OptionChainStrike[],
  side: OptionType,
  direction: BiasDirection,
  buyStrikeEntry: OptionChainStrike,
  strategy: string,
  confidence: number,
  ivRank: number,
  sellOffset: number
): TradeSetup {
  const sellEntry = strikeAtOffset(strikes, buyStrikeEntry.strike, sellOffset);
  if (!sellEntry) return unavailableSpread(strategy, 'not enough strikes in the chain to build the far leg.');

  const buyPremium = legLtp(buyStrikeEntry, side);
  const sellPremium = legLtp(sellEntry, side);
  if (buyPremium == null || sellPremium == null) {
    return unavailableSpread(strategy, `no live ${side} quote at one of the required strikes.`);
  }

  const netPremium = round2(buyPremium - sellPremium);
  if (netPremium <= 0) {
    return unavailableSpread(strategy, 'the near leg is not pricier than the far leg this tick — quotes look inverted, not a real spread.');
  }

  const width = Math.abs(sellEntry.strike - buyStrikeEntry.strike);
  const maxProfit = round2(width - netPremium);
  const maxLoss = netPremium;
  if (maxProfit <= 0) {
    return unavailableSpread(strategy, `net debit (${netPremium.toFixed(2)}) exceeds the strike width (${width}) — no profitable outcome, bad upstream data this tick.`);
  }

  const riskReward = maxLoss > 0 ? round2(maxProfit / maxLoss) : 0;
  const breakeven = round2(direction === 'BULLISH' ? buyStrikeEntry.strike + netPremium : buyStrikeEntry.strike - netPremium);

  const legs: SpreadLeg[] = [
    { action: 'BUY', side, strike: buyStrikeEntry.strike, premium: buyPremium },
    { action: 'SELL', side, strike: sellEntry.strike, premium: sellPremium },
  ];

  return {
    available: true,
    structureType: 'SPREAD',
    strategy,
    legs,
    netPremium,
    maxProfit,
    maxLoss,
    breakeven,
    riskReward,
    reason:
      `${direction} bias at ${confidence}/100 confidence, IV Rank ${ivRank} not elevated — ${strategy}: buy ${side} ${buyStrikeEntry.strike} @ ${buyPremium.toFixed(2)}, ` +
      `sell ${side} ${sellEntry.strike} @ ${sellPremium.toFixed(2)}. Net debit ${netPremium.toFixed(2)}. ` +
      `Max profit ${maxProfit.toFixed(2)}, max loss ${maxLoss.toFixed(2)}, breakeven ${breakeven.toFixed(2)}.`,
  };
}

/** Credit vertical: sell a near-OTM strike, buy a further OTM strike for protection. */
function buildCreditSpread(
  strikes: OptionChainStrike[],
  side: OptionType,
  direction: BiasDirection,
  sellStrikeEntry: OptionChainStrike,
  strategy: string,
  confidence: number,
  ivRank: number,
  buyOffset: number
): TradeSetup {
  const buyEntry = strikeAtOffset(strikes, sellStrikeEntry.strike, buyOffset);
  if (!buyEntry) return unavailableSpread(strategy, 'not enough strikes in the chain to build the protective leg.');

  const sellPremium = legLtp(sellStrikeEntry, side);
  const buyPremium = legLtp(buyEntry, side);
  if (sellPremium == null || buyPremium == null) {
    return unavailableSpread(strategy, `no live ${side} quote at one of the required strikes.`);
  }

  const netPremium = round2(buyPremium - sellPremium); // negative: a credit
  const creditReceived = round2(-netPremium);
  if (creditReceived <= 0) {
    return unavailableSpread(strategy, 'the short leg is not pricier than the protective leg this tick — quotes look inverted, not a real spread.');
  }

  const width = Math.abs(buyEntry.strike - sellStrikeEntry.strike);
  const maxProfit = creditReceived;
  const maxLoss = round2(width - creditReceived);
  if (maxLoss <= 0) {
    return unavailableSpread(strategy, `credit received (${creditReceived.toFixed(2)}) exceeds the strike width (${width}) — quotes look implausible, not a real spread.`);
  }

  const riskReward = maxLoss > 0 ? round2(maxProfit / maxLoss) : 0;
  const breakeven = round2(direction === 'BULLISH' ? sellStrikeEntry.strike - creditReceived : sellStrikeEntry.strike + creditReceived);

  const legs: SpreadLeg[] = [
    { action: 'SELL', side, strike: sellStrikeEntry.strike, premium: sellPremium },
    { action: 'BUY', side, strike: buyEntry.strike, premium: buyPremium },
  ];

  return {
    available: true,
    structureType: 'SPREAD',
    strategy,
    legs,
    netPremium,
    maxProfit,
    maxLoss,
    breakeven,
    riskReward,
    reason:
      `${direction} bias at ${confidence}/100 confidence, IV Rank ${ivRank} elevated — ${strategy}: sell ${side} ${sellStrikeEntry.strike} @ ${sellPremium.toFixed(2)}, ` +
      `buy ${side} ${buyEntry.strike} @ ${buyPremium.toFixed(2)} for protection. Net credit ${creditReceived.toFixed(2)}. ` +
      `Max profit ${maxProfit.toFixed(2)}, max loss ${maxLoss.toFixed(2)}, breakeven ${breakeven.toFixed(2)}.`,
  };
}

function buildBullCallSpread(strikes: OptionChainStrike[], atmStrike: number, confidence: number, ivRank: number): TradeSetup {
  const atmEntry = strikes.find((s) => s.strike === atmStrike);
  if (!atmEntry) return unavailableSpread('Bull Call Spread', 'ATM strike not found in the chain.');
  return buildDebitSpread(strikes, 'CE', 'BULLISH', atmEntry, 'Bull Call Spread', confidence, ivRank, DEBIT_SPREAD_WIDTH_STRIKES);
}

function buildBearPutSpread(strikes: OptionChainStrike[], atmStrike: number, confidence: number, ivRank: number): TradeSetup {
  const atmEntry = strikes.find((s) => s.strike === atmStrike);
  if (!atmEntry) return unavailableSpread('Bear Put Spread', 'ATM strike not found in the chain.');
  return buildDebitSpread(strikes, 'PE', 'BEARISH', atmEntry, 'Bear Put Spread', confidence, ivRank, -DEBIT_SPREAD_WIDTH_STRIKES);
}

function buildBullPutSpread(strikes: OptionChainStrike[], atmStrike: number, confidence: number, ivRank: number): TradeSetup {
  const sellEntry = strikeAtOffset(strikes, atmStrike, -CREDIT_SPREAD_SHORT_OFFSET_STRIKES);
  if (!sellEntry) return unavailableSpread('Bull Put Spread', 'not enough strikes below ATM to build the short leg.');
  return buildCreditSpread(strikes, 'PE', 'BULLISH', sellEntry, 'Bull Put Spread', confidence, ivRank, -CREDIT_SPREAD_WIDTH_STRIKES);
}

function buildBearCallSpread(strikes: OptionChainStrike[], atmStrike: number, confidence: number, ivRank: number): TradeSetup {
  const sellEntry = strikeAtOffset(strikes, atmStrike, CREDIT_SPREAD_SHORT_OFFSET_STRIKES);
  if (!sellEntry) return unavailableSpread('Bear Call Spread', 'not enough strikes above ATM to build the short leg.');
  return buildCreditSpread(strikes, 'CE', 'BEARISH', sellEntry, 'Bear Call Spread', confidence, ivRank, CREDIT_SPREAD_WIDTH_STRIKES);
}

function buildIronCondor(strikes: OptionChainStrike[], atmStrike: number, confidence: number, ivRank: number): TradeSetup {
  const strategy = 'Iron Condor';
  const callShortEntry = strikeAtOffset(strikes, atmStrike, CREDIT_SPREAD_SHORT_OFFSET_STRIKES);
  const callLongEntry = strikeAtOffset(strikes, atmStrike, CREDIT_SPREAD_SHORT_OFFSET_STRIKES + CREDIT_SPREAD_WIDTH_STRIKES);
  const putShortEntry = strikeAtOffset(strikes, atmStrike, -CREDIT_SPREAD_SHORT_OFFSET_STRIKES);
  const putLongEntry = strikeAtOffset(strikes, atmStrike, -CREDIT_SPREAD_SHORT_OFFSET_STRIKES - CREDIT_SPREAD_WIDTH_STRIKES);

  if (!callShortEntry || !callLongEntry || !putShortEntry || !putLongEntry) {
    return unavailableSpread(strategy, 'not enough strikes on both sides of the chain to build all four legs.');
  }

  const callShortPremium = legLtp(callShortEntry, 'CE');
  const callLongPremium = legLtp(callLongEntry, 'CE');
  const putShortPremium = legLtp(putShortEntry, 'PE');
  const putLongPremium = legLtp(putLongEntry, 'PE');
  if (callShortPremium == null || callLongPremium == null || putShortPremium == null || putLongPremium == null) {
    return unavailableSpread(strategy, 'no live quote at one of the four required strikes.');
  }

  const netPremium = round2(callLongPremium + putLongPremium - callShortPremium - putShortPremium); // negative: a credit
  const creditReceived = round2(-netPremium);
  if (creditReceived <= 0) {
    return unavailableSpread(strategy, 'the short legs are not pricier than the protective legs this tick — quotes look inverted, not a real condor.');
  }

  const callWingWidth = Math.abs(callLongEntry.strike - callShortEntry.strike);
  const putWingWidth = Math.abs(putShortEntry.strike - putLongEntry.strike);
  const maxProfit = creditReceived;
  const maxLoss = round2(Math.max(callWingWidth, putWingWidth) - creditReceived);
  if (maxLoss <= 0) {
    return unavailableSpread(strategy, 'credit received exceeds the wing width — quotes look implausible, not a real condor.');
  }

  const riskReward = maxLoss > 0 ? round2(maxProfit / maxLoss) : 0;
  const breakevenLower = round2(putShortEntry.strike - creditReceived);
  const breakevenUpper = round2(callShortEntry.strike + creditReceived);

  const legs: SpreadLeg[] = [
    { action: 'SELL', side: 'CE', strike: callShortEntry.strike, premium: callShortPremium },
    { action: 'BUY', side: 'CE', strike: callLongEntry.strike, premium: callLongPremium },
    { action: 'SELL', side: 'PE', strike: putShortEntry.strike, premium: putShortPremium },
    { action: 'BUY', side: 'PE', strike: putLongEntry.strike, premium: putLongPremium },
  ];

  return {
    available: true,
    structureType: 'SPREAD',
    strategy,
    legs,
    netPremium,
    maxProfit,
    maxLoss,
    breakevenLower,
    breakevenUpper,
    riskReward,
    reason:
      `NEUTRAL bias at ${confidence}/100 confidence, IV Rank ${ivRank} elevated — Iron Condor: sell CE ${callShortEntry.strike} / buy CE ${callLongEntry.strike}, ` +
      `sell PE ${putShortEntry.strike} / buy PE ${putLongEntry.strike}. Net credit ${creditReceived.toFixed(2)}. ` +
      `Max profit ${maxProfit.toFixed(2)}, max loss ${maxLoss.toFixed(2)}, range ${breakevenLower.toFixed(2)}–${breakevenUpper.toFixed(2)}.`,
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
