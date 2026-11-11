// Runs the whole decision summary (every query, incl. the 2.0 gates and risk flags) on the real 047/048 schema in PGlite.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const logs = vi.hoisted(() => ({ info: [] as any[], warn: [] as any[] }));
let pg: PGlite;
vi.mock('../../lib/db.js', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((q, s, i) => q + s + (i < values.length ? `$${i + 1}` : ''), '');
    return pg.query(text, values.map((v) => (v instanceof Date ? v.toISOString() : v))).then((r) => r.rows);
  },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { info: (o: any) => logs.info.push(o), warn: (o: any) => logs.warn.push(o), error() {}, debug() {} } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
const { logFreshDecisionSummary } = await import('../fresh-start/decision-summary.js');
const { FRESH_PACK_VERSION } = await import('@fno/analytics');

beforeAll(async () => {
  pg = new PGlite();
  for (const f of ['047_fresh_start_paper.sql', '048_fresh_start_adapter.sql', '053_dhan_engine_signals.sql', '054_dhan_engine_paper.sql']) await pg.exec(readFileSync(new URL(`../../../../../database/init/${f}`, import.meta.url), 'utf8'));
}, 30_000);

describe('fresh-start decision summary SQL', () => {
  it("reports 2.0 gates per instrument (without not-applicable rows) and today's risk flags", async () => {
    const now = Date.parse('2026-11-09T06:00:00Z'), at = new Date(now - 600_000).toISOString();
    const result = { refusals: [{ strategy: 'NEW_RS_STOCK_V1', code: 'SETUP_CONDITIONS_NOT_MET', detail: 'RS_WEAK' }, { strategy: 'NEW_INDEX_BREADTH_V1', code: 'SETUP_CONDITIONS_NOT_MET', detail: 'IDX_NOT_AN_INDEX' }] };
    await pg.query(`INSERT INTO fresh_evaluations(id,version,at,instrument,session,source_epoch,input,result) VALUES('e1',$1,$2,'NSE_FO:1','s','e','{}',$3)`, [FRESH_PACK_VERSION, at, JSON.stringify(result)]);
    await pg.query(`INSERT INTO fresh_paper_accounts(id,session,version,capital) VALUES('a','s',$1,3000000)`, [FRESH_PACK_VERSION]);
    await pg.query(`INSERT INTO fresh_candidates(id,account_id,at,version,strategy,parent_id,decision,code,evidence) VALUES('p1','a',$2,$1,'NEW_RS_STOCK_V1','pa','FILLED','FILLED','{}')`, [FRESH_PACK_VERSION, at]);
    await pg.query(`INSERT INTO fresh_paper_positions(id,account_id,version,strategy,instrument,risk_group,parent_id,session,status,reserved_risk,reserved_premium,opened_at,state) VALUES('p1','a',$1,'NEW_RS_STOCK_V1','NSE_FO:1','g','pa','s','OPEN',1,1,$2,$3)`, [FRESH_PACK_VERSION, at, JSON.stringify({ riskFlags: ['WOULD_PAUSE_3_LOSSES', 'WOULD_BLOCK_MAX_OPEN'] })]);
    await logFreshDecisionSummary(now);
    expect(logs.warn).toEqual([]);
    const s = logs.info.find((x) => x.event === 'freshDecisionSummary');
    expect(s.v2GatesLast60Min).toEqual([expect.objectContaining({ instrument: 'NSE_FO:1', strategy: 'NEW_RS_STOCK_V1', gate: 'RS_WEAK', n: 1 })]);
    expect(s.riskFlagsToday).toEqual(expect.arrayContaining([{ flag: 'WOULD_PAUSE_3_LOSSES', n: 1 }, { flag: 'WOULD_BLOCK_MAX_OPEN', n: 1 }]));
    // The daily funnel (F-06 / F-12): one line with the counts per strategy, the Dhan signals and the health counters.
    const { noteChainRefresh, noteScanStatus, resetHealthCounters } = await import('../fresh-start/health-counters.js');
    resetHealthCounters();
    noteChainRefresh('NIFTY', null, now - 60_000); noteChainRefresh('SENSEX', 'Unable to resolve a live spot price for SENSEX', now - 30_000);
    noteScanStatus('ARMED', now); noteScanStatus('BLOCKED_EVENT_DATA', now); noteScanStatus('ARMED', now); noteScanStatus('ARMED', now);
    await pg.query(`INSERT INTO fresh_adapter_decisions(candidate_id,at,version,strategy,code,evidence) VALUES('x1',$2,$1,'NEW_RS_STOCK_V1','NO_CONTRACT','{}')`, [FRESH_PACK_VERSION, at]).catch(() => undefined);
    await pg.query(`INSERT INTO dhan_engine_signals(strategy,side,symbol,exchange,bar_time,status,paper_decision,version) VALUES('DHAN_E_ORDER_FLOW','LONG','NIFTY','NSE',$1,'SIGNAL','PAPER_DISABLED','v')`, [at]);
    await logFreshDecisionSummary(now);
    expect(logs.warn).toEqual([]);
    const f = logs.info.filter((x) => x.event === 'freshDailyFunnel').pop();
    expect(f).toMatchObject({ evaluations: 1, instruments: 1, opened: 1, strategies: { NEW_RS_STOCK_V1: { candidates: { FILLED: 1 }, opened: 1, closed: 0 } }, dhanSignals: { DHAN_E_ORDER_FLOW: { 'SIGNAL:PAPER_DISABLED': 1 } } });
    expect(f.chains).toMatchObject({ NIFTY: { ok: 1, failed: 0, minutesSinceOk: 1 }, SENSEX: { ok: 0, failed: 1, lastOkAt: null } });
    expect(f.scans).toEqual({ total: 4, sharePct: { ARMED: 75, BLOCKED_EVENT_DATA: 25 } });
  });
});
