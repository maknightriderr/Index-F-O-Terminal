// ============================================================
// OPS-1 (audit 2026-10-18): oi_snapshots storage — unused indexes dropped, raw rows past retention archived
// losslessly before they are deleted, and no evaluation while every exchange is closed.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const db = vi.hoisted(() => ({ calls: [] as Array<{ text: string; values: unknown[] }>, groups: [] as any[], rows: [] as any[], failArchive: false }));
vi.mock('../../lib/db.js', () => {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    db.calls.push({ text, values });
    if (text.startsWith('SELECT to_char')) return Promise.resolve(db.groups);
    if (text.startsWith('SELECT * FROM oi_snapshots')) return Promise.resolve(db.rows);
    if (text.startsWith('INSERT INTO oi_snapshots_archive')) return db.failArchive ? Promise.reject(new Error('disk full')) : Promise.resolve([]);
    if (text.startsWith('DELETE FROM oi_snapshots')) return Promise.resolve(Object.assign([], { count: db.rows.length }));
    return Promise.resolve([]);
  };
  sql.json = (v: unknown) => v;
  return { sql };
});
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));

const A = await import('../oi-archive.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

describe('retention setting and cutoff', () => {
  it('OI_RETENTION_DAYS: default 60, 0 = keep raw forever, junk = default', () => {
    expect(A.parseRetentionDays(undefined)).toBe(60);
    expect(A.parseRetentionDays('')).toBe(60);
    expect(A.parseRetentionDays('90')).toBe(90);
    expect(A.parseRetentionDays('0')).toBe(0);
    expect(A.parseRetentionDays('-3')).toBe(60);
    expect(A.parseRetentionDays('ninety')).toBe(60);
  });
  it('the cutoff is an IST midnight N days back; 0 days turns archiving off', () => {
    const now = Date.parse('2026-12-20T05:00:00Z'); // 10:30 IST, 20 Dec
    expect(A.archiveCutoff(now, 60)?.toISOString()).toBe(new Date('2026-10-21T00:00:00+05:30').toISOString());
    expect(A.archiveCutoff(now, 0)).toBeNull();
  });
});

describe('the archive is lossless', () => {
  it('pack -> unpack returns every row and column', () => {
    const rows = [
      { time: '2026-09-21T04:00:00.000Z', symbol: 'NIFTY', exchange: 'NSE', strike: '25000.00', option_type: 'CE', oi: '1200', ltp: '101.50', greeks_valid: true, iv: null },
      { time: '2026-09-21T04:05:00.000Z', symbol: 'NIFTY', exchange: 'NSE', strike: '25050.00', option_type: 'PE', oi: '900', ltp: '88.05', greeks_valid: false, iv: '13.2' },
    ];
    expect(A.unpackArchive(A.packArchive(rows))).toEqual(rows);
  });
});

describe('a pass archives, then deletes — never the other way round', () => {
  beforeEach(() => {
    db.calls.length = 0;
    db.failArchive = false;
    db.groups = [{ day: '2026-09-21', exchange: 'NSE', symbol: 'NIFTY' }];
    db.rows = [{ time: new Date('2026-09-21T04:00:00Z'), symbol: 'NIFTY', oi: '1' }, { time: new Date('2026-09-21T09:00:00Z'), symbol: 'NIFTY', oi: '2' }];
  });
  const now = Date.parse('2026-12-20T05:00:00Z');
  it('stores the day then removes exactly those raw rows', async () => {
    expect(await A.archiveOldOiSnapshots(now)).toBe(2);
    const kinds = db.calls.map((c) => c.text.split(' ').slice(0, 3).join(' '));
    expect(kinds).toEqual(['SELECT to_char((time AT', 'SELECT * FROM', 'INSERT INTO oi_snapshots_archive', 'DELETE FROM oi_snapshots']);
    const ins = db.calls[2].values;
    expect(ins.slice(0, 4)).toEqual(['2026-09-21', 'NSE', 'NIFTY', 2]);
    expect(A.unpackArchive(ins[7] as string)).toHaveLength(2);
  });
  it('a failed archive write deletes nothing', async () => {
    db.failArchive = true;
    await expect(A.archiveOldOiSnapshots(now)).rejects.toThrow(/disk full/);
    expect(db.calls.some((c) => c.text.startsWith('DELETE'))).toBe(false);
  });
  it('nothing past the cutoff: no work', async () => {
    db.groups = [];
    expect(await A.archiveOldOiSnapshots(now)).toBe(0);
    expect(db.calls).toHaveLength(1);
  });
});

describe('wiring', () => {
  it('043 drops the four unused indexes and creates the archive; 002 and 010 no longer create them at boot', () => {
    const m = read('database/init/043_oi_storage.sql');
    for (const ix of ['idx_oi_strike', 'idx_oi_symbol', 'idx_oi_greeks_model', 'idx_oi_capture_run']) {
      expect(m).toMatch(new RegExp(`DROP INDEX IF EXISTS ${ix};`));
      expect(read('database/init/002_schema.sql') + read('database/init/010_capture_quality_lineage.sql')).not.toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${ix} `));
    }
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS oi_snapshots_archive/);
    // The decision path's reader (symbol, expiry, time) keeps its index.
    expect(m).not.toMatch(/DROP INDEX IF EXISTS idx_oi_snapshots_capture/);
  });
  it('the prune archives oi_snapshots instead of deleting it at 400 days', () => {
    const cap = read('apps/server/src/services/market-state-capture.ts');
    expect(cap).toMatch(/oiArchived: await archiveOldOiSnapshots\(\)/);
    expect(cap).not.toMatch(/DELETE FROM oi_snapshots/);
  });
  it('no evaluation while every exchange is closed (the cached result is returned)', () => {
    const mb = read('apps/server/src/services/market-bias.ts');
    expect(mb).toMatch(/if \(!isReplaying\(\) && !hasDecisionTime\(\) && !\(\['NSE', 'BSE', 'MCX'\] as const\)\.some\(\(ex\) => isMarketOpen\(ex, Date\.now\(\)\)\)\) \{/);
  });
});
