// ============================================================
// SHADOW vs LIVE COMPARISON — pure aggregation (Phase 2)
// ============================================================
// Reads the three Phase 2 shadow models recorded beside each taken paper
// trade and reports how far each diverges from what the live engine did:
//
//   STRIKE     how often the shadow candidate scorer picked a different
//              strike than the live ATM pick
//   EXECUTION  net R at an ask entry vs the live mid entry, same levels
//   TARGET     the gamma/theta-aware target vs the live delta-only target
//
// This is the evidence base for any FUTURE decision to switch one of these
// models live. It switches nothing. Every group states its n and a
// sufficiency label (same discipline as the Phase 1 report). ADEQUATE means
// "enough rows to read", not "statistically significant".
//
// What this CANNOT show: the outcome of a trade the shadow model would have
// taken instead. Only the live trade was simulated to a close. Where live
// outcomes are split by shadow agreement, that is a split of LIVE outcomes,
// not a shadow backtest — stated in the report's caveats.
// ============================================================

import { sampleSufficiency, type SampleSufficiency } from './loss-attribution-model.js';

export interface ShadowRow {
  decisionId: string;
  time: number;
  symbol: string;
  dteBucket: string | null;
  /** Live values. */
  liveStrike: number | null;
  liveEntry: number | null;
  liveTarget: number | null;
  liveNetR: number | null;
  /** Shadow values. */
  shadowStrike: number | null;
  shadowSelectionScore: number | null;
  shadowEntry: number | null;
  shadowExecutionQuality: 'NORMAL' | 'DEGRADED' | null;
  shadowNetR: number | null;
  shadowTargetV2: number | null;
  shadowExpectedNetRV2: number | null;
  /** How the live paper trade closed, when it has. */
  eventualExitReason: string | null;
  premiumR: number | null;
}

export interface ShadowGroup {
  key: string;
  n: number;
  sample: SampleSufficiency;
}

export interface StrikeGroup extends ShadowGroup {
  differs: number;
  differsPct: number | null;
  /** LIVE premium R of closed trades, split by whether the shadow pick agreed. Not a shadow backtest. */
  livePremiumRWhenAgreed: { n: number; avg: number | null };
  livePremiumRWhenDiffered: { n: number; avg: number | null };
}

export interface ExecutionGroup extends ShadowGroup {
  degraded: number;
  avgLiveNetR: number | null;
  avgShadowNetR: number | null;
  avgNetRDelta: number | null;
  avgEntrySlippagePct: number | null;
}

export interface TargetGroup extends ShadowGroup {
  avgDivergencePts: number | null;
  avgDivergencePctOfEntry: number | null;
  v2BelowLivePct: number | null;
  avgShadowExpectedNetRV2: number | null;
  avgLiveNetR: number | null;
  /** Of closed live trades, how often the live target was hit when v2 sat below vs at/above it. */
  liveTargetHitRate: { v2Below: { n: number; pct: number | null }; v2AtOrAbove: { n: number; pct: number | null } };
}

export interface ShadowComparisonReport {
  simulated: true;
  shadowOnly: true;
  note: string;
  caveats: string[];
  population: { rows: number; from: string | null; to: string | null };
  strike: { overall: StrikeGroup; byDte: StrikeGroup[] };
  execution: { overall: ExecutionGroup; byDte: ExecutionGroup[] };
  target: { overall: TargetGroup; byDte: TargetGroup[] };
}

export const SHADOW_COMPARISON_NOTE =
  'SHADOW vs LIVE — PAPER TRADES ONLY. The shadow strike scorer, ask-price execution model and gamma/theta target are computed ' +
  'beside each live paper setup and never used to make it. Nothing here is account P&L and nothing here changes the engine.';

export const SHADOW_COMPARISON_CAVEATS: readonly string[] = [
  'Shadow columns populate only for decisions recorded after the Phase 2 deploy; older rows are excluded, not zero.',
  'Only the LIVE trade was simulated to a close. Outcomes split by shadow agreement are live outcomes, not what the shadow pick would have earned.',
  'Shadow net R charges the full round-trip spread even at an ask entry (the live cost model assumes a mid entry), so it is a conservative lower bound.',
  'Every group states n and a sufficiency label. A difference on INSUFFICIENT or LOW groups is not evidence; ADEQUATE is not a significance claim.',
  'Switching any shadow model live is a separate, future decision. This report switches nothing.',
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const avg = (xs: number[]): number | null => (xs.length > 0 ? r4(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const pct = (k: number, n: number): number | null => (n > 0 ? r2((k / n) * 100) : null);
const nn = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

function strikeGroup(key: string, rows: readonly ShadowRow[]): StrikeGroup {
  const withShadow = rows.filter((r) => nn(r.shadowStrike) && nn(r.liveStrike));
  const differs = withShadow.filter((r) => r.shadowStrike !== r.liveStrike);
  const agreed = withShadow.filter((r) => r.shadowStrike === r.liveStrike);
  const agreedR = agreed.map((r) => r.premiumR).filter(nn);
  const differedR = differs.map((r) => r.premiumR).filter(nn);
  return {
    key,
    n: withShadow.length,
    sample: sampleSufficiency(withShadow.length),
    differs: differs.length,
    differsPct: pct(differs.length, withShadow.length),
    livePremiumRWhenAgreed: { n: agreedR.length, avg: avg(agreedR) },
    livePremiumRWhenDiffered: { n: differedR.length, avg: avg(differedR) },
  };
}

function executionGroup(key: string, rows: readonly ShadowRow[]): ExecutionGroup {
  const withExec = rows.filter((r) => r.shadowExecutionQuality != null);
  const paired = withExec.filter((r) => nn(r.shadowNetR) && nn(r.liveNetR));
  const slip = withExec.filter((r) => nn(r.shadowEntry) && nn(r.liveEntry) && r.liveEntry! > 0).map((r) => ((r.shadowEntry! - r.liveEntry!) / r.liveEntry!) * 100);
  return {
    key,
    n: withExec.length,
    sample: sampleSufficiency(withExec.length),
    degraded: withExec.filter((r) => r.shadowExecutionQuality === 'DEGRADED').length,
    avgLiveNetR: avg(paired.map((r) => r.liveNetR!)),
    avgShadowNetR: avg(paired.map((r) => r.shadowNetR!)),
    avgNetRDelta: avg(paired.map((r) => r.shadowNetR! - r.liveNetR!)),
    avgEntrySlippagePct: avg(slip),
  };
}

function targetGroup(key: string, rows: readonly ShadowRow[]): TargetGroup {
  const withTarget = rows.filter((r) => nn(r.shadowTargetV2) && nn(r.liveTarget));
  const div = withTarget.map((r) => r.shadowTargetV2! - r.liveTarget!);
  const divPct = withTarget.filter((r) => nn(r.liveEntry) && r.liveEntry! > 0).map((r) => ((r.shadowTargetV2! - r.liveTarget!) / r.liveEntry!) * 100);
  const below = withTarget.filter((r) => r.shadowTargetV2! < r.liveTarget!);
  const closed = (xs: readonly ShadowRow[]) => xs.filter((r) => r.eventualExitReason != null);
  const hitRate = (xs: readonly ShadowRow[]) => {
    const c = closed(xs);
    return { n: c.length, pct: pct(c.filter((r) => r.eventualExitReason === 'TARGET').length, c.length) };
  };
  return {
    key,
    n: withTarget.length,
    sample: sampleSufficiency(withTarget.length),
    avgDivergencePts: avg(div),
    avgDivergencePctOfEntry: avg(divPct),
    v2BelowLivePct: pct(below.length, withTarget.length),
    avgShadowExpectedNetRV2: avg(withTarget.map((r) => r.shadowExpectedNetRV2).filter(nn)),
    avgLiveNetR: avg(withTarget.map((r) => r.liveNetR).filter(nn)),
    liveTargetHitRate: {
      v2Below: hitRate(below),
      v2AtOrAbove: hitRate(withTarget.filter((r) => r.shadowTargetV2! >= r.liveTarget!)),
    },
  };
}

function byDte<T>(rows: readonly ShadowRow[], build: (key: string, rows: readonly ShadowRow[]) => T): T[] {
  const groups = new Map<string, ShadowRow[]>();
  for (const r of rows) {
    const k = r.dteBucket ?? 'UNKNOWN';
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => build(k, g));
}

export function buildShadowComparison(rows: readonly ShadowRow[]): ShadowComparisonReport {
  const times = rows.map((r) => r.time).filter((t) => Number.isFinite(t));
  return {
    simulated: true,
    shadowOnly: true,
    note: SHADOW_COMPARISON_NOTE,
    caveats: [...SHADOW_COMPARISON_CAVEATS],
    population: {
      rows: rows.length,
      from: times.length ? new Date(Math.min(...times)).toISOString() : null,
      to: times.length ? new Date(Math.max(...times)).toISOString() : null,
    },
    strike: { overall: strikeGroup('ALL', rows), byDte: byDte(rows, strikeGroup) },
    execution: { overall: executionGroup('ALL', rows), byDte: byDte(rows, executionGroup) },
    target: { overall: targetGroup('ALL', rows), byDte: byDte(rows, targetGroup) },
  };
}
