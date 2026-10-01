// ============================================================
// TRIGGER ROUTER (live) — records every candidate once with its parent, hands
// the slot EVERY eligible paper-stage candidate of the bar that just closed
// (no pre-selection), returns the parent linkage, and evaluates each closed
// bar once.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MomentumBar } from '@fno/analytics';

const store = new Map<string, string>();
vi.mock('../../lib/redis.js', () => ({
  redis: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
  },
}));
const recorded: any[] = [];
vi.mock('../../services/setup-events.js', () => ({ recordSetupEvent: (e: any) => recorded.push(e) }));

const { routeTriggerFamilies } = await import('../../services/trigger-router.js');

const M15 = 15 * 60 * 1000;
const ist = (s: string) => Date.parse(`${s}+05:30`);
const session = (date: string, path: Array<[number, number, number, number]>): MomentumBar[] =>
  path.map(([open, high, low, close], k) => ({ time: ist(`${date}T09:15:00`) + k * M15, open, high, low, close, volume: 0 }));
const quiet = (date: string) =>
  session(
    date,
    Array.from({ length: 25 }, (_, k) => {
      const o = 100 + ((k % 4) - 1.5) * 2;
      const c = 100 + (((k + 1) % 4) - 1.5) * 2;
      return [o, Math.max(o, c) + 4, Math.min(o, c) - 4, c] as [number, number, number, number];
    })
  );
const days = Array.from({ length: 22 }, (_, k) => new Date(Date.parse('2026-07-15T12:00:00Z') + k * 86_400_000).toISOString().slice(0, 10));
const today = session('2026-08-10', [
  [100, 104, 96, 102],
  [102, 106, 99, 104],
  [104, 107, 101, 105],
  [105, 112, 103, 104],
  [104, 105, 100, 101],
  [101, 103, 98, 102],
  [102, 104, 99, 100],
  [100, 101, 94, 95],
]);
const bars = [...days.flatMap(quiet), ...today];

describe('routeTriggerFamilies', () => {
  beforeEach(() => {
    store.clear();
    recorded.length = 0;
  });

  it('records every candidate (with risk, timing, move potential and parent) and hands the slot every eligible one of the newest bar', async () => {
    const out = await routeTriggerFamilies({ underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars, chain: null, now: ist('2026-08-10T11:20:00') });
    const a2 = recorded.find((r) => r.triggerType === 'A2');
    expect(a2).toBeDefined();
    expect(a2).toMatchObject({ toStage: 'CANDIDATE', direction: 'BEARISH', instrument: 'NIFTY' });
    expect(a2.context.stage).toBe('PAPER_RESEARCH');
    expect(a2.context.risk).toHaveProperty('wouldTrade');
    expect(a2.context.timing).toHaveProperty('class');
    expect(a2.context.movePotential).toHaveProperty('class');
    expect(a2.versions.triggerVersion).toBe('A2-1.0');
    // Recorded at the decision bar's close, never earlier.
    expect(a2.time.getTime()).toBe(today[7].time + M15);
    // Observation arbitration (research view) is unchanged: no parent has two selected setups.
    expect(a2.context.arbitration).toHaveProperty('parentId');
    const selectedPerParent = new Map<string, number>();
    for (const r of recorded) if (r.context.arbitration?.role === 'SELECTED') selectedPerParent.set(r.context.arbitration.parentId, (selectedPerParent.get(r.context.arbitration.parentId) ?? 0) + 1);
    for (const n of selectedPerParent.values()) expect(n).toBe(1);
    // Trading: no pre-selection in the router. Each candidate carries its parent
    // and anchor keys; the slot receives every eligible paper-stage candidate of
    // the newest bar. The risk controls still bind: every candidate in this
    // session has T1 under 1.5R, so none is eligible and none reaches the slot.
    for (const r of recorded) {
      expect(r.context.bucket, r.triggerType).toBe('LOW_RR');
      expect(r.context.trade.parentId, r.triggerType).toBe(r.context.arbitration.parentId);
      expect(r.context.trade.anchorKeys[0]).toBe(r.context.trade.parentId);
      expect(r.context.trade.eligible, r.triggerType).toBe(false);
      expect(r.context.trade.handedToSlot, r.triggerType).toBe(false);
    }
    expect(out!.paper).toEqual([]);
    // The parent linkage S1 joins through: today's sweep of the previous high (bar 3), BEARISH.
    expect(out!.linkage?.sweeps.some((w) => w.direction === 'BEARISH' && w.time === today[3].time)).toBe(true);
  });

  it('a check with no new bar still returns the linkage written at the last evaluation', async () => {
    const first = await routeTriggerFamilies({ underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars, chain: null, now: ist('2026-08-10T11:20:00') });
    const again = await routeTriggerFamilies({ underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars, chain: null, now: ist('2026-08-10T11:25:00') });
    expect(again?.evaluated).toBe(0);
    expect(again?.linkage).toEqual(first?.linkage);
  });

  it('evaluates each closed bar once: a second poll on the same bars records nothing new', async () => {
    await routeTriggerFamilies({ underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars, chain: null, now: ist('2026-08-10T11:20:00') });
    const first = recorded.length;
    const again = await routeTriggerFamilies({ underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars, chain: null, now: ist('2026-08-10T11:25:00') });
    expect(again?.evaluated).toBe(0);
    expect(recorded.length).toBe(first);
  });

  it('does nothing for POSITIONAL, a stale session, or too little history', async () => {
    expect(await routeTriggerFamilies({ underlying: 'NIFTY', exchange: 'NSE', mode: 'POSITIONAL', bars, chain: null, now: ist('2026-08-10T11:20:00') })).toEqual({ paper: [], evaluated: 0 });
    expect(await routeTriggerFamilies({ underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars, chain: null, now: ist('2026-08-11T11:20:00') })).toEqual({ paper: [], evaluated: 0 });
    expect(await routeTriggerFamilies({ underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars: today, chain: null, now: ist('2026-08-10T11:20:00') })).toEqual({ paper: [], evaluated: 0 });
    expect(recorded).toEqual([]);
  });
});
