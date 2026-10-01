// ============================================================
// FEATURE LIFT v2 (second pass): full battery + phi redundancy matrix
// ============================================================
// Replaces the reduced first-pass battery. Adds: true 1H trend/ADX (see
// context-1h.ts — a real resample, not the 15m-native EMA80/ADX56 proxy),
// BOS/CHoCH (market-structure), FVG created, displacement bar, candle-label
// rejection, distance to PDH/PDL (fade hypothesis), Supertrend(10,3), and
// day-of-week. Each feature is a boolean flag per bar per direction; label
// is the 2R-before-1R opportunity census. Lift + Wilson 95% CI, IS vs OOS,
// stability flag (same sign both sides). The phi/redundancy matrix is
// computed on the IS bars only (a description of feature structure, not an
// OOS performance claim) across the "LONG-family" flags (one boolean per
// bar: does this feature currently point long).
//
// NOT COMPUTED (disclosed): expiry day. No reliable historical weekly-expiry
// calendar exists in this codebase/dataset (NSE/BSE expiry-day rules changed
// more than once across 2023-2025 SEBI reforms, and option-chain data itself
// has no history before 2026-09-21 per the task brief) — guessing a
// day-of-week proxy for "expiry" would be more likely wrong than useful, so
// it is left out rather than fabricated. Day-of-week itself (Mon-Fri, not
// expiry-specific) IS computed below.
// Per-15-minute-slot lift is also not hypothesis-tested here (35+ slots x 2
// directions x 2 R-multiples would be ~140 comparisons on top of the ~40
// already run — see the multiple-testing note in the report) — the
// descriptive per-slot base rate from the opportunity census is used
// instead for the time-of-day question.
// ============================================================

import { analyzeMarketStructure, classifyCandleShape, slotVolumeBaseline } from '@fno/analytics';
import type { LoadedSymbol } from '../backtest/harness.js';
import type { SymbolContext } from './context.js';
import { build1hContext, trueTrendAt, trueAdxAt, type OneHourContext } from './context-1h.js';
import { buildOppBars, type OppBar } from './opportunity-census.js';
import { wilson95, round, phi } from './stats.js';

interface Bundle { symbol: string; loaded: LoadedSymbol; ctx: SymbolContext }

const SWING_WINDOW = 120;

function bosChochFlags(loaded: LoadedSymbol, i: number): { bosBull: boolean; bosBear: boolean; chochBull: boolean; chochBear: boolean } {
  const bars = loaded.series.bars;
  const from = Math.max(0, i - SWING_WINDOW);
  const window = bars.slice(from, i + 1);
  const { lastEvent } = analyzeMarketStructure(window.map((b) => b.high), window.map((b) => b.low));
  const flags = { bosBull: false, bosBear: false, chochBull: false, chochBear: false };
  if (!lastEvent) return flags;
  // Only count it "live" if it fired at (or very near) the current bar — otherwise it's stale history, not a feature of bar i.
  if (lastEvent.atIndex < window.length - 3) return flags;
  if (lastEvent.type === 'BOS' && lastEvent.direction === 'BULLISH') flags.bosBull = true;
  if (lastEvent.type === 'BOS' && lastEvent.direction === 'BEARISH') flags.bosBear = true;
  if (lastEvent.type === 'CHOCH' && lastEvent.direction === 'BULLISH') flags.chochBull = true;
  if (lastEvent.type === 'CHOCH' && lastEvent.direction === 'BEARISH') flags.chochBear = true;
  return flags;
}

function fvgFlags(loaded: LoadedSymbol, i: number): { bull: boolean; bear: boolean } {
  const bars = loaded.series.bars;
  if (i < 2) return { bull: false, bear: false };
  const a = bars[i - 2], c = bars[i];
  return { bull: a.high < c.low, bear: a.low > c.high };
}

function displacementFlags(loaded: LoadedSymbol, ctx: SymbolContext, i: number): { bull: boolean; bear: boolean } {
  const atr = ctx.atr14[i];
  if (!atr) return { bull: false, bear: false };
  const bar = loaded.series.bars[i];
  const body = Math.abs(bar.close - bar.open);
  const bull = bar.close > bar.open && body >= 1.0 * atr;
  const bear = bar.close < bar.open && body >= 1.0 * atr;
  return { bull, bear };
}

function candleRejectionFlags(loaded: LoadedSymbol, i: number): { bull: boolean; bear: boolean } {
  const bar = loaded.series.bars[i];
  const c = { open: bar.open, high: bar.high, low: bar.low, close: bar.close };
  const bullShape = classifyCandleShape(c, true); // can only be HAMMER | PIN_BAR | REJECTION
  const bearShape = classifyCandleShape(c, false); // can only be SHOOTING_STAR | PIN_BAR | REJECTION
  return { bull: bullShape === 'HAMMER' || bullShape === 'PIN_BAR', bear: bearShape === 'SHOOTING_STAR' || bearShape === 'PIN_BAR' };
}

function pdLevels(loaded: LoadedSymbol, i: number, atr: number): { nearPdh: boolean; nearPdl: boolean } {
  // Cheap inline PDH/PDL (avoids the heavier buildMomentumLevels level scan in the hot loop).
  const { series } = loaded;
  const s = series.sessionIdx[i];
  if (s === 0) return { nearPdh: false, nearPdl: false };
  const pStart = series.sessionStarts[s - 1];
  const start = series.sessionStarts[s];
  let hi = -Infinity, lo = Infinity;
  for (let j = pStart; j < start; j++) { hi = Math.max(hi, series.bars[j].high); lo = Math.min(lo, series.bars[j].low); }
  const close = series.bars[i].close;
  return { nearPdh: Math.abs(close - hi) <= 0.5 * atr, nearPdl: Math.abs(close - lo) <= 0.5 * atr };
}

interface Cell { n: number; hits: number }
function bump(c: Cell, hit: boolean) { c.n++; if (hit) c.hits++; }
function newCell(): Cell { return { n: 0, hits: 0 }; }

export function runFeatureLiftV2(bundles: Bundle[], splitAt: string) {
  const ctx1hBySymbol = new Map<string, OneHourContext>();
  for (const b of bundles) ctx1hBySymbol.set(b.symbol, build1hContext(b.loaded));

  const defs = [
    'sweep', 'vwapSide', 'trend1h', 'adx1h', 'rsi', 'volRatio', 'atrPctl',
    'supertrend', 'bos', 'choch', 'fvg', 'displacement', 'candleRejection', 'pdLevel',
    'dowMon', 'dowTue', 'dowWed', 'dowThu', 'dowFri',
  ] as const;
  type Key = (typeof defs)[number];
  const counters: Record<Key, { isLong: Cell; isShort: Cell; oosLong: Cell; oosShort: Cell }> = Object.fromEntries(
    defs.map((k) => [k, { isLong: newCell(), isShort: newCell(), oosLong: newCell(), oosShort: newCell() }])
  ) as any;

  // For the phi matrix: IS-only boolean flag arrays for the "long-family" reading of each feature.
  const longFlagSeries: Record<Key, boolean[]> = Object.fromEntries(defs.map((k) => [k, [] as boolean[]])) as any;

  let isLongN = 0, isLongHits = 0, isShortN = 0, isShortHits = 0;
  let oosLongN = 0, oosLongHits = 0, oosShortN = 0, oosShortHits = 0;

  for (const b of bundles) {
    const ctx1h = ctx1hBySymbol.get(b.symbol)!;
    const oppBars = buildOppBars(b.loaded, b.loaded.barMs ?? 15 * 60 * 1000);
    const oppByIndex = new Map(oppBars.map((o) => [o.index, o]));
    const { series } = b.loaded;
    for (let i = 5; i < series.bars.length - 1; i++) {
      const opp = oppByIndex.get(i);
      if (!opp) continue;
      const session = series.sessionDates[series.sessionIdx[i]];
      const isIS = session < splitAt;
      if (isIS) { isLongN++; if (opp.long2R) isLongHits++; isShortN++; if (opp.short2R) isShortHits++; }
      else { oosLongN++; if (opp.long2R) oosLongHits++; oosShortN++; if (opp.short2R) oosShortHits++; }

      const atr = b.ctx.atr14[i];
      const pick = (k: Key) => (isIS ? counters[k].isLong : counters[k].oosLong);
      const pickS = (k: Key) => (isIS ? counters[k].isShort : counters[k].oosShort);

      // sweep in last 3 bars (reuse the first-pass simple definition)
      let sweepUp = false, sweepDown = false;
      for (let j = Math.max(10, i - 2); j <= i; j++) {
        if (j - 10 < 0) continue;
        const lb = series.bars.slice(j - 10, j);
        const priorLow = Math.min(...lb.map((x) => x.low));
        const priorHigh = Math.max(...lb.map((x) => x.high));
        if (series.bars[j].low < priorLow && series.bars[j].close > priorLow) sweepUp = true;
        if (series.bars[j].high > priorHigh && series.bars[j].close < priorHigh) sweepDown = true;
      }
      if (sweepUp) bump(pick('sweep'), opp.long2R);
      if (sweepDown) bump(pickS('sweep'), opp.short2R);
      if (isIS) longFlagSeries.sweep.push(sweepUp);

      // VWAP side
      let vwap: number | null = null;
      { const s = series.sessionIdx[i]; const start = series.sessionStarts[s]; let pv = 0, v = 0; for (let j = start; j < i; j++) { pv += ((series.bars[j].high + series.bars[j].low + series.bars[j].close) / 3) * series.bars[j].volume; v += series.bars[j].volume; } vwap = v > 0 ? pv / v : null; }
      const aboveVwap = vwap != null && series.bars[i].close > vwap;
      if (vwap != null) { if (aboveVwap) bump(pick('vwapSide'), opp.long2R); else bump(pickS('vwapSide'), opp.short2R); }
      if (isIS) longFlagSeries.vwapSide.push(aboveVwap);

      // true 1H trend
      const trend = trueTrendAt(b.loaded, ctx1h, i);
      if (trend === 'BULLISH') bump(pick('trend1h'), opp.long2R);
      if (trend === 'BEARISH') bump(pickS('trend1h'), opp.short2R);
      if (isIS) longFlagSeries.trend1h.push(trend === 'BULLISH');

      // true 1H ADX regime (trending = >=20; tested as an undirected "is a move more likely at all" hypothesis)
      const adxNow = trueAdxAt(ctx1h, i);
      const trending = adxNow != null && adxNow >= 20;
      if (trending) { bump(pick('adx1h'), opp.long2R); bump(pickS('adx1h'), opp.short2R); }
      if (isIS) longFlagSeries.adx1h.push(trending);

      // RSI overbought/oversold (native 15m)
      const rsiNow = b.ctx.rsi14[i];
      const oversold = Number.isFinite(rsiNow) && rsiNow <= 30;
      const overbought = Number.isFinite(rsiNow) && rsiNow >= 70;
      if (oversold) bump(pick('rsi'), opp.long2R);
      if (overbought) bump(pickS('rsi'), opp.short2R);
      if (isIS) longFlagSeries.rsi.push(oversold);

      // volume ratio vs time-of-day median (undirected: high volume raises odds of a big move either way)
      const { median, samples } = slotVolumeBaseline(series, i);
      const highVolRatio = median != null && samples >= 5 && series.bars[i].volume > 1.5 * median;
      if (highVolRatio) { bump(pick('volRatio'), opp.long2R); bump(pickS('volRatio'), opp.short2R); }
      if (isIS) longFlagSeries.volRatio.push(highVolRatio);

      // ATR percentile (volatility regime)
      const atrPctl = b.ctx.atrPercentile[i];
      const highVol = Number.isFinite(atrPctl) && atrPctl >= 80;
      if (highVol) { bump(pick('atrPctl'), opp.long2R); bump(pickS('atrPctl'), opp.short2R); }
      if (isIS) longFlagSeries.atrPctl.push(highVol);

      // Supertrend
      const st = b.ctx.supertrendDir[i];
      if (st === 'UP') bump(pick('supertrend'), opp.long2R);
      if (st === 'DOWN') bump(pickS('supertrend'), opp.short2R);
      if (isIS) longFlagSeries.supertrend.push(st === 'UP');

      // BOS/CHoCH
      const bc = bosChochFlags(b.loaded, i);
      if (bc.bosBull) bump(pick('bos'), opp.long2R);
      if (bc.bosBear) bump(pickS('bos'), opp.short2R);
      if (bc.chochBull) bump(pick('choch'), opp.long2R);
      if (bc.chochBear) bump(pickS('choch'), opp.short2R);
      if (isIS) { longFlagSeries.bos.push(bc.bosBull); longFlagSeries.choch.push(bc.chochBull); }

      // FVG
      const fvg = fvgFlags(b.loaded, i);
      if (fvg.bull) bump(pick('fvg'), opp.long2R);
      if (fvg.bear) bump(pickS('fvg'), opp.short2R);
      if (isIS) longFlagSeries.fvg.push(fvg.bull);

      // displacement
      if (atr) {
        const disp = displacementFlags(b.loaded, b.ctx, i);
        if (disp.bull) bump(pick('displacement'), opp.long2R);
        if (disp.bear) bump(pickS('displacement'), opp.short2R);
        if (isIS) longFlagSeries.displacement.push(disp.bull);
      } else if (isIS) longFlagSeries.displacement.push(false);

      // candle rejection
      const cr = candleRejectionFlags(b.loaded, i);
      if (cr.bull) bump(pick('candleRejection'), opp.long2R);
      if (cr.bear) bump(pickS('candleRejection'), opp.short2R);
      if (isIS) longFlagSeries.candleRejection.push(cr.bull);

      // distance to PDH/PDL (fade hypothesis: near PDH -> short, near PDL -> long)
      if (atr) {
        const pd = pdLevels(b.loaded, i, atr);
        if (pd.nearPdl) bump(pick('pdLevel'), opp.long2R);
        if (pd.nearPdh) bump(pickS('pdLevel'), opp.short2R);
        if (isIS) longFlagSeries.pdLevel.push(pd.nearPdl);
      } else if (isIS) longFlagSeries.pdLevel.push(false);

      // day of week
      const dow = new Date(series.bars[i].time + 330 * 60000).getUTCDay(); // 0=Sun..6=Sat, IST-shifted
      const dowKeys: Record<number, Key | null> = { 1: 'dowMon', 2: 'dowTue', 3: 'dowWed', 4: 'dowThu', 5: 'dowFri' };
      const dk = dowKeys[dow];
      for (const k of ['dowMon', 'dowTue', 'dowWed', 'dowThu', 'dowFri'] as Key[]) {
        const active = k === dk;
        if (active) { bump(pick(k), opp.long2R); bump(pickS(k), opp.short2R); }
        if (isIS) longFlagSeries[k].push(active);
      }
    }
  }

  const baseIS_long = isLongN ? isLongHits / isLongN : 0;
  const baseOOS_long = oosLongN ? oosLongHits / oosLongN : 0;
  const baseIS_short = isShortN ? isShortHits / isShortN : 0;
  const baseOOS_short = oosShortN ? oosShortHits / oosShortN : 0;

  const makeCellReport = (c: Cell, base: number) => {
    const precision = c.n ? c.hits / c.n : null;
    const w = wilson95(c.hits, c.n);
    return { n: c.n, hits: c.hits, lift: precision != null && base > 0 ? round(precision / base, 3) : null, wilson: { lo: round(w.lo, 3), hi: round(w.hi, 3) }, lowN: c.n < 30 };
  };

  const features = defs.map((k) => {
    const c = counters[k];
    const isRep = { long: makeCellReport(c.isLong, baseIS_long), short: makeCellReport(c.isShort, baseIS_short) };
    const oosRep = { long: makeCellReport(c.oosLong, baseOOS_long), short: makeCellReport(c.oosShort, baseOOS_short) };
    const stableLong = isRep.long.lift != null && oosRep.long.lift != null && (isRep.long.lift - 1) * (oosRep.long.lift - 1) > 0;
    const stableShort = isRep.short.lift != null && oosRep.short.lift != null && (isRep.short.lift - 1) * (oosRep.short.lift - 1) > 0;
    return { feature: k, is: isRep, oos: oosRep, stableLong, stableShort };
  });

  // Phi matrix among the long-family flags (IS only, descriptive)
  const flagKeys = defs;
  const n = longFlagSeries[flagKeys[0]]?.length ?? 0;
  const phiMatrix: Array<{ a: string; b: string; phi: number }> = [];
  for (let x = 0; x < flagKeys.length; x++) {
    for (let y = x + 1; y < flagKeys.length; y++) {
      const A = longFlagSeries[flagKeys[x]], B = longFlagSeries[flagKeys[y]];
      const len = Math.min(A.length, B.length);
      let a = 0, bC = 0, c = 0, d = 0;
      for (let i = 0; i < len; i++) {
        if (A[i] && B[i]) a++; else if (A[i] && !B[i]) bC++; else if (!A[i] && B[i]) c++; else d++;
      }
      const p = phi(a, bC, c, d);
      if (Math.abs(p) > 0.6) phiMatrix.push({ a: flagKeys[x], b: flagKeys[y], phi: round(p, 3) });
    }
  }

  return {
    baseRates: { isLong: round(baseIS_long, 4), oosLong: round(baseOOS_long, 4), isShort: round(baseIS_short, 4), oosShort: round(baseOOS_short, 4) },
    features,
    highOverlapPairs: phiMatrix,
    testedCells: features.length * 2, // long + short per feature, roughly (dow features only contribute meaningfully one side each but counted both for uniformity)
    notComputed: ['expiry day (no reliable historical expiry calendar in this dataset)', 'per-15-minute-slot hypothesis-tested lift (descriptive base-rate-by-slot used instead, see opportunity census)'],
  };
}
