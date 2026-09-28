// ============================================================
// PHASE 3 — contract validation persistence, opening-hour detail,
// cooldown effectiveness, OI-wall freshness
// ============================================================
// Every chain/setup number in this file is a FABRICATED fixture, not market
// data. These tests check the Phase 3 guarantees:
//   - contractValidation on TradeSetup mirrors assessOptionQuality's own
//     tradeable/refusalReason exactly, on both a refusal and a taken trade,
//     and agrees with Phase 2's shadow strike-selection reading of the same
//     live candidate — no second validation logic;
//   - the opening-hour classifier is pure and covered in its own file
//     (opening-classifier.test.ts);
//   - minutesSinceLastLossFromTtls recovers elapsed minutes from Redis TTLs
//     honestly, returning null rather than guessing where it can't;
//   - the OI-wall freshness diagnostic is PASS/STALE/NOT_EVALUATED, never a
//     refusal, and is not one of LIVE_CHAIN_GATES.
// ============================================================

import { describe, it, expect } from 'vitest';
import { buildTradeSetup, scoreStrikeCandidates, assessOptionQuality } from '@fno/analytics';
import type { OptionChainLeg, OptionChainStrike } from '@fno/shared';
import {
  minutesSinceLastLossFromTtls,
  oiWallFreshnessDiagnostic,
  LIVE_CHAIN_GATES,
  OI_WALL_FRESHNESS_STALE_SECONDS,
} from '../gate-diagnostics.js';
import { buildOpeningHourReport, buildCooldownEffectivenessReport, type AttributionRow } from '../loss-attribution-model.js';

// ---------------- FABRICATED FIXTURE (mirrors phase2-shadow.test.ts) ----------------
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

const ATM = 25000;
const LOT = 75;
const MOVE = 100;
const HOLD_H = 5;

function strikesWith(atmCall: Partial<OptionChainLeg>): OptionChainStrike[] {
  return [
    {
      strike: ATM,
      distanceFromSpot: 0,
      call: leg({ token: 'CE25000', ...atmCall }),
      put: leg({ token: 'PE25000', delta: -0.5 }),
    },
    {
      strike: 25100,
      distanceFromSpot: 100,
      call: leg({ token: 'CE25100', ltp: 60, bid: 59, ask: 61, volume: 20000, oi: 200000, delta: 0.4, moneyness: 'OTM' }),
      put: leg({ token: 'PE25100', delta: -0.6, moneyness: 'ITM' }),
    },
  ];
}

// ---------------- 1. CONTRACT VALIDATION PERSISTENCE (spec §5) ----------------
describe('contractValidation on TradeSetup — persists assessOptionQuality exactly, no new logic', () => {
  it('on a mechanical refusal (thin contract), contractValidation.tradeable is false and refusalReason is assessOptionQuality\'s own', () => {
    // Below MIN_LEG_VOLUME (100) and MIN_LEG_OI (500) — the "nobody is
    // trading this contract" mechanical floor.
    const strikes = strikesWith({ ltp: 100, bid: 99, ask: 101, volume: 10, oi: 50, delta: 0.5, theta: -5 });
    const setup = buildTradeSetup(strikes, ATM, 'BULLISH', 80, MOVE, undefined, null, 3, LOT, null, { tickSize: 0.05, expectedHoldHours: HOLD_H });

    expect(setup.available).toBe(false);
    expect(setup.noTradeCode).toBe('LOW_OPTION_LIQUIDITY');
    expect(setup.contractValidation).not.toBeNull();
    expect(setup.contractValidation!.tradeable).toBe(false);
    expect(setup.contractValidation!.refusalReason).toMatch(/Nobody is trading this contract/);

    // Cross-check against assessOptionQuality run directly on the same leg —
    // contractValidation is not a re-implementation, it's the same call.
    const reference = assessOptionQuality({
      entryPremium: 100,
      bid: 99,
      ask: 101,
      volume: 10,
      openInterest: 50,
      delta: 0.5,
      theta: -5,
      iv: 0.15,
      ivRank: null,
      hvPct: null,
      dte: 3,
      distanceFromSpot: 0,
      expectedMovePoints: MOVE,
      expectedHoldHours: HOLD_H,
      tickSize: 0.05,
      moneyness: 'ATM',
      greeksSource: 'BROKER',
    });
    expect(setup.contractValidation!.refusalReason).toBe(reference.refusalReason);

    // Phase 2's shadow strike-selection, tagging the SAME live candidate
    // (isLive), agrees it's untradeable — reused, not recomputed twice.
    const shadow = scoreStrikeCandidates({
      strikes,
      liveStrike: ATM,
      side: 'CE',
      expiry: '2026-10-01',
      expectedMovePoints: MOVE,
      dte: 3,
      expectedHoldHours: HOLD_H,
    });
    const liveCandidate = shadow.rejectedAlternatives.find((c) => c.isLive);
    expect(liveCandidate).toBeDefined();
    expect(liveCandidate!.rejectedReason).toMatch(/^UNTRADEABLE:/);
    expect(liveCandidate!.rejectedReason).toContain(reference.refusalReason);
  });

  it('on a taken trade, contractValidation.tradeable is true, refusalReason is null, and checks carries the components', () => {
    const strikes = strikesWith({ ltp: 100, bid: 99, ask: 101, volume: 5000, oi: 50000, delta: 0.5, theta: -5 });
    const setup = buildTradeSetup(strikes, ATM, 'BULLISH', 80, MOVE, undefined, null, 3, LOT, null, { tickSize: 0.05, expectedHoldHours: HOLD_H });

    expect(setup.available).toBe(true);
    expect(setup.contractValidation).not.toBeNull();
    expect(setup.contractValidation!.tradeable).toBe(true);
    expect(setup.contractValidation!.refusalReason).toBeNull();
    // The same assessOptionQuality().components this setup's own optionQuality
    // summary is built from (which trims each entry to name/score/detail) —
    // contractValidation.checks carries the fuller component objects (weight
    // included) rather than a re-derivation.
    const checks = setup.contractValidation!.checks as Array<{ name: string; score: number; detail: string }>;
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBe(setup.optionQuality!.components.length);
    expect(checks.map((c) => c.name)).toEqual(setup.optionQuality!.components.map((c) => c.name));
    expect(checks.map((c) => c.score)).toEqual(setup.optionQuality!.components.map((c) => c.score));
  });

  it('is absent (not a false claim of tradeable) on a refusal that never reaches option-quality assessment', () => {
    const setup = buildTradeSetup(strikesWith({}), ATM, 'NEUTRAL', 80, MOVE, undefined, null, 3, LOT, null, { tickSize: 0.05, expectedHoldHours: HOLD_H });
    expect(setup.available).toBe(false);
    expect(setup.noTradeCode).toBe('NEUTRAL_BIAS');
    expect(setup.contractValidation).toBeUndefined();
  });
});

// ---------------- 2. COOLDOWN EFFECTIVENESS — minutes since last loss (spec §16) ----------------
describe('minutesSinceLastLossFromTtls — pure, honest about what it cannot recover', () => {
  const POST_LOSS_SETTLE_MINUTES = 15;
  const SL_COOLDOWN_SECONDS = 60 * 60; // 1 hour, INTRADAY

  it('recovers 0-15 minutes from the any-symbol settle key while it is alive', () => {
    // 15-minute TTL, 600s (10 min) remaining => 5 minutes elapsed.
    expect(minutesSinceLastLossFromTtls(600, -2, 'INTRADAY', POST_LOSS_SETTLE_MINUTES, SL_COOLDOWN_SECONDS)).toBe(5);
    // Just set: full TTL remaining => ~0 minutes elapsed.
    expect(minutesSinceLastLossFromTtls(POST_LOSS_SETTLE_MINUTES * 60, -2, 'INTRADAY', POST_LOSS_SETTLE_MINUTES, SL_COOLDOWN_SECONDS)).toBe(0);
  });

  it('recovers 15-60 minutes from the same-symbol+direction cooldown key once the settle key has expired, INTRADAY only', () => {
    // Settle key gone (<=0). Cooldown key: 1h TTL, 1500s (25 min) remaining => 35 minutes elapsed.
    expect(minutesSinceLastLossFromTtls(-1, 1500, 'INTRADAY', POST_LOSS_SETTLE_MINUTES, SL_COOLDOWN_SECONDS)).toBe(35);
  });

  it('returns null for POSITIONAL past the settle window rather than a misleading 24h-scale number', () => {
    expect(minutesSinceLastLossFromTtls(-1, 1500, 'POSITIONAL', POST_LOSS_SETTLE_MINUTES, SL_COOLDOWN_SECONDS)).toBeNull();
  });

  it('returns null when neither TTL is alive — no recent loss, or one this design cannot see (different symbol, 15-60min ago)', () => {
    expect(minutesSinceLastLossFromTtls(-1, -1, 'INTRADAY', POST_LOSS_SETTLE_MINUTES, SL_COOLDOWN_SECONDS)).toBeNull();
    expect(minutesSinceLastLossFromTtls(0, 0, 'INTRADAY', POST_LOSS_SETTLE_MINUTES, SL_COOLDOWN_SECONDS)).toBeNull();
  });

  it('never returns a negative number even if a TTL edge case overshoots', () => {
    expect(minutesSinceLastLossFromTtls(POST_LOSS_SETTLE_MINUTES * 60 + 30, -2, 'INTRADAY', POST_LOSS_SETTLE_MINUTES, SL_COOLDOWN_SECONDS)).toBe(0);
  });
});

// ---------------- 3. OI-WALL FRESHNESS DIAGNOSTIC (spec §20) ----------------
describe('OI_WALL_FRESHNESS diagnostic — logged, never a refusal gate', () => {
  it('is not part of the live refusal chain', () => {
    expect(LIVE_CHAIN_GATES).not.toContain('OI_WALL_FRESHNESS');
  });

  it('PASSes on fresh OI data (age inside the threshold)', () => {
    const d = oiWallFreshnessDiagnostic(5, 1_000, OI_WALL_FRESHNESS_STALE_SECONDS);
    expect(d.gate).toBe('OI_WALL_FRESHNESS');
    expect(d.status).toBe('PASS');
    expect(d.was_deciding_gate).toBe(false);
    expect(d.timestamp).toBe(1_000);
  });

  it('is STALE on old OI data (age beyond the threshold), and still does not decide anything', () => {
    const d = oiWallFreshnessDiagnostic(OI_WALL_FRESHNESS_STALE_SECONDS + 1, 1_000, OI_WALL_FRESHNESS_STALE_SECONDS);
    expect(d.status).toBe('STALE');
    expect(d.was_deciding_gate).toBe(false);
    expect(d.reason).toMatch(/beyond the/);
  });

  it('is NOT_EVALUATED rather than guessing PASS when no OI age was available', () => {
    const d = oiWallFreshnessDiagnostic(null, 1_000);
    expect(d.status).toBe('NOT_EVALUATED');
    expect(d.input_values).toEqual({ oiAgeSeconds: null });
  });

  it('respects a custom threshold rather than holding a second copy of the default', () => {
    expect(oiWallFreshnessDiagnostic(50, 1, 40).status).toBe('STALE');
    expect(oiWallFreshnessDiagnostic(50, 1, 60).status).toBe('PASS');
  });
});

// ---------------- 4. REPORTS — reuse groupBy/buckets/sample-size machinery ----------------
describe('opening-hour and cooldown-effectiveness reports (spec §15/§16) — reuse existing report plumbing', () => {
  const row = (over: Partial<AttributionRow>): AttributionRow => ({
    decisionId: Math.random().toString(36),
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
    ...over,
  });

  it('opening-hour report buckets by 15-minute sub-window and by environment, excluding rows outside the window', () => {
    const rows = [
      row({ minutesFromSessionOpen: 5, openingEnvironment: 'OPENING_BREAKOUT', simR: 1 }),
      row({ minutesFromSessionOpen: 40, openingEnvironment: 'OPENING_RANGE', simR: -0.5 }),
      row({ minutesFromSessionOpen: 90, openingEnvironment: null, simR: 2 }), // outside the opening window — excluded
      row({ minutesFromSessionOpen: null, openingEnvironment: null, simR: 3 }), // no reading at all — excluded
    ];
    const report = buildOpeningHourReport(rows);
    expect(report.overall.n).toBe(2);
    expect(report.byWindow.map((g) => g.key).sort()).toEqual(['0-15m', '30-45m']);
    expect(report.byEnvironment.map((g) => g.key).sort()).toEqual(['OPENING_BREAKOUT', 'OPENING_RANGE']);
  });

  it('opening-hour report labels pre-Phase-3 rows UNLABELLED rather than dropping them', () => {
    const report = buildOpeningHourReport([row({ minutesFromSessionOpen: 10, openingEnvironment: null })]);
    expect(report.overall.n).toBe(1);
    expect(report.byEnvironment[0].key).toMatch(/UNLABELLED/);
  });

  it('cooldown-effectiveness report buckets within-15min vs the 15-60min same-symbol-side case and excludes unrecoverable rows', () => {
    const rows = [
      row({ minutesSinceLastLoss: 5, simR: -0.3 }),
      row({ minutesSinceLastLoss: 40, simR: 0.8 }),
      row({ minutesSinceLastLoss: null, simR: 1 }), // not recoverable — excluded from `overall`
    ];
    const report = buildCooldownEffectivenessReport(rows);
    expect(report.overall.n).toBe(2);
    const keys = report.byBucket.map((g) => g.key);
    expect(keys).toContain('within-15min (any symbol just lost)');
    expect(keys).toContain('same-symbol-same-side-within-hour (15-60min)');
  });

  it('cooldown-effectiveness report states the different-symbol-within-hour limitation rather than fabricating that bucket', () => {
    const report = buildCooldownEffectivenessReport([row({ minutesSinceLastLoss: 5 })]);
    expect(report.note).toMatch(/cannot be distinguished from no loss at all/);
  });
});
