// ============================================================
// MEASUREMENT GAPS — against a real Postgres (PGlite) with the full boot schema
// ============================================================
// Migration 040 applies twice, is immutable, and the services issue valid SQL
// against it. Then the whole path on real rows: a cost record at the mint; a
// post-exit watch that folds sweeps and ticks, finalises at the session end and
// writes once; the V2 grader beside the first one; and the report — with the
// trades' own rows (outcome, exit, stop, target, strategy stamp) byte-identical
// before and after every measurement step.
// ============================================================

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { buildTradeSetup } from '@fno/analytics';
import { GOLDEN_CASES } from './trade-setup-fixtures.js';

// ---- a postgres.js-shaped tagged template over PGlite ------------------------------------
class Frag {
  constructor(
    public text: string,
    public params: unknown[]
  ) {}
}
class JsonValue {
  constructor(public v: unknown) {}
}
let pg: PGlite;
const prep = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v instanceof JsonValue ? JSON.stringify(v.v) : v);
function build(strings: TemplateStringsArray, values: unknown[]): { text: string; params: unknown[] } {
  let text = '';
  const params: unknown[] = [];
  strings.forEach((s, i) => {
    text += s;
    if (i >= values.length) return;
    const v = values[i];
    if (v instanceof Frag) {
      text += v.text.replace(/\$(\d+)/g, (_m, n) => `$${params.length + Number(n)}`);
      params.push(...v.params);
    } else {
      params.push(prep(v));
      text += `$${params.length}`;
    }
  });
  return { text, params };
}
class Query extends Frag implements PromiseLike<any[]> {
  then<T1 = any[], T2 = never>(res?: ((v: any[]) => T1 | PromiseLike<T1>) | null, rej?: ((e: any) => T2 | PromiseLike<T2>) | null): Promise<T1 | T2> {
    if (failCostWrites && this.text.includes('INSERT INTO trade_cost_records')) return Promise.reject(new Error('database refused the write')).then(res as any, rej as any);
    return pg.query<any>(this.text, this.params as any[]).then((r) => r.rows, (e) => Promise.reject(Object.assign(e, { code: e.code }))).then(res as any, rej as any);
  }
}
const sqlShim: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const b = build(strings, values);
  return new Query(b.text, b.params);
};
sqlShim.json = (v: unknown) => new JsonValue(v);
sqlShim.unsafe = (s: string) => pg.exec(s);

vi.mock('../../lib/db.js', () => ({ sql: sqlShim }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

// ---- an in-memory redis -----------------------------------------------------------------
const store = new Map<string, string>();
const lists = new Map<string, string[]>();
let failCostWrites = false;
vi.mock('../../lib/redis.js', () => ({
  redis: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...rest: unknown[]) => {
      if (rest.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
    rpush: async (k: string, v: string) => {
      lists.set(k, [...(lists.get(k) ?? []), v]);
      return 1;
    },
    lrange: async (k: string) => lists.get(k) ?? [],
    lrem: async (k: string, _n: number, v: string) => {
      const l = lists.get(k) ?? [];
      const i = l.indexOf(v);
      if (i >= 0) l.splice(i, 1);
      return i >= 0 ? 1 : 0;
    },
  },
  scanKeys: async (pattern: string) => [...store.keys()].filter((k) => k.startsWith(pattern.replace('*', ''))),
}));

// ---- the chain the sampler reads --------------------------------------------------------
let fakeChain: any = null;
vi.mock('../option-chain.js', () => ({ buildOptionChain: async () => fakeChain }));
// schema readiness: every file applied below is ready
vi.mock('../ensure-capture-schema.js', async (orig) => ({ ...(await orig<typeof import('../ensure-capture-schema.js')>()), schemaFileReady: () => true }));

const { FILES, BEST_EFFORT, splitStatements } = await import('../ensure-capture-schema.js');
const C = await import('../trade-costs.js');
const P = await import('../post-exit-tracker.js');
const R = await import('../measurement-report.js');
const FV = await import('../forward-validation.js');
const { insertOnce } = await import('../../lib/insert-once.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.resolve(HERE, '../../../../../database/init');
const F040 = '040_trade_measurement.sql';

async function apply(file: string): Promise<string[]> {
  const errors: string[] = [];
  for (const s of splitStatements(readFileSync(path.join(INIT, file), 'utf-8'))) {
    try {
      await pg.exec(s);
    } catch (e: any) {
      errors.push(`${file}: ${e.message}`);
    }
  }
  return errors;
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { uuid_ossp } });
  await pg.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  expect(await apply('002_schema.sql')).toEqual([]);
  for (const f of FILES) {
    const errs = await apply(f);
    if (!BEST_EFFORT.has(f)) expect(errs, f).toEqual([]);
  }
}, 120_000);

const T_MINT = Date.parse('2026-10-12T09:45:00+05:30');
const T_EXIT = Date.parse('2026-10-12T10:00:00+05:30');

async function insertTrade(over: Record<string, unknown> = {}, time = T_MINT): Promise<string> {
  const inputs = {
    exchange: 'NSE', mode: 'INTRADAY', structureType: 'NAKED_LONG', side: 'CE', strike: 25000, expiry: '2026-10-15',
    entry: 100, stopLoss: 70, target: 111, estimatedCostPct: 3.83, source: 'INDICATOR',
    outcome: 'WIN', exitPrice: 111, exitTime: T_EXIT, closeReason: 'TARGET',
    excursion: { underlyingEntry: 25000, atrAtEntry: 20, premiumMfe: 111.4, premiumMfeAt: T_EXIT - 60_000, premiumMae: 97, premiumMaeAt: T_MINT + 60_000 },
    ...over,
  };
  const rows = await sqlShim`INSERT INTO signals (time, symbol, signal_type, direction, confidence, inputs) VALUES (${new Date(time)}, ${'NIFTY'}, ${'TRADE_SETUP'}, ${'BULLISH'}, ${80}, ${sqlShim.json(inputs)}) RETURNING id`;
  return rows[0].id;
}
const snapshotOf = async (id: string) => (await pg.query<{ row: string }>(`SELECT to_jsonb(s)::text AS row FROM signals s WHERE id = $1`, [id])).rows[0].row;

describe('migration 040', () => {
  it('is registered right after 039 and re-applies cleanly', async () => {
    expect(FILES.indexOf(F040)).toBe(FILES.indexOf('039_bar_anomalies.sql') + 1);
    expect(await apply(F040)).toEqual([]);
    const tables = (await pg.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.t);
    for (const t of ['trade_cost_records', 'trade_post_exit']) expect(tables).toContain(t);
  });

  it('both tables are insert-only: an UPDATE does nothing, a duplicate is an unique violation insertOnce reports as EXISTS', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const ins = () => sqlShim`INSERT INTO trade_cost_records (signal_id, symbol, exchange, minted_at, cost_version, basis, cost) VALUES (${id}, ${'NIFTY'}, ${'NSE'}, ${new Date(T_MINT)}, ${'COST-1.0'}, ${'ESTIMATED_MODEL'}, ${sqlShim.json({ a: 1 })})`;
    expect(await insertOnce(ins())).toBe('INSERTED');
    expect(await insertOnce(ins())).toBe('EXISTS');
    await pg.query(`UPDATE trade_cost_records SET cost = '{"a":2}'::jsonb WHERE signal_id = $1`, [id]);
    expect((await pg.query<{ c: any }>(`SELECT cost AS c FROM trade_cost_records WHERE signal_id = $1`, [id])).rows[0].c).toEqual({ a: 1 });
  });
});

describe('cost record at the mint', () => {
  it('is written once, labelled a model, reconciled with the setup, and leaves the setup untouched', async () => {
    const a = GOLDEN_CASES['p2 BULL move=100 vix=null dte=3']();
    const setup = buildTradeSetup(...a);
    const frozen = JSON.stringify(setup);
    const id = await insertTrade();
    C.recordTradeCosts({ signalId: id, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', source: 'INDICATOR', mintedAt: T_MINT, setup, chain: { strikes: a[0] as any[], lotSize: 75 } });
    await new Promise((r) => setTimeout(r, 50));
    C.recordTradeCosts({ signalId: id, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', source: 'INDICATOR', mintedAt: T_MINT, setup, chain: { strikes: a[0] as any[], lotSize: 75 } });
    await new Promise((r) => setTimeout(r, 50));
    const rows = (await pg.query<{ basis: string; cost: any }>(`SELECT basis, cost FROM trade_cost_records WHERE signal_id = $1`, [id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].basis).toBe('ESTIMATED_MODEL');
    expect(rows[0].cost.actual).toBeNull();
    expect(rows[0].cost.reconciliation.matchesSetup).toBe(true);
    expect(JSON.stringify(setup)).toBe(frozen);
  });
});

describe('a refused measurement write', () => {
  it('is logged and queued, never delays or fails the mint, and is retried idempotently', async () => {
    const a = GOLDEN_CASES['p2 BULL move=100 vix=null dte=3']();
    const setup = buildTradeSetup(...a);
    const id = await insertTrade({}, Date.parse('2026-10-13T09:45:00+05:30'));
    failCostWrites = true;
    const t0 = Date.now();
    expect(() => C.recordTradeCosts({ signalId: id, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', source: 'INDICATOR', mintedAt: T_MINT, setup, chain: { strikes: a[0] as any[], lotSize: 75 } })).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(50); // fire-and-forget: the caller does not wait for the database
    await vi.waitFor(() => expect(lists.get(C.PENDING_COST_RECORDS_KEY) ?? []).toHaveLength(1));
    expect((await pg.query(`SELECT 1 FROM trade_cost_records WHERE signal_id = $1`, [id])).rows).toHaveLength(0);

    expect(await C.drainPendingCostRecords()).toEqual({ written: 0, remaining: 1 }); // still refused: kept
    failCostWrites = false;
    expect(await C.drainPendingCostRecords()).toEqual({ written: 1, remaining: 0 });
    expect((await pg.query(`SELECT 1 FROM trade_cost_records WHERE signal_id = $1`, [id])).rows).toHaveLength(1);
    expect(await C.drainPendingCostRecords()).toEqual({ written: 0, remaining: 0 });
  });
});

describe('post-exit watch: register → sample → finalise', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    store.clear();
  });
  afterEach(() => vi.useRealTimers());

  const leg = (ltp: number) => ({ strike: 25000, call: { ltp, token: 'CE25000' }, put: { ltp: 80, token: 'PE25000' } });

  it('writes exactly one row at the session end, leaves the trade row byte-identical, and keeps the exit price', async () => {
    const id = await insertTrade();
    const before = await snapshotOf(id);
    P.registerPostExitWatch(
      { signalId: id, side: 'CE', strike: 25000, expiry: '2026-10-15', entry: 100, initialStopLoss: 70, target: 111, excursion: { underlyingEntry: 25000, atrAtEntry: 20 } },
      { symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', outcome: 'WIN', reason: 'TARGET', exitPrice: 111, exitAt: T_EXIT }
    );
    await vi.waitFor(() => expect(store.size).toBe(1));

    // two sweeps and one live tick
    fakeChain = { expiry: '2026-10-15', spotPrice: 25030, strikes: [leg(115)] };
    vi.setSystemTime(T_EXIT + 5 * 60_000);
    expect((await P.samplePostExitWatches({} as any, undefined, T_EXIT + 5 * 60_000)).watching).toBe(1);
    P.onPostExitTick({ token: 'CE25000', ltp: 121 } as any, 'DATA_FRESH');
    P.onPostExitTick({ token: 'CE25000', ltp: 999 } as any, 'DATA_FRESH'); // implausible — rejected
    P.onPostExitTick({ token: 'CE25000', ltp: 130 } as any, 'STALE'); // not a fresh token — ignored
    fakeChain = { expiry: '2026-10-15', spotPrice: 25060, strikes: [leg(117)] };
    vi.setSystemTime(T_EXIT + 10 * 60_000);
    await P.samplePostExitWatches({} as any, undefined, T_EXIT + 10 * 60_000);

    // not finalised before the session ends
    expect((await pg.query(`SELECT 1 FROM trade_post_exit WHERE signal_id = $1`, [id])).rows).toHaveLength(0);

    // the session has ended: one pass finalises, a second finds nothing to do
    const end = Date.parse('2026-10-12T15:31:00+05:30');
    vi.setSystemTime(end);
    expect((await P.samplePostExitWatches({} as any, undefined, end)).finalized).toBe(1);
    expect((await P.samplePostExitWatches({} as any, undefined, end + 1000)).finalized).toBe(0);

    const rows = (await pg.query<{ status: string; outcome: string; record: any }>(`SELECT status, outcome, record FROM trade_post_exit WHERE signal_id = $1`, [id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('OBSERVED');
    expect(rows[0].outcome).toBe('WIN');
    expect(rows[0].record.exitPrice).toBe(111);
    expect(rows[0].record.option.maxAfter).toBe(121); // the tick
    expect(rows[0].record.option.maxBeyondExitR).toBeCloseTo(10 / 30, 3);
    expect(rows[0].record.observations).toMatchObject({ sweep: 2, tick: 1 });
    expect(await snapshotOf(id)).toBe(before);
  });

  it('a close with no session left writes an explicit NOT_WATCHED row', async () => {
    const id = await insertTrade({ outcome: 'EXPIRED', closeReason: 'SESSION_ENDED', exitPrice: 90 });
    P.registerPostExitWatch(
      { signalId: id, side: 'CE', strike: 25000, expiry: '2026-10-15', entry: 100, initialStopLoss: 70, target: 111 },
      { symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', outcome: 'EXPIRED', reason: 'SESSION_ENDED', exitPrice: 90, exitAt: Date.parse('2026-10-12T15:40:00+05:30') }
    );
    await vi.waitFor(async () => expect((await pg.query(`SELECT 1 FROM trade_post_exit WHERE signal_id = $1`, [id])).rows).toHaveLength(1));
    const r = (await pg.query<{ status: string; record: any }>(`SELECT status, record FROM trade_post_exit WHERE signal_id = $1`, [id])).rows[0];
    expect(r.status).toBe('NOT_WATCHED');
    expect(r.record.option.maxAfter).toBeNull();
  });

  it('a watch that saw nothing finalises as NO_DATA', async () => {
    const id = await insertTrade();
    P.registerPostExitWatch(
      { signalId: id, side: 'CE', strike: 25000, expiry: '2026-10-15', entry: 100, initialStopLoss: 70, target: 111 },
      { symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', outcome: 'WIN', reason: 'TARGET', exitPrice: 111, exitAt: T_EXIT }
    );
    await vi.waitFor(() => expect(store.size).toBe(1));
    fakeChain = { expiry: '2099-01-01', spotPrice: 25030, strikes: [leg(115)] }; // another expiry: never priced off
    const end = Date.parse('2026-10-12T15:31:00+05:30');
    vi.setSystemTime(T_EXIT + 60_000);
    await P.samplePostExitWatches({} as any, undefined, T_EXIT + 60_000);
    vi.setSystemTime(end);
    await P.samplePostExitWatches({} as any, undefined, end);
    const r = (await pg.query<{ status: string }>(`SELECT status FROM trade_post_exit WHERE signal_id = $1`, [id])).rows[0];
    expect(r.status).toBe('NO_DATA');
  });
});

describe('payoff grader V2 beside the first one', () => {
  it('grades closed trades once, never touches the trade or the first grader\'s row, and states what it cannot verify', async () => {
    const withMonitor = await insertTrade({}, Date.parse('2026-10-09T10:00:00+05:30'));
    const noObs = await insertTrade({ excursion: null, exitTime: Date.parse('2026-10-09T10:30:00+05:30') }, Date.parse('2026-10-09T10:05:00+05:30'));
    await insertTrade({ outcome: 'WIN' }, Date.parse('2026-10-09T10:10:00+05:30'));
    // exit times inside the trade day, extremes inside the holding window
    await pg.query(
      `UPDATE signals SET inputs = inputs || jsonb_build_object('exitTime', $2::bigint, 'excursion', jsonb_build_object('underlyingEntry', 25000, 'atrAtEntry', 20, 'premiumMfe', 111.4, 'premiumMfeAt', $3::bigint, 'premiumMae', 97, 'premiumMaeAt', $4::bigint)) WHERE id = $1`,
      [withMonitor, Date.parse('2026-10-09T10:30:00+05:30'), Date.parse('2026-10-09T10:25:00+05:30'), Date.parse('2026-10-09T10:08:00+05:30')]
    );
    // the first grader already said "not reached" for this trade
    await pg.query(
      `INSERT INTO forward_outcomes (kind, subject_id, symbol, exchange, decided_at, versions, predicted, actual) VALUES ('OPTION_PAYOFF', $1, 'NIFTY', 'NSE', now(), '{}', '{}', '{"targetReached": false, "marks": 2}')`,
      [withMonitor]
    );
    const legacyBefore = (await pg.query<{ a: string }>(`SELECT actual::text AS a FROM forward_outcomes WHERE kind = 'OPTION_PAYOFF' AND subject_id = $1`, [withMonitor])).rows[0].a;
    const tradeBefore = await snapshotOf(withMonitor);

    const now = Date.parse('2026-10-12T20:00:00+05:30');
    await FV.runForwardValidation(now);
    await FV.runForwardValidation(now); // idempotent

    const v2 = (await pg.query<{ subject_id: string; actual: any }>(`SELECT subject_id, actual FROM forward_outcomes WHERE kind = 'OPTION_PAYOFF_V2'`)).rows;
    const mine = v2.find((r) => r.subject_id === withMonitor)!;
    expect(mine.actual.verdict).toBe('CORROBORATED');
    expect(mine.actual.targetLevel.observedBy).toBe('MONITOR_EXTREME');
    expect(mine.actual.legacyContradictedRecordedExit).toBe(true);
    const none = v2.find((r) => r.subject_id === noObs)!;
    expect(none.actual.verdict).toBe('UNVERIFIABLE');
    expect(none.actual.maxPremiumObserved).toBeNull();
    expect(v2.filter((r) => r.subject_id === withMonitor)).toHaveLength(1);
    expect((await pg.query<{ a: string }>(`SELECT actual::text AS a FROM forward_outcomes WHERE kind = 'OPTION_PAYOFF' AND subject_id = $1`, [withMonitor])).rows[0].a).toBe(legacyBefore);
    expect(await snapshotOf(withMonitor)).toBe(tradeBefore);
  });
});

describe('the report', () => {
  it('reports cohorts apart, excluded rows by category, EXPIRED separately, and the new records', async () => {
    await pg.query(`DELETE FROM signals`);
    const mk = (over: Record<string, unknown>, iso: string) => insertTrade(over, Date.parse(iso));
    await mk({}, '2026-10-01T10:00:00+05:30'); // PRE win
    await mk({ outcome: 'LOSS', closeReason: 'STOP_LOSS', exitPrice: 66 }, '2026-10-01T11:00:00+05:30'); // PRE loss
    await mk({ outcome: 'EXPIRED', closeReason: 'SESSION_ENDED', exitPrice: 95 }, '2026-10-06T11:00:00+05:30'); // POST_A expired
    await mk({ voided: true }, '2026-10-06T12:00:00+05:30'); // POST_A voided
    await mk({ outcome: 'EXPIRED', closeReason: 'TRACKING_LOST', voided: true, exitPrice: null }, '2026-10-07T12:00:00+05:30'); // POST_A lost
    await mk({ source: 'S1' }, '2026-10-12T10:00:00+05:30'); // POST_B win, other family
    const r = await R.measurementReport({ since: null, until: null, instrument: null });

    const cohort = (c: string) => r.byCohort.find((x) => x.cohort === c)!.tally;
    expect(cohort('PRE')).toMatchObject({ n: 2, wins: 1, losses: 1, expired: 0 });
    expect(cohort('POST_A')).toMatchObject({ n: 1, expired: 1, wins: 0, losses: 0, rows: 3 });
    expect(cohort('POST_A').excluded).toMatchObject({ VOIDED: 1, TRACKING_LOST: 1 });
    expect(cohort('POST_A').winRateClosedOnly).toBeNull(); // no closed wins/losses: not 0
    expect(cohort('POST_B')).toMatchObject({ n: 1, wins: 1 });
    expect(r.byFamily.filter((f) => f.cohort === 'POST_B').map((f) => f.family)).toEqual(['S1']);
    expect(r.schemaReady).toBe(true);
    expect(r.versions.conservativeFill).toBe('CONSERVATIVE_FILL_V1');
    expect(r.cohortBoundaries.PRE).toMatch(/before/);
    expect(r.reliability.measurementsReliableFrom).toBe('2026-10-11T18:30:00.000Z');
    expect(r.costs?.basis).toBe('ESTIMATED_MODEL');
    expect(r.postExit?.byStatus).toBeDefined();
    // instrument filter
    const none = await R.measurementReport({ since: null, until: null, instrument: 'BANKNIFTY' });
    expect(none.byCohort).toEqual([]);
  });
});
