// ============================================================
// SIGNAL ENGINE — independent triggers, every candidate built, next-best on
// failure, NO TRADE only when every candidate fails; evidence in arbitration.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import type { MomentumBar } from '@fno/analytics';
import type { OptionChain, TradeSetup } from '@fno/shared';

vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../setup-events.js', () => ({ recordSetupEvent: () => undefined }));

const analytics = await import('@fno/analytics');
const { prepareMomentumSeries, buildSeriesContext, runSessionEvents, evaluateTriggersAt, TRIGGER_RULES } = analytics;
const { evaluateFamiliesCore, EMPTY_FAMILY_ROUTER_STATE, liveTriggerStages } = await import('../trigger-router.js');
const sa = await import('../slot-arbitration.js');

// The router-live fixture session: several families fire on the newest bar.
const M15 = 15 * 60 * 1000;
const ist = (s: string) => Date.parse(`${s}+05:30`);
const session = (date: string, p: Array<[number, number, number, number]>): MomentumBar[] => p.map(([open, high, low, close], k) => ({ time: ist(`${date}T09:15:00`) + k * M15, open, high, low, close, volume: 0 }));
const quiet = (date: string) => session(date, Array.from({ length: 25 }, (_, k) => {
  const o = 100 + ((k % 4) - 1.5) * 2;
  const c = 100 + (((k + 1) % 4) - 1.5) * 2;
  return [o, Math.max(o, c) + 4, Math.min(o, c) - 4, c] as [number, number, number, number];
}));
const days = Array.from({ length: 22 }, (_, k) => new Date(Date.parse('2026-07-15T12:00:00Z') + k * 86_400_000).toISOString().slice(0, 10));
const bars = [...days.flatMap(quiet), ...session('2026-08-10', [[100, 104, 96, 102], [102, 106, 99, 104], [104, 107, 101, 105], [105, 112, 103, 104], [104, 105, 100, 101], [101, 103, 98, 102], [102, 104, 99, 100], [100, 101, 94, 95]])];
const NOW = ist('2026-08-10T11:20:00');

function withRule(id: string, rule: any, fn: () => void) {
  const rules = TRIGGER_RULES as Record<string, any>;
  const saved = rules[id];
  rules[id] = rule;
  try {
    fn();
  } finally {
    rules[id] = saved;
  }
}

describe('trigger families are independent', () => {
  const series = prepareMomentumSeries(bars);
  const ctx = buildSeriesContext(series);
  const s = series.sessionStarts.length - 1;
  const log = runSessionEvents(ctx, s);
  const end = ctx.sessionEnd(s);
  const baseline = evaluateTriggersAt(ctx, log, end);
  const firing = [...new Set(baseline.map((c) => c.triggerId))];

  it('a trigger that throws loses only its own candidates; every other trigger still produces its own', () => {
    expect(firing.length).toBeGreaterThan(1);
    const broken = firing[0];
    withRule(broken, () => {
      throw new Error('boom');
    }, () => {
      const failures: any[] = [];
      const got = evaluateTriggersAt(ctx, log, end, undefined, failures);
      expect(got.map((c) => c.triggerId)).not.toContain(broken);
      expect(got).toEqual(baseline.filter((c) => c.triggerId !== broken));
      expect(failures).toEqual([{ triggerId: broken, decisionIndex: end, kind: 'ERROR', message: 'boom' }]);
    });
  });

  it('a look-ahead read is discarded and reported, never used; research callers (no failure list) still get the hard tripwire', () => {
    const broken = firing[0];
    const future = { ...log.events[0], barIndex: end + 5 };
    withRule(broken, () => [{ events: [future] }], () => {
      const failures: any[] = [];
      const got = evaluateTriggersAt(ctx, log, end, undefined, failures);
      expect(got.map((c) => c.triggerId)).not.toContain(broken);
      expect(failures[0]).toMatchObject({ triggerId: broken, kind: 'LOOKAHEAD' });
      expect(() => evaluateTriggersAt(ctx, log, end)).toThrow(/after its decision bar/);
    });
  });

  it('the live router keeps every other family when one throws, and reports the failure', () => {
    const run = () => evaluateFamiliesCore({ underlying: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', bars, chain: null, now: NOW, stages: liveTriggerStages(), state: EMPTY_FAMILY_ROUTER_STATE });
    const clean = run();
    const paperFirst = clean.paper[0]?.candidate.triggerId;
    expect(paperFirst).toBeTruthy();
    withRule(paperFirst!, () => {
      throw new Error('rule bug');
    }, () => {
      const out = run();
      expect(out.status).toBe('EVALUATED');
      expect(out.triggerFailures.some((f) => f.triggerId === paperFirst)).toBe(true);
      expect(out.paper.map((p) => p.lifecycleId)).toEqual(clean.paper.filter((p) => p.candidate.triggerId !== paperFirst).map((p) => p.lifecycleId));
    });
  });
});

// ---------------- the slot: next-best on failure, NO TRADE only when all fail ----------------

const slot = (source: string, netRR: number, over: Record<string, unknown> = {}) =>
  ({ source, candidateId: `id-${source}`, direction: 'BULLISH', parentId: `P-${source}`, anchorKeys: [`P-${source}`], timingClass: 'ACCEPTABLE', movePotential: 'NORMAL', moveConsumedPct: 0.2, objectiveDistanceAtr: 2, netRR, entryQuality: 0.6, evidence: 1, decisionTime: 1000, confirmations: 1, ...over }) as any;
const built = (sl: any, log: string[], commit?: () => Promise<{ setup: TradeSetup; minted: boolean }>) => ({
  kind: 'DEFERRED' as const,
  setup: { available: true, reason: sl.source } as TradeSetup,
  slot: sl,
  commit: commit ?? (async () => (log.push(`MINT ${sl.source}`), { setup: { available: true, reason: `minted ${sl.source}` } as TradeSetup, minted: true })),
  decline: async (reason: string) => void log.push(`DECLINE ${sl.source}: ${reason}`),
});

describe('slot: if the best candidate fails, the next-best is evaluated', () => {
  it('pre-mint failure (data quality / no edge) on #1 → #2 is minted; #1 recorded with its reason', async () => {
    const log: string[] = [];
    let records: any[] = [];
    const out = await sa.settleSlot({
      underlying: 'NIFTY', exchange: 'NSE',
      entries: [built(slot('A', 2.0), log), built(slot('B', 1.5), log), built(slot('C', 1.0), log)],
      preMint: (e) => (e.slot.source === 'A' ? { code: 'STALE_QUOTE', reason: 'old chain' } : null),
      record: (r) => (records = r),
    });
    expect(out?.reason).toBe('minted B');
    expect(log).toContain('MINT B');
    expect(log).not.toContain('MINT A');
    const by = (s: string) => records.find((r) => r.slot.source === s);
    expect(by('A')).toMatchObject({ role: 'INELIGIBLE', refusalCode: 'STALE_QUOTE' });
    expect(by('B')).toMatchObject({ role: 'SELECTED', slotDecision: { decision: 'MINTED' } });
    expect(by('B').reason).toMatch(/1 ranked above it failed/);
    expect(by('C')).toMatchObject({ role: 'ALTERNATIVE', refusalCode: 'NOT_SELECTED' });
    expect(by('C').reason).toMatch(/ranked higher on net R:R after costs/);
  });

  it('a mint that throws moves on to the next-best', async () => {
    const log: string[] = [];
    let records: any[] = [];
    const out = await sa.settleSlot({
      underlying: 'NIFTY', exchange: 'NSE',
      entries: [built(slot('A', 2.0), log, async () => { throw new Error('db down'); }), built(slot('B', 1.5), log)],
      record: (r) => (records = r),
    });
    expect(out?.reason).toBe('minted B');
    expect(records.find((r) => r.slot.source === 'A')).toMatchObject({ role: 'INELIGIBLE', refusalCode: 'MINT_FAILED' });
  });

  it('NO TRADE only when every candidate fails — each one recorded with its reason', async () => {
    let records: any[] = [];
    const out = await sa.settleSlot({
      underlying: 'NIFTY', exchange: 'NSE',
      entries: [
        built(slot('A', 2.0), []),
        { kind: 'REFUSED', slot: slot('B', 1.0), code: 'WIDE_SPREAD', reason: 'spread 9%', optionBuild: true },
        built(slot('C', 1.2), []),
      ],
      preMint: () => ({ code: 'COST_EXCEEDS_EDGE', reason: 'no edge' }),
      record: (r) => (records = r),
    });
    expect(out).toBeNull();
    expect(records.map((r) => [r.slot.source, r.refusalCode]).sort()).toEqual([['A', 'COST_EXCEEDS_EDGE'], ['B', 'WIDE_SPREAD'], ['C', 'COST_EXCEEDS_EDGE']]);
  });

  it('a candidate whose chain throws is refused alone (ENGINE_ERROR); the others are untouched', async () => {
    const ok = await sa.isolatedCandidate(slot('A', 1), async () => built(slot('A', 1), []));
    expect(ok.kind).toBe('DEFERRED');
    const bad = await sa.isolatedCandidate(slot('B', 1), async () => { throw new Error('broker 500'); });
    expect(bad).toMatchObject({ kind: 'REFUSED', code: 'ENGINE_ERROR' });
    expect((bad as any).reason).toMatch(/broker 500/);
  });
});

describe('pre-mint check — genuine failures only (no R:R threshold)', () => {
  const leg = (bid: number, ask: number, ltp = (bid + ask) / 2) => ({ token: 't', ltp, bid, ask, delta: 0.5 }) as any;
  const chain = (ts: number, l = leg(99.9, 100.1)): OptionChain => ({ expiry: '2026-08-13', timestamp: ts, strikes: [{ strike: 100, call: l, put: l }] }) as any;
  const setup = (entry: number, stop: number, target: number, cost = 1): TradeSetup => ({ available: true, reason: 'x', strike: 100, side: 'CE', expiry: '2026-08-13', entry, stopLoss: stop, target, estimatedCostPct: cost }) as any;
  const now = 10_000_000;
  it('passes a fresh, quoted, low-R:R setup (net R:R is not a threshold)', () => {
    expect(sa.preMintCheck(setup(100, 80, 110), chain(now - 5_000), now)).toBeNull();
  });
  it('refuses a stale chain, a missing two-sided quote, and no reward after costs', () => {
    expect(sa.preMintCheck(setup(100, 80, 130), chain(now - sa.PRE_MINT_MAX_QUOTE_AGE_MS - 1), now)?.code).toBe('STALE_QUOTE');
    expect(sa.preMintCheck(setup(100, 80, 130), chain(now, leg(0, 100.1)), now)?.code).toBe('NO_QUOTE');
    expect(sa.preMintCheck(setup(100, 80, 100.5, 2), chain(now), now)?.code).toBe('COST_EXCEEDS_EDGE');
  });
});

describe('arbitration weighs the evidence (ARB-2.0 criterion 5: confirmations)', () => {
  it('S1 counts its sweep, displacement and zone; option-chain agreement adds one', () => {
    const lc = { id: 'L', direction: 'BULLISH', stop: 95, t1: { kind: 'PDH', price: 110 }, pool: { kind: 'PDL', price: 96 }, displacementBodyAtr: 1.2, zone: { kind: 'FVG', near: 99, far: 98 } } as any;
    const link = { parentId: 'P', anchorKeys: ['P'], decisionTime: 1 };
    const agree = sa.structureSlotCandidate(lc, 100, null, link, { positioningNet: 2 } as any);
    expect(agree.confirmations).toBe(4);
    expect(agree.confirmationDetail).toEqual({ liquiditySweep: true, displacement: true, structureZone: true, optionChain: true });
    expect(sa.structureSlotCandidate(lc, 100, null, link, { positioningNet: -1 } as any).confirmations).toBe(3);
    expect(sa.structureSlotCandidate({ ...lc, displacementBodyAtr: null, zone: null }, 100, null, link, null).confirmations).toBe(1);
  });
  it('a family candidate counts the event types of its own sequence', () => {
    const rc = { candidate: { triggerId: 'A2', direction: 'BEARISH', entry: 100, stop: 104, t1: { price: 92 }, anchorPrice: 103, anchorIndex: 3, decisionIndex: 4, decisionTime: 0, eventIds: ['SWEEP:BEARISH:3:x', 'RECLAIM:BEARISH:4:x', 'MICRO_BOS:BEARISH:4:y'] }, lifecycleId: 'L', parentId: 'P', anchorKeys: ['P'] } as any;
    const c = sa.routedSlotCandidate(rc, { positioningNet: -3 } as any);
    expect(c.confirmationDetail).toEqual({ liquiditySweep: true, displacement: false, structureZone: true, optionChain: true });
    expect(c.confirmations).toBe(3);
  });
  it('decides only when timing, move potential, net R:R and entry quality all tie — never ahead of them', () => {
    const a = slot('A', 1.5, { confirmations: 4 });
    const b = slot('B', 1.5, { confirmations: 1 });
    expect(sa.rankSlotCandidates([b, a]).order.map((i) => [b, a][i].source)).toEqual(['A', 'B']);
    expect(sa.compareSlotCandidates(a, b, sa.sharedCriteria([a, b]).used).criterion).toBe('confirmations');
    // Better net R:R still wins over more confirmations.
    const c = slot('C', 2.0, { confirmations: 0 });
    expect(sa.compareSlotCandidates(c, a, sa.sharedCriteria([a, c]).used)).toMatchObject({ criterion: 'net R:R after costs' });
    expect(sa.compareSlotCandidates(c, a, sa.sharedCriteria([a, c]).used).cmp).toBeLessThan(0);
  });
  it('the indicator engine (no event sequence) can only be confirmed by the option chain', () => {
    expect(sa.indicatorSlotCandidate('I', 'BULLISH', 1.4, 1, null, { positioningNet: 1 } as any).confirmations).toBe(1);
    expect(sa.indicatorSlotCandidate('I', 'BULLISH', 1.4, 1, null, null).confirmations).toBe(0);
  });
});
