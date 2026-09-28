import { describe, it, expect } from 'vitest';
import {
  assessStaleness,
  inputTimestampsFrom,
  signalAgeSeconds,
  staleSignalDiagnostic,
  validUntil,
  SIGNAL_STALENESS_MOVE_ATR,
} from '../signal-freshness.js';

// Fabricated price-jump fixture: a sticky setup minted at one underlying
// price and re-surfaced after the underlying jumped. Synthetic numbers.
const GENERATED_AT = 1_700_000_000_000;

describe('signal freshness — measured, not enforced', () => {
  it('flags a re-surfaced setup stale when the underlying jumped beyond the ATR threshold', () => {
    const a = assessStaleness({
      underlyingAtGeneration: 1000,
      currentUnderlying: 1012, // 12 points on a 10-point ATR = 1.2 ATR
      atrPoints: 10,
      generatedAt: GENERATED_AT,
      now: GENERATED_AT + 20 * 60 * 1000,
      thresholdAtr: 0.5,
    });
    expect(a.evaluated).toBe(true);
    expect(a.stale).toBe(true);
    expect(a.moveAtr).toBeCloseTo(1.2, 6);
    expect(a.ageSeconds).toBe(20 * 60);
    expect(a.reason).toMatch(/NOT invalidated/);
  });

  it('does not flag a setup whose underlying stayed inside the threshold', () => {
    const a = assessStaleness({ underlyingAtGeneration: 1000, currentUnderlying: 1003, atrPoints: 10, generatedAt: GENERATED_AT, now: GENERATED_AT, thresholdAtr: 0.5 });
    expect(a.stale).toBe(false);
    expect(a.moveAtr).toBeCloseTo(0.3, 6);
  });

  it('is direction-agnostic: a jump in favour is just as stale', () => {
    const down = assessStaleness({ underlyingAtGeneration: 1000, currentUnderlying: 990, atrPoints: 10, generatedAt: GENERATED_AT, now: GENERATED_AT, thresholdAtr: 0.5 });
    expect(down.stale).toBe(true);
  });

  it('reports "not measurable" rather than "fresh" when inputs are missing', () => {
    const a = assessStaleness({ underlyingAtGeneration: null, currentUnderlying: 1000, atrPoints: 10, generatedAt: GENERATED_AT, now: GENERATED_AT });
    expect(a.evaluated).toBe(false);
    expect(a.stale).toBe(false);
    expect(staleSignalDiagnostic(a, { underlyingAtGeneration: null, currentUnderlying: 1000, atrPoints: 10 }, 1).status).toBe('NOT_EVALUATED');
  });

  it('the SIGNAL_STALE diagnostic records the measurement and never claims to have decided or enforced anything', () => {
    const a = assessStaleness({ underlyingAtGeneration: 1000, currentUnderlying: 1020, atrPoints: 10, generatedAt: GENERATED_AT, now: GENERATED_AT, thresholdAtr: 0.5 });
    const d = staleSignalDiagnostic(a, { underlyingAtGeneration: 1000, currentUnderlying: 1020, atrPoints: 10 }, 42);
    expect(d.gate).toBe('SIGNAL_STALE');
    expect(d.status).toBe('FAIL');
    expect(d.was_deciding_gate).toBe(false);
    expect(d.input_values.enforced).toBe(false);
    expect(d.timestamp).toBe(42);
  });

  it('assessment is pure: the same inputs never produce a different answer, and nothing is mutated', () => {
    const input = Object.freeze({ underlyingAtGeneration: 1000, currentUnderlying: 1012, atrPoints: 10, generatedAt: GENERATED_AT, now: GENERATED_AT + 1000, thresholdAtr: 0.5 });
    expect(assessStaleness(input)).toEqual(assessStaleness(input));
  });

  it('default threshold is a positive, configurable measurement constant', () => {
    expect(SIGNAL_STALENESS_MOVE_ATR).toBeGreaterThan(0);
  });

  it('signal age is measured from the OLDEST input timestamp', () => {
    const ts = inputTimestampsFrom({ timestamp: GENERATED_AT - 30_000 }, { timestamp: GENERATED_AT - 5_000 });
    expect(ts.underlyingQuote).toBe(GENERATED_AT - 30_000);
    expect(ts.pcr).toBe(GENERATED_AT - 30_000);
    expect(ts.optionQuote).toBe(GENERATED_AT - 5_000);
    expect(ts.greeks).toBe(GENERATED_AT - 5_000);
    expect(signalAgeSeconds(GENERATED_AT, ts)).toBe(30);
    expect(signalAgeSeconds(GENERATED_AT, inputTimestampsFrom(null, null))).toBeNull();
    expect(validUntil(GENERATED_AT, 900)).toBe(GENERATED_AT + 900_000);
  });
});
