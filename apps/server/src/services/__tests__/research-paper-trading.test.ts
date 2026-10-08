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
  momentumSlotCandidate,
  indicatorGeometry,
  decisionMetrics,
  buildMetricsContext,
  structureGeometry,
  MEASURED_CRITERIA,
  type MetricsContext,
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

/** That S1 lifecycle as a filled trade: its structural stop beyond the sweep extreme (112) and a T1 below. */
const s1Trade = (): LiveLifecycle => ({ ...s1Lifecycle(), stop: 113.2, t1: { kind: 'PREV_DAY_LOW', price: 80 } }) as LiveLifecycle;

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
  moveConsumedPct: 0.2,
  objectiveDistanceAtr: 2,
  netRR: 1.6,
  entryQuality: 0.6,
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
/** The one slot-candidate schema every engine fills. */
// ARB-2.0 (2026-10-05): every engine's candidate also carries its confirmation count and detail.
const SCHEMA = ['anchorKeys', 'candidateId', 'confirmationDetail', 'confirmations', 'decisionTime', 'direction', 'entryQuality', 'evidence', 'geometry', 'moveConsumedPct', 'movePotential', 'netRR', 'objectiveDistanceAtr', 'parentId', 'source', 'timingClass'];

describe('1. every eligible family candidate of a parent is retained', () => {
  it('the router hands the slot all eligible paper-stage candidates of the newest bar — no pre-selection', () => {
    const newest = 100;
    const pool = [
      routed(candidate('A2'), 'P1'),
      routed(candidate('A3', { timing: { class: 'OPTIMAL' } } as any), 'P1'),
      routed(candidate('B1', { timing: { class: 'LATE' } } as any), 'P1'),
      routed(candidate('D3', { bucket: 'LOW_RR', rToT1: 0.8 } as any), 'P1'), // 0.8R: low R:R is display only (2026-10-05) — still handed over
      routed(candidate('C1', { bucket: 'NO_TARGET', t1: null, rToT1: null } as any), 'P1'), // no target: genuinely ineligible
      routed(candidate('B2', { decisionIndex: 99 } as any), 'P1'), // an earlier bar: never handed over (no hindsight)
    ];
    expect(paperCandidatesForSlot(pool, newest).map((r) => r.candidate.triggerId)).toEqual(['A2', 'A3', 'B1', 'D3']);
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
  it('what cannot be measured is NOT_MEASURED: no structural level behind price → no timing; no bars → no move potential', () => {
    const g = indicatorGeometry({ direction: 'BULLISH', spot: 200, builtAtr: 10, stopInAtr: 1, targetInAtr: 3, behindLevel: null })!;
    expect(g).toMatchObject({ entry: 200, stop: 190, objective: 230, anchor: null });
    const m = decisionMetrics(g, null, 1.4);
    expect(m.timingClass).toBe(NOT_MEASURED);
    expect(m.moveConsumedPct).toBe(NOT_MEASURED);
    expect(m.movePotential).toBe(NOT_MEASURED);
    expect(m.entryQuality).toBe(0.75); // (230 − 200) / (230 − 190): measured from stop and objective alone
    expect(m.netRR).toBe(1.4);
    const bare = indicatorSlotCandidate('IND:x', 'BULLISH', null, 1_000);
    for (const v of [bare.timingClass, bare.moveConsumedPct, bare.movePotential, bare.objectiveDistanceAtr, bare.netRR, bare.entryQuality, bare.evidence]) expect(v).toBe(NOT_MEASURED);
  });
  it('a candidate missing a metric neither beats a LATE one nor loses to an OPTIMAL one on it: the next shared metric decides', () => {
    const unmeasured = slot({ source: 'INDICATOR', timingClass: NOT_MEASURED, moveConsumedPct: NOT_MEASURED, netRR: 1.5 });
    const late = slot({ source: 'B1', timingClass: 'LATE', netRR: 2.0 });
    const optimal = slot({ source: 'A3', timingClass: 'OPTIMAL', netRR: 1.2 });
    expect(rankSlotCandidates([unmeasured, late]).winner).toBe(1); // R:R 2.0 > 1.5 — LATE is not held against B1
    expect(rankSlotCandidates([unmeasured, optimal]).winner).toBe(0); // R:R 1.5 > 1.2 — OPTIMAL is not credited to A3
    expect(rankSlotCandidates([unmeasured, late]).lostOn.get(0)).toBe('net R:R after costs');
  });
  it('evidence (not every engine has events) is recorded, never ranked', () => {
    // ARB-2.0: criterion 5 is the confirmation count (a separate measure); the raw `evidence` count is still never ranked.
    expect(MEASURED_CRITERIA.map((k) => k.name)).toEqual(['entry timing', 'move potential', 'net R:R after costs', 'entry quality', 'confirmations']);
    const a = slot({ source: 'A2', evidence: 9 });
    const ind = slot({ source: 'INDICATOR', evidence: NOT_MEASURED });
    expect(compareSlotCandidates(a, ind, sharedCriteria([a, ind]).used).criterion).toBe('source tie-break');
    // These fixtures carry no confirmation count: it is skipped, never invented.
    expect(sharedCriteria([a, ind]).skipped).toEqual(['confirmations']);
  });
});

describe('6. ranking skips dimensions not measurable for every candidate in the pool', () => {
  it('a fully measured pool compares all four criteria', () => {
    expect(sharedCriteria([slot({ source: 'S1' }), slot({ source: 'A3' }), slot({ source: 'INDICATOR' })])).toEqual({ used: ['entry timing', 'move potential', 'net R:R after costs', 'entry quality'], skipped: ['confirmations'] });
    // With the ARB-2.0 confirmation count measured on every candidate, all five are compared.
    expect(sharedCriteria([slot({ source: 'S1', confirmations: 3 }), slot({ source: 'A3', confirmations: 1 }), slot({ source: 'INDICATOR', confirmations: 0 })])).toEqual({ used: ['entry timing', 'move potential', 'net R:R after costs', 'entry quality', 'confirmations'], skipped: [] });
  });
  it('an indicator with no structural level behind price: entry timing is skipped for the whole pool, the rest still decide', async () => {
    const r = await settle([
      b(slot({ source: 'S1', timingClass: 'OPTIMAL', netRR: 1.5 })),
      b(slot({ source: 'A3', timingClass: 'LATE', netRR: 1.7 })),
      b(slot({ source: 'INDICATOR', timingClass: NOT_MEASURED, moveConsumedPct: NOT_MEASURED, netRR: 1.6 })),
    ]);
    expect(r.role('A3').role).toBe('SELECTED'); // R:R decides; S1's OPTIMAL is not counted while one candidate lacks timing
    for (const x of r.records) expect(x.criteriaUsed).toEqual(['move potential', 'net R:R after costs', 'entry quality']);
    expect(r.role('S1').reason).toMatch(/Not compared \(NOT_MEASURED by at least one candidate in this check\): entry timing/);
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
    expect(src).toMatch(/indicatorSlotCandidate\(\s*indicatorId,\s*direction,\s*netRiskReward\(fresh\),\s*decisionBarClose,/);
  });
});

describe('9. one parent move produces exactly one selected trade', () => {
  it('several engines and families on one parent: one mint, the parent marked once, every other candidate recorded', async () => {
    const r = await settle([
      b(slot({ source: 'S1', anchorKeys: ['P1', 'SWEEP:x'] })),
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
    expect(flow).toMatch(/settleSlot\(\{\s*underlying,\s*exchange,\s*entries,\s*markTraded/);
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
    // The fixture predates ARB-2.0's confirmation fields; every key it has is a schema field
    // (the exact schema of real candidates is pinned in 13) and none is an outcome.
    const keys = Object.keys(slot({})).sort();
    for (const k of keys) expect(SCHEMA).toContain(k);
    expect(keys.filter((k) => /outcome|mfe|mae|exit|result/i.test(k))).toEqual([]);
    expect(SCHEMA.filter((k) => /outcome|mfe|mae|exit|result/i.test(k))).toEqual([]);
  });
  it('S1\'s and the indicator\'s metrics are identical whether or not later bars exist', () => {
    const i = start + 8;
    const cutCtx = buildMetricsContext(allBars.slice(0, i + 1), SESSION)!;
    const fullCtx = buildSeriesContext(series);
    const atFull: MetricsContext = { ctx: fullCtx, s, i, atr: fullCtx.atrAt(i) };
    expect(cutCtx.i).toBe(i);
    const s1g = structureGeometry(s1Trade(), 101);
    expect(decisionMetrics(s1g, cutCtx, 1.7).movePotential).not.toBe(NOT_MEASURED);
    expect(decisionMetrics(s1g, cutCtx, 1.7)).toEqual(decisionMetrics(s1g, atFull, 1.7));
    const indg = indicatorGeometry({ direction: 'BEARISH', spot: 101, builtAtr: 6, stopInAtr: 1, targetInAtr: 2.5, behindLevel: 106 })!;
    expect(decisionMetrics(indg, cutCtx, 1.5)).toEqual(decisionMetrics(indg, atFull, 1.5));
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

describe('13. one metric schema and one formula for S1, the indicator and every family', () => {
  const i = start + 7;
  const m = buildMetricsContext(allBars.slice(0, i + 1), SESSION)!;
  const part = routeSession(prepareMomentumSeries(allBars.slice(0, i + 1)));
  const newest = part.all.filter((c) => c.decisionIndex === i && c.t1 != null);

  it('every engine\'s candidate carries exactly the same fields', () => {
    const fam = routedSlotCandidate(routed(newest[0]), m);
    const s1 = structureSlotCandidate(s1Trade(), 101, 1.6, { parentId: 'P', anchorKeys: ['P'], decisionTime: 1 }, m);
    const geometry = indicatorGeometry({ direction: 'BEARISH', spot: 101, builtAtr: m.atr, stopInAtr: 1.2, targetInAtr: 2, behindLevel: 104 });
    const ind = indicatorSlotCandidate('IND:x', 'BEARISH', 1.6, 1, geometry, m);
    // The momentum break competes on the same schema (2026-10-05).
    const mb = momentumSlotCandidate({ direction: 'BEARISH', levelKind: 'PDL', levelPrice: 102, entry: 101, stop: 103, target: 97, targetKind: 'S1', rUnderlying: 2, volMult: 2, rangeMult: 1.5, closeLocation: 0.1, atr: m.atr ?? 1, quality: 80, barTime: 0, variantId: 'V' } as any, 101, null, { parentId: 'MB:x', decisionTime: 1 }, m);
    for (const c of [fam, s1, ind, mb]) expect(Object.keys(c).sort(), c.source).toEqual(SCHEMA);
    // …and all of them are actually measured here, the indicator included.
    for (const c of [fam, s1, ind]) {
      expect(c.timingClass, c.source).not.toBe(NOT_MEASURED);
      expect(c.movePotential, c.source).not.toBe(NOT_MEASURED);
      expect(c.entryQuality, c.source).not.toBe(NOT_MEASURED);
    }
  });

  it('a family\'s metrics through decisionMetrics equal what the event engine itself recorded at the decision bar', () => {
    expect(newest.length).toBeGreaterThan(0);
    for (const c of newest) {
      const sc = routedSlotCandidate(routed(c), m);
      expect(sc.timingClass, c.triggerId).toBe(c.timing.class);
      expect(sc.movePotential, c.triggerId).toBe(c.movePotential.class);
      expect(sc.moveConsumedPct, c.triggerId).toBe(c.timing.moveConsumedPct ?? NOT_MEASURED);
    }
  });

  it('the indicator\'s entry timing comes from price geometry: the further price has run from the level behind, the later the class', () => {
    const at = (spot: number) =>
      decisionMetrics({ direction: 'BULLISH', entry: spot, stop: 193, objective: 230, anchor: 195, onAnchorBar: false }, m).timingClass;
    expect(at(200)).toBe('OPTIMAL');
    expect(['LATE', 'CHASING']).toContain(at(216));
  });

  it('no hard-coded engine priority: whichever engine carries the better metrics wins, under any label', () => {
    const better = { timingClass: 'OPTIMAL' as const, netRR: 1.8 };
    const worse = { timingClass: 'ACCEPTABLE' as const, netRR: 1.8 };
    for (const x of ['S1', 'INDICATOR', 'A3']) {
      for (const y of ['S1', 'INDICATOR', 'A3']) {
        if (x === y) continue;
        const pool = [slot({ source: y, ...worse }), slot({ source: x, ...better })];
        expect(pool[rankSlotCandidates(pool).winner].source, `${x} vs ${y}`).toBe(x);
      }
    }
    // The comparison code names no engine: the source id appears only as the last tie-break.
    const src = readFileSync(fileURLToPath(new URL('../slot-arbitration.ts', import.meta.url)), 'utf8');
    const ranking = src.slice(src.indexOf('export const MEASURED_CRITERIA'), src.indexOf('/** The pool\'s order'));
    expect(ranking).not.toMatch(/'S1'|'INDICATOR'|triggerId/);
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
  it('no family has been promoted to PAPER or ACTIVE; research families are PAPER_RESEARCH (A4 demoted to SHADOW)', () => {
    for (const [id, st] of Object.entries(liveTriggerStages())) {
      if (id === 'S1') expect(st).toBe('ACTIVE');
      else if (id === 'A4') expect(st).toBe('SHADOW');
      else expect(['PAPER_RESEARCH', 'RETIRED'], id).toContain(st);
    }
  });
});
