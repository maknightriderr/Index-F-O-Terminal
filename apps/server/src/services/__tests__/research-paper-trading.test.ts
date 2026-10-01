// ============================================================
// MULTI-TRIGGER PAPER TRADING — acceptance tests
// ============================================================
// ALL ENGINES → ALL CANDIDATES → PARENT GROUPING → COMMON ELIGIBILITY →
// ARBITRATION → BEST ELIGIBLE (built) → ONE PAPER TRADE.
//   * every eligible family candidate is retained (no pre-selection);
//   * a candidate whose option build fails is ineligible, the next one wins;
//   * S1 joins a family's parent only through the canonical sweep event;
//   * NOT_MEASURED is never a neutral value: a criterion is compared only
//     when every candidate in the pool measured it;
//   * family trades are labelled "Paper research · <trigger>";
//   * one decision-time definition (the decision bar's close) for every engine;
//   * one trade per parent move, decision-time data only, no broker path.
// ============================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareMomentumSeries,
  buildSeriesContext,
  runSessionEvents,
  evaluateTriggersAt,
  evaluateStructureSession,
  groupIntoParents,
  STRUCTURE_VARIANTS,
  TRIGGER_REGISTRY,
  DISPLACEMENT_REQUIRED_BY,
  EVENT_ENGINE_TRIGGER_IDS,
  type MomentumBar,
  type MomentumSeries,
  type TriggerCandidate,
} from '@fno/analytics';
import { engineBadge, researchTriggerOf, type TradeSetup } from '@fno/shared';
import {
  liveTriggerStages,
  liveRoutedTriggerIds,
  validateCandidateRisk,
  lifecycleFromCandidate,
  routedLifecycleId,
  buildParentLinkage,
  anchorKeysOf,
  linkStructureToParent,
  paperCandidatesForSlot,
  type RoutedCandidate,
} from '../trigger-router.js';
import { structureSequenceRefusal, lifecycleIdOf, type LiveLifecycle } from '../structure-live.js';
import { setupConfidenceRefusal } from '../validation-gates.js';
import { INDICATOR_CONFIDENCE_MODE, PAPER_TRADING_STAGES, paperResearchStamp, liveLogicStamp } from '../../config/trading-flags.js';
import { strategyFamilyOfSetup } from '../backtesting.js';
import {
  NOT_MEASURED,
  compareSlotCandidates,
  rankSlotCandidates,
  sharedCriteria,
  settleSlot,
  parentAlreadyTraded,
  structureSlotCandidate,
  routedSlotCandidate,
  indicatorSlotCandidate,
  type DeferredSetup,
  type RefusedCandidate,
  type SlotArbitrationRecord,
  type SlotCandidate,
} from '../slot-arbitration.js';

const M15 = 15 * 60 * 1000;
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
/** A sweep of the previous day's high with NO displacement candle afterwards, then a fall. */
const sweepNoDisplacement = (): MomentumBar[] =>
  session('2026-08-10', [
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
const days = Array.from({ length: 22 }, (_, k) => new Date(Date.parse('2026-07-15T12:00:00Z') + k * 86_400_000).toISOString().slice(0, 10));
const allBars = [...days.flatMap(quiet), ...sweepNoDisplacement()];
const series = prepareMomentumSeries(allBars);
const SESSION = '2026-08-10';
const s = series.sessionDates.indexOf(SESSION);
const start = series.sessionStarts[s];

/** The live router's own steps on a series: every rule on every bar, parents, linkage. */
function routeSession(sr: MomentumSeries) {
  const ctx = buildSeriesContext(sr);
  const si = sr.sessionDates.indexOf(SESSION);
  const log = runSessionEvents(ctx, si);
  const all: TriggerCandidate[] = [];
  for (let i = sr.sessionStarts[si]; i <= ctx.sessionEnd(si); i++) all.push(...evaluateTriggersAt(ctx, log, i, EVENT_ENGINE_TRIGGER_IDS));
  const parents = groupIntoParents(all, new Map([[SESSION, log]]));
  return { ctx, log, all, parents, linkage: buildParentLinkage(SESSION, parents, all, log.events) };
}
/** S1's lifecycle for the session's bearish sweep at bar start+3 (the structure engine's own setup). */
function s1Lifecycle(sr: MomentumSeries = series): LiveLifecycle {
  const variant = STRUCTURE_VARIANTS.find((v) => v.dispMult === 1 && !v.openingGuard)!;
  const st = evaluateStructureSession(sr, start + 8, variant).setups.find((x) => x.direction === 'BEARISH' && x.sweep.index === start + 3)!;
  return { id: lifecycleIdOf('NSE', 'NIFTY', st), direction: 'BEARISH', pool: { kind: st.pool.kind, price: st.pool.price, rank: st.pool.rank }, timeframe: '15m' } as unknown as LiveLifecycle;
}

/** A clean, tradeable candidate for any trigger id (TRADE bucket: T1 3R away). */
const candidate = (triggerId: string, over: Partial<TriggerCandidate> = {}): TriggerCandidate =>
  ({
    triggerId,
    family: 'TEST',
    direction: 'BULLISH',
    session: SESSION,
    decisionIndex: 100,
    decisionTime: ist('2026-08-10T11:00:00'),
    entry: 200,
    stop: 190,
    atr: 10,
    t1: { kind: 'PREV_DAY_HIGH', price: 230 },
    t2: null,
    rToT1: 3,
    bucket: 'TRADE',
    anchorEventId: 'SWEEP:BULLISH:98:x',
    anchorIndex: 98,
    anchorPrice: 195,
    eventIds: ['SWEEP:BULLISH:98:x', 'RECLAIM:BULLISH:98:x'],
    marketState: 'TRENDING_UP',
    movePotential: { class: 'NORMAL', remainingMovePct: 0.5 },
    timing: { class: 'ACCEPTABLE' },
    ...over,
  }) as unknown as TriggerCandidate;
const routed = (c: TriggerCandidate, parentId = 'P1', over: Partial<RoutedCandidate> = {}): RoutedCandidate => ({
  candidate: c,
  stage: liveTriggerStages()[c.triggerId],
  risk: validateCandidateRisk(c, { sessionOk: true, costPct: 2, maxCostPct: 5 }),
  cost: null,
  lifecycleId: routedLifecycleId('NSE', 'NIFTY', c),
  parentId,
  anchorKeys: [parentId, c.anchorEventId],
  ...over,
});
const slot = (over: Partial<SlotCandidate>): SlotCandidate => ({
  source: 'X',
  candidateId: `id-${over.source ?? 'X'}`,
  direction: 'BULLISH',
  parentId: 'P1',
  anchorKeys: ['P1'],
  timingClass: 'ACCEPTABLE',
  movePotential: 'NORMAL',
  remainingMovePct: 0.5,
  netRR: 1.6,
  evidence: 2,
  decisionTime: 1_000,
  ...over,
});
/** A built-but-not-minted setup that logs its commit and decline. */
const built = (sl: SlotCandidate, log: string[]): DeferredSetup => ({
  kind: 'DEFERRED',
  setup: { available: true, reason: sl.source } as TradeSetup,
  slot: sl,
  commit: async () => {
    log.push(`MINT ${sl.source}`);
    return { setup: { available: true, reason: `minted ${sl.source}` } as TradeSetup, minted: true };
  },
  decline: async (reason) => {
    log.push(`NOT_SELECTED ${sl.source}: ${reason}`);
  },
});
const refused = (sl: SlotCandidate, code: string, reason: string, optionBuild: boolean): RefusedCandidate => ({ kind: 'REFUSED', slot: sl, code, reason, optionBuild });
async function settle(entries: Array<DeferredSetup | RefusedCandidate>) {
  const log: string[] = [];
  const marked: string[][] = [];
  let records: SlotArbitrationRecord[] = [];
  const out = await settleSlot({
    underlying: 'NIFTY',
    exchange: 'NSE',
    entries: entries.map((e) => (e.kind === 'DEFERRED' ? built(e.slot, log) : e)),
    record: (r) => (records = r),
    markTraded: async (k) => void marked.push([...k]),
  });
  return { out, log, marked, records, role: (src: string) => records.find((r) => r.slot.source === src)! };
}
const b = (sl: SlotCandidate) => built(sl, []);

describe('1. every eligible family candidate of a parent is retained', () => {
  it('the router hands the slot all eligible paper-stage candidates of the newest bar — no pre-selection', () => {
    const newest = 100;
    const pool = [
      routed(candidate('A2'), 'P1'),
      routed(candidate('A3', { timing: { class: 'OPTIMAL' } } as any), 'P1'),
      routed(candidate('B1', { timing: { class: 'LATE' } } as any), 'P1'),
      routed(candidate('D3', { bucket: 'LOW_RR', rToT1: 0.8 } as any), 'P1'), // ineligible: never handed over
      routed(candidate('B2', { decisionIndex: 99 } as any), 'P1'), // an earlier bar: never handed over (no hindsight)
    ];
    expect(paperCandidatesForSlot(pool, newest).map((r) => r.candidate.triggerId)).toEqual(['A2', 'A3', 'B1']);
  });
  it('all three are recorded with role and rank; exactly one is selected', async () => {
    const r = await settle([b(slot({ source: 'A2' })), b(slot({ source: 'A3', timingClass: 'OPTIMAL' })), b(slot({ source: 'B1', timingClass: 'LATE' }))]);
    expect(r.records.map((x) => [x.slot.source, x.role, x.rank])).toEqual([
      ['A3', 'SELECTED', 1],
      ['A2', 'ALTERNATIVE', 2],
      ['B1', 'ALTERNATIVE', 3],
    ]);
    expect(r.role('A2').reason).toMatch(/A3 ranked higher on entry timing/);
    expect(r.log.filter((l) => l.startsWith('MINT'))).toEqual(['MINT A3']);
  });
});

describe('2. the highest-ranked candidate fails its option build → the next one is selected', () => {
  it('A3 (#1 before the build) is refused by the option leg; B1 (#2) trades; the parent survives', async () => {
    const r = await settle([
      refused(slot({ source: 'A3', timingClass: 'OPTIMAL', netRR: NOT_MEASURED }), 'COST_EXCEEDS_EDGE', 'Round-trip cost exceeds the edge', true),
      b(slot({ source: 'B1', timingClass: 'ACCEPTABLE' })),
      b(slot({ source: 'D3', timingClass: 'LATE' })),
    ]);
    expect(r.out?.reason).toBe('minted B1');
    expect(r.role('A3')).toMatchObject({ role: 'INELIGIBLE', preBuildRank: 1, rank: null, refusalCode: 'COST_EXCEEDS_EDGE', optionBuildFailure: 'Round-trip cost exceeds the edge' });
    expect(r.role('B1')).toMatchObject({ role: 'SELECTED', preBuildRank: 2, rank: 1 });
    expect(r.role('D3')).toMatchObject({ role: 'ALTERNATIVE', preBuildRank: 3, rank: 2 });
    expect(r.marked).toEqual([['P1']]);
  });
  it('a gate refusal (not the option leg) is ineligible too, without an option-build reason', async () => {
    const r = await settle([refused(slot({ source: 'S1' }), 'SESSION_GUARD', 'Closing guard', false), b(slot({ source: 'A2' }))]);
    expect(r.role('S1')).toMatchObject({ role: 'INELIGIBLE', optionBuildFailure: null, refusalCode: 'SESSION_GUARD' });
  });
  it('nothing built: no mint, every candidate recorded INELIGIBLE', async () => {
    const r = await settle([refused(slot({ source: 'A2' }), 'COST_TOO_HIGH', 'x', true)]);
    expect(r.out).toBeNull();
    expect(r.records.map((x) => x.role)).toEqual(['INELIGIBLE']);
  });
});

describe('3–4. S1 joins a family parent only through the canonical sweep event', () => {
  const { all, log, linkage } = routeSession(series);
  const sweep = log.events.find((e) => e.type === 'SWEEP' && e.direction === 'BEARISH' && e.barIndex === start + 3)!;
  const a2 = all.find((c) => c.triggerId === 'A2' && c.decisionIndex === start + 7)!;

  it('S1 and A2 stand on the same sweep event → the same parent', () => {
    expect(sweep).toBeDefined();
    expect(a2).toBeDefined();
    const a2Parent = linkage.parentOfKey[a2.anchorEventId];
    const link = linkStructureToParent(s1Lifecycle(), linkage);
    expect(link.linked).toBe(true);
    expect(link.parentId).toBe(a2Parent);
    expect(link.anchorKeys).toContain(sweep.id);
    expect(anchorKeysOf(a2Parent, a2, log.events)).toContain(sweep.id);
  });

  it('… and produce exactly one trade; the parent can never trade again (the sweep event is marked)', async () => {
    const link = linkStructureToParent(s1Lifecycle(), linkage);
    const a2Keys = anchorKeysOf(link.parentId, a2, log.events);
    const r = await settle([
      b(slot({ source: 'S1', parentId: link.parentId, anchorKeys: link.anchorKeys, timingClass: 'OPTIMAL', movePotential: NOT_MEASURED })),
      b(slot({ source: 'A2', parentId: link.parentId, anchorKeys: a2Keys })),
    ]);
    expect(r.log.filter((l) => l.startsWith('MINT'))).toHaveLength(1);
    const traded = new Set(r.marked.flat());
    // After that trade closes, a later candidate of either strategy on this move is blocked.
    expect(parentAlreadyTraded(a2Keys, traded)).toBe(true);
    expect(parentAlreadyTraded(link.anchorKeys, traded)).toBe(true);
  });

  it('a different market event stays a separate parent — never linked by time or price proximity', () => {
    const lc = s1Lifecycle();
    const sweepTime = Number(lc.id.slice(lc.id.lastIndexOf(':') + 1));
    const otherBar = { ...lc, id: lc.id.replace(String(sweepTime), String(sweepTime + M15)) } as LiveLifecycle; // the next bar
    const otherPool = { ...lc, pool: { ...lc.pool, price: lc.pool.price + 0.5 } } as LiveLifecycle; // a nearby price
    const otherSide = { ...lc, direction: 'BULLISH' } as LiveLifecycle;
    for (const x of [otherBar, otherPool, otherSide]) {
      const link = linkStructureToParent(x, linkage);
      expect(link.linked).toBe(false);
      expect(link.parentId).toBe(`S1:${x.id}`);
      expect(parentAlreadyTraded(anchorKeysOf(linkage.parentOfKey[a2.anchorEventId], a2, log.events), new Set(link.anchorKeys))).toBe(false);
    }
  });

  it('5m S1, a routed lifecycle, or no linkage: S1 stands alone', () => {
    const lc = s1Lifecycle();
    expect(linkStructureToParent({ ...lc, timeframe: '5m' } as LiveLifecycle, linkage).linked).toBe(false);
    expect(linkStructureToParent({ ...lc, triggerId: 'A2' } as LiveLifecycle, linkage).linked).toBe(false);
    expect(linkStructureToParent(lc, null).linked).toBe(false);
  });
});

describe('5. NOT_MEASURED is never ACCEPTABLE / NORMAL / 0', () => {
  it('the indicator engine and S1 report what they do not measure as NOT_MEASURED', () => {
    const ind = indicatorSlotCandidate('IND:x', 'BULLISH', 1.4, 1_000);
    expect([ind.timingClass, ind.movePotential, ind.remainingMovePct, ind.evidence]).toEqual([NOT_MEASURED, NOT_MEASURED, NOT_MEASURED, NOT_MEASURED]);
    expect(ind.netRR).toBe(1.4);
    const lc = { id: 'L', direction: 'BULLISH', stop: 190, t1: { kind: 'PDH', price: 230 }, atr: 10, sweepExtreme: 191, displacementBodyAtr: 1.2, zone: { kind: 'FVG' } } as unknown as LiveLifecycle;
    const s1 = structureSlotCandidate(lc, 194, null, { parentId: 'P', anchorKeys: ['P'], decisionTime: 1 });
    expect(s1.timingClass).toBe('OPTIMAL');
    expect([s1.movePotential, s1.remainingMovePct, s1.netRR]).toEqual([NOT_MEASURED, NOT_MEASURED, NOT_MEASURED]);
    expect(s1.evidence).toBe(3);
  });
  it('an unmeasured indicator neither beats a LATE family on timing nor loses to an OPTIMAL one: R:R decides', () => {
    const ind = indicatorSlotCandidate('IND:x', 'BULLISH', 1.5, 1_000);
    const late = slot({ source: 'B1', timingClass: 'LATE', netRR: 2.0 });
    const optimal = slot({ source: 'A3', timingClass: 'OPTIMAL', netRR: 1.2 });
    expect(rankSlotCandidates([ind, late]).winner).toBe(1); // R:R 2.0 > 1.5 — the LATE timing is not held against B1
    expect(rankSlotCandidates([ind, optimal]).winner).toBe(0); // R:R 1.5 > 1.2 — OPTIMAL is not counted for A3 either
    expect(rankSlotCandidates([ind, late]).lostOn.get(0)).toBe('net R:R after costs');
  });
  it('an unmeasured evidence is not a zero', () => {
    const ind = indicatorSlotCandidate('IND:x', 'BULLISH', 1.6, 1_000);
    const fam = slot({ source: 'A2', timingClass: NOT_MEASURED, movePotential: NOT_MEASURED, remainingMovePct: NOT_MEASURED, netRR: 1.6, evidence: 5 });
    // R:R ties; evidence is NOT compared (the indicator has none measured), so the tie falls to the decision bar, then source.
    expect(compareSlotCandidates(fam, ind, sharedCriteria([fam, ind]).used).criterion).toBe('source tie-break');
  });
});

describe('6. ranking skips dimensions not measurable for every candidate in the pool', () => {
  it('S1 + A3: timing, R:R and evidence compared; move potential and remaining move skipped', () => {
    const s1 = slot({ source: 'S1', movePotential: NOT_MEASURED, remainingMovePct: NOT_MEASURED });
    expect(sharedCriteria([s1, slot({ source: 'A3' })])).toEqual({ used: ['entry timing', 'net R:R after costs', 'evidence'], skipped: ['move potential', 'remaining move'] });
  });
  it('adding the indicator leaves R:R as the only shared measured criterion — recorded on every row', async () => {
    const r = await settle([
      b(slot({ source: 'S1', movePotential: NOT_MEASURED, remainingMovePct: NOT_MEASURED })),
      b(slot({ source: 'A3' })),
      b(indicatorSlotCandidate('IND:x', 'BULLISH', 1.9, 1_000)),
    ]);
    expect(r.role('INDICATOR').role).toBe('SELECTED');
    for (const x of r.records) expect(x.criteriaUsed).toEqual(['net R:R after costs']);
    expect(r.role('A3').reason).toMatch(/Not compared \(NOT_MEASURED by at least one candidate in this check\): entry timing, move potential, remaining move, evidence/);
  });
  it('the order is the same whatever order the candidates arrive in (the pool rule is transitive)', () => {
    // Pairwise skipping would cycle here: A beats B on timing, B beats C on R:R, C beats A on R:R.
    const A = slot({ source: 'A', timingClass: 'OPTIMAL', netRR: 1.5 });
    const B = slot({ source: 'B', timingClass: 'LATE', netRR: 2.0 });
    const C = slot({ source: 'C', timingClass: NOT_MEASURED, netRR: 1.8 });
    const perms = [[A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A]];
    const winners = new Set(perms.map((p) => p[rankSlotCandidates(p).winner].source));
    expect(winners).toEqual(new Set(['B']));
  });
});

describe('7. family trades are labelled "Paper research · <trigger>"', () => {
  it('the shared badge (Telegram, Trade Setup card, trade list) never calls a family trade the structure engine', () => {
    expect(engineBadge('STRUCTURE', 'A3')).toEqual({ key: 'PAPER_RESEARCH', label: 'Paper research · A3' });
    expect(engineBadge('STRUCTURE', null).label).toBe('Structure · NEW');
    expect(engineBadge(undefined).label).toBe('Indicator · OLD');
  });
  it('the logic version still carries +paper-research.<trigger>, and the backtest buckets it apart from S1', () => {
    const v = paperResearchStamp(liveLogicStamp(), 'B1').logicVersion;
    expect(v).toMatch(/\+paper-research\.B1$/);
    expect(researchTriggerOf(v)).toBe('B1');
    expect(strategyFamilyOfSetup({ strategy: 'STRUCTURE', logicVersion: v })).toBe('PAPER_RESEARCH');
    expect(strategyFamilyOfSetup({ strategy: 'STRUCTURE', logicVersion: liveLogicStamp().logicVersion })).toBe('STRUCTURE');
  });
  it('every display passes the trigger to the badge', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(read('../telegram.ts')).toMatch(/engineBadge\(setup\.strategy, setup\.researchTrigger\)/);
    expect(read('../trade-setup-close-notifier.ts')).toMatch(/engineBadge\(n\.strategy, n\.researchTrigger\)/);
    expect(read('../../../../web/src/components/asset-workspace/index.tsx')).toMatch(/engineBadge\(setup\.strategy, setup\.researchTrigger\)/);
    expect(read('../../../../web/src/components/backtesting/index.tsx')).toMatch(/researchTriggerOf\(r\.logicVersion\)/);
    // The structure chain stamps the trigger on a family trade's setup.
    expect(read('../market-bias.ts')).toMatch(/\.\.\.\(lc\.triggerId \? \{ researchTrigger: lc\.triggerId \} : \{\}\)/);
  });
});

describe('8. one decision-time definition for every engine: the decision bar close', () => {
  it('a family decided on a bar and S1 / the indicator deciding after that bar closed share the same decision time', () => {
    const c = candidate('A2', { decisionTime: ist('2026-08-10T11:00:00') } as any);
    const barClose = ist('2026-08-10T11:15:00');
    const fam = routedSlotCandidate(routed(c));
    const lc = { id: 'L', direction: 'BULLISH', stop: 190, t1: { kind: 'PDH', price: 230 }, atr: 10, sweepExtreme: 191, displacementBodyAtr: null, zone: null } as unknown as LiveLifecycle;
    const s1 = structureSlotCandidate(lc, 200, 1.6, { parentId: 'P', anchorKeys: ['P'], decisionTime: barClose });
    const ind = indicatorSlotCandidate('IND:x', 'BULLISH', 1.6, barClose);
    expect(fam.decisionTime).toBe(barClose);
    expect(new Set([fam.decisionTime, s1.decisionTime, ind.decisionTime]).size).toBe(1);
    // So the earliest-decision step can never favour one engine by its clock.
    const tie = compareSlotCandidates({ ...s1, netRR: 1.6 }, { ...ind }, []);
    expect(tie.criterion).not.toBe('earlier decision bar');
  });
  it('the live flow derives S1\'s and the indicator\'s decision time from the newest closed 15m bar, not the check time', () => {
    const src = readFileSync(fileURLToPath(new URL('../market-bias.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/const decisionBarClose = lastClosedBar \? lastClosedBar\.time \+ BAR_MS_15M : decisionNow\(\);/);
    expect(src).toMatch(/linkStructureToParent\(structureFill, linkage\), decisionTime: decisionBarClose/);
    expect(src).toMatch(/indicatorSlotCandidate\(indicatorId, direction, netRiskReward\(fresh\), decisionBarClose\)/);
  });
});

describe('9. one parent move produces exactly one selected trade', () => {
  it('several engines and families on one parent: one mint, the parent marked once, every other candidate recorded', async () => {
    const r = await settle([
      b(slot({ source: 'S1', anchorKeys: ['P1', 'SWEEP:x'], movePotential: NOT_MEASURED, remainingMovePct: NOT_MEASURED })),
      b(slot({ source: 'A2', anchorKeys: ['P1', 'SWEEP:x'] })),
      b(slot({ source: 'A3', anchorKeys: ['P1', 'RECLAIM:x', 'SWEEP:x'], timingClass: 'OPTIMAL' })),
      b(slot({ source: 'D3', anchorKeys: ['P1'] })),
    ]);
    expect(r.log.filter((l) => l.startsWith('MINT'))).toEqual(['MINT A3']);
    expect(r.log.filter((l) => l.startsWith('NOT_SELECTED'))).toHaveLength(3);
    expect(r.marked).toEqual([['P1', 'RECLAIM:x', 'SWEEP:x']]);
    expect(r.records.filter((x) => x.role === 'SELECTED')).toHaveLength(1);
  });
  it('a later candidate of a different parent is not blocked by that trade', () => {
    expect(parentAlreadyTraded(['P2', 'SWEEP:y'], new Set(['P1', 'RECLAIM:x', 'SWEEP:x']))).toBe(false);
  });
  it('the live flow checks the traded-parent guard before building, for S1 and every family candidate', () => {
    const src = readFileSync(fileURLToPath(new URL('../market-bias.ts', import.meta.url)), 'utf8');
    const flow = src.slice(src.indexOf('const entries: SlotEntry[] = [];'), src.indexOf('async function indicatorEngine()'));
    expect(flow.match(/if \(parentTraded\((link|slot)\.anchorKeys\)\)/g)).toHaveLength(2);
    expect(flow).toMatch(/code: 'PARENT_ALREADY_TRADED'/);
    expect(flow).toMatch(/settleSlot\(\{ underlying, exchange, entries, markTraded/);
    expect(flow).not.toMatch(/return filled|mintUnderLock/);
  });
});

describe('10. no future bar or outcome influences arbitration', () => {
  it('rank inputs and S1\'s parent are identical with or without the bars after the decision', () => {
    const i = start + 8;
    const cut = prepareMomentumSeries(allBars.slice(0, i + 1));
    const full = routeSession(series);
    const part = routeSession(cut);
    const rank = (c: TriggerCandidate) => routedSlotCandidate({ candidate: c, lifecycleId: 'x' } as RoutedCandidate);
    const upTo = (xs: TriggerCandidate[]) => xs.filter((c) => c.decisionIndex <= i).map(rank);
    expect(upTo(part.all).length).toBeGreaterThan(0);
    expect(upTo(part.all)).toEqual(upTo(full.all));
    // Every parent assignment known at bar i stands unchanged once later bars exist.
    for (const [k, p] of Object.entries(part.linkage.parentOfKey)) expect(full.linkage.parentOfKey[k], k).toBe(p);
    expect(linkStructureToParent(s1Lifecycle(), part.linkage)).toEqual(linkStructureToParent(s1Lifecycle(), full.linkage));
  });
  it('a slot candidate holds decision-time fields only (no outcome, MFE, exit or result)', () => {
    expect(Object.keys(slot({})).sort()).toEqual(['anchorKeys', 'candidateId', 'decisionTime', 'direction', 'evidence', 'movePotential', 'netRR', 'parentId', 'remainingMovePct', 'source', 'timingClass']);
  });
});

describe('11. S1 and indicator behaviour otherwise unchanged; research families still need no displacement', () => {
  it('S1 still drops a sweep with no displacement; A2 still builds on that same sweep', () => {
    const variant = STRUCTURE_VARIANTS.find((v) => v.dispMult === 1 && !v.openingGuard)!;
    const swept = evaluateStructureSession(series, start + 8, variant).setups.find((x) => x.direction === 'BEARISH' && x.sweep.index === start + 3)!;
    expect(swept.history.some((h) => h.reason === 'NO_DISPLACEMENT')).toBe(true);
    expect(routeSession(series).all.some((c) => c.triggerId === 'A2' && c.decisionIndex === start + 7)).toBe(true);
  });
  it('A2 / A3 / B1 / D3 are PAPER_RESEARCH, need no displacement and pass the structure chain\'s sequence gate', () => {
    expect([...DISPLACEMENT_REQUIRED_BY].sort()).toEqual(['C2', 'S1']);
    for (const id of ['A2', 'A3', 'B1', 'D3']) {
      expect(/DISPLACEMENT/.test(TRIGGER_REGISTRY.find((t) => t.triggerId === id)!.exactRule), id).toBe(false);
      expect(liveRoutedTriggerIds()).toContain(id);
      const rc = routed(candidate(id));
      expect(rc.stage).toBe('PAPER_RESEARCH');
      expect(PAPER_TRADING_STAGES).toContain(rc.stage);
      expect(structureSequenceRefusal(lifecycleFromCandidate(rc), 200)).toBeNull();
    }
  });
  it('the indicator engine stays in EVIDENCE mode: confidence below 75 does not refuse', () => {
    expect(INDICATOR_CONFIDENCE_MODE).toBe('EVIDENCE');
    expect(setupConfidenceRefusal({ mode: 'EVIDENCE', confidence: 60, minConfidence: 75 })).toBeNull();
  });
});

describe('12. no broker / live-order path', () => {
  it('the server has no order-placement code at all', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) {
          if (f !== '__tests__' && f !== 'node_modules') walk(p);
        } else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/placeOrder|place_order|\/orders\b|modifyOrder|kite\.place/i);
  });
  it('no family has been promoted to PAPER or ACTIVE; research families are PAPER_RESEARCH', () => {
    for (const [id, st] of Object.entries(liveTriggerStages())) {
      if (id === 'S1') expect(st).toBe('ACTIVE');
      else expect(['PAPER_RESEARCH', 'RETIRED'], id).toContain(st);
    }
  });
});
