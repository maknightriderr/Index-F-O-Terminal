import { describe, it, expect } from 'vitest';
import { classifyOpeningEnvironment, type OpeningClassifierInput } from '../opening-classifier.js';

const OPENING_GUARD_MINUTES = 60;

function base(overrides: Partial<OpeningClassifierInput> = {}): OpeningClassifierInput {
  return {
    minutesSinceOpen: 10,
    adxValue: 15,
    atrZ: 0,
    freshBreakoutUp: false,
    freshBreakoutDown: false,
    ...overrides,
  };
}

describe('opening-hour environment classifier (Phase 3, spec §15) — observational only', () => {
  it('is null outside the opening window: no minutes, negative minutes, or at/after the guard', () => {
    expect(classifyOpeningEnvironment(base({ minutesSinceOpen: null }), OPENING_GUARD_MINUTES)).toBeNull();
    expect(classifyOpeningEnvironment(base({ minutesSinceOpen: -1 }), OPENING_GUARD_MINUTES)).toBeNull();
    expect(classifyOpeningEnvironment(base({ minutesSinceOpen: 60 }), OPENING_GUARD_MINUTES)).toBeNull();
    expect(classifyOpeningEnvironment(base({ minutesSinceOpen: 120 }), OPENING_GUARD_MINUTES)).toBeNull();
  });

  it('labels OPENING_BREAKOUT on a fresh volume-confirmed break, up or down, regardless of ADX/atrZ', () => {
    expect(classifyOpeningEnvironment(base({ freshBreakoutUp: true, adxValue: 10, atrZ: -2 }), OPENING_GUARD_MINUTES)).toBe('OPENING_BREAKOUT');
    expect(classifyOpeningEnvironment(base({ freshBreakoutDown: true, adxValue: 30, atrZ: 3 }), OPENING_GUARD_MINUTES)).toBe('OPENING_BREAKOUT');
  });

  it('labels OPENING_REVERSAL on elevated range (atrZ > 1) with a trend already read (ADX >= 18)', () => {
    expect(classifyOpeningEnvironment(base({ atrZ: 1.5, adxValue: 18 }), OPENING_GUARD_MINUTES)).toBe('OPENING_REVERSAL');
    expect(classifyOpeningEnvironment(base({ atrZ: 2.4, adxValue: 25 }), OPENING_GUARD_MINUTES)).toBe('OPENING_REVERSAL');
  });

  it('labels HIGH_VOLATILITY_CHOP on elevated range with no trend read (ADX < 18) and no breakout', () => {
    expect(classifyOpeningEnvironment(base({ atrZ: 1.2, adxValue: 12 }), OPENING_GUARD_MINUTES)).toBe('HIGH_VOLATILITY_CHOP');
    expect(classifyOpeningEnvironment(base({ atrZ: 5, adxValue: 17.9 }), OPENING_GUARD_MINUTES)).toBe('HIGH_VOLATILITY_CHOP');
  });

  it('labels LOW_VOLATILITY_CHOP on compressed range (atrZ < -1)', () => {
    expect(classifyOpeningEnvironment(base({ atrZ: -1.1 }), OPENING_GUARD_MINUTES)).toBe('LOW_VOLATILITY_CHOP');
    expect(classifyOpeningEnvironment(base({ atrZ: -3, adxValue: 40 }), OPENING_GUARD_MINUTES)).toBe('LOW_VOLATILITY_CHOP');
  });

  it('labels OPENING_RANGE for an ordinary open — no breakout, atrZ inside +/-1', () => {
    expect(classifyOpeningEnvironment(base({ atrZ: 0 }), OPENING_GUARD_MINUTES)).toBe('OPENING_RANGE');
    expect(classifyOpeningEnvironment(base({ atrZ: 1, adxValue: 30 }), OPENING_GUARD_MINUTES)).toBe('OPENING_RANGE');
    expect(classifyOpeningEnvironment(base({ atrZ: -1 }), OPENING_GUARD_MINUTES)).toBe('OPENING_RANGE');
  });

  it('agrees with a different guard window instead of holding its own copy of the constant', () => {
    // Same fixture, only the guard changes — 45 minutes in is "opening" under
    // a 60-minute guard and "past the opening" under a 30-minute one.
    const fixture = base({ minutesSinceOpen: 45, atrZ: 0 });
    expect(classifyOpeningEnvironment(fixture, 60)).toBe('OPENING_RANGE');
    expect(classifyOpeningEnvironment(fixture, 30)).toBeNull();
  });
});
