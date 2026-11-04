import { describe, expect, it } from 'vitest';
import { freshRankStocks, type FreshReference } from '../fresh-start/markets.js';

const ref = (name: string, token: string) => ({ id: `NSE_CM:${token}`, name, market: 'NSE_STOCK_OPTIONS', signal: { token } }) as unknown as FreshReference;

describe('active F&O stock ranking (5 Nov)', () => {
  it('puts the biggest movers first, then traded value, and unquoted stocks last in their original order', () => {
    const refs = [ref('A', '1'), ref('B', '2'), ref('C', '3'), ref('D', '4'), ref('E', '5')];
    const q = new Map([
      ['1', { ltp: 100, close: 100, volume: 1000 }],               // flat
      ['2', { ltp: 105, close: 100, volume: 10 }],                 // +5%
      ['3', { ltp: 95, close: 100, volume: 10 }],                  // −5%, same move, same value
      ['4', { ltp: 200, close: 190, volume: 0 }],                  // no volume: not ranked
    ]);
    expect(freshRankStocks(refs, q).map((r) => r.name)).toEqual(['B', 'C', 'A', 'D', 'E']);
    expect(freshRankStocks(refs, new Map([['5', { ltp: 50, close: 50, volume: 1, percentChange: -7 }]])).map((r) => r.name)[0]).toBe('E');
  });
});
