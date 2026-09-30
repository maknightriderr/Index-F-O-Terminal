// ============================================================
// TRUE 1H CONTEXT (resampled from 15m, session-anchored)
// ============================================================
// Second-pass fix: the first pass used a 15m-native EMA80/ADX56 proxy for
// "1H trend/ADX". This resamples real 1H OHLC bars from the 15m series
// (groups of 4 consecutive 15m bars from each session's open — the last
// group of a session may be shorter, matching a genuine partial last hour),
// computes EMA20/ADX14 on THAT series, and maps every 15m bar to the latest
// FULLY CLOSED 1H bar as of its own close (never the still-forming hour) —
// so there is no look-ahead: a 15m bar that completes its own hour may use
// that hour's own close (it does not need to wait for a "future" bar, since
// the 1H bar's last constituent bar IS this bar), but every other 15m bar in
// that hour uses the previous, already-closed 1H bar.
// ============================================================

import { ema, adx } from '@fno/analytics';
import type { LoadedSymbol } from '../backtest/harness.js';

export interface OneHourContext {
  bars1h: Array<{ time: number; open: number; high: number; low: number; close: number }>;
  /** For 15m bar i: index into bars1h of the latest CLOSED 1h bar as of bar i's own close, or -1 if none yet. */
  map15to1h: number[];
  ema20_1h: number[]; // aligned to bars1h length, NaN until enough history
  adx14_1h: number[];
}

function alignBack(arr: number[], total: number): number[] {
  const out = new Array(total).fill(NaN);
  const offset = total - arr.length;
  for (let i = 0; i < arr.length; i++) out[offset + i] = arr[i];
  return out;
}

export function build1hContext(loaded: LoadedSymbol): OneHourContext {
  const { series } = loaded;
  const bars = series.bars;
  const bars1h: OneHourContext['bars1h'] = [];
  const map15to1h: number[] = new Array(bars.length).fill(-1);

  let group: typeof bars = [];
  let curSession = -1;
  let lastClosedGroupIdx = -1;

  const flush = () => {
    if (group.length === 0) return;
    const o = group[0];
    const c = group[group.length - 1];
    bars1h.push({
      time: o.time,
      open: o.open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close: c.close,
    });
    group = [];
  };

  for (let i = 0; i < bars.length; i++) {
    const s = series.sessionIdx[i];
    if (s !== curSession) {
      flush();
      lastClosedGroupIdx = bars1h.length - 1;
      curSession = s;
    }
    group.push(bars[i]);
    if (group.length === 4) {
      flush();
      lastClosedGroupIdx = bars1h.length - 1;
      map15to1h[i] = lastClosedGroupIdx; // this bar's own close completes the hour
    } else {
      map15to1h[i] = lastClosedGroupIdx; // still inside a forming hour: use the previous closed one
    }
  }
  flush();

  const closes1h = bars1h.map((b) => b.close);
  const highs1h = bars1h.map((b) => b.high);
  const lows1h = bars1h.map((b) => b.low);
  const ema20_1h = alignBack(ema(closes1h, 20), bars1h.length);
  const adx14_1h = alignBack(adx(highs1h, lows1h, closes1h, 14).adx, bars1h.length);

  return { bars1h, map15to1h, ema20_1h, adx14_1h };
}

/** True 1H trend at 15m bar i: BULLISH if the 15m close is above the latest closed 1H EMA20 and that EMA has risen over the last 4 completed 1H bars, BEARISH mirrors, else null. */
export function trueTrendAt(loaded: LoadedSymbol, ctx: OneHourContext, i: number): 'BULLISH' | 'BEARISH' | null {
  const idx = ctx.map15to1h[i];
  if (idx < 0) return null;
  const e = ctx.ema20_1h[idx];
  const e4 = idx >= 4 ? ctx.ema20_1h[idx - 4] : NaN;
  if (!Number.isFinite(e) || !Number.isFinite(e4)) return null;
  const close = loaded.series.bars[i].close;
  if (close > e && e > e4) return 'BULLISH';
  if (close < e && e < e4) return 'BEARISH';
  return null;
}

export function trueAdxAt(ctx: OneHourContext, i: number): number | null {
  const idx = ctx.map15to1h[i];
  if (idx < 0) return null;
  const v = ctx.adx14_1h[idx];
  return Number.isFinite(v) ? v : null;
}
