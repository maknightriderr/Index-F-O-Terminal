// ============================================================
// REGIME x FAMILY cross-tabs (second pass, item 4)
// ============================================================
// Regimes, all from information available at bar i (no look-ahead):
//   - trend: 'UP' | 'DOWN' | 'RANGE' from the TRUE 1H trend (context-1h.ts)
//   - volatility: 'HIGH' | 'LOW' from the ATR percentile (>=50 high, else low
//     — a simple 50/50 split, not the tertile some reports use; disclosed)
//   - phase: 'OPEN' (first 60m) | 'CLOSE' (last 60m) | 'MID'
// Expiry day is NOT included (no reliable historical expiry calendar — see
// feature-lift-v2.ts's own note).
//
// Multiple-testing context: with 3 trend x 2 vol x 3 phase = 18 regime cells
// per family, across 6 families (A, B, C, D, E, CONTROL) that is 108 cells
// tested for "positive in both IS and OOS with N>=30". Even under a null
// where every cell's true average net R is exactly 0, ordinary sampling
// noise means roughly half of any given IS/OOS pair could show a positive
// mean by chance in EACH period; being positive in BOTH periods by chance
// alone would happen for roughly 25% of cells under a naive independence
// assumption — so with 108 cells tested, expect on the order of 25-30
// "positive in both IS and OOS" cells to appear from noise alone, even if
// there is no real edge anywhere. This is reported explicitly alongside the
// actual count found, so a handful of doubly-positive cells is not, by
// itself, evidence of a regime-specific edge.
// ============================================================

import type { LoadedSymbol } from '../backtest/harness.js';
import type { SymbolContext } from './context.js';
import { build1hContext, trueTrendAt, type OneHourContext } from './context-1h.js';
import { round, mean } from './stats.js';
import { getSessionWindow } from '@fno/shared';

export type TrendRegime = 'UP' | 'DOWN' | 'RANGE';
export type VolRegime = 'HIGH' | 'LOW';
export type Phase = 'OPEN' | 'MID' | 'CLOSE';

export function regimeKey(loaded: LoadedSymbol, ctx: SymbolContext, ctx1h: OneHourContext, i: number): string {
  const trend = trueTrendAt(loaded, ctx1h, i);
  const trendR: TrendRegime = trend === 'BULLISH' ? 'UP' : trend === 'BEARISH' ? 'DOWN' : 'RANGE';
  const atrPctl = ctx.atrPercentile[i];
  const volR: VolRegime = Number.isFinite(atrPctl) && atrPctl >= 50 ? 'HIGH' : 'LOW';
  const { series, spec } = loaded;
  const s = series.sessionIdx[i];
  const date = series.sessionDates[s];
  const w = getSessionWindow(spec.exchange, date);
  let phase: Phase = 'MID';
  if (w) {
    const t = series.bars[i].time;
    if (t - w.open < 60 * 60000) phase = 'OPEN';
    else if (w.close - t < 60 * 60000) phase = 'CLOSE';
  }
  return `${trendR}|${volR}|${phase}`;
}

export function buildCtx1hMap(bundles: Array<{ symbol: string; loaded: LoadedSymbol }>) {
  const map = new Map<string, OneHourContext>();
  for (const b of bundles) map.set(b.symbol, build1hContext(b.loaded));
  return map;
}

interface Row { netR: number }
function cellStats(rows: Row[]) {
  const n = rows.length;
  return { n, avgNetR: n ? round(mean(rows.map((r) => r.netR))) : null, lowN: n < 30 };
}

export interface RegimeEvent { symbol: string; index: number; isIS: boolean; netR: number }

export function crossTabByRegime(
  events: RegimeEvent[],
  bundles: Array<{ symbol: string; loaded: LoadedSymbol; ctx: SymbolContext }>,
  ctx1hMap: Map<string, OneHourContext>
) {
  const bySymbol = new Map(bundles.map((b) => [b.symbol, b]));
  const table = new Map<string, { is: Row[]; oos: Row[] }>();
  for (const e of events) {
    const b = bySymbol.get(e.symbol);
    if (!b) continue;
    const ctx1h = ctx1hMap.get(e.symbol);
    if (!ctx1h) continue;
    const key = regimeKey(b.loaded, b.ctx, ctx1h, e.index);
    if (!table.has(key)) table.set(key, { is: [], oos: [] });
    (e.isIS ? table.get(key)!.is : table.get(key)!.oos).push({ netR: e.netR });
  }
  const rows: Array<{ regime: string; is: ReturnType<typeof cellStats>; oos: ReturnType<typeof cellStats>; positiveBoth: boolean }> = [];
  for (const [key, v] of table) {
    const is = cellStats(v.is);
    const oos = cellStats(v.oos);
    const positiveBoth = !is.lowN && !oos.lowN && (is.avgNetR ?? -1) > 0 && (oos.avgNetR ?? -1) > 0;
    rows.push({ regime: key, is, oos, positiveBoth });
  }
  return rows.sort((a, b) => (a.regime < b.regime ? -1 : 1));
}
