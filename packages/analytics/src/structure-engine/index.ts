// ============================================================
// STRUCTURE ENGINE — liquidity sweep → displacement → FVG retrace (pure)
// ============================================================
// A third setup family. The consensus read averages ~10 votes, 8 of them
// lagging, so it only turns once a move is over; the momentum-break trigger
// trades breaks, and most breaks fail. This engine trades the failed break:
//
//   1. a Tier-1 liquidity pool (previous-day high/low, equal highs/lows, the
//      session high/low, the opening range, an untaken 5-bar fractal from the
//      last 3 sessions) is SWEPT — traded through by ≥ 0.1 ATR and closed back
//      inside (1 bar), or closed beyond and reclaimed on the next bar (2 bars);
//   2. within 3 bars a DISPLACEMENT bar runs the other way — body ≥ DISP_MULT
//      × ATR, closing in the outer 30% of its range;
//   3. the entry is a LIMIT at the near edge of the displacement's fair-value
//      gap (3-bar gap ≥ 0.1 ATR), or at its 50% level when there is no gap;
//      stop beyond the sweep extreme + 0.1 ATR; T1 the next opposite-side
//      pool that was resting before the sweep and is still untaken, which
//      must be ≥ 1.5R away (else LOW_RR, not traded); T2 the one beyond it.
//
// Lifecycle per symbol and direction:
//   WATCH       price within 0.5 ATR of an untaken pool on the sweep side
//   DEVELOPING  the sweep has printed (displacement pending)
//   CONFIRMED   displacement printed; zone, stop and T1 defined; limit resting
//   ENTRY       the limit filled (the bar that filled it)
//   ACTIVE      the trade is on; it ends on STOP, T1, SWEEP_RECLAIMED (a close
//               back beyond the sweep extreme) or the session's end
//   INVALIDATED SWEEP_RECLAIMED / NO_DISPLACEMENT / ZONE_TRADED_THROUGH /
//               NO_FILL (8 bars) / SUPERSEDED (a deeper sweep replaced it)
//   LATE        price already > 1R toward T1 when it confirmed — not placed
//   MISSED      T1 reached before the limit filled
//   LOW_RR      T1 closer than 1.5R — logged, not traded
//
// LOOK-AHEAD CONTRACT (the same as momentum-break):
//   - Everything runs on CLOSED 15m bars. A decision on bar j reads bars ≤ j.
//     Pools and ATR used to judge bar j come from bars strictly before j.
//   - evaluateStructureSession(series, i) slices the series to [0, i] before
//     doing anything, so appending future bars can never change the state at i.
//   - Session end is NOT known to the engine (that would need the next bar):
//     the backtest harness and the live slot apply it.
//
// MULTI-TIMEFRAME (evaluateStructureSessionMTF): pools stay on 15m bars; the
// sweep, displacement, zone, stop and fill run on CLOSED 5m bars with the
// rules restated in time (STRUCTURE_RULES_5M). A 15m bar contributes pools
// only once it has closed by the 5m bar's close; 5m bars since the last
// closed 15m bar mark pools taken. The 15m function is unchanged — both run
// the same lifecycle machine (runStructureMachine).
//
// The score (0-100) orders and describes setups; it never gates.
//
// CANDLE LABELS (candle-labels.ts): each setup carries `patterns` — the sweep
// candle, the displacement candle and any morning/evening-star combination,
// named from bars at or before the one being judged. Labels never feed a
// decision. The score's Tier 1 adds a small capped bonus for them (below);
// every ordering (the backtest's same-bar tie-break, the live fill pick) reads
// `baseTotal`, the score without that bonus, so it cannot change which setup
// is taken.
// ============================================================

import {
  momentumAtrAt,
  slotVolumeBaseline,
  truncateSeries,
  istSlotOf,
  MOMENTUM_BREAK_RULES,
  type MomentumBar,
  type MomentumSeries,
} from '../momentum-break/index.js';
import { classifyStructureCandles, CLEAN_REJECTION_PATTERNS, type StructureCandlePatterns } from './candle-labels.js';

export * from './candle-labels.js';

export type StructureDirection = 'BULLISH' | 'BEARISH';

export type PoolKind =
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

export interface LiquidityPool {
  kind: PoolKind;
  side: 'HIGH' | 'LOW';
  price: number;
  /** 1 = strongest (previous day) … 5 = an untaken fractal. */
  rank: number;
}

/** Pool rank. Lower = more liquidity resting there. */
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
};

/** The fixed rule. Only DISP_MULT varies, and only across STRUCTURE_VARIANTS. */
export const STRUCTURE_RULES = {
  /** A sweep trades beyond the pool by at least this much ATR. */
  sweepMinAtr: 0.1,
  /** Two confirmed swings within this much ATR are equal highs/lows. */
  equalTolAtr: 0.1,
  /** Pools closer than this (ATR) to a better-ranked pool on the same side are merged into it. */
  poolMergeAtr: 0.1,
  /** Displacement must print within this many bars after the sweep. */
  displacementWithinBars: 3,
  /** Displacement closes in the outer 30% of its range. */
  displacementCloseFrac: 0.3,
  /** Minimum fair-value gap, ATR. */
  fvgMinAtr: 0.1,
  /** Stop beyond the sweep extreme, ATR. */
  stopBufferAtr: 0.1,
  /** T1 must be at least this many R from entry, else LOW_RR. */
  minT1R: 1.5,
  /** WATCH when price is within this much ATR of an untaken pool. */
  watchWithinAtr: 0.5,
  /** The limit must fill within this many bars after CONFIRMED. */
  fillWithinBars: 8,
  /** LATE when price has already moved more than this many R toward T1 at CONFIRMED. */
  lateR: 1,
  openingRangeMinutes: 30,
  /** 5-bar fractal: 2 bars each side. */
  swingLookback: 2,
  /** Untaken fractals from this many sessions (the current one included). */
  swingSessions: 3,
  /** Internal swing (structure shift): 3-bar fractal. */
  internalSwingLookback: 1,
} as const;

export type StructureRules = { readonly [K in keyof typeof STRUCTURE_RULES]: number };

/**
 * The same rule on 5m event bars (evaluateStructureSessionMTF), restated in
 * TIME and pre-registered, not tuned: displacement within 30 minutes (6 × 5m),
 * the limit fills within 120 minutes (24 × 5m — the same clock time as
 * 8 × 15m), internal swing on a 5-bar 5m fractal. Everything else — pool
 * rules (still on 15m bars), ATR fractions, 1.5R, LATE at 1R — is unchanged.
 */
export const STRUCTURE_RULES_5M: StructureRules = {
  ...STRUCTURE_RULES,
  displacementWithinBars: 6,
  fillWithinBars: 24,
  internalSwingLookback: 2,
};

export const STRUCTURE_BAR_MS_15M = 15 * 60 * 1000;
export const STRUCTURE_BAR_MS_5M = 5 * 60 * 1000;

export interface StructureVariant {
  id: string;
  /** Displacement body ≥ dispMult × ATR. */
  dispMult: number;
  /** The live 60-minute opening guard applies to this family's fills. */
  openingGuard: boolean;
  /** Minutes before the session close after which a fill is refused (absent: the harness default, 60). */
  closingGuardMin?: number;
}

/**
 * Pre-registered: DISP_MULT ∈ {1.0, 1.5} × opening-hour guard ∈ {on, off}.
 * The guard is a variant because sweeps cluster in the first hour and the
 * guard was measured on the consensus engine, not on this one.
 */
export const STRUCTURE_VARIANTS: readonly StructureVariant[] = [
  { id: 'D1.0-GUARD', dispMult: 1.0, openingGuard: true },
  { id: 'D1.0-NOGUARD', dispMult: 1.0, openingGuard: false },
  { id: 'D1.5-GUARD', dispMult: 1.5, openingGuard: true },
  { id: 'D1.5-NOGUARD', dispMult: 1.5, openingGuard: false },
] as const;

/**
 * Pre-registered for the 5m entry timeframe (15m pools, 5m events):
 * DISP_MULT ∈ {1.0, 1.5} × closing guard ∈ {60, 15} minutes. The opening
 * guard is fixed OFF, the structure engine's existing choice. One is chosen
 * on in-sample average net R (ties: the earlier-registered) and run once out
 * of sample.
 */
export const STRUCTURE_5M_VARIANTS: readonly StructureVariant[] = [
  { id: '5m-D1.0-C60', dispMult: 1.0, openingGuard: false, closingGuardMin: 60 },
  { id: '5m-D1.0-C15', dispMult: 1.0, openingGuard: false, closingGuardMin: 15 },
  { id: '5m-D1.5-C60', dispMult: 1.5, openingGuard: false, closingGuardMin: 60 },
  { id: '5m-D1.5-C15', dispMult: 1.5, openingGuard: false, closingGuardMin: 15 },
] as const;

/**
 * Pre-registered for the 15m engine's closing guard: the live config (D1.0,
 * no opening guard) with the cutoff at 60 or 15 minutes. Chosen on the 15m
 * IN-SAMPLE period only (average net R; ties keep 60, the incumbent).
 */
export const STRUCTURE_15M_CLOSING_VARIANTS: readonly StructureVariant[] = [
  { id: '15m-D1.0-C60', dispMult: 1.0, openingGuard: false, closingGuardMin: 60 },
  { id: '15m-D1.0-C15', dispMult: 1.0, openingGuard: false, closingGuardMin: 15 },
] as const;

export type StructureStage =
  | 'WATCH'
  | 'DEVELOPING'
  | 'CONFIRMED'
  | 'ENTRY'
  | 'ACTIVE'
  | 'CLOSED'
  | 'INVALIDATED'
  | 'LATE'
  | 'MISSED'
  | 'LOW_RR';

export const TERMINAL_STAGES: readonly StructureStage[] = ['CLOSED', 'INVALIDATED', 'LATE', 'MISSED', 'LOW_RR'];

export type InvalidReason = 'SWEEP_RECLAIMED' | 'NO_DISPLACEMENT' | 'ZONE_TRADED_THROUGH' | 'NO_FILL' | 'SUPERSEDED';
export type StructureExitKind = 'STOP' | 'T1' | 'SWEEP_RECLAIMED';

export interface StructureTransition {
  stage: StructureStage;
  /** Index of the bar whose close (or print, for a fill) caused it. */
  barIndex: number;
  /** Close time of that bar (epoch ms) — when a closed-bar engine can know it. */
  at: number;
  reason?: string;
}

export interface StructureScore {
  total: number;
  /**
   * The total without the candle-pattern bonus — exactly the score before the
   * bonus existed. The only score an ordering may read (same-bar tie-breaks,
   * the live fill pick), so the bonus never changes which setup is taken.
   */
  baseTotal: number;
  /** `candle` is the bonus as applied (after the Tier-1 cap); `sum` includes it. */
  tier1: { poolRank: number; sweepDepth: number; displacement: number; structureShift: number; fvg: number; candle: number; sum: number };
  /** The candle-pattern bonus by component, before the Tier-1 cap (for display). */
  candle: { rejection: number; engulfing: number; star: number; raw: number; applied: number };
  tier2: { positioning: number; oiWall: number; sum: number };
  tier3: { regime: number; volume: number; sum: number };
}

/** Tier 1's maximum: pool 15 + sweep depth 10 + displacement 15 + structure shift 10 + FVG 10. */
export const STRUCTURE_TIER1_MAX = 60;

// Candle-pattern bonus inside Tier 1 (capped at STRUCTURE_TIER1_MAX).
// UNTESTED DEFAULTS: chosen before any outcome was measured; the score
// describes and orders for display only, it never gates.
/** Sweep candle is a clean rejection (hammer, shooting star, pin bar, tweezer). */
export const CANDLE_BONUS_REJECTION = 4;
/** Displacement engulfs the previous candle's body. */
export const CANDLE_BONUS_ENGULFING = 3;
/** Sweep, small-bodied bar, displacement: a morning / evening star. */
export const CANDLE_BONUS_STAR = 3;

export interface StructureSetup {
  /** Stable across replays: direction + sweep bar open time. */
  id: string;
  direction: StructureDirection;
  pool: LiquidityPool;
  sweep: { index: number; barTime: number; bars: 1 | 2; extreme: number; depthAtr: number };
  /** ATR at the sweep (bars before it). */
  atr: number;
  displacement: { index: number; barTime: number; bodyAtr: number; closeLocation: number; structureShift: boolean; volMult: number | null } | null;
  zone: { kind: 'FVG' | 'DISP_50'; near: number; far: number } | null;
  entry: number | null;
  stop: number | null;
  t1: { kind: PoolKind; price: number } | null;
  t2: { kind: PoolKind; price: number } | null;
  /** |T1 − entry| / |entry − stop|. */
  rToT1: number | null;
  /** Index of the bar whose close confirmed it. */
  confirmIndex: number | null;
  fill: { index: number; barTime: number; price: number } | null;
  exit: { kind: StructureExitKind; index: number; price: number } | null;
  stage: StructureStage;
  invalidReason: InvalidReason | null;
  late: boolean;
  history: StructureTransition[];
  score: StructureScore | null;
  variantId: string;
  /** The setup's candles, named (sweep from DEVELOPING, displacement once printed). Descriptive only. */
  patterns: StructureCandlePatterns | null;
}

export interface StructureEvaluation {
  /** The bar evaluated (the newest closed bar). */
  index: number;
  barTime: number;
  atr: number | null;
  /** Pools after bar `index` (from bars ≤ index). */
  pools: LiquidityPool[];
  /** Per direction: the best-ranked untaken pool on the sweep side within 0.5 ATR of the close, when no lifecycle is running. */
  watch: Record<StructureDirection, LiquidityPool | null>;
  /** Every setup of the session so far, in sweep order. */
  setups: StructureSetup[];
}

const BAR_MS = 15 * 60 * 1000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------- liquidity pools ----------------

/**
 * The Tier-1 pools for session ordinal `s`, from bars [.., end) only. Pools a
 * later visible bar has already traded through are dropped (taken). Pools
 * within poolMergeAtr of a better-ranked pool on the same side merge into it.
 */
export function buildLiquidityPools(
  series: MomentumSeries,
  s: number,
  end: number,
  atr: number,
  rules: StructureRules = STRUCTURE_RULES
): LiquidityPool[] {
  const { bars } = series;
  // s may be one past the last session: "today" has no bar in the series yet
  // (the MTF engine before today's first 15m bar closes). It then starts at
  // the series end, so only the previous-day and fractal pools exist.
  const start = series.sessionStarts[s] ?? bars.length;
  const e = Math.min(end, bars.length);
  const raw: LiquidityPool[] = [];
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
    if (bars[e - 1].time + BAR_MS >= orEnd) {
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
  const kept: LiquidityPool[] = [];
  for (const p of [...raw].filter((p) => Number.isFinite(p.price) && p.price > 0).sort((a, b) => a.rank - b.rank || a.price - b.price)) {
    if (!kept.some((k) => k.side === p.side && Math.abs(k.price - p.price) <= merge)) kept.push(p);
  }
  return kept.sort((a, b) => a.price - b.price);
}

// ---------------- helpers ----------------

function isDisplacement(bar: MomentumBar, direction: StructureDirection, atr: number, dispMult: number, rules: StructureRules): { bodyAtr: number; closeLocation: number } | null {
  const span = bar.high - bar.low;
  if (!(span > 0)) return null;
  const body = direction === 'BEARISH' ? bar.open - bar.close : bar.close - bar.open;
  if (!(body > 0)) return null;
  const bodyAtr = body / atr;
  if (bodyAtr < dispMult) return null;
  const closeLocation = direction === 'BEARISH' ? (bar.close - bar.low) / span : (bar.high - bar.close) / span;
  if (closeLocation > rules.displacementCloseFrac) return null;
  return { bodyAtr, closeLocation };
}

/** The most recent confirmed internal swing against the setup (a low for a bearish shift) before bar d. */
function internalSwingBefore(bars: MomentumBar[], from: number, d: number, direction: StructureDirection, rules: StructureRules): number | null {
  const lb = rules.internalSwingLookback;
  for (let k = d - 1 - lb; k >= Math.max(from, lb); k--) {
    let ok = true;
    for (let x = 1; x <= lb; x++) {
      if (direction === 'BEARISH') {
        if (bars[k].low >= bars[k - x].low || bars[k].low >= bars[k + x].low) ok = false;
      } else if (bars[k].high <= bars[k - x].high || bars[k].high <= bars[k + x].high) ok = false;
    }
    if (ok) return direction === 'BEARISH' ? bars[k].low : bars[k].high;
  }
  return null;
}

/**
 * Tier 1 (0-60) plus the pure half of tier 3 (volume, ±5). Tier 2 and the
 * regime half of tier 3 come from the live caller. Tier 1 includes the
 * candle-pattern bonus (+4 clean rejection, +3 engulfing, +3 star), capped so
 * Tier 1 never exceeds its maximum. Describes and orders; never gates.
 */
export function scoreStructureSetup(
  setup: Pick<StructureSetup, 'pool' | 'sweep' | 'displacement' | 'zone'> & { patterns?: StructureCandlePatterns | null },
  dispMult: number,
  live: { positioning?: 'AGREE' | 'CONTRADICT' | null; oiWallInPath?: boolean | null; regimeAlignment?: 'WITH' | 'AGAINST' | null } = {}
): StructureScore {
  const rankPts: Record<number, number> = { 1: 15, 2: 12, 3: 9, 4: 6, 5: 3 };
  const poolRank = rankPts[setup.pool.rank] ?? 0;
  const sweepDepth = Math.round(clamp01((setup.sweep.depthAtr - STRUCTURE_RULES.sweepMinAtr) / 0.9) * 10);
  const displacement = setup.displacement ? Math.round(clamp01(setup.displacement.bodyAtr / dispMult - 1) * 15) : 0;
  const structureShift = setup.displacement?.structureShift ? 10 : 0;
  const fvg = setup.zone?.kind === 'FVG' ? 10 : 0;
  const baseT1 = poolRank + sweepDepth + displacement + structureShift + fvg;
  const p = setup.patterns ?? null;
  const rejection = p && CLEAN_REJECTION_PATTERNS.includes(p.sweepPattern) ? CANDLE_BONUS_REJECTION : 0;
  const engulfing = p?.displacementPattern === 'BULLISH_ENGULFING' || p?.displacementPattern === 'BEARISH_ENGULFING' ? CANDLE_BONUS_ENGULFING : 0;
  const star = p?.combo != null ? CANDLE_BONUS_STAR : 0;
  const raw = rejection + engulfing + star;
  const candle = Math.max(0, Math.min(raw, STRUCTURE_TIER1_MAX - baseT1));
  const t1sum = baseT1 + candle;
  const positioning = live.positioning === 'AGREE' ? 15 : live.positioning === 'CONTRADICT' ? -15 : 0;
  const oiWall = live.oiWallInPath === true ? -10 : live.oiWallInPath === false ? 10 : 0;
  const regime = live.regimeAlignment === 'WITH' ? 10 : live.regimeAlignment === 'AGAINST' ? -10 : 0;
  const vm = setup.displacement?.volMult ?? null;
  const volume = vm == null ? 0 : vm >= 1.5 ? 5 : vm <= 0.7 ? -5 : 0;
  const rest = positioning + oiWall + regime + volume;
  const total = Math.max(0, Math.min(100, t1sum + rest));
  const baseTotal = Math.max(0, Math.min(100, baseT1 + rest));
  return {
    total,
    baseTotal,
    tier1: { poolRank, sweepDepth, displacement, structureShift, fvg, candle, sum: t1sum },
    candle: { rejection, engulfing, star, raw, applied: candle },
    tier2: { positioning, oiWall, sum: positioning + oiWall },
    tier3: { regime, volume, sum: regime + volume },
  };
}

// ---------------- the session replay ----------------

interface Machine {
  current: StructureSetup | null;
}

/**
 * Replays bar i's session from its first bar through bar i and returns every
 * setup with its lifecycle so far, plus the WATCH read at i. Pure; reads
 * bars[0..i] only.
 */
export function evaluateStructureSession(
  seriesIn: MomentumSeries,
  i: number,
  variant: StructureVariant,
  rules: StructureRules = STRUCTURE_RULES
): StructureEvaluation {
  const series = truncateSeries(seriesIn, i + 1);
  const { bars } = series;
  if (i < 0 || i >= bars.length) {
    return { index: i, barTime: NaN, atr: null, pools: [], watch: { BULLISH: null, BEARISH: null }, setups: [] };
  }
  const s = series.sessionIdx[i];
  // Pools from bars < e (with the ATR at e), built once per e.
  const poolCache = new Map<number, { atr: number; pools: LiquidityPool[] } | null>();
  const poolsAt = (e: number) => {
    if (!poolCache.has(e)) {
      const atr = momentumAtrAt(series, e, MOMENTUM_BREAK_RULES);
      poolCache.set(e, atr != null ? { atr, pools: buildLiquidityPools(series, s, e, atr, rules) } : null);
    }
    return poolCache.get(e)!;
  };
  return runStructureMachine({ series, i, variant, rules, barMs: BAR_MS, poolsAt, watchAtr: momentumAtrAt(series, i, MOMENTUM_BREAK_RULES) });
}

// ---------------- multi-timeframe: 15m pools, 5m events ----------------

/** How many bars of `series` have CLOSED by `cutoff` (epoch ms). Bars are sorted, so this is a prefix. */
export function closedBarCount(series: MomentumSeries, cutoff: number, barMs: number): number {
  const { bars } = series;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time + barMs <= cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The liquidity pools a 5m bar e is judged against, from information that
 * existed by the close of 5m bar e − 1 (the 15m engine's "pools from bars <
 * e"): the 15m bars that had CLOSED by then (a 15m bar still forming never
 * contributes a pool), plus — because a 15m bar's high/low is not known until
 * it closes — a scan of the 5m bars since the last closed 15m bar, which
 * marks a pool taken the moment a 5m bar trades through it. Merge and
 * equal-high/low tolerance use the 15m ATR.
 */
export function buildMtfPools(
  pool15: MomentumSeries,
  event5: MomentumSeries,
  e: number,
  rules: StructureRules = STRUCTURE_RULES_5M,
  barMs: { pool: number; event: number } = { pool: STRUCTURE_BAR_MS_15M, event: STRUCTURE_BAR_MS_5M },
  cache?: Map<string, { atr15: number; pools: LiquidityPool[] } | null>
): { atr15: number; pools: LiquidityPool[] } | null {
  const ev = event5.bars;
  if (e <= 0 || e > ev.length) return null;
  const cutoff = ev[e - 1].time + barMs.event;
  // The session bar e belongs to (e = length: the last bar's session, for WATCH).
  const date = event5.sessionDates[event5.sessionIdx[Math.min(e, ev.length - 1)]];
  const n15 = closedBarCount(pool15, cutoff, barMs.pool);
  const key = `${date}:${n15}`;
  let base = cache?.get(key);
  if (base === undefined) {
    const sub = truncateSeries(pool15, n15);
    const last = sub.sessionStarts.length - 1;
    const s15 = last >= 0 && sub.sessionDates[last] === date ? last : sub.sessionStarts.length;
    const atr15 = momentumAtrAt(sub, n15, MOMENTUM_BREAK_RULES);
    base = atr15 != null ? { atr15, pools: buildLiquidityPools(sub, s15, n15, atr15, rules) } : null;
    cache?.set(key, base);
  }
  if (!base) return null;
  const lastClose15 = n15 > 0 ? pool15.bars[n15 - 1].time + barMs.pool : -Infinity;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = e - 1; k >= 0 && ev[k].time >= lastClose15; k--) {
    hi = Math.max(hi, ev[k].high);
    lo = Math.min(lo, ev[k].low);
  }
  return { atr15: base.atr15, pools: base.pools.filter((p) => (p.side === 'HIGH' ? !(hi > p.price) : !(lo < p.price))) };
}

/**
 * The structure engine on two timeframes. Liquidity pools come from the 15m
 * series (and its previous-day and session levels) — the meaningful levels;
 * the reaction runs on the 5m series: the sweep's close-back (depth ≥ 0.1 ×
 * the 5m ATR), the displacement (body ≥ DISP_MULT × the 5m ATR), the FVG zone
 * (≥ 0.1 × the 5m ATR), the stop buffer and the limit fill. T1/T2 are the 15m
 * pools resting before the sweep and still untaken. Rules are
 * STRUCTURE_RULES_5M (restated in time).
 *
 * LOOK-AHEAD CONTRACT: the 5m series is sliced to [0, i5]; a 15m bar is used
 * only once it has CLOSED by the close of the 5m bar being judged
 * (closedBarCount), so appending future 5m or 15m bars never changes the
 * state at i5. WATCH proximity is judged in the 15m ATR (it is about pools);
 * the evaluation's `atr` is the 5m ATR.
 */
export function evaluateStructureSessionMTF(
  pool15: MomentumSeries,
  event5In: MomentumSeries,
  i5: number,
  variant: StructureVariant,
  rules: StructureRules = STRUCTURE_RULES_5M,
  barMs: { pool: number; event: number } = { pool: STRUCTURE_BAR_MS_15M, event: STRUCTURE_BAR_MS_5M }
): StructureEvaluation {
  const series = truncateSeries(event5In, i5 + 1);
  if (i5 < 0 || i5 >= series.bars.length) {
    return { index: i5, barTime: NaN, atr: null, pools: [], watch: { BULLISH: null, BEARISH: null }, setups: [] };
  }
  const baseCache = new Map<string, { atr15: number; pools: LiquidityPool[] } | null>();
  const poolCache = new Map<number, { atr: number; pools: LiquidityPool[]; atr15: number } | null>();
  const poolsAt = (e: number) => {
    if (!poolCache.has(e)) {
      const atr = momentumAtrAt(series, e, MOMENTUM_BREAK_RULES);
      const built = atr != null ? buildMtfPools(pool15, series, e, rules, barMs, baseCache) : null;
      poolCache.set(e, atr != null && built ? { atr, pools: built.pools, atr15: built.atr15 } : null);
    }
    return poolCache.get(e)!;
  };
  // WATCH after bar i5: pools from everything closed by i5's close, judged in the 15m ATR.
  const after = buildMtfPools(pool15, series, i5 + 1, rules, barMs, baseCache);
  return runStructureMachine({
    series,
    i: i5,
    variant,
    rules,
    barMs: barMs.event,
    poolsAt: (e) => (e === i5 + 1 ? (after ? { atr: after.atr15, pools: after.pools } : null) : poolsAt(e)),
    watchAtr: after?.atr15 ?? null,
  });
}

// ---------------- the lifecycle machine (both timeframes) ----------------

interface MachineContext {
  /** The event series, already truncated to [0, i]. */
  series: MomentumSeries;
  i: number;
  variant: StructureVariant;
  rules: StructureRules;
  /** Event bar length (a transition happens at its bar's close). */
  barMs: number;
  /** Pools the event bar e is judged against, with the event-series ATR at e (null without either). */
  poolsAt: (e: number) => { atr: number; pools: LiquidityPool[] } | null;
  /** The ATR the WATCH proximity is judged in at i. */
  watchAtr: number | null;
}

function runStructureMachine(ctx: MachineContext): StructureEvaluation {
  const { series, i, variant, rules, barMs, poolsAt } = ctx;
  const { bars } = series;
  const s = series.sessionIdx[i];
  const start = series.sessionStarts[s];
  const setups: StructureSetup[] = [];
  const machines: Record<StructureDirection, Machine> = { BEARISH: { current: null }, BULLISH: { current: null } };
  const closeAt = (j: number) => bars[j].time + barMs;
  const move = (st: StructureSetup, stage: StructureStage, j: number, reason?: string) => {
    st.stage = stage;
    st.history.push({ stage, barIndex: j, at: closeAt(j), ...(reason ? { reason } : {}) });
  };
  const invalidate = (m: Machine, reason: InvalidReason, j: number) => {
    const st = m.current!;
    st.invalidReason = reason;
    move(st, 'INVALIDATED', j, reason);
    m.current = null;
  };

  for (let j = start; j <= i; j++) {
    const atrJ = momentumAtrAt(series, j, MOMENTUM_BREAK_RULES);
    const bar = bars[j];
    for (const direction of ['BEARISH', 'BULLISH'] as StructureDirection[]) {
      const m = machines[direction];
      const bear = direction === 'BEARISH';
      const beyond = (price: number, level: number) => (bear ? price > level : price < level);

      // ---- advance the running lifecycle ----
      const st = m.current;
      if (st) {
        if (st.stage === 'DEVELOPING' && st.displacement == null) {
          if (beyond(bar.close, st.sweep.extreme)) invalidate(m, 'SWEEP_RECLAIMED', j);
          else {
            st.sweep.extreme = bear ? Math.max(st.sweep.extreme, bar.high) : Math.min(st.sweep.extreme, bar.low);
            const disp = j > st.sweep.index ? isDisplacement(bar, direction, st.atr, variant.dispMult, rules) : null;
            if (disp) {
              const swing = internalSwingBefore(bars, start, j, direction, rules);
              const base = slotVolumeBaseline(series, j, MOMENTUM_BREAK_RULES);
              st.displacement = {
                index: j,
                barTime: bar.time,
                bodyAtr: round2(disp.bodyAtr),
                closeLocation: round2(disp.closeLocation),
                structureShift: swing != null && (bear ? bar.close < swing : bar.close > swing),
                volMult: base.median != null ? round2(bar.volume / base.median) : null,
              };
              // Labels only: bars ≤ j (this displacement bar).
              st.patterns = classifyStructureCandles(bars, st);
            } else if (j - st.sweep.index >= rules.displacementWithinBars) invalidate(m, 'NO_DISPLACEMENT', j);
          }
        } else if (st.stage === 'DEVELOPING' && st.displacement != null) {
          // The bar after the displacement: the gap (if any) is now known.
          if (beyond(bar.close, st.sweep.extreme)) invalidate(m, 'SWEEP_RECLAIMED', j);
          else confirm(st, j);
        } else if (st.stage === 'CONFIRMED') {
          const filled = bear ? bar.high >= st.entry! : bar.low <= st.entry!;
          if (filled) {
            st.fill = { index: j, barTime: bar.time, price: st.entry! };
            move(st, 'ENTRY', j);
            // Conservative: the stop counts on the fill bar, the target does not
            // (it may have printed before the fill).
            if (bear ? bar.high >= st.stop! : bar.low <= st.stop!) closeTrade(st, 'STOP', j, st.stop!);
            else if (beyond(bar.close, st.sweep.extreme)) closeTrade(st, 'SWEEP_RECLAIMED', j, bar.close);
          } else if (bear ? bar.low <= st.t1!.price : bar.high >= st.t1!.price) {
            move(st, 'MISSED', j);
            m.current = null;
          } else if (j - st.confirmIndex! >= rules.fillWithinBars) invalidate(m, 'NO_FILL', j);
        } else if (st.stage === 'ENTRY' || st.stage === 'ACTIVE') {
          if (st.stage === 'ENTRY') move(st, 'ACTIVE', j);
          if (bear ? bar.high >= st.stop! : bar.low <= st.stop!) closeTrade(st, 'STOP', j, st.stop!);
          else if (bear ? bar.low <= st.t1!.price : bar.high >= st.t1!.price) closeTrade(st, 'T1', j, st.t1!.price);
          else if (beyond(bar.close, st.sweep.extreme)) closeTrade(st, 'SWEEP_RECLAIMED', j, bar.close);
        }
        if (m.current && TERMINAL_STAGES.includes(m.current.stage)) m.current = null;
      }

      // ---- a new sweep (only when idle, or superseding a sweep still waiting for displacement) ----
      const cur = m.current;
      const open = cur == null || (cur.stage === 'DEVELOPING' && cur.displacement == null && cur.sweep.index < j);
      if (!open || atrJ == null) continue;
      const found = findSweep(series, s, j, direction, rules, poolsAt);
      if (!found) continue;
      // A running sweep is only replaced by one that reaches further.
      if (cur && !(bear ? found.extreme > cur.sweep.extreme : found.extreme < cur.sweep.extreme)) continue;
      if (cur) invalidate(m, 'SUPERSEDED', j);
      const setup: StructureSetup = {
        id: `${direction}:${bars[j].time}`,
        direction,
        pool: found.pool,
        sweep: { index: j, barTime: bars[j].time, bars: found.bars, extreme: found.extreme, depthAtr: round2(found.depth / found.atr) },
        atr: found.atr,
        displacement: null,
        zone: null,
        entry: null,
        stop: null,
        t1: null,
        t2: null,
        rToT1: null,
        confirmIndex: null,
        fill: null,
        exit: null,
        stage: 'DEVELOPING',
        invalidReason: null,
        late: false,
        history: [],
        score: null,
        variantId: variant.id,
        patterns: null,
      };
      // Labels only: the sweep candle(s), bars ≤ j.
      setup.patterns = classifyStructureCandles(bars, setup);
      move(setup, 'DEVELOPING', j, `${found.pool.kind} ${round2(found.pool.price)} swept (${found.bars}-bar)`);
      setups.push(setup);
      m.current = setup;
    }
  }

  function closeTrade(st: StructureSetup, kind: StructureExitKind, j: number, price: number) {
    st.exit = { kind, index: j, price };
    move(st, 'CLOSED', j, kind);
    machines[st.direction].current = null;
  }

  function confirm(st: StructureSetup, c: number) {
    const bear = st.direction === 'BEARISH';
    const d = st.displacement!.index;
    const atr = st.atr;
    st.sweep.extreme = bear ? Math.max(st.sweep.extreme, bars[c].high) : Math.min(st.sweep.extreme, bars[c].low);
    // Zone: the displacement's 3-bar fair-value gap, else its 50% level.
    let zone: StructureSetup['zone'] = null;
    if (d - 1 >= 0) {
      const gap = bear ? bars[d - 1].low - bars[c].high : bars[c].low - bars[d - 1].high;
      if (gap >= rules.fvgMinAtr * atr) zone = bear ? { kind: 'FVG', near: bars[c].high, far: bars[d - 1].low } : { kind: 'FVG', near: bars[c].low, far: bars[d - 1].high };
    }
    if (!zone) {
      const mid = (bars[d].high + bars[d].low) / 2;
      zone = { kind: 'DISP_50', near: mid, far: mid };
    }
    st.zone = { kind: zone.kind, near: round2(zone.near), far: round2(zone.far) };
    const entry = zone.near;
    const stop = bear ? st.sweep.extreme + rules.stopBufferAtr * atr : st.sweep.extreme - rules.stopBufferAtr * atr;
    const risk = Math.abs(stop - entry);
    st.entry = round2(entry);
    st.stop = round2(stop);
    // Targets: the opposite-side pools that were resting BEFORE the sweep and
    // are still untaken at c, beyond the entry. A session low printed by the
    // displacement itself is not resting liquidity — counting it would make
    // the displacement's own low the target of nearly every setup.
    let lowSince = Infinity;
    let highSince = -Infinity;
    for (let k = st.sweep.index; k <= c; k++) {
      lowSince = Math.min(lowSince, bars[k].low);
      highSince = Math.max(highSince, bars[k].high);
    }
    const pools = (poolsAt(st.sweep.index)?.pools ?? [])
      .filter((p) => p.side === (bear ? 'LOW' : 'HIGH') && (bear ? p.price < entry && p.price < lowSince : p.price > entry && p.price > highSince))
      .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry) || a.rank - b.rank);
    const t1 = pools[0] ?? null;
    const t2 = pools.find((p) => t1 != null && Math.abs(p.price - entry) > Math.abs(t1.price - entry)) ?? null;
    st.t1 = t1 ? { kind: t1.kind, price: round2(t1.price) } : null;
    st.t2 = t2 ? { kind: t2.kind, price: round2(t2.price) } : null;
    st.rToT1 = t1 && risk > 0 ? round2(Math.abs(t1.price - entry) / risk) : null;
    st.score = scoreStructureSetup(st, variant.dispMult);
    const m = machines[st.direction];

    // A 50% level the confirming bar already traded to has been mitigated.
    if (zone.kind === 'DISP_50' && (bear ? bars[c].high >= entry : bars[c].low <= entry)) return invalidate(m, 'ZONE_TRADED_THROUGH', c);
    if (!(risk > 0) || !t1 || st.rToT1! < rules.minT1R) {
      move(st, 'LOW_RR', c, t1 ? `T1 ${t1.kind} at ${st.rToT1}R < ${rules.minT1R}R` : 'no opposite-side pool');
      m.current = null;
      return;
    }
    st.confirmIndex = c;
    const progressed = bear ? entry - bars[c].close : bars[c].close - entry;
    if (progressed > rules.lateR * risk) {
      st.late = true;
      move(st, 'LATE', c, `price already ${round2(progressed / risk)}R toward T1`);
      m.current = null;
      return;
    }
    move(st, 'CONFIRMED', c);
  }

  // WATCH at i: the nearest untaken sweep-side pool within 0.5 ATR, for an idle direction.
  const atrI = momentumAtrAt(series, i, MOMENTUM_BREAK_RULES);
  const watchAtr = ctx.watchAtr;
  const pools = poolsAt(i + 1)?.pools ?? [];
  const close = bars[i].close;
  const watchFor = (direction: StructureDirection): LiquidityPool | null => {
    if (watchAtr == null || machines[direction].current != null) return null;
    const side = direction === 'BEARISH' ? 'HIGH' : 'LOW';
    const near = pools
      .filter((p) => p.side === side && (side === 'HIGH' ? p.price >= close : p.price <= close) && Math.abs(p.price - close) <= rules.watchWithinAtr * watchAtr)
      .sort((a, b) => a.rank - b.rank || Math.abs(a.price - close) - Math.abs(b.price - close));
    return near[0] ?? null;
  };

  return {
    index: i,
    barTime: bars[i].time,
    atr: atrI != null ? round2(atrI) : null,
    pools,
    watch: { BEARISH: watchFor('BEARISH'), BULLISH: watchFor('BULLISH') },
    setups,
  };
}

/**
 * A sweep on bar j for `direction` (BEARISH = a HIGH pool swept). 1-bar: bar j
 * trades ≥ sweepMinAtr beyond a pool (from bars < j) and closes back inside.
 * 2-bar: bar j-1 closed beyond a pool (from bars < j-1) and bar j closes back
 * inside. The best-ranked pool wins, then the deeper sweep.
 */
function findSweep(
  series: MomentumSeries,
  s: number,
  j: number,
  direction: StructureDirection,
  rules: StructureRules,
  poolsAt: (e: number) => { atr: number; pools: LiquidityPool[] } | null
): { pool: LiquidityPool; bars: 1 | 2; extreme: number; depth: number; atr: number } | null {
  const { bars } = series;
  const bear = direction === 'BEARISH';
  const side = bear ? 'HIGH' : 'LOW';
  const start = series.sessionStarts[s];
  const candidates: Array<{ pool: LiquidityPool; bars: 1 | 2; extreme: number; depth: number; atr: number }> = [];

  const atJ = poolsAt(j);
  if (atJ != null) {
    const atrJ = atJ.atr;
    for (const p of atJ.pools) {
      if (p.side !== side) continue;
      const depth = bear ? bars[j].high - p.price : p.price - bars[j].low;
      const inside = bear ? bars[j].close < p.price : bars[j].close > p.price;
      if (depth >= rules.sweepMinAtr * atrJ && inside) candidates.push({ pool: p, bars: 1, extreme: bear ? bars[j].high : bars[j].low, depth, atr: atrJ });
    }
  }
  if (j - 1 >= start) {
    const atP = poolsAt(j - 1);
    if (atP != null) {
      const atrP = atP.atr;
      for (const p of atP.pools) {
        if (p.side !== side) continue;
        const brokeClose = bear ? bars[j - 1].close > p.price : bars[j - 1].close < p.price;
        const back = bear ? bars[j].close < p.price : bars[j].close > p.price;
        const extreme = bear ? Math.max(bars[j - 1].high, bars[j].high) : Math.min(bars[j - 1].low, bars[j].low);
        const depth = bear ? extreme - p.price : p.price - extreme;
        if (brokeClose && back && depth >= rules.sweepMinAtr * atrP) candidates.push({ pool: p, bars: 2, extreme, depth, atr: atrP });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.pool.rank - b.pool.rank || b.depth - a.depth);
  const best = candidates[0];
  return { ...best, pool: { ...best.pool, price: round2(best.pool.price) } };
}

/** IST HH:MM of a bar's open, for reports. */
export function structureSlotOf(time: number): string {
  return istSlotOf(time);
}
