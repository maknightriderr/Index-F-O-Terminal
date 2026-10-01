// ============================================================
// FUNNEL B (momentum-break) — removed-candidate grading
// ============================================================
// evaluateMomentumBreak (the live engine) returns the FIRST gate that failed
// (NO_LEVEL_BROKEN / RANGE_TOO_SMALL / VOLUME_TOO_LOW / WEAK_CLOSE / CHASING
// / NO_TARGET) and stops there — later gates are never evaluated for that
// bar, matching the live funnel's own first-match-chain semantics (the same
// semantics the /api/loss-attribution/gates read confirms for the live
// consensus engine).
//
// To grade what a removed candidate WOULD have done, this module rebuilds
// the exact same entry/stop/target construction evaluateMomentumBreak uses
// once a level is broken, but skips the specific quality gates (range,
// volume, close-location, chase-distance) — i.e. "if this bar had been
// allowed to trade despite failing gate X, using the engine's own formula
// for everything else". Bars where NO level even broke, or no valid target
// existed, are not counted in any bucket (there is nothing to grade).
// ============================================================

import {
  buildMomentumLevels,
  momentumAtrAt,
  slotVolumeBaseline,
  evaluateMomentumBreak,
  MOMENTUM_BREAK_RULES,
  type MomentumSeries,
  type MomentumBreakVariant,
  type MomentumNoTrigger,
} from '@fno/analytics';
import type { LoadedSymbol } from '../backtest/harness.js';
import { gradePath } from '../services/grade-path.js';
import { round, mean } from './stats.js';

const KIND_ORDER = ['PREV_DAY_HIGH', 'PREV_DAY_LOW', 'OPENING_RANGE_HIGH', 'OPENING_RANGE_LOW', 'DAY_HIGH', 'DAY_LOW', 'SWING_HIGH', 'SWING_LOW', 'PIVOT_R1', 'PIVOT_S1', 'VWAP'];

interface Counterfactual {
  direction: 'BULLISH' | 'BEARISH';
  entry: number;
  stop: number;
  target: number;
}

/**
 * Re-derives the entry/stop/target the live engine would have used for bar i
 * had it ignored the range/volume/close-location/chase gates — but kept the
 * "a level broke" and "a valid target exists" requirements, since those
 * aren't quality gates, they're what makes a candidate exist at all.
 */
function counterfactualSignal(series: MomentumSeries, i: number, rules = MOMENTUM_BREAK_RULES): Counterfactual | null {
  const { bars } = series;
  const s = series.sessionIdx[i];
  if (i === series.sessionStarts[s]) return null;
  const atrNow = momentumAtrAt(series, i, rules);
  if (atrNow == null) return null;
  const bar = bars[i];
  const prevClose = bars[i - 1].close;
  const levels = buildMomentumLevels(series, i, rules);
  const bearish = bar.close < prevClose;
  const direction: 'BULLISH' | 'BEARISH' = bearish ? 'BEARISH' : 'BULLISH';

  const broken = levels
    .filter((l) => (bearish ? prevClose >= l.price && bar.close <= l.price - rules.breakAtr * atrNow : prevClose <= l.price && bar.close >= l.price + rules.breakAtr * atrNow))
    .sort((a, b) => Math.abs(bar.close - a.price) - Math.abs(bar.close - b.price) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  if (broken.length === 0) return null;
  const level = broken[0]; // ignore the chase-distance restriction entirely for the counterfactual

  const sign = bearish ? -1 : 1;
  const stop = bearish
    ? Math.max(level.price + rules.stopBufferAtr * atrNow, bar.close + rules.minStopAtr * atrNow)
    : Math.min(level.price - rules.stopBufferAtr * atrNow, bar.close - rules.minStopAtr * atrNow);
  const stopDist = Math.abs(bar.close - stop);
  const targets = levels
    .filter((l) => l !== level && sign * (l.price - bar.close) >= rules.minTargetR * stopDist)
    .sort((a, b) => Math.abs(a.price - bar.close) - Math.abs(b.price - bar.close) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const target = targets[0];
  if (!target) return null;
  return { direction, entry: bar.close, stop, target: target.price };
}

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

const COST_R = 0.1;

export interface FunnelBResult {
  buckets: Record<'RANGE_TOO_SMALL' | 'VOLUME_TOO_LOW' | 'WEAK_CLOSE' | 'CHASING', { is: ReturnType<typeof statsOf>; oos: ReturnType<typeof statsOf> }>;
  keptForReference: { is: ReturnType<typeof statsOf>; oos: ReturnType<typeof statsOf> };
}

export function runFunnelB(bundles: Array<{ symbol: string; loaded: LoadedSymbol }>, splitAt: string, variant: MomentumBreakVariant): FunnelBResult {
  const rowsByBucket: Record<string, { is: Row[]; oos: Row[] }> = {
    RANGE_TOO_SMALL: { is: [], oos: [] },
    VOLUME_TOO_LOW: { is: [], oos: [] },
    WEAK_CLOSE: { is: [], oos: [] },
    CHASING: { is: [], oos: [] },
  };
  const kept: { is: Row[]; oos: Row[] } = { is: [], oos: [] };

  for (const b of bundles) {
    const { series } = b.loaded;
    for (let i = 1; i < series.bars.length; i++) {
      const sIdx = series.sessionIdx[i];
      const session = series.sessionDates[sIdx];
      if (b.loaded.masked.has(session)) continue;
      const evalResult = evaluateMomentumBreak(series, i, variant);
      const bucket = evalResult.failed as MomentumNoTrigger | null;
      const relevant = bucket === 'RANGE_TOO_SMALL' || bucket === 'VOLUME_TOO_LOW' || bucket === 'WEAK_CLOSE' || bucket === 'CHASING';
      const isKept = evalResult.signal != null;
      if (!relevant && !isKept) continue;

      const cf = isKept
        ? { direction: evalResult.signal!.direction, entry: evalResult.signal!.entry, stop: evalResult.signal!.stop, target: evalResult.signal!.target }
        : counterfactualSignal(series, i);
      if (!cf) continue;

      const sessionEnd = (sIdx + 1 < series.sessionStarts.length ? series.sessionStarts[sIdx + 1] : series.bars.length) - 1;
      const after = series.bars.slice(i + 1, sessionEnd + 1);
      if (after.length === 0) continue;
      const dir: 1 | -1 = cf.direction === 'BULLISH' ? 1 : -1;
      const path = gradePath(after, dir, cf.entry, cf.stop, cf.target);
      const row: Row = { symbol: b.symbol, session, netR: round(path.settledR - COST_R) };
      const target = isKept ? kept : rowsByBucket[bucket!];
      (session < splitAt ? target.is : target.oos).push(row);
    }
  }

  const buckets: any = {};
  for (const key of Object.keys(rowsByBucket)) {
    buckets[key] = { is: statsOf(rowsByBucket[key].is), oos: statsOf(rowsByBucket[key].oos) };
  }
  return { buckets, keptForReference: { is: statsOf(kept.is), oos: statsOf(kept.oos) } };
}
