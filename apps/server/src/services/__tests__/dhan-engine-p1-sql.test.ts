// Dhan engine v2, phase 1: the footprint / event writes and the nightly event cleanup on the real 038 + 052 schema
// (PGlite), so production cannot meet an untested statement.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
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
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
const store = await import('../order-flow-store.js');
const { trimFlowEvents, flowEventRetentionDays } = await import('../fresh-start/maintenance.js');

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";').catch(() => undefined);
  await pg.exec("CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid AS 'SELECT gen_random_uuid()' LANGUAGE SQL;").catch(() => undefined);
  for (const f of ['038_order_blocks_order_flow_of1.sql', '052_order_flow_events.sql']) await pg.exec(readFileSync(new URL(`../../../../../database/init/${f}`, import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../../../../../database/init/052_order_flow_events.sql', import.meta.url), 'utf8')); // idempotent
}, 30_000);

describe('Dhan engine v2 storage', () => {
  it('writes a closed bar\'s footprint (with unreconciled volume, tick and step) and its compressed events', async () => {
    const bar = Date.parse('2026-11-09T04:00:00Z'); // 09:30 IST, NSE open
    store.resetFlowStore();
    store.registerFlowSymbol('RELIANCE', { exchange: 'NSE', instrument: 'RELIANCE-Nov2026-FUT', source: 'DHAN', mode: 'INFERRED', startedAt: bar - 900000, kind: 'STOCK', tickSize: 0.1 });
    store.recordFlowTrade('RELIANCE', { time: bar + 1000, price: 2800, qty: 500, side: 'BUY' });
    store.recordFlowTrade('RELIANCE', { time: bar + 2000, price: 2801.4, qty: 1000, side: 'SELL' });
    store.recordFlowUnreconciled('RELIANCE', bar + 3000, 500);
    expect(await store.closeFlowBars(bar + 900000 + 1000, true)).toBe(1);
    const [row] = (await pg.query<any>("SELECT * FROM order_flow_bars WHERE symbol='RELIANCE'")).rows;
    expect(Number(row.unreconciled_volume)).toBe(500);
    expect(Number(row.tick_size)).toBe(0.1);
    expect(Number(row.price_step)).toBe(1.4); // ~5 bp of 2800 at tick 0.1
    // 500 unreconciled of 1500 + 500 = 25% > 20%: the bar is INCOMPLETE, its delta withheld (never a misleading number).
    expect(row.delta).toBeNull();
    expect(row.delta_pct).toBeNull();
    expect(row.unavailable_reason).toBe('INCOMPLETE_UNRECONCILED_VOLUME');
    expect(row.delta_mode).toBe('INFERRED');
    const [ev] = (await pg.query<any>("SELECT * FROM order_flow_events WHERE symbol='RELIANCE'")).rows;
    expect(ev).toMatchObject({ exchange: 'NSE', instrument: 'RELIANCE-Nov2026-FUT', trades: 2, encoding: 'gzip-json-v1' });
    expect(JSON.parse(gunzipSync(Buffer.from(ev.events)).toString())).toEqual([[1000, 2800, 500, 1], [2000, 2801.4, 1000, -1], [3000, null, 500, 9]]);
  });
  it('deletes only events past the retention, in batches, and reports storage', async () => {
    const now = Date.parse('2026-11-09T21:00:00Z'), day = 86_400_000;
    for (const [i, age] of [45, 31, 29, 1].entries())
      await pg.query(`INSERT INTO order_flow_events(symbol,exchange,instrument,bar_time,bar_ms,trades,unreconciled_volume,encoding,events,version) VALUES($1,'NSE','X',$2,900000,1,0,'gzip-json-v1',$3,'OF-1.0')`, [`S${i}`, new Date(now - age * day).toISOString(), Buffer.from([1])]);
    expect(flowEventRetentionDays(undefined)).toBe(30);
    expect(flowEventRetentionDays('90')).toBe(90);
    expect(flowEventRetentionDays('3')).toBe(30); // out of range -> default
    expect(await trimFlowEvents(db as any, now, 30)).toBe(2);
    const left = (await pg.query<any>("SELECT symbol FROM order_flow_events WHERE symbol LIKE 'S%' ORDER BY symbol")).rows.map((r) => r.symbol);
    expect(left).toEqual(['S2', 'S3']);
    expect(await trimFlowEvents(db as any, now, 30)).toBe(0);
  });
});
