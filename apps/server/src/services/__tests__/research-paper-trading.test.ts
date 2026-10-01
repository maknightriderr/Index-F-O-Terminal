// ============================================================
// MULTI-TRIGGER PAPER TRADING — acceptance tests
// ============================================================
// Every engine (S1, the indicator engine, the trigger families at
// PAPER_RESEARCH) builds its setup through its own unchanged chain; the
// built setups are ranked on decision-time fields only; exactly one is
// minted into the symbol's one paper slot; the rest are recorded
// NOT_SELECTED. No engine has priority, and nothing reaches a broker.
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
  STRUCTURE_VARIANTS,
  TRIGGER_REGISTRY,
  DISPLACEMENT_REQUIRED_BY,
  type MomentumBar,
  type TriggerCandidate,
} from '@fno/analytics';
import type { TradeSetup } from '@fno/shared';
import { liveTriggerStages, liveRoutedTriggerIds, validateCandidateRisk, lifecycleFromCandidate, routedLifecycleId, type RoutedCandidate } from '../trigger-router.js';
import { structureSequenceRefusal, type LiveLifecycle } from '../structure-live.js';
import { setupConfidenceRefusal } from '../validation-gates.js';
import { INDICATOR_CONFIDENCE_MODE, PAPER_TRADING_STAGES, paperResearchStamp, liveLogicStamp } from '../../config/trading-flags.js';
import {
  compareSlotCandidates,
  rankSlotCandidates,
  notSelectedReason,
  settleSlot,
  structureSlotCandidate,
  routedSlotCandidate,
  type DeferredSetup,
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
const s = series.sessionDates.indexOf('2026-08-10');
const start = series.sessionStarts[s];

/** A clean, tradeable candidate for any trigger id (TRADE bucket: T1 3R away). */
const candidate = (triggerId: string, over: Partial<TriggerCandidate> = {}): TriggerCandidate =>
  ({
    triggerId,
    family: 'TEST',
    direction: 'BULLISH',
    session: '2026-08-10',
    decisionIndex: 100,
    decisionTime: ist('2026-08-10T11:00:00'),
    entry: 200,
    stop: 190,
    atr: 10,
    t1: { kind: 'PREV_DAY_HIGH', price: 230 },
    t2: null,
    rToT1: 3,
    bucket: 'TRADE',
    anchorEventId: 'X:1',
    anchorIndex: 98,
    anchorPrice: 195,
    eventIds: ['X:1', 'Y:2'],
    marketState: 'TRENDING_UP',
    movePotential: { class: 'NORMAL', remainingMovePct: 0.5 },
    timing: { class: 'ACCEPTABLE' },
    ...over,
  }) as unknown as TriggerCandidate;
const routed = (c: TriggerCandidate): RoutedCandidate => ({
  candidate: c,
  stage: liveTriggerStages()[c.triggerId],
  risk: validateCandidateRisk(c, { sessionOk: true, costPct: 2, maxCostPct: 5 }),
  cost: null,
  lifecycleId: routedLifecycleId('NSE', 'NIFTY', c),
});
const slot = (over: Partial<SlotCandidate>): SlotCandidate => ({
  source: 'X',
  timingClass: 'ACCEPTABLE',
  movePotential: 'NORMAL',
  remainingMovePct: 0.5,
  netRR: 1.6,
  evidence: 2,
  decisionTime: 1_000,
  ...over,
});
/** A built-but-not-minted setup that counts its own commits and declines. */
const deferred = (sl: SlotCandidate, log: string[]): DeferredSetup => ({
  kind: 'DEFERRED',
  setup: { available: true, reason: sl.source } as TradeSetup,
  slot: sl,
  commit: async () => {
    log.push(`MINT ${sl.source}`);
    return { available: true, reason: `minted ${sl.source}` } as TradeSetup;
  },
  decline: async (reason) => {
    log.push(`NOT_SELECTED ${sl.source}: ${reason}`);
  },
});

describe('1. S1 fails on displacement while A3 still creates a paper candidate', () => {
  it('the same session: S1 drops its sweep for NO_DISPLACEMENT, A3 evaluates independently', () => {
    const variant = STRUCTURE_VARIANTS.find((v) => v.dispMult === 1 && !v.openingGuard)!;
    const swept = evaluateStructureSession(series, start + 8, variant).setups.find((x) => x.direction === 'BEARISH' && x.sweep.index === start + 3)!;
    expect(swept.history.some((h) => h.reason === 'NO_DISPLACEMENT')).toBe(true);
    const ctx = buildSeriesContext(series);
    const log = runSessionEvents(ctx, s);
    const a3 = Array.from({ length: 9 }, (_, k) => evaluateTriggersAt(ctx, log, start + k, ['A3'])).flat();
    expect(a3.length).toBeGreaterThan(0);
    expect(a3.every((c) => c.triggerId === 'A3')).toBe(true);
  });
  it('an eligible A3 candidate is a paper candidate: PAPER_RESEARCH, risk-valid, accepted by the structure chain with no displacement', () => {
    const rc = routed(candidate('A3'));
    expect(rc.stage).toBe('PAPER_RESEARCH');
    expect(PAPER_TRADING_STAGES).toContain(rc.stage);
    expect(rc.risk.wouldTrade).toBe(true);
    const lc = lifecycleFromCandidate(rc);
    expect(lc.displacementBodyAtr).toBeNull();
    expect(structureSequenceRefusal(lc, lc.entry!)).toBeNull();
  });
});

describe('2. confidence below 75 can still create a candidate', () => {
  it('EVIDENCE mode: confidence ranks, it never refuses', () => {
    expect(INDICATOR_CONFIDENCE_MODE).toBe('EVIDENCE');
    expect(setupConfidenceRefusal({ mode: 'EVIDENCE', confidence: 60, minConfidence: 75 })).toBeNull();
    // Confidence is not a slot-ranking input either: an indicator setup competes on R:R.
    const { winner } = rankSlotCandidates([slot({ source: 'INDICATOR', timingClass: null, movePotential: null, remainingMovePct: null, netRR: 2.1, evidence: 0 }), slot({ source: 'B1', netRR: 1.6 })]);
    expect(winner).toBe(0);
  });
});

describe('3. A2 / A3 / B1 / D3 create paper candidates without displacement', () => {
  for (const id of ['A2', 'A3', 'B1', 'D3']) {
    it(id, () => {
      expect(DISPLACEMENT_REQUIRED_BY).not.toContain(id);
      expect(/DISPLACEMENT/.test(TRIGGER_REGISTRY.find((t) => t.triggerId === id)!.exactRule)).toBe(false);
      expect(liveRoutedTriggerIds()).toContain(id);
      const rc = routed(candidate(id));
      expect(rc.stage).toBe('PAPER_RESEARCH');
      expect(rc.risk.wouldTrade).toBe(true);
      expect(structureSequenceRefusal(lifecycleFromCandidate(rc), 200)).toBeNull();
    });
  }
  it('only S1 and C2 still require a displacement', () => {
    expect([...DISPLACEMENT_REQUIRED_BY].sort()).toEqual(['C2', 'S1']);
  });
});

describe('4–5. S1 and an alternative both valid: one is selected, and it is not automatically S1', () => {
  const s1Lifecycle = (fillOffset: number): LiveLifecycle =>
    ({
      id: 'NSE:NIFTY:S1:x',
      direction: 'BULLISH',
      stop: 190,
      t1: { kind: 'PREV_DAY_HIGH', price: 230 },
      atr: 10,
      sweepExtreme: 191,
      displacementBodyAtr: 1.4,
      zone: { kind: 'FVG' },
      entry: 200 + fillOffset,
    }) as unknown as LiveLifecycle;

  it('S1\'s timing is measured with the same formula as the families\' (sweep extreme → fill → T1)', () => {
    expect(structureSlotCandidate(s1Lifecycle(0), 194, 1.5, 1).timingClass).toBe('OPTIMAL');
    expect(structureSlotCandidate(s1Lifecycle(0), 215, 1.5, 1).timingClass).toMatch(/LATE|CHASING/);
    expect(structureSlotCandidate(s1Lifecycle(0), 194, 1.5, 1)).toMatchObject({ source: 'S1', evidence: 3, movePotential: null });
  });

  it('an alternative with the better entry timing beats S1', () => {
    const s1 = structureSlotCandidate(s1Lifecycle(0), 205, 1.8, 1_000);
    const a3 = { ...routedSlotCandidate(routed(candidate('A3', { timing: { class: 'OPTIMAL' } } as any))), netRR: 1.5, decisionTime: 1_000 };
    expect(s1.timingClass).not.toBe('OPTIMAL');
    const { winner, lostOn } = rankSlotCandidates([s1, a3]);
    expect(winner).toBe(1);
    expect(lostOn.get(0)).toBe('entry timing');
  });

  it('S1 wins only when it ranks higher on the same criteria', () => {
    const s1 = structureSlotCandidate(s1Lifecycle(0), 194, 1.8, 1_000);
    const a3 = { ...routedSlotCandidate(routed(candidate('A3', { timing: { class: 'ACCEPTABLE' } } as any))), netRR: 2.5, decisionTime: 1_000 };
    expect(rankSlotCandidates([a3, s1]).winner).toBe(1);
  });

  it('identical candidates: the source name never decides before every real criterion has', () => {
    const order = ['entry timing', 'move potential', 'remaining move', 'net R:R after costs', 'evidence', 'earlier decision', 'source tie-break'];
    const cases: Array<[Partial<SlotCandidate>, Partial<SlotCandidate>]> = [
      [{ timingClass: 'OPTIMAL' }, { timingClass: 'LATE' }],
      [{ movePotential: 'HIGH' }, { movePotential: 'LOW' }],
      [{ remainingMovePct: 0.8 }, { remainingMovePct: 0.3 }],
      [{ netRR: 2.2 }, { netRR: 1.6 }],
      [{ evidence: 4 }, { evidence: 2 }],
      [{ decisionTime: 500 }, { decisionTime: 1_000 }],
    ];
    cases.forEach(([better, worse], k) => {
      const r = compareSlotCandidates(slot({ source: 'Z9', ...better }), slot({ source: 'S1', ...worse }));
      expect(r.cmp, order[k]).toBeLessThan(0);
      expect(r.criterion).toBe(order[k]);
    });
  });

  it('an unmeasured field is neutral, and the record says so', () => {
    const indicator = slot({ source: 'INDICATOR', timingClass: null, movePotential: null, remainingMovePct: null, netRR: 1.6 });
    expect(compareSlotCandidates(indicator, slot({ source: 'B1', timingClass: 'ACCEPTABLE', movePotential: 'NORMAL' })).criterion).not.toBe('entry timing');
    expect(compareSlotCandidates(slot({ timingClass: 'OPTIMAL' }), indicator).criterion).toBe('entry timing');
    expect(notSelectedReason(indicator, slot({ source: 'B1' }), 'net R:R after costs')).toMatch(/entry timing and move potential not measured for INDICATOR: counted neutral/);
  });
});

describe('6–7. one paper trade per parent move / per symbol slot', () => {
  it('several engines\' built setups for one symbol: exactly one mint, every other recorded NOT_SELECTED', async () => {
    const log: string[] = [];
    const out = await settleSlot('NIFTY', 'NSE', [
      deferred(slot({ source: 'S1', timingClass: 'LATE' }), log),
      deferred(slot({ source: 'A3', timingClass: 'OPTIMAL' }), log),
      deferred(slot({ source: 'INDICATOR', timingClass: null, movePotential: null, remainingMovePct: null }), log),
    ]);
    expect(out.reason).toBe('minted A3');
    expect(log.filter((l) => l.startsWith('MINT'))).toEqual(['MINT A3']);
    expect(log.filter((l) => l.startsWith('NOT_SELECTED')).length).toBe(2);
    expect(log.find((l) => l.startsWith('NOT_SELECTED S1'))).toMatch(/A3 ranked higher on entry timing/);
  });

  it('different symbols settle independently: each gets its own paper trade', async () => {
    const log: string[] = [];
    await settleSlot('NIFTY', 'NSE', [deferred(slot({ source: 'A2' }), log)]);
    await settleSlot('BANKNIFTY', 'NSE', [deferred(slot({ source: 'B1' }), log)]);
    expect(log).toEqual(['MINT A2', 'MINT B1']);
  });

  it('the slot path defers every engine and mints only through settleSlot — no engine returns early', () => {
    const src = readFileSync(fileURLToPath(new URL('../market-bias.ts', import.meta.url)), 'utf8');
    const flow = src.slice(src.indexOf('const pending: DeferredSetup[] = [];'), src.indexOf('async function indicatorEngine()'));
    expect(flow).toMatch(/if \(filled\) pending\.push\(filled\);/);
    expect(flow).toMatch(/if \(built\) pending\.push\(built\);/);
    expect(flow).toMatch(/if \(isDeferred\(indicator\)\) pending\.push\(indicator\);/);
    expect(flow).toMatch(/return settleSlot\(underlying, exchange, pending\);/);
    expect(flow).not.toMatch(/return filled|return minted|mintUnderLock/);
    // Both builders hand back a DEFERRED setup; the mint lives only inside commit().
    const structure = src.slice(src.indexOf('async function resolveStructureSetup('), src.indexOf('const STRUCTURE_PREVIEW_TTL_SECONDS'));
    expect(structure).toMatch(/\): Promise<DeferredSetup \| null> \{/);
    expect(structure).toMatch(/const commit = async \(\): Promise<TradeSetup> => \{\s+const minted = await mintUnderLock/);
    const indicator = src.slice(src.indexOf('async function indicatorEngine()'), src.indexOf('async function mintUnderLock('));
    expect(indicator.match(/mintUnderLock\(/g)?.length).toBe(1);
    expect(indicator).toMatch(/commit: \(\) => mintUnderLock\(/);
  });
});

describe('8. no future information affects selection', () => {
  it('a candidate\'s rank inputs are identical with or without the bars after its decision', () => {
    const i = start + 7;
    const cut = prepareMomentumSeries(allBars.slice(0, i + 1));
    const ctxCut = buildSeriesContext(cut);
    const ctxFull = buildSeriesContext(series);
    const a = evaluateTriggersAt(ctxCut, runSessionEvents(ctxCut, s), i, ['A2']);
    const b = evaluateTriggersAt(ctxFull, runSessionEvents(ctxFull, s), i, ['A2']);
    expect(a.length).toBeGreaterThan(0);
    const rank = (c: TriggerCandidate) => routedSlotCandidate({ candidate: c } as RoutedCandidate);
    expect(a.map(rank)).toEqual(b.map(rank));
  });
  it('the ranking reads decision-time fields only (no outcome, MFE, exit or result field exists on a slot candidate)', () => {
    expect(Object.keys(slot({})).sort()).toEqual(['decisionTime', 'evidence', 'movePotential', 'netRR', 'remainingMovePct', 'source', 'timingClass']);
  });
});

describe('9. research / paper triggers cannot create real trades', () => {
  it('the server has no broker order path at all', () => {
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
  it('a trigger-family paper trade is stamped as paper research, never pooled with S1 or the indicator engine', () => {
    const base = liveLogicStamp();
    expect(paperResearchStamp(base, 'A3').logicVersion).toBe(`${base.logicVersion}+paper-research.A3`);
    expect(paperResearchStamp(base, undefined)).toBe(base);
  });
  it('stages: no family has been promoted to PAPER or ACTIVE; research families are PAPER_RESEARCH', () => {
    const stages = liveTriggerStages();
    for (const [id, st] of Object.entries(stages)) {
      if (id === 'S1') expect(st).toBe('ACTIVE');
      else expect(['PAPER_RESEARCH', 'RETIRED'], id).toContain(st);
    }
  });
});
