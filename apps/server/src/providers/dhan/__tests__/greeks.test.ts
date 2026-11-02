import { describe, expect, it } from 'vitest';
import { greeksFromDhanChain } from '../greeks.js';
import { dhanIndexIds } from '../quotes.js';

describe('Dhan option-chain Greeks (2 Nov)', () => {
  it('maps each strike side to the provider shape and drops junk rows', () => {
    const data = { status: 'success', data: { last_price: 24850, oc: {
      '24850.000000': { ce: { implied_volatility: 12.4, last_price: 118.4, greeks: { delta: 0.52, gamma: 0.0012, theta: -14.1, vega: 12.3 } }, pe: { implied_volatility: 0, last_price: 104, greeks: { delta: -0.48, gamma: 0.001, theta: -13, vega: 12 } } },
      '24900.000000': { pe: { implied_volatility: '13.1', last_price: 130, greeks: { delta: '-0.56', gamma: 0.001, theta: -12, vega: 11 } } },
      bad: { ce: { implied_volatility: 10, greeks: { delta: 1, gamma: 0, theta: 0, vega: 0 } } },
    } } };
    const rows = greeksFromDhanChain(data, 'NIFTY', '2026-11-04');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'NIFTY', expiry: '2026-11-04', strikePrice: 24850, optionType: 'CE', iv: 12.4, delta: 0.52, ltp: 118.4 });
    expect(rows[1]).toMatchObject({ strikePrice: 24900, optionType: 'PE', iv: 13.1, delta: -0.56 });
    expect(greeksFromDhanChain({}, 'NIFTY', '2026-11-04')).toEqual([]);
  });
  it('reads index security ids from the scrip master and drops ambiguous symbols', () => {
    const csv = ['SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_TRADING_SYMBOL', 'NSE,I,13,NIFTY', 'BSE,I,51,SENSEX', 'NSE,E,2885,RELIANCE', 'NSE,I,1,DUP', 'BSE,I,2,DUP'].join('\n');
    const ids = dhanIndexIds(csv);
    expect(ids.get('NIFTY')).toBe('13');
    expect(ids.get('SENSEX')).toBe('51');
    expect(ids.has('RELIANCE')).toBe(false);
    expect(ids.has('DUP')).toBe(false);
  });
});
