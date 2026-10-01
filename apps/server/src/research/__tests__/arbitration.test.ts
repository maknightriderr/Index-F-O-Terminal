// ============================================================
// SETUP ARBITRATION — evaluate all, qualify all, group by parent, select one
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  prepareMomentumSeries,
  buildSeriesContext,
  runSessionEvents,
  evaluateTriggersAt,
  groupIntoParents,
  arbitrateParent,
  arbitrateParents,
  compareCandidates,
  EVENT_ENGINE_TRIGGER_IDS,
  type ArbitrationInfo,
  type MomentumBar,
  type TriggerCandidate,
} from '@fno/analytics';

const ok: ArbitrationInfo = { eligible: true, ineligibleReason: null, stageAllowed: true, netR: null };
const bad = (reason: string): ArbitrationInfo => ({ eligible: false, ineligibleReason: reason, stageAllowed: true, netR: null });

const cand = (over: Partial<TriggerCandidate> & { triggerId: string }): TriggerCandidate =>
  ({
    family: 'LIQUIDITY_REVERSAL',
    direction: 'BEARISH',
    session: 'D',
    decisionIndex: 10,
    decisionTime: 0,
    entry: 100,
    stop: 104,
    atr: 4,
    t1: { kind: 'PREV_DAY_LOW', price: 90 },
    t2: null,
    rToT1: 2.5,
    bucket: 'TRADE',
    anchorEventId: 'SWEEP:x',
    anchorIndex: 7,
    anchorPrice: 104,
    eventIds: ['e1', 'e2'],
    marketState: 'BALANCED',
    movePotential: { class: 'NORMAL', remainingMovePct: 0.5 },
    timing: { class: 'ACCEPTABLE' },
    ...over,
  }) as TriggerCandidate;

describe('evaluate all: one trigger failing never stops another', () => {
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
  const series = prepareMomentumSeries([
    ...days.flatMap(quiet),
    ...session('2026-08-10', [
      [100, 104, 96, 102],
      [102, 106, 99, 104],
      [104, 107, 101, 105],
      [105, 112, 103, 104],
      [104, 105, 100, 101],
      [101, 103, 98, 102],
      [102, 104, 99, 100],
      [100, 101, 94, 95],
      [95, 96, 90, 91],
    ]),
  ]);
  const ctx = buildSeriesContext(series);
  const s = series.sessionDates.indexOf('2026-08-10');
  const log = runSessionEvents(ctx, s);
  const start = series.sessionStarts[s];

  it('C2 (needs a displacement) finds none, and A2 (needs none) still fires on the same bar', () => {
    const out = evaluateTriggersAt(ctx, log, start + 7, ['C2', 'A2']);
    expect(out.map((c) => c.triggerId)).toEqual(['A2']);
  });

  it('every registered rule is evaluated: the same call with all rules still returns A2', () => {
    const out = evaluateTriggersAt(ctx, log, start + 7, EVENT_ENGINE_TRIGGER_IDS);
    expect(out.some((c) => c.triggerId === 'A2')).toBe(true);
  });

  it('an ineligible candidate is stored with its reason; the eligible one is selected', () => {
    const cs = [cand({ triggerId: 'A2' }), cand({ triggerId: 'A3', bucket: 'NO_TARGET' })];
    const d = arbitrateParent({ parentId: 'P', candidates: [0, 1] }, cs, (i) => (i === 1 ? bad('NO_TARGET: no untaken pool ahead') : ok));
    expect(d.get(0)).toMatchObject({ role: 'SELECTED', selectedTriggerId: 'A2' });
    expect(d.get(1)).toMatchObject({ role: 'INELIGIBLE', reason: 'NO_TARGET: no untaken pool ahead' });
  });
});

describe('multiple triggers on the same parent: one selected setup', () => {
  it('A2, A3 and D3 all qualify → exactly one SELECTED, the others ALTERNATIVE with why', () => {
    const cs = [cand({ triggerId: 'A2' }), cand({ triggerId: 'A3', timing: { class: 'OPTIMAL' } as never }), cand({ triggerId: 'D3', family: 'VOLATILITY_EXPANSION' })];
    const d = arbitrateParent({ parentId: 'P101', candidates: [0, 1, 2] }, cs, () => ok);
    expect([...d.values()].filter((x) => x.role === 'SELECTED')).toHaveLength(1);
    expect(d.get(1)).toMatchObject({ role: 'SELECTED', rank: 1 });
    expect(d.get(0)).toMatchObject({ role: 'ALTERNATIVE', selectedTriggerId: 'A3' });
    expect(d.get(0)!.reason).toMatch(/below A3 on entry timing/);
    expect(d.get(2)!.role).toBe('ALTERNATIVE');
  });

  it('a better-looking candidate on a later bar does not replace the selection (no hindsight)', () => {
    const cs = [cand({ triggerId: 'A2', decisionIndex: 10 }), cand({ triggerId: 'B2', decisionIndex: 12, timing: { class: 'OPTIMAL' } as never, rToT1: 6 })];
    const d = arbitrateParent({ parentId: 'P', candidates: [0, 1] }, cs, () => ok);
    expect(d.get(0)!.role).toBe('SELECTED');
    expect(d.get(1)).toMatchObject({ role: 'ALTERNATIVE', reason: 'Parent already has a selected setup (A2 at bar 10)' });
  });

  it('a selection fixed by an earlier evaluation stands', () => {
    const cs = [cand({ triggerId: 'A2', decisionIndex: 10 }), cand({ triggerId: 'A3', decisionIndex: 10, timing: { class: 'OPTIMAL' } as never })];
    const d = arbitrateParent({ parentId: 'P', candidates: [0, 1] }, cs, () => ok, { triggerId: 'A2', decisionIndex: 10 });
    expect(d.get(0)!.role).toBe('SELECTED');
    expect(d.get(1)!.role).toBe('ALTERNATIVE');
  });

  it('a trigger whose stage is not allowed in this mode is never the trading selection', () => {
    const cs = [cand({ triggerId: 'A2' })];
    const d = arbitrateParent({ parentId: 'P', candidates: [0] }, cs, () => ({ ...ok, stageAllowed: false }));
    expect(d.get(0)).toMatchObject({ role: 'INELIGIBLE', selectedTriggerId: null });
  });
});

describe('best-setup ranking (decision-time fields only)', () => {
  const rank = (a: Partial<TriggerCandidate>, b: Partial<TriggerCandidate>, ia = ok, ib = ok) => compareCandidates(cand({ triggerId: 'X', ...a }), cand({ triggerId: 'Y', ...b }), ia, ib);
  it('entry timing first: OPTIMAL > EARLY > ACCEPTABLE > LATE > CHASING', () => {
    expect(rank({ timing: { class: 'OPTIMAL' } as never }, { timing: { class: 'LATE' } as never })).toMatchObject({ criterion: 'entry timing' });
    expect(rank({ timing: { class: 'OPTIMAL' } as never }, { timing: { class: 'LATE' } as never }).cmp).toBeLessThan(0);
    expect(rank({ timing: { class: 'CHASING' } as never }, { timing: { class: 'ACCEPTABLE' } as never }).cmp).toBeGreaterThan(0);
  });
  it('then move potential and remaining move, then net-R geometry, then evidence', () => {
    expect(rank({ movePotential: { class: 'HIGH', remainingMovePct: 0.5 } as never }, {})).toMatchObject({ criterion: 'move potential' });
    expect(rank({ movePotential: { class: 'NORMAL', remainingMovePct: 0.8 } as never }, {})).toMatchObject({ criterion: 'remaining move' });
    expect(rank({}, {}, { ...ok, netR: 2.2 }, { ...ok, netR: 1.9 })).toMatchObject({ criterion: 'net-R geometry' });
    expect(rank({ rToT1: 3 }, { rToT1: 2 })).toMatchObject({ criterion: 'net-R geometry' });
    expect(rank({ eventIds: ['a', 'b', 'c'] }, {})).toMatchObject({ criterion: 'evidence' });
  });
  it('a deterministic tie-break: earlier bar, then trigger id', () => {
    expect(rank({}, {})).toMatchObject({ criterion: 'trigger id tie-break' });
    expect(rank({}, {}).cmp).toBeLessThan(0);
  });
});

describe('different parents stay separate', () => {
  it('three moves → three selections', () => {
    const cs = [
      cand({ triggerId: 'A3', decisionIndex: 10, anchorEventId: 'SWEEP:a', anchorIndex: 8 }),
      cand({ triggerId: 'B2', decisionIndex: 30, anchorEventId: 'BREAK:b', anchorIndex: 27, direction: 'BULLISH' }),
      cand({ triggerId: 'D3', decisionIndex: 50, anchorEventId: 'BURST:c', anchorIndex: 47 }),
      cand({ triggerId: 'A2', decisionIndex: 11, anchorEventId: 'SWEEP:a', anchorIndex: 8 }),
    ];
    const parents = groupIntoParents(cs, new Map());
    expect(parents).toHaveLength(3);
    const d = arbitrateParents(parents, cs, () => ok);
    const selected = [...d.entries()].filter(([, x]) => x.role === 'SELECTED').map(([i]) => cs[i].triggerId).sort();
    expect(selected).toEqual(['A3', 'B2', 'D3']);
    expect(d.get(3)!.role).toBe('ALTERNATIVE');
  });
});
