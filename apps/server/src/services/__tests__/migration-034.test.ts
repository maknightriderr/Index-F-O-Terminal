// Phase 2 migration safety: 034 is applied, through the exact boot runner
// statement splitter, on top of the real schema (002 + every boot-ensured
// file) in an embedded Postgres (PGlite), twice — it must be idempotent,
// additive, and leave existing rows and columns untouched.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { FILES, BEST_EFFORT, splitStatements } = await import('../ensure-capture-schema.js');

const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../database/init');
const read = (f: string) => readFileSync(path.join(INIT, f), 'utf-8');

async function apply(db: PGlite, file: string): Promise<string[]> {
  const errors: string[] = [];
  for (const s of splitStatements(read(file))) {
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
    if (f === '034_decision_records.sql') continue;
    const errs = await apply(db, f);
    if (!BEST_EFFORT.has(f)) expect(errs, f).toEqual([]);
  }
  // Pre-existing rows, to prove 034 never touches existing data.
  await db.exec(`INSERT INTO signals (time, symbol, signal_type, direction, confidence) VALUES (now(), 'NIFTY', 'TRADE_SETUP', 'BULLISH', 80)`);
}, 120_000);

const columns = async (table: string) =>
  (await db.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
    [table],
  )).rows;

describe('migration 034 (decision records)', () => {
  it('is registered last in the boot runner', () => {
    expect(FILES[FILES.length - 1]).toBe('034_decision_records.sql');
    expect(BEST_EFFORT.has('034_decision_records.sql')).toBe(false);
  });

  it('applies cleanly and is idempotent (applied twice)', async () => {
    const beforeSignals = await columns('signals');
    const beforeEvents = await columns('setup_events');
    expect(await apply(db, '034_decision_records.sql')).toEqual([]);
    expect(await apply(db, '034_decision_records.sql')).toEqual([]);
    // Additive: every existing column survives with its type.
    const afterSignals = await columns('signals');
    const afterEvents = await columns('setup_events');
    for (const c of beforeSignals) expect(afterSignals).toContainEqual(c);
    for (const c of beforeEvents) expect(afterEvents).toContainEqual(c);
    expect(afterSignals).toContainEqual({ column_name: 'snapshot_id', data_type: 'uuid' });
    expect(afterEvents).toContainEqual({ column_name: 'snapshot_id', data_type: 'uuid' });
    // Existing rows untouched.
    const sig = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM signals WHERE snapshot_id IS NULL`);
    expect(sig.rows[0].n).toBe(1);
  });

  it('creates the three tables and their indexes', async () => {
    for (const t of ['signal_decision_snapshots', 'decision_records', 'decision_trigger_events']) {
      expect((await columns(t)).length, t).toBeGreaterThan(0);
    }
    const idx = (await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes ORDER BY indexname`)).rows.map((r) => r.indexname);
    for (const i of ['uq_signal_decision_snapshots_poll', 'idx_signal_decision_snapshots_symbol_bar', 'idx_decision_records_selected', 'idx_setup_events_snapshot', 'idx_signals_snapshot']) {
      expect(idx).toContain(i);
    }
  });

  it('keeps snapshots immutable, one per poll, and records immutable except the outcome', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await db.query(
      `INSERT INTO signal_decision_snapshots (snapshot_id, symbol, exchange, mode, decision_bar_time, polled_at, capture_reason, snapshot_schema_version, versions, data_quality, inputs)
       VALUES ($1, 'NIFTY', 'NSE', 'INTRADAY', '2026-10-05T04:00:00Z', '2026-10-05T04:00:20Z', 'NEW_BAR', 'SNAP-1.0', '{}', '{}', '{"a":1}')`,
      [id],
    );
    await db.query(`UPDATE signal_decision_snapshots SET inputs = '{"a":2}' WHERE snapshot_id = $1`, [id]);
    expect((await db.query<any>(`SELECT inputs FROM signal_decision_snapshots WHERE snapshot_id = $1`, [id])).rows[0].inputs).toEqual({ a: 1 });
    await expect(
      db.query(
        `INSERT INTO signal_decision_snapshots (snapshot_id, symbol, exchange, mode, decision_bar_time, polled_at, capture_reason, snapshot_schema_version, versions, data_quality, inputs)
         VALUES ('22222222-2222-4222-8222-222222222222', 'NIFTY', 'NSE', 'INTRADAY', '2026-10-05T04:00:00Z', '2026-10-05T04:00:20Z', 'NEW_BAR', 'SNAP-1.0', '{}', '{}', '{}')`,
      ),
    ).rejects.toThrow();

    await db.query(
      `INSERT INTO decision_records (snapshot_id, record_schema_version, record, record_hash, final_status) VALUES ($1, 'DR-1.0', '{"x":1}', $2, 'NO_TRADE')`,
      [id, 'a'.repeat(64)],
    );
    await db.query(`UPDATE decision_records SET record = '{"x":2}' WHERE snapshot_id = $1`, [id]);
    await db.query(`UPDATE decision_records SET outcome = '{"r":1.2}', outcome_at = now() WHERE snapshot_id = $1`, [id]);
    const row = (await db.query<any>(`SELECT record, outcome FROM decision_records WHERE snapshot_id = $1`, [id])).rows[0];
    expect(row.record).toEqual({ x: 1 });
    expect(row.outcome).toEqual({ r: 1.2 });

    // A record needs its snapshot.
    await expect(
      db.query(`INSERT INTO decision_records (snapshot_id, record_schema_version, record, record_hash, final_status) VALUES ('33333333-3333-4333-8333-333333333333', 'DR-1.0', '{}', $1, 'NO_TRADE')`, ['b'.repeat(64)]),
    ).rejects.toThrow();
  });

  it('leaves the existing decision_snapshots (006) table alone', async () => {
    const c = (await columns('decision_snapshots')).map((r) => r.column_name);
    expect(c).toContain('decision_id');
    expect(c).not.toContain('snapshot_id');
  });
});
