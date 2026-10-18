// ============================================================
// REPL-1 (audit 2026-10-18): the Old Indicator's trades keep a full-replay tape; a refused replay names its config.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const db = vi.hoisted(() => ({ calls: [] as string[], registry: new Map<string, any>() }));
vi.mock('../../lib/db.js', () => {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    db.calls.push(text);
    if (text.startsWith('INSERT INTO config_registry')) {
      const hash = values[0] as string;
      if (db.registry.has(hash)) return Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' }));
      db.registry.set(hash, { config_hash: hash, git_commit: values[4], first_seen: new Date('2026-10-18T10:00:00Z'), last_seen: new Date('2026-10-18T10:00:00Z'), logic_stamp: values[3] });
      return Promise.resolve([]);
    }
    if (text.startsWith('SELECT config_hash')) return Promise.resolve(db.registry.has(values[0] as string) ? [db.registry.get(values[0] as string)] : []);
    return Promise.resolve([]);
  };
  sql.json = (v: unknown) => v;
  return { sql };
});
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));

const S = await import('../decision-record-store.js');
const C = await import('../snapshot-context.js');

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (f: string) => readFileSync(path.join(SERVER, f), 'utf8');

describe('DECISION_TAPE modes', () => {
  it('unset or TAKE = TAKE (the default); 1 / true / on / ALL = ALL; anything else = OFF', () => {
    for (const v of [undefined, '', 'take', ' TAKE ']) expect(S.parseDecisionTapeMode(v)).toBe('TAKE');
    for (const v of ['1', 'true', 'ON', 'yes', 'all']) expect(S.parseDecisionTapeMode(v)).toBe('ALL');
    for (const v of ['0', 'false', 'off', 'no', 'whatever']) expect(S.parseDecisionTapeMode(v)).toBe('OFF');
  });
  it('TAKE stores every minting poll and a deterministic ~1-in-20 sample of the rest', () => {
    const id = (k: number) => `${k.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    expect(S.shouldStoreTape('TAKE', true, id(7))).toBe(true);
    const kept = Array.from({ length: 2000 }, (_, k) => S.shouldStoreTape('TAKE', false, id(k * 7919), 20)).filter(Boolean).length;
    expect(kept).toBeGreaterThan(60);
    expect(kept).toBeLessThan(140);
    // The same snapshot always gets the same answer (a replay of the choice is the choice).
    expect(S.shouldStoreTape('TAKE', false, id(40), 20)).toBe(S.shouldStoreTape('TAKE', false, id(40), 20));
    expect(S.shouldStoreTape('TAKE', false, id(40), 0)).toBe(false);
    expect(S.shouldStoreTape('ALL', false, id(41))).toBe(true);
    expect(S.shouldStoreTape('OFF', true, id(42))).toBe(false);
  });
});

describe('the poll knows whether it minted', () => {
  it('noteScopeTake marks only its own poll', async () => {
    expect(C.scopeTook()).toBe(false);
    const [a, b] = await Promise.all([
      C.runInSnapshotScope(async () => {
        await new Promise((r) => setTimeout(r, 5));
        C.noteScopeTake();
        return C.scopeTook();
      }),
      C.runInSnapshotScope(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return C.scopeTook();
      }),
    ]);
    expect([a, b]).toEqual([true, false]);
    C.noteScopeTake(); // outside a scope: a no-op
    expect(C.scopeTook()).toBe(false);
  });
  it('wiring: the trade insert marks the poll (not a late-written row); the poll stores by shouldStoreTape', () => {
    const mb = read('src/services/market-bias.ts');
    expect(mb).toMatch(/if \(rows\[0\]\?\.id && at == null\) noteScopeTake\(\);/);
    expect(mb).toMatch(/return \{ r, snapshotId: currentSnapshotId\(\), minted: scopeTook\(\) \};/);
    expect(mb).toMatch(/shouldStoreTape\(DECISION_TAPE_MODE, result\.minted, result\.snapshotId\)\) void persistTape/);
    expect(read('src/services/decision-record-store.ts')).not.toMatch(/default on/);
  });
});

describe('config registry', () => {
  beforeEach(() => {
    db.calls.length = 0;
  });
  const snap = (hash: string) => ({ config: { configHash: hash, triggerStages: {} }, versions: { logicFlagsHash: 'lf', gitCommit: 'abc123def456' } }) as never;

  it('writes each configuration once per process; an existing one only refreshes last_seen', async () => {
    db.registry.set('h-old', { config_hash: 'h-old', git_commit: 'a083903', first_seen: new Date('2026-10-09T00:00:00Z'), last_seen: new Date('2026-10-09T00:00:00Z'), logic_stamp: {} });
    await S.registerConfig(snap('h-new'));
    await S.registerConfig(snap('h-new'));
    await S.registerConfig(snap('h-old'));
    expect(db.calls.filter((c) => c.startsWith('INSERT INTO config_registry'))).toHaveLength(2);
    expect(db.calls.filter((c) => c.startsWith('UPDATE config_registry SET last_seen'))).toHaveLength(1);
    expect(db.registry.get('h-new')).toMatchObject({ git_commit: 'abc123def456' });
  });
  it('a replay refused for its configuration names the commit and settings it needs', async () => {
    const r = await S.loadRegisteredConfig('h-old');
    expect(r).toMatchObject({ configHash: 'h-old', gitCommit: 'a083903' });
    expect(await S.loadRegisteredConfig('unknown')).toBeNull();
    expect(read('src/services/decision-record-store.ts')).toMatch(/recordedConfig: await loadRegisteredConfig\(out\.recordedConfigHash\)/);
  });
  it('042 is registered at boot and is plain idempotent DDL', async () => {
    const { FILES, splitStatements } = await vi.importActual<typeof import('../ensure-capture-schema.js')>('../ensure-capture-schema.js');
    expect(FILES).toContain('042_config_registry.sql');
    expect(FILES.indexOf('042_config_registry.sql')).toBe(FILES.indexOf('041_bar_archive.sql') + 1);
    const stmts = splitStatements(read('../../database/init/042_config_registry.sql'));
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/^CREATE TABLE IF NOT EXISTS config_registry/);
  });
});
