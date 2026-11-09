// Sampled order flow (owner decision, 9 Nov 2026): the live Dhan feed reveals ~25% of volume as observed trades, so a
// bar above the complete threshold keeps its observed flow as a labelled sample when coverage >= 15% and >= 30 trades.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/db.js', () => ({ sql: () => { throw new Error('no SQL'); } }));
vi.mock('../../lib/redis.js', () => ({ redis: {} }));
const { applyReconciliation } = await import('../order-flow-store.js');
const { radarOf } = await import('../dhan-engine-shadow.js');
import { buildFootprint, type FlowTrade } from '@fno/analytics';

const trades = (n: number): FlowTrade[] => Array.from({ length: n }, (_, k) => ({ time: 1000 + k, price: 100 + (k % 3), qty: 10, side: k % 3 === 0 ? 'SELL' : 'BUY' }));
const fp = (n: number) => buildFootprint(trades(n), 0, 900_000, 1, 'INFERRED');

describe('applyReconciliation (sampled)', () => {
  it('complete at <= 20% unreconciled', () => {
    expect(applyReconciliation(fp(40), 50)).toMatchObject({ incomplete: false, sampled: false, coverage: 0.8889 });
  });
  it('a sample above 20% when coverage >= 15% and >= 30 observed trades: delta and imbalances kept', () => {
    const f = applyReconciliation(fp(40), 1200); // 400 observed of 1600 = 25%
    expect(f).toMatchObject({ incomplete: false, sampled: true, coverage: 0.25 });
    expect(f.delta).not.toBeNull();
  });
  it('INCOMPLETE below 15% coverage or under 30 trades', () => {
    expect(applyReconciliation(fp(40), 3000)).toMatchObject({ incomplete: true, sampled: false, delta: null }); // 400 of 3400 = 11.8%
    expect(applyReconciliation(fp(20), 400)).toMatchObject({ incomplete: true, sampled: false, delta: null }); // 33% but 20 trades
  });
});

describe('radar outcome per setup', () => {
  it('keeps the side that got furthest, SIGNAL and NO_TRADE first', () => {
    const r = (setup: string, side: string, status: string, failed: string | null, ok: number, extra: object = {}) => ({ setup, side, status, failed, checks: Array.from({ length: ok + (failed ? 1 : 0) }, (_, k) => ({ id: `c${k}`, ok: k < ok })), gates: [], noTrade: null, score: null, ...extra }) as any;
    expect(radarOf([r('A', 'BULLISH', 'NO_SETUP', 'A3', 2), r('A', 'BEARISH', 'NO_SETUP', 'A5', 4), r('B', 'BULLISH', 'NO_SETUP', 'B1', 0), r('B', 'BEARISH', 'NO_TRADE', null, 9, { gates: [{ id: 'MIN_RR_2', ok: false }], score: { total: 6 } })])).toEqual({
      A: { status: 'NO_SETUP', side: null, failed: 'A5', passed: 4, score: null },
      B: { status: 'NO_TRADE', side: 'BEARISH', failed: 'MIN_RR_2', passed: 9, score: 6 },
    });
  });
});

describe('closed-bar counter (9 Nov: a reader closing the bar first starved the shadow pass)', () => {
  it('counts every bar closed, whoever closes it', async () => {
    const store = await import('../order-flow-store.js');
    store.resetFlowStore();
    const T = Date.parse('2026-11-09T03:45:00Z');
    store.registerFlowSymbol('CNT', { exchange: 'NSE', instrument: 'CNT-FUT', source: 'DHAN', mode: 'INFERRED', startedAt: T - 900_000, kind: 'STOCK', tickSize: 0.05 });
    store.recordFlowTrade('CNT', { time: T + 1000, price: 100, qty: 5, side: 'BUY' });
    const before = store.flowClosedBarCount();
    await store.closeFlowBars(T + 900_001, true); // e.g. footprintsFor() closing it
    expect(store.flowClosedBarCount()).toBe(before + 1);
    expect(await store.closeFlowBars(T + 900_002, true)).toBe(0); // the feed's tick then sees nothing written...
    expect(store.flowClosedBarCount()).toBe(before + 1); // ...but the counter still shows a bar closed since its last pass
  });
});
