// Dhan engine v2, phase 6: validation from stored data on the real schema (PGlite) — recorded signals graded on the
// recorded trade events, and a footprint replay of one contract's events.
import { describe, it, expect, vi, beforeAll } from 'vitest';
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
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
const v = await import('../dhan-engine-validation.js');

const OPEN = Date.parse('2026-11-09T03:45:00Z'); // Monday 09:15 IST
const Q = 900_000;
const blob = (rows: Array<[number, number | null, number, number]>) => gzipSync(Buffer.from(JSON.stringify(rows)));
async function events(symbol: string, barTime: number, rows: Array<[number, number | null, number, number]>) {
  await pg.query(`INSERT INTO order_flow_events(symbol,exchange,instrument,bar_time,bar_ms,trades,unreconciled_volume,encoding,events,version) VALUES($1,'NSE','X-FUT',$2,900000,$3,0,'gzip-json-v1',$4,'OF-1.0')`, [symbol, new Date(barTime).toISOString(), rows.length, blob(rows)]);
}
async function bar(symbol: string, barTime: number) {
  await pg.query(`INSERT INTO order_flow_bars(symbol,exchange,instrument,source,bar_time,bar_ms,delta_mode,trades,version,tick_size,price_step) VALUES($1,'NSE','X-FUT','DHAN',$2,900000,'INFERRED',1,'OF-1.0',0.5,1)`, [symbol, new Date(barTime).toISOString()]);
}
async function signal(strategy: string, side: string, symbol: string, barTime: number, status: string, entry: number, sl: number, target: number) {
  await pg.query(`INSERT INTO dhan_engine_signals(strategy,side,symbol,bar_time,status,entry,stop_loss,target,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'DHAN-SETUPS-1.1')`, [strategy, side, symbol, new Date(barTime).toISOString(), status, entry, sl, target]);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";').catch(() => undefined);
  await pg.exec("CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid AS 'SELECT gen_random_uuid()' LANGUAGE SQL;").catch(() => undefined);
  for (const f of ['038_order_blocks_order_flow_of1.sql', '052_order_flow_events.sql', '053_dhan_engine_signals.sql', '054_dhan_engine_paper.sql']) await pg.exec(readFileSync(new URL(`../../../../../database/init/${f}`, import.meta.url), 'utf8'));
  // NIFTY: decision bar 09:30, then a bar that reaches 104.5 (target 104) and a later one; RELIANCE: the stop is hit.
  for (const k of [1, 2, 3]) await bar('NIFTY', OPEN + k * Q);
  await events('NIFTY', OPEN + Q, [[1000, 100, 10, 1]]);
  await events('NIFTY', OPEN + 2 * Q, [[1000, 101, 10, 1], [2000, 104.5, 10, 1], [3000, null, 5, 9], [4000, 103, 10, -1]]);
  await events('NIFTY', OPEN + 3 * Q, [[1000, 103, 10, 0]]);
  await events('RELIANCE', OPEN + 2 * Q, [[1000, 2990, 10, -1]]);
  await signal('DHAN_A_SWEEP_ABSORPTION', 'BULLISH', 'NIFTY', OPEN + Q, 'SIGNAL', 100, 98, 104);
  await signal('DHAN_D_VWAP_PROFILE_REJECTION', 'BEARISH', 'RELIANCE', OPEN + Q, 'SIGNAL', 2980, 2988, 2950);
  await signal('DHAN_C_FAILED_AUCTION_CVD', 'BULLISH', 'NIFTY', OPEN + Q, 'NO_TRADE', 100, 99, 101);
  await signal('DHAN_EXPIRY_GAMMA', 'BULLISH', 'NIFTY', OPEN + Q, 'SIGNAL', 24000, 0, 0); // never graded (no stop)
}, 30_000);

describe('recorded trade events', () => {
  it('decode: trades with sides, unreconciled volume kept apart, bars from exact prices', () => {
    const d = v.decodeFlowEvents(blob([[1000, 101, 10, 1], [2000, null, 5, 9], [3000, 100, 4, 0]]), OPEN);
    expect(d).toEqual({ trades: [{ time: OPEN + 1000, price: 101, qty: 10, side: 'BUY' }, { time: OPEN + 3000, price: 100, qty: 4, side: null }], unreconciled: 5 });
    expect(v.barOfTrades(OPEN, d.trades)).toEqual({ time: OPEN, open: 101, high: 101, low: 100, close: 100, volume: 14 });
  });
});

describe('validation of recorded signals', () => {
  it('grades SIGNAL rows on later bars of the session (target +2R, stop -1R), NO_TRADE separately, gamma excluded', async () => {
    const r = await v.dhanValidation('2026-11-09', '2026-11-09');
    expect(r.signals).toBe(3);
    expect(r.overall).toMatchObject({ trades: 2, wins: 1, losses: 1, totalR: 1, sample: 'SMALL_SAMPLE' });
    expect(r.byStrategy.map((x) => [x.strategy, x.stats.totalR])).toEqual([['DHAN_A_SWEEP_ABSORPTION', 2], ['DHAN_D_VWAP_PROFILE_REJECTION', -1]]);
    // NIFTY tick 0.5 -> 1 point slippage on a 2-point risk = 0.5 R.
    expect(r.byStrategy[0].stats.totalNetR).toBe(1.5);
    expect(r.rejected).toMatchObject({ trades: 1, wins: 1 });
    expect(r.candleBacktest).toMatch(/^NOT_POSSIBLE/);
  });
  it('bounds the range', async () => {
    await expect(v.dhanValidation('2026-01-01', '2026-11-09')).rejects.toThrow(/Range/);
    await expect(v.dhanReplay('NIFTY', '2026-11-01', '2026-11-20')).rejects.toThrow(/Replay range/);
  });
});

describe('footprint replay', () => {
  it('rebuilds footprints from the recorded events and re-runs the setups bar by bar', async () => {
    const r = await v.dhanReplay('NIFTY', '2026-11-09', '2026-11-09');
    expect(r).toMatchObject({ symbol: 'NIFTY', bars: 3, evaluations: 3 });
    expect(r.report.version).toBe('DHAN-VAL-1.0');
    expect(r.report.basis).toBe('FOOTPRINT_REPLAY');
  });
});
