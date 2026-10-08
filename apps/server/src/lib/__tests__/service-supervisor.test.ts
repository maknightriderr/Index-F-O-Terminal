// ============================================================
// PHASE 6 — ServiceSupervisor, shutdown order, state recovery rules and the
// request-priority max-wait cap.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../db.js', () => ({ sql: () => undefined }));
vi.mock('../redis.js', () => ({ redis: {}, scanKeys: async () => [] }));
vi.mock('../logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { ServiceSupervisor, TICK_FAILED } = await import('../service-supervisor.js');
const { nextLane, parseMaxWaitMs } = await import('../request-priority.js');
const { RateLimiter } = await import('../rate-limiter.js');
const { reconcileTradeSetup, storedSetupFromSignal, outcomeFromLifecycleRow, tradedKeysFromArbitration, mergeWatchRows } = await import('../../services/state-recovery.js');

/** A manual clock: timers fire only when advanced. */
function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; every: number | null; fn: () => void }>();
  const add = (fn: () => void, ms: number, every: boolean) => {
    const h = ++id;
    timers.set(h, { at: now + ms, every: every ? ms : null, fn });
    return h;
  };
  return {
    clock: {
      now: () => now,
      setInterval: (fn: () => void, ms: number) => add(fn, ms, true),
      clearInterval: (h: number) => void timers.delete(h),
      setTimeout: (fn: () => void, ms: number) => add(fn, ms, false),
      clearTimeout: (h: number) => void timers.delete(h),
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [h, t] = due;
        now = t.at;
        if (t.every != null) t.at += t.every;
        else timers.delete(h);
        t.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = end;
    },
    count: () => timers.size,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('ServiceSupervisor', () => {
  it('captures a service\'s timers (incl. an interval set by its delayed first tick), heartbeats on every completed run, stops them all', async () => {
    const fc = fakeClock();
    const sup = new ServiceSupervisor({ clock: fc.clock });
    let ticks = 0;
    sup.register({
      name: 'job', critical: false, startupTimeoutMs: 1000, heartbeatIntervalMs: 0, kind: 'TIMER',
      start: () => {
        setTimeout(() => {
          ticks++;
          setInterval(() => void ticks++, 60_000);
        }, 5_000);
      },
    });
    await sup.startAll(30_000);
    expect(sup.snapshot()[0]).toMatchObject({ state: 'RUNNING', timers: 1 });
    await fc.advance(5_000);
    expect(ticks).toBe(1);
    expect(sup.snapshot()[0]).toMatchObject({ timers: 1, heartbeatIntervalMs: 60_000, lastSuccessAt: 5_000 });
    await fc.advance(120_000);
    expect(ticks).toBe(3);
    sup.stopAll();
    expect(fc.count()).toBe(0);
    expect(sup.snapshot()[0].state).toBe('STOPPED');
    await fc.advance(600_000);
    expect(ticks).toBe(3);
  });

  it('consecutive failures → FAILED → controlled restart with exponential backoff → RUNNING; gives up after maxRestarts', async () => {
    const fc = fakeClock();
    const sup = new ServiceSupervisor({ clock: fc.clock, failureThreshold: 2, maxRestarts: 2, backoffBaseMs: 1_000 });
    let fail = true;
    sup.register({
      name: 'flaky', critical: true, startupTimeoutMs: 1000, heartbeatIntervalMs: 0, kind: 'TIMER',
      start: () => void setInterval(() => {
        if (fail) throw new Error('boom');
      }, 10_000),
    });
    await sup.startAll(1e9);
    await fc.advance(10_000);
    expect(sup.snapshot()[0].state).toBe('DEGRADED');
    expect(sup.degradedCritical().map((s) => s.name)).toEqual(['flaky']);
    await fc.advance(10_000);
    expect(sup.snapshot()[0].state).toBe('RESTARTING');
    await fc.advance(1_000); // backoff 1 s
    expect(sup.snapshot()[0]).toMatchObject({ state: 'RUNNING', restarts: 1, timers: 1 });
    fail = false;
    await fc.advance(10_000);
    expect(sup.snapshot()[0]).toMatchObject({ state: 'RUNNING', consecutiveFailures: 0 });
    expect(sup.degradedCritical()).toEqual([]);
    fail = true;
    await fc.advance(20_000);
    await fc.advance(2_000); // backoff 2 s
    expect(sup.snapshot()[0].restarts).toBe(2);
    await fc.advance(20_000);
    expect(sup.snapshot()[0].state).toBe('FAILED'); // restart limit reached
  });

  it('a run that reported its own failure (TICK_FAILED) is not a heartbeat', async () => {
    const fc = fakeClock();
    const sup = new ServiceSupervisor({ clock: fc.clock });
    sup.register({ name: 'm', critical: true, startupTimeoutMs: 1000, heartbeatIntervalMs: 0, kind: 'TIMER', start: () => void setInterval(() => Promise.resolve(TICK_FAILED), 1_000) });
    await sup.startAll(1e9);
    await fc.advance(1_000);
    await flush();
    expect(sup.snapshot()[0].lastSuccessAt).toBeNull();
  });

  it('missed heartbeats: late → DEGRADED, silent → FAILED; not expected while inactive (out of session)', async () => {
    const fc = fakeClock();
    const sup = new ServiceSupervisor({ clock: fc.clock, backoffBaseMs: 1e9 });
    let active = true;
    sup.register({ name: 'signalEngine', critical: true, startupTimeoutMs: 1000, heartbeatIntervalMs: 60_000, kind: 'COMPONENT', start: () => undefined, activeWhen: () => active });
    await sup.startAll(10_000);
    sup.heartbeat('signalEngine');
    await fc.advance(130_000);
    expect(sup.snapshot()[0].state).toBe('DEGRADED');
    sup.heartbeat('signalEngine');
    expect(sup.snapshot()[0].state).toBe('RUNNING');
    active = false;
    await fc.advance(600_000);
    expect(sup.snapshot()[0].state).toBe('RUNNING');
    active = true;
    await fc.advance(10_000);
    expect(sup.snapshot()[0].state).toBe('RESTARTING'); // > 4 intervals silent → FAILED → restart pending
  });

  it('a start that does not complete within its startup timeout FAILS', async () => {
    const fc = fakeClock();
    const sup = new ServiceSupervisor({ clock: fc.clock, backoffBaseMs: 1e9 });
    sup.register({ name: 'slow', critical: false, startupTimeoutMs: 1_000, heartbeatIntervalMs: 0, kind: 'TIMER', start: () => new Promise(() => undefined) });
    const p = sup.startAll(1e9);
    await flush();
    await fc.advance(1_000);
    await p;
    expect(sup.snapshot()[0].lastError).toMatch(/within 1000 ms/);
    expect(['FAILED', 'RESTARTING']).toContain(sup.snapshot()[0].state);
  });
});

describe('boot registrations and shutdown order (index.ts)', () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.ts'), 'utf8');
  const EXISTING = [
    'alertScanner', 'patternScanner', 'institutionalFlowScanner', 'tradeSetupPriceMonitor', 'marketScanner', 'fiiDiiTracker', 'abandonedSetupSweep', 'oiCloseSnapshot', 'cacheWarmer',
    'strategyTracker', 'positionalStockScan', 'backgroundBiasEvaluator', 'marketStateCapture', 'missedWinnerAudit', 'setupEventsGrading', 'opportunityCensus', 'holidayCalendarCheck', 'systemLearningAudit',
  ];
  it('registers exactly the 18 existing services, plus three justified COMPONENT extras', () => {
    const timer = [...src.matchAll(/timerService\('(\w+)'/g)].map((m) => m[1]);
    expect(timer).toEqual(EXISTING);
    expect(new Set(timer).size).toBe(18);
    const components = [...src.matchAll(/name: '(\w+)', critical: (true|false)[^\n]*kind: 'COMPONENT'/g)].map((m) => m[1]);
    expect(components).toEqual(['signalEngine', 'setupLifecycle', 'orderFlowFeed']);
    expect((src.match(/note: 'Extra:/g) ?? []).length).toBe(3);
    // No start*() is called outside the supervisor any more.
    for (const n of EXISTING) {
      const fn = `start${n[0].toUpperCase()}${n.slice(1)}(`;
      expect(src.split(fn).length - 1, fn).toBe(1);
    }
  });
  it('critical set: tradeSetupPriceMonitor, signalEngine, setupLifecycle', () => {
    expect(src).toMatch(/timerService\('tradeSetupPriceMonitor'[^\n]*critical: true/);
    expect(src).toMatch(/name: 'signalEngine', critical: true/);
    expect(src).toMatch(/name: 'setupLifecycle', critical: true/);
    expect((src.match(/critical: true/g) ?? []).length).toBe(3);
  });
  it('shutdown: supervisor + timers, then server.close, WS disconnect, logout, sql.end, redis.disconnect', () => {
    const body = src.slice(src.indexOf('const shutdown = async'));
    const order = ['serviceSupervisor.stopAll()', 'server.close(', 'subscriptionManager.disconnect()', 'provider.logout()', 'sql.end(', 'redis.disconnect()'].map((s) => body.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('health is DEGRADED while a critical service is not RUNNING; Redis is rebuilt from PostgreSQL before the monitor starts', () => {
    expect(src).toMatch(/supervisor\.degradedCritical\.length === 0/);
    expect(src).toMatch(/timerService\('tradeSetupPriceMonitor'[^\n]*ready: \(\) => recoveryReady/);
    expect(src).toMatch(/rehydrateFromPostgres\(\)/);
  });
});

describe('state recovery — PostgreSQL wins', () => {
  const row = { id: 'S1', time: '2026-10-05T05:00:00Z', symbol: 'NIFTY', direction: 'BULLISH', reasoning: 'r', inputs: { exchange: 'NSE', mode: 'INTRADAY', side: 'CE', strike: 25000, entry: 100, stopLoss: 70, target: 160, expiry: '2026-10-07' } };
  it('rebuilds the sticky setup from the PG row, with the recorded trailing stop', () => {
    expect(storedSetupFromSignal(row, 100)).toMatchObject({ signalId: 'S1', available: true, strike: 25000, stopLoss: 100, initialStopLoss: 70, day: '2026-10-05', rehydratedFrom: 'POSTGRES' });
    expect(storedSetupFromSignal(row, null).stopLoss).toBe(70);
  });
  it('missing → written; agreeing → kept; disagreeing → PG fields win; closed in PG → removed; unrecorded cache → kept', () => {
    const pg = storedSetupFromSignal(row, null);
    expect(reconcileTradeSetup({ pg, pgHasTsl: false, redis: null, closedInPg: new Set() }).action).toBe('WRITE');
    const cache = { ...pg, reversalStreak: 1, structure: { lifecycleId: 'L' } };
    expect(reconcileTradeSetup({ pg, pgHasTsl: false, redis: cache, closedInPg: new Set() }).action).toBe('KEEP');
    const r = reconcileTradeSetup({ pg, pgHasTsl: false, redis: { ...cache, target: 999 }, closedInPg: new Set() });
    expect(r).toMatchObject({ action: 'WRITE' });
    if (r.action === 'WRITE') expect(r.value).toMatchObject({ target: 160, reversalStreak: 1, structure: { lifecycleId: 'L' } });
    // A trailing stop only when PG recorded one: a trade minted before plans keeps its cached stop.
    expect(reconcileTradeSetup({ pg, pgHasTsl: false, redis: { ...cache, stopLoss: 95 }, closedInPg: new Set() }).action).toBe('KEEP');
    expect(reconcileTradeSetup({ pg: storedSetupFromSignal(row, 100), pgHasTsl: true, redis: { ...cache, stopLoss: 95 }, closedInPg: new Set() }).action).toBe('WRITE');
    expect(reconcileTradeSetup({ pg: null, pgHasTsl: false, redis: { ...cache, signalId: 'OLD' }, closedInPg: new Set(['OLD']) }).action).toBe('DELETE');
    expect(reconcileTradeSetup({ pg, pgHasTsl: false, redis: { ...cache, signalId: 'OLD' }, closedInPg: new Set(['OLD']) }).action).toBe('WRITE');
    expect(reconcileTradeSetup({ pg, pgHasTsl: false, redis: { ...cache, signalId: undefined }, closedInPg: new Set() }).action).toBe('KEEP');
    // A setup minted without structureType is a naked long — not a disagreement.
    expect(reconcileTradeSetup({ pg, pgHasTsl: false, redis: { ...cache, structureType: undefined }, closedInPg: new Set() }).action).toBe('KEEP');
  });
  it('structure outcomes, traded parents and watch rows from their PG rows', () => {
    expect(outcomeFromLifecycleRow({ to_state: 'ENTRY_REFUSED', reason: 'PARENT_ALREADY_TRADED: one trade per parent', time: '2026-10-05T05:00:00Z', decision_id: null, signal_id: null })).toMatchObject({ outcome: 'REFUSED', code: 'PARENT_ALREADY_TRADED', reason: 'one trade per parent' });
    expect(outcomeFromLifecycleRow({ to_state: 'ENTRY_MINTED', reason: 'Filled', time: 0 as any, decision_id: 'D', signal_id: 'S' })).toMatchObject({ outcome: 'MINTED', code: null, signalId: 'S' });
    const traded = tradedKeysFromArbitration([
      { exchange: 'NSE', instrument: 'NIFTY', context: { slotArbitration: { role: 'SELECTED', slotDecision: { decision: 'MINTED' }, anchorKeys: ['P:a', 'SWEEP:1'] } } },
      { exchange: 'NSE', instrument: 'NIFTY', context: { slotArbitration: { role: 'SELECTED', slotDecision: { decision: 'MINT_LOST' }, anchorKeys: ['P:b'] } } },
      { exchange: 'NSE', instrument: 'NIFTY', context: { slotArbitration: { role: 'ALTERNATIVE', anchorKeys: ['P:c'] } } },
      { exchange: 'NSE', instrument: 'NIFTY', context: { slotArbitration: { role: 'SELECTED', anchorKeys: ['P:old'] } } }, // pre-Phase-4 row
    ]);
    expect(traded.get('NSE:NIFTY')).toEqual(['P:a', 'P:old', 'SWEEP:1']);
    const w = (id: string, status: 'CONFIRMED' | 'ENDED') => ({ id, status }) as any;
    const m = mergeWatchRows([w('a', 'ENDED'), w('b', 'CONFIRMED')], { a: w('a', 'CONFIRMED'), c: w('c', 'CONFIRMED') });
    expect(m.changed.sort()).toEqual(['a', 'b']);
    expect(m.rows).toMatchObject({ a: { status: 'ENDED' }, b: { status: 'CONFIRMED' }, c: { status: 'CONFIRMED' } });
  });
});

describe('request priority — interactive first, with a max-wait cap', () => {
  it('serves interactive first unless the oldest background request has waited past the cap', () => {
    expect(nextLane({ highWaiting: 1, normalWaiting: 1, oldestNormalEnqueuedAt: 0, now: 29_999, maxWaitMs: 30_000 })).toBe('high');
    expect(nextLane({ highWaiting: 1, normalWaiting: 1, oldestNormalEnqueuedAt: 0, now: 30_000, maxWaitMs: 30_000 })).toBe('normal');
    expect(nextLane({ highWaiting: 0, normalWaiting: 2, oldestNormalEnqueuedAt: 0, now: 1, maxWaitMs: 30_000 })).toBe('normal');
    expect(nextLane({ highWaiting: 0, normalWaiting: 0, oldestNormalEnqueuedAt: null, now: 1 })).toBeNull();
    expect(parseMaxWaitMs('5000')).toBe(5000);
    expect(parseMaxWaitMs('x')).toBe(30_000);
    expect(parseMaxWaitMs(undefined)).toBe(30_000);
  });
  it('the limiter promotes a starved background request ahead of a stream of interactive ones', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const lim = new RateLimiter(1, undefined, 3_000);
      await lim.acquire('normal'); // takes the only token
      const order: string[] = [];
      void lim.acquire('normal').then(() => order.push('bg'));
      for (let k = 0; k < 6; k++) void lim.acquire('high').then(() => order.push(`ui${k}`));
      await vi.advanceTimersByTimeAsync(6_000);
      expect(order.indexOf('bg')).toBeGreaterThan(-1);
      expect(order.indexOf('bg')).toBeLessThan(order.length - 1);
      expect(order.slice(0, 2)).toEqual(['ui0', 'ui1']);
    } finally {
      vi.useRealTimers();
    }
  });
});
