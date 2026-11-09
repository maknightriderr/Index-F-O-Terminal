// Dhan engine v2, phase 2: the per-contract engine snapshot over the live flow store (trade VWAP accumulated per
// session and contract, footprint v2 / CVD / profile / structure read from closed bars), read-only.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/db.js', () => ({ sql: () => { throw new Error('no SQL expected'); } }));
vi.mock('../../lib/redis.js', () => ({ redis: {} }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => false }));
const store = await import('../order-flow-store.js');
const { dhanEngineSnapshot, dhanEngineSummary } = await import('../dhan-engine-state.js');

const OPEN = Date.parse('2026-11-09T03:45:00Z'); // Monday 09:15 IST
const Q = 900_000;

beforeEach(() => {
  store.resetFlowStore();
  store.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: 'NIFTY-Nov2026-FUT', source: 'DHAN', mode: 'INFERRED', startedAt: OPEN - Q, kind: 'INDEX', tickSize: 0.1 });
});

describe('Dhan engine snapshot', () => {
  it('trade-based session VWAP of the current contract, labelled; unreconciled volume degrades it', async () => {
    store.recordFlowTrade('NIFTY', { time: OPEN + 1000, price: 100, qty: 10, side: 'BUY' });
    store.recordFlowTrade('NIFTY', { time: OPEN + 2000, price: 102, qty: 30, side: 'SELL' });
    await store.closeFlowBars(OPEN + Q + 1, true);
    const s = dhanEngineSnapshot('NIFTY', OPEN + Q + 1)!;
    expect(s.vwap).toMatchObject({ status: 'ESTIMATED', source: 'TRADES', vwap: 101.5, sd: 0.866 });
    expect(s.bars).toBe(1);
    store.recordFlowUnreconciled('NIFTY', OPEN + Q + 5000, 20); // 40 observed of 60: a usable sample (9 Nov)
    expect(dhanEngineSnapshot('NIFTY', OPEN + Q + 6000)!.vwap.status).toBe('ESTIMATED');
    store.recordFlowUnreconciled('NIFTY', OPEN + Q + 5500, 300); // 40 of 360 = 11% < 15%: incomplete
    expect(dhanEngineSnapshot('NIFTY', OPEN + Q + 6000)!.vwap.status).toBe('INCOMPLETE');
    // Next IST session: VWAP restarts.
    store.recordFlowTrade('NIFTY', { time: OPEN + 86_400_000 + 1000, price: 110, qty: 5, side: 'BUY' });
    expect(dhanEngineSnapshot('NIFTY', OPEN + 86_400_000 + 2000)!.vwap.vwap).toBe(110);
  });

  it('runs footprint v2, CVD, profile and structure over the session\'s closed bars', async () => {
    // Six 15-minute bars rising 10 points each; every bar buys 300 at its top rows and sells 100.
    for (let k = 0; k < 6; k++) {
      const t = OPEN + k * Q, base = 1000 + k * 10;
      for (const [dp, q, side] of [[0, 100, 'SELL'], [3, 100, 'BUY'], [6, 100, 'BUY'], [9, 100, 'BUY']] as const) store.recordFlowTrade('NIFTY', { time: t + 1000 + dp * 100, price: base + dp, qty: q, side });
    }
    await store.closeFlowBars(OPEN + 6 * Q + 1, true);
    const s = dhanEngineSnapshot('NIFTY', OPEN + 6 * Q + 1)!;
    expect(s).toMatchObject({ bars: 6, tradedBars: 6, incompleteBars: 0, kind: 'INDEX', tickSize: 0.1 });
    expect(s.cvd.last).toMatchObject({ cvd: 1200, status: 'ESTIMATED' }); // 6 x (300 - 100)
    expect(s.footprint!.status).toBe('ESTIMATED');
    expect(s.profile.status).toBe('VERIFIED');
    expect(s.profile.valueAreaShare!).toBeGreaterThanOrEqual(0.7);
    expect(s.atr).toMatchObject({ value: 9, source: 'MEAN_15M_RANGE' });
    expect(s.structure).toMatchObject({ source: 'FLOW_15M_BARS' });
    expect(dhanEngineSummary(OPEN + 6 * Q + 1)).toMatchObject([{ symbol: 'NIFTY', bars: 6, cvd: 1200, cvdStatus: 'ESTIMATED', footprint: 'ESTIMATED' }]);
  });

  it('a closed bar without trades leaves the session CVD INCOMPLETE (never an assumed zero)', async () => {
    store.recordFlowTrade('NIFTY', { time: OPEN + 1000, price: 100, qty: 10, side: 'BUY' });
    store.recordFlowTrade('NIFTY', { time: OPEN + 2 * Q + 1000, price: 101, qty: 10, side: 'BUY' });
    await store.closeFlowBars(OPEN + 3 * Q + 1, true);
    const s = dhanEngineSnapshot('NIFTY', OPEN + 3 * Q + 1)!;
    expect(s.bars).toBe(3);
    expect(s.cvd.last).toMatchObject({ cvd: 20, status: 'INCOMPLETE' });
    expect(s.cvd.divergences).toEqual([]);
  });

  it('is null for an unknown symbol', () => {
    expect(dhanEngineSnapshot('NOPE')).toBeNull();
  });
});
