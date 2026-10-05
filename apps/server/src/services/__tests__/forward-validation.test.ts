// ============================================================
// FORWARD VALIDATION + SLOT DECISIONS + SIGNAL ENGINE METRICS (2026-10-05)
// ============================================================
// Pure graders (predicted vs actual), the slot-decision row and the
// diagnostics aggregates. All inputs are FABRICATED fixtures.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import type { OptionCandidate } from '@fno/shared';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const fv = await import('../forward-validation.js');
const sd = await import('../slot-decisions.js');
const m = await import('../signal-engine-metrics.js');
const sa = await import('../slot-arbitration.js');

const T0 = Date.parse('2026-08-10T10:00:00+05:30');
const M15 = 15 * 60 * 1000;
const bar = (k: number, high: number, low: number, close: number) => ({ time: T0 + k * M15, high, low, close });

describe('EVIDENCE_RANK: each candidate on its own levels, after its decision only', () => {
  const c = { direction: 'BULLISH', entry: 100, stop: 95, objective: 110, decisionTime: T0 + M15 };
  it('target first → +reward/risk; the decision bar itself is never read', () => {
    // Bar 0 (before the decision) would stop it — it must be ignored.
    expect(fv.gradeLevels(c, [bar(0, 101, 90, 100), bar(1, 104, 99, 103), bar(2, 111, 102, 110)])).toEqual({ outcome: 'TARGET', r: 2, barsToResolve: 2 });
  });
  it('a bar touching both counts the stop', () => {
    expect(fv.gradeLevels(c, [bar(1, 111, 94, 100)])).toEqual({ outcome: 'STOP', r: -1, barsToResolve: 1 });
  });
  it('unresolved at the session end is OPEN, marked at the last close; bearish mirrors', () => {
    expect(fv.gradeLevels(c, [bar(1, 104, 99, 102.5)])).toEqual({ outcome: 'OPEN', r: 0.5, barsToResolve: null });
    expect(fv.gradeLevels({ direction: 'BEARISH', entry: 100, stop: 105, objective: 90, decisionTime: T0 }, [bar(0, 101, 89, 90)])).toEqual({ outcome: 'TARGET', r: 2, barsToResolve: 1 });
  });
  it('missing or inverted geometry is not graded', () => {
    expect(fv.gradeLevels({ ...c, objective: null }, [bar(1, 1, 1, 1)]).outcome).toBe('NO_GEOMETRY');
    expect(fv.gradeLevels({ ...c, stop: 101 }, [bar(1, 1, 1, 1)]).outcome).toBe('NO_GEOMETRY');
    expect(fv.gradeLevels(c, []).outcome).toBe('NO_BARS');
  });
  it('groups realised R by confirmation count and says whether the top-ranked one was best', () => {
    const cands = [
      { source: 'S1', candidateId: 'a', direction: 'BULLISH', role: 'SELECTED', rank: 1, preBuildRank: 1, confirmations: 3, decisionTime: T0 + M15, entry: 100, stop: 95, objective: 110 },
      { source: 'A3', candidateId: 'b', direction: 'BULLISH', role: 'ALTERNATIVE', rank: 2, preBuildRank: 2, confirmations: 1, decisionTime: T0 + M15, entry: 100, stop: 99, objective: 120 },
      { source: 'INDICATOR', candidateId: 'c', direction: 'BULLISH', role: 'INELIGIBLE', rank: null, preBuildRank: 3, confirmations: 1, decisionTime: T0 + M15, entry: 100, stop: 90, objective: 130 },
    ];
    const g = fv.gradeEvidenceRank(cands, [bar(1, 104, 98.5, 103), bar(2, 111, 102, 110)]);
    expect((g.actual as any).candidates.map((x: any) => [x.candidateId, x.outcome, x.r])).toEqual([['a', 'TARGET', 2], ['b', 'STOP', -1], ['c', 'OPEN', 1]]);
    expect((g.actual as any).byConfirmations['3']).toEqual({ n: 1, avgR: 2, targets: 1, stops: 0 });
    expect((g.actual as any).byConfirmations['1']).toEqual({ n: 2, avgR: 0, targets: 0, stops: 1 });
    expect((g.actual as any).topWasBest).toBe(true);
    expect((g.actual as any).rankVsRealised).toBe(0.5);
  });
});

describe('OPTION_PAYOFF and STRIKE_SELECTION', () => {
  const leg = (bid: number, ask: number) => ({ bid, ask, ltp: (bid + ask) / 2 }) as any;
  const chain = (ce: Record<number, [number, number]>, expiry = '2026-08-13') => ({ expiry, strikes: Object.entries(ce).map(([k, [b, a]]) => ({ strike: Number(k), call: leg(b, a), put: null })) }) as any;

  it('marks are the mid of a two-sided quote, on the plan expiry only', () => {
    expect(fv.markOf(chain({ 100: [9, 11] }), 'CE', 100, '2026-08-13')).toBe(10);
    expect(fv.markOf(chain({ 100: [9, 11] }, '2026-08-20'), 'CE', 100, '2026-08-13')).toBeNull();
    expect(fv.markOf(chain({ 100: [9, 11] }), 'PE', 100, '2026-08-13')).toBeNull();
  });

  it('the premium path is (entry, exit] in time order', () => {
    const chains = [{ at: 3, chain: chain({ 100: [11, 13] }) }, { at: 1, chain: chain({ 100: [9, 11] }) }, { at: 2, chain: chain({ 100: [13, 15] }) }, { at: 9, chain: chain({ 100: [1, 2] }) }];
    expect(fv.premiumPath(chains, 'CE', 100, '2026-08-13', 1, 3)).toEqual([{ at: 2, premium: 14 }, { at: 3, premium: 12 }]);
  });

  it('projected vs actual: the target reached, and the share of the projection the contract offered', () => {
    const g = fv.gradeOptionPayoff({ entry: 100, target: 140, stop: 85, projectedPayoff: { netGain: 40, deltaGain: 45, gammaGain: 3, thetaDecay: 8, holdHours: 2 }, outcome: 'LOSS', exitPrice: 85, path: [{ at: 1, premium: 120 }, { at: 2, premium: 85 }] });
    expect(g.predicted).toMatchObject({ projectedGainPct: 0.4 });
    expect(g.actual).toMatchObject({ realisedPct: -0.15, maxPremium: 120, maxGainPct: 0.2, targetReached: false, projectionCaptured: 0.5, marks: 2 });
  });

  it('strike selection: was the selected strike the best at the exit, and did the ranking order realised R', () => {
    const cand = (strike: number, status: OptionCandidate['status'], rank: number | null, premium = 100): OptionCandidate =>
      ({ side: 'CE', strike, token: null, expiry: '2026-08-13', delta: 0.5, spreadPct: 1, premium, premiumRisk: 20, targetPotential: 0.4, netRR: 1.5, comparableRR: 1.5, status, rank, rejectedAt: status === 'REJECTED' ? 'SPREAD' : null, rejectionReason: null });
    const exits: Record<number, number> = { 100: 130, 150: 110, 200: 105, 250: 140 };
    const g = fv.gradeStrikeSelection([cand(100, 'SELECTED', 1), cand(150, 'RANKED', 2), cand(200, 'RANKED', 3), cand(250, 'REJECTED', null)], (c) => exits[c.strike]);
    expect(g.actual).toMatchObject({ selectedReturnR: 1.5, bestStrike: 250, bestReturnR: 2, selectedWasBest: false, rankVsRealised: 1, rejectedAvgReturnR: 2 });
    expect((g.predicted as any).selectedStrike).toBe(100);
  });

  it('spearman: perfect, inverse, too few', () => {
    expect(fv.spearman([1, 2, 3], [10, 20, 30])).toBe(1);
    expect(fv.spearman([1, 2, 3], [30, 20, 10])).toBe(-1);
    expect(fv.spearman([1, 2], [1, 2])).toBeNull();
  });

  it('a graded day is a finished IST day', () => {
    expect(new Date(fv.istDayStart(Date.parse('2026-08-10T23:30:00+05:30'))).toISOString()).toBe('2026-08-09T18:30:00.000Z');
  });
});

describe('the slot-decision row', () => {
  const slot = (source: string, preBuildRank: number, extra: any = {}) => ({
    ...sa.indicatorSlotCandidate(`${source}:id`, 'BULLISH', null, T0, { direction: 'BULLISH', entry: 100, stop: 95, objective: 110, anchor: null, onAnchorBar: false }),
    source,
    candidateId: `${source}:id`,
    ...extra,
    _p: preBuildRank,
  });
  const rec = (source: string, role: any, preBuildRank: number, refusalCode: string | null, extra: any = {}) =>
    ({ slot: slot(source, preBuildRank), role, rank: role === 'INELIGIBLE' ? null : extra.rank ?? 1, preBuildRank, reason: '', refusalCode, optionBuildFailure: extra.optionBuildFailure ?? null, criteriaUsed: [], criteriaSkipped: [], slotDecision: { slot: 'FREE', decision: role === 'SELECTED' ? 'MINTED' : 'NOT_SELECTED', heldSignalId: null }, finalCheck: extra.finalCheck }) as any;
  const versions = { option: 'OPTION-2.0', arbitration: 'ARB-2.0', optionSelection: 'OPTSEL-2.0' };

  it('a mint after a fall-through: fellthrough, final-check failures, rejection categories, geometry', () => {
    const records = [
      rec('A3', 'INELIGIBLE', 1, 'STALE_QUOTE', { finalCheck: true }),
      rec('S1', 'SELECTED', 2, null, { rank: 2 }),
      rec('B2', 'INELIGIBLE', 3, 'COST_EXCEEDS_EDGE', { optionBuildFailure: 'x' }),
      rec('INDICATOR', 'INELIGIBLE', 4, 'WIDE_SPREAD', { optionBuildFailure: 'x' }),
    ];
    const row = sd.slotDecisionRow({ at: T0, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', decisionBarTime: T0, records, minted: true, noTrade: null, versions });
    expect(row).toMatchObject({ outcome: 'MINTED', candidates: 4, fellthrough: 1, preMintFailures: 1, selectedSource: 'S1', limitingStage: null });
    expect(row.diagnostics.rejections).toEqual({ thetaCost: 1, liquidity: 1, other: 1 });
    expect(row.diagnostics.byCode).toEqual({ STALE_QUOTE: 1, COST_EXCEEDS_EDGE: 1, WIDE_SPREAD: 1 });
    expect(row.diagnostics.candidates[1]).toMatchObject({ source: 'S1', entry: 100, stop: 95, objective: 110, stage: null });
    expect(row.diagnostics.candidates[2]).toMatchObject({ stage: 'OPTION_COST_LIQUIDITY', category: 'THETA_COST' });
  });

  it('NO TRADE carries the limiting factor; no records is NO_CANDIDATE', () => {
    const nt = { limitingFactor: { stage: 'OPTION_COST_LIQUIDITY', code: 'COST_EXCEEDS_EDGE', summary: '' } } as any;
    expect(sd.slotDecisionRow({ at: T0, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', decisionBarTime: T0, records: [rec('B2', 'INELIGIBLE', 1, 'COST_EXCEEDS_EDGE')], minted: false, noTrade: nt, versions })).toMatchObject({ outcome: 'NO_TRADE', limitingStage: 'OPTION_COST_LIQUIDITY', limitingCode: 'COST_EXCEEDS_EDGE', fellthrough: 0 });
    expect(sd.slotDecisionRow({ at: T0, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', decisionBarTime: T0, records: [], minted: false, noTrade: nt, versions }).outcome).toBe('NO_CANDIDATE');
  });

  it('categories: theta / cost vs liquidity', () => {
    expect(sd.rejectionCategory('UNREALISTIC_TARGET')).toBe('THETA_COST');
    expect(sd.rejectionCategory('LOW_OPTION_LIQUIDITY')).toBe('LIQUIDITY');
    expect(sd.rejectionCategory('POST_LOSS_COOLDOWN')).toBe('OTHER');
  });
});

describe('signal engine metrics (pure aggregates)', () => {
  const row = (bar: number, outcome: string, extra: any = {}) => ({ symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', decision_bar_time: new Date(T0 + bar * M15), outcome, candidates: 2, fellthrough: 0, pre_mint_failures: 0, limiting_stage: null, diagnostics: { rejections: { thetaCost: 1, liquidity: 0, other: 0 }, byCode: { COST_EXCEEDS_EDGE: 1 } }, ...extra });

  it('a bar with a mint reads as MINTED once; NO TRADE rate, rejections and fallback success', () => {
    const a = m.aggregateSlotDecisions([
      row(0, 'NO_TRADE', { limiting_stage: 'OPTION_COST_LIQUIDITY' }),
      row(0, 'MINTED', { pre_mint_failures: 1, fellthrough: 1 }),
      row(1, 'NO_TRADE', { limiting_stage: 'OPTION_COST_LIQUIDITY', pre_mint_failures: 1 }),
      row(2, 'MINTED'),
      row(3, 'NO_CANDIDATE', { candidates: 0, diagnostics: null }),
    ]);
    expect(a).toMatchObject({ bars: 4, minted: 2, noTrade: 1, noCandidate: 1, noTradeRate: 0.333, candidates: 6 });
    expect(a.rejections.thetaCost).toEqual({ n: 3, shareOfCandidates: 0.5, shareOfRejections: 1 });
    expect(a.fallback).toEqual({ needed: 2, succeeded: 1, successRate: 0.5, mintedBelowFirst: 1 });
    expect(a.noTradeLimitingStages).toEqual({ OPTION_COST_LIQUIDITY: 1 });
  });

  it('strike-level rejections by stage', () => {
    const s = m.aggregateStrikeRejections([{ rejected_strikes: [{ rejectedAt: 'SPREAD' }, { rejectedAt: 'TARGET_POTENTIAL' }, { rejectedAt: 'DELTA' }], n_candidates: 10 }]);
    expect(s).toMatchObject({ strikesEvaluated: 10, thetaCost: 1, liquidity: 1, thetaCostRate: 0.1, byStage: { SPREAD: 1, TARGET_POTENTIAL: 1, DELTA: 1 } });
  });

  it('forward outcomes: expected vs actual payoff, strike selection, evidence by confirmations', () => {
    const f = m.aggregateForwardOutcomes([
      { kind: 'OPTION_PAYOFF', predicted: { projectedGainPct: 0.4, projectedPayoff: { thetaDecay: 8 } }, actual: { realisedPct: -0.15, maxGainPct: 0.2, targetReached: false, projectionCaptured: 0.5 } },
      { kind: 'OPTION_PAYOFF', predicted: { projectedGainPct: 0.3 }, actual: { realisedPct: 0.3, maxGainPct: 0.35, targetReached: true, projectionCaptured: 1.1667 } },
      { kind: 'STRIKE_SELECTION', predicted: {}, actual: { selectedWasBest: true, selectedReturnR: 1, bestReturnR: 1, rankVsRealised: 0.5 } },
      { kind: 'EVIDENCE_RANK', predicted: {}, actual: { topWasBest: false, topR: -1, byConfirmations: { '1': { n: 2, avgR: -1, targets: 0, stops: 2 }, '3': { n: 1, avgR: 2, targets: 1, stops: 0 } } } },
      { kind: 'EVIDENCE_RANK', predicted: {}, actual: { topWasBest: true, topR: 2, byConfirmations: { '3': { n: 1, avgR: 1, targets: 1, stops: 0 } } } },
    ]);
    expect(f.optionPayoff).toMatchObject({ n: 2, avgProjectedGainPct: 0.35, avgRealisedPct: 0.075, targetReachedRate: 0.5, avgProjectedTheta: 8 });
    expect(f.strikeSelection).toMatchObject({ n: 1, selectedWasBestRate: 1 });
    expect(f.evidenceRank.byConfirmations).toEqual({ '1': { n: 2, avgR: -1, targetRate: 0, stopRate: 1 }, '3': { n: 2, avgR: 1.5, targetRate: 1, stopRate: 0 } });
    expect(f.evidenceRank).toMatchObject({ n: 2, topWasBestRate: 0.5, avgTopR: 0.5 });
  });
});
