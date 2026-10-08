// 038 applied on the full boot schema in PGlite, twice: additive, idempotent;
// and every statement the OB-shadow / order-flow / OF1 services issue is
// valid against it (SELECT / UPDATE executed with NULL parameters; INSERT
// columns exist; every ON CONFLICT target is a real unique index).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { FILES, BEST_EFFORT, splitStatements } = await import('../ensure-capture-schema.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.resolve(HERE, '../../../../../database/init');
const F038 = '038_order_blocks_order_flow_of1.sql';

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

/** Replace every ${…} (balanced braces) in a template body with NULL. */
function nullParams(t: string): string {
  let out = '';
  for (let k = 0; k < t.length; k++) {
    if (t[k] === '$' && t[k + 1] === '{') {
      let depth = 0;
      let j = k + 1;
      for (; j < t.length; j++) {
        if (t[j] === '{') depth++;
        else if (t[j] === '}' && --depth === 0) break;
      }
      out += 'NULL';
      k = j;
    } else out += t[k];
  }
  return out;
}

/** Tagged sql`…` bodies of a source file (template literals may contain ${…} with backticks inside — none in these files). */
function sqlBodies(src: string): string[] {
  const out: string[] = [];
  const re = /sql(?:<[^`]*?>)?`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let k = re.lastIndex;
    let depth = 0;
    for (; k < src.length; k++) {
      if (src[k] === '$' && src[k + 1] === '{') depth++;
      else if (src[k] === '}' && depth > 0) depth--;
      else if (src[k] === '`' && depth === 0) break;
    }
    out.push(src.slice(re.lastIndex, k));
    re.lastIndex = k + 1;
  }
  return out;
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

describe('migration 038', () => {
  it('is registered right after 037 and re-applies cleanly', async () => {
    expect(FILES.indexOf(F038)).toBe(FILES.indexOf('037_replay_tapes_forward_validation.sql') + 1);
    expect(await apply(db, F038)).toEqual([]);
    const tables = (await db.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.t);
    for (const t of ['order_blocks', 'order_block_shadow', 'order_flow_bars', 'of1_candidates', 'bar_anomalies']) expect(tables).toContain(t);
    expect(FILES.indexOf('039_bar_anomalies.sql')).toBe(FILES.indexOf(F038) + 1);
    expect(await apply(db, '039_bar_anomalies.sql')).toEqual([]);
  });

  it('every statement the new services issue is valid against the schema', async () => {
    let checked = 0;
    for (const f of ['order-block-shadow.ts', 'order-flow-store.ts', 'of1-live.ts', 'order-flow-metrics.ts', 'forward-validation.ts', 'bar-anomaly.ts', 'pending-outcomes.ts', 'state-recovery.ts', 'signal-engine-metrics.ts']) {
      const src = readFileSync(path.join(HERE, '..', f), 'utf8');
      for (const body of sqlBodies(src)) {
        const stmt = nullParams(body).trim();
        const ins = /^INSERT INTO (\w+) \(([^)]*)\)/.exec(stmt);
        if (ins) {
          const cols = (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = $1`, [ins[1]])).rows.map((r) => r.c);
          for (const c of ins[2].split(',').map((x) => x.trim())) expect(cols, `${f}: ${ins[1]}.${c}`).toContain(c);
          const conflict = /ON CONFLICT \(([^)]*)\)/.exec(stmt);
          if (conflict) {
            const want = conflict[1].split(',').map((x) => x.trim()).sort().join(',');
            const idx = (await db.query<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE tablename = $1 AND indexdef LIKE 'CREATE UNIQUE%'`, [ins[1]])).rows.map((r) => /\(([^)]*)\)/.exec(r.def)![1].split(',').map((x) => x.trim()).sort().join(','));
            expect(idx, `${f}: ${ins[1]} ON CONFLICT (${want})`).toContain(want);
          }
        } else {
          await db.query(stmt);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(16);
  });
});
