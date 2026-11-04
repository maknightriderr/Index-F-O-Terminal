import { describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/cache.js', () => ({ cached: (_k: string, _t: number, f: () => Promise<unknown>) => f() }));
import { istMinute, lastSessionClose, mcxPreviousClose, mcxPreviousSession } from '../mcx-previous-close.js';

describe('MCX previous close from candles (5 Nov: CRUDEOIL ~740 down shown as ~17 up)', () => {
  it('finds the previous MCX session, skipping the weekend', () => {
    const thu = mcxPreviousSession(Date.parse('2026-11-05T15:00:00+05:30'))!;
    expect(thu.date).toBe('2026-11-04');
    const mon = mcxPreviousSession(Date.parse('2026-11-09T10:00:00+05:30'))!;
    expect(mon.date).toBe('2026-11-06');
  });
  it('takes the close of the last candle inside the session', () => {
    const s = { open: Date.parse('2026-11-04T09:00:00+05:30'), close: Date.parse('2026-11-04T23:30:00+05:30') };
    const rows = [
      { timestamp: '2026-11-04T23:20:00+05:30', close: 9850 },
      { timestamp: '2026-11-04T23:25:00+05:30', close: 9860 },
      { timestamp: '2026-11-04T23:30:00+05:30', close: 1 }, // after the close: ignored
      { timestamp: 'bad', close: 2 },
    ];
    expect(lastSessionClose(rows, s)).toBe(9860);
    expect(lastSessionClose([], s)).toBeNull();
  });
  it('asks for the previous session\'s last three hours of five-minute candles (MCX closes 23:55 IST in US winter)', async () => {
    const getHistoricalData = vi.fn(async () => [{ timestamp: '2026-11-04T23:25:00+05:30', open: 1, high: 1, low: 1, close: 9860, volume: 1 }]);
    const v = await mcxPreviousClose({ getHistoricalData } as any, '123', Date.parse('2026-11-05T15:00:00+05:30'));
    expect(v).toBe(9860);
    expect(getHistoricalData).toHaveBeenCalledWith(expect.objectContaining({ exchange: 'MCX', segment: 'FO', token: '123', interval: 'FIVE_MINUTE', toDate: '2026-11-04 23:55', fromDate: '2026-11-04 20:55' }));
    expect(istMinute(Date.parse('2026-11-04T18:00:00Z'))).toBe('2026-11-04 23:30');
  });
});
