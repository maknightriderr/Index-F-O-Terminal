// ============================================================
// SIGNAL DIAGNOSTICS METRICS — the arithmetic the dashboard quotes
// ============================================================

import { describe, it, expect } from 'vitest';
import { costStats, maxDrawdown, opportunityStats, performanceStats, profitFactor, rate, segmentOf, type GradedEventRow } from '../diagnostics-metrics.js';

const row = (time: number, resultR: number, over: Partial<GradedEventRow> = {}): GradedEventRow => ({
  time,
  resultR,
  netResultR: null,
  mfeR: null,
  maeR: null,
  costR: null,
  spreadR: null,
  slippageR: null,
  chargesR: null,
  costQuality: null,
  ...over,
});

describe('profit factor and drawdown', () => {
  it('PF = winning R ÷ |losing R|; undefined (null) without a loss', () => {
    expect(profitFactor([2, -1, 1.5, -1])).toBe(1.75);
    expect(profitFactor([1, 2])).toBeNull();
    expect(profitFactor([])).toBeNull();
  });

  it('max drawdown is the largest peak-to-trough fall of cumulative R', () => {
    expect(maxDrawdown([1, -1, -1, 2, -3, 1])).toBe(3);
    expect(maxDrawdown([1, 2, 3])).toBe(0);
    expect(maxDrawdown([-1, -1])).toBe(2);
  });
});

describe('performanceStats', () => {
  it('orders by time, and net figures cover only rows with a measured cost', () => {
    const p = performanceStats([row(3, -1), row(1, 2, { netResultR: 1.8, mfeR: 2.5, maeR: 0.2 }), row(2, -1, { netResultR: -1.2, mfeR: 0.5, maeR: 1 })]);
    expect(p).toMatchObject({ count: 3, wins: 1, grossR: 0, profitFactor: 1, netCount: 2, netR: 0.6, profitFactorNet: 1.5, maxDrawdownR: 2, maxDrawdownNetR: 1.2, avgMfeR: 1.5, avgMaeR: 0.6 });
    expect(p.winRate).toBeCloseTo(1 / 3, 4);
  });

  it('with no costed rows, net figures are null rather than zero', () => {
    const p = performanceStats([row(1, 1), row(2, -1)]);
    expect(p.netCount).toBe(0);
    expect(p.netR).toBeNull();
    expect(p.profitFactorNet).toBeNull();
    expect(p.maxDrawdownNetR).toBeNull();
  });
});

describe('costStats', () => {
  it('totals, averages, per-part leakage, and winners flipped by cost', () => {
    const c = costStats([
      row(1, 2, { costR: 0.1, spreadR: 0.05, slippageR: 0.03, chargesR: 0.02, costQuality: 'OBSERVED' }),
      row(2, 0.05, { costR: 0.1, spreadR: 0.05, slippageR: 0.03, chargesR: 0.02, costQuality: 'MODELLED' }),
      row(3, -1, { costR: 0.2, spreadR: 0.1, slippageR: 0.06, chargesR: 0.04, costQuality: 'OBSERVED' }),
      row(4, 1),
    ]);
    expect(c).toMatchObject({ priced: 3, observed: 2, modelled: 1, totalCostR: 0.4, costLeakageR: 0.2, flippedByCost: 1, spreadLeakageR: 0.2, slippageLeakageR: 0.12, chargesLeakageR: 0.08 });
    expect(c.avgCostR).toBeCloseTo(0.1333, 4);
  });

  it('nothing priced: nulls, not zeros', () => {
    expect(costStats([row(1, 1)])).toMatchObject({ priced: 0, totalCostR: null, avgCostR: null, costLeakageR: null });
  });
});

describe('opportunityStats', () => {
  it('rates carry their numerator and denominator', () => {
    const s = opportunityStats({ TRADED: 1, DETECTED_BUT_REJECTED: 2, DETECTED_LATE: 1, NEVER_DETECTED: 4 });
    expect(s).toMatchObject({ opportunities: 8, detected: 4, traded: 1, rejected: 2, late: 1, neverDetected: 4 });
    expect(s.detectionRate).toEqual({ numerator: 4, denominator: 8, rate: 0.5 });
    expect(s.captureRate).toEqual({ numerator: 1, denominator: 8, rate: 0.125 });
  });

  it('no opportunities: a null rate over 0/0', () => {
    expect(opportunityStats({}).captureRate).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(rate(0, 0).rate).toBeNull();
  });
});

describe('segments', () => {
  it('MCX is its own segment; NSE and BSE are INDEX', () => {
    expect(segmentOf('MCX')).toBe('MCX');
    expect(segmentOf('NSE')).toBe('INDEX');
    expect(segmentOf('BSE')).toBe('INDEX');
  });
});
