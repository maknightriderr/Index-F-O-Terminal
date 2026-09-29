// ============================================================
// STRUCTURE BACKTEST — the structure engine as a harness strategy (pure)
// ============================================================
// The engine (@fno/analytics structure-engine) replays a session bar by bar
// on closed bars and confirms a setup on bar c with its zone, stop and T1 all
// fixed from bars ≤ c. The harness asks, bar by bar, "did a setup confirm on
// bar i?" and places a LIMIT at the zone's near edge for the next 8 bars.
//
// For speed the engine is run once per session (at the session's last bar)
// and the setups confirmed on bar i are read from that replay. That is the
// same answer as replaying at i — every transition up to CONFIRMED depends
// only on bars ≤ c (the engine's no-look-ahead test, and the equivalence
// test in structure-backtest.test.ts). The harness never reads the engine's
// own fill/exit: it simulates the order itself (harness.ts LIMIT rules).
//
// LATE and LOW_RR setups are never placed. Exits: stop (wins ties), T1, a
// close back beyond the sweep extreme (SWEEP_RECLAIMED), or the session end.
// ============================================================

import {
  evaluateStructureSession,
  evaluateStructureSessionMTF,
  STRUCTURE_5M_VARIANTS,
  STRUCTURE_RULES,
  STRUCTURE_RULES_5M,
  STRUCTURE_VARIANTS,
  type StructureSetup,
  type StructureVariant,
} from '@fno/analytics';
import { CLOSING_GUARD_MIN, type BacktestStrategy, type BacktestTrade, type LoadedSymbol } from './harness.js';

export type StructureTrade = BacktestTrade<StructureSetup>;

const sessionCache = new WeakMap<LoadedSymbol, Map<string, StructureSetup[]>>();

/**
 * Every setup of session ordinal s (engine replay at the session's last bar).
 * A symbol loaded with a poolSeries (15m) over a 5m series replays the
 * multi-timeframe engine; otherwise the 15m engine, exactly as shipped.
 */
export function sessionSetups(loaded: LoadedSymbol, s: number, variant: StructureVariant): StructureSetup[] {
  let byKey = sessionCache.get(loaded);
  if (!byKey) {
    byKey = new Map();
    sessionCache.set(loaded, byKey);
  }
  const key = `${variant.id}:${s}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const { series } = loaded;
  const last = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : series.bars.length) - 1;
  const setups =
    last < series.sessionStarts[s]
      ? []
      : loaded.poolSeries
        ? evaluateStructureSessionMTF(loaded.poolSeries, series, last, variant).setups
        : evaluateStructureSession(series, last, variant).setups;
  byKey.set(key, setups);
  return setups;
}

/** Setups that reached CONFIRMED (placed) on bar i. */
export function confirmedAt(loaded: LoadedSymbol, i: number, variant: StructureVariant): StructureSetup[] {
  const s = loaded.series.sessionIdx[i];
  return sessionSetups(loaded, s, variant).filter((st) => st.history.some((h) => h.stage === 'CONFIRMED' && h.barIndex === i));
}

export function displacementBucket(bodyAtr: number | null | undefined): string {
  if (bodyAtr == null) return 'n/a';
  if (bodyAtr < 1.5) return '<1.5 ATR';
  if (bodyAtr < 2) return '1.5-2 ATR';
  if (bodyAtr < 3) return '2-3 ATR';
  return '≥3 ATR';
}

export const STRUCTURE_STRATEGY: BacktestStrategy<StructureVariant, StructureSetup> = {
  name: 'STRUCTURE',
  orderType: 'LIMIT',
  variants: STRUCTURE_VARIANTS,
  evaluate: (loaded, i, variant) => {
    const placed = confirmedAt(loaded, i, variant);
    if (placed.length === 0) return null;
    // Both directions confirming on one bar is rare; take the higher score —
    // the score WITHOUT the candle-pattern bonus (baseTotal), so the bonus can
    // never change which setup is placed.
    return [...placed].sort((a, b) => (b.score?.baseTotal ?? 0) - (a.score?.baseTotal ?? 0))[0];
  },
  toOrder: (st) => ({
    direction: st.direction,
    type: 'LIMIT',
    entry: st.entry!,
    stop: st.stop!,
    target: st.t1!.price,
    fillWithinBars: STRUCTURE_RULES.fillWithinBars,
  }),
  invalidateOnClose: (st) => (b) => (st.direction === 'BEARISH' ? b.close > st.sweep.extreme : b.close < st.sweep.extreme),
  invalidationExit: 'SWEEP_RECLAIMED',
  openingGuard: (v) => v.openingGuard,
  closingGuardMin: (v) => v.closingGuardMin ?? CLOSING_GUARD_MIN,
  groupKeys: {
    'By pool type': (t) => t.signal.pool.kind,
    'By fill hour (IST)': (t) => String(t.fill?.hour ?? t.hour).padStart(2, '0'),
    'By direction': (t) => t.signal.direction,
    'By displacement size': (t) => displacementBucket(t.signal.displacement?.bodyAtr),
    'By zone': (t) => t.signal.zone?.kind ?? 'n/a',
    'By exit': (t) => t.exit,
  },
};

/**
 * The 5m entry timeframe: 15m pools, 5m sweep/displacement/zone/fill
 * (evaluateStructureSessionMTF). Symbols must be loaded as 5m series with
 * the 15m series as poolSeries. The LIMIT rests for 24 × 5m (120 minutes, the
 * same clock time as 8 × 15m); the closing guard is the variant's.
 */
export const STRUCTURE_5M_STRATEGY: BacktestStrategy<StructureVariant, StructureSetup> = {
  ...STRUCTURE_STRATEGY,
  name: 'STRUCTURE_5M',
  variants: STRUCTURE_5M_VARIANTS,
  evaluate: (loaded, i, variant) => {
    if (!loaded.poolSeries) throw new Error(`STRUCTURE_5M needs a 15m poolSeries for ${loaded.spec.symbol}`);
    return STRUCTURE_STRATEGY.evaluate(loaded, i, variant);
  },
  toOrder: (st) => ({ ...STRUCTURE_STRATEGY.toOrder(st), fillWithinBars: STRUCTURE_RULES_5M.fillWithinBars }),
};

/** Stopped out before ever reaching +0.5R — the plan's false-positive definition. */
export function isFalsePositive(t: StructureTrade): boolean {
  return t.exit === 'STOP' && (t.mfeR ?? 0) < 0.5;
}

export interface SetupCounts {
  sweeps: number;
  /** Displacement printed and the setup resolved at confirmation (placed, LATE, LOW_RR or a mitigated zone). */
  confirmedOrLater: number;
  early: number;
  late: number;
  lowRr: number;
  zoneTradedThrough: number;
  noDisplacement: number;
  sweepReclaimed: number;
  superseded: number;
}

export function countSetups(setups: readonly StructureSetup[]): SetupCounts {
  const c: SetupCounts = { sweeps: 0, confirmedOrLater: 0, early: 0, late: 0, lowRr: 0, zoneTradedThrough: 0, noDisplacement: 0, sweepReclaimed: 0, superseded: 0 };
  for (const st of setups) {
    c.sweeps++;
    const stages = st.history.map((h) => h.stage);
    if (stages.includes('CONFIRMED')) c.early++;
    if (st.late) c.late++;
    if (stages.includes('LOW_RR')) c.lowRr++;
    if (st.invalidReason === 'ZONE_TRADED_THROUGH') c.zoneTradedThrough++;
    if (st.invalidReason === 'NO_DISPLACEMENT') c.noDisplacement++;
    if (st.invalidReason === 'SWEEP_RECLAIMED' && !stages.includes('CONFIRMED')) c.sweepReclaimed++;
    if (st.invalidReason === 'SUPERSEDED') c.superseded++;
  }
  c.confirmedOrLater = c.early + c.late + c.lowRr + c.zoneTradedThrough;
  return c;
}
