import { describe, it, expect } from 'vitest';
import { zigzagSession } from '../percent-moves.js';

const T = (h: number, m: number) => Date.parse(`2026-03-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
const bar = (t: number, high: number, low: number) => ({ time: t, high, low });

describe('zigzagSession (fixed)', () => {
  it('finds a clean up-down-up zigzag at 1% on a hand-built series', () => {
    // 100 -> 102 (+2%) -> 100.5 (-1.47%) -> 103 (+2.49%)
    const bars = [
      bar(T(9, 15), 100, 99.9),
      bar(T(9, 30), 100.2, 100),
      bar(T(9, 45), 102, 101.8), // up leg peak: 102
      bar(T(10, 0), 101, 100.6),
      bar(T(10, 15), 100.6, 100.5), // down leg trough: 100.5 (from 102, -1.47%)
      bar(T(10, 30), 101.5, 101),
      bar(T(10, 45), 103, 102.8), // up leg peak: 103 (from 100.5, +2.49%)
    ];
    const legs = zigzagSession(bars, 1, 'TEST');
    expect(legs.length).toBe(3);
    expect(legs[0].direction).toBe('UP');
    expect(legs[0].toPrice).toBe(102);
    expect(legs[1].direction).toBe('DOWN');
    expect(legs[1].toPrice).toBe(100.5);
    expect(legs[2].direction).toBe('UP');
    expect(legs[2].toPrice).toBe(103);
  });

  it('flushes a still-open final leg at session end (a move that never reversed)', () => {
    // Monotonic climb from 100 to 105 (+5%), never pulls back >= 1%.
    const bars = [bar(T(9, 15), 100, 99.9), bar(T(9, 30), 101, 100.5), bar(T(10, 0), 103, 102), bar(T(10, 30), 105, 104)];
    const legs = zigzagSession(bars, 1, 'TEST');
    expect(legs.length).toBe(1);
    expect(legs[0].direction).toBe('UP');
    // pivotPrice starts at bar[0]'s midpoint (99.95), but bar[0]'s own low
    // (99.9) is tracked as the running low from i=0 and legitimately becomes
    // the leg's true starting extreme once the up-flip is flushed.
    expect(legs[0].fromPrice).toBeCloseTo(99.9, 5);
    expect(legs[0].toPrice).toBe(105);
  });

  it('does not double-count sub-threshold wiggles', () => {
    const bars = [bar(T(9, 15), 100, 99.9), bar(T(9, 30), 100.2, 100.1), bar(T(9, 45), 100.1, 100), bar(T(10, 0), 100.2, 100.1)];
    const legs = zigzagSession(bars, 1, 'TEST'); // <1% range throughout
    expect(legs.length).toBe(0);
  });

  it('the old shared-extreme-variable bug is fixed: an initial down-then-up move both clear threshold', () => {
    // Session opens, immediately drops 2%, then rallies 2% off that low —
    // this exercises the undecided (dir === null) phase where both branches
    // used to stomp on the same extremePrice variable.
    const bars = [
      bar(T(9, 15), 100, 99.9),
      bar(T(9, 30), 99, 98), // -2% from 100
      bar(T(9, 45), 97.5, 97), // continues down: low 97 (~-3%)
      bar(T(10, 0), 99, 98.9),
      bar(T(10, 15), 99.5, 99.4),
      bar(T(10, 30), 99.9, 99.8),
      bar(T(10, 45), 100, 99), // rallies back toward 100 (from 97 low, ~+3%)
    ];
    const legs = zigzagSession(bars, 1, 'TEST');
    expect(legs.length).toBeGreaterThanOrEqual(2);
    expect(legs.some((l) => l.direction === 'DOWN')).toBe(true);
    expect(legs.some((l) => l.direction === 'UP')).toBe(true);
  });
});
