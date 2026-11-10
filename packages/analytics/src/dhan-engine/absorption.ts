// ============================================================
// ABSORPTION (master prompt 5.3) and EXHAUSTION (5.4) — ESTIMATED
// ============================================================
// Bullish absorption at bar i (bearish is the mirror):
//   1. high estimated aggressive selling: the bar's sell volume is more than minSideShare (50%) of classified volume;
//   2. a row's sell volume >= the 80th percentile of the previous 50 comparable observations (sell volume per row,
//      earlier valid bars of the same contract); fewer than 50 observations -> nothing is detected (no baseline);
//   3. limited downward progress: (zone row − bar low) <= 0.25 ATR — sellers hit the zone and price barely moved;
//   4. price stays near the zone: |close − zone| <= 0.5 ATR;
//   5. confirmation: within 3 bars a close above the bar's high (sellers failed). A trade below the bar's low first,
//      or no confirmation in time, FAILS it. Until then it is a CANDIDATE.
// High volume at a price alone never qualifies (rules 1, 3, 4 and 5 are all required).
//
// Buying exhaustion at a high (bearish; selling exhaustion at a low is the mirror):
//   - the bar makes the highest high of the last `lookback` bars;
//   - weak auction extension: volume in the top row <= 0.3x the bar's average row volume;
//   - reduced aggression: buy volume and delta both below the previous bar's;
//   - failed continuation: the next bar does not exceed the high;
//   - confirmation: within 3 bars a close below the bar's low. A new high first FAILS it.
// Exhaustion never generates a trade on its own; setups read it as one piece of evidence.
// Incomplete / low-classified bars are skipped (and do not feed the baseline).
// ============================================================

import type { FootprintBar } from '../order-flow/index.js';
import { DHAN_ENGINE_RULES, quantile, roundDp, type EngineBar, type Side } from './common.js';

export type PatternState = 'CANDIDATE' | 'CONFIRMED' | 'FAILED';

export interface AbsorptionEvent {
  side: Side;
  index: number;
  zone: number;
  zoneVolume: number;
  threshold: number;
  progressAtr: number;
  state: PatternState;
  resolvedAt: number | null;
}

const valid = (f: FootprintBar | undefined) => !!f && f.deltaMode !== 'UNAVAILABLE' && !f.incomplete && f.delta != null && f.levels.length > 0;
const barOf = (f: FootprintBar, b?: EngineBar): EngineBar | null => (b ? b : f.high != null && f.low != null && f.close != null ? { time: f.barTime, open: f.close, high: f.high, low: f.low, close: f.close } : null);

export interface AbsorptionOptions {
  baselineObs?: number;
  percentile?: number;
  maxProgressAtr?: number;
  nearAtr?: number;
  confirmBars?: number;
  minSideShare?: number;
}

/** `fps[i]` and `bars[i]` are the same bar of one contract (bars optional: the footprint's own high/low/close otherwise). */
export function detectAbsorption(fps: readonly FootprintBar[], atr: number, bars: readonly EngineBar[] = [], o: AbsorptionOptions = {}): AbsorptionEvent[] {
  const nObs = o.baselineObs ?? DHAN_ENGINE_RULES.absorptionBaselineObs;
  const pct = o.percentile ?? DHAN_ENGINE_RULES.absorptionPercentile;
  const maxProg = o.maxProgressAtr ?? DHAN_ENGINE_RULES.absorptionMaxProgressAtr;
  const near = o.nearAtr ?? DHAN_ENGINE_RULES.absorptionNearAtr;
  const nConf = o.confirmBars ?? DHAN_ENGINE_RULES.absorptionConfirmBars;
  const share = o.minSideShare ?? DHAN_ENGINE_RULES.absorptionMinSideShare;
  if (!(atr > 0)) return [];
  const out: AbsorptionEvent[] = [];
  const hist = { BULLISH: [] as number[], BEARISH: [] as number[] };
  for (let i = 0; i < fps.length; i++) {
    const f = fps[i];
    if (!valid(f)) continue;
    const bar = barOf(f, bars[i]);
    for (const side of ['BULLISH', 'BEARISH'] as const) {
      const base = hist[side].slice(-nObs);
      const aggressive = side === 'BULLISH' ? f.sellVolume ?? 0 : f.buyVolume ?? 0;
      const classified = (f.buyVolume ?? 0) + (f.sellVolume ?? 0);
      if (bar && base.length >= nObs && classified > 0 && aggressive / classified > share) {
        const threshold = quantile(base, pct)!;
        // Only rank rows that qualify as absorption zones. A larger row away from the extreme
        // must not hide a qualifying row where aggression failed to move price further.
        const rows = f.levels.flatMap((level) => {
          const volume = side === 'BULLISH' ? level.sell : level.buy;
          if (!(volume > 0 && volume >= threshold)) return [];
          const progress = side === 'BULLISH' ? level.price - bar.low : bar.high - level.price;
          const progressAtr = roundDp(Math.max(0, progress) / atr, 4);
          if (!(progressAtr <= maxProg && Math.abs(bar.close - level.price) <= near * atr)) return [];
          return [{ price: level.price, v: volume, progressAtr }];
        });
        if (rows.length) {
          const zone = rows.reduce((a, r) => (r.v > a.v || (r.v === a.v && (side === 'BULLISH' ? r.price < a.price : r.price > a.price)) ? r : a));
          out.push({ side, index: i, zone: zone.price, zoneVolume: zone.v, threshold: roundDp(threshold, 4), progressAtr: zone.progressAtr, ...resolve(fps, bars, i, bar, side, nConf) });
        }
      }
    }
    for (const l of f.levels) {
      if (l.sell > 0) hist.BULLISH.push(l.sell);
      if (l.buy > 0) hist.BEARISH.push(l.buy);
    }
  }
  return out;
}

function resolve(fps: readonly FootprintBar[], bars: readonly EngineBar[], i: number, bar: EngineBar, side: Side, n: number): { state: PatternState; resolvedAt: number | null } {
  const known = Math.max(fps.length, bars.length);
  for (let j = i + 1; j <= i + n; j++) {
    if (j >= known) return { state: 'CANDIDATE', resolvedAt: null };
    const f = fps[j];
    const b = f ? barOf(f, bars[j]) : bars[j] ?? null;
    if (!b) continue; // a bar with no trades decides nothing
    if (side === 'BULLISH' ? b.low < bar.low : b.high > bar.high) return { state: 'FAILED', resolvedAt: j };
    if (side === 'BULLISH' ? b.close > bar.high : b.close < bar.low) return { state: 'CONFIRMED', resolvedAt: j };
  }
  return { state: 'FAILED', resolvedAt: i + n };
}

export interface ExhaustionEvent {
  /** BEARISH = buying exhausted at a high; BULLISH = selling exhausted at a low. */
  side: Side;
  index: number;
  extreme: number;
  extremeRowShare: number;
  state: PatternState;
  resolvedAt: number | null;
}

export function detectExhaustion(fps: readonly FootprintBar[], bars: readonly EngineBar[] = [], o: { lookback?: number; thinShare?: number; confirmBars?: number } = {}): ExhaustionEvent[] {
  const look = o.lookback ?? DHAN_ENGINE_RULES.exhaustionLookback;
  const thin = o.thinShare ?? DHAN_ENGINE_RULES.exhaustionThinShare;
  const nConf = o.confirmBars ?? DHAN_ENGINE_RULES.exhaustionConfirmBars;
  const out: ExhaustionEvent[] = [];
  for (let i = Math.max(1, look - 1); i < fps.length; i++) {
    const f = fps[i], p = fps[i - 1];
    if (!valid(f) || !valid(p)) continue;
    const bar = barOf(f, bars[i]);
    if (!bar) continue;
    const window = fps.slice(i - look + 1, i + 1).map((x, k) => (x ? barOf(x, bars[i - look + 1 + k]) : null));
    if (window.some((w) => !w)) continue;
    const avgRow = (f.volume ?? 0) / f.levels.length;
    const rows = [...f.levels].sort((a, b) => a.price - b.price);
    for (const side of ['BEARISH', 'BULLISH'] as const) {
      const atExtreme = side === 'BEARISH' ? window.every((w) => w!.high <= bar.high) : window.every((w) => w!.low >= bar.low);
      if (!atExtreme) continue;
      const edge = side === 'BEARISH' ? rows[rows.length - 1] : rows[0];
      const edgeShare = avgRow > 0 ? (edge.buy + edge.sell + edge.unclassified) / avgRow : Infinity;
      const aggNow = side === 'BEARISH' ? f.buyVolume ?? 0 : f.sellVolume ?? 0;
      const aggPrev = side === 'BEARISH' ? p.buyVolume ?? 0 : p.sellVolume ?? 0;
      const weaker = side === 'BEARISH' ? f.delta! < p.delta! : f.delta! > p.delta!;
      if (!(edgeShare <= thin && aggNow < aggPrev && weaker)) continue;
      let state: PatternState = 'FAILED', resolvedAt: number | null = i + nConf;
      const known = Math.max(fps.length, bars.length);
      for (let j = i + 1; j <= i + nConf; j++) {
        if (j >= known) { state = 'CANDIDATE'; resolvedAt = null; break; }
        const b = fps[j] ? barOf(fps[j], bars[j]) : bars[j] ?? null;
        if (!b) continue;
        if (side === 'BEARISH' ? b.high > bar.high : b.low < bar.low) { state = 'FAILED'; resolvedAt = j; break; }
        if (side === 'BEARISH' ? b.close < bar.low : b.close > bar.high) { state = 'CONFIRMED'; resolvedAt = j; break; }
      }
      out.push({ side, index: i, extreme: side === 'BEARISH' ? bar.high : bar.low, extremeRowShare: roundDp(edgeShare, 4), state, resolvedAt });
    }
  }
  return out;
}
