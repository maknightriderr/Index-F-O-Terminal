// ============================================================
// MEASUREMENT GAPS (2026-10-09) — cost components, post-exit excursion, payoff
// grader V2, the conservative-fill scenario and the data-integrity rules.
// ============================================================
// Measurement only. The proofs that matter most here are the negative ones:
// the cost parts add up to the live estimate EXACTLY (so no gate can differ),
// nothing mutates a setup or a stored trade, missing data is never turned into
// a touch or a miss, and EXPIRED / voided / lost rows never leak into a rate.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTradeSetup, estimateRoundTripCost } from '@fno/analytics';
import { TRADING_COST_MODEL } from '@fno/shared';
import { GOLDEN_CASES } from './trade-setup-fixtures.js';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK', del: async () => 1 }, scanKeys: async () => [] }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const C = await import('../trade-costs.js');
const P = await import('../post-exit-tracker.js');
const G = await import('../payoff-grader-v2.js');
const M = await import('../measurement-core.js');
const SEM = await import('../signal-engine-metrics.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 1. cost components
describe('trade cost components', () => {
  it('the parts add up to the live estimate on every available golden setup (so no gate or ranking can differ)', () => {
    let checked = 0;
    for (const args of Object.values(GOLDEN_CASES)) {
      const a = args();
      const setup = buildTradeSetup(...a);
      if (!setup.available || setup.structureType !== 'NAKED_LONG') continue;
      const strikes = a[0] as any[];
      const rec = C.costRecordForSetup(setup, { strikes, lotSize: a[8] as number });
      expect(rec, 'record built').not.toBeNull();
      // The builder's own number, from its own quote.
      const leg = C.legOfSetup({ strikes }, setup)!;
      const live = estimateRoundTripCost(setup.entry!, leg.bid, leg.ask, (a[8] as number) ?? 0);
      expect(rec!.total.perUnit).toBeCloseTo(live.perUnit, 3);
      expect(rec!.total.pctOfEntry).toBeCloseTo(live.pct, 2);
      expect(rec!.reconciliation.matchesSetup, 'agrees with TradeSetup.estimatedCostPct').toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('every component is labelled; nothing is presented as an actual fill', () => {
    const r = C.buildCostRecord({ entry: 100, stopLoss: 70, target: 111, bid: 99.5, ask: 100.5, lotSize: 75 })!;
    expect(r.basis).toBe('ESTIMATED_MODEL');
    expect(r.actual).toBeNull();
    expect(r.actualNote).toMatch(/no actual fill/i);
    expect(r.spread.source).toBe('QUOTE');
    expect(r.slippage.assumedPct).toBe(TRADING_COST_MODEL.slippagePct);
    expect(r.statutory.assumedPct).toBe(TRADING_COST_MODEL.statutoryPct);
    expect(r.otherConfigured).toEqual([]);
    expect(r.brokerage.orders).toBe(2);
    expect(r.gstOnBrokerage.gstPct).toBe(TRADING_COST_MODEL.gstPct);
  });

  it('derives cost in R and as a share of the planned gross profit from the mint geometry', () => {
    const r = C.buildCostRecord({ entry: 100, stopLoss: 70, target: 111, bid: 99.5, ask: 100.5, lotSize: 75 })!;
    // spread 1 + slippage 1 + statutory 0.2 + brokerage 2×20/75 + GST 7.2/75
    const total = 1 + 1 + 0.2 + 40 / 75 + 7.2 / 75;
    expect(r.total.perUnit).toBeCloseTo(total, 3);
    expect(r.costR).toBeCloseTo(total / 30, 3);
    expect(r.costPctOfPlannedGrossProfit).toBeCloseTo((total / 11) * 100, 1);
    expect(r.total.perLotInr).toBeCloseTo(total * 75, 1);
  });

  it('a missing quote uses the model fallback and says so; a missing lot size drops brokerage, flagged by a null lot', () => {
    const r = C.buildCostRecord({ entry: 100, stopLoss: 70, target: 111, bid: null, ask: null, lotSize: null })!;
    expect(r.spread.source).toBe('FALLBACK_ASSUMED');
    expect(r.spread.assumedPct).toBe(TRADING_COST_MODEL.fallbackSpreadPct);
    expect(r.inputs.lotSize).toBeNull();
    expect(r.brokerage.perUnit).toBe(0);
    expect(r.total.perLotInr).toBeNull();
    expect(C.buildCostRecord({ entry: 0, stopLoss: 0, target: 1, bid: 1, ask: 2, lotSize: 1 })).toBeNull();
  });

  it('cost R / share of profit are null without a positive risk / gain — never a flat default', () => {
    const noRisk = C.buildCostRecord({ entry: 100, stopLoss: 100, target: 111, bid: 99, ask: 101, lotSize: 75 })!;
    expect(noRisk.costR).toBeNull();
    const noGain = C.buildCostRecord({ entry: 100, stopLoss: 70, target: 100, bid: 99, ask: 101, lotSize: 75 })!;
    expect(noGain.costPctOfPlannedGrossProfit).toBeNull();
  });

  it('building a record never mutates the setup or the chain it reads', () => {
    const a = GOLDEN_CASES['p2 default args']();
    const setup = buildTradeSetup(...a);
    const chain = { strikes: a[0] as any[], lotSize: 75 };
    const before = JSON.stringify({ setup, chain });
    C.costRecordForSetup(setup, chain);
    expect(JSON.stringify({ setup, chain })).toBe(before);
  });

  it('spreads and refusals have no cost record', () => {
    expect(C.costRecordForSetup({ available: false } as any, { strikes: [], lotSize: 1 })).toBeNull();
    expect(C.costRecordForSetup({ available: true, structureType: 'SPREAD', entry: 1, stopLoss: 1, target: 2 } as any, { strikes: [], lotSize: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------- 2. post-exit excursion
function watch(over: Partial<ReturnType<typeof baseWatch>> = {}) {
  return { ...baseWatch(), ...over };
}
function baseWatch() {
  const built = P.buildPostExitWatch(
    { signalId: 'sig-1', side: 'CE', strike: 25000, expiry: '2026-10-15', entry: 100, initialStopLoss: 70, target: 111, excursion: { underlyingEntry: 25000, atrAtEntry: 20 } },
    { symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', outcome: 'WIN', reason: 'TARGET', exitPrice: 111, exitAt: Date.parse('2026-10-12T10:00:00+05:30') }
  );
  if (!('watch' in built)) throw new Error('expected a watch: ' + JSON.stringify(built));
  return built.watch;
}
const T0 = Date.parse('2026-10-12T10:00:00+05:30');

describe('post-exit excursion', () => {
  it('watches until the session ends, not beyond', () => {
    const w = baseWatch();
    expect(w.endAt).toBeGreaterThan(T0);
    expect(w.endAt - T0).toBeLessThanOrEqual(P.POST_EXIT_MAX_WATCH_MS);
    // NSE closes 15:30 IST: 5.5 hours after 10:00.
    expect(w.endAt - T0).toBe(5.5 * 3_600_000);
  });

  it('a close after the session has ended is NOT_WATCHED with the reason, never silently skipped', () => {
    const r = P.buildPostExitWatch(
      { signalId: 's', side: 'CE', strike: 1, entry: 100, initialStopLoss: 70, target: 111 },
      { symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', outcome: 'EXPIRED', reason: 'SESSION_ENDED', exitPrice: 90, exitAt: Date.parse('2026-10-12T15:45:00+05:30') }
    );
    expect(r).toMatchObject({ skip: 'NOT_WATCHED' });
    const stub = baseWatch();
    const rec = P.finalizePostExit({ ...stub, endAt: stub.exitAt }, { status: 'NOT_WATCHED', why: 'no session time left after the exit' });
    expect(rec.status).toBe('NOT_WATCHED');
    expect(rec.basis).toBe('NONE');
    expect(rec.option.maxAfter).toBeNull();
  });

  it('spreads, unpriced contracts and rows without a signal are not applicable', () => {
    const close = { symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', outcome: 'WIN', reason: 'TARGET', exitPrice: 1, exitAt: T0 };
    expect(P.buildPostExitWatch({ signalId: 's', structureType: 'SPREAD', side: 'CE', strike: 1, entry: 1 }, close)).toMatchObject({ skip: 'NOT_APPLICABLE' });
    expect(P.buildPostExitWatch({ signalId: null, side: 'CE', strike: 1, entry: 1 }, close)).toMatchObject({ skip: 'NOT_APPLICABLE' });
    expect(P.buildPostExitWatch({ signalId: 's', side: null, strike: 1, entry: 1 }, close)).toMatchObject({ skip: 'NOT_APPLICABLE' });
  });

  it('folds the best and worst price after the exit, with their times, without touching the exit', () => {
    let w = baseWatch();
    const frozen = JSON.stringify(w);
    const obs = [
      { at: T0 + 60_000, premium: 112, underlying: 25030 },
      { at: T0 + 120_000, premium: 118, underlying: 25060 },
      { at: T0 + 180_000, premium: 104, underlying: 25010 },
    ];
    for (const o of obs) w = P.foldPostExitObservation(w, { ...o, via: 'SWEEP' });
    expect(JSON.stringify(baseWatch())).toBe(frozen); // the pure builder is repeatable
    const rec = P.finalizePostExit(w);
    expect(rec.status).toBe('OBSERVED');
    expect(rec.basis).toBe('OBSERVED_SAMPLED');
    expect(rec.exitPrice).toBe(111); // untouched
    expect(rec.outcome).toBe('WIN');
    expect(rec.option.maxAfter).toBe(118);
    expect(rec.option.maxAfterAt).toBe(T0 + 120_000);
    expect(rec.option.minAfter).toBe(104);
    expect(rec.option.maxBeyondExit).toBe(7);
    expect(rec.option.maxBeyondExitR).toBeCloseTo(7 / 30, 3); // R = entry − initial stop
    expect(rec.option.peakThroughTargetR).toBeCloseTo(7 / 30, 3);
    expect(rec.option.returnedToEntry).toBe(false);
    expect(rec.option.minutesToPeak).toBe(2);
    expect(rec.underlying.maxFavVsEntry).toBe(60);
    expect(rec.underlying.maxFavVsEntryAtr).toBe(3);
    expect(rec.observations.total).toBe(3);
  });

  it('the underlying excursion is signed to the trade: a put gains when the underlying falls', () => {
    const put = { ...baseWatch(), side: 'PE' as const, bullish: false };
    const w = P.foldPostExitObservation(put, { at: T0 + 60_000, premium: 112, underlying: 24950, via: 'SWEEP' });
    expect(w.underlying.maxFavVsEntry).toBe(50);
    expect(w.underlying.maxAdvVsEntry).toBe(-50);
  });

  it('an observation outside (exit, end], or a price outside the sanity band, is not used — and is counted, not guessed at', () => {
    const w0 = baseWatch();
    const before = P.foldPostExitObservation(w0, { at: T0, premium: 150, underlying: 26000, via: 'SWEEP' });
    const after = P.foldPostExitObservation(w0, { at: w0.endAt + 1, premium: 150, underlying: 26000, via: 'SWEEP' });
    expect(before.obs.total).toBe(0);
    expect(after.obs.total).toBe(0);
    const bad = P.foldPostExitObservation(w0, { at: T0 + 1000, premium: 111 * 5, underlying: null, via: 'TICK' });
    expect(bad.obs.total).toBe(0);
    expect(bad.obs.rejected).toBe(1);
    expect(bad.option.max).toBeNull();
    const none = P.foldPostExitObservation(w0, { at: T0 + 1000, premium: null, underlying: null, via: 'SWEEP' });
    expect(none).toBe(w0);
  });

  it('with no usable observation the record says NO_DATA and carries no number', () => {
    const rec = P.finalizePostExit(baseWatch());
    expect(rec.status).toBe('NO_DATA');
    expect(rec.basis).toBe('NONE');
    expect(rec.option.maxAfter).toBeNull();
    expect(rec.option.maxBeyondExitR).toBeNull();
    expect(rec.observations.maxGapSeconds).toBeNull();
    expect(rec.note).toMatch(/nothing is inferred/);
  });

  it('records how patchy the sampling was: largest gap including the stretch to the end of the watch', () => {
    let w = baseWatch();
    w = P.foldPostExitObservation(w, { at: T0 + 90_000, premium: 112, underlying: 25010, via: 'SWEEP' });
    w = P.foldPostExitObservation(w, { at: T0 + 100_000, premium: 113, underlying: 25011, via: 'TICK' });
    const rec = P.finalizePostExit(w);
    expect(rec.observations.tick).toBe(1);
    expect(rec.observations.sweep).toBe(1);
    // The last observation is 100 s in; the watch runs 5.5 h — that tail is the largest gap.
    expect(rec.observations.maxGapSeconds).toBe(Math.round((w.endAt - (T0 + 100_000)) / 1000));
    expect(rec.observations.coveragePct!).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------- 3. payoff grader V2
const E0 = Date.parse('2026-10-12T10:00:00+05:30');
const base = (over: Partial<Parameters<typeof G.gradeOptionPayoffV2>[0]> = {}): Parameters<typeof G.gradeOptionPayoffV2>[0] => ({
  entry: 100,
  target: 111,
  initialStop: 70,
  outcome: 'WIN',
  closeReason: 'TARGET',
  exitPrice: 111,
  entryAt: E0,
  exitAt: E0 + 30 * 60_000,
  projectedPayoff: null,
  observations: [],
  ...over,
});
const verdictOf = (i: Parameters<typeof G.gradeOptionPayoffV2>[0]) => (G.gradeOptionPayoffV2(i).actual as any).verdict;

describe('OPTION_PAYOFF_V2', () => {
  it('a recorded target exit is CORROBORATED by the monitor\'s own extreme — even when no chain mid reached it (the first grader\'s blind spot)', () => {
    const obs = [
      ...G.monitorExtremes(100, { premiumMfe: 111.4, premiumMfeAt: E0 + 20 * 60_000 }),
      { at: E0 + 15 * 60_000, premium: 104, source: 'CHAIN_SNAPSHOT' as const },
      { at: E0 + 30 * 60_000, premium: 109, source: 'CHAIN_SNAPSHOT' as const },
    ];
    const out = G.gradeOptionPayoffV2(base({ observations: obs, legacy: { targetReached: false, marks: 2 } }));
    const a = out.actual as any;
    expect(a.verdict).toBe('CORROBORATED');
    expect(a.targetLevel.observedBy).toBe('MONITOR_EXTREME');
    expect(a.legacyContradictedRecordedExit).toBe(true);
  });

  it('sparse data that never reaches the target is NOT_CORROBORATED, not a contradiction', () => {
    const obs = [{ at: E0 + 15 * 60_000, premium: 104, source: 'CHAIN_SNAPSHOT' as const }];
    expect(verdictOf(base({ observations: obs }))).toBe('NOT_CORROBORATED');
  });

  it('only continuous observations that never reach the target contradict a recorded target exit', () => {
    const dense = Array.from({ length: 31 }, (_, k) => ({ at: E0 + (k + 1) * 60_000 - (k === 30 ? 60_000 : 0), premium: 103, source: 'CHAIN_SNAPSHOT' as const }));
    const a = G.gradeOptionPayoffV2(base({ observations: dense })).actual as any;
    expect(a.observations.dense).toBe(true);
    expect(a.verdict).toBe('CONTRADICTED_DENSE');
  });

  it('no observation at all is UNVERIFIABLE — no touch and no miss is inferred', () => {
    const a = G.gradeOptionPayoffV2(base({ observations: [] })).actual as any;
    expect(a.verdict).toBe('UNVERIFIABLE');
    expect(a.maxPremiumObserved).toBeNull();
    expect(a.projectionCaptured).toBeNull();
    expect(a.observations.maxGapSeconds).toBeNull();
  });

  it('a missing exit time is UNVERIFIABLE, and observations outside the holding window are ignored', () => {
    expect(verdictOf(base({ exitAt: null, observations: [{ at: E0 + 1, premium: 120, source: 'MONITOR_EXTREME' }] }))).toBe('UNVERIFIABLE');
    const outside = [
      { at: E0 - 1000, premium: 120, source: 'CHAIN_SNAPSHOT' as const },
      { at: E0 + 31 * 60_000, premium: 120, source: 'CHAIN_SNAPSHOT' as const },
    ];
    expect(verdictOf(base({ observations: outside }))).toBe('UNVERIFIABLE');
  });

  it('a recorded stop exit is graded against the initial stop level; the stop may overshoot', () => {
    const lossInput = base({ outcome: 'LOSS', closeReason: 'STOP_LOSS', exitPrice: 66, observations: [{ at: E0 + 10 * 60_000, premium: 66, source: 'MONITOR_EXTREME' }] });
    expect(verdictOf(lossInput)).toBe('CORROBORATED');
    expect(verdictOf({ ...lossInput, observations: [{ at: E0 + 10 * 60_000, premium: 85, source: 'CHAIN_SNAPSHOT' }] })).toBe('NOT_CORROBORATED');
  });

  it('flags a level observed before an exit that did not record it — as a review flag, nothing is changed', () => {
    const expired = base({ outcome: 'EXPIRED', closeReason: 'SESSION_ENDED', exitPrice: 95, observations: [{ at: E0 + 10 * 60_000, premium: 112, source: 'MONITOR_EXTREME' }] });
    expect(verdictOf(expired)).toBe('TARGET_SEEN_NOT_RECORDED');
    expect(verdictOf({ ...expired, observations: [{ at: E0 + 10 * 60_000, premium: 98, source: 'CHAIN_SNAPSHOT' }] })).toBe('NO_CONFLICT');
    expect(verdictOf({ ...expired, observations: [] })).toBe('UNVERIFIABLE');
  });

  it('monitorExtremes keeps only timed extremes that actually moved', () => {
    expect(G.monitorExtremes(100, { premiumMfe: 100, premiumMfeAt: null, premiumMae: 100, premiumMaeAt: null })).toEqual([]);
    expect(G.monitorExtremes(100, { premiumMfe: 112, premiumMfeAt: E0 + 5, premiumMae: 92, premiumMaeAt: E0 + 3 })).toHaveLength(2);
    expect(G.monitorExtremes(100, null)).toEqual([]);
  });

  it('the grade carries its own version and never alters its input', () => {
    const input = base({ observations: [{ at: E0 + 60_000, premium: 112, source: 'MONITOR_EXTREME' }] });
    const frozen = JSON.stringify(input);
    const a = G.gradeOptionPayoffV2(input).actual as any;
    expect(JSON.stringify(input)).toBe(frozen);
    expect(a.grader).toBe('OPTION_PAYOFF_V2');
    expect(a.version).toBe(G.PAYOFF_GRADER_VERSION);
  });
});

// ---------------------------------------------------------------- 4. conservative fill
const trade = (over: Partial<ReturnType<typeof baseTrade>> = {}) => ({ ...baseTrade(), ...over });
function baseTrade() {
  return {
    id: 't1',
    symbol: 'NIFTY',
    exchange: 'NSE',
    family: 'INDICATOR',
    mintedAt: Date.parse('2026-10-12T10:00:00+05:30'),
    mode: 'INTRADAY',
    structureType: 'NAKED_LONG',
    outcome: 'WIN' as string | null,
    closeReason: 'TARGET' as string | null,
    voided: false,
    generatedOffSession: false,
    entry: 100 as number | null,
    initialStop: 70 as number | null,
    target: 111 as number | null,
    exitPrice: 111 as number | null,
    estimatedCostPct: 3 as number | null,
    cost: null as null | { spreadPerUnit: number; spreadSource: 'QUOTE' | 'FALLBACK_ASSUMED'; totalPerUnit: number },
  };
}

describe('CONSERVATIVE_FILL_V1', () => {
  it('is fixed, documented and frozen', () => {
    expect(M.CONSERVATIVE_FILL.id).toBe('CONSERVATIVE_FILL_V1');
    expect(M.CONSERVATIVE_FILL.HALF_SPREAD_FRACTION).toBe(0.5);
    expect(M.CONSERVATIVE_FILL.MIN_TICK).toBe(0.05);
    expect(Object.isFrozen(M.CONSERVATIVE_FILL)).toBe(true);
    expect(() => {
      (M.CONSERVATIVE_FILL as any).HALF_SPREAD_FRACTION = 0;
    }).toThrow();
  });

  it('a target exit gives back half the quoted spread (never under one tick); baseline is untouched', () => {
    const f = M.fillScenarioOf(trade({ cost: { spreadPerUnit: 2, spreadSource: 'QUOTE', totalPerUnit: 4 } }))!;
    expect(f.appliesToExit).toBe(true);
    expect(f.haircut).toBe(1);
    expect(f.spreadBasis).toBe('QUOTE');
    expect(f.baselineGrossR).toBeCloseTo(11 / 30, 3);
    expect(f.conservativeGrossR).toBeCloseTo(10 / 30, 3);
    // cost R = 3% × 100 / 30 = 0.1, deducted from both
    expect(f.baselineNetR).toBeCloseTo(11 / 30 - 0.1, 3);
    expect(f.conservativeNetR).toBeCloseTo(10 / 30 - 0.1, 3);
    const tight = M.fillScenarioOf(trade({ cost: { spreadPerUnit: 0.02, spreadSource: 'QUOTE', totalPerUnit: 1 } }))!;
    expect(tight.haircut).toBe(0.05);
  });

  it('without a recorded quote it uses the cost model\'s fallback spread and says so', () => {
    const f = M.fillScenarioOf(trade())!;
    expect(f.spreadBasis).toBe('FALLBACK_ASSUMED');
    expect(f.haircut).toBeCloseTo(1, 6); // 0.5 × 2% × 100
  });

  it('stops, expiries and non-target closes are not haircut', () => {
    for (const t of [trade({ outcome: 'LOSS', closeReason: 'STOP_LOSS', exitPrice: 66 }), trade({ outcome: 'EXPIRED', closeReason: 'SESSION_ENDED', exitPrice: 95 }), trade({ outcome: 'WIN', closeReason: 'TRAILING_STOP', exitPrice: 105 })]) {
      const f = M.fillScenarioOf(t)!;
      expect(f.appliesToExit).toBe(false);
      expect(f.conservativeGrossR).toBe(f.baselineGrossR);
      expect(f.haircut).toBeNull();
      expect(f.spreadBasis).toBe('NOT_APPLICABLE');
    }
  });

  it('flags a win that the haircut turns into a loss; no cost → no net figure, never a default', () => {
    const f = M.fillScenarioOf(trade({ exitPrice: 100.5, cost: { spreadPerUnit: 4, spreadSource: 'QUOTE', totalPerUnit: 6 } }))!;
    expect(f.winBecomesLoss).toBe(true);
    const nc = M.fillScenarioOf(trade({ estimatedCostPct: null }))!;
    expect(nc.baselineNetR).toBeNull();
    expect(nc.conservativeNetR).toBeNull();
  });
});

// ---------------------------------------------------------------- 5. integrity
const at = (s: string) => Date.parse(s);

describe('cohorts', () => {
  it('splits by mint time at the two fixed boundaries; the 5 October baseline equals the existing constant', () => {
    expect(M.BASELINE_CHANGE_AT).toBe(SEM.ARCHITECTURE_CHANGE_AT);
    expect(M.cohortOf(at('2026-10-05T11:59:59Z'))).toBe('PRE');
    expect(M.cohortOf(at('2026-10-05T12:00:00Z'))).toBe('POST_A');
    expect(M.cohortOf(at('2026-10-08T21:37:59Z'))).toBe('POST_A');
    expect(M.cohortOf(at('2026-10-08T21:38:00Z'))).toBe('POST_B');
  });

  it('the tracking-fix instant is after the merge of PR #33 and the reliable-from date is a later trading day', () => {
    expect(M.TRACKING_FIX_DEPLOYED_AT).toBeGreaterThan(at('2026-10-09T03:04:37+05:30') - 6 * 3_600_000);
    expect(new Date(M.MEASUREMENT_RELIABLE_FROM).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Kolkata' })).toBe('Monday');
    expect(M.MEASUREMENT_RELIABLE_FROM).toBeGreaterThan(M.TRACKING_FIX_DEPLOYED_AT);
  });
});

describe('eligibility and denominators', () => {
  it('classifies every row into exactly one population, in a fixed order', () => {
    expect(M.eligibilityOf(trade())).toBe('ELIGIBLE');
    expect(M.eligibilityOf(trade({ voided: true }))).toBe('VOIDED');
    expect(M.eligibilityOf(trade({ voided: true, closeReason: 'TRACKING_LOST', outcome: 'EXPIRED', exitPrice: null }))).toBe('TRACKING_LOST');
    expect(M.eligibilityOf(trade({ generatedOffSession: true }))).toBe('OFF_SESSION');
    expect(M.eligibilityOf(trade({ structureType: 'SPREAD' }))).toBe('SPREAD');
    expect(M.eligibilityOf(trade({ outcome: null, exitPrice: null }))).toBe('OPEN');
    expect(M.eligibilityOf(trade({ exitPrice: null }))).toBe('NO_GEOMETRY');
    expect(M.eligibilityOf(trade({ initialStop: 100 }))).toBe('NO_GEOMETRY');
  });

  const mixed = [
    trade({ id: 'w1' }),
    trade({ id: 'w2' }),
    trade({ id: 'l1', outcome: 'LOSS', closeReason: 'STOP_LOSS', exitPrice: 66 }),
    trade({ id: 'x1', outcome: 'EXPIRED', closeReason: 'SESSION_ENDED', exitPrice: 95 }),
    trade({ id: 'x2', outcome: 'EXPIRED', closeReason: 'SESSION_ENDED', exitPrice: 97 }),
    trade({ id: 'v1', voided: true, outcome: 'WIN' }),
    trade({ id: 'lost', voided: true, closeReason: 'TRACKING_LOST', outcome: 'EXPIRED', exitPrice: null }),
    trade({ id: 'open', outcome: null, exitPrice: null }),
  ];

  it('EXPIRED is its own category; voided, lost and open rows are counted but never enter a rate', () => {
    const t = M.tallyOf(mixed);
    expect(t.rows).toBe(8);
    expect(t.n).toBe(5);
    expect(t.wins).toBe(2);
    expect(t.losses).toBe(1);
    expect(t.expired).toBe(2);
    expect(t.excluded).toMatchObject({ VOIDED: 1, TRACKING_LOST: 1, OPEN: 1 });
    expect(t.winRateClosedOnly).toBeCloseTo((2 / 3) * 100, 0); // wins / (wins + losses)
    expect(t.winRateAllTrades).toBe(40); // wins / (wins + losses + expired)
    expect(t.expiredShare).toBe(40);
  });

  it('names the denominator of every metric; net R is comparable only with gross R over the same trades', () => {
    const rows = [...mixed, trade({ id: 'nc', estimatedCostPct: null })];
    const t = M.tallyOf(rows);
    expect(t.denominators).toEqual({ winRateClosedOnly: 4, winRateAllTrades: 6, expiredShare: 6, grossR: 6, netR: 5 });
    expect(t.baseline.nNet).toBe(5);
    // gross over all 6 differs from gross over the 5 that have a net: the report gives both, labelled
    expect(t.baseline.grossRSameTradesAsNet).not.toBe(t.baseline.grossR);
    expect(t.baseline.netR!).toBeLessThan(t.baseline.grossRSameTradesAsNet!);
  });

  it('baseline and conservative results come from the same trades', () => {
    const t = M.tallyOf(mixed);
    expect(t.baseline.nNet).toBe(t.conservative.nNet);
    expect(t.targetExits.n).toBe(2);
    expect(t.conservative.grossR!).toBeLessThan(t.baseline.grossR!);
    expect(t.targetExits.spreadFallback).toBe(2);
  });

  it('never pools cohorts, families or instruments', () => {
    const rows = [
      trade({ id: 'a', mintedAt: at('2026-10-01T05:00:00Z') }),
      trade({ id: 'b', mintedAt: at('2026-10-06T05:00:00Z') }),
      trade({ id: 'c', mintedAt: at('2026-10-09T05:00:00Z'), family: 'S1' }),
      trade({ id: 'd', mintedAt: at('2026-10-09T05:00:00Z'), family: 'S1', symbol: 'CRUDEOIL', exchange: 'MCX' }),
    ];
    const g = M.groupTallies(rows);
    expect(g.byCohort.map((c) => [c.cohort, c.tally.n])).toEqual([['PRE', 1], ['POST_A', 1], ['POST_B', 2]]);
    expect(g.byFamily.map((c) => [c.cohort, c.family, c.tally.n])).toEqual([['PRE', 'INDICATOR', 1], ['POST_A', 'INDICATOR', 1], ['POST_B', 'S1', 2]]);
    expect(g.byInstrument.filter((c) => c.cohort === 'POST_B').map((c) => [c.family, c.instrument, c.tally.n])).toEqual([['S1', 'CRUDEOIL', 1], ['S1', 'NIFTY', 1]]);
    const sum = g.byCohort.reduce((s, c) => s + c.tally.rows, 0);
    expect(sum).toBe(rows.length); // each trade is in exactly one cohort
  });

  it('empty groups give null rates, not zero', () => {
    const t = M.tallyOf([]);
    expect(t.n).toBe(0);
    expect(t.winRateClosedOnly).toBeNull();
    expect(t.baseline.grossR).toBeNull();
  });
});

describe('summaries of the new records', () => {
  it('cost summary stays labelled as a model and reports the reconciliation', () => {
    const recs = [
      C.buildCostRecord({ entry: 100, stopLoss: 70, target: 111, bid: 99, ask: 101, lotSize: 75, setupEstimatedCostPct: 3.83 }),
      C.buildCostRecord({ entry: 100, stopLoss: 70, target: 111, bid: null, ask: null, lotSize: 75 }),
    ];
    const s = M.summariseCostRecords(recs);
    expect(s.basis).toBe('ESTIMATED_MODEL');
    expect(s.n).toBe(2);
    expect(s.spreadFromQuote).toBe(1);
    expect(s.spreadFallbackAssumed).toBe(1);
    expect(s.reconcilesWithSetupCost).toEqual({ matches: 1, checked: 1 });
  });

  it('post-exit summary keeps target exits apart from stops and expiries, and NO_DATA / NOT_WATCHED out of the figures', () => {
    const rec = (beyondR: number) => ({ option: { maxBeyondExitR: beyondR, maxBeyondExitPct: beyondR * 20, returnedToEntry: false, minutesToPeak: 10 }, underlying: { maxFavVsEntryAtr: 1.5 }, observations: { total: 20, maxGapSeconds: 95 } });
    const s = M.summarisePostExit([
      { status: 'OBSERVED', outcome: 'WIN', record: rec(0.6) },
      { status: 'OBSERVED', outcome: 'WIN', record: rec(0.1) },
      { status: 'OBSERVED', outcome: 'LOSS', record: rec(0) },
      { status: 'NO_DATA', outcome: 'WIN', record: {} },
      { status: 'NOT_WATCHED', outcome: 'EXPIRED', record: {} },
    ]);
    expect(s.byStatus).toEqual({ OBSERVED: 3, NO_DATA: 1, NOT_WATCHED: 1 });
    expect(s.targetExits.n).toBe(2);
    expect(s.targetExits.shareBeyondExitAtLeast['0.5R']).toBe(50);
    expect(s.stopExits.n).toBe(1);
    expect(s.expired.n).toBe(0);
  });

  it('payoff summary counts how often the first grader contradicted a recorded target exit and V2 corroborated it', () => {
    const row = (verdict: string, legacy: boolean | null) => ({ actual: { verdict, recorded: { outcome: 'WIN', closeReason: 'TARGET' }, legacy: { targetReached: legacy } } });
    const s = M.summarisePayoffV2([row('CORROBORATED', false), row('CORROBORATED', true), row('NOT_CORROBORATED', false), row('UNVERIFIABLE', null)]);
    expect(s.recordedTargetExits.n).toBe(4);
    expect(s.recordedTargetExits.corroborated).toBe(2);
    expect(s.firstGraderComparison).toEqual({ recordedTargetExitsWithAFirstGrade: 3, firstGraderSaidTargetNotReached: 2, ofThose_v2Corroborated: 1 });
  });
});

// ---------------------------------------------------------------- 6. nothing decides from these
describe('measurement-only guarantees', () => {
  const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const src = (f: string) => strip(readFileSync(path.join(HERE, '..', f), 'utf-8'));

  it('no decision module imports a measurement module', () => {
    const decisionModules = ['market-bias.ts', 'trigger-router.ts', 'slot-arbitration.ts', 'validation-gates.ts', 'structure-live.ts'];
    for (const m of decisionModules) {
      const code = src(m);
      for (const forbidden of ['measurement-core', 'measurement-report', 'payoff-grader-v2']) expect(code, `${m} imports ${forbidden}`).not.toMatch(new RegExp(`from '\\./${forbidden}\\.js'`));
    }
  });

  it('market-bias.ts calls the two writers fire-and-forget and never reads their result', () => {
    const code = src('market-bias.ts');
    expect(code).toMatch(/\brecordTradeCosts\(\{/);
    expect(code).toMatch(/\bregisterPostExitWatch\(stored,/);
    expect(code).not.toMatch(/=\s*(await\s+)?(recordTradeCosts|registerPostExitWatch)\(/);
    expect(code).not.toMatch(/\bawait\s+(recordTradeCosts|registerPostExitWatch)\(/);
  });

  it('the new tables are written only by the measurement services and are immutable', () => {
    const migration = readFileSync(path.resolve(HERE, '../../../../../database/init/040_trade_measurement.sql'), 'utf-8');
    expect(migration).toMatch(/trade_cost_records_immutable AS ON UPDATE TO trade_cost_records DO INSTEAD NOTHING/);
    expect(migration).toMatch(/trade_post_exit_immutable AS ON UPDATE TO trade_post_exit DO INSTEAD NOTHING/);
    const writers = ['market-bias.ts', 'trigger-router.ts', 'slot-arbitration.ts', 'validation-gates.ts'];
    for (const w of writers) expect(src(w)).not.toMatch(/trade_cost_records|trade_post_exit/);
  });
});
