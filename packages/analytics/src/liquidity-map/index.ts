// ============================================================
// CANONICAL LIQUIDITY MAP (pure) — Stage 2, signal-diagnostics
// ============================================================
// A single source of truth for "what liquidity pools exist" that the
// structure engine and research/diagnostics code can both use.
//
// `buildTradeablePools` is the EXACT algorithm that used to live inline in
// the structure engine (packages/analytics/src/structure-engine/index.ts,
// formerly `buildLiquidityPools` lines ~316-429): previous-day high/low,
// equal highs/lows, session high/low, opening range, untaken 5-bar swing
// fractals. It is moved here verbatim (not reimplemented) so the structure
// engine's decisions stay byte-identical when it delegates to this module —
// see structure-engine/index.ts's `buildLiquidityPools`, which is now a thin
// wrapper around `buildTradeablePools`.
//
// `buildLiquidityMap` wraps the same candidate pools (plus new
// research-only pool types: previous close, weekly high/low, monthly
// high/low) with diagnostic metadata: id, createdAt, ageBars, testedCount,
// swept/sweptAt, strength, distanceAtr and status. This richer view is for
// `setup_events` / diagnostics ONLY. Research-only pool kinds must never be
// used by the structure engine's sweep detection or T1 selection — they are
// filtered out of `buildTradeablePools`'s output by construction.
// ============================================================

import { type MomentumSeries, type MomentumBar } from '../momentum-break/index.js';

export type TradeablePoolKind =
  | 'PREV_DAY_HIGH'
  | 'PREV_DAY_LOW'
  | 'EQUAL_HIGHS'
  | 'EQUAL_LOWS'
  | 'SESSION_HIGH'
  | 'SESSION_LOW'
  | 'OPENING_RANGE_HIGH'
  | 'OPENING_RANGE_LOW'
  | 'SWING_HIGH'
  | 'SWING_LOW';

export type ResearchOnlyPoolKind = 'PREV_CLOSE' | 'WEEK_HIGH' | 'WEEK_LOW' | 'MONTH_HIGH' | 'MONTH_LOW';

export type PoolKind = TradeablePoolKind | ResearchOnlyPoolKind;

export const TRADEABLE_POOL_KINDS: readonly TradeablePoolKind[] = [
  'PREV_DAY_HIGH',
  'PREV_DAY_LOW',
  'EQUAL_HIGHS',
  'EQUAL_LOWS',
  'SESSION_HIGH',
  'SESSION_LOW',
  'OPENING_RANGE_HIGH',
  'OPENING_RANGE_LOW',
  'SWING_HIGH',
  'SWING_LOW',
];

export const RESEARCH_ONLY_POOL_KINDS: readonly ResearchOnlyPoolKind[] = ['PREV_CLOSE', 'WEEK_HIGH', 'WEEK_LOW', 'MONTH_HIGH', 'MONTH_LOW'];

/** Pool rank. Lower = more liquidity resting there. Research-only kinds rank last (untested). */
export const POOL_RANK: Record<PoolKind, number> = {
  PREV_DAY_HIGH: 1,
  PREV_DAY_LOW: 1,
  EQUAL_HIGHS: 2,
  EQUAL_LOWS: 2,
  SESSION_HIGH: 3,
  SESSION_LOW: 3,
  OPENING_RANGE_HIGH: 4,
  OPENING_RANGE_LOW: 4,
  SWING_HIGH: 5,
  SWING_LOW: 5,
  PREV_CLOSE: 6,
  WEEK_HIGH: 6,
  WEEK_LOW: 6,
  MONTH_HIGH: 6,
  MONTH_LOW: 6,
};

/** The narrow shape the structure engine has always used. Unchanged. Generic so tradeable and research-only pools stay distinct types. */
export interface BasePool<K extends PoolKind = PoolKind> {
  kind: K;
  side: 'HIGH' | 'LOW';
  price: number;
  rank: number;
}

export interface LiquidityMapRules {
  equalTolAtr: number;
  poolMergeAtr: number;
  openingRangeMinutes: number;
  swingLookback: number;
  swingSessions: number;
}

export const LIQUIDITY_MAP_DEFAULT_RULES: LiquidityMapRules = {
  equalTolAtr: 0.1,
  poolMergeAtr: 0.1,
  openingRangeMinutes: 30,
  swingLookback: 2,
  swingSessions: 3,
};

const BAR_MS_15M = 15 * 60 * 1000;

/**
 * The Tier-1 (tradeable) pools for session ordinal `s`, from bars [.., end)
 * only. Pools a later visible bar has already traded through are dropped
 * (taken). Pools within poolMergeAtr of a better-ranked pool on the same
 * side merge into it.
 *
 * MOVED VERBATIM from structure-engine's `buildLiquidityPools`. Do not
 * change this function's logic without re-proving the 315 golden snapshots
 * and the structure/5m/patterns report parity tests — the structure engine
 * delegates to it directly.
 */
export function buildTradeablePools(
  series: MomentumSeries,
  s: number,
  end: number,
  atr: number,
  rules: LiquidityMapRules = LIQUIDITY_MAP_DEFAULT_RULES
): BasePool<TradeablePoolKind>[] {
  const { bars } = series;
  // s may be one past the last session: "today" has no bar in the series yet
  // (the MTF engine before today's first 15m bar closes). It then starts at
  // the series end, so only the previous-day and fractal pools exist.
  const start = series.sessionStarts[s] ?? bars.length;
  const e = Math.min(end, bars.length);
  const raw: BasePool<TradeablePoolKind>[] = [];
  const takenAbove = (price: number, from: number) => {
    for (let j = from; j < e; j++) if (bars[j].high > price) return true;
    return false;
  };
  const takenBelow = (price: number, from: number) => {
    for (let j = from; j < e; j++) if (bars[j].low < price) return true;
    return false;
  };

  // 1. Previous session high/low, taken if today traded through it.
  if (s > 0) {
    const pStart = series.sessionStarts[s - 1];
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = pStart; j < start; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    if (Number.isFinite(hi) && !takenAbove(hi, start)) raw.push({ kind: 'PREV_DAY_HIGH', side: 'HIGH', price: hi, rank: 1 });
    if (Number.isFinite(lo) && !takenBelow(lo, start)) raw.push({ kind: 'PREV_DAY_LOW', side: 'LOW', price: lo, rank: 1 });
  }

  // 3. Session high/low so far (never taken by construction).
  if (e > start) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = start; j < e; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    raw.push({ kind: 'SESSION_HIGH', side: 'HIGH', price: hi, rank: 3 }, { kind: 'SESSION_LOW', side: 'LOW', price: lo, rank: 3 });

    // 4. Opening range, once every bar in it has closed.
    const orEnd = bars[start].time + rules.openingRangeMinutes * 60 * 1000;
    if (bars[e - 1].time + BAR_MS_15M >= orEnd) {
      let orHi = -Infinity;
      let orLo = Infinity;
      let after = e;
      for (let j = start; j < e; j++) {
        if (bars[j].time < orEnd) {
          orHi = Math.max(orHi, bars[j].high);
          orLo = Math.min(orLo, bars[j].low);
        } else if (after === e) after = j;
      }
      if (Number.isFinite(orHi) && !takenAbove(orHi, after)) raw.push({ kind: 'OPENING_RANGE_HIGH', side: 'HIGH', price: orHi, rank: 4 });
      if (Number.isFinite(orLo) && !takenBelow(orLo, after)) raw.push({ kind: 'OPENING_RANGE_LOW', side: 'LOW', price: orLo, rank: 4 });
    }
  }

  // 5 (and 2). Untaken 5-bar fractals from the last `swingSessions` sessions;
  // a fractal at k is confirmed once bar k + lookback is visible.
  const lb = rules.swingLookback;
  const wFrom = series.sessionStarts[Math.max(0, s - (rules.swingSessions - 1))];
  const highs: Array<{ p: number; k: number }> = [];
  const lows: Array<{ p: number; k: number }> = [];
  for (let k = wFrom + lb; k + lb < e; k++) {
    let peak = true;
    let trough = true;
    for (let d = 1; d <= lb; d++) {
      if (bars[k].high <= bars[k - d].high || bars[k].high <= bars[k + d].high) peak = false;
      if (bars[k].low >= bars[k - d].low || bars[k].low >= bars[k + d].low) trough = false;
    }
    if (peak) highs.push({ p: bars[k].high, k });
    if (trough) lows.push({ p: bars[k].low, k });
  }
  // Equal highs/lows: two confirmed swings within equalTolAtr. The later one
  // usually pokes a hair past the earlier, so the pair is judged as one pool
  // at its outer price, taken only if traded through after the later swing.
  // Unpaired swings stand alone (rank 5) while untaken.
  const tol = rules.equalTolAtr * atr;
  const pairUp = (swings: Array<{ p: number; k: number }>, side: 'HIGH' | 'LOW') => {
    const high = side === 'HIGH';
    const taken = (price: number, from: number) => (high ? takenAbove(price, from) : takenBelow(price, from));
    const used = new Set<number>();
    const sorted = swings.map((w, idx) => ({ ...w, idx })).sort((a, b) => a.p - b.p);
    for (let a = 0; a + 1 < sorted.length; a++) {
      const x = sorted[a];
      const y = sorted[a + 1];
      if (used.has(x.idx) || used.has(y.idx) || Math.abs(y.p - x.p) > tol) continue;
      const price = high ? Math.max(x.p, y.p) : Math.min(x.p, y.p);
      if (taken(price, Math.max(x.k, y.k) + 1)) continue;
      used.add(x.idx);
      used.add(y.idx);
      raw.push({ kind: high ? 'EQUAL_HIGHS' : 'EQUAL_LOWS', side, price, rank: 2 });
    }
    swings.forEach((w, idx) => {
      if (!used.has(idx) && !taken(w.p, w.k + 1)) raw.push({ kind: high ? 'SWING_HIGH' : 'SWING_LOW', side, price: w.p, rank: 5 });
    });
  };
  pairUp(highs, 'HIGH');
  pairUp(lows, 'LOW');

  // Merge near-duplicates into the better-ranked pool.
  const merge = rules.poolMergeAtr * atr;
  const kept: BasePool<TradeablePoolKind>[] = [];
  for (const p of [...raw].filter((p) => Number.isFinite(p.price) && p.price > 0).sort((a, b) => a.rank - b.rank || a.price - b.price)) {
    if (!kept.some((k) => k.side === p.side && Math.abs(k.price - p.price) <= merge)) kept.push(p);
  }
  return kept.sort((a, b) => a.price - b.price);
}

// ---------------- research-only pool types ----------------

/**
 * Previous close, and trailing weekly/monthly high-low (last 5 / 21
 * sessions, a rolling approximation of the calendar week/month since the
 * saved series carries no calendar-week metadata). UNTESTED — Stage 1 never
 * evaluated these; they're research-only until a clean test is run, so they
 * must never feed the structure engine's sweep detection or T1.
 */
export function buildResearchOnlyPools(series: MomentumSeries, s: number, end: number): BasePool<ResearchOnlyPoolKind>[] {
  const { bars } = series;
  const start = series.sessionStarts[s] ?? bars.length;
  const e = Math.min(end, bars.length);
  const out: BasePool<ResearchOnlyPoolKind>[] = [];

  if (s > 0 && start > 0) {
    out.push({ kind: 'PREV_CLOSE', side: 'HIGH', price: bars[start - 1].close, rank: POOL_RANK.PREV_CLOSE });
  }

  const rollingExtreme = (sessionsBack: number, kindHi: ResearchOnlyPoolKind, kindLo: ResearchOnlyPoolKind) => {
    const fromSession = Math.max(0, s - (sessionsBack - 1));
    const from = series.sessionStarts[fromSession] ?? 0;
    if (e <= from) return;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = from; j < e; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    if (Number.isFinite(hi)) out.push({ kind: kindHi, side: 'HIGH', price: hi, rank: POOL_RANK[kindHi] });
    if (Number.isFinite(lo)) out.push({ kind: kindLo, side: 'LOW', price: lo, rank: POOL_RANK[kindLo] });
  };
  rollingExtreme(5, 'WEEK_HIGH', 'WEEK_LOW');
  rollingExtreme(21, 'MONTH_HIGH', 'MONTH_LOW');

  return out;
}

// ---------------- diagnostic (metadata-rich) view ----------------

export type PoolStatus = 'ACTIVE' | 'TESTED' | 'SWEPT' | 'INVALIDATED';

export interface LiquidityMapPool extends BasePool {
  /** Deterministic from symbol + type + price + createdAt. */
  id: string;
  /** Epoch ms of the bar that established the pool (best-effort; session start when the exact origin bar isn't tracked). */
  createdAt: number;
  ageBars: number;
  testedCount: number;
  swept: boolean;
  sweptAt: number | null;
  /** Rank-based: POOL_RANK 1 -> 100 down to 6 -> 10 (documented formula, no fit). */
  strength: number;
  distanceAtr: number | null;
  status: PoolStatus;
  researchOnly: boolean;
}

const STRENGTH_BY_RANK: Record<number, number> = { 1: 100, 2: 80, 3: 60, 4: 40, 5: 20, 6: 10 };

export function poolId(symbol: string, kind: PoolKind, price: number, createdAt: number): string {
  return `${symbol}:${kind}:${price.toFixed(2)}:${createdAt}`;
}

/**
 * Wraps `buildTradeablePools` + `buildResearchOnlyPools` with diagnostic
 * metadata for `setup_events` / the Signal Diagnostics dashboard. NOT used
 * by the structure engine. `referenceClose`/`referenceAtr` are the values to
 * measure distanceAtr from (typically the evaluated bar's close and ATR).
 */
export function buildLiquidityMap(
  symbol: string,
  series: MomentumSeries,
  s: number,
  end: number,
  atr: number,
  opts: { referenceClose?: number; rules?: LiquidityMapRules } = {}
): LiquidityMapPool[] {
  const rules = opts.rules ?? LIQUIDITY_MAP_DEFAULT_RULES;
  const { bars } = series;
  const start = series.sessionStarts[s] ?? bars.length;
  const e = Math.min(end, bars.length);
  const createdAt = bars[start]?.time ?? bars[Math.max(0, e - 1)]?.time ?? 0;
  const referenceClose = opts.referenceClose ?? (e > 0 ? bars[e - 1].close : NaN);

  const decorate = (p: BasePool, researchOnly: boolean): LiquidityMapPool => {
    const ageBars = Math.max(0, e - start);
    // A "test" is a later bar in [start, e) whose high/low came within
    // poolMergeAtr of the pool without invalidating it (it's still in the
    // surviving/untaken set by construction of the two builders above).
    let testedCount = 0;
    const tol = rules.poolMergeAtr * atr;
    for (let j = start; j < e; j++) {
      const touch = p.side === 'HIGH' ? p.price - bars[j].high : bars[j].low - p.price;
      if (touch >= 0 && touch <= tol) testedCount++;
    }
    const distanceAtr = Number.isFinite(referenceClose) && atr > 0 ? Math.abs(referenceClose - p.price) / atr : null;
    return {
      ...p,
      id: poolId(symbol, p.kind, p.price, createdAt),
      createdAt,
      ageBars,
      testedCount,
      swept: false,
      sweptAt: null,
      strength: STRENGTH_BY_RANK[p.rank] ?? 10,
      distanceAtr,
      status: testedCount > 0 ? 'TESTED' : 'ACTIVE',
      researchOnly,
    };
  };

  const tradeable = buildTradeablePools(series, s, end, atr, rules).map((p) => decorate(p, false));
  const research = buildResearchOnlyPools(series, s, end).map((p) => decorate(p, true));
  return [...tradeable, ...research];
}
