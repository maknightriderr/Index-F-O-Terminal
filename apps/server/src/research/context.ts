// ============================================================
// SHARED CONTEXT ARRAYS (research, read-only, no look-ahead)
// ============================================================
// Precomputes, once per symbol, whole-series arrays for indicators used by
// the simple trigger families and the feature-lift analysis. Every array
// value at index i is a function of bars[0..i] only (standard causal
// indicator construction: ema/adx/rsi/supertrend all consume a prefix and
// their libraries never reach forward). Tests in
// research-no-lookahead.test.ts assert this holds for the derived signals.
//
// SIMPLIFICATION (disclosed): the spec asks for "1H" trend/ADX context.
// Resampling to true 1H bars was out of budget for this pass, so trend and
// regime use longer-period indicators on the native 15m series as a proxy:
// EMA80 (~20 "hours" of 4 15m bars) for 1H EMA20, and ADX56 (~14 "hours")
// for 1H ADX14. This is noted plainly in the diagnosis report; it is a
// coarser regime signal than a true 1H resample and should be treated as
// such, not as validated evidence either way.
// ============================================================

import { adx, ema, rsi, supertrend as supertrendInd, atr as atrArr } from '@fno/analytics';
import { momentumAtrAt, buildMomentumLevels, type MomentumSeries } from '@fno/analytics';
import type { LoadedSymbol } from '../backtest/harness.js';

export interface SymbolContext {
  ema80: number[]; // 1H EMA20 proxy, aligned to bars index (NaN until enough history)
  ema20: number[]; // real 15m EMA20 (for pullback touches)
  adx56: number[]; // 1H ADX14 proxy
  rsi14: number[];
  supertrendDir: ('UP' | 'DOWN' | null)[];
  atr14: (number | null)[]; // momentumAtrAt per bar, cached
  atrPercentile: number[]; // percentile of atr14[i] within trailing 60 sessions' bars, 0-100
}

function alignBack<T>(arr: T[], total: number, fill: T): T[] {
  const out = new Array<T>(total).fill(fill);
  const offset = total - arr.length;
  for (let i = 0; i < arr.length; i++) out[offset + i] = arr[i];
  return out;
}

export function buildContext(loaded: LoadedSymbol): SymbolContext {
  const { series } = loaded;
  const bars = series.bars;
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  const emaRaw = ema(closes, 80);
  const ema80 = alignBack(emaRaw, n, NaN);
  const ema20Raw = ema(closes, 20);
  const ema20 = alignBack(ema20Raw, n, NaN);

  const adxRaw = adx(highs, lows, closes, 56).adx;
  const adx56 = alignBack(adxRaw, n, NaN);

  const rsiRaw = rsi(closes, 14);
  const rsi14 = alignBack(rsiRaw, n, NaN);

  const stRaw = supertrendInd(highs, lows, closes, 10, 3).direction;
  const supertrendDir = alignBack(stRaw, n, null as 'UP' | 'DOWN' | null);

  const atr14: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) atr14[i] = momentumAtrAt(series, i);

  // ATR percentile within trailing 60 sessions (using only bars at/ before i,
  // sessions strictly before i's own session plus bars so far this session).
  const atrPercentile = computeAtrPercentile(series, atr14);

  return { ema80, ema20, adx56, rsi14, supertrendDir, atr14, atrPercentile };
}

function computeAtrPercentile(series: MomentumSeries, atr14: (number | null)[]): number[] {
  const n = series.bars.length;
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const v = atr14[i];
    if (v == null) continue;
    const s = series.sessionIdx[i];
    const lowSession = Math.max(0, s - 60);
    const lowIdx = series.sessionStarts[lowSession];
    const window: number[] = [];
    for (let j = lowIdx; j <= i; j++) {
      const a = atr14[j];
      if (a != null) window.push(a);
    }
    if (window.length < 20) continue;
    const below = window.filter((x) => x <= v).length;
    out[i] = Math.round((below / window.length) * 100);
  }
  return out;
}

/** 1H trend side at bar i: BULLISH if close > ema80 and ema80 rising over the last 4 bars, BEARISH mirror, else null (no trend / flat). */
export function trendAt(loaded: LoadedSymbol, ctx: SymbolContext, i: number): 'BULLISH' | 'BEARISH' | null {
  const e = ctx.ema80[i];
  const e4 = i >= 4 ? ctx.ema80[i - 4] : NaN;
  if (!Number.isFinite(e) || !Number.isFinite(e4)) return null;
  const close = loaded.series.bars[i].close;
  const slopeUp = e > e4;
  const slopeDown = e < e4;
  if (close > e && slopeUp) return 'BULLISH';
  if (close < e && slopeDown) return 'BEARISH';
  return null;
}

/** Session VWAP at bar i (from bars strictly before i in the same session), via buildMomentumLevels. */
export function vwapAt(loaded: LoadedSymbol, i: number): number | null {
  const levels = buildMomentumLevels(loaded.series, i);
  return levels.find((l) => l.kind === 'VWAP')?.price ?? null;
}

export function levelsAt(loaded: LoadedSymbol, i: number) {
  return buildMomentumLevels(loaded.series, i);
}
