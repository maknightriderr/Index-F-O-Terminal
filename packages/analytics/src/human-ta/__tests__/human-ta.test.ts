import { describe, expect, it } from 'vitest';
import { evaluateHumanTa, htaPickOption, htaCandleOf, htaTrendOf, HTA_STRATEGY_ID, type HtaBar, type HtaChain, type HtaInput } from '../index.js';

const OPEN = Date.parse('2026-11-16T03:45:00Z'); // Monday 09:15 IST
const bar = (time: number, o: number, h: number, l: number, c: number, volume = 1000): HtaBar => ({ time, open: o, high: h, low: l, close: c, volume });
// A steady uptrend on the 15-minute chart (100 bars, +2 a bar), ending at 1200.
const bars15 = Array.from({ length: 100 }, (_, k) => { const c = 1000 + 2 * k; return bar(OPEN - (100 - k) * 900_000, c - 1, c + 3, c - 4, c); });
const daily = Array.from({ length: 40 }, (_, k) => { const c = 900 + 7 * k; return bar(OPEN - (40 - k) * 86_400_000, c - 3, c + 8, c - 8, c); });
// Previous session 5-minute bars, then today: a tight 12-bar box at 1200-1204, then a breakout bar on 2x volume.
const prev5 = Array.from({ length: 60 }, (_, k) => { const c = 1140 + k; return bar(OPEN - 86_400_000 + k * 300_000, c - 0.5, c + 1, c - 1, c); });
const box = Array.from({ length: 12 }, (_, k) => bar(OPEN + k * 300_000, 1202, 1204, 1200, k % 2 ? 1203 : 1201));
const breakout = bar(OPEN + 12 * 300_000, 1203, 1209, 1202.5, 1208.5, 2500);
const leg = (ask: number, delta: number, oi = 1000) => ({ ltp: ask, bid: ask - 0.4, ask, oi, iv: 14, delta, gamma: 0.002, theta: -8 });
const chain = (at: number, putOi = 1000): HtaChain => ({
  at, spot: 1208, expiry: '2026-11-19', daysToExpiry: 3,
  strikes: [1180, 1190, 1200, 1210, 1220, 1230, 1260].map((strike) => ({ strike, call: leg(Math.max(5, 1208 - strike + 25), Math.min(0.9, Math.max(0.1, 0.5 + (1208 - strike) / 60)), strike === 1260 ? 5000 : 800), put: leg(Math.max(5, strike - 1208 + 25), -Math.min(0.9, Math.max(0.1, 0.5 + (strike - 1208) / 60)), strike === 1200 ? putOi : 600) })),
});
const input = (extra: Partial<HtaInput> = {}): HtaInput => ({
  symbol: 'NIFTY', now: OPEN + 13 * 300_000 + 1000, sessionOpen: OPEN, sessionClose: OPEN + 6.25 * 3_600_000,
  bars5: [...prev5, ...box, breakout], bars15, daily, chain: chain(OPEN + 13 * 300_000), chainBefore: chain(OPEN + 10 * 300_000, 800), futuresOi: 'LONG_BUILDUP', ...extra,
});
const mirrorBars = (bs: readonly HtaBar[]) => bs.map((b) => ({ ...b, open: 3000 - b.open, high: 3000 - b.low, low: 3000 - b.high, close: 3000 - b.close }));

describe('Human TA (HTA-1.0)', () => {
  it('reads trend and candles from raw bars', () => {
    expect(htaTrendOf(bars15)).toBe('UP');
    expect(htaTrendOf(mirrorBars(bars15))).toBe('DOWN');
    expect(htaCandleOf(breakout, box[11])).toBe('STRONG_BULL');
  });
  it('a range breakout in an uptrend, on volume, with put writing and a liquid call -> a bullish signal with a CE strike', () => {
    const r = evaluateHumanTa(input());
    expect(r.signal, JSON.stringify(r.best)).not.toBeNull();
    const s = r.signal!;
    expect(s).toMatchObject({ side: 'BULLISH', pattern: 'RANGE_BREAKOUT_12', entry: 1208.5 });
    expect(s.stop).toBeLessThan(1202.5);
    expect(s.target).toBeGreaterThan(s.entry);
    expect(s.rr).toBeGreaterThanOrEqual(1.5);
    expect(s.option.side).toBe('CE');
    expect(Math.abs(s.option.delta)).toBeGreaterThanOrEqual(0.45);
    expect(Math.abs(s.option.delta)).toBeLessThanOrEqual(0.65);
    expect(s.option.optionRr).toBeGreaterThanOrEqual(1.2);
    expect(s.score).toBeGreaterThanOrEqual(65);
    expect(s.lines.map((l) => l.item)).toEqual(expect.arrayContaining(['DAILY_TREND_WITH', 'TREND_15M_WITH', 'PATTERN_RANGE_BREAKOUT_12', 'VOLUME_HIGH', 'PUT_WRITING_NEAR_SPOT', 'FUTURES_LONG_BUILDUP', 'OPTION_PICKED']));
    expect(HTA_STRATEGY_ID).toBe('HTA_HUMAN_TA_V1');
  });
  it('the same breakout against a falling daily trend and short build-up loses its edge', () => {
    const r = evaluateHumanTa(input({ daily: mirrorBars(daily).map((b) => ({ ...b, open: b.open - 1900, high: b.high - 1900, low: b.low - 1900, close: b.close - 1900 })), futuresOi: 'SHORT_BUILDUP' }));
    expect(r.signal?.side).not.toBe('BULLISH');
  });
  it('without an option chain there is no trade (the option is part of the decision)', () => {
    const r = evaluateHumanTa(input({ chain: null }));
    expect(r.signal).toBeNull();
    expect(r.best?.refusal).toBe('NO_OPTION_CHAIN');
  });
  it('the mirrored chart gives a bearish signal with a PE strike', () => {
    const m = (c: HtaChain): HtaChain => ({ ...c, spot: 3000 - c.spot, strikes: c.strikes.map((s) => ({ strike: 3000 - s.strike, call: s.put, put: s.call })) });
    const r = evaluateHumanTa(input({ bars5: mirrorBars([...prev5, ...box, breakout]), bars15: mirrorBars(bars15), daily: mirrorBars(daily), chain: m(chain(OPEN + 13 * 300_000)), chainBefore: m(chain(OPEN + 10 * 300_000, 800)), futuresOi: 'SHORT_BUILDUP' }));
    expect(r.signal, JSON.stringify(r.best)).not.toBeNull();
    expect(r.signal).toMatchObject({ side: 'BEARISH', pattern: 'RANGE_BREAKDOWN_12', entry: 1791.5 });
    expect(r.signal!.stop).toBeGreaterThan(r.signal!.entry);
    expect(r.signal!.target).toBeLessThan(r.signal!.entry);
    expect(r.signal!.option.side).toBe('PE');
  });
  it('picks the strike whose own delta, gamma and theta give the best R:R; skips wide spreads and out-of-band deltas', () => {
    const c: HtaChain = { at: 0, spot: 100, expiry: 'x', daysToExpiry: 3, strikes: [
      { strike: 100, call: { ltp: 5, bid: 4.95, ask: 5, oi: 1, iv: 15, delta: 0.5, gamma: 0.05, theta: -2 }, put: null },
      { strike: 98, call: { ltp: 6, bid: 5.95, ask: 6, oi: 1, iv: 15, delta: 0.6, gamma: 0.04, theta: -2 }, put: null },
      { strike: 102, call: { ltp: 4, bid: 3, ask: 4, oi: 1, iv: 15, delta: 0.45, gamma: 0.05, theta: -2 }, put: null }, // 29% spread
      { strike: 95, call: { ltp: 8, bid: 7.95, ask: 8, oi: 1, iv: 15, delta: 0.8, gamma: 0.02, theta: -2 }, put: null }, // delta out of band
    ] };
    const { best, ranked } = htaPickOption(c, 'CE', 4, 2, 1.5);
    expect(ranked.map((r) => r.strike).sort()).toEqual([100, 98]);
    expect(best!.premiumAtTarget).toBeCloseTo(5 + 0.5 * 4 + 0.5 * 0.05 * 16 - 2 * (1.5 / 24), 2);
    expect(best!.optionRr).toBeGreaterThan(1);
  });
});
