// Phase 3 migration safety: 035 applied through the boot runner's splitter on
// top of the full boot schema (002 + every boot file up to 034) in PGlite,
// twice — idempotent, additive, plans immutable, events insert-only.
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
    if (f === '035_option_plans.sql') continue;
    const errs = await apply(db, f);
    if (!BEST_EFFORT.has(f)) expect(errs, f).toEqual([]);
  }
}, 120_000);

const PLAN = '44444444-4444-4444-8444-444444444444';
describe('migration 035 (option plans)', () => {
  it('is registered right after 034', () => {
    expect(FILES.indexOf('035_option_plans.sql')).toBe(FILES.indexOf('034_decision_records.sql') + 1);
  });

  it('applies cleanly twice and leaves every earlier table intact', async () => {
    const before = (await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`)).rows.map((r) => r.table_name);
    expect(await apply(db, '035_option_plans.sql')).toEqual([]);
    expect(await apply(db, '035_option_plans.sql')).toEqual([]);
    const after = (await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`)).rows.map((r) => r.table_name);
    for (const t of before) expect(after).toContain(t);
    expect(after).toContain('option_plans');
    expect(after).toContain('option_plan_events');
  });

  it('plans are immutable; events are insert-only and need their plan', async () => {
    await db.query(
      `INSERT INTO option_plans (plan_id, signal_id, symbol, exchange, mode, source, direction, option_strike, option_sl, candidates, rejected_strikes, option_selection_version)
       VALUES ($1, '55555555-5555-4555-8555-555555555555', 'NIFTY', 'NSE', 'INTRADAY', 'S1', 'BULLISH', 25000, 80, '[]', '[]', 'OPTSEL-1.0')`,
      [PLAN],
    );
    await db.query(`UPDATE option_plans SET option_sl = 1 WHERE plan_id = $1`, [PLAN]);
    expect(Number((await db.query<any>(`SELECT option_sl FROM option_plans WHERE plan_id = $1`, [PLAN])).rows[0].option_sl)).toBe(80);
    // One plan per minted trade.
    await expect(
      db.query(`INSERT INTO option_plans (plan_id, signal_id, symbol, exchange, mode, source, direction, candidates, rejected_strikes, option_selection_version)
                VALUES ('66666666-6666-4666-8666-666666666666', '55555555-5555-4555-8555-555555555555', 'NIFTY', 'NSE', 'INTRADAY', 'S1', 'BULLISH', '[]', '[]', 'OPTSEL-1.0')`),
    ).rejects.toThrow();
    await db.query(`INSERT INTO option_plan_events (event_id, plan_id, at, event_type, levels_after) VALUES ('77777777-7777-4777-8777-777777777777', $1, now(), 'TSL_MOVED', '{"tsl":100}')`, [PLAN]);
    await db.query(`UPDATE option_plan_events SET event_type = 'X'`);
    expect((await db.query<any>(`SELECT event_type FROM option_plan_events`)).rows[0].event_type).toBe('TSL_MOVED');
    await expect(
      db.query(`INSERT INTO option_plan_events (event_id, plan_id, at, event_type, levels_after) VALUES ('88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999', now(), 'CREATED', '{}')`),
    ).rejects.toThrow();
  });
});
