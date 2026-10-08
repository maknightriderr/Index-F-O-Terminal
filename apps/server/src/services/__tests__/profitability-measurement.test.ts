// ============================================================
// PROFITABILITY REVIEW (2026-10-08): measurement + pre-registered shadow rules
// ============================================================
//   * every bucket reports net expectancy with EXPIRED counted, beside the
//     closed-only win rate, and the wins that did not cover their cost;
//   * results split by the source that made the trade;
//   * entry filters read only decision-time fields; exit rules read only the
//     marks strictly before the actual exit.
// All inputs are FABRICATED fixtures.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import type { TradeSetupRecord } from '@fno/shared';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' }, scanKeys: async () => [] }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const sr = await import('../shadow-rules.js');
const bt = await import('../backtesting.js');
const m = await import('../signal-engine-metrics.js');

const IST = (s: string) => Date.parse(`${s}+05:30`);
const rec = (o: Partial<TradeSetupRecord>): TradeSetupRecord =>
  ({ id: 'x', symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', generatedAt: IST('2026-10-06T11:00:00'), direction: 'BEARISH', generatedOffSession: false, voided: false, strategy: null, structureType: 'NAKED_LONG', entry: 100, target: 120, stopLoss: 80, estimatedCostPct: 2, outcome: 'WIN', returnPercent: 20, logicVersion: null, ...o }) as TradeSetupRecord;

describe('entry filters: decision-time fields only', () => {
  const base = { exchange: 'NSE', generatedAt: IST('2026-10-06T11:00:00'), entry: 100, target: 120, estimatedCostPct: 2, ivVsHv: 'CHEAP' };
  it('COST_EDGE_2X: a target gain under 2× the cost is flagged', () => {
    expect(sr.entryFlags(base).COST_EDGE_2X).toBe(false); // 20% ≥ 4%
    expect(sr.entryFlags({ ...base, target: 103 }).COST_EDGE_2X).toBe(true); // 3% < 4%
    expect(sr.entryFlags({ ...base, estimatedCostPct: null }).COST_EDGE_2X).toBeNull();
  });
  it('MCX_EVENING: MCX from 18:00 IST only', () => {
    expect(sr.entryFlags({ ...base, exchange: 'MCX', generatedAt: IST('2026-10-06T17:59:00') }).MCX_EVENING).toBe(false);
    expect(sr.entryFlags({ ...base, exchange: 'MCX', generatedAt: IST('2026-10-06T18:00:00') }).MCX_EVENING).toBe(true);
    expect(sr.entryFlags({ ...base, generatedAt: IST('2026-10-06T19:00:00') }).MCX_EVENING).toBe(false);
  });
  it('RICH_IV', () => {
    expect(sr.entryFlags({ ...base, ivVsHv: 'RICH' }).RICH_IV).toBe(true);
    expect(sr.entryFlags({ ...base, ivVsHv: null }).RICH_IV).toBeNull();
  });
});

describe('exit rules: only marks strictly before the actual exit', () => {
  const T0 = IST('2026-10-06T10:00:00');
  const M = 60_000;
  const x = (path: Array<[number, number]>, over: Partial<Parameters<typeof sr.simulateExits>[0]> = {}) =>
    sr.simulateExits({ entry: 100, target: 140, costPct: 2, entryAt: T0, exitAt: T0 + 180 * M, actualNetPct: -27, path: path.map(([min, premium]) => ({ at: T0 + min * M, premium })), ...over });
  it('TIME_STOP_60 fires on the first mark from 60 min that is below entry', () => {
    const r = x([[15, 98], [45, 95], [60, 90], [75, 80]]);
    expect(r.TIME_STOP_60).toEqual({ fired: true, at: T0 + 60 * M, netPct: -12 });
  });
  it('TIME_STOP_60 does not fire when that first mark is above entry, nor on marks at or after the exit', () => {
    expect(x([[60, 105], [75, 80]]).TIME_STOP_60.fired).toBe(false);
    expect(x([[200, 50]]).TIME_STOP_60).toEqual({ fired: false, at: null, netPct: -27 });
  });
  it('BREAKEVEN_AT_HALF arms at entry + ½(target − entry) and exits at entry (cost only) on a later mark at or below entry', () => {
    expect(x([[15, 121], [30, 110], [45, 100]]).BREAKEVEN_AT_HALF).toEqual({ fired: true, at: T0 + 45 * M, netPct: -2 });
    expect(x([[15, 119], [30, 99]]).BREAKEVEN_AT_HALF.fired).toBe(false);
    expect(x([[15, 121]], { target: null }).BREAKEVEN_AT_HALF.fired).toBe(false);
  });
  it('aggregates: per-trade net with the rule, and what the fired trades did vs would have done', () => {
    const a = sr.aggregateExitRules([
      { actualNetPct: -27, exits: { TIME_STOP_60: { fired: true, at: 1, netPct: -12 }, BREAKEVEN_AT_HALF: { fired: false, at: null, netPct: -27 } } },
      { actualNetPct: 18, exits: { TIME_STOP_60: { fired: false, at: null, netPct: 18 }, BREAKEVEN_AT_HALF: { fired: false, at: null, netPct: 18 } } },
    ]);
    expect(a.baselineNetPerTrade).toBe(-4.5);
    expect(a.rules.TIME_STOP_60).toEqual({ fired: 1, netPerTradeWithRule: 3, firedActualNetPerTrade: -27, firedRuleNetPerTrade: -12 });
  });
});

describe('entry-rule aggregation', () => {
  it('skipped vs kept, and the total with the rule (unjudgeable trades are still taken)', () => {
    const f = (c: boolean | null) => ({ COST_EDGE_2X: c, MCX_EVENING: false, RICH_IV: null });
    const a = sr.aggregateEntryRules([
      { netPct: -5, flags: f(true) },
      { netPct: -3, flags: f(true) },
      { netPct: 10, flags: f(false) },
      { netPct: 4, flags: f(null) },
    ]);
    expect(a).toMatchObject({ trades: 4, baselineNetPerTrade: 1.5, baselineTotalNet: 6 });
    expect(a.rules.COST_EDGE_2X).toEqual({ measured: 3, skipped: 2, skippedNetPerTrade: -4, keptNetPerTrade: 10, totalNetWithRule: 14, improvementTotalNet: 8 });
    expect(a.rules.RICH_IV).toMatchObject({ measured: 0, skipped: 0, totalNetWithRule: 6 });
  });
  it('judged on closed single-leg trades, net of each one\'s own cost (spreads, voided, off-session and open excluded)', () => {
    const t = m.entryRuleTrades([
      rec({ returnPercent: 20, estimatedCostPct: 2 }),
      rec({ outcome: 'EXPIRED', returnPercent: -7, estimatedCostPct: null }),
      rec({ structureType: 'SPREAD' }),
      rec({ voided: true }),
      rec({ generatedOffSession: true }),
      rec({ outcome: null, returnPercent: null }),
    ]);
    expect(t.map((x) => x.netPct)).toEqual([18, -10]);
  });
});

describe('reporting: source split, net expectancy, wins below cost', () => {
  it('the source is the recorded one, else derived from the logic version / strategy', () => {
    expect(bt.sourceOfSetup({ strategy: null, source: 'E1' })).toBe('E1');
    expect(bt.sourceOfSetup({ strategy: 'STRUCTURE', logicVersion: '2026-09-29.structure.1+paper-research.A4' })).toBe('A4');
    expect(bt.sourceOfSetup({ strategy: 'STRUCTURE' })).toBe('S1');
    expect(bt.sourceOfSetup({ strategy: 'MOMENTUM_BREAK' })).toBe('MOMENTUM_BREAK');
    expect(bt.sourceOfSetup({ strategy: 'Bear Put Spread', structureType: 'SPREAD' })).toBe('SPREAD');
    expect(bt.sourceOfSetup({ strategy: null })).toBe('INDICATOR');
  });
  it('win % counts closed WIN / LOSS only; net expectancy counts EXPIRED at its exit, after cost; a win under its cost is counted', () => {
    const rows = [
      rec({ outcome: 'WIN', returnPercent: 20, estimatedCostPct: 2 }),
      rec({ outcome: 'WIN', returnPercent: 1.5, estimatedCostPct: 2 }),
      rec({ outcome: 'LOSS', returnPercent: -30, estimatedCostPct: 2 }),
      rec({ outcome: 'EXPIRED', returnPercent: -8, estimatedCostPct: 2 }),
      rec({ outcome: null, returnPercent: null }),
    ];
    const [b] = bt.strategyBuckets(rows, () => 'X');
    expect(b).toMatchObject({ wins: 2, losses: 1, expired: 1, open: 1, winRatePercent: 66.7, winsBelowCost: 1 });
    expect(b.netExpectancyPercent).toBe(-6.12); // (18 − 0.5 − 32 − 10) / 4 = −6.125, rounded half up
  });
});
