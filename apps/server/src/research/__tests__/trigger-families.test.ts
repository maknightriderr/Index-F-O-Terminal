// ============================================================
// DISPLACEMENT IS TRIGGER-SPECIFIC — the trigger-family layer
// ============================================================
// 1. A setup exists before displacement is checked: a sweep the structure
//    engine (S1) drops for NO_DISPLACEMENT is still a candidate for A2.
// 2. No universal displacement gate: only S1 and C2 require one.
// 3. Each family keeps its own rule; non-displacement candidates reach risk
//    validation and option feasibility.
// 4. Unvalidated families paper-trade as PAPER_RESEARCH (RESEARCH_PAPER_TRADING,
//    rollback to SHADOW by setting); PAPER only through a code-level promotion.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
  EVENT_ENGINE_TRIGGER_IDS,
  type MomentumBar,
} from '@fno/analytics';
import { resolveTriggerStage, parseTriggerStages, TRIGGER_PROMOTIONS, TRIGGER_VERSION, RESEARCH_PAPER_TRADING, PAPER_TRADING_STAGES } from '../../config/trading-flags.js';
import { liveTriggerStages, liveRoutedTriggerIds, validateCandidateRisk, lifecycleFromCandidate, routedLifecycleId, type RoutedCandidate } from '../../services/trigger-router.js';
import { structureSequenceRefusal } from '../../services/structure-live.js';

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
/** A sweep of the previous day's high with NO displacement candle afterwards, then a close through a 3-bar swing low. */
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
const series = prepareMomentumSeries([...days.flatMap(quiet), ...sweepNoDisplacement()]);
const s = series.sessionDates.indexOf('2026-08-10');
const start = series.sessionStarts[s];

describe('a setup exists before displacement is checked', () => {
  it('S1 (the structure engine) drops the sweep for NO_DISPLACEMENT …', () => {
    const variant = STRUCTURE_VARIANTS.find((v) => v.dispMult === 1 && !v.openingGuard)!;
    const evalAt = evaluateStructureSession(series, start + 8, variant);
    const swept = evalAt.setups.find((x) => x.direction === 'BEARISH' && x.sweep.index === start + 3)!;
    expect(swept).toBeDefined();
    expect(swept.stage).toBe('INVALIDATED');
    expect(swept.history.some((h) => h.reason === 'NO_DISPLACEMENT')).toBe(true);
  });

  it('… but the same sweep continues as an A2 candidate and reaches risk validation', () => {
    const ctx = buildSeriesContext(series);
    const log = runSessionEvents(ctx, s);
    const [c] = evaluateTriggersAt(ctx, log, start + 7, ['A2']);
    expect(c).toMatchObject({ triggerId: 'A2', direction: 'BEARISH', anchorIndex: start + 3 });
    expect(log.events.some((e) => e.type === 'DISPLACEMENT' && e.direction === 'BEARISH' && e.barIndex <= start + 7)).toBe(false);
    // Evidence, move potential and timing travel with it into risk validation.
    expect(c.movePotential.class).toMatch(/LOW|NORMAL|HIGH/);
    expect(c.timing.class).toMatch(/EARLY|OPTIMAL|ACCEPTABLE|LATE|CHASING/);
    const risk = validateCandidateRisk(c, { sessionOk: true, costPct: 3, maxCostPct: 5 });
    expect(risk.bucket).toBe(c.bucket);
    // Since 2026-10-05 net R:R is not a gate: TRADE and LOW_RR (valid geometry) both trade; only NO_TARGET / INVALID_STOP do not.
    expect(risk.wouldTrade).toBe(c.bucket === 'TRADE' || c.bucket === 'LOW_RR');
  });
});

describe('no universal displacement gate', () => {
  it('only S1 and C2 require a displacement; every other family has its own rule', () => {
    expect([...DISPLACEMENT_REQUIRED_BY].sort()).toEqual(['C2', 'S1']);
    for (const t of TRIGGER_REGISTRY) {
      const mentions = /DISPLACEMENT/.test(t.exactRule);
      expect(mentions, t.triggerId).toBe(DISPLACEMENT_REQUIRED_BY.includes(t.triggerId));
    }
  });
  it('S1 is the structure engine itself; every other rule is evaluated by the event engine', () => {
    expect(EVENT_ENGINE_TRIGGER_IDS).not.toContain('S1');
    expect(EVENT_ENGINE_TRIGGER_IDS).toEqual(TRIGGER_REGISTRY.map((t) => t.triggerId).filter((id) => id !== 'S1'));
  });
  it('trigger rows are versioned so pre-change rows stay distinguishable', () => {
    expect(TRIGGER_VERSION).toBe('FAMILIES-1.0');
  });
});

describe('stages: research families paper-trade, nothing has earned PAPER', () => {
  it('defaults: S1 ACTIVE, the SWEEP_CLOSE restatements RETIRED, every other family PAPER_RESEARCH, nothing promoted to PAPER', () => {
    expect(RESEARCH_PAPER_TRADING).toBe(true);
    expect(TRIGGER_PROMOTIONS).toEqual({});
    const stages = liveTriggerStages();
    expect(stages.S1).toBe('ACTIVE');
    expect(stages.A1).toBe('RETIRED');
    expect(stages.F4).toBe('RETIRED');
    for (const [id, st] of Object.entries(stages)) if (!['S1', 'A1', 'F4'].includes(id)) expect(st, id).toBe('PAPER_RESEARCH');
    expect(Object.values(stages).filter((x) => x === 'PAPER')).toEqual([]);
    expect(PAPER_TRADING_STAGES).toEqual(['PAPER_RESEARCH', 'PAPER', 'ACTIVE']);
  });
  it('RESEARCH_PAPER_TRADING off puts every research family back to SHADOW (rollback without a deploy)', () => {
    expect(resolveTriggerStage('A3', 'SHADOW', {}, {}, false)).toBe('SHADOW');
    expect(resolveTriggerStage('A3', 'SHADOW', {}, {}, true)).toBe('PAPER_RESEARCH');
    expect(resolveTriggerStage('A1', 'RETIRED', {}, {}, true)).toBe('RETIRED');
  });
  it('the router evaluates paper-research families live, never RETIRED ones', () => {
    const ids = liveRoutedTriggerIds();
    expect(ids).toContain('A2');
    expect(ids).toContain('B2');
    expect(ids).not.toContain('A1');
    expect(ids).not.toContain('S1');
  });
  it('a setting can only demote; promotion needs a code-level record', () => {
    const { overrides, rejected } = parseTriggerStages('A2=PAPER, B2=RESEARCH, A3=SHADOW, junk');
    expect(rejected).toEqual(['junk']);
    expect(resolveTriggerStage('A2', 'SHADOW', {}, overrides, true)).toBe('PAPER_RESEARCH');
    expect(resolveTriggerStage('B2', 'SHADOW', {}, overrides, true)).toBe('RESEARCH');
    expect(resolveTriggerStage('A3', 'SHADOW', {}, overrides, true)).toBe('SHADOW');
    const promoted = { A2: { stage: 'PAPER' as const, evidence: 'OOS pass + 30 forward trades', approvedOn: '2026-12-01' } };
    expect(resolveTriggerStage('A2', 'SHADOW', promoted, {})).toBe('PAPER');
    expect(resolveTriggerStage('A1', 'RETIRED', { A1: { stage: 'PAPER', evidence: 'x', approvedOn: 'x' } }, {})).toBe('RETIRED');
  });
  it('the slot builds a routed candidate only at a paper-trading stage, and before any arbitration', () => {
    const src = readFileSync(fileURLToPath(new URL('../../services/market-bias.ts', import.meta.url)), 'utf8');
    const loop = src.slice(src.indexOf('for (const rc of multipathFamily?.candidates ?? [])'), src.indexOf('let indicator: TradeSetup | SlotEntry'));
    expect(loop).toMatch(/if \(!PAPER_TRADING_STAGES\.includes\(rc\.stage\)\) continue;/);
    expect(loop.indexOf('PAPER_TRADING_STAGES.includes(rc.stage)')).toBeLessThan(loop.indexOf('resolveStructureSetup'));
    // Every eligible candidate is built (no per-poll cap, no pre-selection) and handed to the slot arbitration.
    expect(loop).not.toMatch(/break;/);
    expect(loop).toMatch(/entries\.push\(\s*await resolveStructureSetup\(/);
  });
});

describe('risk validation and the PAPER adapter', () => {
  const c = {
    triggerId: 'B2',
    family: 'BREAKOUT_ACCEPTANCE',
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
    anchorEventId: 'MAJOR_LEVEL_BREAK:x',
    anchorIndex: 96,
    anchorPrice: 195,
    eventIds: [],
    marketState: 'TRENDING_UP',
    movePotential: { class: 'NORMAL' },
    timing: { class: 'OPTIMAL' },
  } as unknown as RoutedCandidate['candidate'];

  it('wouldTrade only with valid geometry, the session window and cost under the ceiling', () => {
    expect(validateCandidateRisk(c, { sessionOk: true, costPct: 2, maxCostPct: 5 })).toMatchObject({ wouldTrade: true, reason: null });
    expect(validateCandidateRisk(c, { sessionOk: true, costPct: 7, maxCostPct: 5 }).reason).toMatch(/COST_TOO_HIGH/);
    expect(validateCandidateRisk(c, { sessionOk: false, costPct: 2, maxCostPct: 5 }).wouldTrade).toBe(false);
    expect(validateCandidateRisk({ ...c, bucket: 'NO_TARGET' }, { sessionOk: true, costPct: null, maxCostPct: 5 }).reason).toMatch(/NO_TARGET/);
  });

  it('a PAPER candidate becomes the structure chain\'s lifecycle: filled at the decision close, invalidation at the rule\'s extreme', () => {
    const rc: RoutedCandidate = { candidate: c, stage: 'PAPER', risk: validateCandidateRisk(c, { sessionOk: true, costPct: 2, maxCostPct: 5 }), cost: null, lifecycleId: routedLifecycleId('NSE', 'NIFTY', c) };
    const lc = lifecycleFromCandidate(rc);
    expect(lc).toMatchObject({ id: `NSE:NIFTY:MP:B2:BULLISH:${c.decisionTime}`, triggerId: 'B2', entry: 200, rejectionFillPrice: 200, stop: 190, sweepExtreme: 191, zone: null });
    // The structure chain's own sequence gate accepts it at the decision close …
    expect(structureSequenceRefusal(lc, 200)).toBeNull();
    // … still accepts it close to T1 (low R:R is display only since 2026-10-05) …
    expect(structureSequenceRefusal(lc, 225)).toBeNull();
    // … and refuses it only once price is at / through T1 or the stop (genuine geometry).
    expect(structureSequenceRefusal(lc, 230)?.code).toBe('STRUCTURE_SEQUENCE');
    expect(structureSequenceRefusal(lc, 189)?.code).toBe('STRUCTURE_SEQUENCE');
  });
});
