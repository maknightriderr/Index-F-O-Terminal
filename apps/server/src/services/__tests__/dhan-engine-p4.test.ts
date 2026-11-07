// Dhan engine v2, phase 4: an external (DHAN_*) candidate goes through the same adapter / store path as a fresh-start
// entry, and only when entries are armed.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/redis.js', () => ({ scanKeys: vi.fn(async () => []) }));
import { FreshRuntime } from '../fresh-start/runtime.js';

const c = () => ({ id: 'dhan-1', at: Date.now(), expiresAt: Date.now() + 20000, origin: Date.now(), strategy: 'DHAN_A_SWEEP_ABSORPTION' }) as any;
const parts = (enter = vi.fn(async () => ({ ok: true, code: 'FILLED' }))) => {
  const store = { recover: vi.fn(async () => []), observe: vi.fn(), enter };
  const adapter = { qualified: true, build: vi.fn(), prepare: vi.fn(async (x: any) => ({ candidate: x, netRR: 2, finish: vi.fn(async () => ({ candidate: x })) })), watch: vi.fn(async () => {}), audit: vi.fn(async () => {}), decision: vi.fn(async () => {}) };
  return { store, adapter };
};

describe('FreshRuntime.onExternalCandidate', () => {
  it('prices through adapter.prepare, enters through the store and attaches the watch', async () => {
    const { store, adapter } = parts();
    const rt = new FreshRuntime(store as any, adapter as any, () => true);
    await rt.recover();
    const cand = c();
    expect(await rt.onExternalCandidate(cand)).toBe('FILLED');
    expect(adapter.prepare).toHaveBeenCalledWith(cand);
    expect(store.enter).toHaveBeenCalledOnce();
    expect(adapter.watch).toHaveBeenCalledTimes(2); // recovery + after the fill
  });
  it('records the store refusal as a decision', async () => {
    const { store, adapter } = parts(vi.fn(async () => ({ ok: false, code: 'INSUFFICIENT_CASH' })));
    const rt = new FreshRuntime(store as any, adapter as any, () => true);
    await rt.recover();
    const cand = c();
    expect(await rt.onExternalCandidate(cand)).toBe('INSUFFICIENT_CASH');
    expect(adapter.decision).toHaveBeenCalledWith(cand, 'INSUFFICIENT_CASH');
  });
  it('never enters while paper entries are not armed, or before recovery', async () => {
    const { store, adapter } = parts();
    expect(await new FreshRuntime(store as any, adapter as any, () => false).onExternalCandidate(c())).toBe('PAPER_DISABLED');
    expect(await new FreshRuntime(store as any, adapter as any, () => true).onExternalCandidate(c())).toBe('BLOCKED_QUALIFIED_ADAPTER');
    expect(adapter.prepare).not.toHaveBeenCalled();
  });
  it('returns NO_ELIGIBLE_ENTRY when the adapter finds no contract', async () => {
    const { store, adapter } = parts();
    adapter.prepare = vi.fn(async () => null) as any;
    const rt = new FreshRuntime(store as any, adapter as any, () => true);
    await rt.recover();
    expect(await rt.onExternalCandidate(c())).toBe('NO_ELIGIBLE_ENTRY');
    expect(store.enter).not.toHaveBeenCalled();
  });
});
