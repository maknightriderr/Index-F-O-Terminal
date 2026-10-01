// ============================================================
// CONFIRMED-SETUP WATCH — acceptance tests
// ============================================================
// A confirmed setup below 1.50R is kept alive under its SAME id, re-measured
// on every closed 15m bar with the existing setup logic, shown with its full
// option plan (premium Entry / SL / TSL / T1 / T2), and becomes Eligible only
// when every hard check passes. The 1.50R minimum is unchanged; nothing here
// trades on its own; decision-time data only.
// ============================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));

import {
  buildTradeSetup,
  prepareMomentumSeries,
  buildSeriesContext,
  runSessionEvents,
  evaluateTriggersAt,
  rebuildCandidateAt,
  EVENT_ENGINE_TRIGGER_IDS,
  STRUCTURE_RULES,
  type MomentumBar,
  type TriggerCandidate,
} from '@fno/analytics';
import type { OptionChain, OptionChainLeg, OptionChainStrike, TradeSetup } from '@fno/shared';
import { fixtureStrikes, leg, ATM, LOT } from './trade-setup-fixtures.js';
import {
  RR_MIN,
  rrStatus,
  bindingRR,
  structureReference,
  grossRRFrom,
  advanceStructureKeepAlive,
  keepAliveStep,
  applyWatchUpdate,
  planFromLevels,
  endUpdateFor,
  type ClosedBar,
  type StructureKeepAlive,
  type WatchUpdate,
} from '../setup-watch-core.js';
import { validateOnChain, rankStrikeBuilds, strikeNetRR, type StrikeBuild } from '../fno-validation.js';
import { advanceFamilyWatch, newFamilyWatch, recoveredFamilyCandidates, FAMILY_WATCH_BARS, validateCandidateRisk, routedLifecycleId, liveTriggerStages, type RoutedCandidate, type FamilyWatchEntry } from '../trigger-router.js';
import { fillCandidate, structureSequenceRefusal, type LiveLifecycle, type LiveState } from '../structure-live.js';

const M15 = 15 * 60 * 1000;
const T0 = Date.parse('2026-08-10T10:00:00+05:30');
const bar = (k: number, o: number, h: number, l: number, c: number): ClosedBar => ({ time: T0 + k * M15, open: o, high: h, low: l, close: c });

/** A bearish S1 setup confirmed at 1.33R: limit 100 (FVG 100–103), stop 106, T1 92, sweep extreme 105. */
const lowRrS1 = (over: Partial<LiveLifecycle> = {}): LiveLifecycle =>
  ({
    id: 'NSE:NIFTY:BEARISH:1',
    direction: 'BEARISH',
    stage: 'LOW_RR',
    stageAt: T0 + M15, // bar 0's close
    entry: 100,
    zone: { kind: 'FVG', near: 100, far: 103 },
    stop: 106,
    t1: { kind: 'PREV_DAY_LOW', price: 92 },
    t2: null,
    sweepExtreme: 105,
    rToT1: 1.33,
    atr: 4,
    live: null,
    ...over,
  }) as unknown as LiveLifecycle;
const fill = STRUCTURE_RULES.fillWithinBars;
const watchUpdate = (over: Partial<WatchUpdate>): WatchUpdate => ({
  id: 'NSE:NIFTY:BEARISH:1',
  source: 'S1',
  direction: 'BEARISH',
  parentId: 'P1',
  at: T0,
  barTime: T0,
  statusRR: 1.4,
  grossRR: 1.4,
  netRR: 1.6,
  block: null,
  plan: null,
  optionBuildFailed: false,
  underlying: { entry: 100, sl: 106, t1: 92, t2: null },
  expiresAt: null,
  ...over,
});
const planOf = (strike: number, entryPremium = 118) =>
  planFromLevels({
    side: 'PE',
    strike,
    expiry: '2026-10-07',
    dte: 5,
    lotSize: 75,
    levels: { entry: entryPremium, stopLoss: entryPremium - 26, target: entryPremium + 37 },
    delta: -0.5,
    spot: 100,
    reference: 100,
    underlying: { sl: 106, t1: 92, t2: null },
    grossRR: 1.4,
    netRR: 1.6,
    estimatedCostPct: 2,
    ranking: null,
    trail: { breakevenAtR: 1, lockAtR: 2 },
  });

describe('3. the status line', () => {
  it('reads exactly as specified, and the 1.50R minimum is unchanged', () => {
    expect(RR_MIN).toBe(1.5);
    expect(rrStatus(1.32, null).text).toBe('Confirmed — R:R 1.32R < 1.50R');
    expect(rrStatus(1.47, null).text).toBe('Confirmed — R:R 1.47R < 1.50R');
    expect(rrStatus(1.5, null).text).toBe('Eligible — R:R 1.50R ≥ 1.50R');
    expect(rrStatus(1.82, null).text).toBe('Eligible — R:R 1.82R ≥ 1.50R');
    // Never "1.50R < 1.50R": a value just below the minimum floors to 1.49.
    expect(rrStatus(1.4999, null).text).toBe('Confirmed — R:R 1.49R < 1.50R');
  });
  it('R:R at the minimum does not bypass another hard check: the exact reason is shown', () => {
    expect(rrStatus(1.62, { code: 'COST_TOO_HIGH', reason: 'round trip 6.1% of premium' })).toEqual({ status: 'BLOCKED', text: 'Blocked — R:R 1.62R ≥ 1.50R · COST_TOO_HIGH: round trip 6.1% of premium' });
  });
  it('the binding R:R is the lower of the underlying R:R and the option net R:R', () => {
    expect(bindingRR(1.8, 1.42)).toBe(1.42);
    expect(bindingRR(null, 1.7)).toBe(1.7);
    expect(bindingRR(null, null)).toBeNull();
  });
});

describe('1–2. a confirmed setup at 1.40R stays visible and is re-evaluated under the same id', () => {
  it('S1: the engine\'s LOW_RR starts a keep-alive instead of being forgotten', () => {
    const ka = keepAliveStep(lowRrS1(), [bar(1, 99, 101, 98.5, 99)], M15, fill)!;
    expect(ka).toBeDefined();
    expect(ka.cause).toBe('LOW_RR_AT_CONFIRM');
    expect(ka.ended).toBeNull();
    expect(ka.lastBarTime).toBe(T0 + M15);
    expect(ka.grossRR).toBe(1.33);
    // A setup with a live outcome (traded / refused for good) is never kept alive.
    expect(keepAliveStep(lowRrS1({ live: { outcome: 'MINTED', reason: null, code: null, at: 1 } }), [], M15, fill)).toBeUndefined();
    // No T1 = not a confirmed trade plan: not kept.
    expect(keepAliveStep(lowRrS1({ t1: null }), [], M15, fill)).toBeUndefined();
  });

  it('each closed bar re-measures the same setup; only new bars are read', () => {
    const lc = lowRrS1();
    const b1 = bar(1, 99, 101, 98.5, 99);
    const b2 = bar(2, 99, 101.5, 98.8, 101);
    const k1 = keepAliveStep(lc, [b1], M15, fill)!;
    const k2 = keepAliveStep({ ...lc, keepAlive: k1 }, [b1, b2], M15, fill)!;
    expect(k2.since).toBe(k1.since);
    expect(k2.lastBarTime).toBe(b2.time);
    expect(k2.reference).toBe(101); // the close is inside the zone: a fill would happen there now
    // Re-running on the same bars changes nothing (idempotent per bar).
    expect(keepAliveStep({ ...lc, keepAlive: k2 }, [b1, b2], M15, fill)).toEqual(k2);
  });

  it('the watch keeps ONE row per id across evaluations (no duplicate candidate)', () => {
    const a = applyWatchUpdate(null, watchUpdate({ statusRR: 1.4, plan: planOf(8950) }));
    expect(a.events).toEqual(['WATCH_STARTED']);
    expect(a.row.statusText).toBe('Confirmed — R:R 1.40R < 1.50R');
    expect(a.row.startedBelowMin).toBe(true);
    const b = applyWatchUpdate(a.row, watchUpdate({ statusRR: 1.45, barTime: T0 + M15, at: T0 + M15, plan: planOf(8950) }));
    expect(b.events).toEqual(['REEVALUATED']);
    expect(b.row.id).toBe(a.row.id);
    expect(b.row.initial).toEqual(a.row.initial);
    expect(b.row.current.statusRR).toBe(1.45);
  });

  it('families: a confirmed LOW_RR candidate is kept under its original id and rebuilt by its own rule on later bars', () => {
    const { ctx, log, s, start } = familySession();
    const original = evaluateTriggersAt(ctx, log, start + 7, EVENT_ENGINE_TRIGGER_IDS).find((c) => c.triggerId === 'A2')!;
    expect(original.bucket).toBe('LOW_RR');
    expect(original.stopRef).toBeDefined();
    const rc = routedOf(original);
    const watch = [newFamilyWatch(rc, 'LOW_RR_AT_DECISION')];
    const next = advanceFamilyWatch(watch, ctx, log, start + 7, () => true);
    expect(next[0]).toEqual(watch[0]); // nothing new to read yet
    const rebuilt = rebuildCandidateAt(ctx, log, original, start + 8);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!).toMatchObject({ triggerId: 'A2', anchorEventId: original.anchorEventId, stopRef: original.stopRef, decisionIndex: start + 8 });
    expect(rebuilt!.entry).toBe(ctx.series.bars[start + 8].close);
    void s;
  });
});

describe('3–4. R:R moves from below 1.50R to ≥ 1.50R and the status turns Eligible', () => {
  it('S1: a close inside the zone is the achievable fill — R:R recovers from 1.33R to 2.5R', () => {
    const lc = lowRrS1();
    expect(grossRRFrom(lc, structureReference(lc, 99))).toBe(1.33); // below the zone: the limit
    expect(structureReference(lc, 102)).toBe(102);
    expect(grossRRFrom(lc, 102)).toBe(2.5);
  });
  it('Confirmed → Eligible on the same row, RR_RECOVERED recorded once, first-eligible time kept', () => {
    const a = applyWatchUpdate(null, watchUpdate({ statusRR: 1.4 })).row;
    const b = applyWatchUpdate(a, watchUpdate({ statusRR: 1.62, barTime: T0 + M15, at: T0 + M15 }));
    expect(b.events).toEqual(['REEVALUATED', 'RR_RECOVERED']);
    expect(b.row.status).toBe('ELIGIBLE');
    expect(b.row.statusText).toBe('Eligible — R:R 1.62R ≥ 1.50R');
    expect(b.row.rrRecovered).toBe(true);
    expect(b.row.firstEligibleAt).toBe(T0 + M15);
    const c = applyWatchUpdate(b.row, watchUpdate({ statusRR: 1.7, barTime: T0 + 2 * M15, at: T0 + 2 * M15 }));
    expect(c.events).toEqual(['REEVALUATED']); // recovered once, not again
    expect(c.row.firstEligibleAt).toBe(T0 + M15);
  });
  it('a recovered S1 is offered to the fill chain only at ≥ 1.50R at the live price, at most once per closed bar', () => {
    const ka: StructureKeepAlive = { since: T0, cause: 'LOW_RR_AT_CONFIRM', lastBarTime: null, lastAttemptBar: null, reference: 100, grossRR: 1.33, ended: null };
    const state = { lifecycles: [lowRrS1({ keepAlive: ka })] } as unknown as LiveState;
    expect(fillCandidate(state, 100.2, T0)).toBeNull(); // 1.41R at the live price: not yet
    expect(fillCandidate(state, 102, T0)?.id).toBe('NSE:NIFTY:BEARISH:1'); // 2.5R: offered
    const tried = { lifecycles: [lowRrS1({ keepAlive: { ...ka, lastAttemptBar: T0 } })] } as unknown as LiveState;
    expect(fillCandidate(tried, 102, T0)).toBeNull(); // already tried on this bar
    expect(fillCandidate(tried, 102, T0 + M15)?.id).toBe('NSE:NIFTY:BEARISH:1'); // the next bar may try again
    // The chain's own sequence gate still decides at the fill, and an R:R-only refusal is marked as such (kept alive).
    expect(structureSequenceRefusal(lowRrS1(), 100.2)?.rrOnly).toBe(true);
    expect(structureSequenceRefusal(lowRrS1(), 102)).toBeNull();
  });
});

describe('5. no duplicate candidate', () => {
  it('a kept-alive family candidate is handed to the slot once, under its original id', () => {
    const { ctx, log, start } = familySession();
    const original = evaluateTriggersAt(ctx, log, start + 7, EVENT_ENGINE_TRIGGER_IDS).find((c) => c.triggerId === 'A2')!;
    const rebuilt = { ...rebuildCandidateAt(ctx, log, original, start + 8)!, bucket: 'TRADE' as const, rToT1: 1.8 };
    const w: FamilyWatchEntry = { ...newFamilyWatch(routedOf(original), 'LOW_RR_AT_DECISION'), current: rebuilt, lastIndex: start + 8 };
    const stages = liveTriggerStages();
    const once = recoveredFamilyCandidates([w], start + 8, stages, null, []);
    expect(once.map((r) => r.lifecycleId)).toEqual([w.lifecycleId]);
    expect(once[0].lifecycleId).toBe(routedLifecycleId('NSE', 'NIFTY', original)); // the ORIGINAL id
    expect(recoveredFamilyCandidates([w], start + 8, stages, null, once)).toEqual([]); // already in the slot list
  });
  it('an ended row is never reopened', () => {
    const live = applyWatchUpdate(null, watchUpdate({})).row;
    const ended = applyWatchUpdate(live, endUpdateFor(live, 'SWEEP_RECLAIMED', T0 + M15)).row;
    expect(ended.status).toBe('ENDED');
    expect(applyWatchUpdate(ended, watchUpdate({ statusRR: 2 }))).toEqual({ row: ended, events: [] });
  });
});

describe('6. option strike, entry, SL, TSL and targets are recalculated', () => {
  it('a new closed bar rebuilds the premium levels; a strike change keeps the same id', () => {
    const a = applyWatchUpdate(null, watchUpdate({ plan: planOf(8950, 118) })).row;
    const b = applyWatchUpdate(a, watchUpdate({ plan: planOf(9000, 131), barTime: T0 + M15, at: T0 + M15 }));
    expect(b.events).toContain('STRIKE_CHANGED');
    expect(b.row.id).toBe(a.id);
    expect(b.row.strikeChanges).toBe(1);
    expect(b.row.plan!.strike).toBe(9000);
    expect(b.row.plan!.entryPremium).toBe(131);
    expect(b.row.initial.strike).toBe(8950);
  });
  it('premiums follow the underlying entry reference by the leg\'s delta (marked est.)', () => {
    const at = (reference: number) =>
      planFromLevels({ side: 'PE', strike: 25000, expiry: 'x', dte: 3, lotSize: 75, levels: { entry: 120, stopLoss: 90, target: 180 }, delta: -0.5, spot: 25000, reference, underlying: { sl: 25150, t1: 24800, t2: null }, grossRR: 1.5, netRR: 1.6, estimatedCostPct: 2, ranking: null, trail: { breakevenAtR: 1, lockAtR: 2 } });
    expect(at(25000)).toMatchObject({ entryPremium: 120, slPremium: 90, t1Premium: 180, estimated: false });
    expect(at(24950)).toMatchObject({ entryPremium: 145, slPremium: 115, t1Premium: 205, estimated: true }); // PE gains as the underlying falls
  });
});

describe('7–8. the best valid strike, deterministically; a failing strike falls through to the next', () => {
  const liquid = { volume: 50_000, oi: 500_000, theta: -2 };
  const putRow = (strike: number, over: Partial<OptionChainLeg>, dist = 0): OptionChainStrike => ({ strike, distanceFromSpot: dist, call: null, put: leg({ token: `PE${strike}`, ...over }) });
  const chain = {
    symbol: 'SYN',
    underlying: 'SYN',
    exchange: 'NSE',
    spotPrice: 25000,
    expiry: '2030-01-07',
    availableExpiries: ['2030-01-07'],
    dte: 3,
    strikeInterval: 100,
    atmStrike: 25000,
    lotSize: 75,
    strikes: [
      putRow(24900, { ...liquid, ltp: 50, bid: 49.9, ask: 50.1, delta: -0.4, moneyness: 'OTM' }, -100),
      putRow(25000, { ...liquid, ltp: 70, bid: 69.8, ask: 70.2, delta: -0.5, moneyness: 'ATM' }),
      putRow(25100, { ...liquid, ltp: 120, bid: 119.8, ask: 120.2, delta: -0.6, moneyness: 'ITM' }, 100),
    ],
    expectedMove: { points: 100, upperBound: 25100, lowerBound: 24900 },
  } as unknown as OptionChain;
  const ctx = { expectedMovePoints: 80, expectedHoldHours: 3, ivRank: null, hvPct: null, ivCap: null };
  const params = { deltaMin: 0.35, deltaMax: 0.65, deltaTarget: 0.5 };
  const ok = (strike: number, entry: number, stop: number, target: number): TradeSetup => ({ available: true, reason: '', strike, side: 'PE', entry, stopLoss: stop, target, estimatedCostPct: 2 });

  it('every in-band strike is built; the highest net R:R after costs wins — not the ATM, not the cheapest, not the highest delta', () => {
    const builds: Record<number, TradeSetup> = { 24900: ok(24900, 50, 40, 70), 25000: ok(25000, 70, 55, 100), 25100: ok(25100, 120, 95, 170) };
    const out = validateOnChain({ chain, side: 'PE', params, context: ctx, build: (_c, strike) => builds[strike] });
    const ranking = out.setup.fnoValidation!.strikeSelection!.ranking!;
    expect(ranking.map((r) => r.strike)).toHaveLength(3);
    const best = ranking[0];
    expect(best.netRR).toBe(Math.max(...ranking.map((r) => r.netRR!)));
    expect(out.setup.strike).toBe(best.strike);
    expect(out.setup.fnoValidation!.strikeSelection!.method).toBe('BEST_OF_BAND');
  });

  it('the top strike failing a hard check falls through to the next valid one', () => {
    const builds: Record<number, TradeSetup> = {
      24900: { available: false, reason: 'cost', noTradeCode: 'COST_TOO_HIGH' },
      25000: ok(25000, 70, 55, 100),
      25100: { available: false, reason: 'noise', noTradeCode: 'STOP_INSIDE_NOISE' },
    };
    const out = validateOnChain({ chain, side: 'PE', params, context: ctx, build: (_c, strike) => builds[strike] });
    expect(out.setup.available).toBe(true);
    expect(out.setup.strike).toBe(25000);
  });

  it('only when every strike fails is the setup refused — with the most specific reason; an R:R-only refusal keeps its plan', () => {
    const allFail: Record<number, TradeSetup> = {
      24900: { available: false, reason: 'cost', noTradeCode: 'COST_TOO_HIGH' },
      25000: { available: false, reason: 'rr', noTradeCode: 'REWARD_RISK_TOO_LOW', rrPlan: { entry: 70, stopLoss: 55, target: 88, riskReward: 1.2, riskRewardNet: 1.1, estimatedCostPct: 2, stopInAtr: 1.5, targetInAtr: 2, delta: -0.5 } },
      25100: { available: false, reason: 'noise', noTradeCode: 'STOP_INSIDE_NOISE' },
    };
    const out = validateOnChain({ chain, side: 'PE', params, context: ctx, build: (_c, strike) => allFail[strike] });
    expect(out.setup.available).toBe(false);
    expect(out.setup.noTradeCode).toBe('REWARD_RISK_TOO_LOW');
    expect(out.setup.rrPlan?.riskRewardNet).toBe(1.1);
  });

  it('the ranking is deterministic: any input order gives the same order', () => {
    const b = (strike: number, setup: TradeSetup, spreadPct = 0.4, delta = -0.5): StrikeBuild => ({ strike, delta, spreadPct, setup });
    const builds = [b(24900, ok(24900, 50, 40, 70), 0.4, -0.4), b(25000, ok(25000, 70, 55, 100)), b(25100, ok(25100, 120, 95, 170), 0.3, -0.6), b(25200, { available: false, reason: 'x', noTradeCode: 'COST_TOO_HIGH' })];
    const ref = rankStrikeBuilds(builds, 0.5, 25000).map((x) => x.strike);
    for (const perm of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) expect(rankStrikeBuilds(perm.map((i) => builds[i]), 0.5, 25000).map((x) => x.strike)).toEqual(ref);
    expect(ref[ref.length - 1]).toBe(25200); // a refused strike never outranks a tradeable one
    expect(strikeNetRR(ok(25000, 70, 55, 100))).toBe(Math.round(((100 - 70 - 1.4) / (70 - 55 + 1.4)) * 100) / 100);
  });
});

describe('9. option SL / TSL are premium values, never underlying prices', () => {
  it('an R:R refusal built with plan:true carries premium levels; without it the refusal is unchanged', () => {
    let found = false;
    for (let move = 5; move <= 300 && !found; move += 5) {
      const planned = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 80, move, undefined, null, 5, LOT, 50, { plan: true });
      if (planned.noTradeCode !== 'REWARD_RISK_TOO_LOW') continue;
      found = true;
      const p = planned.rrPlan!;
      expect(p.entry).toBeGreaterThan(p.stopLoss);
      expect(p.target).toBeGreaterThan(p.entry);
      expect(p.entry).toBeLessThan(1000); // a premium, not the 25,000 underlying
      expect(p.riskRewardNet!).toBeLessThan(1.5);
      const plain = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 80, move, undefined, null, 5, LOT, 50, {});
      expect(plain.rrPlan).toBeUndefined();
      expect({ ...planned, rrPlan: undefined }).toEqual({ ...plain, rrPlan: undefined });
    }
    expect(found).toBe(true);
  });
  it('the plan\'s SL and TSL are in premium; the TSL is the existing trailing rule in that premium', () => {
    const p = planOf(8950, 118);
    expect(p.slPremium).toBe(92);
    expect(p.tslPremium).toBe(92); // before entry the TSL is the initial SL
    expect(p.underlyingSl).toBe(106);
    expect(p.slPremium).not.toBe(p.underlyingSl);
    expect(p.tslRule).toBe('TSL = SL ₹92.00 until entry; then at +1R (premium ₹144.00) SL → entry ₹118.00; at +2R (₹170.00) SL → ₹144.00 (locks +1R).');
  });
});

describe('10. no future data', () => {
  it('S1 keep-alive state at bar k is identical whether or not later bars exist', () => {
    const lc = lowRrS1();
    const bars = [bar(1, 99, 101, 98.5, 99), bar(2, 99, 101.5, 98.8, 101), bar(3, 101, 104, 100, 103.5), bar(4, 103, 107, 102, 106.5)];
    const atTwo = advanceStructureKeepAlive(lc, keepAliveStep(lc, [], M15, fill)!, bars.slice(0, 2), M15, fill);
    const k = keepAliveStep(lc, [], M15, fill)!;
    const stepped = advanceStructureKeepAlive(lc, advanceStructureKeepAlive(lc, k, bars.slice(0, 2), M15, fill), bars, M15, fill);
    expect(atTwo.ended).toBeNull();
    expect(stepped.ended?.reason).toBe('STOP_TRADED'); // only once bar 4 exists
  });
  it('a family re-measure at bar i reads bars ≤ i only', () => {
    const { ctx, log, start, allBars } = familySession();
    const original = evaluateTriggersAt(ctx, log, start + 7, EVENT_ENGINE_TRIGGER_IDS).find((c) => c.triggerId === 'A2')!;
    const i = start + 8;
    const cut = prepareMomentumSeries(allBars.slice(0, i + 1));
    const cctx = buildSeriesContext(cut);
    const s = cut.sessionStarts.length - 1;
    const clog = runSessionEvents(cctx, s);
    expect(rebuildCandidateAt(cctx, clog, original, i)).toEqual(rebuildCandidateAt(ctx, log, original, i));
  });
});

describe('11. invalidation and expiry still end the setup', () => {
  const lc = lowRrS1();
  const k = keepAliveStep(lc, [], M15, fill)!;
  const endOn = (b: ClosedBar) => advanceStructureKeepAlive(lc, k, [b], M15, fill).ended?.reason;
  it('S1: stop traded, sweep reclaimed, T1 traded first, fill window over', () => {
    expect(endOn(bar(1, 104, 106.2, 103, 104))).toBe('STOP_TRADED');
    expect(endOn(bar(1, 104, 105.9, 103, 105.5))).toBe('SWEEP_RECLAIMED');
    expect(endOn(bar(1, 96, 97, 91.5, 93))).toBe('MISSED');
    const quiet = Array.from({ length: fill + 1 }, (_, j) => bar(j + 1, 99, 99.5, 98.5, 99));
    expect(advanceStructureKeepAlive(lc, k, quiet, M15, fill).ended?.reason).toBe('NO_FILL');
    expect(advanceStructureKeepAlive(lc, k, quiet.slice(0, fill), M15, fill).ended).toBeNull();
  });
  it('families: a close beyond the rule\'s invalidation, T1 traded, the window or the closing guard', () => {
    const { ctx, log, start } = familySession();
    const original = evaluateTriggersAt(ctx, log, start + 7, EVENT_ENGINE_TRIGGER_IDS).find((c) => c.triggerId === 'A2')!;
    const w = newFamilyWatch(routedOf(original), 'LOW_RR_AT_DECISION');
    // The session falls straight through A2's tiny T1 on the next bar: the move it was confirmed for is gone.
    expect(advanceFamilyWatch([w], ctx, log, start + 8, () => true)[0].ended?.reason).toBe('MISSED');
    const noT1 = { ...w, original: { ...original, t1: null } };
    expect(advanceFamilyWatch([noT1], ctx, log, start + 8, () => false)[0].ended?.reason).toBe('EXPIRED_CLOSING_GUARD');
    const late = start + 7 + FAMILY_WATCH_BARS + 1;
    expect(advanceFamilyWatch([noT1], ctx, log, late, () => true)[0].ended?.reason).toMatch(/EXPIRED|NO_TARGET|INVALIDATED/);
    const high = { ...w, original: { ...original, t1: null, stopRef: 50 } }; // every close is above a 50 invalidation for a short
    expect(advanceFamilyWatch([high], ctx, log, start + 8, () => true)[0].ended?.reason).toBe('INVALIDATED');
  });
  it('the 1.50R minimum is not relaxed anywhere: the sequence gate still refuses below it', () => {
    expect(structureSequenceRefusal(lowRrS1(), 100)?.code).toBe('STRUCTURE_SEQUENCE');
    expect(STRUCTURE_RULES.minT1R).toBe(1.5);
  });
});

// ---------------- fixtures ----------------

function familySession() {
  const ist = (s: string) => Date.parse(`${s}+05:30`);
  const session = (date: string, path: Array<[number, number, number, number]>): MomentumBar[] =>
    path.map(([open, high, low, close], k) => ({ time: ist(`${date}T09:15:00`) + k * M15, open, high, low, close, volume: 0 }));
  const quiet = (date: string): MomentumBar[] =>
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
    [95, 96, 90, 91],
    ...Array.from({ length: 16 }, (_, k) => [91 - k, 92 - k, 88 - k, 89 - k] as [number, number, number, number]),
  ]);
  const allBars = [...days.flatMap(quiet), ...today];
  const series = prepareMomentumSeries(allBars);
  const ctx = buildSeriesContext(series);
  const s = series.sessionDates.indexOf('2026-08-10');
  const log = runSessionEvents(ctx, s);
  return { ctx, log, s, start: series.sessionStarts[s], allBars };
}

function routedOf(c: TriggerCandidate): RoutedCandidate {
  return {
    candidate: c,
    stage: liveTriggerStages()[c.triggerId],
    risk: validateCandidateRisk(c, { sessionOk: true, costPct: 2, maxCostPct: 5 }),
    cost: null,
    lifecycleId: routedLifecycleId('NSE', 'NIFTY', c),
    parentId: 'P1',
    anchorKeys: ['P1', c.anchorEventId],
  };
}
