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
import type { Greeks, OptionType } from '@fno/shared';

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
 * Calculate implied volatility using Newton-Raphson method.
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

  // Initial guess
  let sigma = 0.3; // 30%

  for (let i = 0; i < maxIterations; i++) {
    const price = blackScholesPrice({
      spotPrice, strikePrice, timeToExpiry,
      riskFreeRate, iv: sigma, optionType,
    });

    const diff = price - marketPrice;

    if (Math.abs(diff) < tolerance) {
      return sigma;
    }

    // Vega for Newton-Raphson step
    const { d1 } = calcD1D2(spotPrice, strikePrice, timeToExpiry, riskFreeRate, sigma);
    const vega = spotPrice * Math.sqrt(timeToExpiry) * normalPDF(d1);

    if (vega < 1e-10) break; // Avoid division by zero

    sigma -= diff / vega;

    // Keep sigma in reasonable bounds
    if (sigma < 0.001) sigma = 0.001;
    if (sigma > 5.0) sigma = 5.0; // 500% IV cap
  }

  return Math.max(0, sigma);
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

  return calculateGreeks({
    spotPrice, strikePrice: strikePrice, timeToExpiry,
    riskFreeRate, iv, optionType,
  });
}

// --- Helpers ---

function clampGreek(value: number, min: number, max: number): number {
  if (!isFinite(value) || isNaN(value)) return 0;
  return Math.min(Math.max(value, min), max);
}

// --- Exports for testing ---
export { normalCDF, normalPDF, calcD1D2 };
