// ============================================================
// MULTI-TIMEFRAME REGIME (master prompt Part 11)
// ============================================================
// Per timeframe, from: structure trend, VWAP slope (ATR units), ATR percentile, RVOL, CVD direction, price vs the
// value area. Classification, in order:
//   UNCERTAIN       structure unknown, or fewer than 2 of the 4 confirmations available
//   HIGH_VOLATILITY ATR percentile >= 80
//   STRONG_BULLISH  structure BULLISH and >= 2 of {VWAP slope > flat band, CVD rising, price above VAH (or above POC
//                   while RVOL >= 1), RVOL >= 1} agree, none contradicts the trend (a falling CVD / slope below −flat
//                   / price below VAL); STRONG_BEARISH mirror
//   LOW_VOLATILITY  ATR percentile <= 20
//   SIDEWAYS        otherwise
// Combination (daily, 30m, 15m, 5m): the 30-minute class is the regime; the 15-minute bias may not override it: a
// 15m strong trend against a 30m strong trend -> UNCERTAIN (lower timeframe conflicts with higher). Daily opposite
// to the 30m trend is recorded as COUNTER_DAILY and removes the strong label. 5m only confirms (never overrides).
// `allowed` is the direction(s) a setup may trade without a separately validated reversal setup.
// ============================================================

import { DHAN_ENGINE_RULES, type Side } from './common.js';

export type RegimeClass = 'STRONG_BULLISH' | 'STRONG_BEARISH' | 'SIDEWAYS' | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY' | 'UNCERTAIN';

export interface TimeframeInputs {
  structure: Side | 'RANGE' | 'UNKNOWN';
  vwapSlopeAtr: number | null;
  /** ATR's percentile (0..1) against its own recent history. */
  atrPercentile: number | null;
  rvol: number | null;
  cvdDirection: 'UP' | 'DOWN' | 'FLAT' | null;
  priceVsValue: 'ABOVE_VAH' | 'ABOVE_POC' | 'BELOW_POC' | 'BELOW_VAL' | null;
}

export interface TimeframeRegime {
  regime: RegimeClass;
  votes: { for: number; against: number; available: number };
}

export function classifyTimeframe(x: TimeframeInputs): TimeframeRegime {
  const flat = DHAN_ENGINE_RULES.vwapFlatAtr;
  const avail = [x.vwapSlopeAtr, x.cvdDirection, x.priceVsValue, x.rvol].filter((v) => v != null).length;
  const dir = x.structure === 'BULLISH' ? 1 : x.structure === 'BEARISH' ? -1 : 0;
  let pro = 0, con = 0;
  if (dir !== 0) {
    if (x.vwapSlopeAtr != null) { if (x.vwapSlopeAtr * dir > flat) pro++; else if (x.vwapSlopeAtr * dir < -flat) con++; }
    if (x.cvdDirection != null) { const c = x.cvdDirection === 'UP' ? 1 : x.cvdDirection === 'DOWN' ? -1 : 0; if (c === dir) pro++; else if (c === -dir) con++; }
    if (x.priceVsValue != null) {
      const v = x.priceVsValue;
      const strongWith = dir > 0 ? v === 'ABOVE_VAH' || (v === 'ABOVE_POC' && (x.rvol ?? 0) >= 1) : v === 'BELOW_VAL' || (v === 'BELOW_POC' && (x.rvol ?? 0) >= 1);
      const against = dir > 0 ? v === 'BELOW_VAL' : v === 'ABOVE_VAH';
      if (strongWith) pro++; else if (against) con++;
    }
    if (x.rvol != null && x.rvol >= 1) pro++;
  }
  const votes = { for: pro, against: con, available: avail };
  if (x.structure === 'UNKNOWN' || avail < 2) return { regime: 'UNCERTAIN', votes };
  if (x.atrPercentile != null && x.atrPercentile >= DHAN_ENGINE_RULES.highVolPct) return { regime: 'HIGH_VOLATILITY', votes };
  if (dir !== 0 && pro >= 2 && con === 0) return { regime: dir > 0 ? 'STRONG_BULLISH' : 'STRONG_BEARISH', votes };
  if (x.atrPercentile != null && x.atrPercentile <= DHAN_ENGINE_RULES.lowVolPct) return { regime: 'LOW_VOLATILITY', votes };
  return { regime: 'SIDEWAYS', votes };
}

export interface MtfRegime {
  regime: RegimeClass;
  allowed: Side[];
  notes: string[];
  frames: { daily: RegimeClass | null; m30: RegimeClass | null; m15: RegimeClass | null; m5: RegimeClass | null };
}

const sideOf = (r: RegimeClass | null): Side | null => (r === 'STRONG_BULLISH' ? 'BULLISH' : r === 'STRONG_BEARISH' ? 'BEARISH' : null);

export function combineRegime(f: { daily?: TimeframeInputs | null; m30?: TimeframeInputs | null; m15?: TimeframeInputs | null; m5?: TimeframeInputs | null }): MtfRegime {
  const c = (x?: TimeframeInputs | null) => (x ? classifyTimeframe(x).regime : null);
  const frames = { daily: c(f.daily), m30: c(f.m30), m15: c(f.m15), m5: c(f.m5) };
  const notes: string[] = [];
  if (frames.m30 == null) return { regime: 'UNCERTAIN', allowed: [], notes: ['NO_30M'], frames };
  let regime = frames.m30;
  const s30 = sideOf(regime), s15 = sideOf(frames.m15);
  if (s30 && s15 && s30 !== s15) return { regime: 'UNCERTAIN', allowed: [], notes: ['LOWER_TF_CONFLICT'], frames };
  const daily = f.daily?.structure;
  if (s30 && (daily === 'BULLISH' || daily === 'BEARISH') && daily !== s30) {
    notes.push('COUNTER_DAILY');
    regime = 'SIDEWAYS';
  }
  const s5 = sideOf(frames.m5);
  if (s30 && s5 && s5 !== s30) notes.push('5M_AGAINST');
  const allowed: Side[] = regime === 'STRONG_BULLISH' ? ['BULLISH'] : regime === 'STRONG_BEARISH' ? ['BEARISH'] : regime === 'UNCERTAIN' ? [] : (['BULLISH', 'BEARISH'] as Side[]).filter((d) => !s15 || d === s15);
  return { regime, allowed, notes, frames };
}
