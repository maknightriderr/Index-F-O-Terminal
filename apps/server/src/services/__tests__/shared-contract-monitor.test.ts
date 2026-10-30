import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Tick } from '@fno/shared';

const f = vi.hoisted(() => ({ kv: new Map<string, string>(), check: vi.fn(), gap: vi.fn(), mark: vi.fn() }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async (k: string) => f.kv.get(k) ?? null, set: async () => 'OK' }, scanKeys: async () => [...f.kv.keys()] }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {} } }));
vi.mock('../market-bias.js', () => ({ checkLockedSetupPriceLevels: f.check, lastBiasComputedAt: () => Date.now(), buildMarketBias: vi.fn() }));
vi.mock('../state-recovery.js', () => ({ sweepLostTrades: async () => 0 }));
vi.mock('../pending-outcomes.js', () => ({ drainPendingOutcomes: async () => undefined }));
vi.mock('../post-exit-tracker.js', () => ({ onPostExitTick() {}, samplePostExitWatches: async () => undefined }));
vi.mock('../trade-costs.js', () => ({ drainPendingCostRecords: async () => undefined }));
vi.mock('../paper-execution-ledger.js', () => ({ observeTick: () => ({}), recordMark: f.mark }));
vi.mock('../../lib/request-priority.js', () => ({ runInteractive: (run: () => unknown) => run() }));
vi.mock('../../lib/service-supervisor.js', () => ({ serviceFailure() {}, TICK_FAILED: Symbol() }));
vi.mock('../feed-gap-check.js', () => ({ istMinute: () => '', runGapCheck: f.gap }));

const instrument = { token: '123', underlying: 'SILVER', exchange: 'MCX', strike: 190000, optionType: 'PE', expiry: '2026-11-27' };
const key = (mode: string) => `trade_setup:MCX:SILVER:${mode}`;
const tick = (ltp: number, exchange = 'MCX') => ({ token: '123', exchange, ltp, timestamp: Date.now() }) as Tick;

async function boot() {
  const m = await import('../trade-setup-monitor.js');
  for (const mode of ['INTRADAY', 'POSITIONAL']) f.kv.set(key(mode), JSON.stringify({ ...instrument, side: 'PE', available: true, stopLoss: mode === 'INTRADAY' ? 90 : 80, target: 120, signalId: mode }));
  let ticks!: (t: Tick[]) => void;
  let gaps!: (g: any[]) => void;
  const subs = { subscribe: vi.fn(async (_client: string, _targets: unknown[]) => undefined), unsubscribe: vi.fn(), onTick: (cb: typeof ticks) => { ticks = cb; }, onRecovering: (cb: typeof gaps) => { gaps = cb; }, feedStateOfToken: vi.fn(() => 'DATA_FRESH'), markRecovered: vi.fn() };
  const provider = { isAuthenticated: () => true, getInstrumentMaster: async () => [instrument] };
  m.startTradeSetupPriceMonitor(provider as never, subs as never);
  await vi.advanceTimersByTimeAsync(0);
  return { m, subs, ticks, gaps };
}

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); f.kv.clear(); f.check.mockReset(); f.gap.mockReset(); f.mark.mockReset();
  f.check.mockImplementation(async (_p, _e, _s, mode) => { f.kv.delete(key(mode)); return null; });
});
afterEach(() => vi.useRealTimers());

describe('two paper trades sharing an option contract', () => {
  it('retains both slots at boot, subscribes once, and records each trade independently', async () => {
    const { m, subs, ticks } = await boot();
    expect(m.watchedSetups().map(w => w.mode)).toEqual(['INTRADAY', 'POSITIONAL']);
    expect(subs.subscribe.mock.calls[0][1]).toHaveLength(1);
    ticks([tick(100)]);
    expect(f.mark.mock.calls.map(c => c[0].signalId)).toEqual(['INTRADAY', 'POSITIONAL']);
    expect(f.check).not.toHaveBeenCalled();
  });
  it('closes each mode at its own stop and retains the subscription until the last closes', async () => {
    const { m, subs, ticks } = await boot();
    ticks([tick(85), tick(85)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(f.check.mock.calls[0][3]).toBe('INTRADAY');
    expect(m.watchedSetups().map(w => w.mode)).toEqual(['POSITIONAL']);
    expect(subs.unsubscribe).not.toHaveBeenCalled();
    ticks([tick(75)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.check.mock.calls[1][3]).toBe('POSITIONAL');
    expect(m.watchedSetups()).toHaveLength(0);
    expect(subs.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('a target tick checks both trades, while another exchange or stale feed checks neither', async () => {
    const { subs, ticks } = await boot();
    ticks([tick(130, 'NSE')]);
    subs.feedStateOfToken.mockReturnValue('DATA_GAP'); ticks([tick(130)]);
    expect(f.check).not.toHaveBeenCalled();
    subs.feedStateOfToken.mockReturnValue('DATA_FRESH'); ticks([tick(130)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.check.mock.calls.map(c => c[3])).toEqual(['INTRADAY', 'POSITIONAL']);
    expect(subs.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('a periodic sweep keeps both watches and does not churn the shared subscription', async () => {
    const { m, subs } = await boot();
    f.check.mockResolvedValue(null); // unavailable quote: falls back to the stored open slot
    await vi.advanceTimersByTimeAsync(45_000);
    expect(m.watchedSetups()).toHaveLength(2);
    expect(subs.subscribe).toHaveBeenCalledTimes(1);
    expect(subs.unsubscribe).not.toHaveBeenCalled();
  });
  it('checks both slots on reconnect before marking the shared feed recovered; preserves uncertainty', async () => {
    const { gaps, subs } = await boot();
    f.gap.mockImplementation(async ({ watch }) => ({ outcome: watch.mode === 'INTRADAY' ? 'NO_TOUCH' : 'FILL_UNCERTAIN', detail: watch.mode }));
    gaps([{ key: 'MCX:123', token: '123', exchange: 'MCX', from: 1, to: 2 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.gap.mock.calls.map(c => c[0].watch.mode)).toEqual(['INTRADAY', 'POSITIONAL']);
    expect(subs.markRecovered).toHaveBeenCalledTimes(1);
    expect(subs.markRecovered.mock.calls[0][1]).toBe('FILL_UNCERTAIN');
  });
});
