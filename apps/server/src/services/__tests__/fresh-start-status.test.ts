import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let pg: PGlite;
vi.mock('../../lib/db.js', () => ({ sql: async (s: TemplateStringsArray, ...v: any[]) => { const q = s.reduce((q, x, i) => q + x + (i < v.length ? `$${i + 1}` : ''), ''); return (await pg.query(q, v)).rows; } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
import { freshStartStatus } from '../fresh-start/status.js';
beforeAll(async () => { pg = new PGlite(); await pg.exec(readFileSync(new URL('../../../../../database/init/047_fresh_start_paper.sql', import.meta.url), 'utf8')); }, 30000);
afterAll(async () => { await pg.close(); });
describe('fresh-start read-only status and all-cohort aggregation', () => {
    it('returns four explicitly unvalidated rows with unavailable net results, and performs no writes', async () => { const before = (await pg.query('SELECT count(*) FROM fresh_paper_accounts')).rows; const r = await freshStartStatus(); expect(r).toMatchObject({ enabled: false, legacyNewEntries: false, liveOrdersAllowed: false, capital: 500000, performanceValidated: false, schemaReady: true }); expect(r.performance).toHaveLength(4); expect(r.performance.every(x => x.netPnl === null && x.winRate === null && x.validation === 'NOT_VALIDATED')).toBe(true); expect((await pg.query('SELECT count(*) FROM fresh_paper_accounts')).rows).toEqual(before); expect(r.blockers).toContain('QUALIFIED_SHARED_FEED_ADAPTER'); expect(r.reviews).toEqual([]); });
});
