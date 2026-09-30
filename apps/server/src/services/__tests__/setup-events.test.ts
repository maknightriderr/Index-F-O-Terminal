// ============================================================
// SETUP_EVENTS — pure helpers (grade bands, would_be_valid_if)
// ============================================================
// gradeFromScore's bands are fixed in advance from the score's own shape
// (see setup-events.ts's module comment); this pins them so a change to the
// bands is a visible, deliberate diff, not an accidental drift.
// ============================================================

import { describe, it, expect } from 'vitest';
import { gradeFromScore, wouldBeValidIf } from '../setup-events.js';
import { firstFillIndex } from '../setup-events-grading.js';

describe('gradeFromScore', () => {
  it('bands are fixed at 70 / 55 / 40', () => {
    expect(gradeFromScore(null)).toBeNull();
    expect(gradeFromScore(39)).toBe('C');
    expect(gradeFromScore(40)).toBe('B');
    expect(gradeFromScore(54)).toBe('B');
    expect(gradeFromScore(55)).toBe('A');
    expect(gradeFromScore(69)).toBe('A');
    expect(gradeFromScore(70)).toBe('A+');
    expect(gradeFromScore(100)).toBe('A+');
  });
});

describe('wouldBeValidIf', () => {
  it('LOW_RR: solves the entry that clears 1.5R holding stop/T1 fixed (bullish: stop < entry < T1)', () => {
    // stop 90, T1 110, entry 95 -> current RR = 15/5 = 3R (already fine) — use
    // a case that is actually LOW_RR: entry 100 -> RR = 10/10 = 1R.
    const out = wouldBeValidIf({ eventType: 'LOW_RR', reason: 'T1 closer than 1.5R', entry: 100, stop: 90, t1: 110, grossRr: 1 });
    expect(out).toMatch(/T1 >= 1.5R would need entry/);
    // required = (t1 + 1.5*stop) / (1 + 1.5) = (110 + 135) / 2.5 = 98.
    expect(out).toContain('98');
  });

  it('cost-related reasons get the fixed cost line', () => {
    expect(wouldBeValidIf({ eventType: 'REJECTED', reason: 'Premium risk exceeds 5% of premium (cost)', entry: null, stop: null, t1: null, grossRr: null })).toBe(
      'Would be valid if cost < 5% of premium.'
    );
  });

  it('closing-guard reasons get the fixed closing-guard line', () => {
    expect(wouldBeValidIf({ eventType: 'REJECTED', reason: 'CLOSING_HOUR: too close to the session close', entry: null, stop: null, t1: null, grossRr: null })).toBe(
      'Would be valid if filled earlier than the closing guard cutoff.'
    );
  });

  it('an unrecognized reason yields null rather than a guess', () => {
    expect(wouldBeValidIf({ eventType: 'REJECTED', reason: 'some unmapped refusal', entry: null, stop: null, t1: null, grossRr: null })).toBeNull();
  });
});

describe('firstFillIndex', () => {
  const bars = [
    { high: 105, low: 101, close: 104 },
    { high: 103, low: 99, close: 100 },
    { high: 98, low: 95, close: 96 },
  ];

  it('grades from the first bar that trades at the entry', () => {
    expect(firstFillIndex(bars, 100)).toBe(1);
    expect(firstFillIndex(bars, 104)).toBe(0);
  });

  it('-1 when price never trades at the entry (the limit would not have filled)', () => {
    expect(firstFillIndex(bars, 110)).toBe(-1);
  });
});
