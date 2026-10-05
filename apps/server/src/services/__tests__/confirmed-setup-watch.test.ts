// ============================================================
// CONFIRMED-SETUP WATCH + R:R DISPLAY-ONLY (Phase 1, 2026-10-05)
// ============================================================
// Net R:R is a ranking / display input only. A confirmed setup at 1.20R (or
// 0.4R) is CONFIRMED, ranks (criterion #3), can be minted and is shown under
// its SAME id on every closed bar until it is INVALIDATED / EXPIRES / FILLS.
// Genuine checks still reject: no target, zero / negative risk, a fill at or
// through the stop or T1, a stop that cannot sit outside the noise floor.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));

import {
  buildTradeSetup,
  evaluateStructureSession,
  prepareMomentumSeries,
  buildSeriesContext,
  runSessionEvents,
  evaluateTriggersAt,
  rebuildCandidateAt,
  EVENT_ENGINE_TRIGGER_IDS,
  STRUCTURE_RULES,
  STRUCTURE_VARIANTS,
  MIN_RISK_REWARD,
  type MomentumBar,
  type TriggerCandidate,
} from '@fno/analytics';
import type { OptionChain, OptionChainLeg, OptionChainStrike, TradeSetup } from '@fno/shared';
import { fixtureStrikes, leg, ATM, LOT } from './trade-setup-fixtures.js';
import {
  RR_REFERENCE,
  rrStatus,
  rrBandOf,
  bindingRR,
  structureReference,
  grossRRFrom,
  structureDisplayEnd,
  isShownStructureSetup,
  isNakedLongRiskRewardPlausible,
  applyWatchUpdate,
  planFromLevels,
  endUpdateFor,
  type ClosedBar,
  type WatchUpdate,
} from '../setup-watch-core.js';
import { validateOnChain, rankStrikeBuilds, strikeNetRR, type StrikeBuild } from '../fno-validation.js';
import { advanceFamilyWatch, newFamilyWatch, FAMILY_WATCH_BARS, validateCandidateRisk, routedLifecycleId, liveTriggerStages, paperCandidatesForSlot, type RoutedCandidate } from '../trigger-router.js';
import { liveStructureRulesFor, structureSequenceRefusal, type LiveLifecycle } from '../structure-live.js';
import { rankSlotCandidates, settleSlot, type DeferredSetup, type SlotCandidate } from '../slot-arbitration.js';
import { RISK_VERSION, RR_DISPLAY_ONLY_LOGIC_SUFFIX, liveLogicStamp } from '../../config/trading-flags.js';

const M15 = 15 * 60 * 1000;
const T0 = Date.parse('2026-08-10T10:00:00+05:30');
const bar = (k: number, o: number, h: number, l: number, c: number): ClosedBar => ({ time: T0 + k * M15, open: o, high: h, low: l, close: c });
const fill = STRUCTURE_RULES.fillWithinBars;

/** A bearish S1 setup confirmed at 1.20R: limit 100 (FVG 100–103), stop 106, T1 92.8, sweep extreme 105. */
const s1 = (over: Partial<LiveLifecycle> = {}): LiveLifecycle =>
  ({
    id: 'NSE:NIFTY:BEARISH:1',
    direction: 'BEARISH',
    stage: 'CONFIRMED',
    stageAt: T0 + M15,
    confirmedAt: T0 + M15,
    entry: 100,
    zone: { kind: 'FVG', near: 100, far: 103 },
    stop: 106,
    t1: { kind: 'PREV_DAY_LOW', price: 92.8 },
    t2: null,
    sweepExtreme: 105,
    rToT1: 1.2,
    atr: 4,
    live: null,
    ...over,
  }) as unknown as LiveLifecycle;
const watchUpdate = (over: Partial<WatchUpdate>): WatchUpdate => ({
  id: 'NSE:NIFTY:BEARISH:1',
  source: 'S1',
  direction: 'BEARISH',
  parentId: 'P1',
  at: T0,
  barTime: T0,
  statusRR: 1.2,
  grossRR: 1.2,
  netRR: 1.25,
  block: null,
  plan: null,
  optionBuildFailed: false,
  underlying: { entry: 100, sl: 106, t1: 92.8, t2: null },
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
    levels: { entry: entryPremium, stopLoss: entryPremium - 26, target: entryPremium + 31 },
    delta: -0.5,
    spot: 100,
    reference: 100,
    underlying: { sl: 106, t1: 92.8, t2: null },
    grossRR: 1.2,
    netRR: 1.15,
    estimatedCostPct: 2,
    ranking: null,
    trail: { breakevenAtR: 1, lockAtR: 2 },
  });

// ---------------- the structure-engine fixture (from structure-engine.test.ts) ----------------
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);
function mbar(time: number, open: number, close: number, wick = 0.2, volume = 1000): MomentumBar {
  return { time, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume };
}
function session(date: string, closes: number[], startOpen: number): MomentumBar[] {
  let prev = startOpen;
  return closes.map((c, k) => {
    const b = mbar(at(date, '09:15') + k * M15, prev, c);
    prev = c;
    return b;
  });
}
const alternating = (n: number, a = 100, b = 100.5) => Array.from({ length: n }, (_, k) => (k % 2 === 0 ? a : b));
const HIST = ['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16'];
const PREV = '2026-01-19';
const TODAY = '2026-01-20';
const PREV_CLOSES = [100, 99.5, 99, 98.5, 98, 97.5, 97.2, 97.5, 98, 98.5, 99, 99.5, 100, 100.5, 101, 101.5, 101.8, 101.5, 101.2, 101.0, 101.2, 101.0, 101.2, 101.0, 101.2];
function base(): MomentumBar[] {
  const bars: MomentumBar[] = [];
  let last = 100.5;
  for (const d of HIST) {
    bars.push(...session(d, alternating(25), last));
    last = bars[bars.length - 1].close;
  }
  bars.push(...session(PREV, PREV_CLOSES, last));
  last = bars[bars.length - 1].close;
  bars.push(...session(TODAY, [101.3, 101.0, 101.3, 101.0, 101.3, 101.0], last));
  return bars;
}
const t = (k: number) => at(TODAY, '10:45') + k * M15;
const B = (k: number, open: number, high: number, low: number, close: number): MomentumBar => ({ time: t(k), open, high, low, close, volume: 1000 });
const SWEEP = B(0, 101.0, 102.3, 100.9, 101.6);
const DISP = B(1, 101.6, 101.7, 100.1, 100.2);
const CONF = B(2, 100.2, 100.6, 99.9, 100.3);
const V10 = STRUCTURE_VARIANTS.find((v) => v.id === 'D1.0-GUARD')!;
/** The LOW_RR fixture: a previous-day low at 99.8 sits only ~0.4R below the entry. */
const closeTarget = () =>
  base().map((b) => (b.low < 99.8 && b.time < at(TODAY, '09:15') && b.time >= at(PREV, '09:15') ? { ...b, low: 99.8, close: Math.max(b.close, 99.9), open: Math.max(b.open, 99.9) } : b));

describe('Phase 1 — net R:R never decides confirmation, eligibility or minting', () => {
  it('the same low-R:R sweep is LOW_RR under the pre-registered rules and CONFIRMED under the live rules', () => {
    const bars = [...closeTarget(), SWEEP, DISP, CONF];
    const series = prepareMomentumSeries(bars);
    const research = evaluateStructureSession(series, bars.length - 1, V10).setups.find((s) => s.direction === 'BEARISH')!;
    expect(research.stage).toBe('LOW_RR'); // research / backtests keep 1.5R (unchanged)
    const live = evaluateStructureSession(series, bars.length - 1, V10, liveStructureRulesFor('15m')).setups.find((s) => s.direction === 'BEARISH')!;
    expect(live.stage).toBe('CONFIRMED');
    expect(live.rToT1!).toBeLessThan(1);
    expect(live.t1).not.toBeNull();
  });

  it('the live rules keep only the geometry: no R:R floor, a T1 strictly beyond the entry, the research rules unchanged', () => {
    expect(liveStructureRulesFor('15m').minT1R).toBe(0);
    expect(liveStructureRulesFor('5m').minT1R).toBe(0);
    expect(STRUCTURE_RULES.minT1R).toBe(1.5);
    const bars = [...closeTarget(), SWEEP, DISP, CONF];
    const live = evaluateStructureSession(prepareMomentumSeries(bars), bars.length - 1, V10, liveStructureRulesFor('15m')).setups.find((s) => s.direction === 'BEARISH')!;
    expect(live.rToT1!).toBeGreaterThan(0); // the target is beyond the entry (positive reward)
    expect(Math.abs(live.entry! - live.stop!)).toBeGreaterThan(0); // positive risk
  });

  it('the fill gate passes a 1.20R fill and still refuses a fill at / through the stop or T1', () => {
    expect(structureSequenceRefusal(s1(), 100)).toBeNull(); // 1.20R
    expect(structureSequenceRefusal(s1(), 99)).toBeNull(); // ~0.92R — still a valid fill
    expect(structureSequenceRefusal(s1(), 106)?.code).toBe('STRUCTURE_SEQUENCE'); // at the stop: zero risk
    expect(structureSequenceRefusal(s1(), 107)?.code).toBe('STRUCTURE_SEQUENCE'); // through it: negative risk
    expect(structureSequenceRefusal(s1(), 92.8)?.code).toBe('STRUCTURE_SEQUENCE'); // at T1: no reward
    expect(structureSequenceRefusal(s1({ t1: null }), 100)?.code).toBe('STRUCTURE_SEQUENCE'); // no target
  });

  it('a family candidate at 0.8R is eligible and handed to the slot; no target / invalid stop are not', () => {
    const c = (bucket: TriggerCandidate['bucket'], rToT1: number | null): TriggerCandidate => ({ triggerId: 'A3', direction: 'BULLISH', decisionIndex: 100, bucket, rToT1 }) as unknown as TriggerCandidate;
    const ok = { sessionOk: true, costPct: 2, maxCostPct: 5 };
    expect(validateCandidateRisk(c('LOW_RR', 0.8), ok)).toMatchObject({ wouldTrade: true, reason: null });
    expect(validateCandidateRisk(c('TRADE', 2.1), ok).wouldTrade).toBe(true);
    expect(validateCandidateRisk(c('NO_TARGET', null), ok)).toMatchObject({ wouldTrade: false, reason: 'NO_TARGET: no untaken pool ahead' });
    expect(validateCandidateRisk(c('INVALID_STOP', null), ok)).toMatchObject({ wouldTrade: false, reason: 'INVALID_STOP' });
    const rc = (b: TriggerCandidate['bucket']): RoutedCandidate => ({ candidate: c(b, 0.8), stage: 'PAPER_RESEARCH', risk: validateCandidateRisk(c(b, 0.8), ok), cost: null, lifecycleId: b });
    expect(paperCandidatesForSlot([rc('LOW_RR'), rc('NO_TARGET')], 100).map((r) => r.lifecycleId)).toEqual(['LOW_RR']);
  });

  it('the option builder (rrGate: false) builds a low-R:R leg the original gate refuses', () => {
    let checked = 0;
    for (let move = 5; move <= 300; move += 5) {
      const gated = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 80, move, undefined, null, 5, LOT, 50, {});
      if (gated.noTradeCode !== 'REWARD_RISK_TOO_LOW') continue;
      const open = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 80, move, undefined, null, 5, LOT, 50, { rrGate: false });
      expect(open.available, `move ${move}`).toBe(true);
      expect(open.stopLoss!).toBeLessThan(open.entry!);
      expect(open.target!).toBeGreaterThan(open.entry!);
      expect(strikeNetRR(open)!).toBeLessThan(MIN_RISK_REWARD); // a genuinely low net R:R leg (after costs), built
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('the structural-stop builder (live default) never refuses for R:R, incl. the RICH-IV bar', () => {
    let checked = 0;
    for (let move = 5; move <= 300; move += 5) {
      const opts = { flags: { structuralStop: true, richIvRr: true }, spot: ATM, nearestBehindLevel: ATM - 120, ivVsHv: 'RICH' };
      const gated = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 80, move, undefined, null, 5, LOT, 50, opts);
      if (gated.noTradeCode !== 'REWARD_RISK_TOO_LOW') continue;
      const open = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 80, move, undefined, null, 5, LOT, 50, { ...opts, rrGate: false });
      expect(open.noTradeCode, `move ${move}`).not.toBe('REWARD_RISK_TOO_LOW');
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('genuine option checks still refuse with rrGate: false: no edge after cost, an unusable quote', () => {
    const tiny = buildTradeSetup(fixtureStrikes(), ATM, 'BULLISH', 80, 0.5, undefined, null, 5, LOT, 50, { rrGate: false });
    expect(tiny.available).toBe(false);
    expect(tiny.noTradeCode).not.toBe('REWARD_RISK_TOO_LOW');
  });

  it('a stored 1.20R trade stays live on the next read; only non-positive or implausibly high R:R retires it', () => {
    expect(isNakedLongRiskRewardPlausible(1.2)).toBe(true);
    expect(isNakedLongRiskRewardPlausible(0.6)).toBe(true);
    expect(isNakedLongRiskRewardPlausible(0)).toBe(false);
    expect(isNakedLongRiskRewardPlausible(-0.4)).toBe(false);
    expect(isNakedLongRiskRewardPlausible(7)).toBe(false); // MAX_RISK_REWARD (bad upstream data)
    expect(isNakedLongRiskRewardPlausible(null)).toBe(false);
  });

  it('a 1.20R candidate ranks on net R:R (criterion #3) and is minted when it ranks first', async () => {
    const common = { direction: 'BEARISH' as const, parentId: 'P', anchorKeys: [] as string[], timingClass: 'OPTIMAL' as const, moveConsumedPct: 0.1, movePotential: 'NORMAL' as const, objectiveDistanceAtr: 2, entryQuality: 0.55, evidence: 2, decisionTime: 1 };
    const low: SlotCandidate = { ...common, source: 'A3', candidateId: 'low', netRR: 1.2 };
    const lower: SlotCandidate = { ...common, source: 'B1', candidateId: 'lower', netRR: 0.9 };
    const r = rankSlotCandidates([lower, low]);
    expect(r.winner).toBe(1);
    expect(r.lostOn.get(0)).toBe('net R:R after costs');
    const log: string[] = [];
    const entry = (sl: SlotCandidate): DeferredSetup => ({
      kind: 'DEFERRED',
      setup: { available: true, reason: '' },
      slot: sl,
      commit: async () => {
        log.push(`MINT ${sl.candidateId}`);
        return { setup: { available: true, reason: 'minted' }, minted: true };
      },
      decline: async () => {
        log.push(`DECLINE ${sl.candidateId}`);
      },
    });
    const minted = await settleSlot({ underlying: 'NIFTY', exchange: 'NSE', entries: [entry(lower), entry(low)] });
    expect(minted?.available).toBe(true);
    expect(log).toEqual(['MINT low', 'DECLINE lower']);
  });

  it('versions are bumped: RISK-2.0 and +rr-display-only.1 on every live stamp', () => {
    expect(RISK_VERSION).toBe('RISK-2.0');
    expect(liveLogicStamp().logicVersion.endsWith(RR_DISPLAY_ONLY_LOGIC_SUFFIX)).toBe(true);
    expect(liveLogicStamp().versions?.riskVersion).toBe('RISK-2.0');
  });
});

describe('the status line and the display-only band', () => {
  it('reads "Confirmed — R:R x" at any R:R; the band is display only', () => {
    expect(RR_REFERENCE).toBe(1.5);
    expect(rrStatus(1.2)).toEqual({ text: 'Confirmed — R:R 1.20R', band: '1.0-1.5' });
    expect(rrStatus(1.49)).toEqual({ text: 'Confirmed — R:R 1.49R', band: '1.0-1.5' });
    expect(rrStatus(1.5)).toEqual({ text: 'Confirmed — R:R 1.50R', band: '>=1.5' });
    expect(rrStatus(1.7)).toEqual({ text: 'Confirmed — R:R 1.70R', band: '>=1.5' });
    expect(rrStatus(0.8)).toEqual({ text: 'Confirmed — R:R 0.80R', band: '<1.0' });
    expect(rrStatus(null)).toEqual({ text: 'Confirmed — R:R not measured', band: null });
    expect(rrBandOf(0.999)).toBe('<1.0');
    expect(rrBandOf(1)).toBe('1.0-1.5');
  });
  it('R:R never changes the status: any value stays CONFIRMED, no "< / ≥ 1.50R" comparison, no RR_RECOVERED', () => {
    const a = applyWatchUpdate(null, watchUpdate({ statusRR: 1.2 }));
    expect(a.row.status).toBe('CONFIRMED');
    expect(a.row.statusText).toBe('Confirmed — R:R 1.20R');
    const b = applyWatchUpdate(a.row, watchUpdate({ statusRR: 1.7, barTime: T0 + M15, at: T0 + M15 }));
    expect(b.events).toEqual(['REEVALUATED']);
    expect(b.row.status).toBe('CONFIRMED');
    expect(b.row.rrBand).toBe('>=1.5');
    const c = applyWatchUpdate(b.row, watchUpdate({ statusRR: 0.9, barTime: T0 + 2 * M15, at: T0 + 2 * M15 }));
    expect(c.row.status).toBe('CONFIRMED');
    expect(c.row.statusText).toBe('Confirmed — R:R 0.90R');
    for (const row of [a.row, b.row, c.row]) expect(row.statusText).not.toMatch(/[<≥]\s*1\.50R/);
  });
  it('the binding R:R is the lower of the underlying R:R and the option net R:R', () => {
    expect(bindingRR(1.8, 1.42)).toBe(1.42);
    expect(bindingRR(null, 1.7)).toBe(1.7);
    expect(bindingRR(null, null)).toBeNull();
  });
});

describe('a confirmed 1.20R setup is shown and survives across bars until it genuinely ends', () => {
  it('shown: any confirmed lifecycle with a stop and a T1', () => {
    expect(isShownStructureSetup(s1())).toBe(true);
    expect(isShownStructureSetup(s1({ stage: 'DEVELOPING', confirmedAt: null }))).toBe(false);
    expect(isShownStructureSetup(s1({ t1: null }))).toBe(false);
  });
  it('survives quiet bars at 1.20R; one row, same id, re-measured each bar', () => {
    const lc = s1();
    const bars = [bar(1, 99, 101, 98.5, 99), bar(2, 99, 101.5, 98.8, 101), bar(3, 101, 102, 99.5, 100.2)];
    expect(structureDisplayEnd(lc, bars, M15, fill)).toBeNull();
    let row = applyWatchUpdate(null, watchUpdate({ barTime: bars[0].time })).row;
    for (const b of bars.slice(1)) {
      const ref = structureReference(lc, b.close);
      const next = applyWatchUpdate(row, watchUpdate({ barTime: b.time, at: b.time + M15, statusRR: grossRRFrom(lc, ref), underlying: { entry: ref, sl: 106, t1: 92.8, t2: null } }));
      expect(next.events).toEqual(['REEVALUATED']);
      expect(next.row.id).toBe(row.id);
      row = next.row;
    }
    expect(row.status).toBe('CONFIRMED');
    expect(grossRRFrom(lc, structureReference(lc, 101))).toBe(1.64); // a fill inside the zone measures better — display only
  });
  it('ends only on INVALIDATION / EXPIRY (S1: stop traded, sweep reclaimed, T1 traded first, fill window over)', () => {
    const lc = s1();
    expect(structureDisplayEnd(lc, [bar(1, 104, 106.2, 103, 104)], M15, fill)?.reason).toBe('STOP_TRADED');
    expect(structureDisplayEnd(lc, [bar(1, 104, 105.9, 103, 105.5)], M15, fill)?.reason).toBe('SWEEP_RECLAIMED');
    expect(structureDisplayEnd(lc, [bar(1, 96, 97, 92.5, 93)], M15, fill)?.reason).toBe('MISSED');
    const quiet = Array.from({ length: fill + 1 }, (_, j) => bar(j + 1, 99, 99.5, 98.5, 99));
    expect(structureDisplayEnd(lc, quiet, M15, fill)?.reason).toBe('NO_FILL');
    expect(structureDisplayEnd(lc, quiet.slice(0, fill), M15, fill)).toBeNull();
    // A paper-trade-log refusal (any reason) never ends what is shown.
    const refused = s1({ live: { outcome: 'REFUSED', reason: 'cooldown', code: 'POST_LOSS_COOLDOWN', at: T0 + M15 } });
    expect(structureDisplayEnd(refused, [bar(1, 99, 101, 98.5, 99)], M15, fill)).toBeNull();
  });
  it('… or when FILLED; an ended row is never reopened', () => {
    const live = applyWatchUpdate(null, watchUpdate({})).row;
    const filled = applyWatchUpdate(live, endUpdateFor(live, 'FILLED', T0 + M15));
    expect(filled.events).toEqual(['WATCH_ENDED']);
    expect(filled.row.status).toBe('ENDED');
    expect(applyWatchUpdate(filled.row, watchUpdate({ statusRR: 2 }))).toEqual({ row: filled.row, events: [] });
  });
  it('a strike change keeps the same row and is recorded', () => {
    const a = applyWatchUpdate(null, watchUpdate({ plan: planOf(8950, 118) })).row;
    const b = applyWatchUpdate(a, watchUpdate({ plan: planOf(9000, 131), barTime: T0 + M15, at: T0 + M15 }));
    expect(b.events).toEqual(['REEVALUATED', 'STRIKE_CHANGED']);
    expect(b.row.id).toBe(a.id);
    expect(b.row.strikeChanges).toBe(1);
    expect(b.row.initial.strike).toBe(8950);
  });
});

describe('families on the watch: display only, ending on genuine rules', () => {
  function familySession() {
    const ist = (s: string) => Date.parse(`${s}+05:30`);
    const sess = (date: string, path: Array<[number, number, number, number]>): MomentumBar[] =>
      path.map(([open, high, low, close], k) => ({ time: ist(`${date}T09:15:00`) + k * M15, open, high, low, close, volume: 0 }));
    const quiet = (date: string): MomentumBar[] =>
      sess(
        date,
        Array.from({ length: 25 }, (_, k) => {
          const o = 100 + ((k % 4) - 1.5) * 2;
          const c = 100 + (((k + 1) % 4) - 1.5) * 2;
          return [o, Math.max(o, c) + 4, Math.min(o, c) - 4, c] as [number, number, number, number];
        })
      );
    const days = Array.from({ length: 22 }, (_, k) => new Date(Date.parse('2026-07-15T12:00:00Z') + k * 86_400_000).toISOString().slice(0, 10));
    const today = sess('2026-08-10', [
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
    return { ctx, log: runSessionEvents(ctx, s), start: series.sessionStarts[s], allBars };
  }
  const routedOf = (c: TriggerCandidate): RoutedCandidate => ({
    candidate: c,
    stage: liveTriggerStages()[c.triggerId],
    risk: validateCandidateRisk(c, { sessionOk: true, costPct: 2, maxCostPct: 5 }),
    cost: null,
    lifecycleId: routedLifecycleId('NSE', 'NIFTY', c),
    parentId: 'P1',
    anchorKeys: ['P1', c.anchorEventId],
  });
  it('a LOW_RR candidate is eligible at its own bar and watched (DISPLAY) under its original id', () => {
    const { ctx, log, start } = familySession();
    const original = evaluateTriggersAt(ctx, log, start + 7, EVENT_ENGINE_TRIGGER_IDS).find((c) => c.triggerId === 'A2')!;
    expect(original.bucket).toBe('LOW_RR');
    expect(routedOf(original).risk.wouldTrade).toBe(true);
    const w = newFamilyWatch(routedOf(original));
    expect(w).toMatchObject({ cause: 'DISPLAY', lifecycleId: routedLifecycleId('NSE', 'NIFTY', original), ended: null });
  });
  it('ends on a close beyond the invalidation, T1 traded, the window or the closing guard — never on R:R', () => {
    const { ctx, log, start } = familySession();
    const original = evaluateTriggersAt(ctx, log, start + 7, EVENT_ENGINE_TRIGGER_IDS).find((c) => c.triggerId === 'A2')!;
    const w = newFamilyWatch(routedOf(original));
    expect(advanceFamilyWatch([w], ctx, log, start + 8, () => true)[0].ended?.reason).toBe('MISSED');
    const noT1 = { ...w, original: { ...original, t1: null } };
    expect(advanceFamilyWatch([noT1], ctx, log, start + 8, () => false)[0].ended?.reason).toBe('EXPIRED_CLOSING_GUARD');
    expect(advanceFamilyWatch([noT1], ctx, log, start + 7 + FAMILY_WATCH_BARS + 1, () => true)[0].ended?.reason).toMatch(/EXPIRED|NO_TARGET|INVALIDATED/);
    const high = { ...w, original: { ...original, t1: null, stopRef: 50 } };
    expect(advanceFamilyWatch([high], ctx, log, start + 8, () => true)[0].ended?.reason).toBe('INVALIDATED');
  });
  it('a re-measure at bar i reads bars ≤ i only', () => {
    const { ctx, log, start, allBars } = familySession();
    const original = evaluateTriggersAt(ctx, log, start + 7, EVENT_ENGINE_TRIGGER_IDS).find((c) => c.triggerId === 'A2')!;
    const i = start + 8;
    const cut = prepareMomentumSeries(allBars.slice(0, i + 1));
    const cctx = buildSeriesContext(cut);
    const clog = runSessionEvents(cctx, cut.sessionStarts.length - 1);
    expect(rebuildCandidateAt(cctx, clog, original, i)).toEqual(rebuildCandidateAt(ctx, log, original, i));
  });
});

describe('the option leg: best valid strike, deterministic, premium levels', () => {
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

  it('every in-band strike is built; the highest net R:R wins even when every leg is below 1.5R', () => {
    const builds: Record<number, TradeSetup> = { 24900: ok(24900, 50, 40, 61), 25000: ok(25000, 70, 55, 88), 25100: ok(25100, 120, 95, 150) };
    const out = validateOnChain({ chain, side: 'PE', params, context: ctx, build: (_c, strike) => builds[strike] });
    const ranking = out.setup.fnoValidation!.strikeSelection!.ranking!;
    expect(ranking).toHaveLength(3);
    expect(out.setup.available).toBe(true);
    expect(out.setup.strike).toBe(ranking[0].strike);
    expect(ranking[0].netRR!).toBeLessThan(1.5);
  });
  it('the top strike failing a genuine check falls through to the next', () => {
    const builds: Record<number, TradeSetup> = { 24900: { available: false, reason: 'cost', noTradeCode: 'COST_TOO_HIGH' }, 25000: ok(25000, 70, 55, 100), 25100: { available: false, reason: 'noise', noTradeCode: 'STOP_INSIDE_NOISE' } };
    const out = validateOnChain({ chain, side: 'PE', params, context: ctx, build: (_c, strike) => builds[strike] });
    expect(out.setup.strike).toBe(25000);
  });
  it('the ranking is deterministic whatever the input order', () => {
    const b = (strike: number, setup: TradeSetup, spreadPct = 0.4, delta = -0.5): StrikeBuild => ({ strike, delta, spreadPct, setup });
    const builds = [b(24900, ok(24900, 50, 40, 70), 0.4, -0.4), b(25000, ok(25000, 70, 55, 100)), b(25100, ok(25100, 120, 95, 170), 0.3, -0.6), b(25200, { available: false, reason: 'x', noTradeCode: 'COST_TOO_HIGH' })];
    const ref = rankStrikeBuilds(builds, 0.5, 25000).map((x) => x.strike);
    for (const perm of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) expect(rankStrikeBuilds(perm.map((i) => builds[i]), 0.5, 25000).map((x) => x.strike)).toEqual(ref);
    expect(ref[ref.length - 1]).toBe(25200);
    expect(strikeNetRR(ok(25000, 70, 55, 100))).toBe(Math.round(((100 - 70 - 1.4) / (70 - 55 + 1.4)) * 100) / 100);
  });
  it('SL / TSL are premium values from the existing trailing rule, never underlying prices', () => {
    const p = planOf(8950, 118);
    expect(p.slPremium).toBe(92);
    expect(p.tslPremium).toBe(92);
    expect(p.underlyingSl).toBe(106);
    expect(p.tslRule).toBe('TSL = SL ₹92.00 until entry; then at +1R (premium ₹144.00) SL → entry ₹118.00; at +2R (₹170.00) SL → ₹144.00 (locks +1R).');
  });
});

describe('Phase 1 source guards: the 1.5R gate cannot come back unnoticed', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  it('every live option build passes rrGate: false', () => {
    const src = read('../market-bias.ts');
    const builds = src.match(/buildTradeSetup\(/g)?.length ?? 0;
    expect(builds).toBeGreaterThan(0);
    expect(src.match(/rrGate: false,/g)?.length).toBe(builds);
  });
  it('the live structure engine runs the live rules (no R:R floor)', () => {
    const src = read('../market-bias.ts');
    expect(src).toMatch(/evaluateStructureSession\(series, bars\.length - 1, liveStructureVariant\(\), liveStructureRulesFor\('15m'\)\)/);
    expect(src).toMatch(/liveStructureVariant\('5m'\), liveStructureRulesFor\('5m'\)\)/);
    expect(src).not.toMatch(/riskReward >= MIN_RISK_REWARD/);
  });
  it('no live module compares R:R against the 1.5 minimum any more; the RR_RECOVERED endpoint is gone', () => {
    for (const f of ['../structure-live.ts', '../trigger-router.ts', '../setup-watch-core.ts', '../slot-arbitration.ts', '../fno-validation.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/>=\s*(STRUCTURE_RULES\.minT1R|MIN_RISK_REWARD|RR_MIN)\b/);
      expect(src, f).not.toMatch(/<\s*(STRUCTURE_RULES\.minT1R|MIN_RISK_REWARD|RR_MIN)\b/);
    }
    expect(read('../../api/diagnostics.ts')).not.toMatch(/rr-recovery/);
  });
});
