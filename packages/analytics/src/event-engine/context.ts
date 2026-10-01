// ============================================================
// EVENT ENGINE — series context and market state
// ============================================================
// Cached per-series reads every detector and trigger shares: ATR (bars
// before i), EMA20 of closes (bars <= i), the average session range of the
// previous 20 sessions, the canonical liquidity pools (bars before i, the
// same builder the structure engine uses), and the market state at i.
//
// Every threshold below is fixed in advance from conventional values and
// written down here; none was fitted to outcomes. Changing one is a new
// rule version.
// ============================================================

import { momentumAtrAt, type MomentumBar, type MomentumSeries } from '../momentum-break/index.js';
import { buildLiquidityPools, STRUCTURE_RULES, type LiquidityPool } from '../structure-engine/index.js';
import { buildResearchOnlyPools, type BasePool, type ResearchOnlyPoolKind } from '../liquidity-map/index.js';
import type { MarketState } from './types.js';

export const EVENT_RULES = {
  /** Trend: EMA20 slope over 5 bars ≥ 0.5 ATR and ≥ 8 of the last 10 closes on that side of the EMA. */
  emaPeriod: 20,
  slopeBars: 5,
  persistenceBars: 10,
  trendSlopeAtr: 0.5,
  trendPersistence: 8,
  /** Compression: the last 6 bars span ≤ 1.5 ATR and none is wider than 1 ATR. */
  compressionBars: 6,
  compressionRangeAtr: 1.5,
  compressionBarMaxAtr: 1.0,
  /** A compression box resolves within 8 bars or expires. */
  compressionExpiryBars: 8,
  /** Expansion: one bar ≥ 1.8 ATR, or the mean true range of the last 5 bars ≥ 1.6 ATR. */
  expansionBarAtr: 1.8,
  burstBars: 5,
  burstRatio: 1.6,
  burstRearmRatio: 1.2,
  /** Exhaustion: trending and the close ≥ 2.5 ATR from EMA20. */
  exhaustionAtr: 2.5,
  /** Reversal: the EMA slope 10 bars ago was a trend (≥ 0.5 ATR) and the slope now points the other way by ≥ 0.3 ATR. */
  reversalLookbackBars: 10,
  reversalSlopeAtr: 0.3,
  /** Radar: price within 0.5 ATR of an untaken pool (the structure engine's own WATCH distance). */
  liquidityNearAtr: STRUCTURE_RULES.watchWithinAtr,
  /** A break closes ≥ 0.1 ATR beyond the level. */
  breakMinAtr: 0.1,
  /** Acceptance: the 2 closes after the break stay beyond the level. */
  acceptanceBars: 2,
  /** A retest comes within 0.25 ATR of the level within 8 bars. */
  retestWithinBars: 8,
  retestTolAtr: 0.25,
  /** Pullback inside a trend: ≥ 0.75 ATR off the 10-bar extreme, close no more than 0.5 ATR through EMA20. */
  pullbackAtr: 0.75,
  pullbackLookbackBars: 10,
  pullbackEmaTolAtr: 0.5,
  /** Trend acceleration: 3 closes in a row in the trend's direction covering ≥ 1.5 ATR. */
  accelerationBars: 3,
  accelerationAtr: 1.5,
  /** Gap: the session's first open ≥ 1 ATR(15m) from the previous close. */
  gapAtr: 1.0,
  /** Abnormal move: the session has moved ≥ 1 average session range from its open. */
  abnormalAdr: 1.0,
  adrSessions: 20,
  /** Opening range: the first 30 minutes. */
  openingRangeMinutes: STRUCTURE_RULES.openingRangeMinutes,
  /** Displacement uses the live engine's own definition at DISP_MULT 1.0. */
  displacementMult: 1.0,
  /** Stops sit this far beyond their reference extreme (the engine's own buffer). */
  stopBufferAtr: STRUCTURE_RULES.stopBufferAtr,
  /** T1 must be ≥ this many R (the engine's own floor). */
  minT1R: STRUCTURE_RULES.minT1R,
} as const;

export const BAR_MS_15M = 15 * 60 * 1000;

export interface SeriesContext {
  series: MomentumSeries;
  barMs: number;
  /** Wilder ATR14 from bars before i. */
  atrAt(i: number): number | null;
  /** EMA20 of closes, bars <= i. */
  ema: number[];
  /** Mean session range of the previous 20 sessions (sessions before s). */
  adrAt(s: number): number | null;
  /** Last bar index of session s. */
  sessionEnd(s: number): number;
  /** Tradeable pools from bars before i, with the ATR they were built on (findSweep's poolsAt shape). */
  poolsAt(s: number, i: number): { atr: number; pools: LiquidityPool[] } | null;
  /** Research-only pools (previous close, week/month H/L) from bars before i. */
  researchPoolsAt(s: number, i: number): BasePool<ResearchOnlyPoolKind>[];
  /** Market state at bar i's close. */
  stateAt(i: number): MarketState;
}

const trueRange = (bars: readonly MomentumBar[], k: number) => {
  const b = bars[k];
  const pc = k > 0 ? bars[k - 1].close : b.close;
  return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
};

export function buildSeriesContext(series: MomentumSeries, barMs: number = BAR_MS_15M): SeriesContext {
  const { bars } = series;
  const atrCache = new Map<number, number | null>();
  const poolCache = new Map<number, { atr: number; pools: LiquidityPool[] } | null>();
  const researchCache = new Map<number, BasePool<ResearchOnlyPoolKind>[]>();
  const stateCache = new Map<number, MarketState>();

  const ema: number[] = new Array(bars.length);
  const k = 2 / (EVENT_RULES.emaPeriod + 1);
  for (let i = 0; i < bars.length; i++) ema[i] = i === 0 ? bars[0].close : bars[i].close * k + ema[i - 1] * (1 - k);

  const sessionRanges: number[] = series.sessionStarts.map((start, s) => {
    const end = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : bars.length) - 1;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = start; j <= end; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    return hi - lo;
  });

  const ctx: SeriesContext = {
    series,
    barMs,
    ema,
    atrAt(i) {
      if (!atrCache.has(i)) atrCache.set(i, momentumAtrAt(series, i));
      return atrCache.get(i)!;
    },
    adrAt(s) {
      const from = s - EVENT_RULES.adrSessions;
      if (from < 0) return null;
      let sum = 0;
      for (let x = from; x < s; x++) sum += sessionRanges[x];
      return sum / EVENT_RULES.adrSessions;
    },
    sessionEnd(s) {
      return (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : bars.length) - 1;
    },
    poolsAt(s, i) {
      if (!poolCache.has(i)) {
        const atr = ctx.atrAt(i);
        poolCache.set(i, atr != null ? { atr, pools: buildLiquidityPools(series, s, i, atr, STRUCTURE_RULES) } : null);
      }
      return poolCache.get(i)!;
    },
    researchPoolsAt(s, i) {
      if (!researchCache.has(i)) researchCache.set(i, buildResearchOnlyPools(series, s, i));
      return researchCache.get(i)!;
    },
    stateAt(i) {
      if (!stateCache.has(i)) stateCache.set(i, marketStateAt(ctx, i));
      return stateCache.get(i)!;
    },
  };
  return ctx;
}

/**
 * The environment at bar i's close, first match wins:
 * EXPANSION > EXHAUSTION > REVERSAL > TRENDING_UP/DOWN > COMPRESSION > BALANCED.
 * Context only: a state is never a trade and never a gate.
 */
export function marketStateAt(ctx: SeriesContext, i: number): MarketState {
  const { bars } = ctx.series;
  const R = EVENT_RULES;
  const atr = ctx.atrAt(i);
  if (atr == null || i < R.persistenceBars) return 'BALANCED';
  const b = bars[i];

  if (b.high - b.low >= R.expansionBarAtr * atr) return 'EXPANSION';
  let trSum = 0;
  for (let k = i - R.burstBars + 1; k <= i; k++) trSum += trueRange(bars, k);
  if (trSum / R.burstBars >= R.burstRatio * atr) return 'EXPANSION';

  const slope = i >= R.slopeBars ? (ctx.ema[i] - ctx.ema[i - R.slopeBars]) / atr : 0;
  let above = 0;
  for (let k = i - R.persistenceBars + 1; k <= i; k++) if (bars[k].close > ctx.ema[k]) above++;
  const below = R.persistenceBars - above;
  const trendUp = slope >= R.trendSlopeAtr && above >= R.trendPersistence;
  const trendDown = slope <= -R.trendSlopeAtr && below >= R.trendPersistence;
  const dist = (b.close - ctx.ema[i]) / atr;
  if ((trendUp && dist >= R.exhaustionAtr) || (trendDown && dist <= -R.exhaustionAtr)) return 'EXHAUSTION';

  const back = i - R.reversalLookbackBars;
  if (back >= R.slopeBars) {
    const prevSlope = (ctx.ema[back] - ctx.ema[back - R.slopeBars]) / atr;
    if (Math.abs(prevSlope) >= R.trendSlopeAtr && Math.sign(prevSlope) !== Math.sign(slope) && Math.abs(slope) >= R.reversalSlopeAtr) return 'REVERSAL';
  }
  if (trendUp) return 'TRENDING_UP';
  if (trendDown) return 'TRENDING_DOWN';

  let hi = -Infinity;
  let lo = Infinity;
  for (let k = i - R.compressionBars + 1; k <= i; k++) {
    hi = Math.max(hi, bars[k].high);
    lo = Math.min(lo, bars[k].low);
  }
  if (hi - lo <= R.compressionRangeAtr * atr) return 'COMPRESSION';
  return 'BALANCED';
}
