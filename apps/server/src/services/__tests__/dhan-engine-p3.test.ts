// Dhan engine v2, phase 3: the shadow recorder on the real 053 schema (PGlite): context built from the flow store,
// SIGNAL / NO_TRADE rows written once per strategy / side / contract / bar, NO_SETUP only counted, expiry-gamma
// samples kept for the day and each side's first signal recorded. Nothing opens a position.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

let pg: PGlite;
const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce((q, s, i) => q + s + (i < values.length ? `$${i + 1}` : ''), '');
  return pg.query(text, values.map((v) => (v instanceof Date ? v.toISOString() : v))).then((r) => r.rows);
};
const db = Object.assign(tag, { json: (x: unknown) => JSON.stringify(x) });
vi.mock('../../lib/db.js', () => ({ sql: db }));
vi.mock('../../lib/redis.js', () => ({ redis: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn(o: any, m: string) { throw new Error(`unexpected warn: ${m} ${JSON.stringify(o)}`); }, error() {}, debug() {} } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: (f: string) => f === '053_dhan_engine_signals.sql' || f === '054_dhan_engine_paper.sql' }));

// The setups themselves are tested in packages/analytics; here a fixed evaluation drives the recorder.
const fixed = { results: [] as any[], sessionWindow: 'PRIMARY', regime: { regime: 'SIDEWAYS' } };
vi.mock('@fno/analytics', async (orig) => ({ ...(await orig<typeof import('@fno/analytics')>()), evaluateDhanSetups: vi.fn(() => fixed) }));

const store = await import('../order-flow-store.js');
const shadow = await import('../dhan-engine-shadow.js');
const analytics = await import('@fno/analytics');

const OPEN = Date.parse('2026-11-09T03:45:00Z'); // Monday 09:15 IST
const Q = 900_000;
const healthy = () => ({ stale: false, mappingValid: true });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(new URL('../../../../../database/init/053_dhan_engine_signals.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../../../../../database/init/053_dhan_engine_signals.sql', import.meta.url), 'utf8')); // idempotent
  for (let k = 0; k < 2; k++) await pg.exec(readFileSync(new URL('../../../../../database/init/054_dhan_engine_paper.sql', import.meta.url), 'utf8'));
}, 30_000);

beforeEach(async () => {
  store.resetFlowStore();
  shadow.resetDhanShadow();
  shadow.setDhanPaperHandler(null);
  await pg.exec('DELETE FROM dhan_engine_signals');
  store.registerFlowSymbol('NIFTY', { exchange: 'NSE', instrument: 'NIFTY-Nov2026-FUT', source: 'DHAN', mode: 'INFERRED', startedAt: OPEN - 3 * 86_400_000 - Q, kind: 'INDEX', tickSize: 0.1 });
});

async function trade(t: number, price: number, qty: number, side: 'BUY' | 'SELL') { store.recordFlowTrade('NIFTY', { time: t, price, qty, side }); }

describe('setup context from the flow store', () => {
  it('maps closed footprints: first-trade open, trade VWAP sums, prior-session daily bar, no RVOL without 20 sessions', async () => {
    const fri = OPEN - 3 * 86_400_000;
    await trade(fri + 1000, 100, 10, 'BUY'); await trade(fri + 2000, 104, 10, 'SELL'); await trade(fri + 3000, 102, 10, 'BUY');
    await store.closeFlowBars(fri + Q + 1, true);
    await trade(OPEN + 1000, 103, 20, 'BUY'); await trade(OPEN + 2000, 105, 10, 'SELL');
    await store.closeFlowBars(OPEN + Q + 1, true);
    const c = (await shadow.setupContextFor('NIFTY', OPEN + Q + 1, healthy, false))!;
    expect(c.bars.map((b) => [b.open, b.high, b.low, b.close])).toEqual([[100, 104, 100, 102], [103, 105, 103, 105]]);
    expect(c.vwapSums[1]).toEqual({ pv: 103 * 20 + 105 * 10, v: 30, p2v: 103 * 103 * 20 + 105 * 105 * 10 });
    expect(c.daily).toEqual([{ time: fri, open: 100, high: 104, low: 100, close: 102 }]);
    expect(c.rvol).toEqual([null, null]);
    expect(c).toMatchObject({ sessionOpen: OPEN, tickSize: 0.1, exchange: 'NSE', health: { stale: false, mappingValid: true } });
  });
});

describe('shadow recorder', () => {
  const sig = (status: string, extra: object = {}) => ({ setup: 'A', strategy: 'DHAN_A_SWEEP_ABSORPTION', side: 'BULLISH', status, failed: status === 'NO_SETUP' ? 'A2_SWEEP' : null, checks: [{ id: 'A1', ok: true }], gates: [{ id: 'VALID_DATA', ok: true }], noTrade: { tradeable: true, reasons: [], notEvaluated: [] }, plan: { entry: 101, sl: 99, target: 106, targetKind: 'PDH', rr: 2.5 }, score: { total: 8, eligibility: 'PREFERRED', lines: [] }, evidence: { zone: 99 }, ...extra });
  it('writes SIGNAL and NO_TRADE once per bar, counts NO_SETUP, and skips a contract with nothing new', async () => {
    fixed.results = [sig('SIGNAL'), sig('NO_TRADE', { side: 'BEARISH' }), sig('NO_SETUP', { strategy: 'DHAN_C_FAILED_AUCTION_CVD' })];
    await trade(OPEN + 1000, 100, 10, 'BUY');
    await store.closeFlowBars(OPEN + Q + 1, true);
    expect(await shadow.evaluateDhanShadow(OPEN + Q + 1, healthy)).toBe(1);
    expect(await shadow.evaluateDhanShadow(OPEN + Q + 2, healthy)).toBe(0); // same bar: not re-evaluated
    const rows = (await pg.query<any>('SELECT * FROM dhan_engine_signals ORDER BY side')).rows;
    expect(rows.map((r) => [r.strategy, r.side, r.status, Number(r.entry), Number(r.stop_loss), Number(r.rr), r.score, r.session_window, r.version])).toEqual([
      ['DHAN_A_SWEEP_ABSORPTION', 'BEARISH', 'NO_TRADE', 101, 99, 2.5, 8, 'PRIMARY', 'DHAN-SETUPS-1.1'],
      ['DHAN_A_SWEEP_ABSORPTION', 'BULLISH', 'SIGNAL', 101, 99, 2.5, 8, 'PRIMARY', 'DHAN-SETUPS-1.1'],
    ]);
    expect(new Date(rows[0].bar_time).getTime()).toBe(OPEN);
    expect(shadow.dhanShadowStatus()).toMatchObject({ recorded: { SIGNAL: 1, NO_TRADE: 1 }, firstFailures: [{ k: 'DHAN_C_FAILED_AUCTION_CVD:A2_SWEEP', c: 1 }] });
    expect((await shadow.dhanShadowSignals('2026-11-09')).length).toBe(2);
    expect(analytics.evaluateDhanSetups).toHaveBeenCalledTimes(1);
  });
  it('phase 4: hands each SIGNAL (only) to the paper handler and records its decision on the row', async () => {
    fixed.results = [sig('SIGNAL', { evidence: { atr: 12 } }), sig('NO_TRADE', { side: 'BEARISH' })];
    const handler = vi.fn(async () => ({ decision: 'FILLED', candidateId: 'cand-1' }));
    shadow.setDhanPaperHandler(handler);
    await trade(OPEN + 1000, 100, 10, 'BUY');
    await store.closeFlowBars(OPEN + Q + 1, true);
    await shadow.evaluateDhanShadow(OPEN + Q + 1, healthy);
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'NIFTY', barTime: OPEN, decidedAt: OPEN + Q, atr: 12, exchange: 'NSE', kind: 'INDEX' }));
    const rows = (await pg.query<any>('SELECT side, paper_decision, paper_candidate_id FROM dhan_engine_signals ORDER BY side')).rows;
    expect(rows).toEqual([{ side: 'BEARISH', paper_decision: null, paper_candidate_id: null }, { side: 'BULLISH', paper_decision: 'FILLED', paper_candidate_id: 'cand-1' }]);
    expect(shadow.dhanShadowStatus().paper).toEqual({ FILLED: 1 });
    expect(store.flowLastTrade('NIFTY')).toEqual({ price: 100, at: OPEN + 1000 });
  });
  it('does not decide on a closed bar without trades', async () => {
    fixed.results = [sig('SIGNAL')];
    await trade(OPEN + 1000, 100, 10, 'BUY');
    await store.closeFlowBars(OPEN + 2 * Q + 1, true); // bar 2 closed empty
    expect(await shadow.evaluateDhanShadow(OPEN + 2 * Q + 1, healthy)).toBe(0);
  });
});

describe('expiry gamma recorder', () => {
  const ist = (h: number, m: number) => Date.parse('2026-11-10T00:00:00Z') - 19_800_000 + (h * 60 + m) * 60_000; // Tuesday
  const leg = (oi: number) => ({ token: 't', ltp: 1, bid: 1, ask: 1, oi } as any);
  const chain = (spot: number, calls: number[], puts: number[]) => ({ spotPrice: spot, expiry: '2026-11-10', strikes: [23800, 23900, 24000, 24100, 24200].map((strike, k) => ({ strike, distanceFromSpot: 0, call: leg(calls[k]), put: leg(puts[k]) })) });
  it('keeps the day\'s samples and records each side\'s first signal once', async () => {
    await shadow.recordGammaChain('NIFTY', chain(23950, [500, 700, 1000, 600, 400], [900, 800, 800, 500, 300]), ist(12, 0), ist(12, 0));
    await shadow.recordGammaChain('NIFTY', chain(24005, [500, 700, 1000, 600, 400], [900, 800, 800, 500, 300]), ist(13, 10), ist(13, 10));
    await shadow.recordGammaChain('NIFTY', chain(24010, [500, 700, 700, 600, 400], [900, 900, 1100, 500, 300]), ist(13, 58), ist(13, 58));
    await shadow.recordGammaChain('NIFTY', chain(24012, [500, 700, 650, 600, 400], [900, 900, 1150, 500, 300]), ist(13, 59), ist(13, 59));
    const rows = (await pg.query<any>("SELECT * FROM dhan_engine_signals WHERE strategy='DHAN_EXPIRY_GAMMA'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ side: 'BULLISH', symbol: 'NIFTY', status: 'SIGNAL', session_window: 'EXPIRY_PM', version: 'DHAN-GAMMA-1.0' });
    const ev = typeof rows[0].evidence === 'string' ? JSON.parse(rows[0].evidence) : rows[0].evidence;
    expect(ev).toMatchObject({ atm: 24000, dCallOi: -300, dPutOi: 300, dayHigh: 24005, dayRangeSource: 'CHAIN_SAMPLE_SPOT', strikes: { atm: 24000, itm: 23900, right: 'CE' } });
    expect(shadow.dhanShadowStatus().gamma).toEqual([{ index: 'NIFTY', day: '2026-11-10', samples: 4, fired: ['BULLISH'] }]);
  });
  it('8 Nov: hands each gamma signal to the paper handler (30% premium stop) and records the decision', async () => {
    const handler = vi.fn(async () => ({ decision: 'FILLED', candidateId: 'g-1' }));
    shadow.setDhanPaperHandler(handler);
    await shadow.recordGammaChain('NIFTY', chain(24005, [500, 700, 1000, 600, 400], [900, 800, 800, 500, 300]), ist(13, 10), ist(13, 10));
    await shadow.recordGammaChain('NIFTY', chain(24010, [500, 700, 700, 600, 400], [900, 900, 1100, 500, 300]), ist(13, 58), ist(13, 58));
    await new Promise((r) => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'NIFTY', at: ist(13, 58), gamma: expect.objectContaining({ side: 'BULLISH', status: 'SIGNAL' }) }));
    const rows = (await pg.query<any>("SELECT paper_decision, paper_candidate_id FROM dhan_engine_signals WHERE strategy='DHAN_EXPIRY_GAMMA'")).rows;
    expect(rows).toEqual([{ paper_decision: 'FILLED', paper_candidate_id: 'g-1' }]);
  });
  it('records nothing when the chain does not expire today', async () => {
    await shadow.recordGammaChain('NIFTY', { ...chain(24005, [500, 700, 1000, 600, 400], [900, 800, 800, 500, 300]), expiry: '2026-11-17' }, ist(13, 10), ist(13, 10));
    await shadow.recordGammaChain('NIFTY', { ...chain(24010, [500, 700, 700, 600, 400], [900, 900, 1100, 500, 300]), expiry: '2026-11-17' }, ist(13, 58), ist(13, 58));
    expect((await pg.query("SELECT 1 FROM dhan_engine_signals")).rows).toHaveLength(0);
    expect(shadow.chainExpiresToday('2026-11-10T00:00:00.000Z', ist(14, 0))).toBe(true);
    expect(shadow.chainExpiresToday(null, ist(14, 0))).toBe(false);
  });
});
