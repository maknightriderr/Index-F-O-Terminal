// ============================================================
// DHAN ENGINE v2 — shared vocabulary (pure)
// ============================================================
// Every value an engine returns carries a status, so an estimate is never shown
// as exchange truth and a missing input is never shown as zero:
//   VERIFIED       exchange-published (price, cumulative volume, OI)
//   ESTIMATED      built from inferred aggressor sides (delta, CVD, imbalances, absorption)
//   APPROXIMATION  computed from candles where the definition wants trades (candle VWAP)
//   INCOMPLETE     the interval had too much unreconciled volume / a data gap: withheld
//   UNAVAILABLE    not enough input to compute
// All thresholds are the master prompt's initial research values, configurable,
// versioned here, and claimed to be nothing more.
// ============================================================

export const DHAN_ENGINE_VERSION = 'DHAN-ENG-2.0';

export type EngineStatus = 'VERIFIED' | 'ESTIMATED' | 'APPROXIMATION' | 'INCOMPLETE' | 'UNAVAILABLE';
export type Side = 'BULLISH' | 'BEARISH';

export interface EngineBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export const DHAN_ENGINE_RULES = Object.freeze({
  /** 5.1 diagonal imbalance ratio (300%). */
  diagonalRatio: 3,
  /** 5.2 stacked imbalance: consecutive qualifying rows. */
  stackedMin: 3,
  /** Default min-volume filter when the instrument has none: this share of the bar's average row volume (and >= 1 lot). */
  minLevelShare: 0.25,
  /** Part 6: pivots need this many bars each side. */
  pivotLeft: 2,
  pivotRight: 2,
  /** Part 6: a BOS close must clear the level by this many ticks. */
  bosTickBuffer: 2,
  /** Part 6: a sweep / failed breakout must resolve back inside within this many bars. */
  sweepMaxBars: 2,
  failedBreakoutBars: 3,
  /** Part 7: value area share. */
  valueAreaFrac: 0.7,
  /** HVN / LVN: share of the mean row volume (after 3-row smoothing). */
  hvnMult: 1.5,
  lvnMult: 0.5,
  /** 5.3 absorption. */
  absorptionBaselineObs: 50,
  absorptionPercentile: 0.8,
  absorptionMaxProgressAtr: 0.25,
  absorptionNearAtr: 0.5,
  absorptionConfirmBars: 3,
  absorptionMinSideShare: 0.5,
  /** 5.4 exhaustion: extreme-row volume at or below this share of the bar's average row volume. */
  exhaustionThinShare: 0.3,
  exhaustionLookback: 6,
  exhaustionConfirmBars: 3,
  /** 8.2 relative volume. */
  rvolSessions: 20,
  rvolBreakout: 1.5,
  /** 4.3 rolling CVD and delta momentum windows (bars). */
  cvdRollingBars: 12,
  cvdMomentumBars: 3,
  /** 8.1 VWAP slope window (bars) and the ATR-normalised flat band. */
  vwapSlopeBars: 6,
  vwapFlatAtr: 0.1,
  /** Part 11: ATR-percentile volatility bands. */
  highVolPct: 0.8,
  lowVolPct: 0.2,
});

/** Linear-interpolated quantile of finite values (q in 0..1); null when empty. */
export function quantile(values: readonly number[], q: number): number | null {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export const roundDp = (x: number, dp = 6) => Math.round(x * 10 ** dp) / 10 ** dp;

/** Same row arithmetic as the footprint (order-flow/index.ts bucket). */
export const rowOf = (price: number, step: number) => roundDp(Math.round(price / step) * step);
