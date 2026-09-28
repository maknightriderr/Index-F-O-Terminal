// ============================================================
// MARKET REGIME CLASSIFIER
// ============================================================
// classifyRegime was moved here verbatim from market-bias.ts so it can be
// tested without the engine's Redis/DB imports, and so the FAST_INTRADAY_REGIME
// fallback below can reuse its exact ADX bands (25 strong / 18 weak) by
// calling it, rather than restating the numbers.
//
// FAST_INTRADAY_REGIME (INTRADAY only). The 1H ADX needs hours to leave
// RANGE_BOUND once an intraday trend starts, and BREAKOUT/BREAKDOWN only lasts
// the single 15m bar the break happened on — so on 28 Sep CRUDEOIL's evening
// fall read RANGE_BOUND (a 0.9 confidence factor) long after the move was
// obvious on the 15m chart. Two additions, both pure and both recorded:
//
//   15M_FALLBACK      when the 1H read found no trend (RANGE_BOUND,
//                     LOW_VOLATILITY, HIGH_VOLATILITY — i.e. 1H ADX < 18),
//                     ADX(14) on the 15m candles already loaded is run through
//                     classifyRegime's own bands, with the direction from the
//                     (volume-confirmed) 15m Supertrend.
//   BREAKOUT_PERSIST  a volume-confirmed Bollinger break stays BREAKOUT /
//                     BREAKDOWN while every close since stays beyond the
//                     midline, for up to BREAKOUT_PERSIST_BARS 15m bars
//                     (untested default 4) instead of one bar.
//
// The leading regimes (expiry gamma, operator activity, a fresh breakout)
// keep priority over both, exactly as they do over the 1H ADX bands.
// ============================================================

import type { GammaExposureRegime, MarketRegime } from '@fno/shared';

// DTE<=1 with non-neutral GEX overrides the ADX/Supertrend trend read —
// dealer hedging flows into an imminent expiry can pin or whipsaw price in
// ways that have nothing to do with the underlying trend (a "strong" ADX
// reading into expiry is often just the pin/unwind, not a real trend), so
// this is checked first, ahead of the ADX bands below.
const EXPIRY_GAMMA_MAX_DTE = 1;

export function classifyRegime(
  adxValue: number,
  st1hDirection: 'UP' | 'DOWN',
  atrZ: number,
  dte: number | null,
  gexRegime: GammaExposureRegime | null,
  freshBreakoutUp: boolean,
  freshBreakoutDown: boolean,
  operatorActivityBullish: boolean,
  operatorActivityBearish: boolean
): MarketRegime {
  if (dte != null && dte <= EXPIRY_GAMMA_MAX_DTE && gexRegime != null && gexRegime !== 'NEUTRAL') {
    return 'EXPIRY_GAMMA';
  }
  // Real capital committed right now (futures OI buildup + an OI wall
  // actually under price pressure + PCR skew, all three agreeing) is a
  // stronger, more trustworthy leading signal than a pure price break —
  // a breakout can be a fakeout with no real positioning behind it, but
  // this requires informed/large participants to have actually acted.
  // Checked ahead of BREAKOUT/BREAKDOWN for that reason, still below
  // EXPIRY_GAMMA (a hard mechanical constraint that overrides everything
  // when dealer hedging can dominate regardless of positioning).
  if (operatorActivityBullish) return 'OPERATOR_ACCUMULATION';
  if (operatorActivityBearish) return 'OPERATOR_DISTRIBUTION';
  // A volume-confirmed break outside the Bollinger Bands on this bar is a
  // leading signal — it can fire well before ADX (a 14-period smoothed
  // average) has accumulated enough bars to call the same move a "strong
  // trend." Checked ahead of the ADX bands below for exactly that reason:
  // by the time ADX confirms, the leading part of the move is already over.
  if (freshBreakoutUp) return 'BREAKOUT';
  if (freshBreakoutDown) return 'BREAKDOWN';
  if (adxValue >= 25) return st1hDirection === 'UP' ? 'STRONG_BULL_TREND' : 'STRONG_BEAR_TREND';
  if (adxValue >= 18) return st1hDirection === 'UP' ? 'WEAK_BULL_TREND' : 'WEAK_BEAR_TREND';
  if (atrZ > 1) return 'HIGH_VOLATILITY';
  if (atrZ < -1) return 'LOW_VOLATILITY';
  return 'RANGE_BOUND';
}

/** Where a decision's regime came from. '1H' = classifyRegime as before. */
// MOMENTUM_BREAK: the momentum-break regime assist (flag MOMENTUM_BREAK) —
// a qualified trigger holds BREAKOUT/BREAKDOWN for BREAKOUT_PERSIST_BARS.
export type RegimeSource = '1H' | '15M_FALLBACK' | 'BREAKOUT_PERSIST' | 'MOMENTUM_BREAK';

const LEADING_REGIMES: ReadonlySet<MarketRegime> = new Set<MarketRegime>([
  'EXPIRY_GAMMA',
  'OPERATOR_ACCUMULATION',
  'OPERATOR_DISTRIBUTION',
  'BREAKOUT',
  'BREAKDOWN',
]);

/** What classifyRegime returns when its 1H ADX found no trend (ADX < 18). */
const NO_TREND_REGIMES: ReadonlySet<MarketRegime> = new Set<MarketRegime>(['RANGE_BOUND', 'LOW_VOLATILITY', 'HIGH_VOLATILITY']);

export interface PersistedBreakout {
  direction: 'UP' | 'DOWN';
  /** How many completed 15m bars ago the volume-confirmed break printed (1 = the previous bar). */
  barsAgo: number;
}

/**
 * The most recent volume-confirmed Bollinger break within the last
 * `maxBars - 1` COMPLETED bars (the forming bar is classifyRegime's own fresh
 * check), if every close since — the forming bar included — has stayed beyond
 * the midline on the break's side. Only the latest confirmed break is
 * considered; an older one is superseded by it.
 *
 * Band arrays are aligned to the END of `closes` (bollingerBands' output is
 * shorter by its period). A past bar's volume confirmation is that bar's own
 * volume against the average of the `volumeLookback` bars before it — the
 * same ratio and threshold the live check applies to the last completed bar.
 */
export function persistedBreakout(input: {
  closes: number[];
  volumes: number[];
  upper: number[];
  middle: number[];
  lower: number[];
  maxBars: number;
  volumeConfirmThreshold: number;
  volumeLookback?: number;
}): PersistedBreakout | null {
  const { closes, volumes, upper, middle, lower } = input;
  const lookback = input.volumeLookback ?? 20;
  const n = closes.length;
  const maxBack = Math.floor(input.maxBars) - 1;
  if (n < 2 || maxBack < 1) return null;

  // Band value `k` bars before the newest one, aligned from the end.
  const band = (arr: number[], k: number): number | undefined => arr[arr.length - 1 - k];
  const pctB = (k: number): number | null => {
    const close = closes[n - 1 - k];
    const up = band(upper, k);
    const lo = band(lower, k);
    if (close === undefined || up === undefined || lo === undefined || !(up > lo)) return null;
    return (close - lo) / (up - lo);
  };
  const volumeConfirmed = (k: number): boolean => {
    const i = n - 1 - k;
    const prior = volumes.slice(Math.max(0, i - lookback), i);
    if (prior.length === 0) return false;
    const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
    const v = volumes[i] ?? 0;
    return avg > 0 && v > 0 && v / avg >= input.volumeConfirmThreshold;
  };

  for (let k = 1; k <= maxBack; k++) {
    const now = pctB(k);
    const before = pctB(k + 1);
    if (now == null || before == null) continue;
    const up = now > 1 && before <= 1;
    const down = now < 0 && before >= 0;
    if (!up && !down) continue;
    // An unconfirmed band cross was never a BREAKOUT/BREAKDOWN regime; keep
    // looking for an older confirmed one (the midline check below still has
    // to hold across every bar since it).
    if (!volumeConfirmed(k)) continue;
    for (let j = k; j >= 0; j--) {
      const close = closes[n - 1 - j];
      const mid = band(middle, j);
      if (close === undefined || mid === undefined) return null;
      if (up ? !(close > mid) : !(close < mid)) return null;
    }
    return { direction: up ? 'UP' : 'DOWN', barsAgo: k };
  }
  return null;
}

/**
 * The FAST_INTRADAY_REGIME overlay on classifyRegime's result. Disabled (flag
 * off, or POSITIONAL mode) it returns the base regime with source '1H'.
 */
export function applyFastIntradayRegime(input: {
  enabled: boolean;
  baseRegime: MarketRegime;
  /** ADX(14) on the 15m candles; null when there weren't enough bars. */
  adx15m: number | null;
  /** The 15m Supertrend direction, flip-confirmed the same way the 1H one is. */
  st15Direction: 'UP' | 'DOWN';
  persisted: PersistedBreakout | null;
}): { regime: MarketRegime; source: RegimeSource } {
  const base = { regime: input.baseRegime, source: '1H' as RegimeSource };
  if (!input.enabled || LEADING_REGIMES.has(input.baseRegime)) return base;
  if (input.persisted) {
    return { regime: input.persisted.direction === 'UP' ? 'BREAKOUT' : 'BREAKDOWN', source: 'BREAKOUT_PERSIST' };
  }
  if (NO_TREND_REGIMES.has(input.baseRegime) && input.adx15m != null && Number.isFinite(input.adx15m)) {
    // classifyRegime itself, fed only the 15m ADX and direction, so the
    // strong/weak bands are exactly the 1H ones. Anything below 18 comes back
    // RANGE_BOUND, i.e. no 15m trend either — keep the 1H read.
    const trend = classifyRegime(input.adx15m, input.st15Direction, 0, null, null, false, false, false, false);
    if (trend !== 'RANGE_BOUND') return { regime: trend, source: '15M_FALLBACK' };
  }
  return base;
}
