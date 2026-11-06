// 6 Nov: CRUDEOIL read "Strong Bull Trend" (ADX 26.7) while price fell below EMA20 < EMA50 - the label's direction
// came from the late 1H Supertrend. The direction now comes from the ADX's own +DI / -DI.
import { describe, it, expect } from 'vitest';
import { adx } from '@fno/analytics';
import { adxTrendDirection, classifyRegime } from '../regime-classifier.js';

describe('regime direction from +DI / -DI', () => {
  it('follows the dominant directional indicator and keeps the Supertrend only as the tie-breaker', () => {
    expect(adxTrendDirection(14, 31, 'UP')).toBe('DOWN');
    expect(adxTrendDirection(31, 14, 'DOWN')).toBe('UP');
    expect(adxTrendDirection(20, 20, 'UP')).toBe('UP');
    expect(adxTrendDirection(undefined, 20, 'DOWN')).toBe('DOWN');
    expect(adxTrendDirection(NaN, 20, 'UP')).toBe('UP');
  });
  it('labels a strong fall STRONG_BEAR_TREND even while a lagging Supertrend still reads UP', () => {
    // 40 bars of a steady rise, then 30 bars of a steady fall: ADX strong, -DI dominant.
    const closes = [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 30 }, (_, i) => 139 - 1.5 * (i + 1))];
    const highs = closes.map((c) => c + 0.5), lows = closes.map((c) => c - 0.5);
    const r = adx(highs, lows, closes, 14), value = r.adx.at(-1)!;
    expect(value).toBeGreaterThanOrEqual(25);
    const dir = adxTrendDirection(r.plusDI.at(-1), r.minusDI.at(-1), 'UP');
    expect(dir).toBe('DOWN');
    expect(classifyRegime(value, dir, 0, null, null, false, false, false, false)).toBe('STRONG_BEAR_TREND');
  });
});
