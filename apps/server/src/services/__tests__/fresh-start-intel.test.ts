// 2.0 stocks in play: the F&O universe scan -> per-stock intel and the selection of stock references.
import { describe, it, expect } from 'vitest';
import { FRESH_INTEL_MAX_AGE_MS } from '@fno/analytics';
import { freshParseScan, freshSectorStrength, freshStockIntel, freshStocksInPlay, freshInPlayDirection, type FreshScan } from '../fresh-start/intel.js';

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
