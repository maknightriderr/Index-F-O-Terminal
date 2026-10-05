// 037 applied on the full boot schema in PGlite, twice: additive, idempotent;
// a tape needs its snapshot; one forward outcome per (kind, subject).
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
const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../database/init');
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
    if (f === '037_replay_tapes_forward_validation.sql') continue;
    const errs = await apply(db, f);
    if (!BEST_EFFORT.has(f)) expect(errs, f).toEqual([]);
  }
}, 120_000);

describe('migration 037', () => {
  it('is registered right after 036 and applies twice cleanly', async () => {
    expect(FILES.indexOf('037_replay_tapes_forward_validation.sql')).toBe(FILES.indexOf('036_widen_logic_version.sql') + 1);
    const before = (await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name);
    expect(await apply(db, '037_replay_tapes_forward_validation.sql')).toEqual([]);
    expect(await apply(db, '037_replay_tapes_forward_validation.sql')).toEqual([]);
    const after = (await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name);
    for (const t of before) expect(after).toContain(t);
    for (const t of ['decision_tapes', 'slot_decisions', 'forward_outcomes']) expect(after).toContain(t);
  });

  it('a tape needs its snapshot; forward outcomes are one per (kind, subject)', async () => {
    await expect(db.query(`INSERT INTO decision_tapes (snapshot_id, tape_version, tape_gz, entries, bytes, live_result_gz) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'TAPE-1.0', '', 0, 0, '')`)).rejects.toThrow();
    const fo = `INSERT INTO forward_outcomes (kind, subject_id, symbol, exchange, decided_at, versions, predicted, actual) VALUES ('OPTION_PAYOFF', 'sig-1', 'NIFTY', 'NSE', now(), '{}', '{}', '{}')`;
    expect(await insertOnce(db.query(fo))).toBe('INSERTED');
    expect(await insertOnce(db.query(fo))).toBe('EXISTS');
    await db.query(`INSERT INTO slot_decisions (time, symbol, exchange, mode, outcome) VALUES (now(), 'NIFTY', 'NSE', 'INTRADAY', 'NO_TRADE')`);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM slot_decisions`)).rows[0].n).toBe(1);
  });

  it("every statement the new services issue is valid against the migrated schema", async () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    let checked = 0;
    for (const f of ['slot-decisions.ts', 'forward-validation.ts', 'signal-engine-metrics.ts']) {
      const text = readFileSync(path.join(SRC, f), 'utf8');
      for (const m of text.matchAll(/sql(?:<[^`]*?>)?`([\s\S]*?)`/g)) {
        const stmt = m[1].replace(/\$\{[^}]*\}/g, 'NULL').trim();
        const ins = /^INSERT INTO (\w+) \(([^)]*)\)/.exec(stmt);
        if (ins) {
          const cols = (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1`, [ins[1]])).rows.map((r) => r.c);
          for (const c of ins[2].split(',').map((x) => x.trim())) expect(cols, `${f}: ${ins[1]}.${c}`).toContain(c);
        } else {
          await db.query(stmt);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(9);
  });
});
