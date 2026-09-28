// ============================================================
// PHASE 2 — shadow models and observational labels
// ============================================================
// Every chain/setup number in this file is a FABRICATED fixture, not market
// data. The tests check the Phase 2 guarantees:
//   - the three shadow models compute what they claim, and
//   - none of them feeds back into buildTradeSetup's live decision;
//   - exposure, DTE buckets and invalidation reasons are pure labels.
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  buildTradeSetup,
  scoreStrikeCandidates,
  assessExecutionQuality,
  estimateTargetV2,
  analyzeTimeDecay,
  assessOptionQuality,
} from '@fno/analytics';
import { classifyDteBucket, classifyDteTier, type OptionChainLeg, type OptionChainStrike } from '@fno/shared';
import { computeExposure, toExposureSetup, familyOf, type ExposureSetup } from '../exposure-tracker.js';
import { invalidationReasonFromCloseReason } from '../invalidation-reason.js';
import { buildShadowComparison, type ShadowRow } from '../shadow-comparison-model.js';
import { buildAttributionReport, buckets, type AttributionRow } from '../loss-attribution-model.js';

// ---------------- FABRICATED FIXTURE ----------------
function leg(over: Partial<OptionChainLeg>): OptionChainLeg {
  return {
    token: 'SYNTH',
    ltp: 100,
    bid: 99,
    ask: 101,
    volume: 5000,
    oi: 50000,
    changeOi: 0,
    changePercent: 0,
    iv: 0.15,
    delta: 0.5,
    gamma: 0.002,
    theta: -5,
    vega: 10,
    oiInterpretation: 'NEUTRAL' as OptionChainLeg['oiInterpretation'],
    moneyness: 'ATM',
    greeksSource: 'BROKER',
    timestamp: 0,
    ...over,
  };
}

const SPOT = 25000;
const ATM = 25000;
const LOT = 75;

/**
 * ATM CE is thin (volume/OI just above the mechanical floors, 2% spread);
 * the 24900 CE one strike ITM is deep and tight. A non-ATM strike is
 * clearly the better instrument.
 */
function fixtureStrikes(): OptionChainStrike[] {
  return [
    {
      strike: 24900,
      distanceFromSpot: -100,
      call: leg({ token: 'CE24900', ltp: 150, bid: 149.5, ask: 150.5, volume: 50000, oi: 500000, delta: 0.6, theta: -4, moneyness: 'ITM' }),
      put: leg({ token: 'PE24900', ltp: 50, bid: 49.5, ask: 50.5, delta: -0.4, moneyness: 'OTM' }),
    },
    {
      strike: ATM,
      distanceFromSpot: 0,
      call: leg({ token: 'CE25000', ltp: 100, bid: 99, ask: 101, volume: 150, oi: 600, delta: 0.5, theta: -5 }),
      put: leg({ token: 'PE25000', ltp: 100, bid: 99, ask: 101, delta: -0.5 }),
    },
    {
      strike: 25100,
      distanceFromSpot: 100,
      call: leg({ token: 'CE25100', ltp: 60, bid: 55, ask: 65, volume: 50, oi: 100, delta: 0.4, moneyness: 'OTM' }), // wide + dead
      put: leg({ token: 'PE25100', ltp: 150, bid: 149.5, ask: 150.5, delta: -0.6, moneyness: 'ITM' }),
    },
  ];
}

const MOVE = 100;
const HOLD_H = 5;

function liveSetup(strikes: OptionChainStrike[]) {
  return buildTradeSetup(strikes, ATM, 'BULLISH', 80, MOVE, undefined, null, 3, LOT, null, { tickSize: 0.05, expectedHoldHours: HOLD_H });
}

// ---------------- 1. STRIKE SELECTION (shadow) ----------------
describe('shadow strike selection', () => {
  it('picks a clearly better non-ATM candidate, scored by the existing option-quality assessment', () => {
    const sel = scoreStrikeCandidates({
      strikes: fixtureStrikes(),
      liveStrike: ATM,
      side: 'CE',
      expiry: '2026-10-01',
      expectedMovePoints: MOVE,
      dte: 3,
      expectedHoldHours: HOLD_H,
    });
    expect(sel.shadow).toBe(true);
    expect(sel.selectedStrike).toBe(24900);
    expect(sel.differsFromLive).toBe(true);
    expect(sel.candidatesEvaluated).toBe(3);

    // The score IS assessOptionQuality's, not a re-implementation.
    const reference = assessOptionQuality({
      entryPremium: 150,
      bid: 149.5,
      ask: 150.5,
      volume: 50000,
      openInterest: 500000,
      delta: 0.6,
      theta: -4,
      iv: 0.15,
      ivRank: null,
      hvPct: null,
      dte: 3,
      distanceFromSpot: 100,
      expectedMovePoints: MOVE,
      expectedHoldHours: HOLD_H,
      tickSize: 0.05,
      moneyness: 'ITM',
      greeksSource: 'BROKER',
    });
    expect(sel.selectionScore).toBe(reference.score);

    // The 25100 CE is refused by the existing spread ceiling; ATM is merely outscored.
    const byStrike = new Map(sel.rejectedAlternatives.map((c) => [c.strike, c]));
    expect(byStrike.get(25100)!.rejectedReason).toBe('WIDE_SPREAD');
    expect(byStrike.get(ATM)!.rejectedReason).toBe('LOWER_SCORE');
    expect(byStrike.get(ATM)!.isLive).toBe(true);
  });

  it('does NOT feed back into buildTradeSetup: the live setup is identical and still trades ATM', () => {
    const strikes = fixtureStrikes();
    const snapshot = JSON.stringify(strikes);
    const before = liveSetup(strikes);

    scoreStrikeCandidates({ strikes, liveStrike: ATM, side: 'CE', expiry: null, expectedMovePoints: MOVE, dte: 3, expectedHoldHours: HOLD_H });

    const after = liveSetup(strikes);
    expect(JSON.stringify(strikes)).toBe(snapshot); // input not mutated
    expect(after).toEqual(before);
    expect(before.available).toBe(true);
    expect(before.strike).toBe(ATM); // the live strike is still the ATM pick
  });
});

// ---------------- 2. EXECUTION QUALITY (shadow) ----------------
describe('shadow execution quality', () => {
  const setup = liveSetup(fixtureStrikes());

  it('enters at the ask with a two-sided quote and costs R versus the live mid', () => {
    const r = assessExecutionQuality({ bid: 99, ask: 101, ltp: 100, liveEntry: setup.entry!, stopLoss: setup.stopLoss!, target: setup.target!, lotSize: LOT });
    expect(r.executionQuality).toBe('NORMAL');
    expect(r.basis).toBe('ASK');
    expect(r.shadowEntryPrice).toBe(101);
    expect(r.liveNetR).not.toBeNull();
    expect(r.shadowNetR!).toBeLessThan(r.liveNetR!);
    expect(r.entrySlippage).toBe(1);
  });

  it.each([
    [null, null],
    [0, 0],
    [99, 0],
    [0, 101],
  ])('flags DEGRADED and falls back to LTP when bid=%s ask=%s', (bid, ask) => {
    const r = assessExecutionQuality({ bid, ask, ltp: 100, liveEntry: 100, stopLoss: 80, target: 150, lotSize: LOT });
    expect(r.executionQuality).toBe('DEGRADED');
    expect(r.basis).toBe('LTP_FALLBACK');
    expect(r.shadowEntryPrice).toBe(100);
  });

  it('does not change the live entry (mid) that buildTradeSetup produced', () => {
    expect(setup.entry).toBe(100); // (99 + 101) / 2
  });
});

// ---------------- 3. TARGET v2 (shadow) ----------------
describe('shadow gamma/theta target', () => {
  it('diverges from the delta-only target on a high-gamma leg', () => {
    const r = estimateTargetV2({
      entry: 100,
      stopLoss: 80,
      liveTarget: 150, // entry + 0.5 x 100
      delta: 0.5,
      gamma: 0.01, // high gamma: 0.5 x 0.01 x 100^2 = +50
      theta: -12, // 12/day over 6h = 3
      expectedMovePoints: 100,
      expectedHoldHours: 6,
      bid: 99,
      ask: 101,
      lotSize: LOT,
    });
    expect(r.deltaMove).toBe(50);
    expect(r.gammaTerm).toBe(50);
    expect(r.thetaDecay).toBe(3);
    expect(r.shadowTargetV2).toBe(197);
    expect(r.targetDivergence).toBe(47);
    expect(r.shadowExpectedNetRV2!).toBeGreaterThan(0);
  });

  it('reduces to the live delta-only target when gamma and theta are zero', () => {
    const r = estimateTargetV2({ entry: 100, stopLoss: 80, liveTarget: 150, delta: 0.5, gamma: 0, theta: 0, expectedMovePoints: 100, expectedHoldHours: 6, bid: 99, ask: 101, lotSize: LOT });
    expect(r.shadowTargetV2).toBe(150);
    expect(r.targetDivergence).toBe(0);
  });

  it('records unusable Greeks instead of inventing them', () => {
    const r = estimateTargetV2({ entry: 100, stopLoss: 80, liveTarget: 150, delta: 0.5, gamma: NaN, theta: null, expectedMovePoints: 100, expectedHoldHours: 6, bid: 99, ask: 101, lotSize: LOT });
    expect(r.missing).toEqual(['gamma', 'theta']);
    expect(r.shadowTargetV2).toBe(150);
  });

  it('leaves the live target at entry + delta x move', () => {
    const setup = liveSetup(fixtureStrikes());
    expect(setup.target).toBe(150);
  });
});

// ---------------- 4. EXPOSURE (live, observational) ----------------
describe('exposure tracker', () => {
  const s = (over: Partial<ExposureSetup>): ExposureSetup => ({
    key: 'trade_setup:NSE:NIFTY:INTRADAY',
    exchange: 'NSE',
    underlying: 'NIFTY',
    mode: 'INTRADAY',
    direction: 'BULLISH',
    strike: 25000,
    side: 'CE',
    expiry: '2026-10-01',
    riskAmount: 1500,
    ...over,
  });

  it('sums three simultaneous sticky setups and classifies same-direction / correlated exposure', () => {
    const current = s({});
    const others = [
      s({ key: 'trade_setup:NSE:BANKNIFTY:INTRADAY', underlying: 'BANKNIFTY', strike: 55000, riskAmount: 2000 }), // correlated, same direction
      s({ key: 'trade_setup:NSE:NIFTY:POSITIONAL', mode: 'POSITIONAL', riskAmount: 1000 }), // same contract, same underlying
      s({ key: 'trade_setup:NSE:RELIANCE:INTRADAY', underlying: 'RELIANCE', strike: 3000, direction: 'BEARISH', riskAmount: 500 }),
    ];
    const e = computeExposure(current, others);
    expect(e.simulated).toBe(true);
    expect(e.openSetupCount).toBe(4);
    expect(e.openSimulatedRisk).toBe(5000);
    expect(e.sameDirectionExposure).toBe(2);
    expect(e.correlatedExposure).toBe(1);
    expect(e.sameUnderlyingExposure).toBe(1);
    expect(e.sameSymbolExposure).toBe(1);
    expect(e.detail.riskBy.sameDirection).toBe(3000);
    expect(e.detail.riskBy.correlated).toBe(2000);
    expect(e.detail.family).toBe('INDIA_EQUITY_INDEX');
  });

  it('never counts the setup against itself and treats unknown symbols as their own family', () => {
    const current = s({});
    expect(computeExposure(current, [current]).openSetupCount).toBe(1);
    expect(familyOf('RELIANCE')).toBe('SELF:RELIANCE');
  });

  it('reads stop-distance risk from a stored setup and skips non-live ones', () => {
    const today = '2026-09-28';
    const stored = { available: true, direction: 'BULLISH' as const, day: today, strike: 25000, side: 'CE' as const, entry: 100, stopLoss: 80, positionSize: { quantity: 75 } };
    expect(toExposureSetup('trade_setup:NSE:NIFTY:INTRADAY', stored, today)!.riskAmount).toBe(1500);
    expect(toExposureSetup('trade_setup:NSE:NIFTY:INTRADAY', { ...stored, day: '2026-09-27' }, today)).toBeNull();
    expect(toExposureSetup('trade_setup:NSE:NIFTY:POSITIONAL', { ...stored, day: '2026-09-27' }, today)).not.toBeNull();
    expect(toExposureSetup('trade_setup:NSE:NIFTY:INTRADAY', { ...stored, available: false }, today)).toBeNull();
    // A stop trailed above entry carries no remaining risk.
    expect(toExposureSetup('trade_setup:NSE:NIFTY:INTRADAY', { ...stored, stopLoss: 110 }, today)!.riskAmount).toBe(0);
  });
});

// ---------------- 5. DTE BUCKETS (shared, one definition) ----------------
describe('DTE buckets', () => {
  it.each([
    [0, '0DTE'],
    [1, '1-3DTE'],
    [3, '1-3DTE'],
    [4, '4-7DTE'],
    [7, '4-7DTE'],
    [8, '8-30DTE'],
    [30, '8-30DTE'],
    [31, '30+DTE'],
  ] as const)('dte %s -> %s', (dte, bucket) => {
    expect(classifyDteBucket(dte)).toBe(bucket);
  });

  it('is null for unknown dte, and the report groups by the same buckets', () => {
    expect(classifyDteBucket(null)).toBeNull();
    expect(buckets.dte(null)).toBe('UNKNOWN');
    expect(buckets.dte(5)).toBe('4-7DTE');
  });

  it('the consolidated tier reproduces the three old inline tier expressions exactly', () => {
    for (let dte = -1; dte <= 40; dte += 0.5) {
      // greeks/index.ts analyzeTimeDecay, as it was written inline
      const oldSpeed = dte <= 1 ? 'EXTREME' : dte <= 3 ? 'FAST' : dte <= 7 ? 'MODERATE' : 'SLOW';
      expect(analyzeTimeDecay([], 0, dte).speed).toBe(oldSpeed);
      // market-scanner.ts and option-quality/index.ts
      const tier = classifyDteTier(dte);
      expect(tier === 'EXPIRY_WINDOW').toBe(dte <= 1);
      expect(tier === 'SHORT').toBe(dte > 1 && dte <= 3);
    }
  });
});

// ---------------- 6. INVALIDATION REASON (live, labelling) ----------------
describe('invalidation reason', () => {
  it('labels which existing close branch fired', () => {
    expect(invalidationReasonFromCloseReason('STOP_LOSS')).toBe('OPTION_EMERGENCY_STOP');
    expect(invalidationReasonFromCloseReason('TRAILING_STOP')).toBe('OPTION_EMERGENCY_STOP');
    expect(invalidationReasonFromCloseReason('BREAKEVEN_STOP')).toBe('OPTION_EMERGENCY_STOP');
    expect(invalidationReasonFromCloseReason('TARGET')).toBe('OPTION_TARGET_HIT');
    expect(invalidationReasonFromCloseReason('BIAS_REVERSED')).toBe('UNDERLYING_STRUCTURAL_INVALIDATION');
    expect(invalidationReasonFromCloseReason('SESSION_ENDED')).toBeNull();
    expect(invalidationReasonFromCloseReason('SETUP_INVALIDATED')).toBeNull();
    expect(invalidationReasonFromCloseReason(null)).toBeNull();
  });
});

// ---------------- 7. SHADOW-vs-LIVE REPORT ----------------
describe('shadow comparison report', () => {
  const row = (over: Partial<ShadowRow>): ShadowRow => ({
    decisionId: Math.random().toString(36),
    time: 0,
    symbol: 'SYNTH',
    dteBucket: '1-3DTE',
    liveStrike: 25000,
    liveEntry: 100,
    liveTarget: 150,
    liveNetR: 1.6,
    shadowStrike: 25000,
    shadowSelectionScore: 70,
    shadowEntry: 101,
    shadowExecutionQuality: 'NORMAL',
    shadowNetR: 1.5,
    shadowTargetV2: 140,
    shadowExpectedNetRV2: 1.2,
    eventualExitReason: null,
    premiumR: null,
    ...over,
  });

  it('renders on an empty population and states sample-size caveats', () => {
    const r = buildShadowComparison([]);
    expect(r.shadowOnly).toBe(true);
    expect(r.population.rows).toBe(0);
    expect(r.strike.overall.sample).toBe('INSUFFICIENT');
    expect(r.caveats.some((c) => /INSUFFICIENT or LOW/.test(c))).toBe(true);
  });

  it('counts strike disagreement, R delta and target divergence', () => {
    const r = buildShadowComparison([
      row({}),
      row({ shadowStrike: 24900, premiumR: 1, eventualExitReason: 'TARGET' }),
      row({ shadowExecutionQuality: 'DEGRADED', shadowEntry: 100, shadowNetR: 1.6, dteBucket: '0DTE', shadowTargetV2: 160 }),
    ]);
    expect(r.strike.overall.n).toBe(3);
    expect(r.strike.overall.differs).toBe(1);
    expect(r.strike.overall.livePremiumRWhenDiffered).toEqual({ n: 1, avg: 1 });
    expect(r.execution.overall.degraded).toBe(1);
    expect(r.execution.overall.avgNetRDelta).toBeCloseTo(-0.0667, 3);
    expect(r.target.overall.v2BelowLivePct).toBeCloseTo(66.67, 1);
    expect(r.target.overall.liveTargetHitRate.v2Below).toEqual({ n: 1, pct: 100 });
    expect(r.strike.byDte.map((g) => g.key)).toEqual(['0DTE', '1-3DTE']);
  });
});

describe('loss attribution report keeps the Phase 1 questions and adds Phase 2 panels', () => {
  it('still answers exactly 12 questions and groups by close branch and exposure', () => {
    const base: AttributionRow = {
      decisionId: 'x',
      time: 0,
      symbol: 'SYNTH',
      bias: 'BULLISH',
      regime: 'RANGE_BOUND',
      confidence: 80,
      strategy: 'BOS',
      side: 'CE',
      strikeDistanceAtr: 0.1,
      delta: 0.5,
      dte: 3,
      ivPct: 20,
      sessionBucket: '120+',
      signalAgeSeconds: 2,
      spreadPct: 1,
      exitReason: 'STOP',
      mfeAtr: 0.1,
      maeAtr: 2,
      simR: -1,
      premiumR: null,
      eventualExitReason: null,
      deadAt: null,
    };
    const report = buildAttributionReport([
      base,
      { ...base, decisionId: 'y', invalidationReason: 'OPTION_EMERGENCY_STOP', sameDirectionExposure: 1, correlatedExposure: 0 },
    ]);
    expect(report.questions).toHaveLength(12);
    expect(report.invalidation.map((g) => g.key).sort()).toEqual(['NOT_RECORDED', 'OPTION_EMERGENCY_STOP']);
    expect(report.exposure.sameDirection.map((g) => g.key).sort()).toEqual(['same-direction: 1 other', 'same-direction: NOT_RECORDED']);
  });
});
