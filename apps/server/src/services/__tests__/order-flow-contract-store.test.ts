import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sql: Object.assign(vi.fn(async () => [] as any[]), { json: (v: unknown) => v }) }));
vi.mock('../../lib/db.js', () => ({ sql: mocks.sql }));
vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
const S = await import('../order-flow-store.js');
const T = Date.parse('2026-10-06T10:45:00+05:30'), M = 900_000;
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(T + M); S.resetFlowStore(); mocks.sql.mockClear(); mocks.sql.mockResolvedValue([]); });

it('closed footprints preserve their source contract', async () => {
  S.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: 'OCT', source: 'DHAN', mode: 'INFERRED', startedAt: T - M });
  S.recordFlowTrade('NIFTY', { time: T + 1, price: 100, qty: 10, side: 'BUY' });
  await S.closeFlowBars(T + M);
  expect((await S.footprintsFor('NIFTY', [T])).get(T)?.sourceInstrument).toBe('OCT');
});
it('rollover drops the mixed partial bar without relabelling closed footprints', async () => {
  S.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: 'OCT', source: 'DHAN', mode: 'INFERRED', startedAt: T - 2 * M });
  S.recordFlowTrade('NIFTY', { time: T - M + 1, price: 100, qty: 10, side: 'BUY' });
  await S.closeFlowBars(T);
  S.recordFlowTrade('NIFTY', { time: T + 1, price: 100, qty: 10, side: 'BUY' });
  S.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: 'NOV', source: 'DHAN', mode: 'INFERRED', startedAt: T + 2 });
  expect(S.flowStoreStatus()[0]).toMatchObject({ instrument: 'NOV', openTrades: 0, lastClosed: T });
  expect((await S.footprintsFor('NIFTY', [T - M])).get(T - M)?.sourceInstrument).toBe('OCT');
});
it.each(['OCT', null])('database reload preserves instrument %s; missing identity stays unknown', async instrument => {
  mocks.sql.mockResolvedValue([{ instrument, bar_time: new Date(T), bar_ms: M, delta_mode: 'INFERRED', trades: 1, volume: 10, buy_volume: 10, sell_volume: 0, unclassified_volume: 0, delta: 10, delta_pct: 1, poc: 100, vah: 100, val: 100, levels: [{ price: 100, buy: 10, sell: 0, unclassified: 0 }] }]);
  expect((await S.footprintsFor('NIFTY', [T])).get(T)?.sourceInstrument).toBe(instrument);
});
