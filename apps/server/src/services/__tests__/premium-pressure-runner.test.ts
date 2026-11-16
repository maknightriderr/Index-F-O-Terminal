import { describe, expect, it, vi } from 'vitest';
import { blackScholesPrice, calculateGreeks, GXP_STRATEGY_ID, freshAccountBook, freshAccountId, type FreshCandidate } from '@fno/analytics';
import type { OptionChain } from '@fno/shared';

vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../lib/telegram.js', () => ({ sendTelegramMessage: vi.fn(async () => undefined) }));
vi.mock('../../lib/db.js', () => ({ sql: vi.fn() }));

import { PremiumPressureRunner, gxpMinutesToExpiry, gxpSampleOf, premiumPressureLatest, GXP_LAST_ENTRY_BEFORE_CUTOFF_MS } from '../premium-pressure/runner.js';
import { gxpSamplesFromRows } from '../premium-pressure/backtest.js';

const OPEN = Date.parse('2026-11-17T03:45:00Z'), CLOSE = Date.parse('2026-11-17T10:00:00Z'), T0 = Date.parse('2026-11-17T05:30:00Z'), min = 60_000;
function chain(at: number, spot: number, peIv: number, peOi: number, peVol: number): OptionChain {
  const t = gxpMinutesToExpiry('2026-11-19', at, CLOSE) / (365 * 1440);
  const leg = (strike: number, type: 'CE' | 'PE', iv: number, oi: number, volume: number) => {
    const input = { spotPrice: spot, strikePrice: strike, timeToExpiry: t, riskFreeRate: 0.065, iv: iv / 100, optionType: type } as const, ltp = Math.round(blackScholesPrice(input) * 20) / 20, g = calculateGreeks(input);
    return { token: `${strike}${type}`, ltp, bid: ltp - 0.1, ask: ltp + 0.1, volume, oi, observedOi: oi, changeOi: 0, changePercent: 0, iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, oiInterpretation: 'NEUTRAL', moneyness: 'ATM', greeksSource: 'CALCULATED', timestamp: at };
  };
  return { symbol: 'NIFTY', underlying: 'NIFTY', exchange: 'NSE', spotPrice: spot, expiry: '2026-11-19', strikeInterval: 50, timestamp: at, strikes: [24850, 24900, 24950, 25000, 25050, 25100, 25150].map((strike) => ({ strike, distanceFromSpot: strike - spot, call: leg(strike, 'CE', 14, 100_000, 50_000), put: leg(strike, 'PE', peIv, peOi, peVol) })) } as unknown as OptionChain;
}
const ref = { id: 'NSE_FO:1', name: 'NIFTY', market: 'NSE_INDEX_OPTIONS', exchange: 'NSE' };
const bars = Array.from({ length: 20 }, (_, i) => ({ time: T0 - (20 - i) * 5 * min, open: 24990 + i, high: 25004 + i, low: 24986 + i, close: 24998 + i, volume: 1000 }));
const tick = (now: number, price: number) => ({ now, session: '2026-11-17', sessionOpen: OPEN, sessionClose: CLOSE, sourceEpoch: 'EPOCH', price, priceAt: now - 500, bars5: bars });
async function feed(r: PremiumPressureRunner, from = 0, to = 10, base = T0) {
  let last: string | null = null;
  for (let i = from; i <= to; i++) { const f = i / 10, at = base + i * min; last = (await r.onChain(ref, chain(at, 25000 + 30 * f, 14 - 1.4 * f, 100_000 + 4000 * f, 50_000 + 12_000 * f), tick(at + 500, 25012 + 8 * f))) ?? last; }
  return last;
}

describe('premium pressure runner', () => {
  it('a bullish read becomes one paper candidate in the GXP book, with the plan and the explanation as evidence', async () => {
    const sent: FreshCandidate[] = [];
    const r = new PremiumPressureRunner({ enter: async (c) => { sent.push(c); return 'FILLED'; }, alert: async () => undefined });
    expect(await feed(r)).toBe('FILLED');
    expect(sent).toHaveLength(1);
    const c = sent[0];
    expect(c.strategy).toBe(GXP_STRATEGY_ID);
    expect(c.direction).toBe('BULLISH');
    expect(c.stop).toBeLessThan(c.referenceEntry); expect(c.target).toBeGreaterThan(c.referenceEntry);
    expect(c.allowedStrikes?.length).toBe(2);
    expect(c.lastEntryBeforeCutoffMs).toBe(GXP_LAST_ENTRY_BEFORE_CUTOFF_MS);
    expect((c.evidence.gxp as any).simulated).toBe(true);
    expect((c.evidence.gxp as any).explanation.length).toBeGreaterThan(2);
    expect(freshAccountBook(freshAccountId(c))).toBe('GXP');
    expect(premiumPressureLatest().find((x) => x.symbol === 'NIFTY')?.classification).toBe('BULLISH_PREMIUM_PRESSURE');
  });
  it('16. duplicate prevention: the same direction in the same 30-minute bucket is sent once', async () => {
    const enter = vi.fn(async () => 'FILLED');
    const r = new PremiumPressureRunner({ enter, alert: async () => undefined });
    await feed(r);
    const again = T0 + 11 * min;
    await r.onChain(ref, chain(again, 25034, 12.5, 104_500, 63_000), tick(again + 500, 25021));
    expect(enter).toHaveBeenCalledTimes(1);
  });
  it('a stale reference price sends nothing; GXP_PAPER=false keeps the analysis and sends nothing', async () => {
    const enter = vi.fn(async () => 'FILLED');
    const r = new PremiumPressureRunner({ enter, alert: async () => undefined });
    let last: string | null = null;
    for (let i = 0; i <= 10; i++) { const f = i / 10, at = T0 + i * min; last = (await r.onChain(ref, chain(at, 25000 + 30 * f, 14 - 1.4 * f, 100_000 + 4000 * f, 50_000 + 12_000 * f), { ...tick(at + 500, 25020), priceAt: at - 60_000 })) ?? last; }
    expect(last).toBe('REFERENCE_PRICE_STALE'); expect(enter).not.toHaveBeenCalled();
    process.env.GXP_PAPER = 'false';
    try { const r2 = new PremiumPressureRunner({ enter, alert: async () => undefined }); expect(await feed(r2)).toBe('GXP_PAPER_OFF'); expect(enter).not.toHaveBeenCalled(); } finally { delete process.env.GXP_PAPER; }
  });
  it('never throws on a broken chain', async () => {
    const r = new PremiumPressureRunner({ enter: async () => 'FILLED' });
    expect(await r.onChain(ref, { strikes: null } as unknown as OptionChain, tick(T0, 25000))).toBeNull();
  });
  it('expiry mapping: minutes to the expiry day close; chain conversion keeps missing OI as missing', () => {
    expect(gxpMinutesToExpiry('2026-11-17', T0, CLOSE)).toBe(270);
    expect(Math.round(gxpMinutesToExpiry('2026-11-19', T0, CLOSE))).toBe(270 + 2 * 1440);
    const c = chain(T0, 25000, 14, 100_000, 50_000); (c.strikes[0].call as any).observedOi = null;
    expect(gxpSampleOf(c, CLOSE).strikes[0].call!.oi).toBeNull();
  });
  it('stored rows become samples on the nearest expiry only (backtest input)', () => {
    const row = (time: string, strike: number, type: string, expiry: string, ltp: number) => ({ time: new Date(time), strike, option_type: type, expiry, oi: 1000, volume: 10, ltp, bid: null, ask: null, iv: 14, delta: 0.5, gamma: 0.001, theta: -8, vega: 9, spot_price: 25000 });
    const rows = [24900, 24950, 25000, 25050, 25100].flatMap((k) => [row('2026-11-17T05:30:00Z', k, 'CE', '2026-11-19', 80), row('2026-11-17T05:30:00Z', k, 'PE', '2026-11-19', 70), row('2026-11-17T05:30:00Z', k, 'CE', '2026-11-26', 150)]);
    const s = gxpSamplesFromRows(rows as never, 15 * 60 + 30);
    expect(s).toHaveLength(1); expect(s[0].expiry).toBe('2026-11-19'); expect(s[0].strikeStep).toBe(50);
    expect(s[0].strikes[0].call!.ltp).toBe(80); expect(s[0].strikes[0].call!.ask).toBeGreaterThan(80);
  });
});
