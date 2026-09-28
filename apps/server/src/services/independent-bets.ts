// ============================================================
// INDEPENDENT BETS — correlation-aware backtesting stats (validation review, fix 4)
// ============================================================
// A NIFTY long and a BANKNIFTY long taken in the same hour are one bet on
// the index, not two. Counting them as two overstates the sample and the
// confidence in every rate computed from it. The daily breaker stays
// disabled (so more trades are taken), which makes this matter more, not less.
//
// Setups are clustered when they
//   - overlap in time (generation → exit),
//   - share a direction, and
//   - are in the same index family (CORRELATED_INDEX_FAMILIES; any other
//     symbol is its own family of one).
// Clustering is transitive (union-find), so A~B and B~C put A, B and C in
// one cluster.
//
// Each cluster is scored as ONE bet whose result is the SUM of its members'
// net premium R — what that concentrated position actually made or lost.
// The totals therefore reconcile with the per-setup figures; only the count
// of independent observations (and anything computed per observation) moves.
//
// Pure. Reporting only — nothing reads this back into a decision.
// ============================================================

import type { IndependentBetsSummary } from '@fno/shared';
import { CORRELATED_INDEX_FAMILIES, familyOf } from './exposure-tracker.js';

export interface BetInput {
  id: string;
  symbol: string;
  direction: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms; null when the exit time was not recorded (treated as a point at `start`). */
  end: number | null;
  /** Net premium R after costs; null when the setup has no usable R. */
  netR: number | null;
}

export type { IndependentBetsSummary };

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Groups the bets into correlated clusters (every bet lands in exactly one). */
export function clusterBets(
  bets: readonly BetInput[],
  families: Readonly<Record<string, readonly string[]>> = CORRELATED_INDEX_FAMILIES
): BetInput[][] {
  const parent = bets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const fam = bets.map((b) => familyOf(b.symbol, families));
  const end = (b: BetInput) => b.end ?? b.start;
  for (let i = 0; i < bets.length; i++) {
    for (let j = i + 1; j < bets.length; j++) {
      const a = bets[i];
      const b = bets[j];
      if (a.direction !== b.direction || fam[i] !== fam[j]) continue;
      if (a.start <= end(b) && b.start <= end(a)) union(i, j);
    }
  }
  const groups = new Map<number, BetInput[]>();
  bets.forEach((b, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(b);
    else groups.set(root, [b]);
  });
  return [...groups.values()];
}

export function summariseIndependentBets(
  inputs: readonly BetInput[],
  families: Readonly<Record<string, readonly string[]>> = CORRELATED_INDEX_FAMILIES
): IndependentBetsSummary {
  const bets = inputs.filter((b) => b.netR != null && Number.isFinite(b.netR));
  const clusters = clusterBets(bets, families);
  const results = clusters.map((c) => c.reduce((s, b) => s + (b.netR as number), 0));
  const profitable = results.filter((r) => r > 0).length;
  const unprofitable = results.filter((r) => r < 0).length;
  const grossProfit = results.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(results.filter((r) => r < 0).reduce((s, r) => s + r, 0));
  const netR = results.reduce((s, r) => s + r, 0);
  return {
    setups: bets.length,
    clusters: clusters.length,
    multiSetupClusters: clusters.filter((c) => c.length > 1).length,
    largestCluster: clusters.reduce((m, c) => Math.max(m, c.length), 0),
    profitableCloseRatePercent: profitable + unprofitable > 0 ? Math.round((profitable / (profitable + unprofitable)) * 1000) / 10 : null,
    profitFactor: grossLoss > 0 ? r2(grossProfit / grossLoss) : null,
    netR: r2(netR),
    avgNetRPerBet: clusters.length > 0 ? r2(netR / clusters.length) : null,
    note:
      'Setups that overlapped in time, shared a direction and sat in the same index family are counted as one bet; each ' +
      "bet's result is the sum of its setups' net premium R. Totals match the per-setup figures; the number of independent " +
      'observations is what changes.',
  };
}
