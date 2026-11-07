// ============================================================
// MARKET STRUCTURE (master prompt Part 6) — closed bars only
// ============================================================
// Pivot high at bar i: high above the highs of the `left` bars before it, and at or above the highs of the `right`
// bars after it (so of two equal highs the first is the pivot). Mirror for lows. A pivot exists only from bar
// i + right (its `confirmedAt`): nothing here looks at a bar that had not closed at the time of the decision.
//
// Swing labels: each pivot high vs the previous pivot high: HH / LH / EH (equal); lows: HL / LL / EL.
// BOS / CHoCH: a CLOSE beyond the latest confirmed swing by >= bosTickBuffer ticks (a wick is not enough). Breaking
// in the direction of the current structure is a BOS; against it (or the first break) is a CHoCH. Each swing breaks once.
// Liquidity sweep: trades beyond a confirmed level by >= the buffer, never closes beyond it by the buffer, and closes
// back inside within sweepMaxBars bars. Order-flow evidence is attached; a sweep is CONFIRMED only when it supports.
// Failed breakout: a close beyond a level by the buffer, then a close back inside within failedBreakoutBars bars.
// FVG: bars[i-2].high < bars[i].low (bullish) / bars[i-2].low > bars[i].high (bearish); filled once a later bar trades into it.
// ============================================================

import { DHAN_ENGINE_RULES, roundDp, type EngineBar, type Side } from './common.js';

export interface Pivot {
  kind: 'HIGH' | 'LOW';
  index: number;
  time: number;
  price: number;
  /** The bar index from which the pivot is known. */
  confirmedAt: number;
  label: 'HH' | 'LH' | 'EH' | 'HL' | 'LL' | 'EL' | null;
}

export function confirmedPivots(bars: readonly EngineBar[], left: number = DHAN_ENGINE_RULES.pivotLeft, right: number = DHAN_ENGINE_RULES.pivotRight): Pivot[] {
  const out: Pivot[] = [];
  let lastHigh: number | null = null, lastLow: number | null = null;
  for (let i = left; i + right < bars.length; i++) {
    const b = bars[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= left; k++) {
      if (!(b.high > bars[i - k].high)) isHigh = false;
      if (!(b.low < bars[i - k].low)) isLow = false;
    }
    for (let k = 1; k <= right; k++) {
      if (!(b.high >= bars[i + k].high)) isHigh = false;
      if (!(b.low <= bars[i + k].low)) isLow = false;
    }
    if (isHigh) {
      out.push({ kind: 'HIGH', index: i, time: b.time, price: b.high, confirmedAt: i + right, label: lastHigh == null ? null : b.high > lastHigh ? 'HH' : b.high < lastHigh ? 'LH' : 'EH' });
      lastHigh = b.high;
    }
    if (isLow) {
      out.push({ kind: 'LOW', index: i, time: b.time, price: b.low, confirmedAt: i + right, label: lastLow == null ? null : b.low > lastLow ? 'HL' : b.low < lastLow ? 'LL' : 'EL' });
      lastLow = b.low;
    }
  }
  return out;
}

export interface StructureBreak {
  type: 'BOS' | 'CHOCH';
  side: Side;
  index: number;
  time: number;
  level: number;
  pivotIndex: number;
}

export interface StructureState {
  trend: Side | 'UNKNOWN';
  pivots: Pivot[];
  breaks: StructureBreak[];
  lastSwingHigh: Pivot | null;
  lastSwingLow: Pivot | null;
}

/** Walk closed bars; at bar i only pivots confirmed at or before i are used. */
export function analyzeStructure(bars: readonly EngineBar[], tickSize: number, tickBuffer: number = DHAN_ENGINE_RULES.bosTickBuffer): StructureState {
  const pivots = confirmedPivots(bars);
  const buf = tickSize * tickBuffer;
  const breaks: StructureBreak[] = [];
  let trend: Side | 'UNKNOWN' = 'UNKNOWN';
  let swingHigh: Pivot | null = null, swingLow: Pivot | null = null;
  const used = new Set<number>();
  let p = 0;
  for (let i = 0; i < bars.length; i++) {
    while (p < pivots.length && pivots[p].confirmedAt <= i) {
      if (pivots[p].kind === 'HIGH') swingHigh = pivots[p];
      else swingLow = pivots[p];
      p++;
    }
    const c = bars[i].close;
    if (swingHigh && !used.has(swingHigh.index * 2) && i > swingHigh.index && c >= swingHigh.price + buf) {
      breaks.push({ type: trend === 'BULLISH' ? 'BOS' : 'CHOCH', side: 'BULLISH', index: i, time: bars[i].time, level: swingHigh.price, pivotIndex: swingHigh.index });
      used.add(swingHigh.index * 2);
      trend = 'BULLISH';
    }
    if (swingLow && !used.has(swingLow.index * 2 + 1) && i > swingLow.index && c <= swingLow.price - buf) {
      breaks.push({ type: trend === 'BEARISH' ? 'BOS' : 'CHOCH', side: 'BEARISH', index: i, time: bars[i].time, level: swingLow.price, pivotIndex: swingLow.index });
      used.add(swingLow.index * 2 + 1);
      trend = 'BEARISH';
    }
  }
  return { trend, pivots, breaks, lastSwingHigh: swingHigh, lastSwingLow: swingLow };
}

export interface LiquidityLevel {
  price: number;
  /** 'HIGH' levels hold buy-side liquidity (stops above), 'LOW' levels sell-side. */
  side: 'HIGH' | 'LOW';
  kind: 'SWING' | 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'OR_HIGH' | 'OR_LOW';
  /** First bar index at which the level is known. */
  knownFrom: number;
}

export type FlowSupport = 'SUPPORTING' | 'NOT_SUPPORTING' | 'UNAVAILABLE';

export interface EngineSweep {
  /** BEARISH = buy-side liquidity above a high taken and rejected; BULLISH = sell-side below a low. */
  side: Side;
  level: LiquidityLevel;
  /** Bar that traded beyond, bar that closed back inside. */
  index: number;
  reclaimIndex: number;
  extreme: number;
  flow: FlowSupport;
  confirmed: boolean;
}

/**
 * Per-bar estimated delta (null = unavailable) supports a sweep of highs when sellers took over (delta < 0) at the
 * sweep or reclaim bar, or bearish absorption was flagged there; mirror for lows. A research definition, recorded.
 */
export function detectSweeps(bars: readonly EngineBar[], levels: readonly LiquidityLevel[], tickSize: number, flow: { delta: ReadonlyArray<number | null>; absorption?: ReadonlyArray<Side | null> } | null = null, tickBuffer: number = DHAN_ENGINE_RULES.bosTickBuffer, maxBars: number = DHAN_ENGINE_RULES.sweepMaxBars): EngineSweep[] {
  const buf = tickSize * tickBuffer;
  const out: EngineSweep[] = [];
  for (const lv of levels) {
    for (let i = Math.max(0, lv.knownFrom); i < bars.length; i++) {
      const beyond = lv.side === 'HIGH' ? bars[i].high >= lv.price + buf : bars[i].low <= lv.price - buf;
      if (!beyond) continue;
      let reclaim = -1, accepted = false, extreme = lv.side === 'HIGH' ? -Infinity : Infinity;
      for (let j = i; j < Math.min(bars.length, i + maxBars); j++) {
        extreme = lv.side === 'HIGH' ? Math.max(extreme, bars[j].high) : Math.min(extreme, bars[j].low);
        const c = bars[j].close;
        if (lv.side === 'HIGH' ? c >= lv.price + buf : c <= lv.price - buf) { accepted = true; break; }
        if (lv.side === 'HIGH' ? c < lv.price : c > lv.price) { reclaim = j; break; }
      }
      if (!accepted && reclaim >= 0) {
        const side: Side = lv.side === 'HIGH' ? 'BEARISH' : 'BULLISH';
        const f = flowAt(flow, [i, reclaim], side);
        out.push({ side, level: lv, index: i, reclaimIndex: reclaim, extreme, flow: f, confirmed: f === 'SUPPORTING' });
      }
      break; // a level is swept (or accepted) once: the first excursion decides it
    }
  }
  return out.sort((a, b) => a.reclaimIndex - b.reclaimIndex);
}

function flowAt(flow: { delta: ReadonlyArray<number | null>; absorption?: ReadonlyArray<Side | null> } | null, idx: number[], side: Side): FlowSupport {
  if (!flow) return 'UNAVAILABLE';
  const ds = idx.map((k) => flow.delta[k]).filter((d): d is number => d != null);
  const abs = idx.some((k) => flow.absorption?.[k] === side);
  if (abs) return 'SUPPORTING';
  if (!ds.length) return 'UNAVAILABLE';
  return ds.some((d) => (side === 'BEARISH' ? d < 0 : d > 0)) ? 'SUPPORTING' : 'NOT_SUPPORTING';
}

export interface FailedBreakout {
  side: Side;
  level: LiquidityLevel;
  breakIndex: number;
  failIndex: number;
}

/** A close beyond a level by the buffer that closes back inside within `bars` bars: BEARISH for highs, BULLISH for lows. */
export function detectFailedBreakouts(bars: readonly EngineBar[], levels: readonly LiquidityLevel[], tickSize: number, tickBuffer: number = DHAN_ENGINE_RULES.bosTickBuffer, within: number = DHAN_ENGINE_RULES.failedBreakoutBars): FailedBreakout[] {
  const buf = tickSize * tickBuffer;
  const out: FailedBreakout[] = [];
  for (const lv of levels) {
    for (let i = Math.max(0, lv.knownFrom); i < bars.length; i++) {
      const c = bars[i].close;
      if (!(lv.side === 'HIGH' ? c >= lv.price + buf : c <= lv.price - buf)) continue;
      for (let j = i + 1; j <= Math.min(bars.length - 1, i + within); j++) {
        if (lv.side === 'HIGH' ? bars[j].close < lv.price : bars[j].close > lv.price) {
          out.push({ side: lv.side === 'HIGH' ? 'BEARISH' : 'BULLISH', level: lv, breakIndex: i, failIndex: j });
          break;
        }
      }
      break;
    }
  }
  return out.sort((a, b) => a.failIndex - b.failIndex);
}

export interface Fvg {
  side: Side;
  top: number;
  bottom: number;
  /** The middle (impulse) bar; known from index + 1. */
  index: number;
  filledAt: number | null;
}

export function fairValueGaps(bars: readonly EngineBar[]): Fvg[] {
  const out: Fvg[] = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2], c = bars[i];
    let g: Fvg | null = null;
    if (a.high < c.low) g = { side: 'BULLISH', bottom: a.high, top: c.low, index: i - 1, filledAt: null };
    else if (a.low > c.high) g = { side: 'BEARISH', bottom: c.high, top: a.low, index: i - 1, filledAt: null };
    if (!g) continue;
    for (let j = i + 1; j < bars.length; j++) {
      if (g.side === 'BULLISH' ? bars[j].low <= g.top : bars[j].high >= g.bottom) { g.filledAt = j; break; }
    }
    out.push(g);
  }
  return out;
}

export interface ReferenceLevels {
  pdh: number | null; pdl: number | null;
  pwh: number | null; pwl: number | null;
  orHigh: number | null; orLow: number | null;
}

/**
 * Previous day / week high-low from completed daily bars (oldest first, today excluded; weeks are ISO weeks in IST)
 * and the opening range from the session's bars in [sessionOpen, sessionOpen + orMinutes).
 */
export function referenceLevels(daily: readonly EngineBar[], session: readonly EngineBar[], sessionOpen: number, orMinutes = 15): ReferenceLevels {
  const prev = daily.at(-1) ?? null;
  const wk = (t: number) => { const d = new Date(t + 19_800_000); const day = (d.getUTCDay() + 6) % 7; return Math.floor((d.getTime() - day * 86_400_000) / 86_400_000 / 7) ; };
  let pwh: number | null = null, pwl: number | null = null;
  if (prev) {
    const thisWeek = wk(sessionOpen);
    const last = daily.filter((b) => wk(b.time) === thisWeek - 1);
    if (last.length) (pwh = Math.max(...last.map((b) => b.high))), (pwl = Math.min(...last.map((b) => b.low)));
  }
  const or = session.filter((b) => b.time >= sessionOpen && b.time < sessionOpen + orMinutes * 60_000);
  return {
    pdh: prev?.high ?? null, pdl: prev?.low ?? null, pwh, pwl,
    orHigh: or.length ? Math.max(...or.map((b) => b.high)) : null,
    orLow: or.length ? Math.min(...or.map((b) => b.low)) : null,
  };
}

/** Confirmed swings plus reference levels as liquidity levels (the opening range is known once it has closed). */
export function liquidityLevels(bars: readonly EngineBar[], ref: ReferenceLevels | null, orEndIndex = -1): LiquidityLevel[] {
  const out: LiquidityLevel[] = confirmedPivots(bars).map((p) => ({ price: p.price, side: p.kind, kind: 'SWING', knownFrom: p.confirmedAt + 1 }));
  const add = (price: number | null, side: 'HIGH' | 'LOW', kind: LiquidityLevel['kind'], from = 0) => { if (price != null) out.push({ price: roundDp(price), side, kind, knownFrom: from }); };
  if (ref) {
    add(ref.pdh, 'HIGH', 'PDH'); add(ref.pdl, 'LOW', 'PDL'); add(ref.pwh, 'HIGH', 'PWH'); add(ref.pwl, 'LOW', 'PWL');
    if (orEndIndex >= 0) { add(ref.orHigh, 'HIGH', 'OR_HIGH', orEndIndex + 1); add(ref.orLow, 'LOW', 'OR_LOW', orEndIndex + 1); }
  }
  return out;
}
