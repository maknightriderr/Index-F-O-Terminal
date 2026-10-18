// ============================================================
// ARB-1 (audit 2026-10-18): a missing net R never ranks on the gross R, and an unpriced candidate never beats a
// priced one by making the pool skip net R:R.
// ============================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../setup-events.js', () => ({ recordSetupEvent: () => undefined }));

const sa = await import('../slot-arbitration.js');
const { NOT_MEASURED } = sa;

const slot = (source: string, netRR: number | typeof NOT_MEASURED, over: Record<string, unknown> = {}) =>
  ({ source, candidateId: `id-${source}`, direction: 'BULLISH', parentId: `P-${source}`, anchorKeys: [`P-${source}`], timingClass: 'ACCEPTABLE', movePotential: 'NORMAL', moveConsumedPct: 0.2, objectiveDistanceAtr: 2, netRR, entryQuality: 0.6, evidence: 1, decisionTime: 1000, confirmations: 1, ...over }) as any;

describe('slot pool with priced and unpriced candidates', () => {
  it('the priced candidate wins even when the unpriced one has better entry quality', () => {
    const unpriced = slot('U', NOT_MEASURED, { entryQuality: 0.95 });
    const priced = slot('P', 0.4, { entryQuality: 0.5 });
    const r = sa.rankSlotCandidates([unpriced, priced]);
    expect([unpriced, priced][r.winner].source).toBe('P');
    expect(r.used).toContain('net R:R after costs');
    expect(r.lostOn.get(0)).toMatch(/not measured; a priced candidate ranks first/);
  });
  it('among the priced, net R:R decides; the unpriced follow, ranked among themselves', () => {
    const cs = [slot('U1', NOT_MEASURED, { entryQuality: 0.9 }), slot('P1', 0.2), slot('P2', 0.7), slot('U2', NOT_MEASURED, { entryQuality: 0.4 })];
    expect(sa.rankSlotCandidates(cs).order.map((i) => cs[i].source)).toEqual(['P2', 'P1', 'U1', 'U2']);
  });
  it('an all-priced or all-unpriced pool ranks exactly as before', () => {
    const priced = [slot('A', 1.5, { confirmations: 4 }), slot('B', 1.5, { confirmations: 1 }), slot('C', 2.0, { confirmations: 0 })];
    expect(sa.rankSlotCandidates(priced).order.map((i) => priced[i].source)).toEqual(['C', 'A', 'B']);
    const none = [slot('X', NOT_MEASURED, { entryQuality: 0.3 }), slot('Y', NOT_MEASURED, { entryQuality: 0.8 })];
    const r = sa.rankSlotCandidates(none);
    expect(r.order.map((i) => none[i].source)).toEqual(['Y', 'X']);
    expect(r.skipped).toContain('net R:R after costs');
  });
});
