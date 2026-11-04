import { describe, expect, it, beforeEach } from 'vitest';
import { flowFiveMinuteBars, recordFlowTrade, registerFlowSymbol, resetFlowStore } from '../order-flow-store.js';
import { freshOrderFlowFor } from '../fresh-start/worker.js';

const t0 = Date.parse('2026-11-05T04:00:00Z');
describe('five-minute order flow for the fresh-start shadow tag (5 Nov)', () => {
  beforeEach(() => resetFlowStore());
  it('aggregates inferred buy / sell / unclassified volume per five-minute bar', () => {
    registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: 'NIFTY-Nov2026-FUT', source: 'DHAN', mode: 'INFERRED', startedAt: t0 });
    recordFlowTrade('NIFTY', { time: t0 + 1000, price: 1, qty: 75, side: 'BUY' });
    recordFlowTrade('NIFTY', { time: t0 + 2000, price: 1, qty: 25, side: 'SELL' });
    recordFlowTrade('NIFTY', { time: t0 + 3000, price: 1, qty: 10, side: null });
    recordFlowTrade('NIFTY', { time: t0 + 300000, price: 1, qty: 5, side: 'SELL' });
    const f = flowFiveMinuteBars('NIFTY', t0, t0 + 600000)!;
    expect(f.instrument).toBe('NIFTY-Nov2026-FUT');
    expect(f.bars).toEqual([{ time: t0, buy: 75, sell: 25, unclassified: 10, trades: 3 }, { time: t0 + 300000, buy: 0, sell: 5, unclassified: 0, trades: 1 }]);
  });
  it('starts a fresh series on a contract change and uses the parent only when the mini is not carried', () => {
    registerFlowSymbol('CRUDEOIL', { exchange: 'MCX', instrument: 'CRUDEOIL-19Nov2026-FUT', source: 'DHAN', mode: 'INFERRED', startedAt: t0 });
    recordFlowTrade('CRUDEOIL', { time: t0 + 1000, price: 1, qty: 3, side: 'BUY' });
    expect(freshOrderFlowFor('CRUDEOILM', t0, t0 + 600000)).toMatchObject({ proxy: true, instrument: 'CRUDEOIL-19Nov2026-FUT' });
    expect(freshOrderFlowFor('CRUDEOIL', t0, t0 + 600000)).toMatchObject({ proxy: false });
    expect(freshOrderFlowFor('SENSEX', t0, t0 + 600000)).toBeUndefined();
    registerFlowSymbol('CRUDEOIL', { exchange: 'MCX', instrument: 'CRUDEOIL-18Dec2026-FUT', source: 'DHAN', mode: 'INFERRED', startedAt: t0 + 400000 });
    recordFlowTrade('CRUDEOIL', { time: t0 + 400000, price: 1, qty: 2, side: 'SELL' });
    expect(flowFiveMinuteBars('CRUDEOIL', t0, t0 + 600000)!.bars).toEqual([{ time: t0 + 300000, buy: 0, sell: 2, unclassified: 0, trades: 1 }]);
  });
});
