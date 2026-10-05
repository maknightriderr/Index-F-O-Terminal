// Hotfix regression (2026-10-05, seen in production):
//   1. `INSERT … ON CONFLICT` is refused on tables with immutability RULEs
//      (034 / 035) — every snapshot / record / plan insert failed;
//   2. the live logic stamp (99 chars) outgrew logic_version VARCHAR(64).
// Applied on the full boot schema in PGlite (real Postgres).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { FILES, BEST_EFFORT, splitStatements } = await import('../ensure-capture-schema.js');
const { insertOnce } = await import('../../lib/insert-once.js');
const { liveLogicStamp } = await import('../../config/trading-flags.js');

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INIT = path.resolve(SERVER, '../../database/init');
async function apply(db: PGlite, file: string): Promise<string[]> {
  const errors: string[] = [];
  for (const s of splitStatements(readFileSync(path.join(INIT, file), 'utf-8'))) {
    try {
      await db.exec(s);
    } catch (e: any) {
      errors.push(`${file}: ${e.message}`);
    }
  }
  return errors;
}

let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { uuid_ossp } });
  await db.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  expect(await apply(db, '002_schema.sql')).toEqual([]);
  for (const f of FILES) {
    const errs = await apply(db, f);
    if (!BEST_EFFORT.has(f)) expect(errs, f).toEqual([]);
  }
}, 120_000);

const SNAP = `INSERT INTO signal_decision_snapshots (snapshot_id, symbol, exchange, mode, decision_bar_time, polled_at, capture_reason, snapshot_schema_version, versions, data_quality, inputs)
  VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'NIFTY', 'NSE', 'INTRADAY', now(), now(), 'NEW_BAR', 'SNAP-1.0', '{}', '{}', '{}')`;

describe('hotfix: inserts into rule-guarded tables', () => {
  it('Postgres refuses ON CONFLICT on them (the production error)', async () => {
    await expect(db.query(`${SNAP} ON CONFLICT (snapshot_id) DO NOTHING`)).rejects.toThrow(/cannot be used with table that has INSERT or UPDATE rules/);
  });
  it('insertOnce stores the row once; a repeat is EXISTS, not an error — and the stores no longer use ON CONFLICT', async () => {
    expect(await insertOnce(db.query(SNAP))).toBe('INSERTED');
    expect(await insertOnce(db.query(SNAP))).toBe('EXISTS');
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM signal_decision_snapshots`)).rows[0].n).toBe(1);
    await expect(insertOnce(db.query(`INSERT INTO signal_decision_snapshots (snapshot_id) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')`))).rejects.toThrow();
    for (const f of ['src/services/decision-record-store.ts', 'src/services/option-plans.ts']) expect(readFileSync(path.join(SERVER, f), 'utf8'), f).not.toMatch(/ON CONFLICT/);
  });
});

describe('hotfix: logic_version wide enough for the live stamp', () => {
  it('036 is registered and widens all three columns to 200', async () => {
    expect(FILES).toContain('036_widen_logic_version.sql');
    const rows = (await db.query<{ table_name: string; len: number }>(
      `SELECT table_name, character_maximum_length AS len FROM information_schema.columns WHERE column_name = 'logic_version' AND table_name IN ('decision_snapshots', 'setup_lifecycle_events', 'recorder_boots') ORDER BY table_name`
    )).rows;
    expect(rows).toEqual([
      { table_name: 'decision_snapshots', len: 200 },
      { table_name: 'recorder_boots', len: 200 },
      { table_name: 'setup_lifecycle_events', len: 200 },
    ]);
  });
  it('the live stamp fits, with room to spare', () => {
    const v = liveLogicStamp().logicVersion;
    expect(v.length).toBeGreaterThan(64);
    expect(v.length).toBeLessThanOrEqual(150);
  });
  it('re-applying 036 is a no-op', async () => {
    expect(await apply(db, '036_widen_logic_version.sql')).toEqual([]);
  });
});
