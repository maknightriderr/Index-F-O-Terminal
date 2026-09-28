// ============================================================
// VALIDATION REVIEW — reporting (fix 4 stats, fix 7 metrics honesty)
// ============================================================
// Every record here is a FABRICATED fixture. Checks:
//   - independentBets clusters overlapping same-direction same-family setups
//     (NIFTY/BANKNIFTY) into one bet, transitively, and leaves the rest alone;
//   - the EXPIRED breakdown by close reason;
//   - the logic-version filter and split, in Backtesting and loss attribution.
// ============================================================

import { describe, it, expect } from 'vitest';
import type { TradeSetupRecord } from '@fno/shared';
import { clusterBets, summariseIndependentBets, type BetInput } from '../independent-bets.js';
import { expiredBreakdown, logicVersionBuckets, matchesLogicVersion, LOGIC_VERSION_ALL, LOGIC_VERSION_PRE_REVIEW } from '../backtesting.js';
import { buildAttributionReport, R_DEFINITIONS, type AttributionRow } from '../loss-attribution-model.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-14T10:30:00+05:30');

function bet(id: string, symbol: string, direction: string, startMin: number, endMin: number | null, netR: number | null): BetInput {
  return { id, symbol, direction, start: T0 + startMin * MIN, end: endMin == null ? null : T0 + endMin * MIN, netR };
}

describe('independentBets — correlated overlapping setups count as one bet', () => {
  const fixture = [
    bet('a', 'NIFTY', 'BULLISH', 0, 60, -1), // overlaps b
    bet('b', 'BANKNIFTY', 'BULLISH', 30, 90, -1.2), // overlaps a and c
    bet('c', 'FINNIFTY', 'BULLISH', 80, 120, 0.5), // overlaps b only → same cluster transitively
    bet('d', 'NIFTY', 'BEARISH', 10, 50, 1), // opposite direction → its own bet
    bet('e', 'RELIANCE', 'BULLISH', 0, 60, 2), // not in the index family → its own bet
    bet('f', 'NIFTY', 'BULLISH', 200, 230, 1.5), // same family/direction but no time overlap
    bet('g', 'SENSEX', 'BULLISH', 300, null, -0.5), // no exit time → a point at its start
    bet('h', 'BANKNIFTY', 'BULLISH', 300, 320, null), // no usable R → excluded
  ];

  it('clusters NIFTY/BANKNIFTY/FINNIFTY longs that overlap, transitively', () => {
    const clusters = clusterBets(fixture.filter((b) => b.netR != null));
    const ids = clusters.map((c) => c.map((b) => b.id).sort().join('')).sort();
    expect(ids).toEqual(['abc', 'd', 'e', 'f', 'g']);
  });

  it('scores each cluster as the sum of its members, so totals reconcile with per-setup', () => {
    const s = summariseIndependentBets(fixture);
    expect(s.setups).toBe(7);
    expect(s.clusters).toBe(5);
    expect(s.multiSetupClusters).toBe(1);
    expect(s.largestCluster).toBe(3);
    // Cluster results: abc = -1.7, d = +1, e = +2, f = +1.5, g = -0.5
    expect(s.netR).toBe(2.3);
    expect(s.avgNetRPerBet).toBe(0.46);
    expect(s.profitableCloseRatePercent).toBe(60);
    expect(s.profitFactor).toBe(Math.round((4.5 / 2.2) * 100) / 100);
    // Per-setup, the same trades read as 4 winners / 3 losers and PF 5/2.7.
    const perSetupPf = Math.round((5 / 2.7) * 100) / 100;
    expect(s.profitFactor).not.toBe(perSetupPf);
  });

  it('an empty history reports nothing rather than zeros that look like results', () => {
    const s = summariseIndependentBets([]);
    expect(s).toMatchObject({ setups: 0, clusters: 0, profitableCloseRatePercent: null, profitFactor: null, avgNetRPerBet: null, netR: 0 });
  });
});

function rec(over: Partial<TradeSetupRecord>): TradeSetupRecord {
  return {
    id: 'x',
    symbol: 'NIFTY',
    exchange: 'NSE',
    mode: 'INTRADAY',
    generatedAt: T0,
    direction: 'BULLISH',
    confidence: 80,
    structureType: 'NAKED_LONG',
    strategy: null,
    legs: null,
    netPremium: null,
    maxProfit: null,
    maxLoss: null,
    breakeven: null,
    breakevenLower: null,
    breakevenUpper: null,
    side: 'CE',
    strike: 25000,
    entry: 100,
    stopLoss: 70,
    target: 160,
    riskReward: 2,
    reason: '',
    regime: null,
    intelligenceScore: null,
    outcome: 'EXPIRED',
    exitPrice: null,
    exitTime: null,
    returnPercent: 0,
    generatedOffSession: false,
    estimatedCostPct: 0,
    ...over,
  };
}

describe('EXPIRED breakdown by close reason', () => {
  it('groups EXPIRED closes by how they closed, with Premium R (net)', () => {
    const rows = expiredBreakdown([
      rec({ id: '1', closeReason: 'SESSION_ENDED', returnPercent: 15 }), // +0.5R
      rec({ id: '2', closeReason: 'SESSION_ENDED', returnPercent: -15 }), // -0.5R
      rec({ id: '3', closeReason: 'BIAS_REVERSED', returnPercent: 9 }), // +0.3R
      rec({ id: '4', closeReason: 'BREAKEVEN_STOP', returnPercent: 0 }),
      rec({ id: '5', closeReason: 'ABANDONED', returnPercent: null }),
      rec({ id: '6', closeReason: null, returnPercent: -3 }),
      rec({ id: '7', outcome: 'LOSS', closeReason: 'STOP_LOSS', returnPercent: -30 }), // not EXPIRED → excluded
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.closeReason, r]));
    expect(Object.keys(by).sort()).toEqual(['ABANDONED', 'BIAS_REVERSED', 'BREAKEVEN_STOP', 'SESSION_ENDED', 'UNRECORDED']);
    expect(by.SESSION_ENDED).toMatchObject({ count: 2, profitable: 1, unprofitable: 1, avgRMultiple: 0 });
    expect(by.BIAS_REVERSED).toMatchObject({ count: 1, profitable: 1, avgRMultiple: 0.3 });
    expect(by.ABANDONED).toMatchObject({ count: 1, profitable: 0, unprofitable: 0, avgRMultiple: null });
    expect(rows[0].closeReason).toBe('SESSION_ENDED'); // largest first
  });
});

describe('logic-version filter and split', () => {
  const pre = rec({ id: 'p', outcome: 'LOSS', returnPercent: -30, logicVersion: null });
  const post1 = rec({ id: 'q', outcome: 'WIN', returnPercent: 60, logicVersion: 'v-new' });
  const post2 = rec({ id: 'r', outcome: 'LOSS', returnPercent: -30, logicVersion: 'v-new' });

  it('all matches everything; PRE_REVIEW matches unstamped rows; a version matches only itself', () => {
    expect([pre, post1].every((r) => matchesLogicVersion(r, LOGIC_VERSION_ALL))).toBe(true);
    expect(matchesLogicVersion(pre, LOGIC_VERSION_PRE_REVIEW)).toBe(true);
    expect(matchesLogicVersion(post1, LOGIC_VERSION_PRE_REVIEW)).toBe(false);
    expect(matchesLogicVersion(post1, 'v-new')).toBe(true);
    expect(matchesLogicVersion(pre, 'v-new')).toBe(false);
  });

  it('the split keeps pre- and post-review trades apart', () => {
    const buckets = logicVersionBuckets([pre, post1, post2]);
    const by = Object.fromEntries(buckets.map((b) => [b.logicVersion, b]));
    expect(by.PRE_REVIEW).toMatchObject({ total: 1, losses: 1, totalRMultiple: -1 });
    expect(by['v-new']).toMatchObject({ total: 2, wins: 1, losses: 1, totalRMultiple: 1, profitFactor: 2 });
  });

  it('loss attribution splits by logic version and names its R definitions', () => {
    const row = (id: string, simR: number, logicVersion: string | null): AttributionRow => ({
      decisionId: id, time: T0, symbol: 'NIFTY', bias: 'BULLISH', regime: null, confidence: 80, strategy: 'X', side: 'CE',
      strikeDistanceAtr: null, delta: null, dte: null, ivPct: null, sessionBucket: null, signalAgeSeconds: null, spreadPct: null,
      exitReason: null, mfeAtr: null, maeAtr: null, simR, premiumR: null, eventualExitReason: null, deadAt: null, logicVersion,
    });
    const report = buildAttributionReport([row('1', -1, null), row('2', 1, 'v-new'), row('3', 2, 'v-new')]);
    const by = Object.fromEntries(report.byLogicVersion.map((g) => [g.key, g]));
    expect(by.PRE_REVIEW.n).toBe(1);
    expect(by['v-new']).toMatchObject({ n: 2, wins: 2, totalSimR: 3 });
    expect(report.rDefinitions).toBe(R_DEFINITIONS);
    expect(R_DEFINITIONS.simR).toMatch(/^Underlying replay R/);
    expect(R_DEFINITIONS.premiumR).toMatch(/^Premium R \(gross\)/);
    expect(R_DEFINITIONS.backtestingR).toMatch(/^Premium R \(net\)/);
  });
});
