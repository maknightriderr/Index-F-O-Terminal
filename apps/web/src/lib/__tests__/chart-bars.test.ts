import { describe, expect, it } from 'vitest';
import { aggregateWeekly, cleanBars, CHART_INTERVALS, INTERVAL_CONFIG, rangesFor, rangeStart, type Bar } from '../chart-bars';

const ist = (iso: string) => Math.floor(Date.parse(`${iso}+05:30`) / 1000);
const bar = (time: number, close = 100): Bar => ({ time, open: close, high: close + 1, low: close - 1, close });

describe('chart intervals', () => {
  it('gives every interval button a distinct candle size (the old 15m / 1D / 5D all loaded 15-minute candles)', () => {
    const sizes = CHART_INTERVALS.map((i) => INTERVAL_CONFIG[i].seconds);
    expect(new Set(sizes).size).toBe(CHART_INTERVALS.length);
    expect(INTERVAL_CONFIG['1D'].broker).toBe('ONE_DAY');
    expect(INTERVAL_CONFIG['15m'].broker).toBe('FIFTEEN_MINUTE');
  });
  it('keeps every load inside the broker per-request limit', () => {
    const limit: Record<string, number> = { ONE_MINUTE: 30, THREE_MINUTE: 60, FIVE_MINUTE: 100, FIFTEEN_MINUTE: 200, THIRTY_MINUTE: 200, ONE_HOUR: 400, ONE_DAY: 2000 };
    for (const i of CHART_INTERVALS) expect(INTERVAL_CONFIG[i].days).toBeLessThanOrEqual(limit[INTERVAL_CONFIG[i].broker]);
  });
  it('offers only ranges that fit the interval, always including its default and All', () => {
    expect(rangesFor('1m')).toEqual(['1D', '5D', 'ALL']);
    expect(rangesFor('1D')).toEqual(['1M', '3M', '6M', '1Y', 'ALL']);
    for (const i of CHART_INTERVALS) expect(rangesFor(i)).toContain(INTERVAL_CONFIG[i].defaultRange);
  });
});

describe('visible range', () => {
  // Thu 29 Oct, Fri 30 Oct, then Mon 2 Nov sessions with 15-minute bars.
  const days = ['2026-10-29', '2026-10-30', '2026-11-02'];
  const bars = days.flatMap((d) => Array.from({ length: 25 }, (_, i) => bar(ist(`${d}T09:15:00`) + i * 900)));
  it('counts trading sessions, not calendar days, for 1D and 5D', () => {
    expect(rangeStart(bars, '1D')).toBe(ist('2026-11-02T09:15:00'));
    expect(rangeStart(bars, '5D')).toBeNull(); // fewer than five sessions loaded → show all
  });
  it('shows everything for All or when the range is wider than the history', () => {
    expect(rangeStart(bars, 'ALL')).toBeNull();
    expect(rangeStart(bars, '1M')).toBeNull();
  });
});

describe('weekly candles and cleaning', () => {
  it('builds Monday-start weekly candles from daily ones', () => {
    const daily = ['2026-10-26', '2026-10-27', '2026-10-30', '2026-11-02'].map((d, i) => ({ ...bar(ist(`${d}T00:00:00`), 100 + i), volume: 10 }));
    const w = aggregateWeekly(daily);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ time: ist('2026-10-26T00:00:00'), open: 100, close: 102, high: 103, low: 99, volume: 30 });
    expect(w[1].time).toBe(ist('2026-11-02T00:00:00'));
  });
  it('sorts, de-duplicates and drops invalid rows', () => {
    const rows = [
      { timestamp: '2026-11-02T09:30:00+05:30', open: 2, high: 3, low: 1, close: 2 },
      { timestamp: '2026-11-02T09:15:00+05:30', open: 1, high: 2, low: 1, close: 1 },
      { timestamp: '2026-11-02T09:30:00+05:30', open: 2, high: 4, low: 1, close: 3 },
      { timestamp: 'bad', open: 1, high: 1, low: 1, close: 1 },
      { timestamp: '2026-11-02T09:45:00+05:30', open: 0, high: 1, low: 0, close: 1 },
    ];
    const out = cleanBars(rows);
    expect(out.map((b) => b.close)).toEqual([1, 3]);
  });
});
