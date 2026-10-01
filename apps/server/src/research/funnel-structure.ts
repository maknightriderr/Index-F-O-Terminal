// ============================================================
// FUNNEL A (structure engine) — removed-candidate grading
// ============================================================
// evaluateStructureSession replays a full session once and returns every
// StructureSetup that ever formed, each carrying its own terminal `stage`
// and `invalidReason` (already exported by @fno/analytics — no funnel logic
// is reimplemented here, only the counterfactual grading of setups the live
// engine does NOT trade). Buckets, matching the coordinator's second-pass
// request:
//   - noDisplacement: swept but never displaced (invalidReason NO_DISPLACEMENT).
//     Counterfactual: entry at the SWEEP bar's own close, stop beyond the
//     sweep extreme (+0.1 ATR buffer), target the nearest opposite-side
//     session extreme so far (a session-extreme proxy for "nearest opposite
//     pool" — the pool list at the sweep bar is available but picking the
//     single nearest opposite pool by price is equivalent for this purpose).
//   - late: displaced and zoned, but the confirming close came after the
//     engine's LATE cutoff. Graded with the setup's OWN entry/stop/t1 (these
//     are still computed for a LATE setup) as if it had filled anyway.
//   - lowRr: zoned with R:R below the live minimum. Same grading.
//   - zoneTradedThrough: price ran through the zone before any fill.
//     Graded as if it had filled at the zone's near edge (entry) anyway.
//   - noFill: confirmed, resting, but never touched within the live fill
//     window. Graded as if the fill window had been unlimited.
// SWEEP_RECLAIMED-before-CONFIRMED and SUPERSEDED are out of scope for this
// pass (not requested) and are excluded from every bucket.
// ============================================================

import { evaluateStructureSession, type StructureSetup, type StructureVariant, type MomentumSeries } from '@fno/analytics';
import type { LoadedSymbol } from '../backtest/harness.js';
import { gradePath } from '../services/grade-path.js';
import { round, mean } from './stats.js';

const COST_R = 0.1;
interface Row { symbol: string; session: string; netR: number }

function statsOf(rows: Row[]) {
  const n = rows.length;
  const gains = rows.filter((r) => r.netR > 0).reduce((a, r) => a + r.netR, 0);
  const losses = rows.filter((r) => r.netR <= 0).reduce((a, r) => a - r.netR, 0);
  return {
    trades: n,
    avgNetR: n ? round(mean(rows.map((r) => r.netR))) : null,
    winRate: n ? round(rows.filter((r) => r.netR > 0).length / n, 3) : null,
    profitFactor: losses > 0 ? round(gains / losses) : gains > 0 ? Infinity : null,
    lowN: n < 30,
  };
}

function sessionExtreme(series: MomentumSeries, sessionStart: number, uptoIdx: number, which: 'HIGH' | 'LOW'): number {
  let ext = which === 'HIGH' ? -Infinity : Infinity;
  for (let j = sessionStart; j <= uptoIdx; j++) {
    ext = which === 'HIGH' ? Math.max(ext, series.bars[j].high) : Math.min(ext, series.bars[j].low);
  }
  return ext;
}

function gradeFrom(series: MomentumSeries, sessionEnd: number, startIdx: number, dir: 1 | -1, entry: number, stop: number, target: number): number | null {
  const after = series.bars.slice(startIdx + 1, sessionEnd + 1);
  if (after.length === 0) return null;
  const path = gradePath(after, dir, entry, stop, target);
  return round(path.settledR - COST_R);
}

export interface FunnelAResult {
  buckets: Record<'noDisplacement' | 'late' | 'lowRr' | 'zoneTradedThrough' | 'noFill', { is: ReturnType<typeof statsOf>; oos: ReturnType<typeof statsOf> }>;
}

export function runFunnelA(bundles: Array<{ symbol: string; loaded: LoadedSymbol }>, splitAt: string, variant: StructureVariant): FunnelAResult {
  const rowsByBucket: Record<string, { is: Row[]; oos: Row[] }> = {
    noDisplacement: { is: [], oos: [] },
    late: { is: [], oos: [] },
    lowRr: { is: [], oos: [] },
    zoneTradedThrough: { is: [], oos: [] },
    noFill: { is: [], oos: [] },
  };

  for (const b of bundles) {
    const { series } = b.loaded;
    const nSessions = series.sessionStarts.length;
    for (let s = 0; s < nSessions; s++) {
      const session = series.sessionDates[s];
      if (b.loaded.masked.has(session)) continue;
      const sessionStart = series.sessionStarts[s];
      const sessionEnd = (s + 1 < nSessions ? series.sessionStarts[s + 1] : series.bars.length) - 1;
      if (sessionEnd < sessionStart) continue;
      const evaln = evaluateStructureSession(series, sessionEnd, variant);
      const bucketOf = (target: 'is' | 'oos', bucket: string, netR: number | null) => {
        if (netR == null) return;
        rowsByBucket[bucket][target].push({ symbol: b.symbol, session, netR });
      };
      const target: 'is' | 'oos' = session < splitAt ? 'is' : 'oos';

      for (const st of evaln.setups) {
        const dir: 1 | -1 = st.direction === 'BULLISH' ? 1 : -1;
        if (st.invalidReason === 'NO_DISPLACEMENT') {
          const buf = 0.1 * st.atr;
          const entry = series.bars[st.sweep.index].close;
          const stop = dir === 1 ? st.sweep.extreme - buf : st.sweep.extreme + buf;
          const oppositeExtreme = sessionExtreme(series, sessionStart, st.sweep.index, dir === 1 ? 'HIGH' : 'LOW');
          // Target must sit beyond entry in the trade direction.
          if (dir === 1 && !(oppositeExtreme > entry)) continue;
          if (dir === -1 && !(oppositeExtreme < entry)) continue;
          const netR = gradeFrom(series, sessionEnd, st.sweep.index, dir, entry, stop, oppositeExtreme);
          bucketOf(target, 'noDisplacement', netR);
          continue;
        }
        if (st.entry == null || st.stop == null || st.t1 == null) continue; // nothing to grade for the remaining buckets without a formed zone
        const startIdx = st.confirmIndex ?? st.displacement?.index ?? st.sweep.index;
        if (st.late) {
          const netR = gradeFrom(series, sessionEnd, startIdx, dir, st.entry, st.stop, st.t1.price);
          bucketOf(target, 'late', netR);
        } else if (st.stage === 'LOW_RR' || st.history.some((h) => h.stage === 'LOW_RR')) {
          const netR = gradeFrom(series, sessionEnd, startIdx, dir, st.entry, st.stop, st.t1.price);
          bucketOf(target, 'lowRr', netR);
        } else if (st.invalidReason === 'ZONE_TRADED_THROUGH') {
          const netR = gradeFrom(series, sessionEnd, startIdx, dir, st.entry, st.stop, st.t1.price);
          bucketOf(target, 'zoneTradedThrough', netR);
        } else if (st.invalidReason === 'NO_FILL') {
          const netR = gradeFrom(series, sessionEnd, startIdx, dir, st.entry, st.stop, st.t1.price);
          bucketOf(target, 'noFill', netR);
        }
      }
    }
  }

  const buckets: any = {};
  for (const key of Object.keys(rowsByBucket)) buckets[key] = { is: statsOf(rowsByBucket[key].is), oos: statsOf(rowsByBucket[key].oos) };
  return { buckets };
}
