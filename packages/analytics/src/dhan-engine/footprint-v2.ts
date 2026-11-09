// ============================================================
// FOOTPRINT v2 — diagonal and stacked imbalances (master prompt 5.1 / 5.2)
// ============================================================
// Buy imbalance at row P:  ask (estimated aggressive buy) volume at P ÷ bid (estimated aggressive sell) volume one row BELOW.
// Sell imbalance at row P: bid volume at P ÷ ask volume one row ABOVE.
// Ratio >= 300%. No imbalance when:
//   - the numerator is below the instrument's minimum row volume (min-volume filter), or
//   - the denominator is below `minDenominator` (default 1 unit: a comparison against nothing is not a ratio), or
//   - the bar is INCOMPLETE / UNAVAILABLE / its classified share is too low (delta withheld).
// A stack is >= 3 consecutive rows (adjacent price rows, no gap) imbalanced on the same side.
// Sides are inferred: everything here is ESTIMATED.
// ============================================================

import type { FootprintBar } from '../order-flow/index.js';
import { DHAN_ENGINE_RULES, roundDp, rowOf, type EngineStatus } from './common.js';

export interface DiagonalRow {
  price: number;
  ask: number;
  bid: number;
  unknown: number;
  /** ask(P) ÷ bid(P − step); null when not computable. */
  buyRatio: number | null;
  /** bid(P) ÷ ask(P + step); null when not computable. */
  sellRatio: number | null;
  buyImbalance: boolean;
  sellImbalance: boolean;
}

export interface ImbalanceStack {
  side: 'BUY' | 'SELL';
  /** Lowest and highest row of the stack. */
  low: number;
  high: number;
  rows: number;
}

export interface FootprintV2 {
  status: EngineStatus;
  reason: string | null;
  barTime: number;
  priceStep: number | null;
  minLevelVolume: number | null;
  rows: DiagonalRow[];
  buyImbalances: number;
  sellImbalances: number;
  stacks: ImbalanceStack[];
}

export interface DiagonalOptions {
  ratio?: number;
  stackedMin?: number;
  /** Instrument-specific numerator floor; default max(lot, minLevelShare × average row volume). */
  minLevelVolume?: number;
  minDenominator?: number;
  lotSize?: number;
}

/** The default instrument min-volume filter for a bar (documented; replaceable per instrument). */
export function defaultMinLevelVolume(fp: FootprintBar, lotSize = 1): number | null {
  if (!fp.levels.length || !(fp.volume != null && fp.volume > 0)) return null;
  return Math.max(lotSize, Math.ceil((DHAN_ENGINE_RULES.minLevelShare * fp.volume) / fp.levels.length));
}

export function diagonalImbalances(fp: FootprintBar, opts: DiagonalOptions = {}): FootprintV2 {
  const ratio = opts.ratio ?? DHAN_ENGINE_RULES.diagonalRatio;
  const stackedMin = opts.stackedMin ?? DHAN_ENGINE_RULES.stackedMin;
  const minDen = opts.minDenominator ?? 1;
  const step = fp.priceStep ?? inferStep(fp);
  const base = { barTime: fp.barTime, priceStep: step, rows: [] as DiagonalRow[], buyImbalances: 0, sellImbalances: 0, stacks: [] as ImbalanceStack[] };
  if (fp.deltaMode === 'UNAVAILABLE' || !fp.levels.length) return { ...base, status: 'UNAVAILABLE', reason: 'NO_TRADES', minLevelVolume: null };
  if (fp.incomplete) return { ...base, status: 'INCOMPLETE', reason: 'INCOMPLETE_UNRECONCILED_VOLUME', minLevelVolume: null };
  if (fp.delta == null) return { ...base, status: 'INCOMPLETE', reason: 'LOW_CLASSIFIED_SHARE', minLevelVolume: null };
  if (!(step != null && step > 0)) return { ...base, status: 'UNAVAILABLE', reason: 'NO_PRICE_STEP', minLevelVolume: null };
  const minLevel = opts.minLevelVolume ?? defaultMinLevelVolume(fp, opts.lotSize ?? 1)!;
  const byRow = new Map(fp.levels.map((l) => [rowOf(l.price, step), l]));
  const rows: DiagonalRow[] = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([price, l]) => {
    const below = byRow.get(rowOf(price - step, step));
    const above = byRow.get(rowOf(price + step, step));
    const bidBelow = below?.sell ?? 0;
    const askAbove = above?.buy ?? 0;
    const buyRatio = bidBelow >= minDen ? roundDp(l.buy / bidBelow, 4) : null;
    const sellRatio = askAbove >= minDen ? roundDp(l.sell / askAbove, 4) : null;
    return {
      price, ask: l.buy, bid: l.sell, unknown: l.unclassified, buyRatio, sellRatio,
      buyImbalance: buyRatio != null && l.buy >= minLevel && buyRatio >= ratio,
      sellImbalance: sellRatio != null && l.sell >= minLevel && sellRatio >= ratio,
    };
  });
  return { ...base, status: 'ESTIMATED', reason: fp.sampled ? `SAMPLED_COVERAGE_${Math.round((fp.coverage ?? 0) * 100)}PCT` : null, minLevelVolume: minLevel, rows, buyImbalances: rows.filter((r) => r.buyImbalance).length, sellImbalances: rows.filter((r) => r.sellImbalance).length, stacks: stacksOf(rows, step, stackedMin) };
}

function stacksOf(rows: readonly DiagonalRow[], step: number, min: number): ImbalanceStack[] {
  const out: ImbalanceStack[] = [];
  for (const side of ['BUY', 'SELL'] as const) {
    let run: DiagonalRow[] = [];
    const flush = () => {
      if (run.length >= min) out.push({ side, low: run[0].price, high: run[run.length - 1].price, rows: run.length });
      run = [];
    };
    for (const r of rows) {
      const hit = side === 'BUY' ? r.buyImbalance : r.sellImbalance;
      const adjacent = run.length > 0 && Math.abs(r.price - run[run.length - 1].price - step) < step * 1e-6;
      if (!hit) flush();
      else if (run.length === 0 || adjacent) run.push(r);
      else (flush(), run.push(r));
    }
    flush();
  }
  return out.sort((a, b) => a.low - b.low);
}

/** Smallest gap between adjacent rows (for footprints stored before v2 carried their step). */
function inferStep(fp: FootprintBar): number | null {
  const p = [...new Set(fp.levels.map((l) => l.price))].sort((a, b) => a - b);
  let best: number | null = null;
  for (let i = 1; i < p.length; i++) {
    const d = roundDp(p[i] - p[i - 1]);
    if (d > 0 && (best == null || d < best)) best = d;
  }
  return best;
}
