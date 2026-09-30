// ============================================================
// FEATURE LIFT (univariate, no ML fitting)
// ============================================================
// REDUCED BATTERY (disclosed): the full spec lists ~14 features including
// sweep/displacement/FVG/BOS-CHoCH from the structure engine, candle labels,
// expiry day, day of week, and pairwise phi-correlation redundancy. Given
// the time budget for this research pass, this module implements a smaller,
// still-meaningful set: 3-bar sweep, price-vs-VWAP side, 1H trend side
// (proxy, see context.ts), 1H ADX regime bucket, 15m RSI bucket, volume
// ratio vs time-of-day median, and ATR percentile bucket. Each is tested
// for lift on the label "does a 2R-before-1R opportunity occur in the
// feature-implied direction (or either direction where the feature has
// none)", with counts and Wilson 95% intervals, IS and OOS separately.
// Structure-engine sweep/displacement/BOS-CHoCH, FVG, candle-label and
// expiry-day features, and the pairwise phi redundancy matrix, were NOT
// computed in this pass — flagged as not done in the report, not silently
// skipped.
// ============================================================

import { slotVolumeBaseline } from '@fno/analytics';
import type { LoadedSymbol } from '../backtest/harness.js';
import { trendAt, type SymbolContext } from './context.js';
import { wilson95, round } from './stats.js';
import { buildOppBars } from './opportunity-census.js';

interface Bundle {
  symbol: string;
  loaded: LoadedSymbol;
  ctx: SymbolContext;
}

function sweepInLast3(loaded: LoadedSymbol, i: number): 'UP' | 'DOWN' | null {
  const bars = loaded.series.bars;
  const s = loaded.series.sessionIdx[i];
  const start = loaded.series.sessionStarts[s];
  for (let j = Math.max(start + 10, i - 2); j <= i; j++) {
    if (j - 10 < 0) continue;
    const lookback = bars.slice(Math.max(0, j - 10), j);
    if (lookback.length < 10) continue;
    const priorLow = Math.min(...lookback.map((b) => b.low));
    const priorHigh = Math.max(...lookback.map((b) => b.high));
    if (bars[j].low < priorLow && bars[j].close > priorLow) return 'UP'; // bullish sweep of lows
    if (bars[j].high > priorHigh && bars[j].close < priorHigh) return 'DOWN'; // bearish sweep of highs
  }
  return null;
}

interface FeatureResult {
  feature: string;
  direction: 'LONG' | 'SHORT';
  is: { hits: number; n: number; lift: number | null; wilson: { lo: number; hi: number } };
  oos: { hits: number; n: number; lift: number | null; wilson: { lo: number; hi: number } };
  stableSign: boolean;
}

export function runFeatureLift(bundles: Bundle[], splitAt: string) {
  const results: FeatureResult[] = [];
  const record = (name: string, dir: 'LONG' | 'SHORT', isCounts: [number, number], oosCounts: [number, number], baseIS: number, baseOOS: number) => {
    const [isHits, isN] = isCounts;
    const [oosHits, oosN] = oosCounts;
    const isLift = isN > 0 && baseIS > 0 ? (isHits / isN) / baseIS : null;
    const oosLift = oosN > 0 && baseOOS > 0 ? (oosHits / oosN) / baseOOS : null;
    const isW = wilson95(isHits, isN);
    const oosW = wilson95(oosHits, oosN);
    const stableSign = isLift != null && oosLift != null && (isLift - 1) * (oosLift - 1) > 0;
    results.push({
      feature: name,
      direction: dir,
      is: { hits: isHits, n: isN, lift: isLift != null ? round(isLift, 3) : null, wilson: { lo: round(isW.lo, 3), hi: round(isW.hi, 3) } },
      oos: { hits: oosHits, n: oosN, lift: oosLift != null ? round(oosLift, 3) : null, wilson: { lo: round(oosW.lo, 3), hi: round(oosW.hi, 3) } },
      stableSign,
    });
  };

  // aggregate counters across all symbols
  const counters: Record<string, { isHits: number; isN: number; oosHits: number; oosN: number }> = {};
  const bump = (key: string, isOrOos: 'is' | 'oos', hit: boolean) => {
    counters[key] ??= { isHits: 0, isN: 0, oosHits: 0, oosN: 0 };
    if (isOrOos === 'is') { counters[key].isN++; if (hit) counters[key].isHits++; }
    else { counters[key].oosN++; if (hit) counters[key].oosHits++; }
  };

  for (const b of bundles) {
    const oppBars = buildOppBars(b.loaded, b.loaded.barMs ?? 15 * 60 * 1000);
    const oppByIndex = new Map(oppBars.map((o) => [o.index, o]));
    const { series } = b.loaded;
    for (let i = 5; i < series.bars.length - 1; i++) {
      const opp = oppByIndex.get(i);
      if (!opp) continue;
      const session = series.sessionDates[series.sessionIdx[i]];
      const isIS = session < splitAt;
      const bucket = isIS ? 'is' : 'oos';

      // Feature: sweep in last 3 bars
      const sweep = sweepInLast3(b.loaded, i);
      if (sweep === 'UP') bump('sweep_long', bucket, opp.long2R);
      if (sweep === 'DOWN') bump('sweep_short', bucket, opp.short2R);

      // Feature: price vs VWAP side
      const vwap = vwapCache(b.loaded, i);
      if (vwap != null) {
        const close = series.bars[i].close;
        if (close > vwap) bump('above_vwap_long', bucket, opp.long2R);
        else bump('below_vwap_short', bucket, opp.short2R);
      }

      // Feature: 1H trend side (proxy)
      const trend = trendAt(b.loaded, b.ctx, i);
      if (trend === 'BULLISH') bump('trend_up_long', bucket, opp.long2R);
      if (trend === 'BEARISH') bump('trend_down_short', bucket, opp.short2R);

      // Feature: 1H ADX regime (>=20 = trending)
      const adxNow = b.ctx.adx56[i];
      if (Number.isFinite(adxNow)) {
        if (adxNow >= 20) { bump('adx_trending_long', bucket, opp.long2R); bump('adx_trending_short', bucket, opp.short2R); }
        else { bump('adx_ranging_long', bucket, opp.long2R); bump('adx_ranging_short', bucket, opp.short2R); }
      }

      // Feature: RSI bucket (overbought/oversold as a mean-reversion lift test)
      const rsiNow = b.ctx.rsi14[i];
      if (Number.isFinite(rsiNow)) {
        if (rsiNow >= 70) bump('rsi_overbought_short', bucket, opp.short2R);
        if (rsiNow <= 30) bump('rsi_oversold_long', bucket, opp.long2R);
      }

      // Feature: volume ratio vs time-of-day median (high volume = more likely to run either way)
      const { median, samples } = slotVolumeBaseline(series, i);
      if (median != null && samples >= 5 && series.bars[i].volume > 1.5 * median) {
        bump('highvol_long', bucket, opp.long2R);
        bump('highvol_short', bucket, opp.short2R);
      }

      // Feature: ATR percentile (volatility regime; high vol = more likely to run)
      const atrPctl = b.ctx.atrPercentile[i];
      if (Number.isFinite(atrPctl) && atrPctl >= 80) {
        bump('highvolatility_long', bucket, opp.long2R);
        bump('highvolatility_short', bucket, opp.short2R);
      }
    }
  }

  // base rates per direction (IS/OOS), pooled across symbols
  let isLongN = 0, isLongHits = 0, isShortN = 0, isShortHits = 0;
  let oosLongN = 0, oosLongHits = 0, oosShortN = 0, oosShortHits = 0;
  for (const b of bundles) {
    const oppBars = buildOppBars(b.loaded, b.loaded.barMs ?? 15 * 60 * 1000);
    for (const o of oppBars) {
      const isIS = o.session < splitAt;
      if (isIS) { isLongN++; if (o.long2R) isLongHits++; isShortN++; if (o.short2R) isShortHits++; }
      else { oosLongN++; if (o.long2R) oosLongHits++; oosShortN++; if (o.short2R) oosShortHits++; }
    }
  }
  const baseIS_long = isLongN ? isLongHits / isLongN : 0;
  const baseOOS_long = oosLongN ? oosLongHits / oosLongN : 0;
  const baseIS_short = isShortN ? isShortHits / isShortN : 0;
  const baseOOS_short = oosShortN ? oosShortHits / oosShortN : 0;

  const defs: Array<{ key: string; dir: 'LONG' | 'SHORT'; base: 'long' | 'short' }> = [
    { key: 'sweep_long', dir: 'LONG', base: 'long' },
    { key: 'sweep_short', dir: 'SHORT', base: 'short' },
    { key: 'above_vwap_long', dir: 'LONG', base: 'long' },
    { key: 'below_vwap_short', dir: 'SHORT', base: 'short' },
    { key: 'trend_up_long', dir: 'LONG', base: 'long' },
    { key: 'trend_down_short', dir: 'SHORT', base: 'short' },
    { key: 'adx_trending_long', dir: 'LONG', base: 'long' },
    { key: 'adx_trending_short', dir: 'SHORT', base: 'short' },
    { key: 'adx_ranging_long', dir: 'LONG', base: 'long' },
    { key: 'adx_ranging_short', dir: 'SHORT', base: 'short' },
    { key: 'rsi_overbought_short', dir: 'SHORT', base: 'short' },
    { key: 'rsi_oversold_long', dir: 'LONG', base: 'long' },
    { key: 'highvol_long', dir: 'LONG', base: 'long' },
    { key: 'highvol_short', dir: 'SHORT', base: 'short' },
    { key: 'highvolatility_long', dir: 'LONG', base: 'long' },
    { key: 'highvolatility_short', dir: 'SHORT', base: 'short' },
  ];

  for (const d of defs) {
    const c = counters[d.key] ?? { isHits: 0, isN: 0, oosHits: 0, oosN: 0 };
    const baseIS = d.base === 'long' ? baseIS_long : baseIS_short;
    const baseOOS = d.base === 'long' ? baseOOS_long : baseOOS_short;
    record(d.key, d.dir, [c.isHits, c.isN], [c.oosHits, c.oosN], baseIS, baseOOS);
  }

  return {
    baseRates: { isLong: round(baseIS_long, 4), oosLong: round(baseOOS_long, 4), isShort: round(baseIS_short, 4), oosShort: round(baseOOS_short, 4) },
    features: results,
    notComputed: [
      'displacement / FVG created',
      'BOS/CHoCH direction (structure-engine)',
      'distance to PDH/PDL/session extremes in ATR',
      'time-of-day / day-of-week / expiry-day buckets',
      'candle label (rejection-type) feature',
      'Supertrend(10,3) direction feature',
      'pairwise phi correlation / redundancy matrix',
    ],
  };
}

// small cache to avoid recomputing VWAP levels per call in the hot loop
const vwapMemo = new Map<string, number | null>();
function vwapCache(loaded: LoadedSymbol, i: number): number | null {
  const key = `${loaded.spec.symbol}:${i}`;
  if (vwapMemo.has(key)) return vwapMemo.get(key)!;
  // Local, cheap VWAP-so-far computation (equivalent to buildMomentumLevels' VWAP but avoids its heavier level scan).
  const { series } = loaded;
  const s = series.sessionIdx[i];
  const start = series.sessionStarts[s];
  let pv = 0, v = 0;
  for (let j = start; j < i; j++) {
    pv += ((series.bars[j].high + series.bars[j].low + series.bars[j].close) / 3) * series.bars[j].volume;
    v += series.bars[j].volume;
  }
  const val = v > 0 ? pv / v : null;
  vwapMemo.set(key, val);
  return val;
}
