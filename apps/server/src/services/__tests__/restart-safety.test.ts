// ============================================================
// REL-1 (audit 2026-10-18): a restart in session left open trades without live ticks for 4-16 minutes.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mem = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock('../../lib/redis.js', () => ({
  redis: { get: async (k: string) => mem.kv.get(k) ?? null },
  scanKeys: async (p: string) => [...mem.kv.keys()].filter((k) => k.startsWith(p.replace('*', ''))),
}));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../market-bias.js', () => ({ buildMarketBias: async () => ({}), checkLockedSetupPriceLevels: async () => null, lastBiasComputedAt: () => undefined }));
vi.mock('../state-recovery.js', () => ({ sweepLostTrades: async () => 0 }));
vi.mock('../pending-outcomes.js', () => ({ drainPendingOutcomes: async () => ({ applied: 0, remaining: 0 }) }));
vi.mock('../post-exit-tracker.js', () => ({ onPostExitTick: () => undefined, samplePostExitWatches: async () => undefined }));
vi.mock('../trade-costs.js', () => ({ drainPendingCostRecords: async () => undefined }));
vi.mock('../feed-gap-check.js', () => ({ istMinute: () => '', runGapCheck: async () => undefined }));

const M = await import('../trade-setup-monitor.js');

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (f: string) => readFileSync(path.join(SERVER, f), 'utf8');

const instruments = [
  { token: '580629', underlying: 'CRUDEOIL', exchange: 'MCX', strike: 8950, optionType: 'PE', expiry: '2026-11-17' },
  { token: '580601', underlying: 'CRUDEOIL', exchange: 'MCX', strike: 8950, optionType: 'CE', expiry: '2026-11-17' },
  { token: '43210', underlying: 'TCS', exchange: 'NSE', strike: 2440, optionType: 'CE', expiry: '2026-10-27' },
] as never[];

describe('tokenForStoredSetup (pure)', () => {
  it('finds the exact contract (strike, side, expiry) without a quote call', () => {
    expect(M.tokenForStoredSetup(instruments, 'CRUDEOIL', 'MCX', { strike: 8950, side: 'PE', expiry: '2026-11-17' })).toBe('580629');
    expect(M.tokenForStoredSetup(instruments, 'TCS', 'NSE', { strike: 2440, side: 'CE', expiry: '2026-10-27' })).toBe('43210');
  });
  it('a spread, a missing field or an unknown contract is null', () => {
    expect(M.tokenForStoredSetup(instruments, 'CRUDEOIL', 'MCX', { structureType: 'SPREAD', strike: 8950, side: 'PE', expiry: '2026-11-17' })).toBeNull();
    expect(M.tokenForStoredSetup(instruments, 'CRUDEOIL', 'MCX', { strike: 8950, side: 'PE', expiry: '2026-12-16' })).toBeNull();
    expect(M.tokenForStoredSetup(instruments, 'CRUDEOIL', 'MCX', { strike: 8950, side: null, expiry: '2026-11-17' })).toBeNull();
    expect(M.tokenForStoredSetup(instruments, 'CRUDEOIL', 'MCX', null)).toBeNull();
  });
});

describe('a price check that could not price an open trade keeps its tick watch (fix 2026-10-21)', () => {
  beforeEach(() => mem.kv.clear());
  const provider = { isAuthenticated: () => true, getInstrumentMaster: async () => instruments } as never;
  it('still open: watched from its slot and the instrument master', async () => {
    mem.kv.set('trade_setup:NSE:TCS:INTRADAY', JSON.stringify({ available: true, strike: 2440, side: 'CE', expiry: '2026-10-27', stopLoss: 23.54, target: 86.16 }));
    expect(await M.watchForOpenSlot(provider, 'NSE', 'TCS', 'INTRADAY')).toEqual({ underlying: 'TCS', exchange: 'NSE', mode: 'INTRADAY', token: '43210', stopLoss: 23.54, target: 86.16 });
  });
  it('closed, gone, a spread or an unknown contract: no watch, as before', async () => {
    mem.kv.set('trade_setup:NSE:NIFTY:INTRADAY', JSON.stringify({ available: false, strike: 2440, side: 'CE', expiry: '2026-10-27', stopLoss: 1, target: 2 }));
    mem.kv.set('trade_setup:NSE:BANKNIFTY:INTRADAY', JSON.stringify({ available: true, structureType: 'SPREAD', stopLoss: 1, target: 2 }));
    mem.kv.set('trade_setup:MCX:CRUDEOIL:INTRADAY', JSON.stringify({ available: true, strike: 9000, side: 'PE', expiry: '2026-11-17', stopLoss: 1, target: 2 }));
    expect(await M.watchForOpenSlot(provider, 'NSE', 'NIFTY', 'INTRADAY')).toBeNull();
    expect(await M.watchForOpenSlot(provider, 'NSE', 'BANKNIFTY', 'INTRADAY')).toBeNull();
    expect(await M.watchForOpenSlot(provider, 'MCX', 'CRUDEOIL', 'INTRADAY')).toBeNull();
    expect(await M.watchForOpenSlot(provider, 'NSE', 'SBIN', 'INTRADAY')).toBeNull();
  });
  it('the sweep falls back to the slot only when the price check returned no watch', () => {
    expect(read('src/services/trade-setup-monitor.ts')).toMatch(/\(await checkLockedSetupPriceLevels\(provider, exchange as Exchange, underlying, mode\)\) \?\? \(await watchForOpenSlot\(provider, exchange, underlying, mode\)\)/);
  });
});

describe('boot subscription, before the first sweep', () => {
  beforeEach(() => mem.kv.clear());
  it('subscribes every open naked trade from its slot once the broker session is up; skips closed slots and spreads', async () => {
    mem.kv.set('trade_setup:MCX:CRUDEOIL:POSITIONAL', JSON.stringify({ available: true, strike: 8950, side: 'PE', expiry: '2026-11-17', stopLoss: 200, target: 380 }));
    mem.kv.set('trade_setup:NSE:TCS:POSITIONAL', JSON.stringify({ available: true, strike: 2440, side: 'CE', expiry: '2026-10-27', stopLoss: 23.54, target: 86.16 }));
    mem.kv.set('trade_setup:NSE:NIFTY:INTRADAY', JSON.stringify({ available: false }));
    mem.kv.set('trade_setup:NSE:BANKNIFTY:INTRADAY', JSON.stringify({ available: true, structureType: 'SPREAD', stopLoss: 1, target: 2 }));
    let authed = false;
    setTimeout(() => (authed = true), 30);
    const provider = { isAuthenticated: () => authed, getInstrumentMaster: async () => instruments } as never;
    const subscribed: unknown[] = [];
    const subs = { subscribe: async (_c: string, t: unknown[]) => void subscribed.push(...t), unsubscribe: () => undefined } as never;
    expect(await M.primeSubscriptions(provider, subs, 2_000, 10)).toBe(2);
    expect(subscribed).toEqual([
      { token: '580629', exchange: 'MCX', exchangeSegment: 'MCX_FO' },
      { token: '43210', exchange: 'NSE', exchangeSegment: 'NSE_FO' },
    ]);
  });
  it('no broker session within the wait: nothing subscribed (the first sweep does it, as before)', async () => {
    mem.kv.set('trade_setup:NSE:TCS:POSITIONAL', JSON.stringify({ available: true, strike: 2440, side: 'CE', expiry: '2026-10-27', stopLoss: 23.54, target: 86.16 }));
    const provider = { isAuthenticated: () => false, getInstrumentMaster: async () => instruments } as never;
    const subs = { subscribe: async () => { throw new Error('must not subscribe'); }, unsubscribe: () => undefined } as never;
    expect(await M.primeSubscriptions(provider, subs, 30, 10)).toBe(0);
  });
});

describe('wiring', () => {
  const index = read('src/index.ts');
  it('the monitor primes at start and runs its price checks in the interactive lane', () => {
    const mon = read('src/services/trade-setup-monitor.ts');
    expect(mon).toMatch(/void primeSubscriptions\(provider, subscriptions\);/);
    expect(mon).toMatch(/await runInteractive\(\(\) => sweep\(provider, subscriptions\)\)/);
    expect(mon).toMatch(/runInteractive\(\(\) => checkLockedSetupPriceLevels\(provider, watch\.exchange, watch\.underlying, watch\.mode, tick\.ltp\)\)/);
  });
  it('after a boot in session the scanners, decision timers and archive wait; the monitor and DB-only jobs do not', () => {
    for (const n of ['alertScanner', 'patternScanner', 'institutionalFlowScanner', 'marketScanner', 'oiCloseSnapshot', 'cacheWarmer', 'strategyTracker', 'positionalStockScan', 'backgroundBiasEvaluator', 'marketStateCapture', 'missedWinnerAudit', 'setupEventsGrading', 'opportunityCensus', 'barArchive']) {
      expect(index, n).toMatch(new RegExp(`timerService\\('${n}'[^\\n]*held\\(`));
    }
    for (const n of ['tradeSetupPriceMonitor', 'abandonedSetupSweep', 'fiiDiiTracker', 'recordReconciliation', 'dailyReview']) {
      expect(index, n).not.toMatch(new RegExp(`timerService\\('${n}'[^\\n]*held\\(`));
    }
    expect(index).toMatch(/const BOOT_HOLD_MS = 5 \* 60_000;/);
    expect(index).toMatch(/const bootHold: Promise<void> = anySession\(Date\.now\(\)\)/);
  });
  it('Railway waits for /api/health/ready (DB, Redis, schema) — never for the broker feed — and it is public', async () => {
    const railway = JSON.parse(read('../../railway.json'));
    expect(railway.deploy.healthcheckPath).toBe('/api/health/ready');
    expect(railway.deploy.healthcheckTimeout).toBeGreaterThanOrEqual(120);
    const route = index.slice(index.indexOf("app.get('/api/health/ready'"), index.indexOf("app.get('/api/health/ready'") + 600);
    expect(route).toMatch(/const ready = redisHealth\.healthy && dbHealth\.healthy && schemaChecked;/);
    expect(route).toMatch(/res\.status\(ready \? 200 : 503\)/);
    expect(index).toMatch(/void schemaReady\.then\(\(\) => \{\s+schemaChecked = true;/);
    const { PUBLIC_ROUTES } = await import('../../lib/api-auth.js');
    expect(PUBLIC_ROUTES.has('GET /api/health/ready')).toBe(true);
  });
});
