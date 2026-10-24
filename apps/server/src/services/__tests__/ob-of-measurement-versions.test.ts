import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const bridge = vi.hoisted(() => ({ query: null as null | ((s: readonly string[], v: unknown[]) => Promise<unknown[]>) }));
vi.mock('../../lib/db.js', () => ({ sql: (s: readonly string[], ...v: unknown[]) => bridge.query!(s, v) }));
vi.mock('../../lib/redis.js', () => ({ redis: { set: async () => 'OK' } }));
vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
vi.mock('../dhan-feed.js', () => ({ orderFlowFeedStatus: () => ({ status: 'NOT_CONFIGURED', instruments: {} }) }));
vi.mock('../order-flow-alignment.js', () => ({ orderFlowAlignmentStatus: () => ({}) }));
const { recordOrderBlockShadow } = await import('../order-block-shadow.js');
const { orderFlowReport } = await import('../order-flow-metrics.js');
const db = new PGlite({ extensions: { uuid_ossp } });
const T = Date.parse('2026-10-06T09:15:00+05:30'), M = 900_000;
const b = (k: number, open: number, high: number, low: number, close: number) => ({ time: T + k * M, open, high, low, close });
const bars = [...Array.from({ length: 20 }, (_, k) => k % 2 ? b(k, 100, 105, 95, 101) : b(k, 101, 105, 95, 100)),
  b(20, 100, 101, 94, 95), b(21, 96, 113, 95, 112), b(22, 112, 115, 106, 114), b(23, 106, 107, 100, 104), b(24, 103, 104, 92, 93), b(25, 93, 118, 92, 117)];
const query = { since: null, until: null, instrument: 'NIFTY', strategyVersion: null, costVersion: null };

beforeAll(async () => {
  await db.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
  await db.exec(readFileSync(new URL('../../../../../database/init/038_order_blocks_order_flow_of1.sql', import.meta.url), 'utf8'));
  bridge.query = async (strings, params) => {
    const text = strings.reduce((s, part, i) => s + (i ? `$${i}` : '') + part, '');
    return (await db.query(text, params.map(v => v instanceof Date ? v.toISOString() : v))).rows;
  };
}, 20_000);
afterAll(async () => { await db.close(); });

it('preserves old held=true while writing corrected held=false under the new version; report never double-counts', async () => {
  await db.query(`INSERT INTO order_blocks (symbol, exchange, version, block_type, block_time, displacement_time, block_high, block_low, atr, displacement_atr, state, first_touch_time, held)
    VALUES ('NIFTY','NSE','OB-2.0','BULLISH',$1,$2,101,94,10,1.6,'MITIGATED',$3,true)`,
    [new Date(bars[20].time).toISOString(), new Date(bars[21].time).toISOString(), new Date(bars[23].time).toISOString()]);
  const args = { underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars, legacyVote: 0 as const, signal: null, liveDirection: 'NEUTRAL', directionWithV2: 'NEUTRAL' };
  await recordOrderBlockShadow(args);
  await recordOrderBlockShadow(args);
  const rows = (await db.query('SELECT version, held FROM order_blocks WHERE block_time=$1 ORDER BY version', [new Date(bars[20].time).toISOString()])).rows;
  expect(rows).toEqual([{ version: 'OB-2.0', held: true }, { version: 'OB-2.1', held: false }]);
  const report = await orderFlowReport(query);
  expect(report.orderBlocks.reactionVersion).toBe('OB-2.1');
  expect(report.orderBlocks.allTouched).toMatchObject({ n: 1, held: 0, failed: 1 });
});

it('OF1 dashboard totals/subtypes/winners exclude historical versions without deleting them', async () => {
  for (const [version, day, outcome] of [['OF1-1.1', '2026-10-06', 10], ['OF1-1.2', '2026-10-07', -1]] as const) {
    await db.query(`INSERT INTO of1_candidates (symbol,exchange,mode,decision_bar_time,direction,strategy_version,subtype,location_kind,location_price,atr,entry,stop,delta_mode,evidence,would_trade_if_live,graded_at,outcome_r,existing_source_that_won)
      VALUES ('NIFTY','NSE','INTRADAY',$1,'BULLISH',$2,$2,'PDL',100,10,104,98,'INFERRED','{}',true,$1,$3,'OF1')`, [day, version, outcome]);
  }
  const report = await orderFlowReport(query);
  expect(report.of1).toMatchObject({ version: 'OF1-1.2', candidates: 1, avgR: -1, existingWinners: [{ source: 'OF1', n: 1 }] });
  expect(report.of1.bySubtype).toEqual([{ subtype: 'OF1-1.2', n: 1, avgR: -1 }]);
  expect((await db.query('SELECT COUNT(*)::integer AS n FROM of1_candidates')).rows).toEqual([{ n: 2 }]);
});
