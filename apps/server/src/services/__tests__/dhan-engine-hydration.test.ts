// 8 Nov audit fix: after a restart the order-flow store rebuilds today's and the previous session's closed bars from
// the recorded trade events (PGlite, 038 + 052), keeps the bar the process started in as an INCOMPLETE gap marker, and
// every session-level reading downstream (VWAP, CVD, setups) is labelled incomplete instead of restarting silently.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';

let pg: PGlite;
const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce((q, s, i) => q + s + (i < values.length ? `$${i + 1}` : ''), '');
  return pg.query(text, values.map((v) => (v instanceof Date ? v.toISOString() : v))).then((r) => r.rows);
};
const db = Object.assign(tag, { json: (x: unknown) => JSON.stringify(x) });
vi.mock('../../lib/db.js', () => ({ sql: db }));
vi.mock('../../lib/redis.js', () => ({ redis: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn(o: any, m: string) { throw new Error(`unexpected warn: ${m} ${JSON.stringify(o)}`); }, error() {}, debug() {} } }));
const schema = { ready: true };
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: (f: string) => schema.ready && f !== '053_dhan_engine_signals.sql' }));
const store = await import('../order-flow-store.js');
const { dhanEngineSnapshot } = await import('../dhan-engine-state.js');
const { setupContextFor } = await import('../dhan-engine-shadow.js');

const OPEN = Date.parse('2026-11-09T03:45:00Z'); // Monday 09:15 IST
const FRI = OPEN - 3 * 86_400_000, THU = OPEN - 4 * 86_400_000, Q = 900_000;
const INSTR = 'NIFTY-Nov2026-FUT';
const blob = (rows: Array<[number, number | null, number, number]>) => gzipSync(Buffer.from(JSON.stringify(rows)));
async function recorded(symbol: string, barTime: number, rows: Array<[number, number | null, number, number]>, instrument = INSTR) {
  await pg.query(`INSERT INTO order_flow_events(symbol,exchange,instrument,bar_time,bar_ms,trades,unreconciled_volume,encoding,events,version) VALUES($1,'NSE',$2,$3,900000,$4,0,'gzip-json-v1',$5,'OF-1.0')`, [symbol, instrument, new Date(barTime).toISOString(), rows.length, blob(rows)]);
  await pg.query(`INSERT INTO order_flow_bars(symbol,exchange,instrument,source,bar_time,bar_ms,delta_mode,trades,version,tick_size,price_step) VALUES($1,'NSE',$2,'DHAN',$3,900000,'INFERRED',1,'OF-1.0',0.1,1)`, [symbol, instrument, new Date(barTime).toISOString()]);
}
const healthy = () => ({ stale: false, mappingValid: true });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";').catch(() => undefined);
  await pg.exec("CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid AS 'SELECT gen_random_uuid()' LANGUAGE SQL;").catch(() => undefined);
  for (const f of ['038_order_blocks_order_flow_of1.sql', '052_order_flow_events.sql', '055_order_flow_open_bars.sql']) await pg.exec(readFileSync(new URL(`../../../../../database/init/${f}`, import.meta.url), 'utf8'));
  await recorded('NIFTY', THU, [[1000, 90, 10, 1]]); // two sessions back: not rebuilt
  await recorded('NIFTY', FRI, [[1000, 100, 10, 1], [2000, 104, 10, -1]]);
  await recorded('NIFTY', FRI + Q, [[1000, 103, 10, 1], [2000, 102, 10, -1]]);
  await recorded('NIFTY', OPEN, [[1000, 110, 20, 1], [2000, 112, 10, -1], [3000, null, 5, 9]]);
  await recorded('NIFTY', OPEN + Q, [[1000, 112, 10, 1], [2000, 113, 30, 1]]);
  await recorded('NIFTY', OPEN + 2 * Q, [[1000, 500, 10, 1]], 'NIFTY-Oct2026-FUT'); // another contract: ignored
}, 30_000);

beforeEach(() => store.resetFlowStore());

describe('restart hydration', () => {
  it('rebuilds today and the previous session, marks the lost restart bar, and flags session totals incomplete', async () => {
    const started = OPEN + 52 * 60_000; // 10:07 IST: the 10:00 bar's earlier trades are lost
    store.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: INSTR, source: 'DHAN', mode: 'INFERRED', startedAt: started, kind: 'INDEX', tickSize: 0.1 });
    expect(await store.hydrateFlowSymbol('NIFTY', started + 1000)).toBe(4);
    expect(await store.hydrateFlowSymbol('NIFTY', started + 2000)).toBe(0); // once per contract
    const fps = store.flowContractBars('NIFTY')!.footprints;
    expect(fps.map((f) => [f.barTime, f.deltaMode, !!f.incomplete])).toEqual([[FRI, 'INFERRED', false], [FRI + Q, 'INFERRED', false], [OPEN, 'INFERRED', false], [OPEN + Q, 'INFERRED', false], [OPEN + 3 * Q, 'UNAVAILABLE', true]]);
    expect(fps[2]).toMatchObject({ open: 110, high: 112, low: 110, close: 112, delta: 10, unreconciledVolume: 5, priceStep: 1, tickSize: 0.1, sourceInstrument: INSTR, tradeSums: { pv: 110 * 20 + 112 * 10, v: 30 } });
    // 11 Nov: the same recorded events also rebuild the 5-minute footprints (index / commodity futures).
    expect(store.flowContractFiveBars('NIFTY')!.footprints.filter((f) => f.deltaMode !== 'UNAVAILABLE').map((f) => [f.barTime, f.volume, f.unreconciledVolume])).toEqual([[FRI, 20, 0], [FRI + Q, 20, 0], [OPEN, 30, 5], [OPEN + Q, 40, 0]]);
    const s = store.flowSessionState('NIFTY', started + 3000)!;
    expect(s.vwap).toMatchObject({ sums: { pv: 110 * 20 + 112 * 10 + 112 * 10 + 113 * 30, v: 70 }, unreconciled: 5, incomplete: true });
    expect(store.flowFiveMinuteBars('NIFTY', OPEN, OPEN + 2 * Q)!.bars.map((b) => [b.buy, b.sell, b.unreconciled])).toEqual([[20, 10, 5], [40, 0, 0]]);
    const snap = dhanEngineSnapshot('NIFTY', started + 3000)!;
    expect(snap.vwap.status).toBe('INCOMPLETE');
    expect(snap.cvd.last).toMatchObject({ status: 'INCOMPLETE' });
    const ctx = (await setupContextFor('NIFTY', started + 3000, healthy, false))!;
    expect(ctx.sessionOpen).toBe(OPEN); // the exchange open, not the first traded bar
    expect(ctx.health.sessionGapAt).toBe(OPEN + 3 * Q);
    expect(ctx.daily.map((d) => [d.time, d.high, d.low, d.close])).toEqual([[FRI, 104, 100, 102]]);
  });
  it('a start before the session opens loses nothing: no gap marker, complete VWAP', async () => {
    const started = OPEN - 25 * 60_000; // 08:50 IST
    store.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: INSTR, source: 'DHAN', mode: 'INFERRED', startedAt: started, kind: 'INDEX', tickSize: 0.1 });
    expect(await store.hydrateFlowSymbol('NIFTY', started + 1000)).toBe(2); // the previous session only
    const fps = store.flowContractBars('NIFTY')!.footprints;
    expect(fps.every((f) => !f.incomplete)).toBe(true);
    expect(store.flowSessionState('NIFTY', started + 1000)!.vwap).toBeNull();
  });
  it('F-08: a restart inside a bar restores its checkpointed events, and the bar closes whole', async () => {
    const BAR = OPEN + 4 * Q, reg = (startedAt: number) => store.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: INSTR, source: 'DHAN', mode: 'INFERRED', startedAt, kind: 'INDEX', tickSize: 0.1 });
    reg(OPEN - 25 * 60_000);
    store.recordFlowTrade('NIFTY', { time: BAR + 60_000, price: 120, qty: 10, side: 'BUY' });
    store.recordFlowTrade('NIFTY', { time: BAR + 120_000, price: 121, qty: 4, side: 'SELL' });
    store.recordFlowUnreconciled('NIFTY', BAR + 130_000, 3);
    expect(await store.checkpointOpenFlowBars(BAR + 300_000)).toBe(1);
    expect(await store.checkpointOpenFlowBars(BAR + 310_000)).toBe(0); // nothing new since the last save
    // The process restarts one minute after the checkpoint, inside the same bar.
    store.resetFlowStore();
    const started = BAR + 360_000;
    reg(started);
    store.recordFlowTrade('NIFTY', { time: BAR + 420_000, price: 122, qty: 6, side: 'BUY' });
    expect(await store.hydrateFlowSymbols(started + 1000)).toMatchObject({ openBars: 1, failed: 0 });
    expect(store.flowContractBars('NIFTY')!.footprints.some((f) => f.barTime === BAR)).toBe(false); // no gap marker
    expect(store.flowSessionState('NIFTY', started + 2000)!.vwap).toMatchObject({ incomplete: false, unreconciled: 5 + 3 });
    await store.closeFlowBars(BAR + Q + 1000, true);
    const fp = store.flowContractBars('NIFTY')!.footprints.find((f) => f.barTime === BAR)!;
    expect(fp).toMatchObject({ open: 120, volume: 20, delta: 12, unreconciledVolume: 3, deltaMode: 'INFERRED' });
    expect(fp.incomplete).toBeFalsy();
    await pg.query(`DELETE FROM order_flow_events WHERE bar_time = $1`, [new Date(BAR).toISOString()]);
    await pg.query(`DELETE FROM order_flow_bars WHERE bar_time = $1`, [new Date(BAR).toISOString()]);
  });
  it('F-08: a checkpoint older than the allowed gap is not restored (the bar stays an INCOMPLETE gap)', async () => {
    const BAR = OPEN + 4 * Q, started = BAR + 300_000 + store.OPEN_BAR_MAX_GAP_MS + 1000; // saved at BAR + 5 min above
    store.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: INSTR, source: 'DHAN', mode: 'INFERRED', startedAt: started, kind: 'INDEX', tickSize: 0.1 });
    expect(await store.hydrateFlowSymbols(started + 1000)).toMatchObject({ openBars: 0 });
    expect(store.flowContractBars('NIFTY')!.footprints.find((f) => f.barTime === BAR)).toMatchObject({ deltaMode: 'UNAVAILABLE', incomplete: true });
    expect(await store.checkpointOpenFlowBars(started + 5000)).toBe(0); // a gap bar is never saved as if it were whole
  });
  it('hydrates every registered symbol and reports totals', async () => {
    store.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: INSTR, source: 'DHAN', mode: 'INFERRED', startedAt: OPEN + 52 * 60_000, kind: 'INDEX', tickSize: 0.1 });
    store.registerFlowSymbol('NOFLOW', { exchange: 'NSE', instrument: 'NOFLOW-Nov2026-FUT', source: 'DHAN', mode: 'INFERRED', startedAt: OPEN + 52 * 60_000, kind: 'STOCK', tickSize: 0.05 });
    expect(await store.hydrateFlowSymbols(OPEN + 53 * 60_000)).toMatchObject({ contracts: 1, bars: 4, failed: 0, schemaReady: true });
  });

  it('waits for the boot-time schema check before reading (9 Nov: the feed resolved 5 s before it finished)', async () => {
    store.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: INSTR, source: 'DHAN', mode: 'INFERRED', startedAt: OPEN + 52 * 60_000, kind: 'INDEX', tickSize: 0.1 });
    schema.ready = false;
    expect(await store.hydrateFlowSymbols(OPEN + 53 * 60_000, { schemaWaitMs: 30, pollMs: 5 })).toMatchObject({ contracts: 0, bars: 0, failed: 0, schemaReady: false });
    setTimeout(() => { schema.ready = true; }, 20);
    expect(await store.hydrateFlowSymbols(OPEN + 53 * 60_000, { schemaWaitMs: 2000, pollMs: 5 })).toMatchObject({ contracts: 1, bars: 4, failed: 0, schemaReady: true });
  });
});
