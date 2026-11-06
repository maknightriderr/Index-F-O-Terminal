// 2.0 stocks in play: the F&O universe scan -> per-stock intel and the selection of stock references.
import { describe, it, expect } from 'vitest';
import { FRESH_INTEL_MAX_AGE_MS } from '@fno/analytics';
import { freshParseScan, freshSectorStrength, freshStockIntel, freshStocksInPlay, freshInPlayDirection, freshIndexBreadth, freshFuturesOiRead, freshOiBefore, freshIndexIntel, FRESH_INDEX_HEAVYWEIGHTS, type FreshScan } from '../fresh-start/intel.js';

const now = Date.parse('2026-11-09T06:00:00Z');
const row = (symbol: string, x: Record<string, unknown> = {}) => ({ symbol, exchange: 'NSE', price: 100, changePercent: 1, volume: 1, futuresOi: 1, futuresChangeOi: 1, futuresChangeOiPercent: 1, oiInterpretation: 'LONG_BUILDUP', pcr: 1, atmIv: 20, ceIv: 20, peIv: 20, ivSkew: 0, ivRank: 40, ivPercentile: 40, atmGamma: 0, atmTheta: 0, atmVega: 0, atmSpreadPct: 0.5, direction: 'BULLISH', confidence: 50, score: 50, relativeStrength: 1.2, timestamp: now - 60000, ...x }) as any;
const ref = (name: string) => ({ id: `NSE_FO:${name}`, name, market: 'NSE_STOCK_OPTIONS', signal: { token: name, name, underlying: name }, spot: { token: name, exchangeSegment: 'NSE_CM' }, riskGroup: name }) as any;
const scan = (rows: any[], at = now - 60000): FreshScan => ({ at, rows });

describe('fresh-start 2.0 intel', () => {
  it('parses only a well-formed stored scan', () => {
    expect(freshParseScan(JSON.stringify({ at: now, rows: [] }))).toEqual({ at: now, rows: [] });
    for (const bad of [null, '', '{', JSON.stringify({ at: 'x', rows: [] }), JSON.stringify({ at: now })]) expect(freshParseScan(bad)).toBeNull();
  });
  it('averages sector relative strength over at least two members', () => {
    const s = freshSectorStrength([row('HDFCBANK', { relativeStrength: 1 }), row('ICICIBANK', { relativeStrength: 2 }), row('TCS', { relativeStrength: 3 })]);
    expect(s.get('Banking')).toBe(1.5);
    expect(s.has('IT')).toBe(false); // one member only
  });
  it('reads a stock point-in-time: never a scan older than 6 minutes or newer than the decision', () => {
    const x = freshStockIntel(scan([row('HDFCBANK'), row('ICICIBANK', { relativeStrength: 0.4 })]), ref('HDFCBANK'), now);
    expect(x).toMatchObject({ at: now - 60000, relativeStrength: 1.2, oiInterpretation: 'LONG_BUILDUP', sectorRelativeStrength: 0.8, atmSpreadPct: 0.5, ivRank: 40 });
    expect(freshStockIntel(scan([row('HDFCBANK', { timestamp: now - FRESH_INTEL_MAX_AGE_MS - 1 })], now - FRESH_INTEL_MAX_AGE_MS - 1), ref('HDFCBANK'), now)).toBeNull();
    expect(freshStockIntel(scan([row('HDFCBANK', { timestamp: now + 1000 })], now + 1000), ref('HDFCBANK'), now)).toBeNull();
    expect(freshStockIntel(scan([row('TCS')]), ref('HDFCBANK'), now)).toBeNull();
    expect(freshStockIntel(null, ref('HDFCBANK'), now)).toBeNull();
    expect(freshStockIntel(scan([row('HDFCBANK', { atmSpreadPct: null, ivRank: null })]), ref('HDFCBANK'), now)).toMatchObject({ atmSpreadPct: null, ivRank: null });
  });
  it('classifies the in-play direction with the same gates as the strategy', () => {
    const base = { at: now, relativeStrength: 1, oiInterpretation: 'LONG_BUILDUP', sectorRelativeStrength: 0.2, atmSpreadPct: 0.5, ivRank: 30 };
    expect(freshInPlayDirection(base)).toBe(1);
    expect(freshInPlayDirection({ ...base, relativeStrength: -1, oiInterpretation: 'SHORT_BUILDUP', sectorRelativeStrength: -0.2 })).toBe(-1);
    expect(freshInPlayDirection({ ...base, relativeStrength: 0.5 })).toBe(0);
    expect(freshInPlayDirection({ ...base, oiInterpretation: 'SHORT_BUILDUP' })).toBe(0);
    expect(freshInPlayDirection({ ...base, sectorRelativeStrength: -0.5 })).toBe(0);
    expect(freshInPlayDirection({ ...base, atmSpreadPct: null })).toBe(0);
    expect(freshInPlayDirection({ ...base, ivRank: 80 })).toBe(0);
  });
  it('selects leaders and laggards alternately, keeps a still-qualified pick, and skips event-blocked stocks', () => {
    const rows = [row('A', { relativeStrength: 2 }), row('B', { relativeStrength: 1 }), row('C', { relativeStrength: -3, oiInterpretation: 'SHORT_BUILDUP' }), row('D', { relativeStrength: -1, oiInterpretation: 'LONG_UNWINDING' }), row('E', { relativeStrength: 0.2 }), row('F', { relativeStrength: 5 })];
    const stocks = ['A', 'B', 'C', 'D', 'E', 'F'].map(ref), clear = (r: any) => r.name !== 'F';
    expect(freshStocksInPlay(scan(rows), stocks, now, 3, new Set(), clear).map((r) => r.name)).toEqual(['A', 'C', 'B']);
    expect(freshStocksInPlay(scan(rows), stocks, now, 3, new Set(['NSE_FO:D']), clear).map((r) => r.name)).toEqual(['D', 'A', 'C']);
    expect(freshStocksInPlay(scan(rows), stocks, now, 0, new Set(), clear)).toEqual([]);
    expect(freshStocksInPlay(null, stocks, now, 3, new Set(), clear)).toEqual([]);
  });
});

describe('fresh-start 2.0 index intel', () => {
  const heavy = (above: string[], missing: string[] = []) => scan(Object.keys(FRESH_INDEX_HEAVYWEIGHTS.BANKNIFTY).filter((x) => !missing.includes(x)).map((x) => row(x, { price: 100, vwap: above.includes(x) ? 99 : 101 })));
  it('measures heavyweight breadth by weight, and refuses it below 70% coverage or without a table', () => {
    expect(freshIndexBreadth(heavy(['HDFCBANK', 'ICICIBANK']), 'BANKNIFTY').breadth).toBeCloseTo(53 / 95.5, 6);
    expect(freshIndexBreadth(heavy(Object.keys(FRESH_INDEX_HEAVYWEIGHTS.BANKNIFTY)), 'BANKNIFTY').breadth).toBe(1);
    const thin = freshIndexBreadth(heavy([], ['HDFCBANK', 'ICICIBANK']), 'BANKNIFTY');
    expect(thin.breadth).toBeNull(); expect(thin.coverage).toBeCloseTo(42.5 / 95.5, 6);
    expect(freshIndexBreadth(heavy([]), 'MIDCPNIFTY')).toEqual({ breadth: null, coverage: 0 });
    expect(freshIndexBreadth(scan([row('HDFCBANK', { vwap: undefined })]), 'BANKNIFTY').breadth).toBeNull(); // no VWAP, no vote
  });
  it('reads the index future price / OI over 30 minutes, only with >= 20 minutes of samples', () => {
    const s = (min: number, price: number, oi: number) => ({ at: now - min * 60000, price, oi });
    expect(freshFuturesOiRead([s(25, 100, 1000), s(0, 101, 1100)], now)).toBe('LONG_BUILDUP');
    expect(freshFuturesOiRead([s(25, 100, 1000), s(0, 99, 1100)], now)).toBe('SHORT_BUILDUP');
    expect(freshFuturesOiRead([s(25, 100, 1000), s(0, 101, 900)], now)).toBe('SHORT_COVERING');
    expect(freshFuturesOiRead([s(25, 100, 1000), s(0, 99, 900)], now)).toBe('LONG_UNWINDING');
    expect(freshFuturesOiRead([s(25, 100, 1000), s(0, 101, 1003)], now)).toBe('NEUTRAL');
    expect(freshFuturesOiRead([s(10, 100, 1000), s(0, 101, 1100)], now)).toBeNull();
    expect(freshFuturesOiRead([s(25, 100, 1000), s(-1, 101, 1100)], now)).toBeNull(); // a later sample is never read
  });
  it('pairs the latest chain OI with the sample ~15 minutes earlier, and builds point-in-time index intel', () => {
    const c = (min: number) => ({ at: now - min * 60000, strikes: [{ strike: 100, callOi: min, putOi: 1 }] });
    expect(freshOiBefore([c(30), c(16), c(14), c(1)], c(1))?.strikes[0].callOi).toBe(16);
    expect(freshOiBefore([c(5), c(1)], c(1))).toBeNull();
    const x = freshIndexIntel('BANKNIFTY', heavy(Object.keys(FRESH_INDEX_HEAVYWEIGHTS.BANKNIFTY)), [], [c(16), c(1), c(-1)], now)!;
    expect(x).toMatchObject({ breadth: 1, futuresOi: null });
    expect(x.oiNow?.at).toBe(now - 60000); // the later chain sample is not used
    expect(x.oiBefore?.at).toBe(now - 16 * 60000);
    expect(x.at).toBe(now - 60000);
  });
});

