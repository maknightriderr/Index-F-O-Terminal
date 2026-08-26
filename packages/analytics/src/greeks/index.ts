// ============================================================
// BLACK-SCHOLES GREEKS ENGINE
// ============================================================
// Pure mathematical implementation of the Black-Scholes model
// for European-style options. Indian index/stock options are
// European-style, making this appropriate.
//
// Handles edge cases: near-expiry, deep ITM/OTM, zero DTE.
// ============================================================

import { RISK_FREE_RATE } from '@fno/shared';
import type { Greeks, OptionType, OptionChainStrike, DecayAnalysis } from '@fno/shared';

// --- Normal Distribution Helpers ---

/**
 * Cumulative standard normal distribution (Abramowitz & Stegun approximation).
 * Accuracy: ~1e-7
 */
function normalCDF(x: number): number {
  if (x > 10) return 1;
  if (x < -10) return 0;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Standard normal probability density function.
 */
function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// --- Black-Scholes Core ---

interface BSInput {
  spotPrice: number;
  strikePrice: number;
  timeToExpiry: number;  // in years
  riskFreeRate: number;
  iv: number;            // annualized implied volatility (decimal, e.g. 0.20 for 20%)
  optionType: OptionType;
}

/**
 * Calculate d1 and d2 parameters for Black-Scholes.
 */
function calcD1D2(
  spot: number,
  strike: number,
  t: number,
  r: number,
  sigma: number
): { d1: number; d2: number } {
  // Guard against zero/negative time or volatility
  if (t <= 0 || sigma <= 0) {
    const intrinsic = spot - strike;
    return {
      d1: intrinsic > 0 ? 100 : intrinsic < 0 ? -100 : 0,
      d2: intrinsic > 0 ? 100 : intrinsic < 0 ? -100 : 0,
    };
  }

  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (r + sigma * sigma / 2) * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  return { d1, d2 };
}

/**
 * Black-Scholes option price.
 */
export function blackScholesPrice(input: BSInput): number {
  const { spotPrice, strikePrice, timeToExpiry, riskFreeRate, iv, optionType } = input;

  // At expiry, return intrinsic value
  if (timeToExpiry <= 0) {
    if (optionType === 'CE') return Math.max(0, spotPrice - strikePrice);
    return Math.max(0, strikePrice - spotPrice);
  }

  const { d1, d2 } = calcD1D2(spotPrice, strikePrice, timeToExpiry, riskFreeRate, iv);
  const discountFactor = Math.exp(-riskFreeRate * timeToExpiry);

  if (optionType === 'CE') {
    return spotPrice * normalCDF(d1) - strikePrice * discountFactor * normalCDF(d2);
  } else {
    return strikePrice * discountFactor * normalCDF(-d2) - spotPrice * normalCDF(-d1);
  }
}

/**
 * Calculate all Greeks for an option.
 */
export function calculateGreeks(input: BSInput): Greeks {
  const { spotPrice, strikePrice, timeToExpiry, riskFreeRate, iv, optionType } = input;

  // Edge case: at/past expiry
  if (timeToExpiry <= 0) {
    const itm = optionType === 'CE'
      ? spotPrice > strikePrice
      : spotPrice < strikePrice;

    return {
      delta: itm ? (optionType === 'CE' ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      iv: iv,
    };
  }

  // Edge case: very low IV
  if (iv <= 0.001) {
    const itm = optionType === 'CE'
      ? spotPrice > strikePrice
      : spotPrice < strikePrice;

    return {
      delta: itm ? (optionType === 'CE' ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      iv: iv,
    };
  }

  const { d1, d2 } = calcD1D2(spotPrice, strikePrice, timeToExpiry, riskFreeRate, iv);
  const sqrtT = Math.sqrt(timeToExpiry);
  const discountFactor = Math.exp(-riskFreeRate * timeToExpiry);
  const pdfD1 = normalPDF(d1);

  // --- Delta ---
  let delta: number;
  if (optionType === 'CE') {
    delta = normalCDF(d1);
  } else {
    delta = normalCDF(d1) - 1;
  }

  // --- Gamma (same for both CE and PE) ---
  const gamma = pdfD1 / (spotPrice * iv * sqrtT);

  // --- Theta (per calendar day) ---
  let theta: number;
  const thetaCommon = -(spotPrice * pdfD1 * iv) / (2 * sqrtT);

  if (optionType === 'CE') {
    theta = (thetaCommon - riskFreeRate * strikePrice * discountFactor * normalCDF(d2)) / 365;
  } else {
    theta = (thetaCommon + riskFreeRate * strikePrice * discountFactor * normalCDF(-d2)) / 365;
  }

  // --- Vega (per 1% change in IV) ---
  const vega = (spotPrice * sqrtT * pdfD1) / 100;

  return {
    delta: clampGreek(delta, -1, 1),
    gamma: clampGreek(gamma, 0, Infinity),
    theta: clampGreek(theta, -Infinity, 0), // Theta is always negative for long options
    vega: clampGreek(vega, 0, Infinity),
    iv: iv,
  };
}

/**
 * Calculate implied volatility via bisection.
 * Returns IV as decimal (e.g., 0.20 for 20%).
 */
export function calculateIV(
  marketPrice: number,
  spotPrice: number,
  strikePrice: number,
  timeToExpiry: number,
  riskFreeRate: number = RISK_FREE_RATE,
  optionType: OptionType = 'CE',
  maxIterations: number = 100,
  tolerance: number = 0.0001
): number {
  // Sanity checks
  if (marketPrice <= 0) return 0;
  if (timeToExpiry <= 0) return 0;

  // Intrinsic value check
  const intrinsic = optionType === 'CE'
    ? Math.max(0, spotPrice - strikePrice)
    : Math.max(0, strikePrice - spotPrice);

  if (marketPrice < intrinsic * 0.99) return 0; // Below intrinsic

  // Bisection over [SIGMA_MIN, SIGMA_MAX] — option price is strictly
  // monotonically increasing in sigma, so bisection is guaranteed to
  // converge whenever the market price actually falls inside the bracket.
  // This used to be Newton-Raphson, which had two distinct live failure
  // modes: it could diverge to an absurd boundary value on highly-convex
  // short-dated options (a "500% IV" observed live on a 5-DTE near-ATM
  // NIFTY option), and — found while investigating an implausible
  // BANKNIFTY trade-setup target — it can get stuck in a stable 2-point
  // oscillation (sigma bouncing between ~0.006 and ~1.006 every iteration,
  // forever) whenever the true solution sits in a near-zero-vega region,
  // which a perfectly ordinary 34-DTE ATM option with ~8-9% IV did here.
  // Bisection has neither failure mode: slower per-iteration, but
  // unconditionally stable, at the cost this codebase can easily afford.
  const SIGMA_MIN = 0.001;
  const SIGMA_MAX = 3.0; // 300% IV cap — still generous; genuine 500%+ never happens, only a diverging solver landing there

  const priceAt = (sigma: number) =>
    blackScholesPrice({ spotPrice, strikePrice, timeToExpiry, riskFreeRate, iv: sigma, optionType });

  const priceLo = priceAt(SIGMA_MIN);
  const priceHi = priceAt(SIGMA_MAX);

  // Market price falls outside what any IV in [0.1%, 300%] could produce —
  // not a resolvable IV, an upstream data issue (stale/bad quote), so report
  // "unresolvable" (0) rather than a plausible-looking number that isn't.
  if (marketPrice <= priceLo || marketPrice >= priceHi) return 0;

  let lo = SIGMA_MIN;
  let hi = SIGMA_MAX;

  for (let i = 0; i < maxIterations; i++) {
    const mid = (lo + hi) / 2;
    const diff = priceAt(mid) - marketPrice;

    if (Math.abs(diff) < tolerance) return mid;
    if (diff > 0) hi = mid; else lo = mid;
  }

  // Ran out of iterations before hitting the price tolerance exactly — the
  // bracket has still shrunk to within (SIGMA_MAX-SIGMA_MIN)/2^maxIterations,
  // far tighter than any real use needs, so the midpoint is a safe result
  // rather than a failure.
  return (lo + hi) / 2;
}

/**
 * Calculate all Greeks from market price (first solves for IV).
 */
export function calculateGreeksFromPrice(
  marketPrice: number,
  spotPrice: number,
  strikePrice: number,
  timeToExpiry: number,
  optionType: OptionType,
  riskFreeRate: number = RISK_FREE_RATE
): Greeks {
  const iv = calculateIV(
    marketPrice, spotPrice, strikePrice,
    timeToExpiry, riskFreeRate, optionType
  );

  // calculateIV returns exactly 0 as its own "could not resolve" sentinel
  // whenever timeToExpiry > 0 (see its own early-returns) — never a genuine
  // market reading, since a live option with real time value essentially
  // never has true 0% IV. Feeding that sentinel into calculateGreeks would
  // hit its near-zero-IV edge case (meant for genuinely at-expiry-like
  // conditions) and fabricate a confidently wrong hard ITM/OTM delta of 1
  // or 0 instead of "no data" — this is exactly what produced a delta of
  // 1.00 on an ordinary near-ATM BANKNIFTY option and roughly doubled its
  // trade-setup target. Report honest zeros so callers (e.g. Trade Setup's
  // delta-move guard) correctly treat this leg as having no usable Greeks.
  // (timeToExpiry <= 0 is excluded — that's genuine expiry, where
  // calculateGreeks's own zero-DTE branch computing a hard ITM/OTM delta
  // is correct, not a failure.)
  if (timeToExpiry > 0 && iv <= 0) {
    return { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 };
  }

  return calculateGreeks({
    spotPrice, strikePrice: strikePrice, timeToExpiry,
    riskFreeRate, iv, optionType,
  });
}

// --- Time Decay Analysis ---

/**
 * How fast theta is eating premium right now, at the ATM strike (where
 * theta bites hardest). Speed is classified purely from DTE — decay
 * accelerates non-linearly into expiry regardless of the underlying,
 * so DTE alone is a reliable, defensible classifier (no historical
 * decay-curve data needed).
 */
export function analyzeTimeDecay(
  strikes: OptionChainStrike[],
  atmStrike: number,
  dte: number
): DecayAnalysis {
  const atmEntry = strikes.find((s) => s.strike === atmStrike);

  const thetaPct = (leg: { theta: number; ltp: number } | null | undefined): number =>
    leg && leg.ltp > 0 ? clampGreek((leg.theta / leg.ltp) * 100, -100, 0) : 0;

  const speed: DecayAnalysis['speed'] =
    dte <= 1 ? 'EXTREME' : dte <= 3 ? 'FAST' : dte <= 7 ? 'MODERATE' : 'SLOW';

  return {
    atmCallThetaPct: thetaPct(atmEntry?.call),
    atmPutThetaPct: thetaPct(atmEntry?.put),
    speed,
    dte,
  };
}

// --- Helpers ---

function clampGreek(value: number, min: number, max: number): number {
  if (!isFinite(value) || isNaN(value)) return 0;
  return Math.min(Math.max(value, min), max);
}

// --- Exports for testing ---
export { normalCDF, normalPDF, calcD1D2 };
