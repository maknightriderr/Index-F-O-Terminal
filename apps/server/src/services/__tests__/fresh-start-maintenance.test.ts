// Nightly evaluation-input retention on the real 048 schema in PGlite (5 Nov cost review).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
const { trimFreshEvaluationInputs, freshMaintenanceRunDate, FRESH_EVALUATION_INPUT_RETENTION_DAYS, FRESH_TRIM_BATCH } = await import('../fresh-start/maintenance.js');

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
