// ============================================================
// MOMENTUM-BREAK IN THE SLOT ARBITRATION (2026-10-05)
// ============================================================
// A momentum break is one more candidate: evaluated and validated by its own
// chain WITHOUT minting, then ranked against every other engine's candidate
// on the same pre-registered criteria. It never mints on its own, has no
// priority, and loses (NOT_SELECTED, recorded) to a better-ranked candidate.
// All inputs are FABRICATED fixtures.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { MomentumBreakSignal } from '@fno/analytics';
import type { TradeSetup } from '@fno/shared';

vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const sa = await import('../slot-arbitration.js');

const trigger: MomentumBreakSignal = {
  direction: 'BULLISH',
  levelKind: 'PDH' as any,
  levelPrice: 25000,
  entry: 25040,
  stop: 24990,
  target: 25150,
  targetKind: 'R1' as any,
  rUnderlying: 2.2,
  volMult: 2.1,
  rangeMult: 1.8,
  closeLocation: 0.1,
  atr: 40,
  quality: 85,
  barTime: Date.parse('2026-08-10T10:45:00+05:30'),
  variantId: 'V1',
};
const parentId = sa.momentumParentId('NSE', 'NIFTY', trigger, '2026-08-10');
const link = { parentId, decisionTime: trigger.barTime + 15 * 60 * 1000 };

function deferred(slot: any, log: string[]) {
  return {
    kind: 'DEFERRED' as const,
    setup: { available: true, reason: `built ${slot.source}` } as TradeSetup,
    slot,
    commit: async () => {
      log.push(`MINT ${slot.source}`);
      return { setup: { available: true, reason: `minted ${slot.source}` } as TradeSetup, minted: true };
    },
    decline: async (reason: string) => {
      log.push(`DECLINE ${slot.source}: ${reason}`);
    },
  };
}

describe('the momentum break as a slot candidate', () => {
  it('carries the common schema: its own geometry, parent move, confirmations', () => {
    const c = sa.momentumSlotCandidate(trigger, 25040, null, link);
    expect(c).toMatchObject({ source: 'MOMENTUM_BREAK', direction: 'BULLISH', parentId, anchorKeys: [parentId], evidence: 1, decisionTime: link.decisionTime });
    expect(c.candidateId).toBe(`${parentId}:${trigger.barTime}`);
    // Entry at the spot, stop/target the trigger's own, anchored on the broken level.
    expect(sa.momentumGeometry(trigger, 25040)).toEqual({ direction: 'BULLISH', entry: 25040, stop: 24990, objective: 25150, anchor: 25000, onAnchorBar: true });
    expect(c.confirmationDetail).toEqual({ liquiditySweep: false, displacement: true, structureZone: false, optionChain: null });
    expect(c.confirmations).toBe(1);
    expect(c.netRR).toBe(sa.NOT_MEASURED);
  });

  it('one parent per broken level, direction and day', () => {
    expect(sa.momentumParentId('NSE', 'NIFTY', { ...trigger, direction: 'BEARISH' }, '2026-08-10')).not.toBe(parentId);
    expect(sa.momentumParentId('NSE', 'NIFTY', trigger, '2026-08-11')).not.toBe(parentId);
    expect(sa.parentAlreadyTraded(sa.momentumSlotCandidate(trigger, 25040, null, link).anchorKeys, new Set([parentId]))).toBe(true);
  });
});

describe('it competes — it never mints on its own', () => {
  it('a better-ranked candidate wins; the momentum break is declined NOT_SELECTED and recorded', async () => {
    const log: string[] = [];
    let records: any[] = [];
    const mb = { ...sa.momentumSlotCandidate(trigger, 25040, null, link), netRR: 1.2 };
    const other = { ...mb, source: 'S1', candidateId: 'S1:x', parentId: 'P2', anchorKeys: ['P2'], netRR: 2.4 };
    const out = await sa.settleSlot({ underlying: 'NIFTY', exchange: 'NSE', entries: [deferred(mb, log), deferred(other, log)], record: (r) => (records = r) });
    expect(out?.reason).toBe('minted S1');
    expect(log).not.toContain('MINT MOMENTUM_BREAK');
    expect(log.some((l) => l.startsWith('DECLINE MOMENTUM_BREAK'))).toBe(true);
    expect(records.find((r) => r.slot.source === 'MOMENTUM_BREAK')).toMatchObject({ role: 'ALTERNATIVE', refusalCode: 'NOT_SELECTED' });
  });

  it('when it ranks best it is minted through the same settle, and its parent is marked traded', async () => {
    const log: string[] = [];
    const marked: string[] = [];
    const mb = { ...sa.momentumSlotCandidate(trigger, 25040, null, link), netRR: 3.0 };
    const other = { ...mb, source: 'S1', candidateId: 'S1:x', parentId: 'P2', anchorKeys: ['P2'], netRR: 1.1 };
    const out = await sa.settleSlot({ underlying: 'NIFTY', exchange: 'NSE', entries: [deferred(other, log), deferred(mb, log)], markTraded: async (k) => void marked.push(...k) });
    expect(out?.reason).toBe('minted MOMENTUM_BREAK');
    expect(marked).toEqual([parentId]);
  });

  it('a momentum break that fails its final check falls through to the next-best', async () => {
    const log: string[] = [];
    const mb = { ...sa.momentumSlotCandidate(trigger, 25040, null, link), netRR: 3.0 };
    const other = { ...mb, source: 'S1', candidateId: 'S1:x', parentId: 'P2', anchorKeys: ['P2'], netRR: 1.1 };
    const out = await sa.settleSlot({
      underlying: 'NIFTY', exchange: 'NSE', entries: [deferred(mb, log), deferred(other, log)],
      preMint: (e) => (e.slot.source === 'MOMENTUM_BREAK' ? { code: 'STALE_QUOTE', reason: 'old chain' } : null),
    });
    expect(out?.reason).toBe('minted S1');
  });
});

describe('market-bias wiring', () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../market-bias.ts'), 'utf8');
  const resolver = src.slice(src.indexOf('async function resolveMomentumBreakSetup('), src.indexOf('// --- Structure family (flag STRUCTURE) ---'));

  it('no early return: the trigger is pushed into the arbitration entries', () => {
    expect(src).not.toMatch(/if \(triggered\) return triggered/);
    const push = src.indexOf('resolveMomentumBreakSetup({');
    expect(push).toBeGreaterThan(src.indexOf('const entries: SlotEntry[] = [];'));
    expect(push).toBeLessThan(src.indexOf('const minted = await settleSlot({'));
  });

  it('the resolver returns a SlotEntry and mints only inside commit()', () => {
    expect(resolver).toMatch(/\): Promise<SlotEntry> \{/);
    expect(resolver).toMatch(/kind: 'DEFERRED'/);
    const mintCalls = resolver.match(/mintUnderLock\(/g) ?? [];
    expect(mintCalls).toHaveLength(1);
    expect(resolver.indexOf('mintUnderLock(')).toBeGreaterThan(resolver.indexOf('const commit = async'));
  });
});
