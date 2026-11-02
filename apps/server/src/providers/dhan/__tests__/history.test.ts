import { describe, expect, it } from 'vitest';
import { candlesFromDhan, dhanTime, istIso, parseRequestTime } from '../history.js';

describe('Dhan candles (2 Nov): formats and parsing', () => {
  it('reads Angel-format IST request times and ISO instants', () => {
    expect(parseRequestTime('2026-11-02 09:15')).toBe(Date.parse('2026-11-02T03:45:00Z'));
    expect(parseRequestTime('2026-11-02T03:45:00.000Z')).toBe(Date.parse('2026-11-02T03:45:00Z'));
    expect(parseRequestTime('nonsense')).toBeNull();
  });
  it('writes Dhan request times and Angel-shaped candle timestamps in IST', () => {
    expect(dhanTime(Date.parse('2026-11-02T03:45:00Z'))).toBe('2026-11-02 09:15:00');
    expect(istIso(Date.parse('2026-11-02T03:45:00Z') / 1000)).toBe('2026-11-02T09:15:00+05:30');
  });
  it('turns Dhan column arrays into candles and drops broken rows', () => {
    const t0 = Date.parse('2026-11-02T03:45:00Z') / 1000;
    const out = candlesFromDhan({ timestamp: [t0, t0 + 300, t0 + 600], open: [10, 0, 12], high: [11, 1, 13], low: [9, 0, 11], close: [10.5, 0, 12.5], volume: [100, 0, 300] });
    expect(out).toEqual([
      { timestamp: '2026-11-02T09:15:00+05:30', open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
      { timestamp: '2026-11-02T09:25:00+05:30', open: 12, high: 13, low: 11, close: 12.5, volume: 300 },
    ]);
    expect(candlesFromDhan(null)).toEqual([]);
  });
});
