// ============================================================
// SETUP EXPLANATION — the shared builder behind the cards and Telegram
// ============================================================
// Lines come from stored fields only, a missing field drops its line, a
// rejected setup shows its outcome only once its entry actually traded, and
// building an explanation never changes what it reads.
// ============================================================

import { describe, it, expect } from 'vitest';
import { buildSetupExplanation, gradeFromScore as sharedGrade, type SetupExplanationInput } from '@fno/shared';
import { gradeFromScore } from '../setup-events.js';

const base: SetupExplanationInput = {
  direction: 'BULLISH',
  pool: { kind: 'PREV_DAY_LOW', price: 22571, rank: 1 },
  sweepExtreme: 22542,
  zone: { kind: 'FVG', near: 22590, far: 22580 },
  entry: 22590,
  stop: 22538,
  t1: { kind: 'SESSION_HIGH', price: 22700 },
  t2: { kind: 'PREV_DAY_HIGH', price: 22760 },
  rToT1: 2.12,
  score: 62,
  scoreCandle: null,
  patterns: null,
  timeframe: '15m',
};

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    Object.values(o as object).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};

describe('buildSetupExplanation', () => {
  it('names why, the trigger, the pool, the levels and the grade from stored fields', () => {
    const e = buildSetupExplanation(base);
    expect(e.why).toMatch(/Bullish liquidity sweep: prev day low 22,571 was taken \(extreme 22,542\).*displacement candle confirmed/);
    expect(e.trigger).toBe('PREV_DAY_LOW_SWEEP · limit at the fair-value gap 22,590–22,580 · 15m');
    expect(e.pool).toBe('prev day low 22,571 (rank 1)');
    expect({ entry: e.entry, stop: e.stop, t1: e.t1, t2: e.t2, grade: e.grade, grossR: e.grossR }).toEqual({ entry: 22590, stop: 22538, t1: 22700, t2: 22760, grade: 'A', grossR: 2.12 });
    expect(e.forLines).toEqual(expect.arrayContaining([expect.stringMatching(/rank-1 pool/), expect.stringMatching(/2.12R away/), expect.stringMatching(/grade A/)]));
    expect(e.invalidation).toMatch(/sweep extreme \(22,542\)/);
    expect(e.rejected).toBeNull();
  });

  it('no displacement yet: says so; absent fields drop their lines', () => {
    const e = buildSetupExplanation({ ...base, zone: null, pool: null, rToT1: null, score: null, t2: null });
    expect(e.trigger).toBeNull();
    expect(e.pool).toBeNull();
    expect(e.grade).toBeNull();
    expect(e.forLines).toEqual([]);
    expect(e.against).toEqual([]);
  });

  it('option: estimated premiums carry "~"; a minted trade does not', () => {
    const option = { side: 'CE' as const, strike: 22600, expiry: '2026-10-07', dte: 7, entryPremium: 120.5, stopPremium: 96, targetPremium: 170, lotSize: 75 };
    expect(buildSetupExplanation({ ...base, option: { ...option, estimated: true } }).option).toBe('CE 22,600 · exp 2026-10-07 (7 DTE) · entry ~₹120.5 · SL ~₹96 · target ~₹170 · lot 75 · estimated');
    expect(buildSetupExplanation({ ...base, option: { ...option, estimated: false } }).option).toBe('CE 22,600 · exp 2026-10-07 (7 DTE) · entry ₹120.5 · SL ₹96 · target ₹170 · lot 75');
  });

  it('net R and its cost note come only from a measured cost, labelled by quality', () => {
    expect(buildSetupExplanation(base).netR).toBeNull();
    expect(buildSetupExplanation(base).costNote).toBeNull();
    const obs = buildSetupExplanation({ ...base, netR: 1.4, costR: 0.72, costQuality: 'OBSERVED' });
    expect(obs.netR).toBe(1.4);
    expect(obs.costNote).toMatch(/spread from the live quote; slippage and charges modelled/);
    expect(obs.against).toEqual(expect.arrayContaining([expect.stringMatching(/After costs T1 is 1.40R/)]));
    expect(buildSetupExplanation({ ...base, netR: 1.9, costR: 0.22, costQuality: 'MODELLED' }).costNote).toMatch(/spread is assumed/);
  });

  it('rejected: reason, potential levels, fill status, and an outcome only when it filled', () => {
    const rejection = { reason: 'COST_TOO_HIGH: round trip 6.1% of premium', resultR: 2.12, netResultR: 1.4 };
    const filled = buildSetupExplanation({ ...base, rejection: { ...rejection, fillStatus: 'FILLED' } }).rejected!;
    expect(filled.reason).toBe(rejection.reason);
    expect(filled.potential).toBe('Potential entry 22,590 · stop 22,538 · target 22,700');
    expect(filled.fillStatus).toBe('FILLED');
    expect(filled.outcome).toMatch(/\+2.12R \(\+1.40R after costs\)/);

    const noFill = buildSetupExplanation({ ...base, rejection: { ...rejection, fillStatus: 'NO_FILL' } }).rejected!;
    expect(noFill.fillStatus).toBe('NO_FILL');
    expect(noFill.outcome).toBeNull();

    expect(buildSetupExplanation({ ...base, rejection: { ...rejection, fillStatus: null } }).rejected!.fillStatus).toBe('PENDING');
    expect(buildSetupExplanation({ ...base, rejection: { ...rejection, fillStatus: 'NOT_GRADED' } }).rejected!.outcome).toBeNull();
  });

  it('a stored would-be-valid-if wins over the derived one', () => {
    expect(buildSetupExplanation({ ...base, rToT1: 1.2 }).wouldBeValidIf).toMatch(/currently 1.2R/);
    expect(buildSetupExplanation({ ...base, rToT1: 1.2, rejection: { reason: 'x', wouldBeValidIf: 'Would be valid if cost < 5% of premium.' } }).wouldBeValidIf).toBe('Would be valid if cost < 5% of premium.');
  });

  it('is informational: it never changes the fields it reads', () => {
    const input = deepFreeze(JSON.parse(JSON.stringify({ ...base, rejection: { reason: 'r', fillStatus: 'FILLED', resultR: -1 } })) as SetupExplanationInput);
    const before = JSON.stringify(input);
    expect(() => buildSetupExplanation(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });

  it('the server re-exports the one shared grade function', () => {
    expect(gradeFromScore).toBe(sharedGrade);
  });
});
