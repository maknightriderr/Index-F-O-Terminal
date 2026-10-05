// ============================================================
// PHASE 3 — the OptionCandidate pipeline and the persisted option plan.
//   same snapshot (chain) → same strike, whatever the strike order
//   rank #1 fails (wide spread / build refusal) → #2 is traded, #1 recorded
//   a low-R:R but otherwise valid option is selected, never rejected
//   every strike recorded with its stage and reason; deterministic tie-break
//   the option plan row (underlying + option levels, rejected strikes, T2)
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import type { OptionChain, OptionChainLeg, OptionChainStrike, TradeSetup } from '@fno/shared';
import { OPTION_CANDIDATE_STAGES } from '@fno/shared';
import { leg } from './trade-setup-fixtures.js';

vi.mock('../../lib/db.js', () => ({ sql: () => undefined }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { validateOnChain, rankStrikeBuilds, stageOfRefusal, preBuildRejection, strikeNetRR } = await import('../fno-validation.js');
const { buildOptionPlanRow, optionT2, optionLevelsOf, planIdFor } = await import('../option-plans.js');
const { canonicalJson } = await import('../decision-record.js');

const PARAMS = { deltaMin: 0.35, deltaMax: 0.65, deltaTarget: 0.5 };
const CONTEXT = { expectedMovePoints: 120, expectedHoldHours: 3, ivRank: null, hvPct: null, ivCap: null };
const liquid = { volume: 50_000, oi: 500_000, theta: -2 };

function putRow(strike: number, over: Partial<OptionChainLeg>, dist = 0): OptionChainStrike {
  return { strike, distanceFromSpot: dist, call: null, put: leg({ token: `PE${strike}`, ...over }) };
}
function chainOf(strikes: OptionChainStrike[]): OptionChain {
  return {
    symbol: 'SYN', underlying: 'SYN', exchange: 'NSE', spotPrice: 25000, underlyingChange: null, underlyingChangePercent: null,
    expiry: '2030-01-07', availableExpiries: ['2030-01-07'], dte: 3, strikeInterval: 100, atmStrike: 25000, lotSize: 75, strikes,
    pcr: 1, pcrDetail: { oiPCR: 1, volumePCR: 1, changeOiPCR: 1, nearAtmPCR: 1 }, maxPain: 25000, maxPainDistance: 0,
    expectedMove: { points: 100, upperBound: 25100, lowerBound: 24900 },
  } as unknown as OptionChain;
}

/** A synthetic builder: per strike, the premium levels (or a refusal) it returns. */
function builder(plan: Record<number, { entry: number; sl: number; target: number; cost?: number } | { refuse: string }>) {
  return (_chain: OptionChain, strike: number): TradeSetup => {
    const p = plan[strike];
    if (!p) return { available: false, noTradeCode: 'NO_QUOTE', reason: 'no plan' } as TradeSetup;
    if ('refuse' in p) return { available: false, noTradeCode: p.refuse as any, reason: `refused ${p.refuse}` } as TradeSetup;
    return { available: true, reason: 'built', side: 'PE', strike, entry: p.entry, stopLoss: p.sl, target: p.target, estimatedCostPct: p.cost ?? 1, expiry: '2030-01-07' } as TradeSetup;
  };
}

const rows = [
  putRow(24800, { ...liquid, ltp: 25, bid: 24.9, ask: 25.1, delta: -0.2, moneyness: 'OTM' }, -200), // out of band
  putRow(24900, { ...liquid, ltp: 45, bid: 44.9, ask: 45.1, delta: -0.38, moneyness: 'OTM' }, -100),
  putRow(25000, { ...liquid, ltp: 70, bid: 69.9, ask: 70.1, delta: -0.5, moneyness: 'ATM' }),
  putRow(25100, { ...liquid, ltp: 110, bid: 109.9, ask: 110.1, delta: -0.62, moneyness: 'ITM' }, 100),
  putRow(25200, { ltp: 150, bid: 149.9, ask: 150.1, delta: -0.6, volume: 3, oi: 10, theta: -2, moneyness: 'ITM' }, 200), // illiquid
  putRow(25300, { ltp: 0, bid: 0, ask: 0, delta: -0.7, volume: 0, oi: 0, theta: 0, moneyness: 'ITM' }, 300), // no quote
];
const plan = {
  24900: { entry: 45, sl: 30, target: 75 }, // net ≈ 1.9
  25000: { entry: 70, sl: 50, target: 110 }, // net ≈ 1.9 (lower spread … ties broken by the ladder)
  25100: { entry: 110, sl: 85, target: 140 }, // net ≈ 1.1
};

describe('OptionCandidate pipeline', () => {
  it('same chain → same strike and the same candidate record, whatever order the strikes arrive in', () => {
    const run = (strikes: OptionChainStrike[]) => validateOnChain({ chain: chainOf(strikes), side: 'PE', params: PARAMS, context: CONTEXT, build: builder(plan) });
    const base = run(rows);
    const reversed = run([...rows].reverse());
    const shuffled = run([rows[3], rows[0], rows[5], rows[2], rows[4], rows[1]]);
    expect(base.setup.available).toBe(true);
    for (const r of [reversed, shuffled, run(rows)]) {
      expect(r.setup.strike).toBe(base.setup.strike);
      expect(canonicalJson(r.fnoValidation!.strikeSelection!.optionCandidates)).toBe(canonicalJson(base.fnoValidation!.strikeSelection!.optionCandidates));
    }
  });

  it('records EVERY strike of the side: selected first, then ranked, then each rejection with its stage and reason', () => {
    const out = validateOnChain({ chain: chainOf(rows), side: 'PE', params: PARAMS, context: CONTEXT, build: builder(plan) });
    const cands = out.fnoValidation!.strikeSelection!.optionCandidates!;
    expect(cands.map((c) => c.strike).sort()).toEqual(rows.map((r) => r.strike).sort());
    expect(cands[0].status).toBe('SELECTED');
    expect(cands[0].rank).toBe(1);
    expect(cands[0].strike).toBe(out.setup.strike);
    const by = (k: number) => cands.find((c) => c.strike === k)!;
    expect(by(24800)).toMatchObject({ status: 'REJECTED', rejectedAt: 'DELTA' });
    expect(by(24800).rejectionReason).toMatch(/OUT_OF_BAND/);
    expect(by(25200)).toMatchObject({ status: 'REJECTED', rejectedAt: 'LIQUIDITY' });
    expect(by(25300)).toMatchObject({ status: 'REJECTED', rejectedAt: 'AVAILABILITY' });
    for (const c of cands) {
      expect(c.token).toBe(`PE${c.strike}`);
      if (c.status === 'REJECTED') expect(c.rejectionReason, String(c.strike)).toBeTruthy();
      if (c.rejectedAt) expect([...OPTION_CANDIDATE_STAGES, 'BUILD']).toContain(c.rejectedAt);
    }
    // Net R:R ranks; it is recorded on every built strike.
    expect(by(25100).status).toBe('RANKED');
    expect(by(25100).netRR).toBeCloseTo(strikeNetRR(builder(plan)(chainOf(rows), 25100))!, 6);
  });

  it('rank #1 has a wide spread → #2 is traded, and #1 is recorded REJECTED at SPREAD', () => {
    const wide = [
      putRow(25000, { ...liquid, ltp: 70, bid: 64, ask: 76, delta: -0.5, moneyness: 'ATM' }),
      putRow(25100, { ...liquid, ltp: 110, bid: 109.9, ask: 110.1, delta: -0.6, moneyness: 'ITM' }, 100),
    ];
    // 25000 would rank first on net R:R if it could be built.
    const out = validateOnChain({ chain: chainOf(wide), side: 'PE', params: PARAMS, context: CONTEXT, build: builder({ 25000: { entry: 70, sl: 55, target: 130 }, 25100: { entry: 110, sl: 85, target: 140 } }) });
    expect(out.setup.available).toBe(true);
    expect(out.setup.strike).toBe(25100);
    const c = out.fnoValidation!.strikeSelection!.optionCandidates!.find((x) => x.strike === 25000)!;
    expect(c).toMatchObject({ status: 'REJECTED', rejectedAt: 'SPREAD' });
    expect(c.rejectionReason).toMatch(/spread/i);
  });

  it('rank #1 fails its build → #2, #3 … until one passes; every refusal recorded at its stage', () => {
    const out = validateOnChain({
      chain: chainOf(rows),
      side: 'PE',
      params: PARAMS,
      context: CONTEXT,
      build: builder({ 24900: { refuse: 'COST_TOO_HIGH' }, 25000: { refuse: 'STOP_INSIDE_NOISE' }, 25100: { entry: 110, sl: 85, target: 140 } }),
    });
    expect(out.setup.strike).toBe(25100);
    const cands = out.fnoValidation!.strikeSelection!.optionCandidates!;
    expect(cands.find((c) => c.strike === 24900)).toMatchObject({ status: 'REJECTED', rejectedAt: 'SPREAD' });
    expect(cands.find((c) => c.strike === 25000)).toMatchObject({ status: 'REJECTED', rejectedAt: 'PREMIUM_RISK' });
    expect(cands.find((c) => c.strike === 25000)!.rejectionReason).toMatch(/^STOP_INSIDE_NOISE/);
  });

  it('a low-R:R but otherwise valid option is SELECTED, not rejected (net R:R only ranks)', () => {
    const out = validateOnChain({ chain: chainOf([rows[2]]), side: 'PE', params: PARAMS, context: CONTEXT, build: builder({ 25000: { entry: 70, sl: 50, target: 82 } }) });
    expect(out.setup.available).toBe(true);
    expect(out.setup.strike).toBe(25000);
    const c = out.fnoValidation!.strikeSelection!.optionCandidates![0];
    expect(c.status).toBe('SELECTED');
    expect(c.netRR!).toBeLessThan(1);
    expect(c.rejectedAt).toBeNull();
    // With a better-R:R strike beside it, the low one is RANKED (#2) — still never REJECTED.
    const two = validateOnChain({ chain: chainOf([rows[1], rows[2]]), side: 'PE', params: PARAMS, context: CONTEXT, build: builder({ 24900: { entry: 45, sl: 30, target: 80 }, 25000: { entry: 70, sl: 50, target: 82 } }) });
    expect(two.fnoValidation!.strikeSelection!.optionCandidates!.find((x) => x.strike === 25000)).toMatchObject({ status: 'RANKED', rank: 2, rejectedAt: null });
  });

  it('tie-break: strike, then token — a total order', () => {
    const s = (strike: number, token: string) => ({ strike, token, delta: -0.5, spreadPct: 0.2, setup: builder(plan)(chainOf(rows), 25000) });
    const a = rankStrikeBuilds([s(25000, 'B'), s(25000, 'A')], 0.5, 25000).map((b) => b.token);
    const b = rankStrikeBuilds([s(25000, 'A'), s(25000, 'B')], 0.5, 25000).map((b) => b.token);
    expect(a).toEqual(['A', 'B']);
    expect(b).toEqual(['A', 'B']);
  });

  it('stage mapping: genuine checks only; NET_RR only for the research R:R gate', () => {
    expect(stageOfRefusal('NO_QUOTE')).toBe('AVAILABILITY');
    expect(stageOfRefusal('LOW_OPTION_LIQUIDITY')).toBe('LIQUIDITY');
    expect(stageOfRefusal('WIDE_SPREAD')).toBe('SPREAD');
    expect(stageOfRefusal('COST_TOO_HIGH')).toBe('SPREAD');
    expect(stageOfRefusal('OPTION_DELTA_OUT_OF_BAND')).toBe('DELTA');
    expect(stageOfRefusal('STOP_INSIDE_NOISE')).toBe('PREMIUM_RISK');
    expect(stageOfRefusal('COST_EXCEEDS_EDGE')).toBe('TARGET_POTENTIAL');
    expect(stageOfRefusal('REWARD_RISK_TOO_LOW')).toBe('NET_RR');
    // A wide-spread strike that is also illiquid is reported at the earlier stage.
    expect(preBuildRejection({ rejectedReason: 'WIDE_SPREAD', grade: 'UNTRADEABLE', spreadPct: 9 })!.stage).toBe('LIQUIDITY');
    expect(preBuildRejection({ rejectedReason: 'WIDE_SPREAD', grade: 'POOR', spreadPct: 9 })!.stage).toBe('SPREAD');
  });
});

describe('option plan', () => {
  const out = validateOnChain({ chain: chainOf(rows), side: 'PE', params: PARAMS, context: CONTEXT, build: builder(plan) });
  const setup: TradeSetup = { ...out.setup, fnoValidation: out.fnoValidation! };

  it('persists the underlying and option plans, the selected strike and every rejected strike', () => {
    const row = buildOptionPlanRow({
      signalId: 'sig-1', snapshotId: 'snap-1', symbol: 'SYN', exchange: 'NSE', mode: 'INTRADAY', source: 'S1', candidateId: 'L1', direction: 'BEARISH',
      underlying: { entry: 25000, stop: 25080, t1: 24860, t2: 24780 }, setup, chain: chainOf(rows),
    });
    expect(row.planId).toBe(planIdFor('sig-1'));
    expect(row.snapshotId).toBe('snap-1');
    expect(row.option).toMatchObject({ side: 'PE', strike: setup.strike, token: `PE${setup.strike}` });
    expect(row.levels).toMatchObject({ entry: setup.entry, sl: setup.stopLoss, tsl: setup.stopLoss, t1: setup.target });
    // T2: T1 plus |delta| × the extra underlying move beyond T1.
    const delta = Math.abs(out.fnoValidation!.strikeSelection!.delta!);
    expect(row.levels.t2).toBeCloseTo(setup.target! + delta * 80, 2);
    expect(row.selectedStrike).toBe(setup.strike);
    expect(row.candidates.length).toBe(rows.length);
    expect(row.rejectedStrikes.map((c) => c.strike).sort()).toEqual(row.candidates.filter((c) => c.status === 'REJECTED').map((c) => c.strike).sort());
    expect(row.rejectedStrikes.every((c) => c.rejectionReason)).toBe(true);
  });

  it('T2 only when the underlying T2 lies beyond T1; levels track the trailing stop', () => {
    expect(optionT2({ t1Premium: 100, delta: -0.5, underlying: { entry: 100, stop: 110, t1: 90, t2: 80 }, direction: 'BEARISH' })).toBe(105);
    expect(optionT2({ t1Premium: 100, delta: 0.5, underlying: { entry: 100, stop: 90, t1: 110, t2: 105 }, direction: 'BULLISH' })).toBeNull();
    expect(optionT2({ t1Premium: 100, delta: null, underlying: { entry: 100, stop: 90, t1: 110, t2: 120 }, direction: 'BULLISH' })).toBeNull();
    const before = optionLevelsOf({ entry: 70, stopLoss: 50, target: 110, initialStopLoss: 50 }, null);
    const after = optionLevelsOf({ entry: 70, stopLoss: 70, target: 110, initialStopLoss: 50 }, null);
    expect(before).toEqual({ entry: 70, sl: 50, tsl: 50, t1: 110, t2: null });
    expect(after).toEqual({ entry: 70, sl: 50, tsl: 70, t1: 110, t2: null });
  });
});
