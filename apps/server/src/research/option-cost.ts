// ============================================================
// SWEEP_CLOSE — modelled per-trade option cost, in R (research only)
// ============================================================
// Every assumption is listed where it is used, per the plan (Stage 1,
// "Costs"). Nothing here touches a live gate, floor or flag; it is read
// entirely by the sweep-close report CLI to convert an underlying-R trade
// into a net-of-cost option R, for comparison only.
//
// ASSUMPTIONS (all stated up front, none tuned after seeing a result):
//   - Strike step: NIFTY 50, BANKNIFTY 100, SENSEX 100, CRUDEOIL 50, GOLD 100.
//   - Volatility multiplier k on India VIX: NIFTY 1.0, BANKNIFTY 1.25.
//   - SENSEX/CRUDEOIL/GOLD sigma: HV20 (20-session close-to-close, annualised
//     √252) × 1.1.
//   - Expiry calendar (assumed, not fetched): NIFTY weekly Tuesday; SENSEX
//     weekly Thursday; BANKNIFTY monthly, the last Tuesday of the month;
//     CRUDEOIL/GOLD monthly, the 20th calendar day (the previous Friday if
//     that falls on a weekend) — a listed-style monthly cycle landing
//     roughly 15-20 days out. The nearest expiry with DTE >= 1 is used; DTE
//     is calendar days, not trading days.
//   - Time to expiry: DTE / 365.
//   - r = 7% (RISK_FREE_RATE), Black-Scholes European pricing/greeks.
//   - Round-trip cost = calibrated spread (% of premium) + (0.2% + 1%) × P
//     (STT/exchange/GST-style all-in slab) + ₹47.2 per lot, expressed per
//     option unit by dividing the flat piece by the chain's lot size.
// ============================================================

import { blackScholesPrice, calculateGreeks } from '@fno/analytics';
import { round } from './stats.js';

export const STRIKE_STEP: Record<string, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
  CRUDEOIL: 50,
  GOLD: 100,
};

export const VIX_MULTIPLIER: Record<'NIFTY' | 'BANKNIFTY', number> = { NIFTY: 1.0, BANKNIFTY: 1.25 };
export const HV_MULTIPLIER = 1.1;
export const RISK_FREE_RATE = 0.07;
export const PCT_COST = 0.002 + 0.01; // 0.2% + 1% all-in slab on premium
export const BROKERAGE_PER_LOT = 47.2;

/** IST calendar date (YYYY-MM-DD) → day-of-week, Sun=0. */
function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00+05:30`).getUTCDay();
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00+05:30`);
  const tb = Date.parse(`${b}T00:00:00+05:30`);
  return Math.round((tb - ta) / 86400000);
}

/** The next date on/after `from` with the given weekday (0=Sun..6=Sat), strictly after `from` if `strict`. */
function nextWeekday(from: string, weekday: number, strict: boolean): string {
  let d = from;
  if (strict) d = addDays(d, 1);
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  return d;
}

/** The last Tuesday on/before the last day of `dateStr`'s month. */
function lastTuesdayOfMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).toLocaleDateString('en-CA', { timeZone: 'UTC' });
  let cur = lastDay;
  while (weekdayOf(cur) !== 2) cur = addDays(cur, -1);
  return cur;
}

/** The 20th of `dateStr`'s month, rolled back to Friday if it lands on a weekend. */
function twentiethOfMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  let cur = new Date(Date.UTC(y, m, 20)).toLocaleDateString('en-CA', { timeZone: 'UTC' });
  const wd = weekdayOf(cur);
  if (wd === 0) cur = addDays(cur, -2);
  else if (wd === 6) cur = addDays(cur, -1);
  return cur;
}

/** The assumed expiry calendar's nearest expiry to `date` with DTE >= 1. Returns { expiry, dte }. */
export function nearestExpiry(symbol: string, date: string): { expiry: string; dte: number } {
  let expiry: string;
  if (symbol === 'NIFTY') expiry = nextWeekday(date, 2, false);
  else if (symbol === 'SENSEX') expiry = nextWeekday(date, 4, false);
  else if (symbol === 'BANKNIFTY') {
    expiry = lastTuesdayOfMonth(date);
    if (daysBetween(date, expiry) < 1) expiry = lastTuesdayOfMonth(addDays(date, 32));
  } else {
    // CRUDEOIL / GOLD
    expiry = twentiethOfMonth(date);
    if (daysBetween(date, expiry) < 1) expiry = twentiethOfMonth(addDays(date, 32));
  }
  let dte = daysBetween(date, expiry);
  while (dte < 1) {
    expiry = addDays(expiry, 7);
    dte = daysBetween(date, expiry);
  }
  return { expiry, dte };
}

export function atmStrike(symbol: string, spot: number): number {
  const step = STRIKE_STEP[symbol] ?? 50;
  return Math.round(spot / step) * step;
}

/** HV20: annualised (√252) stdev of daily close-to-close log returns over the trailing 20 sessions ending at `idx` (inclusive). */
export function hv20(dailyCloses: readonly number[], idx: number): number | null {
  if (idx < 20) return null;
  const rets: number[] = [];
  for (let k = idx - 19; k <= idx; k++) {
    if (dailyCloses[k - 1] > 0 && dailyCloses[k] > 0) rets.push(Math.log(dailyCloses[k] / dailyCloses[k - 1]));
  }
  if (rets.length < 15) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export interface ChainCalibration {
  spreadPct: number; // median (ask-bid)/mid of the 3 strikes nearest ATM
  lotSize: number;
}

export interface OptionCostInputs {
  symbol: string;
  session: string; // IST date the trigger fired on
  spot: number; // entry (underlying)
  atr: number;
  stopPoints: number;
  direction: 'BULLISH' | 'BEARISH';
  sigma: number; // annualised, decimal (already includes the k / HV multiplier)
  chain: ChainCalibration;
}

export interface OptionCostResult {
  expiry: string;
  dte: number;
  strike: number;
  optionType: 'CE' | 'PE';
  sigma: number;
  premium: number;
  delta: number;
  premiumRisk: number;
  roundTripCost: number;
  costR: number;
  liveWouldRefuse: boolean;
  refuseReason: 'PREMIUM_RISK' | 'COST_PCT' | null;
}

export function computeOptionCost(input: OptionCostInputs): OptionCostResult {
  const { symbol, session, spot, atr, stopPoints, direction, sigma, chain } = input;
  const { expiry, dte } = nearestExpiry(symbol, session);
  const strike = atmStrike(symbol, spot);
  const optionType: 'CE' | 'PE' = direction === 'BULLISH' ? 'CE' : 'PE';
  const timeToExpiry = dte / 365;
  const premium = blackScholesPrice({ spotPrice: spot, strikePrice: strike, timeToExpiry, riskFreeRate: RISK_FREE_RATE, iv: sigma, optionType });
  const greeks = calculateGreeks({ spotPrice: spot, strikePrice: strike, timeToExpiry, riskFreeRate: RISK_FREE_RATE, iv: sigma, optionType });
  const absDelta = Math.abs(greeks.delta);
  const premiumRisk = Math.max(absDelta * stopPoints, 0.15 * premium, 1.0 * atr * absDelta);
  const roundTripCost = chain.spreadPct * premium + PCT_COST * premium + BROKERAGE_PER_LOT / chain.lotSize;
  const costR = premiumRisk > 0 ? roundTripCost / premiumRisk : 0;
  const refusePremium = premium > 0 && premiumRisk > 0.45 * premium;
  const refuseCost = premium > 0 && roundTripCost > 0.05 * premium;
  return {
    expiry,
    dte,
    strike,
    optionType,
    sigma: round(sigma, 4),
    premium: round(premium, 2),
    delta: round(greeks.delta, 4),
    premiumRisk: round(premiumRisk, 2),
    roundTripCost: round(roundTripCost, 2),
    costR: round(costR, 4),
    liveWouldRefuse: refusePremium || refuseCost,
    refuseReason: refusePremium ? 'PREMIUM_RISK' : refuseCost ? 'COST_PCT' : null,
  };
}
