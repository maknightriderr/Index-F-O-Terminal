import { describe, expect, it } from 'vitest';
import { biasCaveat } from '../bias-read';

describe('bias caveat (audit F-23)', () => {
  it('flags a weak and counter-trend read; leaves a firm aligned one alone', () => {
    expect(biasCaveat('BULLISH', 29, 'STRONG_BEAR_TREND')).toBe('Weak read (29 / 100): treat as neutral, leaning bullish. Against the 1-hour trend (strong bear trend): counter-trend.');
    expect(biasCaveat('BEARISH', 75, 'STRONG_BULL_TREND')).toBe('Against the 1-hour trend (strong bull trend): counter-trend.');
    expect(biasCaveat('BULLISH', 70, 'STRONG_BULL_TREND')).toBeNull();
    expect(biasCaveat('NEUTRAL', 10, 'RANGE_BOUND')).toBeNull();
  });
});
