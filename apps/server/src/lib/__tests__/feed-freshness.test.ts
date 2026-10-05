// ============================================================
// PHASE 5 — server-side data freshness and gap protection.
//   per-token DATA_FRESH / DATA_STALE / DATA_GAP / RECOVERING on the exchange
//   session calendar (no gaps outside market hours); duplicate and
//   out-of-order ticks dropped by exchange timestamp; partial batches
//   flagged; reconnect → re-subscribe + RECOVERING + gap check; gap checks
//   never assume a fill; auth refresh retried with backoff and alerted.
// ============================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OHLCV, Tick } from '@fno/shared';

vi.mock('../redis.js', () => ({ redis: { set: async () => 'OK', get: async () => null } }));
vi.mock('../oi-baseline.js', () => ({ computeChangeOi: async () => 0 }));
vi.mock('../logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { FeedTracker, resolveGapTouch, FEED_STALE_MS, FEED_GAP_MS } = await import('../feed-freshness.js');
const { SubscriptionManager } = await import('../subscription-manager.js');
const { refreshAuthWithRetry } = await import('../auth-refresh.js');
const { runGapCheck, istMinute } = await import('../../services/feed-gap-check.js');

const ist = (s: string) => Date.parse(`${s}+05:30`);
const MON_11 = ist('2026-10-05T11:00:00'); // Monday, NSE in session
const SUN_11 = ist('2026-10-04T11:00:00'); // Sunday
const tick = (ltp: number, exchangeTimestamp?: number, sequence?: number): Tick => ({ token: '111', exchange: 'NSE', timestamp: 0, ltp, open: 0, high: 0, low: 0, close: 0, volume: 0, exchangeTimestamp, sequence });

afterEach(() => vi.useRealTimers());

describe('FeedTracker — ticks', () => {
  it('drops duplicates and out-of-order ticks by exchange timestamp (then sequence)', () => {
    const f = new FeedTracker();
    f.track('NFO:111', '111', 'NSE');
    expect(f.acceptTick('NFO:111', tick(100, 1000, 5), MON_11).accept).toBe(true);
    expect(f.acceptTick('NFO:111', tick(100, 1000, 5), MON_11)).toEqual({ accept: false, reason: 'DUPLICATE' });
    expect(f.acceptTick('NFO:111', tick(99, 900, 6), MON_11)).toEqual({ accept: false, reason: 'OUT_OF_ORDER' });
    expect(f.acceptTick('NFO:111', tick(101, 1000, 4), MON_11)).toEqual({ accept: false, reason: 'OUT_OF_ORDER' });
    expect(f.acceptTick('NFO:111', tick(101, 1000, 6), MON_11).accept).toBe(true); // same ms, later sequence
    expect(f.acceptTick('NFO:111', tick(102, 1100, 7), MON_11).accept).toBe(true);
    expect(f.summary(MON_11)).toMatchObject({ droppedDuplicates: 1, droppedOutOfOrder: 2 });
    expect(f.get('NFO:111')!.lastTickTime).toBe(1100);
  });

  it('STALE then GAP while silent in session; nothing is due outside the session (no gap on a Sunday or after the close)', () => {
    const f = new FeedTracker();
    f.track('NFO:111', '111', 'NSE');
    f.acceptTick('NFO:111', tick(100, MON_11), MON_11);
    f.evaluate(MON_11 + FEED_STALE_MS - 1);
    expect(f.get('NFO:111')!.state).toBe('DATA_FRESH');
    f.evaluate(MON_11 + FEED_STALE_MS);
    expect(f.get('NFO:111')!.state).toBe('DATA_STALE');
    f.evaluate(MON_11 + FEED_GAP_MS);
    expect(f.get('NFO:111')!.state).toBe('DATA_GAP');
    expect(f.get('NFO:111')!.gapStartedAt).toBe(MON_11);

    const s = new FeedTracker();
    s.track('NFO:111', '111', 'NSE');
    s.acceptTick('NFO:111', tick(100, SUN_11), SUN_11);
    s.evaluate(SUN_11 + 60 * 60_000);
    expect(s.get('NFO:111')!.state).toBe('DATA_FRESH');
    const after = ist('2026-10-05T15:25:00');
    s.acceptTick('NFO:111', tick(100, after), after);
    s.evaluate(ist('2026-10-05T16:30:00'));
    expect(s.get('NFO:111')!.state).toBe('DATA_FRESH');
  });

  it('upstream down → in-session tokens in a gap from their last tick; out-of-session tokens untouched', () => {
    const f = new FeedTracker();
    f.track('NFO:111', '111', 'NSE');
    f.track('MCX:222', '222', 'MCX');
    const early = ist('2026-10-05T08:30:00'); // NSE and MCX both closed
    f.acceptTick('NFO:111', tick(100, early), early);
    f.markUpstreamDown(early);
    expect(f.get('NFO:111')!.state).toBe('DATA_FRESH');
    f.acceptTick('NFO:111', tick(101, MON_11 - 10_000), MON_11 - 10_000);
    f.markUpstreamDown(MON_11);
    expect(f.get('NFO:111')!.state).toBe('DATA_GAP');
    expect(f.get('NFO:111')!.gapStartedAt).toBe(MON_11 - 10_000);
    expect(f.isUpstreamDown()).toBe(true);
  });

  it('back → RECOVERING with the gap to check; a tick never ends RECOVERING, only the gap check does', () => {
    const f = new FeedTracker();
    f.track('NFO:111', '111', 'NSE');
    f.acceptTick('NFO:111', tick(100, MON_11), MON_11);
    f.markUpstreamDown(MON_11 + 1_000);
    const gaps = f.markRecovering(MON_11 + 120_000);
    expect(gaps).toEqual([{ key: 'NFO:111', token: '111', exchange: 'NSE', from: MON_11, to: MON_11 + 120_000 }]);
    expect(f.get('NFO:111')!.state).toBe('RECOVERING');
    f.acceptTick('NFO:111', tick(100.5, MON_11 + 121_000), MON_11 + 121_000);
    expect(f.get('NFO:111')!.state).toBe('RECOVERING');
    f.markRecovered('NFO:111', 'NO_TOUCH', 'nothing', MON_11 + 125_000);
    expect(f.get('NFO:111')!.state).toBe('DATA_FRESH');
    const v = f.view(MON_11 + 125_000)[0];
    expect(v).toMatchObject({ state: 'DATA_FRESH', status: 'OK', asOf: MON_11 + 121_000, source: 'angel-one:ws', lastGapOutcome: { outcome: 'NO_TOUCH' } });
  });
});

describe('resolveGapTouch — never assumes a fill', () => {
  const from = MON_11;
  const to = MON_11 + 5 * 60_000;
  const minute = (k: number, low: number, high: number) => ({ time: from + k * 60_000, open: 100, high, low, close: 100 });
  const levels = [
    { name: 'SL', price: 90, side: 'BELOW' as const },
    { name: 'TARGET', price: 120, side: 'ABOVE' as const },
  ];
  it('NO_TOUCH with every minute covered', () => {
    expect(resolveGapTouch({ bars: [0, 1, 2, 3, 4].map((k) => minute(k, 95, 105)), from, to, levels }).outcome).toBe('NO_TOUCH');
  });
  it('LEVEL_TOUCHED: the first level reached, across minutes, is known', () => {
    const r = resolveGapTouch({ bars: [minute(0, 95, 105), minute(1, 89, 104), minute(2, 95, 125)], from, to, levels });
    expect(r.outcome).toBe('LEVEL_TOUCHED');
    expect(r.level!.name).toBe('SL');
  });
  it('FILL_UNCERTAIN: two levels inside one minute', () => {
    expect(resolveGapTouch({ bars: [minute(0, 95, 105), minute(1, 85, 125)], from, to, levels }).outcome).toBe('FILL_UNCERTAIN');
  });
  it('MISSED_TOUCH_POSSIBLE: missing minutes, or no bars at all', () => {
    expect(resolveGapTouch({ bars: [minute(0, 95, 105), minute(3, 95, 105)], from, to, levels }).outcome).toBe('MISSED_TOUCH_POSSIBLE');
    expect(resolveGapTouch({ bars: [], from, to, levels }).outcome).toBe('MISSED_TOUCH_POSSIBLE');
  });
});

describe('runGapCheck — an open trade after a gap', () => {
  const watch = { underlying: 'NIFTY', exchange: 'NSE' as const, mode: 'INTRADAY', token: '111', stopLoss: 90, target: 120 };
  const bar = (t: number, low: number, high: number): OHLCV => ({ timestamp: new Date(t).toISOString(), open: 100, high, low, close: 100, volume: 0 });
  const gap = { from: MON_11, to: MON_11 + 3 * 60_000 };
  it('sequence established → resolved normally at the level reached first', async () => {
    const closeAt = vi.fn(async () => null);
    const record = vi.fn();
    const r = await runGapCheck({ gap, watch, fetchMinuteBars: async () => [bar(MON_11, 95, 105), bar(MON_11 + 60_000, 89, 100), bar(MON_11 + 120_000, 95, 105)], closeAt, record });
    expect(r.outcome).toBe('LEVEL_TOUCHED');
    expect(closeAt).toHaveBeenCalledWith(90);
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('uncertain / unbackfillable → recorded; the trade is neither closed nor cancelled', async () => {
    const closeAt = vi.fn(async () => null);
    const r1 = await runGapCheck({ gap, watch, fetchMinuteBars: async () => [bar(MON_11, 85, 125)], closeAt, record: () => undefined });
    expect(r1.outcome).toBe('FILL_UNCERTAIN');
    const r2 = await runGapCheck({ gap, watch, fetchMinuteBars: async () => Promise.reject(new Error('rate limited')), closeAt, record: () => undefined });
    expect(r2.outcome).toBe('MISSED_TOUCH_POSSIBLE');
    expect(r2.detail).toMatch(/rate limited/);
    expect(closeAt).not.toHaveBeenCalled();
  });
  it('the window is clamped to the session: minutes after the close are not a gap', async () => {
    const fetch = vi.fn(async () => [] as OHLCV[]);
    const r = await runGapCheck({ gap: { from: ist('2026-10-05T15:28:00'), to: ist('2026-10-05T16:10:00') }, watch, fetchMinuteBars: fetch, closeAt: async () => null, record: () => undefined });
    expect(r.to).toBe(ist('2026-10-05T15:30:00'));
    const night = await runGapCheck({ gap: { from: ist('2026-10-05T16:00:00'), to: ist('2026-10-05T17:00:00') }, watch, fetchMinuteBars: fetch, closeAt: async () => null, record: () => undefined });
    expect(night.outcome).toBe('NO_GAP_IN_SESSION');
  });
  it('the broker time window is IST wall-clock on the exchange calendar, whatever the server zone', () => {
    expect(istMinute(ist('2026-10-05T09:15:00'))).toBe('2026-10-05 09:15');
  });
});

describe('SubscriptionManager — the feed', () => {
  function fakeProvider() {
    const cb: Record<string, any> = {};
    const subscribed: any[][] = [];
    const ws = {
      connected: false,
      connect: async () => void (ws.connected = true),
      disconnect: () => void (ws.connected = false),
      subscribe: (t: any[]) => void subscribed.push(t),
      unsubscribe: () => undefined,
      onTick: (f: any) => void (cb.tick = f),
      onError: (f: any) => void (cb.error = f),
      onDisconnect: (f: any) => void (cb.disconnect = f),
      onReconnect: (f: any) => void (cb.reconnect = f),
      isConnected: () => ws.connected,
      getSubscriptionCount: () => 0,
    };
    return { provider: { createWebSocketConnection: () => ws } as any, cb, subscribed };
  }

  it('drops repeats before any listener sees them, flags partial batches, and recovers through the gap checker', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_11);
    const { provider, cb, subscribed } = fakeProvider();
    const sm = new SubscriptionManager(provider);
    await sm.subscribe('c1', [{ token: '111', exchange: 'NSE', exchangeSegment: 'NSE_FO' }]);
    const seen: number[] = [];
    sm.onTick((ts) => seen.push(...ts.map((t) => t.ltp)));
    await cb.tick([tick(100, MON_11, 1)]);
    await cb.tick([tick(100, MON_11, 1), tick(99, MON_11 - 5_000, 0)], { partial: true });
    expect(seen).toEqual([100]);
    expect(sm.getStatus().feed).toMatchObject({ droppedDuplicates: 1, droppedOutOfOrder: 1, partialBatches: 1 });

    const gaps: any[] = [];
    sm.onRecovering((g) => gaps.push(...g));
    vi.setSystemTime(MON_11 + 30_000);
    cb.disconnect(1006, 'drop');
    expect(sm.feedStateOfToken('111')).toBe('DATA_GAP');
    vi.setSystemTime(MON_11 + 90_000);
    subscribed.length = 0;
    cb.reconnect();
    expect(subscribed[0].map((t: any) => t.token)).toEqual(['111']);
    expect(sm.feedStateOfToken('111')).toBe('RECOVERING');
    expect(gaps).toEqual([{ key: 'NSE_FO:111', token: '111', exchange: 'NSE', from: MON_11, to: MON_11 + 90_000 }]);
    sm.markRecovered('NSE_FO:111', 'NO_TOUCH', 'ok');
    expect(sm.getFeedStates()[0]).toMatchObject({ state: 'DATA_FRESH', status: 'OK' });
    sm.disconnect();
  });
});

describe('auth refresh — retry, alert, reconnect', () => {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  it('retries with exponential backoff and reconnects the feed on success', async () => {
    const sleeps: number[] = [];
    const onSuccess = vi.fn(async () => undefined);
    const alert = vi.fn();
    let n = 0;
    const r = await refreshAuthWithRetry({ attempt: async () => ({ success: ++n === 3 }), onSuccess, alert, log, sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 1000 });
    expect(r).toMatchObject({ success: true, attempts: 3 });
    expect(sleeps).toEqual([1000, 2000]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });
  it('alerts when every attempt fails (and never reconnects)', async () => {
    const onSuccess = vi.fn(async () => undefined);
    const alert = vi.fn();
    const r = await refreshAuthWithRetry({ attempt: async () => ({ success: false, error: 'TOTP rejected' }), onSuccess, alert, log, sleep: async () => undefined, attempts: 3 });
    expect(r).toMatchObject({ success: false, attempts: 3, error: 'TOTP rejected' });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0][0])).toMatch(/failed 3 times/);
  });
});

describe('wiring guards', () => {
  const read = (rel: string) => readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf8');
  it('the price monitor never evaluates a level on a token that is not DATA_FRESH, and gap-checks on recovery', () => {
    const src = read('../../services/trade-setup-monitor.ts');
    const onTicks = src.slice(src.indexOf('function onTicks('));
    expect(onTicks.indexOf("state !== 'DATA_FRESH'")).toBeGreaterThan(0);
    expect(onTicks.indexOf("state !== 'DATA_FRESH'")).toBeLessThan(onTicks.indexOf('checkLockedSetupPriceLevels('));
    expect(src).toMatch(/subscriptions\.onRecovering\(/);
  });
  it('the scheduled re-authentication retries, alerts and reconnects the feed', () => {
    const src = read('../../index.ts');
    expect(src).toMatch(/refreshAuthWithRetry\(\{/);
    expect(src).toMatch(/onSuccess: \(\) => subscriptionManager\.refreshConnection\(\)/);
    expect(src).toMatch(/alert: \(message\) => notifyOperationalAlert\(message\)/);
  });
});
