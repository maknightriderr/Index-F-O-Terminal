// Setup E1 (11 Nov): each order-flow future's daily trend from its own daily candles, read once a day in the background.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logs = vi.hoisted(() => ({ info: [] as any[], warn: [] as any[] }));
vi.mock('../../lib/logger.js', () => ({ logger: { info: (o: any) => logs.info.push(o), warn: (o: any) => logs.warn.push(o), error() {}, debug() {} } }));
vi.mock('../dhan-session.js', () => ({ dhanSession: () => ({ clientId: 'c', accessToken: 't' }), markDhanTokenRejected: vi.fn() }));
const { prefetchDhanDaily, dhanDailyTrend, resetDhanDaily } = await import('../dhan-daily.js');

const NOW = Date.parse('2026-11-12T03:00:00Z'); // 08:30 IST
const contract = (securityId: string, tradingSymbol: string, kind: 'INDEX' | 'STOCK' | 'COMMODITY' = 'INDEX') => ({ securityId, tradingSymbol, expiry: '2026-11-25', segment: 'NSE_FNO' as const, exchange: 'NSE' as const, kind, tickSize: 0.1, lotSize: 75 });
const rising = Array.from({ length: 40 }, (_, k) => ({ time: NOW - (41 - k) * 86_400_000, open: 100 + k, high: 101 + k, low: 99 + k, close: 100 + k }));

beforeEach(() => { resetDhanDaily(); logs.info.length = 0; logs.warn.length = 0; });

describe('Dhan daily trend prefetch', () => {
  it('reads each contract once a day and serves the trend for the same contract only', async () => {
    const fetch = vi.fn(async (r: { securityId: string }) => (r.securityId === '1' ? rising : rising.slice(0, 10)));
    const resolved = { NIFTY: contract('1', 'NIFTY-Nov2026-FUT'), RELIANCE: contract('2', 'RELIANCE-Nov2026-FUT', 'STOCK') };
    expect(await prefetchDhanDaily(resolved, NOW, { spacingMs: 0, fetch })).toEqual({ read: 2, failed: 0, counts: { BULLISH: 1, UNKNOWN: 1 } });
    expect(dhanDailyTrend('NIFTY', NOW, 'NIFTY-Nov2026-FUT')).toEqual({ trend: 'BULLISH', bars: 40 });
    expect(dhanDailyTrend('RELIANCE', NOW)).toEqual({ trend: 'UNKNOWN', bars: 10 }); // too short: unknown, never a guess
    expect(dhanDailyTrend('NIFTY', NOW, 'NIFTY-Dec2026-FUT')).toBeNull(); // another contract
    expect(dhanDailyTrend('NIFTY', NOW + 86_400_000)).toBeNull(); // another day
    await prefetchDhanDaily(resolved, NOW + 60_000, { spacingMs: 0, fetch });
    expect(fetch).toHaveBeenCalledTimes(2); // already read today
  });
  it('a failed contract is retried by the next pass; a rejected session stops the pass', async () => {
    let fail = true;
    const fetch = vi.fn(async () => { if (fail) throw Object.assign(new Error('timeout'), { status: null }); return rising; });
    const resolved = { NIFTY: contract('1', 'NIFTY-Nov2026-FUT') };
    expect(await prefetchDhanDaily(resolved, NOW, { spacingMs: 0, fetch })).toMatchObject({ read: 0, failed: 1 });
    expect(dhanDailyTrend('NIFTY', NOW)).toBeNull();
    fail = false;
    expect(await prefetchDhanDaily(resolved, NOW, { spacingMs: 0, fetch })).toMatchObject({ read: 1, failed: 0 });
    resetDhanDaily();
    const denied = vi.fn(async () => { throw Object.assign(new Error('401'), { status: 401 }); });
    expect(await prefetchDhanDaily({ A: contract('1', 'A'), B: contract('2', 'B') }, NOW, { spacingMs: 0, fetch: denied })).toMatchObject({ read: 0, failed: 1 });
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
