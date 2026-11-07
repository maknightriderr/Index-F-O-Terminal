// ============================================================
// DHAN ENGINE v2 — PHASE 6 VALIDATION (pure)
// ============================================================
// Grading: a signal's plan (entry, stop, target, in futures prices) is walked forward over the contract's later bars
// of the same session. The first bar to reach the stop or the target decides; a bar reaching BOTH counts as the stop
// (bar data cannot order them — the conservative reading). Unresolved at the session's last bar = OPEN, marked at
// that bar's close. R = (exit − entry) ÷ (entry − stop) for a long, mirrored for a short. Costs are charged in price
// points per round trip and reported as net R beside gross R.
// Report: per cohort — trades, wins, win rate, expectancy (mean R), profit factor, max drawdown in R (on the
// chronological R sequence), net R — with a SAMPLE flag below 200 trades (master prompt Part 19). Chronological
// out-of-sample: the first 70% of trades in time is in-sample, the rest out-of-sample. Walk-forward: k consecutive
// folds by time, each reported on its own. Nothing here tunes a parameter on the result.
// Candle history cannot validate A–D: every setup needs footprint / CVD, which exists only from recording onwards.
// ============================================================

import type { EngineBar, Side } from './common.js';
import { roundDp } from './common.js';

export const DHAN_VALIDATION_VERSION = 'DHAN-VAL-1.0';
export const DHAN_MIN_SAMPLE = 200;

export interface GradeInput { side: Side; entry: number; stop: number; target: number; costPoints?: number }
export interface Graded { outcome: 'TARGET' | 'STOP' | 'OPEN' | 'INVALID'; exitPrice: number | null; exitTime: number | null; r: number | null; netR: number | null; bars: number }

export function gradeSignal(g: GradeInput, after: readonly EngineBar[]): Graded {
  const long = g.side === 'BULLISH';
  const risk = long ? g.entry - g.stop : g.stop - g.entry;
  if (!(risk > 0) || (long ? !(g.target > g.entry) : !(g.target < g.entry))) return { outcome: 'INVALID', exitPrice: null, exitTime: null, r: null, netR: null, bars: 0 };
  const rOf = (px: number) => (long ? px - g.entry : g.entry - px) / risk;
  const done = (outcome: Graded['outcome'], px: number, t: number, k: number): Graded => ({ outcome, exitPrice: px, exitTime: t, r: roundDp(rOf(px), 4), netR: roundDp(rOf(px) - (g.costPoints ?? 0) / risk, 4), bars: k });
  for (let k = 0; k < after.length; k++) {
    const b = after[k];
    const hitStop = long ? b.low <= g.stop : b.high >= g.stop;
    const hitTarget = long ? b.high >= g.target : b.low <= g.target;
    if (hitStop) return done('STOP', g.stop, b.time, k + 1);
    if (hitTarget) return done('TARGET', g.target, b.time, k + 1);
  }
  const last = after.at(-1);
  return last ? done('OPEN', last.close, last.time, after.length) : { outcome: 'OPEN', exitPrice: null, exitTime: null, r: null, netR: null, bars: 0 };
}

export interface GradedTrade { key: string; strategy: string; symbol: string; side: Side; time: number; regime?: string | null; status?: string; r: number | null; netR: number | null; outcome: Graded['outcome'] }

export interface CohortStats {
  trades: number; wins: number; losses: number; open: number; winRate: number | null; expectancyR: number | null; netExpectancyR: number | null;
  profitFactor: number | null; maxDrawdownR: number | null; totalR: number; totalNetR: number; sample: 'OK' | 'SMALL_SAMPLE';
}

export function cohortStats(trades: readonly GradedTrade[]): CohortStats {
  const t = trades.filter((x) => x.r != null && x.outcome !== 'INVALID').slice().sort((a, b) => a.time - b.time);
  const rs = t.map((x) => x.r as number), nets = t.map((x) => x.netR ?? (x.r as number));
  const wins = rs.filter((r) => r > 0).length, losses = rs.filter((r) => r < 0).length;
  const gain = rs.filter((r) => r > 0).reduce((a, r) => a + r, 0), loss = -rs.filter((r) => r < 0).reduce((a, r) => a + r, 0);
  let peak = 0, eq = 0, dd = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return {
    trades: t.length, wins, losses, open: t.filter((x) => x.outcome === 'OPEN').length,
    winRate: t.length ? roundDp(wins / t.length, 4) : null, expectancyR: t.length ? roundDp(sum(rs) / t.length, 4) : null, netExpectancyR: t.length ? roundDp(sum(nets) / t.length, 4) : null,
    profitFactor: loss > 0 ? roundDp(gain / loss, 4) : null, maxDrawdownR: t.length ? roundDp(dd, 4) : null, totalR: roundDp(sum(rs), 4), totalNetR: roundDp(sum(nets), 4),
    sample: t.length >= DHAN_MIN_SAMPLE ? 'OK' : 'SMALL_SAMPLE',
  };
}

/** First `inSample` share of trades by time vs the rest. */
export function chronologicalSplit(trades: readonly GradedTrade[], inSample = 0.7): { inSample: CohortStats; outOfSample: CohortStats; cut: number | null } {
  const t = trades.slice().sort((a, b) => a.time - b.time);
  const k = Math.floor(t.length * inSample);
  return { inSample: cohortStats(t.slice(0, k)), outOfSample: cohortStats(t.slice(k)), cut: t[k]?.time ?? null };
}

/** k consecutive time folds (equal trade counts), each reported on its own. */
export function walkForward(trades: readonly GradedTrade[], folds = 4): Array<{ fold: number; from: number | null; to: number | null; stats: CohortStats }> {
  const t = trades.slice().sort((a, b) => a.time - b.time);
  const size = Math.ceil(t.length / folds);
  return Array.from({ length: folds }, (_, f) => {
    const part = t.slice(f * size, (f + 1) * size);
    return { fold: f + 1, from: part[0]?.time ?? null, to: part.at(-1)?.time ?? null, stats: cohortStats(part) };
  });
}

export interface ValidationReport {
  version: string;
  basis: string;
  candleBacktest: string;
  overall: CohortStats;
  byStrategy: Array<{ strategy: string; stats: CohortStats; split: ReturnType<typeof chronologicalSplit>; walkForward: ReturnType<typeof walkForward> }>;
  bySymbol: Array<{ symbol: string; stats: CohortStats }>;
  byRegime: Array<{ regime: string; stats: CohortStats }>;
}

export function validationReport(trades: readonly GradedTrade[], basis: string): ValidationReport {
  const group = <K extends string>(f: (t: GradedTrade) => K) => {
    const m = new Map<K, GradedTrade[]>();
    for (const t of trades) m.set(f(t), [...(m.get(f(t)) ?? []), t]);
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  };
  return {
    version: DHAN_VALIDATION_VERSION, basis,
    candleBacktest: 'NOT_POSSIBLE: setups A-D need footprint / CVD, which Dhan history (OHLCV candles) cannot provide; validation runs on recorded flow only.',
    overall: cohortStats(trades),
    byStrategy: group((t) => t.strategy).map(([strategy, ts]) => ({ strategy, stats: cohortStats(ts), split: chronologicalSplit(ts), walkForward: walkForward(ts) })),
    bySymbol: group((t) => t.symbol).map(([symbol, ts]) => ({ symbol, stats: cohortStats(ts) })),
    byRegime: group((t) => t.regime ?? 'UNKNOWN').map(([regime, ts]) => ({ regime, stats: cohortStats(ts) })),
  };
}
