import { describe, expect, it } from 'vitest';
import { gammaBreakObservation, startGammaBreakWatch } from '../gamma-break-shadow.js';

const minute = 60_000;
const at = 1_800_000_000_000;
const bar = (time: number, close: number, availableAt: number) =>
  ({ time, open: 100, high: Math.max(101, close), low: Math.min(99, close), close, volume: 10, availableAt });
const range = [15, 10, 5].map(m => bar(at - m * minute, 100, at - (m - 5) * minute));

describe('Gamma break variants', () => {
  it.each([['BULLISH', 102], ['BEARISH', 98]] as const)('observes a %s first close and refuses hold when the next close returns inside', (side, outside) => {
    const watch = startGammaBreakWatch(side, range, at, at + 10 * minute)!;
    const minutes = [bar(at - minute, 100, at), bar(at, outside, at + minute + 100), bar(at + minute, 100, at + 2 * minute)];
    expect(gammaBreakObservation(watch, minutes, at + minute).first).toBeNull();
    expect(gammaBreakObservation(watch, minutes, at + 2 * minute)).toEqual({
      first: at + minute + 100, hold: null, failedHold: at + 2 * minute, expired: false,
    });
    minutes[2] = bar(at + minute, outside, at + 2 * minute);
    expect(gammaBreakObservation(watch, minutes, at + 2 * minute).hold).toBe(at + 2 * minute);
  });
  it('requires contiguous range data known before the watch', () => {
    expect(startGammaBreakWatch('BULLISH', range.slice(1), at, at + minute)).toBeNull();
    expect(startGammaBreakWatch('BULLISH', [...range.slice(0, 2), { ...range[2], availableAt: at + 1 }], at, at + minute)).toBeNull();
  });
});
