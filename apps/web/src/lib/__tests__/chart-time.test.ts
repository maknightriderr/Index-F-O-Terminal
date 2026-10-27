import { describe, expect, it } from 'vitest';
import { TickMarkType, type UTCTimestamp } from 'lightweight-charts';
import { chartCrosshairIst, chartTickIst } from '../chart-time';

const utc = (value: string) => (Date.parse(value) / 1000) as UTCTimestamp;

describe('chart IST labels', () => {
  it('shows the NSE open at 09:15, preserving the UTC candle time', () => {
    const time = utc('2026-10-27T03:45:00Z');
    expect(chartTickIst(time, TickMarkType.Time)).toBe('09:15');
    expect(chartCrosshairIst(time)).toBe('27 Oct 2026 09:15 IST');
    expect(time).toBe(Date.parse('2026-10-27T03:45:00Z') / 1000);
  });
  it('handles IST midnight and year rollover', () => {
    const time = utc('2026-12-31T18:30:00Z');
    expect(chartTickIst(time, TickMarkType.TimeWithSeconds)).toBe('00:00:00');
    expect(chartTickIst(time, TickMarkType.DayOfMonth)).toBe('01 Jan');
    expect(chartTickIst(time, TickMarkType.Month)).toBe('Jan');
    expect(chartTickIst(time, TickMarkType.Year)).toBe('2027');
    expect(chartCrosshairIst(time)).toBe('01 Jan 2027 00:00 IST');
  });
  it('preserves date-only business days', () => {
    expect(chartCrosshairIst('2026-10-27')).toBe('27 Oct 2026');
    expect(chartCrosshairIst({ year: 2026, month: 10, day: 27 })).toBe('27 Oct 2026');
  });
});
