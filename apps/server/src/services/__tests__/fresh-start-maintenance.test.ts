// Nightly evaluation-input retention on the real 048 schema in PGlite (5 Nov cost review).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
const { largestTables, trimFreshEvaluationInputs, freshMaintenanceRunDate, FRESH_EVALUATION_INPUT_RETENTION_DAYS, FRESH_TRIM_BATCH, storageGuard, volumeCapacityMb } = await import('../fresh-start/maintenance.js');

let pg: PGlite;
/** A postgres.js-style tagged template over PGlite. */
const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce((q, s, i) => q + s + (i < values.length ? `$${i + 1}` : ''), '');
  return (await pg.query(text, values.map((v) => (v instanceof Date ? v.toISOString() : v)))).rows;
}) as any;

const now = Date.parse('2026-11-06T21:00:00Z'); // 02:30 IST, inside the window
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../../../../database/init/048_fresh_start_adapter.sql', import.meta.url), 'utf8'));
}, 30_000);

describe('fresh-start nightly maintenance', () => {
  it('lists the largest tables (read only), largest first, in MB', async () => {
    const top = await largestTables(db, 3);
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(3);
    expect(top.every((t) => typeof t.table === 'string' && t.mb >= 0)).toBe(true);
    expect(top.map((t) => t.mb)).toEqual([...top.map((t) => t.mb)].sort((a, b) => b - a));
  });
  it('storage guard: no delete or VACUUM once the volume is about 85% full (database + 1 GB overhead)', () => {
    // 22 Nov on the 5 GB volume: 4,176 MB database -> ~102% -> skipped (it filled the disk that night).
    expect(storageGuard(4176, 5120)).toMatchObject({ allowed: false, usedMb: 5200, fillPct: 101.6 });
    expect(storageGuard(4176, 10_240)).toMatchObject({ allowed: true, fillPct: 50.8 });
    expect(storageGuard(7700, 10_240).allowed).toBe(false); // 85.2%
    expect(storageGuard(7600, 10_240).allowed).toBe(true); // 84.2%
    expect(storageGuard(null, 10_240)).toEqual({ allowed: true, usedMb: null, fillPct: null });
    expect(volumeCapacityMb({})).toBe(10_240);
    expect(volumeCapacityMb({ POSTGRES_VOLUME_MB: '20480' })).toBe(20_480);
    expect(volumeCapacityMb({ POSTGRES_VOLUME_MB: 'x' })).toBe(10_240);
  });
  it('runs only between 02:00 and 06:00 IST', () => {
    expect(freshMaintenanceRunDate(Date.parse('2026-11-05T20:30:00Z'))).toBe('2026-11-06'); // 02:00 IST
    expect(freshMaintenanceRunDate(Date.parse('2026-11-06T00:29:00Z'))).toBe('2026-11-06'); // 05:59 IST
    expect(freshMaintenanceRunDate(Date.parse('2026-11-06T00:30:00Z'))).toBeNull(); // 06:00 IST
    expect(freshMaintenanceRunDate(Date.parse('2026-11-05T18:00:00Z'))).toBeNull(); // 23:30 IST, MCX open
  });
  it('trims only inputs older than the retention, keeps every result, and is idempotent', async () => {
    const day = 86_400_000, input = JSON.stringify({ bars5: Array(300).fill({ close: 1 }) }), result = JSON.stringify({ refusals: [{ strategy: 'X', code: 'Y' }] });
    const ages = [FRESH_EVALUATION_INPUT_RETENTION_DAYS + 5, FRESH_EVALUATION_INPUT_RETENTION_DAYS + 1, FRESH_EVALUATION_INPUT_RETENTION_DAYS - 1, 0];
    for (const [i, age] of ages.entries())
      await pg.query(`INSERT INTO fresh_evaluations(id,version,at,instrument,session,source_epoch,input,result) VALUES($1,'V',$2,'NSE_FO:1','s','e',$3,$4)`, [`e${i}`, new Date(now - age * day).toISOString(), input, result]);
    expect(await trimFreshEvaluationInputs(db, now)).toBe(2);
    const rows = (await pg.query<any>('SELECT id, input, result FROM fresh_evaluations ORDER BY id')).rows;
    expect(rows[0].input).toEqual({ trimmedAt: new Date(now).toISOString(), instrument: 'NSE_FO:1' });
    expect(rows[1].input).toHaveProperty('trimmedAt');
    expect(rows[2].input).toHaveProperty('bars5');
    expect(rows[3].input).toHaveProperty('bars5');
    for (const r of rows) expect(r.result).toEqual({ refusals: [{ strategy: 'X', code: 'Y' }] });
    expect(await trimFreshEvaluationInputs(db, now)).toBe(0);
    expect(FRESH_TRIM_BATCH).toBeGreaterThan(0);
  });
});

describe('weekly cleanup (owner, 18 Nov)', () => {
  it('runs on IST Mondays only', async () => {
    const { isIstMonday } = await import('../fresh-start/maintenance.js');
    expect(isIstMonday(Date.parse('2026-11-22T20:30:00Z'))).toBe(true); // Mon 23 Nov 02:00 IST
    expect(isIstMonday(Date.parse('2026-11-23T00:29:00Z'))).toBe(true); // Mon 05:59 IST
    expect(isIstMonday(Date.parse('2026-11-23T20:30:00Z'))).toBe(false); // Tue 02:00 IST
    expect(isIstMonday(Date.parse('2026-11-22T18:00:00Z'))).toBe(false); // Sun 23:30 IST
  });
  it('deletes gate diagnostics past the retention only, vacuums, logs before / after, and survives a missing table', async () => {
    const { weeklyCleanup, GATE_DIAGNOSTICS_RETENTION_DAYS, WEEKLY_VACUUM_TABLES } = await import('../fresh-start/maintenance.js');
    await pg.exec('CREATE TABLE IF NOT EXISTS gate_diagnostics (id serial PRIMARY KEY, gate text, evaluated_at timestamptz NOT NULL)');
    const day = 86_400_000, t = Date.parse('2026-11-23T21:00:00Z');
    for (const age of [GATE_DIAGNOSTICS_RETENTION_DAYS + 10, GATE_DIAGNOSTICS_RETENTION_DAYS + 1, GATE_DIAGNOSTICS_RETENTION_DAYS - 1, 1]) await pg.query('INSERT INTO gate_diagnostics (gate, evaluated_at) VALUES ($1, $2)', ['G', new Date(t - age * day).toISOString()]);
    const withUnsafe = Object.assign(db, { unsafe: (q: string) => pg.exec(q) });
    const out = await weeklyCleanup(withUnsafe, t);
    expect(out.gateDiagnosticsDeleted).toBe(2);
    expect((await pg.query('SELECT count(*)::int AS n FROM gate_diagnostics')).rows[0]).toEqual({ n: 2 });
    expect(out.vacuumed).toEqual(expect.arrayContaining(['fresh_evaluations', 'gate_diagnostics']));
    // Tables this test database does not have fail on their own; the rest still ran.
    expect((out.vacuumFailed as string[]).length).toBe(WEEKLY_VACUUM_TABLES.length - (out.vacuumed as string[]).length);
    expect(out.largestTablesBefore).not.toBeNull();
    expect(out).toHaveProperty('after');
    expect(out.largestTablesAfter).not.toBeNull();
  });
});
