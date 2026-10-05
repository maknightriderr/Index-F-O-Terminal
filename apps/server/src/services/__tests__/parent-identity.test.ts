// ============================================================
// PHASE 4 — parent identity (PARENT-2.0) and the slot rule.
//   "the same underlying move" = same session + direction + same origin event
//   (ancestry root), or the same origin level inside the move's window;
//   two different moves are never merged; parentId is a stable hash;
//   ONE open trade per symbol, the same day open again after a close (only
//   the traded parent stays blocked); parentId + slot decision on every
//   arbitrated candidate.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { groupIntoParents, parentIdFor, PARENT_SPAN_BARS, PARENT_IDENTITY_VERSION, type MarketEvent, type SessionEventLog, type TriggerCandidate } from '@fno/analytics';
import type { TradeSetup } from '@fno/shared';
import type { SlotCandidate, SlotEntry } from '../slot-arbitration.js';

vi.mock('../../lib/redis.js', () => ({ redis: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../setup-events.js', () => ({ recordSetupEvent: () => undefined }));

const { slotRuleFor, settleSlot } = await import('../slot-arbitration.js');
const { buildParentLinkage, linkStructureToParent } = await import('../trigger-router.js');
const { PARENTING_VERSION } = await import('../../config/trading-flags.js');

const SESSION = '2026-10-05';
const T0 = Date.parse('2026-10-05T09:15:00+05:30');
const M15 = 15 * 60 * 1000;
const ev = (id: string, type: MarketEvent['type'], dir: 'BULLISH' | 'BEARISH', bar: number, level: { kind: string; price: number } | null, parentId: string | null = null): MarketEvent =>
  ({ id, type, direction: dir, barIndex: bar, time: T0 + bar * M15, availableAt: T0 + (bar + 1) * M15, price: level?.price ?? 100, level, parentId }) as MarketEvent;
const logOf = (events: MarketEvent[]): Map<string, SessionEventLog> =>
  new Map([[SESSION, { session: SESSION, s: 0, start: 0, end: 30, events, byIndex: new Map(), byId: new Map(events.map((e) => [e.id, e])) } as SessionEventLog]]);
const cand = (triggerId: string, anchorEventId: string, anchorIndex: number, decisionIndex: number, direction: 'BULLISH' | 'BEARISH' = 'BEARISH'): TriggerCandidate =>
  ({ triggerId, family: 'LIQUIDITY_REVERSAL', direction, session: SESSION, decisionIndex, anchorEventId, anchorIndex, bucket: 'TRADE' }) as TriggerCandidate;

const PDH = { kind: 'PREV_DAY_HIGH', price: 25100 };
const ORH = { kind: 'OPENING_RANGE_HIGH', price: 25060 };
const events = [
  ev('SWEEP:PDH:3', 'SWEEP', 'BEARISH', 3, PDH),
  ev('RECLAIM:PDH:4', 'RECLAIM', 'BEARISH', 4, PDH, 'SWEEP:PDH:3'),
  ev('SWEEP:ORH:5', 'SWEEP', 'BEARISH', 5, ORH),
  ev('SWEEP:PDH:9', 'SWEEP', 'BEARISH', 9, PDH), // the same pool again, inside the window
  ev('SWEEP:PDH:20', 'SWEEP', 'BEARISH', 20, PDH), // the same pool, after the window
  ev('SWEEP:PDHup:6', 'SWEEP', 'BULLISH', 6, PDH), // same level, other direction
];
const logs = logOf(events);

describe('parent identity — "the same underlying move"', () => {
  it('two different moves are never merged: different origins on different levels, two bars apart', () => {
    const parents = groupIntoParents([cand('A2', 'SWEEP:PDH:3', 3, 4), cand('A3', 'SWEEP:ORH:5', 5, 5)], logs, { symbol: 'NIFTY' });
    expect(parents).toHaveLength(2);
    expect(new Set(parents.map((p) => p.parentId)).size).toBe(2);
  });

  it('one origin, several families: an event and its ancestors are one move (RECLAIM → its SWEEP)', () => {
    const parents = groupIntoParents([cand('A2', 'RECLAIM:PDH:4', 4, 4), cand('B1', 'SWEEP:PDH:3', 3, 5)], logs, { symbol: 'NIFTY' });
    expect(parents).toHaveLength(1);
    expect(parents[0].anchorEventId).toBe('SWEEP:PDH:3');
    expect(parents[0].triggerIds).toEqual(['A2', 'B1']);
  });

  it('the same pool again inside the move\'s window is the same move; after the window, or the other direction, it is not', () => {
    const inside = groupIntoParents([cand('A2', 'SWEEP:PDH:3', 3, 4), cand('A2', 'SWEEP:PDH:9', 9, 10)], logs, { symbol: 'NIFTY' });
    expect(inside).toHaveLength(1);
    expect(9 - 3).toBeLessThanOrEqual(PARENT_SPAN_BARS);
    const after = groupIntoParents([cand('A2', 'SWEEP:PDH:3', 3, 4), cand('A2', 'SWEEP:PDH:20', 20, 21)], logs, { symbol: 'NIFTY' });
    expect(after).toHaveLength(2);
    const other = groupIntoParents([cand('A2', 'SWEEP:PDH:3', 3, 4), cand('A2', 'SWEEP:PDHup:6', 6, 7, 'BULLISH')], logs, { symbol: 'NIFTY' });
    expect(other).toHaveLength(2);
  });

  it('the window never slides: a level revisited inside each previous visit\'s window but beyond the first\'s is a new move', () => {
    const e = [ev('S:a', 'SWEEP', 'BEARISH', 0, PDH), ev('S:b', 'SWEEP', 'BEARISH', 10, PDH), ev('S:c', 'SWEEP', 'BEARISH', 20, PDH)];
    const parents = groupIntoParents([cand('A2', 'S:a', 0, 1), cand('A2', 'S:b', 10, 11), cand('A2', 'S:c', 20, 21)], logOf(e), { symbol: 'NIFTY' });
    expect(parents.map((p) => p.candidates)).toEqual([[0, 1], [2]]);
  });

  it('parentId is a stable hash: independent of input order and of later candidates; specific to the symbol', () => {
    const cs = [cand('A2', 'SWEEP:PDH:3', 3, 4), cand('A3', 'SWEEP:ORH:5', 5, 5), cand('B1', 'RECLAIM:PDH:4', 4, 6), cand('A2', 'SWEEP:PDH:20', 20, 21)];
    const ids = (list: TriggerCandidate[]) =>
      groupIntoParents(list, logs, { symbol: 'NIFTY' })
        .map((p) => `${p.parentId}=${p.candidates.map((i) => `${list[i].triggerId}@${list[i].anchorEventId}`).sort().join(',')}`)
        .sort();
    expect(ids([...cs].reverse())).toEqual(ids(cs));
    expect(ids([cs[2], cs[0], cs[3], cs[1]])).toEqual(ids(cs));
    // The first move's id does not change when later candidates arrive.
    const early = groupIntoParents(cs.slice(0, 1), logs, { symbol: 'NIFTY' })[0].parentId;
    expect(groupIntoParents(cs, logs, { symbol: 'NIFTY' }).find((p) => p.anchorEventId === 'SWEEP:PDH:3')!.parentId).toBe(early);
    expect(early).toMatch(/^P:[0-9a-f]{28}$/);
    expect(groupIntoParents(cs.slice(0, 1), logs, { symbol: 'BANKNIFTY' })[0].parentId).not.toBe(early);
    expect(PARENT_IDENTITY_VERSION).toBe('PARENT-2.0');
    expect(PARENTING_VERSION).toBe(PARENT_IDENTITY_VERSION);
  });

  it('S1 joins the move through the canonical sweep even when no family candidate is anchored on it', () => {
    const parents = groupIntoParents([cand('A2', 'SWEEP:PDH:3', 3, 4)], logs, { symbol: 'NIFTY' });
    const linkage = buildParentLinkage(SESSION, parents, [cand('A2', 'SWEEP:PDH:3', 3, 4)], events, 'NIFTY');
    // A re-sweep of the same pool in the window → the same parent as the family's.
    expect(linkage.parentOfKey['SWEEP:PDH:9']).toBe(parents[0].parentId);
    // A sweep of another pool → its own move, with the id the grouping would give it.
    expect(linkage.parentOfKey['SWEEP:ORH:5']).toBe(parentIdFor('NIFTY', SESSION, 'BEARISH', { originEventId: 'SWEEP:ORH:5', originLevel: 'OPENING_RANGE_HIGH:25060.00', ancestry: ['SWEEP:ORH:5'], windowStart: T0 + 5 * M15 }));
    const lc = { id: `NSE:NIFTY:${T0 + 5 * M15}`, direction: 'BEARISH' as const, pool: { kind: 'OPENING_RANGE_HIGH', price: 25060 } as any, timeframe: '15m' as const };
    expect(linkStructureToParent(lc, linkage)).toEqual({ parentId: linkage.parentOfKey['SWEEP:ORH:5'], anchorKeys: [linkage.parentOfKey['SWEEP:ORH:5'], 'SWEEP:ORH:5'], linked: true });
  });
});

describe('slot rule — one OPEN trade per symbol, not one trade per day', () => {
  it('open → SLOT_OCCUPIED; after the close the same day: the traded parent stays out, an independent parent competes', () => {
    const traded = new Set(['P:first', 'SWEEP:PDH:3']);
    expect(slotRuleFor({ openTradeHeld: true, anchorKeys: ['P:second'], traded })).toBe('SLOT_OCCUPIED');
    expect(slotRuleFor({ openTradeHeld: false, anchorKeys: ['P:first', 'SWEEP:PDH:3'], traded })).toBe('PARENT_ALREADY_TRADED');
    // A different parent on the shared canonical event is still the same move.
    expect(slotRuleFor({ openTradeHeld: false, anchorKeys: ['P:other', 'SWEEP:PDH:3'], traded })).toBe('PARENT_ALREADY_TRADED');
    expect(slotRuleFor({ openTradeHeld: false, anchorKeys: ['P:second', 'SWEEP:ORH:5'], traded })).toBe('COMPETES');
  });

  it('every arbitrated candidate carries its parentId and the slot decision', async () => {
    const slot = (source: string, parentId: string, netRR = 1.6): SlotCandidate => ({
      source, candidateId: `id-${source}`, direction: 'BEARISH', parentId, anchorKeys: [parentId], timingClass: 'ACCEPTABLE', movePotential: 'NORMAL',
      moveConsumedPct: 0.2, objectiveDistanceAtr: 2, netRR, entryQuality: 0.6, evidence: 2, decisionTime: 1_000,
    });
    const built = (sl: SlotCandidate): SlotEntry => ({ kind: 'DEFERRED', setup: { available: true, reason: sl.source } as TradeSetup, slot: sl, commit: async () => ({ setup: { available: true, reason: 'm' } as TradeSetup, minted: true }), decline: async () => undefined });
    let records: any[] = [];
    await settleSlot({
      underlying: 'NIFTY',
      exchange: 'NSE',
      entries: [
        built(slot('A2', 'P:a', 2.0)),
        built(slot('B1', 'P:b', 1.1)),
        { kind: 'REFUSED' as const, slot: slot('A3', 'P:c'), code: 'PARENT_ALREADY_TRADED', reason: 'traded', optionBuild: false },
        { kind: 'REFUSED' as const, slot: slot('S1', 'P:d'), code: 'COST_TOO_HIGH', reason: 'cost', optionBuild: true },
      ],
      record: (r) => (records = r),
    });
    const by = (s: string) => records.find((r) => r.slot.source === s);
    expect(records).toHaveLength(4);
    for (const r of records) {
      expect(r.slot.parentId).toBeTruthy();
      expect(r.slotDecision.slot).toBe('FREE');
    }
    expect(by('A2').slotDecision.decision).toBe('MINTED');
    expect(by('B1').slotDecision.decision).toBe('NOT_SELECTED');
    expect(by('A3').slotDecision.decision).toBe('PARENT_ALREADY_TRADED');
    expect(by('S1').slotDecision.decision).toBe('INELIGIBLE');
  });
});
