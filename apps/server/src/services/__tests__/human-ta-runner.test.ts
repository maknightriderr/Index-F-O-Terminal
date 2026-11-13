// Human TA runner (owner, 13 Nov): chain in the reference's price space, one evaluation per 5-minute close, the
// candidate on HTA's own strike (back in chain strikes), its own book, an alert with the reasoning.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../../lib/telegram.js', () => ({ sendTelegramMessage: vi.fn(async () => undefined) }));
vi.mock('../dhan-daily.js', () => ({ dhanDailyBars: () => [] }));
const { HumanTaRunner, htaChainOf, daysToExpiry } = await import('../human-ta/runner.js');
const { freshAccountId } = await import('@fno/analytics');

const OPEN = Date.parse('2026-11-16T03:45:00Z');
const bar = (time: number, o: number, h: number, l: number, c: number, volume = 1000) => ({ time, availableAt: time + 300_000, open: o, high: h, low: l, close: c, volume });
const bars15 = Array.from({ length: 100 }, (_, k) => { const c = 1000 + 2 * k; return { ...bar(OPEN - (100 - k) * 900_000, c - 1, c + 3, c - 4, c), availableAt: OPEN - (99 - k) * 900_000 }; });
const daily = Array.from({ length: 40 }, (_, k) => { const c = 900 + 7 * k; return { time: OPEN - (40 - k) * 86_400_000, open: c - 3, high: c + 8, low: c - 8, close: c }; });
const prev5 = Array.from({ length: 60 }, (_, k) => { const c = 1140 + k; return bar(OPEN - 86_400_000 + k * 300_000, c - 0.5, c + 1, c - 1, c); });
const box = Array.from({ length: 12 }, (_, k) => bar(OPEN + k * 300_000, 1202, 1204, 1200, k % 2 ? 1203 : 1201));
const breakout = bar(OPEN + 12 * 300_000, 1203, 1209, 1202.5, 1208.5, 2500);
const now = OPEN + 13 * 300_000 + 1000;
const BASIS = 20; // the future trades 20 above the spot the strikes are on
const leg = (ask: number, delta: number, oi: number) => ({ token: 't', ltp: ask, bid: ask - 0.4, ask, volume: 1, oi, changeOi: 0, iv: 14, delta, gamma: 0.002, theta: -8 });
const chain = (putOi: number) => ({ symbol: 'NIFTY', spotPrice: 1208 - BASIS, expiry: '2026-11-19', timestamp: now, strikes: [1180, 1190, 1200, 1210, 1220, 1230, 1260].map((k) => ({ strike: k - BASIS, call: leg(Math.max(5, 1208 - k + 25), Math.min(0.9, Math.max(0.1, 0.5 + (1208 - k) / 60)), k === 1260 ? 5000 : 800), put: leg(Math.max(5, k - 1208 + 25), -Math.min(0.9, Math.max(0.1, 0.5 + (k - 1208) / 60)), k === 1200 ? putOi : 600) })) }) as any;
const context = (t = now) => ({ now: t, session: '2026-11-16', sessionOpen: OPEN, sessionClose: OPEN + 6.25 * 3_600_000, instrument: 'NSE_FO:1', sourceEpoch: 'e1', bars5: [...prev5, ...box, breakout], bars15, indexIntel: { futuresOi: 'LONG_BUILDUP' } }) as any;

describe('Human TA runner', () => {
  it('reads the chain in the reference price space and days to expiry in IST', () => {
    const { chain: c, basis } = htaChainOf(chain(1000), 1208.5, now);
    expect(basis).toBeCloseTo(20.5, 5);
    expect(c.strikes[0].strike).toBeCloseTo(1160 + 20.5, 5);
    expect(daysToExpiry('2026-11-19', now)).toBe(3);
    expect(daysToExpiry('2026-11-16', now)).toBe(0);
  });
  it('a signal becomes one paper candidate on HTA strikes (chain strikes), in its own book, with an alert; once per bar', async () => {
    let calls = 0;
    const chainFn = vi.fn(async () => (calls++ === 0 ? chain(800) : chain(1000)));
    const enter = vi.fn(async () => 'FILLED'), alert = vi.fn(async () => undefined);
    const runner = new HumanTaRunner({ chain: chainFn, enter, alert, daily: () => daily });
    // A first read 15 minutes earlier (the OI baseline), then the breakout bar.
    (runner as any).chains.set('NSE_FO:1', [{ at: now - 15 * 60_000, chain: htaChainOf(chain(800), 1208.5, now).chain, basis: 20.5 }]);
    expect(await runner.onBar({ id: 'NSE_FO:1', name: 'NIFTY', market: 'NSE_INDEX_OPTIONS', exchange: 'NSE' }, context())).toBe('FILLED');
    const c = (enter.mock.calls[0] as any[])[0];
    expect(c).toMatchObject({ strategy: 'HTA_HUMAN_TA_V1', direction: 'BULLISH', referenceEntry: 1208.5, exitProfile: 'TARGET', instrument: 'NSE_FO:1' });
    expect(c.allowedStrikes.length).toBeGreaterThan(0);
    for (const k of c.allowedStrikes) expect([1160, 1170, 1180, 1190, 1200, 1210, 1240]).toContain(Math.round(k)); // back on the chain's strikes
    expect(freshAccountId(c)).toContain(':HTA:');
    expect((alert.mock.calls[0] as any[])[0]).toMatch(/Human TA · NIFTY BUY CE[\s\S]*Paper decision: FILLED/);
    expect(await runner.onBar({ id: 'NSE_FO:1', name: 'NIFTY', market: 'NSE_INDEX_OPTIONS', exchange: 'NSE' }, context(now + 1000))).toBeNull(); // same bar
    expect(await runner.onBar({ id: 'NSE_CM:1', name: 'RELIANCE', market: 'NSE_STOCK_OPTIONS', exchange: 'NSE' }, context())).toBeNull(); // not its market
  });
  it('no chain: no trade, and nothing thrown', async () => {
    const runner = new HumanTaRunner({ chain: async () => { throw new Error('down'); }, enter: vi.fn(), alert: vi.fn(), daily: () => daily });
    expect(await runner.onBar({ id: 'X', name: 'NIFTY', market: 'NSE_INDEX_OPTIONS', exchange: 'NSE' }, context())).toBe('NO_OPTION_CHAIN');
  });
});
