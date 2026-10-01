// ============================================================
// SWEEP_CLOSE — pre-registered, clean re-test (research only)
// ============================================================
// Everything is fixed BEFORE looking at a result (see the approved plan,
// Stage 1). It fixes the three defects the earlier +0.27R estimate had:
//
//   1. The candidate set is EVERY sweep `findSweep` detects (1-bar and
//      2-bar), never filtered by what happens after the trigger bar (the
//      old code only kept sweeps the engine later labelled NO_DISPLACEMENT,
//      a label that needs the next 3 bars and silently dropped the 549 OOS
//      sweeps that reclaimed instead).
//   2. The stop uses the sweep bar(s)' OWN extreme (bars <= the trigger)
//      only — never `st.sweep.extreme` after the engine widens it on later
//      bars (structure-engine/index.ts ~L696, before its NO_DISPLACEMENT
//      check at ~L711). The first three bars are not stop-proof here.
//   3. T1 uses the shared `nearestOppositePool` helper (extracted from the
//      engine's own `confirm()`, byte-identical) and a hard 1.5R floor: below
//      it (or with no T1 at all) the setup is logged LOW_RR / NO_TARGET and
//      graded in a separate REJECTED bucket — it is never counted as a trade.
//   4. One trade at a time per symbol: once a trade is open (or the fixed
//      LOW_RR/NO_TARGET geometry says one would be), no new trigger is
//      evaluated for that symbol until the running trade exits. A rejected
//      (LOW_RR/NO_TARGET) signal does not occupy the symbol — it holds no
//      position — so the next real trigger is still evaluated on the very
//      next bar.
//
// LOOK-AHEAD CONTRACT: for a trigger at bar j, everything that decides it —
// the sweep itself, `entry` (bars[j].close), `stop` (the sweep bar(s)'
// extreme, bars <= j), and T1 (pools built from bars < j, via `findSweep`'s
// own `poolsAt`) — reads only bars <= j. Appending bars after j can never
// change any of them. `sweep-close-lookahead.test.ts` holds this.
//
// Displacement (whether the engine's own displacement print followed within
// 3 bars) is recorded on every graded row, but purely as LATER information:
// it plays no part in the trigger, the entry, the stop, the target, or which
// bucket a setup lands in.
// ============================================================

import {
  momentumAtrAt,
  MOMENTUM_BREAK_RULES,
  STRUCTURE_RULES,
  findSweep,
  buildLiquidityPools,
  nearestOppositePool,
  isDisplacement,
  type MomentumSeries,
  type StructureDirection,
  type LiquidityPool,
} from '@fno/analytics';
import { getSessionWindow, type Exchange } from '@fno/shared';
import type { LoadedSymbol } from '../backtest/harness.js';
import { gradePath } from '../services/grade-path.js';
import { round } from './stats.js';

/** Live session rules unique to this test (the plan's Stage 1, not the harness's 60-min opening guard). */
export const SWEEP_CLOSE_SETTLE_MIN = 5;
export const SWEEP_CLOSE_CLOSING_GUARD_MIN = 60;
/** Displacement is recorded on DISP_MULT = 1.0 (the live default variant), later-information only. */
const DISPLACEMENT_MULT = 1.0;

export type SweepCloseBucket = 'TRADE' | 'LOW_RR' | 'NO_TARGET';

export interface SweepCloseRow {
  symbol: string;
  session: string;
  direction: StructureDirection;
  triggerIndex: number;
  triggerBarTime: number;
  triggerBars: 1 | 2;
  poolKind: string;
  poolRank: number;
  entry: number;
  stop: number;
  atr: number;
  stopPoints: number;
  stopAtr: number;
  t1: number | null;
  t1Kind: string | null;
  rToT1: number | null;
  bucket: SweepCloseBucket;
  /** Settled R against the stop distance (gradePath's convention: -1 at the stop). Before any cost. */
  grossR: number;
  exitKind: 'STOP' | 'TARGET' | 'SESSION_END';
  mfeR: number;
  maeR: number;
  barsHeld: number;
  /** LATER information only — not tradable at the trigger. */
  displacedWithin3: boolean;
}

function poolsAtFactory(series: MomentumSeries, s: number) {
  const cache = new Map<number, { atr: number; pools: LiquidityPool[] } | null>();
  return (e: number) => {
    if (!cache.has(e)) {
      const atr = momentumAtrAt(series, e, MOMENTUM_BREAK_RULES);
      cache.set(e, atr != null ? { atr, pools: buildLiquidityPools(series, s, e, atr, STRUCTURE_RULES) } : null);
    }
    return cache.get(e)!;
  };
}

/**
 * Every SWEEP_CLOSE row for one symbol's whole (unmasked) history: every
 * sweep `findSweep` detects, honouring the live session guards and the
 * one-trade-at-a-time rule, graded with `gradePath` exactly like the harness.
 */
export function runSweepClose(symbol: string, loaded: LoadedSymbol, exchange: Exchange): SweepCloseRow[] {
  const { series, masked } = loaded;
  const rows: SweepCloseRow[] = [];
  const nSessions = series.sessionStarts.length;

  for (let s = 0; s < nSessions; s++) {
    const session = series.sessionDates[s];
    if (masked.has(session)) continue;
    const sessionStart = series.sessionStarts[s];
    const sessionEnd = (s + 1 < nSessions ? series.sessionStarts[s + 1] : series.bars.length) - 1;
    if (sessionEnd < sessionStart) continue;
    const window = getSessionWindow(exchange, session);
    if (!window) continue;

    const poolsAt = poolsAtFactory(series, s);
    let busyUntil = -1; // bar index (inclusive) the symbol stays busy through

    for (let j = sessionStart; j <= sessionEnd; j++) {
      if (j <= busyUntil) continue;
      const closeAt = series.bars[j].time + 15 * 60 * 1000;
      // No trigger in the first 5 minutes of the session.
      if (series.bars[j].time - window.open < SWEEP_CLOSE_SETTLE_MIN * 60 * 1000) continue;
      // No NEW entry in the last 60 minutes (entry is the trigger bar's close).
      if (window.close - closeAt < SWEEP_CLOSE_CLOSING_GUARD_MIN * 60 * 1000) continue;

      for (const direction of ['BEARISH', 'BULLISH'] as StructureDirection[]) {
        const found = findSweep(series, s, j, direction, STRUCTURE_RULES, poolsAt);
        if (!found) continue;
        const bear = direction === 'BEARISH';
        const dir: 1 | -1 = bear ? -1 : 1;
        const atr = found.atr;
        const buf = STRUCTURE_RULES.stopBufferAtr * atr;
        const stop = bear ? found.extreme + buf : found.extreme - buf;
        const entry = series.bars[j].close;
        const risk = Math.abs(entry - stop);
        if (!(risk > 0)) continue;

        // The sweep bar(s) only (bars <= the trigger): 1-bar is just j;
        // 2-bar is j-1 and j. Matches `found.extreme`'s own span.
        const sweepStartIdx = found.bars === 2 ? j - 1 : j;
        let lowSince = Infinity;
        let highSince = -Infinity;
        for (let k = sweepStartIdx; k <= j; k++) {
          lowSince = Math.min(lowSince, series.bars[k].low);
          highSince = Math.max(highSince, series.bars[k].high);
        }
        const poolsAtSweep = poolsAt(j)?.pools ?? [];
        const { t1 } = nearestOppositePool(poolsAtSweep, direction, entry, lowSince, highSince);
        const rToT1 = t1 ? Math.abs(t1.price - entry) / risk : null;

        const bucket: SweepCloseBucket = !t1 ? 'NO_TARGET' : rToT1! < STRUCTURE_RULES.minT1R ? 'LOW_RR' : 'TRADE';
        const targetLevel = bucket === 'NO_TARGET' ? (dir > 0 ? Infinity : -Infinity) : t1!.price;

        const after = series.bars.slice(j + 1, sessionEnd + 1);
        const path = gradePath(after, dir, entry, stop, targetLevel);
        const grossR = round(path.settledR);
        const exitKind: SweepCloseRow['exitKind'] = path.hitStop ? 'STOP' : path.hitTarget ? 'TARGET' : 'SESSION_END';
        const barsHeld = path.exitIndex != null ? path.exitIndex + 1 : after.length;

        // LATER information only: did the engine's own displacement print
        // within 3 bars after the trigger, in the trade's favour? Uses the
        // sweep's own ATR (bars before it) and DISP_MULT 1.0, exactly the
        // live default — never gates or changes the trigger/entry/stop/T1.
        let displacedWithin3 = false;
        for (let k = j + 1; k <= Math.min(j + STRUCTURE_RULES.displacementWithinBars, sessionEnd); k++) {
          if (isDisplacement(series.bars[k], direction, atr, DISPLACEMENT_MULT, STRUCTURE_RULES)) {
            displacedWithin3 = true;
            break;
          }
        }

        rows.push({
          symbol,
          session,
          direction,
          triggerIndex: j,
          triggerBarTime: series.bars[j].time,
          triggerBars: found.bars,
          poolKind: found.pool.kind,
          poolRank: found.pool.rank,
          entry: round(entry, 2),
          stop: round(stop, 2),
          atr: round(atr, 2),
          stopPoints: round(risk, 2),
          stopAtr: round(risk / atr, 3),
          t1: t1 ? round(t1.price, 2) : null,
          t1Kind: t1 ? t1.kind : null,
          rToT1: rToT1 != null ? round(rToT1, 3) : null,
          bucket,
          grossR,
          exitKind,
          mfeR: round(path.mfe / risk, 3),
          maeR: round(path.mae / risk, 3),
          barsHeld,
          displacedWithin3,
        });

        // One trade at a time per symbol: only an actual TRADE occupies the
        // symbol. A LOW_RR/NO_TARGET rejection holds no position.
        if (bucket === 'TRADE') {
          busyUntil = j + barsHeld;
          break; // both directions can't both trigger into a trade on the same bar
        }
      }
    }
  }

  return rows;
}
