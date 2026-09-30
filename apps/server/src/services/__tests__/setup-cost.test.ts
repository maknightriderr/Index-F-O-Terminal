// ============================================================
// SETUP COST MEASUREMENT — per-setup option cost and stop distance
// ============================================================
// The parts must add up to the live gate's own estimate; observed and
// modelled values must stay labelled; a missing input gives nulls, never a
// flat 0.1R; and the measurement only ever feeds the record, never a decision.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { estimateRoundTripCost } from '@fno/analytics';
import { measureSetupCost, measureStopDistance, type OptionQuoteInput } from '../setup-cost.js';

const leg = (over: Partial<OptionQuoteInput> = {}): OptionQuoteInput => ({
  side: 'CE',
  strike: 25000,
  expiry: '2026-10-07',
  strikeBasis: 'TRADED',
  premium: 100,
  bid: 99.5,
  ask: 100.5,
  delta: 0.5,
  lotSize: 75,
  premiumStop: 80,
  ...over,
});
// Underlying: entry 25000, stop 24960 (40 pts), T1 25100 (100 pts) → gross 2.5R.
const geometry = { entry: 25000, stop: 24960, t1: 25100, atr: 20, costVersion: 'COST-2.0' };

describe('measureSetupCost', () => {
  it('splits the live estimate into parts that add up to it exactly', () => {
    const m = measureSetupCost({ ...geometry, option: leg() });
    const live = estimateRoundTripCost(100, 99.5, 100.5, 75);
    expect(m.perUnit!.spread + m.perUnit!.slippage + m.perUnit!.charges).toBeCloseTo(live.perUnit, 3);
    expect(m.perUnit!.total).toBeCloseTo(live.perUnit, 3);
    expect(m.costPctOfPremium!).toBeCloseTo(live.pct, 3);
  });

  it('a two-sided quote is OBSERVED; slippage and charges are always MODELLED', () => {
    const m = measureSetupCost({ ...geometry, option: leg() });
    expect(m.quality).toBe('OBSERVED');
    expect(m.sources).toEqual({ premium: 'OBSERVED', spread: 'OBSERVED', slippage: 'MODELLED', charges: 'MODELLED' });
    expect(m.perUnit!.spread).toBe(1);
  });

  it('no two-sided quote: MODELLED, with the schedule fallback spread', () => {
    const m = measureSetupCost({ ...geometry, option: leg({ bid: null, ask: null }) });
    expect(m.quality).toBe('MODELLED');
    expect(m.sources.spread).toBe('MODELLED');
    expect(m.perUnit!.total).toBeCloseTo(estimateRoundTripCost(100, 0, 0, 75).perUnit, 3);
  });

  it('no option quote: UNAVAILABLE, every cost null, gross R still measured', () => {
    for (const option of [null, leg({ premium: null }), leg({ premium: 0 })]) {
      const m = measureSetupCost({ ...geometry, option });
      expect(m.quality).toBe('UNAVAILABLE');
      expect(m.perUnit).toBeNull();
      expect(m.costR).toBeNull();
      expect(m.netR).toBeNull();
      expect(m.grossR).toBe(2.5);
    }
  });

  it('cost in R uses |delta| × underlying stop, and net R = gross R − cost R', () => {
    const m = measureSetupCost({ ...geometry, option: leg() });
    const riskUnit = 0.5 * 40;
    expect(m.costR!).toBeCloseTo(m.perUnit!.total / riskUnit, 4);
    expect(m.spreadR! + m.slippageR! + m.chargesR!).toBeCloseTo(m.costR!, 3);
    expect(m.netR!).toBeCloseTo(2.5 - m.costR!, 4);
    // A put's negative delta prices the same way.
    expect(measureSetupCost({ ...geometry, option: leg({ side: 'PE', delta: -0.5 }) }).costR).toBe(m.costR);
  });

  it('no delta: no cost in R and no net R — never a flat 0.1R stand-in', () => {
    const m = measureSetupCost({ ...geometry, option: leg({ delta: null }) });
    expect(m.perUnit).not.toBeNull();
    expect(m.costR).toBeNull();
    expect(m.netR).toBeNull();
  });
});

describe('measureStopDistance', () => {
  it('points, ATR, % and per-lot risk, with the premium stop when a setup was built', () => {
    const s = measureStopDistance({ entry: 25000, stop: 24960, atr: 20, option: leg() });
    expect(s).toMatchObject({ points: 40, atr: 2, pct: 0.16, underlyingRiskPerLot: 3000, optionRiskPerUnit: 20, optionRiskPerLot: 1500, optionRiskBasis: 'PREMIUM_STOP' });
  });

  it('without a built premium stop, option risk is |delta| × underlying stop', () => {
    const s = measureStopDistance({ entry: 25000, stop: 24960, atr: 20, option: leg({ premiumStop: null, delta: 0.4 }) });
    expect(s.optionRiskBasis).toBe('DELTA_X_STOP');
    expect(s.optionRiskPerUnit).toBe(16);
  });

  it('without an option, only the underlying distances', () => {
    const s = measureStopDistance({ entry: 25000, stop: 24960, atr: null });
    expect(s).toMatchObject({ points: 40, atr: null, underlyingRiskPerLot: null, optionRiskPerUnit: null, optionRiskBasis: null });
  });
});

describe('measurement never feeds a decision', () => {
  const src = readFileSync(fileURLToPath(new URL('../market-bias.ts', import.meta.url)), 'utf8');

  it('every measureStructureFillCost call is an argument to recordStructureOutcome, written after the outcome', () => {
    const calls = [...src.matchAll(/measureStructureFillCost\(/g)].map((m) => m.index!).filter((i) => !src.slice(i - 9, i).includes('function'));
    expect(calls.length).toBe(2);
    for (const i of calls) {
      const before = src.slice(Math.max(0, i - 700), i);
      expect(before.lastIndexOf('recordStructureOutcome(')).toBeGreaterThan(-1);
    }
  });

  it('no gate or builder reads a cost measurement', () => {
    expect(src).not.toMatch(/\.costR\b/);
    expect(src).not.toMatch(/\.netR\b/);
    expect(src).not.toMatch(/cost\.quality/);
  });
});
