// Second audit (8 Nov): previous-day / previous-week levels only from complete days (exchange calendar).
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/db.js', () => ({ sql: () => { throw new Error('no SQL'); } }));
vi.mock('../../lib/redis.js', () => ({ redis: {} }));
const { referenceCompleteness } = await import('../dhan-engine-shadow.js');
import { unavailableFootprint, type FootprintBar } from '@fno/analytics';

const Q = 900_000;
const open = (day: string) => Date.parse(`${day}T09:15:00+05:30`);
/** A traded footprint at a time. */
const fp = (t: number): FootprintBar => ({ ...unavailableFootprint(t, Q), deltaMode: 'INFERRED', levels: [{ price: 1, buy: 1, sell: 0, unclassified: 0 }], high: 1, low: 1, close: 1, volume: 1, delta: 1 });
const day = (d: string, from = 0, to = 24) => Array.from({ length: to - from + 1 }, (_, k) => fp(open(d) + (from + k) * Q)); // 09:15 .. 15:15 bars

describe('referenceCompleteness', () => {
  // Monday 9 Nov 2026: previous session Friday 6 Nov; previous ISO week 2-6 Nov.
  it('both complete when the previous session and every trading day of last week are covered', () => {
    const fps = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].flatMap((d) => day(d));
    expect(referenceCompleteness(fps, 'NSE', '2026-11-09')).toEqual({ previousDay: true, previousWeek: true });
  });
  it('a previous session that started late or a missing weekday makes the level unavailable', () => {
    const lateFriday = [...['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].flatMap((d) => day(d)), ...day('2026-11-06', 12)];
    expect(referenceCompleteness(lateFriday, 'NSE', '2026-11-09')).toEqual({ previousDay: false, previousWeek: false });
    const noMonday = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].flatMap((d) => day(d));
    expect(referenceCompleteness(noMonday, 'NSE', '2026-11-09')).toEqual({ previousDay: true, previousWeek: false });
  });
  it('follows the exchange calendar: Wednesday 11 Nov after the Tuesday 10 Nov holiday reads Monday as the previous session', () => {
    expect(referenceCompleteness(day('2026-11-09'), 'NSE', '2026-11-11').previousDay).toBe(true);
    expect(referenceCompleteness(day('2026-11-06'), 'NSE', '2026-11-11').previousDay).toBe(false);
  });
});
