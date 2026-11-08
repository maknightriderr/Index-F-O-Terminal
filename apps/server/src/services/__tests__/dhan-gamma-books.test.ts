// Expiry gamma (8 Nov): the expiry-day option books an index subscribes on its expiry afternoon.
import { describe, it, expect } from 'vitest';
import { freshExpiryDayOptions, freshGammaBookWindow } from '../fresh-start/markets.js';

const ist = (h: number, m: number) => Date.parse('2026-11-10T00:00:00Z') - 19_800_000 + (h * 60 + m) * 60_000;
const ref = { id: 'NFO:1', name: 'NIFTY', market: 'NSE_INDEX_OPTIONS', signal: { exchange: 'NSE' } } as any;
const opt = (token: string, expiry: string, strike: number, optionType: 'CE' | 'PE') => ({ token, exchange: 'NSE', segment: 'FO', name: 'NIFTY', instrumentType: 'OPTIDX', expiry, strike, optionType, lotSize: 75, tickSize: 0.05 }) as any;

describe('expiry-day books', () => {
  it('the 5 strikes nearest the price of the contract expiring today, CE and PE', () => {
    const master = [...[23800, 23900, 24000, 24100, 24200, 24300].flatMap((k) => [opt(`a${k}C`, '2026-11-10', k, 'CE'), opt(`a${k}P`, '2026-11-10', k, 'PE')]), opt('next', '2026-11-17', 24000, 'CE')];
    const out = freshExpiryDayOptions(master, ref, '2026-11-10', 24010);
    expect(out).toHaveLength(10);
    expect([...new Set(out.map((x: any) => x.strike))].sort()).toEqual([23800, 23900, 24000, 24100, 24200]);
    expect(out.every((x: any) => x.expiry === '2026-11-10')).toBe(true);
    expect(freshExpiryDayOptions(master, ref, '2026-11-11', 24010)).toEqual([]);
    expect(freshExpiryDayOptions(master, ref, '2026-11-10', null)).toEqual([]);
  });
  it('only 13:10-15:20 IST', () => {
    expect([freshGammaBookWindow(ist(13, 9)), freshGammaBookWindow(ist(13, 10)), freshGammaBookWindow(ist(15, 19)), freshGammaBookWindow(ist(15, 20))]).toEqual([false, true, true, false]);
  });
});
