import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { ARMS, openPosition, type ExpCandidate } from '../experiment-arms.js';

const bridge = vi.hoisted(() => ({ query: null as null | ((s: readonly string[], v: unknown[]) => Promise<unknown[]>) }));
vi.mock('../../lib/db.js', () => ({ sql: (s: readonly string[], ...v: unknown[]) => bridge.query!(s, v) }));
vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => true }));
const { entryConfirmationReport, summarizeEntryConfirmation } = await import('../entry-confirmation-report.js');
const db = new PGlite();
const t = Date.parse('2026-10-26T10:00:00+05:30');
const query = { since: null, until: null, instrument: 'NIFTY', strategyVersion: null, costVersion: null };
const pos = (id: number, result: number | null, arm = 'OB1C') => {
  const c = { at: t, candidateId: `c${id}`, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', direction: 'BULLISH', confidence: 80, side: 'CE', strike: 24000, expiry: '2026-10-27', token: '1', lotSize: 50, entry: 100, stop: 80, target: 140, costPct: 2, statutoryPct: .2, brokeragePerLotInr: 40, minutesSinceOpen: 45, behindLevel: 94, atr: 10, decisionTime: t - 900_000, quote: { ltp: 100, bid: 99, ask: 101, bidQty: 500, askQty: 500, exchangeAt: t, receivedAt: t, feedState: null, source: 'CHAIN' } } as ExpCandidate;
  const p = openPosition(ARMS.find((a) => a.id === arm)!, c, `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`, t + 1000);
  if (result != null) {
    p.official = { status: 'CLOSED', exitAt: t + id * 60_000, exitPrice: 100 + result * 20 + 2, reason: result > 0 ? 'TARGET' : 'STOP_LOSS', netR: result };
    p.sim = { ...p.sim, status: 'CLOSED', exitAt: t + id * 60_000, netR: result };
  }
  return p;
};
beforeAll(async () => {
  await db.exec('CREATE TABLE slot_decisions (id uuid PRIMARY KEY);');
  await db.exec(readFileSync(new URL('../../../../../database/init/045_experiments_and_linkage.sql', import.meta.url), 'utf8'));
  bridge.query = async (strings, params) => (await db.query(strings.reduce((s, part, i) => s + (i ? `$${i}` : '') + part, ''), params.map((p) => p instanceof Date ? p.toISOString() : p))).rows;
  for (const p of [pos(1, 1.9), pos(2, -1.1), pos(3, null), pos(5, 9, 'OF1R'), { ...pos(6, 99), armVersion: 'OB1C-ENTRY-0.0' }, pos(7, .5, 'OF1C')]) {
    if (p.candidate.candidateId === 'c2') p.sim = { ...p.sim, status: 'NOT_OPENED', netR: null };
    await db.query(`INSERT INTO experiment_positions (id,arm,arm_version,candidate_id,symbol,exchange,mode,direction,opened_at,official_status,sim_status,official_net_r,sim_net_r,state)
      VALUES ($1,$2,$3,$4,'NIFTY','NSE','INTRADAY','BULLISH',$5,$6,$7,$8,$9,$10)`, [p.id, p.arm, p.armVersion, p.candidate.candidateId, new Date(p.openedAt).toISOString(), p.official.status, p.sim.status, p.official.netR, p.sim.netR, JSON.stringify(p)]);
  }
  // Duplicate poll attempts hit the real UNIQUE key; one observation per candidate/arm/code.
  for (const id of [1, 2, 3, 4, 1]) await db.query(`INSERT INTO experiment_decisions (at,arm,arm_version,candidate_id,symbol,exchange,mode,decision,code,detail)
    VALUES ($1,'OB1J','OB1J-ENTRY-1.0',$2,'NIFTY','NSE','INTRADAY','OBSERVE','OB_REJECTION_NOT_CONFIRMED','{}') ON CONFLICT DO NOTHING`, [new Date(t).toISOString(), `c${id}`]);
  await db.query(`INSERT INTO experiment_decisions (at,arm,arm_version,candidate_id,symbol,exchange,mode,decision,code,detail)
    VALUES ($1,'OF1G','OF1G-ENTRY-1.0','c7','NIFTY','NSE','INTRADAY','OBSERVE','RULE_PASS',$2)`, [new Date(t).toISOString(), JSON.stringify({ entryEvidence: { found: ['ABSORPTION', 'DELTA'] } })]);
}, 20_000);
afterAll(async () => { await db.close(); });

describe('real PostgreSQL-compatible schema and independently calculated reporting', () => {
  it('does not mix versions, open trades, absent fills or missed outcomes into closed net returns', async () => {
    const r = await entryConfirmationReport(query);
    expect(r.status).toBe('AVAILABLE');
    if (r.status !== 'AVAILABLE') throw new Error(r.reason);
    const control = r.arms.find((a) => a.arm === 'OB1C')!;
    expect(control.positions).toBe(3);
    expect(control.official).toMatchObject({ closed: 2, open: 1, winRate: .5 });
    expect(control.official.avgNetR).toBeCloseTo(.4); // (1.9 - 1.1) / 2
    expect(control.official.totalNetR).toBeCloseTo(.8);
    expect(control.official.realisedDrawdownR).toBeCloseTo(1.1);
    expect(control.simulated).toMatchObject({ closed: 1, open: 1, unavailable: 1, avgNetR: 1.9 });
    expect(control.avgEstimatedCostR).toBeCloseTo(.1); // 100 * 2% / (100-80)
    expect(control.avgEntryDelaySeconds).toBe(1);
    expect(r.pairs[0]).toMatchObject({ filteredCandidates: 4, controlPositions: 3, closedControl: 2, pendingControl: 1, noControlPosition: 1, missedWinners: 1, avoidedLosers: 1, flat: 0, simulatedClosedControl: 1, simulatedMissedWinners: 1, simulatedAvoidedLosers: 0 });
    expect(r.pairs[0].rejectedControlAvgNetR).toBeCloseTo(.4);
    expect(r.combinations).toEqual([{ evidence: 'ABSORPTION + DELTA', observed: 1, passed: 1, controlClosed: 1, controlAvgNetR: .5 }]);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM experiment_positions')).rows).toEqual([{ n: 6 }]); // old rows retained
  });
  it('uses the requested instrument and inclusive-since/exclusive-until entry window', async () => {
    const empty = await entryConfirmationReport({ ...query, instrument: 'BANKNIFTY' });
    expect(empty.status === 'AVAILABLE' && empty.arms.every((a) => a.positions === 0 && a.observed === 0 && a.official.avgNetR === null)).toBe(true);
    const before = await entryConfirmationReport({ ...query, until: new Date(t) });
    expect(before.status === 'AVAILABLE' && before.arms.every((a) => a.positions === 0 && a.observed === 0)).toBe(true);
    const after = await entryConfirmationReport({ ...query, since: new Date(t) });
    expect(after.status === 'AVAILABLE' && after.pairs[0].filteredCandidates).toBe(4);
  });
  it('no samples means null returns, not a zero-return or zero-drawdown claim', () => {
    const r = summarizeEntryConfirmation([], []);
    expect(r.arms.every((a) => a.official.avgNetR === null && a.official.realisedDrawdownR === null && a.avgEstimatedCostR === null)).toBe(true);
  });
  it('a database failure is explicitly unavailable, never an empty successful report', async () => {
    const original = bridge.query;
    bridge.query = async () => { throw new Error('offline'); };
    try { expect(await entryConfirmationReport(query)).toMatchObject({ status: 'UNAVAILABLE', reason: 'EXPERIMENT_QUERY_FAILED' }); }
    finally { bridge.query = original; }
  });
});
