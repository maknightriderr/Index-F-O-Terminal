// ============================================================
// HISTORICAL (REALIZED) VOLATILITY
// ============================================================
// Close-to-close log-return volatility, annualized to the same
// percentage convention as IV — so the two are directly comparable.
// IV Rank (elsewhere in this codebase) says whether options are
// expensive relative to their OWN history; this says whether
// they're expensive relative to what the underlying actually does.
// IV > HV: options priced richer than realized movement — favors
// selling premium. IV < HV: options priced cheaper than realized
// movement — favors buying.
// ============================================================

export const TRADING_DAYS_PER_YEAR = 252;
// NSE cash/derivatives session is 09:15-15:30 = 6.25 hours.
export const TRADING_HOURS_PER_DAY = 6.25;
export const HOURLY_BARS_PER_YEAR = TRADING_DAYS_PER_YEAR * TRADING_HOURS_PER_DAY;

/**
 * Annualized historical volatility (%) from the last `period` closes' log
 * returns, scaled by `barsPerYear` — the number of bars-per-year MUST
 * match the actual granularity of `closes` (252 for daily bars, ~1575 for
 * 1H bars) or the annualization is wrong. Defaults to daily. Returns null
 * when there isn't enough history — never a misleading 0, which would look
 * like "no volatility at all."
 */
export function calculateHistoricalVolatility(closes: number[], period: number = 20, barsPerYear: number = TRADING_DAYS_PER_YEAR): number | null {
  if (closes.length < period + 1) return null;

  const recent = closes.slice(-(period + 1));
  const logReturns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1] <= 0 || recent[i] <= 0) continue; // guard against bad upstream data (zero/negative close)
    logReturns.push(Math.log(recent[i] / recent[i - 1]));
  }
  if (logReturns.length < 2) return null;

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (logReturns.length - 1); // sample variance (n-1)
  const barStdDev = Math.sqrt(variance);
  const annualizedPct = barStdDev * Math.sqrt(barsPerYear) * 100;

  return Math.round(annualizedPct * 100) / 100;
}

export type IvVsHvReading = 'RICH' | 'CHEAP' | 'FAIR';

/** How far apart IV and HV are, as a fraction of HV — the basis for the RICH/CHEAP/FAIR read below. */
const IV_HV_FAIR_BAND_PCT = 15; // within +-15% of HV counts as roughly fairly priced, not a real edge either way

export function compareIvToHv(atmIvPct: number, hvPct: number | null): { reading: IvVsHvReading; spreadPct: number | null } {
  if (hvPct == null || hvPct <= 0) return { reading: 'FAIR', spreadPct: null };
  const spreadPct = Math.round(((atmIvPct - hvPct) / hvPct) * 10000) / 100;
  const reading: IvVsHvReading = spreadPct > IV_HV_FAIR_BAND_PCT ? 'RICH' : spreadPct < -IV_HV_FAIR_BAND_PCT ? 'CHEAP' : 'FAIR';
  return { reading, spreadPct };
}
