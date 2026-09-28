import { describe, it, expect } from 'vitest';
import { exitReasonFromGrade, exitReasonFromCloseReason } from '../exit-reason.js';
import { deadTradeMarker, emptyExcursion } from '../trade-health.js';
import { provisionalExecutionScore } from '../confidence-dimensions.js';
import { buildAttributionReport, sampleSufficiency, type AttributionRow } from '../loss-attribution-model.js';

describe('exit reason — the gradeDecision() hit_target/hit_stop truth table', () => {
  it.each([
    [false, false, 'TIME_EXIT'],
    [true, false, 'TARGET'],
    [false, true, 'STOP'],
    // A bar spanning both is scored as the stop (gradeDecision's conservative rule).
    [true, true, 'STOP'],
  ] as const)('hit_target=%s hit_stop=%s -> %s', (hitTarget, hitStop, expected) => {
    expect(exitReasonFromGrade(hitTarget, hitStop)).toBe(expected);
  });

  it('maps every live paper-close reason into the same vocabulary', () => {
    expect(exitReasonFromCloseReason('TARGET')).toBe('TARGET');
    expect(exitReasonFromCloseReason('STOP_LOSS')).toBe('STOP');
    expect(exitReasonFromCloseReason('TRAILING_STOP')).toBe('STOP');
    expect(exitReasonFromCloseReason('BREAKEVEN_STOP')).toBe('STOP');
    expect(exitReasonFromCloseReason('SESSION_ENDED')).toBe('TIME_EXIT');
    expect(exitReasonFromCloseReason('BIAS_REVERSED')).toBe('INVALIDATED');
    expect(exitReasonFromCloseReason('SETUP_INVALIDATED')).toBe('INVALIDATED');
    expect(exitReasonFromCloseReason('MANUAL_EXIT')).toBe('MANUAL_TEST_EXIT');
    expect(exitReasonFromCloseReason('UNKNOWN')).toBe('OTHER');
    expect(exitReasonFromCloseReason(null)).toBe('OTHER');
  });
});

describe('dead-trade marker — reporting only', () => {
  it('returns a marker only for the DEAD state, with excursion in ATR', () => {
    const ex = { ...emptyExcursion(1000, 10, 50), underlyingMfe: 2, underlyingMae: 8 };
    expect(deadTradeMarker({ state: 'HEALTHY' }, ex, 5)).toBeNull();
    expect(deadTradeMarker({ state: 'DEAD' }, ex, 5)).toEqual({ deadAt: 5, mfeAtDeadAtr: 0.2, maeAtDeadAtr: 0.8 });
  });
});

describe('provisional execution score', () => {
  it('is null without a two-sided quote and is marked provisional', () => {
    const s = provisionalExecutionScore(null, 3);
    expect(s.score).toBeNull();
    expect(s.basis.provisional).toBe(true);
  });
  it('scores a tight, fresh quote above a wide, stale one', () => {
    expect(provisionalExecutionScore(0.5, 1).score!).toBeGreaterThan(provisionalExecutionScore(6, 90).score!);
  });
});

describe('loss attribution model', () => {
  const row = (over: Partial<AttributionRow>): AttributionRow => ({
    decisionId: Math.random().toString(36),
    time: 0,
    symbol: 'SYNTH',
    bias: 'BULLISH',
    regime: 'RANGE_BOUND',
    confidence: 80,
    strategy: 'BOS',
    side: 'CE',
    strikeDistanceAtr: 0.1,
    delta: 0.5,
    dte: 3,
    ivPct: 20,
    sessionBucket: '120+',
    signalAgeSeconds: 2,
    spreadPct: 1,
    exitReason: 'STOP',
    mfeAtr: 0.1,
    maeAtr: 2,
    simR: -1,
    premiumR: null,
    eventualExitReason: null,
    deadAt: null,
    ...over,
  });

  it('states sample sufficiency rather than implying significance', () => {
    expect(sampleSufficiency(3)).toBe('INSUFFICIENT');
    expect(sampleSufficiency(15)).toBe('LOW');
    expect(sampleSufficiency(40)).toBe('ADEQUATE');
  });

  it('answers the pre-built questions and splits exit reasons', () => {
    const rows = [row({}), row({ simR: 1.5, exitReason: 'TARGET', strategy: 'CHOCH' }), row({ simR: 0.2, exitReason: 'TIME_EXIT' })];
    const report = buildAttributionReport(rows);
    expect(report.simulated).toBe(true);
    expect(report.questions).toHaveLength(12);
    expect(report.overall.n).toBe(3);
    expect(report.overall.wins).toBe(2);
    expect(report.overall.losses).toBe(1);
    expect(report.overall.exitReasons).toMatchObject({ STOP: 1, TARGET: 1, TIME_EXIT: 1 });
    expect(report.overall.sample).toBe('INSUFFICIENT');
    const q12 = report.questions.find((q) => q.id === 'Q12')!;
    expect(q12.groups.reduce((s, g) => s + g.n, 0)).toBe(1); // losers only
  });
});
