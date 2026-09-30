// ============================================================
// PRECISION: of the triggers a family fires, what fraction themselves reach
// 2R (or 3R) before 1R — i.e. do they land inside a real opportunity window,
// not just "does the trade make money net of cost". Reported per direction
// (LONG/SHORT) since the base rate itself is direction-specific, with the
// lift over that direction's base rate, IS and OOS. Shown next to capture
// rate and trade count so trigger frequency can't be mistaken for skill: a
// family that fires on most bars "captures" most opportunities early by
// sheer volume while having precision no better than chance.
// ============================================================

import type { LoadedSymbol } from '../backtest/harness.js';
import { buildOppBars, type OppBar } from './opportunity-census.js';
import { wilson95, round } from './stats.js';

export interface PrecisionCell {
  n: number;
  hits: number;
  precision: number | null;
  lift: number | null;
  wilson: { lo: number; hi: number };
  lowN: boolean;
}

function cell(n: number, hits: number, base: number): PrecisionCell {
  const precision = n ? round(hits / n, 4) : null;
  return {
    n, hits, precision,
    lift: precision != null && base > 0 ? round(precision / base, 3) : null,
    wilson: n ? wilson95(hits, n) : { lo: 0, hi: 0 },
    lowN: n < 30,
  };
}

export interface PrecisionReport {
  long2R: PrecisionCell; short2R: PrecisionCell;
  long3R: PrecisionCell; short3R: PrecisionCell;
}

export function oppIndexBySymbol(bundles: Array<{ symbol: string; loaded: LoadedSymbol }>) {
  const map = new Map<string, Map<number, OppBar>>();
  for (const b of bundles) {
    const bars = buildOppBars(b.loaded, b.loaded.barMs ?? 15 * 60 * 1000);
    map.set(b.symbol, new Map(bars.map((o) => [o.index, o])));
  }
  return map;
}

/** Finds the bar index whose decidedAt (bar.time + barMs) matches — used to map an existing A/B OOS trade-log entry back onto the opportunity census. */
export function indexAtDecidedAt(loaded: LoadedSymbol, decidedAtMs: number, barMs: number): number | null {
  const { bars } = loaded.series;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].time + barMs === decidedAtMs) return i;
  }
  return null;
}

export interface PrecisionEvent { symbol: string; index: number; direction: 'LONG' | 'SHORT' }

/** baseRates: pooled {isLong,oosLong,isShort,oosShort} for 2R and 3R (caller supplies both mults). */
export function scorePrecision(
  events: PrecisionEvent[],
  oppIndex: Map<string, Map<number, OppBar>>,
  base2R: { long: number; short: number },
  base3R: { long: number; short: number }
): PrecisionReport {
  let hL2 = 0, nL2 = 0, hS2 = 0, nS2 = 0, hL3 = 0, nL3 = 0, hS3 = 0, nS3 = 0;
  for (const e of events) {
    const opp = oppIndex.get(e.symbol)?.get(e.index);
    if (!opp) continue;
    if (e.direction === 'LONG') {
      nL2++; if (opp.long2R) hL2++;
      nL3++; if (opp.long3R) hL3++;
    } else {
      nS2++; if (opp.short2R) hS2++;
      nS3++; if (opp.short3R) hS3++;
    }
  }
  return {
    long2R: cell(nL2, hL2, base2R.long),
    short2R: cell(nS2, hS2, base2R.short),
    long3R: cell(nL3, hL3, base3R.long),
    short3R: cell(nS3, hS3, base3R.short),
  };
}

/** Pooled base rates across all bars from a set of loaded symbols' opportunity bars, split IS/OOS. */
export function pooledBaseRates(allOppBars: OppBar[], splitAt: string) {
  const agg = (pred: (o: OppBar) => boolean, dirKey: 'long2R' | 'short2R' | 'long3R' | 'short3R') => {
    let n = 0, h = 0;
    for (const o of allOppBars) {
      if (!pred(o)) continue;
      n++; if (o[dirKey]) h++;
    }
    return n ? h / n : 0;
  };
  const isP = (o: OppBar) => o.session < splitAt;
  const oosP = (o: OppBar) => o.session >= splitAt;
  return {
    is2R: { long: agg(isP, 'long2R'), short: agg(isP, 'short2R') },
    oos2R: { long: agg(oosP, 'long2R'), short: agg(oosP, 'short2R') },
    is3R: { long: agg(isP, 'long3R'), short: agg(isP, 'short3R') },
    oos3R: { long: agg(oosP, 'long3R'), short: agg(oosP, 'short3R') },
  };
}
