// ============================================================
// READ-ONLY VIEWS (2026-10-10) — page visits must not mutate production data
// ============================================================
// On 10 Oct a UI audit opened the Market Scanner page; GET /api/market-scanner
// computed a fresh scan (a bias per finalist) and wrote ~105 decision rows.
// These tests pin the fix at HTTP level: the routes the web terminal reads on
// mount and on every refresh never call the decision engine, the scanner, the
// provider or a SQL writer, and the explicit scan is a separate POST action.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ---- spies that must never fire on a read ------------------------------------------------
const spies = {
  buildMarketBias: vi.fn(async () => {
    throw new Error('the engine must not run on a read');
  }),
  noteBiasRequest: vi.fn(),
  refreshMarketScan: vi.fn(async () => ({ scannedAt: Date.now(), candidates: [] })),
  getFnoScan: vi.fn(async () => {
    throw new Error('the F&O scan must not run on a read');
  }),
  nseOpen: vi.fn(() => true),
  sqlWrites: vi.fn(),
  providerCalls: vi.fn(),
};

const store = new Map<string, string>();
const dbRows: { match: RegExp; rows: any[] }[] = [];

vi.mock('@fno/shared', async (importOriginal) => ({ ...(await importOriginal<typeof import('@fno/shared')>()), isMarketOpen: (...a: unknown[]) => (a[0] === 'NSE' ? spies.nseOpen() : false) }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../../lib/redis.js', () => ({
  redis: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (...a: unknown[]) => {
      spies.sqlWrites('redis.set', ...a);
      return 'OK';
    },
    mget: async (...keys: string[]) => keys.map((k) => store.get(k) ?? null),
  },
  scanKeys: async (pattern: string) => [...store.keys()].filter((k) => k.startsWith(pattern.replace('*', ''))),
}));
vi.mock('../../lib/db.js', () => {
  const sql: any = (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/\b(INSERT|UPDATE|DELETE)\b/i.test(text)) spies.sqlWrites('sql', text);
    const hit = dbRows.find((d) => d.match.test(text));
    return Promise.resolve(hit ? hit.rows : []);
  };
  sql.json = (v: unknown) => v;
  return { sql };
});
vi.mock('../market-bias.js', () => ({ buildMarketBias: spies.buildMarketBias }));
vi.mock('../cache-warmer.js', () => ({ noteBiasRequest: spies.noteBiasRequest }));
vi.mock('../market-scanner.js', () => ({ refreshMarketScan: spies.refreshMarketScan, getMarketScan: spies.getFnoScan, SCAN_CACHE_KEY: 'market_scan:latest' }));
vi.mock('../fno-scanner.js', () => ({ getFnoScan: spies.getFnoScan }));
vi.mock('../indices.js', () => ({ getLiveIndexQuotes: async () => [], getMcxCommodityQuotes: async () => [], ALL_INDEX_LIST: [] }));
vi.mock('../chart-patterns.js', () => ({ getCachedPatterns: async () => [] }));
vi.mock('../backtesting.js', () => ({ getTradeSetupHistory: async () => [] }));

const provider: any = new Proxy({}, { get: (_t, prop) => (...a: unknown[]) => spies.providerCalls(String(prop), ...a) });

const { createMarketScannerRoutes, MANUAL_SCAN_MIN_INTERVAL_MS } = await import('../../api/market-scanner.js');
const { createInstrumentRoutes } = await import('../../api/instruments.js');
const { createFiiDiiRoutes } = await import('../../api/fii-dii.js');
const { createMarketDataRoutes } = await import('../../api/market.js');
const { createPaperTradesRoutes } = await import('../../api/paper-trades.js');
const V = await import('../read-only-views.js');
const TM = await import('../trade-marks.js');
const PT = await import('../paper-trades.js');

const app = express();
app.use(express.json());
app.use('/api/market-scanner', createMarketScannerRoutes(provider));
app.use('/api/instruments', createInstrumentRoutes(provider));
app.use('/api/fii-dii', createFiiDiiRoutes());
app.use('/api/market', createMarketDataRoutes(provider));
app.use('/api/paper-trades', createPaperTradesRoutes());
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());
const get = async (p: string) => (await fetch(base() + p)).json() as Promise<any>;

beforeEach(() => {
  store.clear();
  dbRows.length = 0;
  for (const s of Object.values(spies)) (s as any).mockClear?.();
});

const noEffects = () => {
  expect(spies.buildMarketBias).not.toHaveBeenCalled();
  expect(spies.noteBiasRequest).not.toHaveBeenCalled();
  expect(spies.refreshMarketScan).not.toHaveBeenCalled();
  expect(spies.getFnoScan).not.toHaveBeenCalled();
  expect(spies.providerCalls).not.toHaveBeenCalled();
  expect(spies.sqlWrites).not.toHaveBeenCalled();
};

describe('GET /api/market-scanner — read-only', () => {
  it('with nothing recorded it says so and does NOT run a scan (the 10 Oct incident)', async () => {
    const r = await get('/api/market-scanner');
    expect(r.success).toBe(true);
    expect(r.data).toBeNull();
    expect(r.meta).toMatchObject({ readOnly: true, source: 'NONE', asOf: null });
    expect(r.meta.unavailableReason).toMatch(/No market scan/);
    noEffects();
  });

  it('serves the live cache, else the last-known copy, with its age', async () => {
    const scannedAt = Date.now() - 90_000;
    store.set(V.MARKET_SCAN_LAST_KEY, JSON.stringify({ scannedAt, candidates: [] }));
    let r = await get('/api/market-scanner');
    expect(r.meta).toMatchObject({ source: 'LAST_KNOWN', asOf: scannedAt });
    expect(r.meta.ageSeconds).toBeGreaterThanOrEqual(89);
    store.set(V.MARKET_SCAN_LATEST_KEY, JSON.stringify({ scannedAt: scannedAt + 60_000, candidates: [] }));
    r = await get('/api/market-scanner');
    expect(r.meta).toMatchObject({ source: 'CACHE', asOf: scannedAt + 60_000 });
    noEffects();
  });

  const explicit = { 'x-explicit-action': 'run-market-scan' };

  it('the explicit scan is a separate POST: it runs once, and is rate-limited', async () => {
    const first = await fetch(base() + '/api/market-scanner/refresh', { method: 'POST', headers: explicit });
    expect(first.status).toBe(200);
    expect(spies.refreshMarketScan).toHaveBeenCalledTimes(1);
    const second = await fetch(base() + '/api/market-scanner/refresh', { method: 'POST', headers: explicit });
    expect(second.status).toBe(429);
    expect(spies.refreshMarketScan).toHaveBeenCalledTimes(1);
    expect(MANUAL_SCAN_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    // GET on the refresh path does nothing
    expect((await fetch(base() + '/api/market-scanner/refresh')).status).toBe(404);
  });

  it('a POST without the explicit-action header never starts a scan', async () => {
    const r = await fetch(base() + '/api/market-scanner/refresh', { method: 'POST' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe('EXPLICIT_ACTION_REQUIRED');
    const wrong = await fetch(base() + '/api/market-scanner/refresh', { method: 'POST', headers: { 'x-explicit-action': 'yes' } });
    expect(wrong.status).toBe(400);
    expect(spies.refreshMarketScan).not.toHaveBeenCalled();
  });

  it('an explicit scan is refused while NSE is closed (found 11 Oct: a closed-market scan wrote 17 MARKET_CLOSED decision rows)', async () => {
    spies.nseOpen.mockReturnValueOnce(false);
    const r = await fetch(base() + '/api/market-scanner/refresh', { method: 'POST', headers: explicit });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe('MARKET_CLOSED');
    expect(spies.refreshMarketScan).not.toHaveBeenCalled();
    noEffects();
  });
});

describe('GET /api/instruments/fno-scanner — read-only', () => {
  it('never scans; says where the rows came from', async () => {
    let r = await get('/api/instruments/fno-scanner');
    expect(r.data).toEqual([]);
    expect(r.meta).toMatchObject({ readOnly: true, source: 'NONE' });
    const rows = [{ symbol: 'ITC', timestamp: Date.now() - 5000 }];
    store.set('fno-scanner:last:NSE', JSON.stringify({ at: 123456, rows }));
    r = await get('/api/instruments/fno-scanner');
    expect(r.data).toHaveLength(1);
    expect(r.meta).toMatchObject({ source: 'LAST_KNOWN', asOf: 123456, count: 1 });
    store.set('fno-scanner:NSE', JSON.stringify(rows));
    r = await get('/api/instruments/fno-scanner');
    expect(r.meta.source).toBe('CACHE');
    expect(r.meta.asOf).toBe(rows[0].timestamp);
    noEffects();
  });
});

describe('GET /api/fii-dii — read-only', () => {
  it('reads the cache or the newest history row and never calls NSE', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = fetchSpy.mock.calls.length;
    dbRows.push({ match: /fii_dii_history/, rows: [{ date: '09-Oct-2026', fii_buy: '1', fii_sell: '2', fii_net: '-1', dii_buy: '3', dii_sell: '1', dii_net: '2', fetched_at: new Date('2026-10-09T13:00:00Z') }] });
    const r = await get('/api/fii-dii');
    expect(r.data.fii.netValue).toBe(-1);
    expect(r.meta).toMatchObject({ source: 'DATABASE', readOnly: true });
    // only the test's own request went out — nothing to nseindia.com
    const urls = fetchSpy.mock.calls.slice(before).map((c) => String(c[0]));
    expect(urls.every((u) => u.startsWith('http://127.0.0.1'))).toBe(true);
    noEffects();
    fetchSpy.mockRestore();
  });
});

describe('GET /api/market/bias-snapshot/:symbol — read-only', () => {
  it('never runs the engine and never registers the symbol; reads the engine cache', async () => {
    store.set('bias_result:NSE:NIFTY:INTRADAY', JSON.stringify({ bias: { direction: 'BULLISH', confidence: 83, regime: 'TRENDING_UP', timestamp: Date.now() - 20_000, inputs: { pcr: 1.12 } }, score: { score: 66 } }));
    const r = await get('/api/market/bias-snapshot/nifty?exchange=NSE');
    expect(r.data).toMatchObject({ symbol: 'NIFTY', direction: 'BULLISH', confidence: 83, origin: 'ENGINE_CACHE', pcr: 1.12 });
    expect(r.meta).toMatchObject({ source: 'CACHE', readOnly: true });
    expect(r.meta.ageSeconds).toBeGreaterThanOrEqual(19);
    noEffects();
  });

  it('serves the 2-day last-known copy when the 5-minute cache has expired', async () => {
    store.set('bias_last:NSE:NIFTY:INTRADAY', JSON.stringify({ bias: { direction: 'BEARISH', confidence: 70, regime: 'TRENDING_DOWN', timestamp: Date.now() - 3 * 3_600_000 } }));
    const r = await get('/api/market/bias-snapshot/NIFTY');
    expect(r.data).toMatchObject({ direction: 'BEARISH', origin: 'ENGINE_CACHE' });
    expect(r.meta).toMatchObject({ source: 'LAST_KNOWN' });
    expect(r.meta.ageSeconds).toBeGreaterThan(3 * 3600 - 5);
    noEffects();
  });

  it('falls back to the last decision record, then to an explicit NONE', async () => {
    dbRows.push({ match: /decision_snapshots/, rows: [{ time: new Date('2026-10-09T10:00:00Z'), regime: 'RANGE_BOUND', bias: 'NEUTRAL', confidence: '55', pcr: '1.0', vix: '14', underlying_price: '22500', reason: 'NEUTRAL_BIAS' }] });
    let r = await get('/api/market/bias-snapshot/NIFTY');
    expect(r.data).toMatchObject({ origin: 'LAST_DECISION_RECORD', direction: 'NEUTRAL', confidence: 55, reason: 'NEUTRAL_BIAS' });
    expect(r.meta.source).toBe('DATABASE');
    dbRows.length = 0;
    r = await get('/api/market/bias-snapshot/NIFTY');
    expect(r.data).toBeNull();
    expect(r.meta).toMatchObject({ source: 'NONE', asOf: null });
    noEffects();
  });

  it('the legacy engine-running route is untouched and still the only one that calls the engine', async () => {
    const res = await fetch(base() + '/api/market/bias/NIFTY');
    expect(res.status).toBe(502); // our spy throws: proves THIS route still runs the engine
    expect(spies.buildMarketBias).toHaveBeenCalledTimes(1);
    expect(spies.noteBiasRequest).toHaveBeenCalledTimes(1);
  });
});

describe('read-only constants agree with the writers', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = (f: string) => readFileSync(path.join(HERE, '..', f), 'utf-8');

  it('the cache keys the readers use are the ones the engines write', () => {
    expect(V.MARKET_SCAN_LATEST_KEY).toBe('market_scan:latest');
    expect(src('market-scanner.ts')).toMatch(/export const SCAN_CACHE_KEY = 'market_scan:latest'/);
    expect(src('market-bias.ts')).toContain('`bias_result:${exchange}:${underlying}:${mode}`');
    expect(V.biasResultKey('NSE', 'NIFTY', 'INTRADAY')).toBe('bias_result:NSE:NIFTY:INTRADAY');
    expect(V.biasLastKey('NSE', 'NIFTY', 'INTRADAY')).toBe('bias_last:NSE:NIFTY:INTRADAY');
    expect(src('market-bias.ts')).toContain("resultCacheKey.replace('bias_result:', 'bias_last:')");
    expect(V.BIAS_RESULT_CACHE_TTL_SECONDS).toBe(300);
    expect(src('market-bias.ts')).toMatch(/BIAS_RESULT_CACHE_TTL_SECONDS = 5 \* 60/);
    expect(src('fno-scanner.ts')).toContain('fnoScanLastKey(exchange)');
    expect(V.fnoScanLastKey('NSE')).toBe('fno-scanner:last:NSE');
  });

  it('the routes the web terminal calls on mount import no engine, scanner or provider writer', () => {
    for (const f of ['../../api/market-scanner.ts', '../../api/paper-trades.ts', '../../api/fii-dii.ts']) {
      const code = readFileSync(path.join(HERE, f), 'utf-8').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/buildMarketBias|getFnoScan|runMarketScan|noteBiasRequest/);
    }
    const inst = readFileSync(path.join(HERE, '../../api/instruments.ts'), 'utf-8').replace(/\/\/.*$/gm, '');
    expect(inst).not.toMatch(/getFnoScan/);
  });
});

describe('trade marks (display only)', () => {
  it('writes at most once per interval, ignores unusable prices, and reads back', async () => {
    expect(TM.shouldWriteMark(undefined, 1000, 10)).toBe(true);
    expect(TM.shouldWriteMark(1000, 1000 + TM.TRADE_MARK_MIN_INTERVAL_MS - 1, 10)).toBe(false);
    expect(TM.shouldWriteMark(1000, 1000 + TM.TRADE_MARK_MIN_INTERVAL_MS, 10)).toBe(true);
    expect(TM.shouldWriteMark(undefined, 1000, null)).toBe(false);
    expect(TM.shouldWriteMark(undefined, 1000, 0)).toBe(false);
    store.set(TM.tradeMarkKey('a'), JSON.stringify({ premium: 12.5, at: 99 }));
    store.set(TM.tradeMarkKey('b'), 'not json');
    const m = await TM.readTradeMarks(['a', 'b', 'c']);
    expect([...m.keys()]).toEqual(['a']);
    expect(m.get('a')).toEqual({ premium: 12.5, at: 99 });
  });
});

describe('paper trade view', () => {
  const NOW = Date.parse('2026-10-13T11:00:00Z');
  const rec = (over: Record<string, unknown> = {}): any => ({
    id: 't1', symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', generatedAt: Date.parse('2026-10-13T04:30:00Z'), direction: 'BULLISH', confidence: 80,
    structureType: 'NAKED_LONG', strategy: null, legs: null, netPremium: null, maxProfit: null, maxLoss: null, breakeven: null, breakevenLower: null, breakevenUpper: null,
    expiry: '2026-10-20', estimatedCostPct: 4, side: 'CE', strike: 25000, entry: 100, stopLoss: 70, target: 111, riskReward: 0.37, reason: '', regime: null, intelligenceScore: null,
    outcome: 'WIN', exitPrice: 111, exitTime: Date.parse('2026-10-13T05:30:00Z'), returnPercent: 11, generatedOffSession: false, voided: false, logicVersion: null, closeReason: 'TARGET', source: 'INDICATOR',
    ...over,
  });

  it('closed trade: gross and net R use the mint stop and the ESTIMATED cost; no live block', () => {
    const v = PT.buildPaperTradeView(rec(), { now: NOW });
    expect(v.state).toBe('WIN');
    expect(v.status).toBe('CLOSED');
    expect(v.includedInPerformance).toBe(true);
    expect(v.grossR).toBeCloseTo(11 / 30, 3);
    expect(v.estimatedCost).toMatchObject({ pct: 4, basis: 'ESTIMATED_MODEL' });
    expect(v.estimatedCost.costR).toBeCloseTo(4 / 30, 3);
    expect(v.netR).toBeCloseTo(11 / 30 - 4 / 30, 3);
    expect(v.holdMinutes).toBe(60);
    expect(v.live).toBeNull();
    expect(v.strategyLabel).toBe('Indicator Engine');
    expect(v.disclosure).toMatch(/no broker order was placed/);
    expect(v.disclosure).toMatch(/estimates/);
  });

  it('a missing cost % is a labelled DEFAULT_ASSUMPTION, never presented as recorded', () => {
    const v = PT.buildPaperTradeView(rec({ estimatedCostPct: null }), { now: NOW });
    expect(v.estimatedCost.basis).toBe('DEFAULT_ASSUMPTION');
    expect(v.estimatedCost.pct).toBe(3);
  });

  it('open trade: tracked vs untracked is explicit; live premium, age, unrealised R and ₹ come from the monitor mark', () => {
    const open = rec({ outcome: null, exitPrice: null, exitTime: null, returnPercent: null, closeReason: null });
    const tracked = PT.buildPaperTradeView(open, { now: NOW, slot: { signalId: 't1', stopLoss: 90, positionSize: { quantity: 75 }, health: { state: 'HEALTHY', at: NOW - 1000, reason: 'ok' } }, mark: { premium: 106, at: NOW - 12_000 } });
    expect(tracked.status).toBe('OPEN_TRACKED');
    expect(tracked.state).toBe('OPEN');
    expect(tracked.currentStop).toBe(90);
    expect(tracked.live).toMatchObject({ premium: 106, ageSeconds: 12, slotTracked: true, quantity: 75, unrealisedPnlInr: 450 });
    expect(tracked.live!.unrealisedGrossR).toBeCloseTo(6 / 30, 3);
    const untracked = PT.buildPaperTradeView(open, { now: NOW, slot: null, mark: null });
    expect(untracked.status).toBe('OPEN_UNTRACKED');
    expect(untracked.live).toMatchObject({ premium: null, observedAt: null, unrealisedGrossR: null, unrealisedPnlInr: null, slotTracked: false });
  });

  it('voided, lost, off-session and spread trades are explicit and never counted as valid', () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ voided: true }, 'VOIDED', 'VOIDED'],
      [{ voided: true, closeReason: 'TRACKING_LOST', outcome: 'EXPIRED', exitPrice: null }, 'TRACKING_LOST', 'TRACKING_LOST'],
      [{ generatedOffSession: true }, 'OFF_SESSION', 'OFF_SESSION'],
      [{ structureType: 'SPREAD' }, 'SPREAD', 'SPREAD'],
    ];
    for (const [over, status, why] of cases) {
      const v = PT.buildPaperTradeView(rec(over), { now: NOW });
      expect(v.status).toBe(status);
      expect(v.includedInPerformance).toBe(false);
      expect(v.excludedReason).toBeTruthy();
      expect(why).toBeTruthy();
    }
  });

  it('cohort and measurement-reliable flags follow the server configuration', () => {
    expect(PT.buildPaperTradeView(rec({ generatedAt: Date.parse('2026-10-02T05:00:00Z') }), { now: NOW })).toMatchObject({ cohort: 'PRE', measurementReliable: false });
    expect(PT.buildPaperTradeView(rec(), { now: NOW })).toMatchObject({ cohort: 'POST_B', measurementReliable: true });
  });

  it('strategy labels: known engines, trigger families and the legacy badge', () => {
    expect(PT.strategyLabelOf('S1', 'x')).toBe('Structure S1');
    expect(PT.strategyLabelOf('OF1', 'x')).toBe('Order Flow OF1');
    expect(PT.strategyLabelOf('A3', 'x')).toBe('Paper research · A3');
    expect(PT.strategyLabelOf(null, 'Indicator · OLD')).toBe('Indicator · OLD');
  });

  it('GET /api/paper-trades returns the envelope, read-only', async () => {
    const r = await get('/api/paper-trades');
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ trades: [], counts: { total: 0, open: 0 } });
    expect(r.data.measurementReliableFrom).toBe('2026-10-11T18:30:00.000Z');
    expect(r.meta.readOnly).toBe(true);
    noEffects();
  });
});
