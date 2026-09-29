// ============================================================
// PART A — F&O trade validation (flag FNO_VALIDATION)
// ============================================================
//   1. strike by |delta| band (selectStrikeByDelta)
//   2. IV cap on the target move (capExpectedMoveByHv)
//   3. round-trip cost ceiling (COST_TOO_HIGH)
//   4. stop outside the underlying's noise (STOP_INSIDE_NOISE)
//   5. 0-DTE → next-expiry fallback (buildWithFnoValidation)
// plus the flag-off contract (identical to the golden path) and the replay
// of the two 29 Sep BSE 3100 PE losses from their recorded numbers.
// ============================================================

import { describe, it, expect } from 'vitest';
import { buildTradeSetup, capExpectedMoveByHv, selectStrikeByDelta, estimateRoundTripCost, MAX_COST_PCT_OF_PREMIUM, MIN_OPTION_STOP_ATR } from '@fno/analytics';
import type { OptionChain, OptionChainLeg, OptionChainStrike, TradeSetup } from '@fno/shared';
import { GOLDEN_CASES, leg } from './trade-setup-fixtures.js';
import {
  buildWithFnoValidation,
  fnoValidationDiagnostic,
  isFnoRefusal,
  nextExpiryAfter,
  refusalSpecificity,
  type FnoChainContext,
} from '../fno-validation.js';
import { gateForRefusalCode } from '../gate-diagnostics.js';
import { classifyRefusal } from '../research-contract.js';
import { FNO_VALIDATION_DEFAULT, FNO_VALIDATION_PARAM_DEFAULTS, readFnoValidationFlag, readFnoValidationParams, liveLogicStamp, LOGIC_VERSION } from '../../config/trading-flags.js';

const FNO_ON = { fnoValidation: { enabled: true } } as const;
const PARAMS = { deltaMin: 0.35, deltaMax: 0.65, deltaTarget: 0.5 };

/** A put chain row. */
function putRow(strike: number, over: Partial<OptionChainLeg>, dist = 0): OptionChainStrike {
  return { strike, distanceFromSpot: dist, call: null, put: leg({ token: `PE${strike}`, ...over }) };
}

function chainOf(strikes: OptionChainStrike[], over: Partial<OptionChain> = {}): OptionChain {
  return {
    symbol: 'SYN',
    underlying: 'SYN',
    exchange: 'NSE',
    spotPrice: 25000,
    underlyingChange: null,
    underlyingChangePercent: null,
    expiry: '2030-01-07',
    availableExpiries: ['2030-01-07', '2030-01-14', '2030-01-28'],
    dte: 0,
    strikeInterval: 100,
    atmStrike: 25000,
    lotSize: 75,
    strikes,
    pcr: 1,
    pcrDetail: { oiPCR: 1, volumePCR: 1, changeOiPCR: 1, nearAtmPCR: 1 },
    maxPain: 25000,
    maxPainDistance: 0,
    expectedMove: { points: 100, upperBound: 25100, lowerBound: 24900 },
    ...over,
  } as unknown as OptionChain;
}

const liquid = { volume: 50_000, oi: 500_000, theta: -2 };

describe('rule 1 — strike by delta band', () => {
  it('picks the in-band strike closest to 0.50 delta, not the rounded ATM', () => {
    const strikes = [
      putRow(24900, { ...liquid, ltp: 40, bid: 39.8, ask: 40.2, delta: -0.3, moneyness: 'OTM' }, -100),
      putRow(25000, { ...liquid, ltp: 70, bid: 69.8, ask: 70.2, delta: -0.44, moneyness: 'ATM' }),
      putRow(25100, { ...liquid, ltp: 120, bid: 119.8, ask: 120.2, delta: -0.62, moneyness: 'ITM' }, 100),
    ];
    const sel = selectStrikeByDelta({ strikes, liveStrike: 24900, side: 'PE', expiry: 'x', expectedMovePoints: 80, dte: 3, expectedHoldHours: 3, ...PARAMS });
    expect(sel.strike).toBe(25000);
    expect(sel.eligible).toBe(2);
    expect(sel.candidates.find((c) => c.strike === 24900)?.rejectedReason).toMatch(/^OUT_OF_BAND/);
  });

  it('skips an in-band strike whose spread is too wide', () => {
    const strikes = [
      putRow(25000, { ...liquid, ltp: 70, bid: 66, ask: 74, delta: -0.5 }),
      putRow(25100, { ...liquid, ltp: 120, bid: 119.8, ask: 120.2, delta: -0.6, moneyness: 'ITM' }, 100),
    ];
    const sel = selectStrikeByDelta({ strikes, liveStrike: 25000, side: 'PE', expiry: 'x', expectedMovePoints: 80, dte: 3, expectedHoldHours: 3, ...PARAMS });
    expect(sel.strike).toBe(25100);
    expect(sel.candidates.find((c) => c.strike === 25000)?.rejectedReason).toBe('WIDE_SPREAD');
  });

  it('no strike in the band → null (the caller refuses OPTION_DELTA_OUT_OF_BAND)', () => {
    const strikes = [
      putRow(25000, { ...liquid, ltp: 7, bid: 6.9, ask: 7.1, delta: -0.19, moneyness: 'OTM' }),
      putRow(25100, { ...liquid, ltp: 80, bid: 79.8, ask: 80.2, delta: -0.85, moneyness: 'ITM' }, 100),
    ];
    const sel = selectStrikeByDelta({ strikes, liveStrike: 25000, side: 'PE', expiry: 'x', expectedMovePoints: 80, dte: 0, expectedHoldHours: 1, ...PARAMS });
    expect(sel.strike).toBeNull();
    expect(sel.reason).toMatch(/No PE strike/);
  });
});

describe('rule 2 — IV cap on the target move', () => {
  it('caps the IV behind the move at HV × 1.5 and scales the move linearly', () => {
    const r = capExpectedMoveByHv(84, 138.21, 26.66, 1.5);
    expect(r.capped).toBe(true);
    expect(r.ivUsedPct).toBeCloseTo(39.99, 2);
    expect(r.points).toBeCloseTo((84 * 39.99) / 138.21, 2);
  });
  it('leaves the move alone when IV is under the ceiling or an input is missing', () => {
    expect(capExpectedMoveByHv(84, 30, 26.66, 1.5)).toEqual({ points: 84, ivUsedPct: 30, capped: false });
    expect(capExpectedMoveByHv(84, 138, null, 1.5).points).toBe(84);
    expect(capExpectedMoveByHv(84, null, 27, 1.5).points).toBe(84);
  });
});

describe('rule 3 — cost ceiling', () => {
  // ₹10 premium, ₹0.4 spread, lot 75: ~6.9% round trip.
  const strikes = [putRow(25000, { ...liquid, ltp: 10, bid: 9.8, ask: 10.2, delta: -0.5 })];
  it('refuses COST_TOO_HIGH above the ceiling when the flag is on', () => {
    const cost = estimateRoundTripCost(10, 9.8, 10.2, 75);
    expect(cost.pct).toBeGreaterThan(MAX_COST_PCT_OF_PREMIUM);
    const on = buildTradeSetup(strikes, 25000, 'BEARISH', 80, 60, undefined, null, 3, 75, 10, FNO_ON);
    expect(on.available).toBe(false);
    expect(on.noTradeCode).toBe('COST_TOO_HIGH');
    expect(on.contractValidation?.tradeable).toBe(false);
    expect(on.fnoValidation?.refusalCode).toBe('COST_TOO_HIGH');
  });
  it('the same contract is not refused for cost with the flag off', () => {
    const off = buildTradeSetup(strikes, 25000, 'BEARISH', 80, 60, undefined, null, 3, 75, 10, {});
    expect(off.noTradeCode).not.toBe('COST_TOO_HIGH');
    expect(off.fnoValidation).toBeUndefined();
  });
});

describe('rule 4 — stop outside the noise', () => {
  const strikes = [putRow(25000, { ...liquid, ltp: 100, bid: 99.9, ask: 100.1, delta: -0.5 })];
  it('refuses STOP_INSIDE_NOISE when the noise floor sits beyond the 45% cap', () => {
    // 1 ATR = 100 pts → 50 premium at delta 0.5, above 45% of 100.
    const r = buildTradeSetup(strikes, 25000, 'BEARISH', 80, 300, undefined, null, 3, 75, 100, { ...FNO_ON, flags: { structuralStop: true } });
    expect(r.noTradeCode).toBe('STOP_INSIDE_NOISE');
    expect(r.fnoValidation?.stopUnderlyingAtr).toBeLessThan(MIN_OPTION_STOP_ATR);
  });
  it('widens the stop to the noise floor when the cap allows, and says so', () => {
    // 1 ATR = 70 pts → 35 premium; the 30% base stop (30) sits inside it.
    const r = buildTradeSetup(strikes, 25000, 'BEARISH', 80, 300, undefined, null, 3, 75, 70, { ...FNO_ON, flags: { structuralStop: true } });
    expect(r.available).toBe(true);
    expect(r.fnoValidation?.stopWidenedForNoise).toBe(true);
    expect(r.entry! - r.stopLoss!).toBeCloseTo(35, 1);
    expect(r.stopInAtr).toBeGreaterThanOrEqual(MIN_OPTION_STOP_ATR - 0.01);
    expect(r.reason).toMatch(/outside noise/);
  });
  it('the R:R-sized stop (structural flag off) is never widened past what R:R affords', () => {
    const r = buildTradeSetup(strikes, 25000, 'BEARISH', 80, 110, undefined, null, 3, 75, 90, FNO_ON);
    expect(['STOP_INSIDE_NOISE', 'REWARD_RISK_TOO_LOW']).toContain(r.noTradeCode);
  });
  it('names the real moneyness instead of "ATM" when the flag is on', () => {
    const itm = [putRow(25100, { ...liquid, ltp: 100, bid: 99.9, ask: 100.1, delta: -0.6, moneyness: 'ITM' })];
    const r = buildTradeSetup(itm, 25100, 'BEARISH', 80, 300, undefined, null, 3, 75, 30, { ...FNO_ON, flags: { structuralStop: true } });
    expect(r.available).toBe(true);
    expect(r.reason).toMatch(/ITM PE 25100/);
    expect(r.reason).not.toMatch(/ATM PE/);
  });
});

describe('flag off is the old builder, byte for byte', () => {
  it('fnoValidation {enabled:false} gives exactly the golden outputs for every golden case', () => {
    for (const [, args] of Object.entries(GOLDEN_CASES)) {
      const a = args();
      const base = buildTradeSetup(...a);
      const withOff = a.slice() as typeof a;
      withOff[10] = { ...(a[10] ?? {}), fnoValidation: { enabled: false } };
      expect(buildTradeSetup(...withOff)).toEqual(base);
    }
  });
  it('the orchestrator with the flag off builds once on chain.atmStrike and records nothing', async () => {
    const calls: number[] = [];
    const chain = chainOf([putRow(25000, { ...liquid, ltp: 7, bid: 6.9, ask: 7.1, delta: -0.19 })]);
    const out = await buildWithFnoValidation({
      enabled: false,
      primary: chain,
      side: 'PE',
      params: PARAMS,
      contextFor: () => ctx(80),
      build: (_c, strike) => { calls.push(strike); return { available: false, reason: 'x' }; },
      fetchNextExpiry: async () => { throw new Error('must not be called'); },
    });
    expect(calls).toEqual([25000]);
    expect(out.fnoValidation).toBeNull();
    expect(out.chain).toBe(chain);
  });
});

function ctx(move: number): FnoChainContext {
  return { expectedMovePoints: move, expectedHoldHours: 2, ivRank: null, hvPct: null, ivCap: null };
}

const realBuild = (c: OptionChain, strike: number, context: FnoChainContext): TradeSetup =>
  buildTradeSetup(c.strikes, strike, 'BEARISH', 80, context.expectedMovePoints, undefined, null, c.dte, c.lotSize, 20, { ...FNO_ON, flags: { structuralStop: true } });

describe('rule 5 — 0-DTE expiry fallback', () => {
  const badPrimary = chainOf([
    putRow(25000, { ...liquid, ltp: 7, bid: 6.9, ask: 7.1, delta: -0.19, moneyness: 'OTM' }),
    putRow(25100, { ...liquid, ltp: 90, bid: 89.9, ask: 90.1, delta: -0.88, moneyness: 'ITM' }, 100),
  ]);
  const goodNext = chainOf([putRow(25000, { ...liquid, ltp: 100, bid: 99.9, ask: 100.1, delta: -0.48 })], { expiry: '2030-01-14', dte: 7 });

  it('0 DTE fails → the next expiry passes and is traded, expiryFallback recorded', async () => {
    const asked: string[] = [];
    const out = await buildWithFnoValidation({
      enabled: true, primary: badPrimary, side: 'PE', params: PARAMS, contextFor: () => ctx(250), build: realBuild,
      fetchNextExpiry: async (e) => { asked.push(e); return goodNext; },
    });
    expect(asked).toEqual(['2030-01-14']);
    expect(out.setup.available).toBe(true);
    expect(out.chain).toBe(goodNext);
    expect(out.fnoValidation).toMatchObject({ expiryFallback: true, primaryExpiry: '2030-01-07', primaryRefusalCode: 'OPTION_DELTA_OUT_OF_BAND', finalExpiry: '2030-01-14', refusalCode: null });
    expect(out.setup.reason).toMatch(/^Expiry fallback/);
  });

  it('both fail → refused with the more specific reason, both named', async () => {
    const costlyNext = chainOf([putRow(25000, { ...liquid, ltp: 10, bid: 9.8, ask: 10.2, delta: -0.5 })], { expiry: '2030-01-14', dte: 7 });
    const out = await buildWithFnoValidation({
      enabled: true, primary: badPrimary, side: 'PE', params: PARAMS, contextFor: () => ctx(250), build: realBuild,
      fetchNextExpiry: async () => costlyNext,
    });
    expect(out.setup.available).toBe(false);
    expect(out.setup.noTradeCode).toBe('COST_TOO_HIGH'); // more specific than OPTION_DELTA_OUT_OF_BAND
    expect(out.setup.reason).toMatch(/Both expiries fail/);
    expect(out.fnoValidation?.expiryFallback).toBe(true);
  });

  it('a contract with DTE > 0 never falls back', async () => {
    const out = await buildWithFnoValidation({
      enabled: true, primary: { ...badPrimary, dte: 2 } as OptionChain, side: 'PE', params: PARAMS, contextFor: () => ctx(250), build: realBuild,
      fetchNextExpiry: async () => { throw new Error('must not be called'); },
    });
    expect(out.setup.noTradeCode).toBe('OPTION_DELTA_OUT_OF_BAND');
    expect(out.fnoValidation?.expiryFallback).toBe(false);
  });

  it('a failed next-expiry fetch is reported through onError and refuses on the primary reason', async () => {
    const errors: string[] = [];
    const out = await buildWithFnoValidation({
      enabled: true, primary: badPrimary, side: 'PE', params: PARAMS, contextFor: () => ctx(250), build: realBuild,
      fetchNextExpiry: async () => { throw new Error('broker 403'); },
      onError: (stage, err: any) => errors.push(`${stage}:${err.message}`),
    });
    expect(errors).toEqual(['FETCH_NEXT_EXPIRY:broker 403']);
    expect(out.setup.noTradeCode).toBe('OPTION_DELTA_OUT_OF_BAND');
    expect(out.setup.reason).toMatch(/could not be priced/);
  });

  it('helpers: next expiry, specificity, code families', () => {
    expect(nextExpiryAfter({ expiry: '2030-01-07', availableExpiries: ['2030-01-28', '2030-01-07', '2030-01-14'] })).toBe('2030-01-14');
    expect(nextExpiryAfter({ expiry: '2030-01-28', availableExpiries: ['2030-01-28'] })).toBeNull();
    expect(refusalSpecificity('STOP_INSIDE_NOISE')).toBeGreaterThan(refusalSpecificity('COST_TOO_HIGH'));
    expect(refusalSpecificity('REWARD_RISK_TOO_LOW')).toBeGreaterThan(refusalSpecificity('STOP_INSIDE_NOISE'));
    expect(isFnoRefusal('COST_TOO_HIGH')).toBe(true);
    expect(isFnoRefusal('REWARD_RISK_TOO_LOW')).toBe(false);
    for (const c of ['OPTION_DELTA_OUT_OF_BAND', 'COST_TOO_HIGH', 'STOP_INSIDE_NOISE']) {
      expect(gateForRefusalCode(c)).toBe('FNO_VALIDATION');
      expect(classifyRefusal(c)).toBe('REFUSED');
    }
  });
});

describe('FNO_VALIDATION diagnostic row and flags', () => {
  it('FAIL deciding on a refusal, PASS on a pass, NOT_EVALUATED without a record', () => {
    const fail = fnoValidationDiagnostic({ enabled: true, record: { refusalCode: 'COST_TOO_HIGH', expiryFallback: false } as any, params: {}, at: 1 });
    expect(fail).toMatchObject({ gate: 'FNO_VALIDATION', status: 'FAIL', was_deciding_gate: true });
    expect(fnoValidationDiagnostic({ enabled: true, record: { refusalCode: null } as any, params: {}, at: 1 }).status).toBe('PASS');
    expect(fnoValidationDiagnostic({ enabled: true, record: null, params: {}, at: 1 }).status).toBe('NOT_EVALUATED');
  });
  it('defaults ON, env-configurable, untested-default params, stamped without changing the version', () => {
    expect(FNO_VALIDATION_DEFAULT).toBe(true);
    expect(readFnoValidationFlag({})).toBe(true);
    expect(readFnoValidationFlag({ FNO_VALIDATION: 'off' })).toBe(false);
    expect(readFnoValidationParams({})).toEqual(FNO_VALIDATION_PARAM_DEFAULTS);
    expect(readFnoValidationParams({ MAX_COST_PCT_OF_PREMIUM: '4', OPTION_DELTA_BAND_MIN: 'x' })).toMatchObject({ MAX_COST_PCT_OF_PREMIUM: 4, OPTION_DELTA_BAND_MIN: 0.35 });
    expect(FNO_VALIDATION_PARAM_DEFAULTS).toEqual({ OPTION_DELTA_BAND_MIN: 0.35, OPTION_DELTA_BAND_MAX: 0.65, OPTION_DELTA_TARGET: 0.5, IV_TARGET_CAP_MULT: 1.5, MAX_COST_PCT_OF_PREMIUM: 5, MIN_OPTION_STOP_ATR: 1 });
    expect(liveLogicStamp().fnoValidation?.enabled).toBe(true);
    expect(LOGIC_VERSION).toBe('2026-09-29.coverage-lag.1');
  });
});

// ------------------------------------------------------------
// Replay: the two 29 Sep BSE 3100 PE losses, from the recorded setups
// (GET /api/backtesting/trade-setups): 0 DTE, lot 200, delta -0.19, entry
// 7.18 / 7.23, cost 9.36% / 9.31%, ATM IV 138.21 / 97.72 vs HV 26.66 /
// 26.83, ATR 18.38 / 21.86, spot 3139.3 / 3141.2, the target move capped at
// the 84.23 / 86.13-pt room. The bid/ask are reconstructed so the cost model
// reproduces the recorded cost (a ₹0.35 spread at lot 200). The 3200 PE
// (61 pts ITM at 0 DTE) was not recorded; its delta is ASSUMED -0.85.
// ------------------------------------------------------------
describe('replay — 29 Sep BSE 3100 PE losses', () => {
  const trades = [
    { entry: 7.18, iv: 138.21, hv: 26.66, atr: 18.38, spot: 3139.3, room: 84.23, recordedCost: 9.36, behind: 3142.4997 },
    { entry: 7.23, iv: 97.72, hv: 26.83, atr: 21.86, spot: 3141.2, room: 86.13, recordedCost: 9.31, behind: 3142.8954 },
  ];
  const bseLeg = (t: (typeof trades)[number]): Partial<OptionChainLeg> => ({
    ltp: t.entry, bid: round2(t.entry - 0.175), ask: round2(t.entry + 0.175), delta: -0.19, iv: t.iv, theta: -6, volume: 4_000_000, oi: 540_000, moneyness: 'OTM',
  });
  const opts = (t: (typeof trades)[number], fno: boolean) => ({
    ivRank: null, hvPct: t.hv, tickSize: 0.05, expectedHoldHours: 1.1,
    flags: { structuralStop: true, richIvRr: true }, spot: t.spot, nearestBehindLevel: t.behind, structuralStopBufferAtr: 0.25, ivVsHv: 'RICH', richIvMinRiskReward: 2,
    ...(fno ? FNO_ON : {}),
  });

  for (const [i, t] of trades.entries()) {
    it(`trade ${i + 1}: the old engine took it; Part A refuses it on every rule it can see`, async () => {
      const strikes = [putRow(3100, bseLeg(t), -39), putRow(3200, { ...liquid, ltp: 62, bid: 61.5, ask: 62.5, delta: -0.85, moneyness: 'ITM' }, 61)];
      // The reconstructed quote reproduces the recorded round-trip cost.
      expect(estimateRoundTripCost(t.entry, t.entry - 0.175, t.entry + 0.175, 200).pct).toBeCloseTo(t.recordedCost, 0);

      // Before: exactly what shipped (flag off) — available at a projected R:R of ~5.
      const before = buildTradeSetup(strikes, 3100, 'BEARISH', 85, t.room, undefined, 15, 0, 200, t.atr, opts(t, false));
      expect(before.available).toBe(true);
      expect(before.riskReward!).toBeGreaterThan(4);

      // Rule 1: no PE strike in the 0.35-0.65 band on the 0-DTE chain.
      const sel = selectStrikeByDelta({ strikes, liveStrike: 3100, side: 'PE', expiry: '2026-09-29', expectedMovePoints: t.room, dte: 0, expectedHoldHours: 1.1, ...PARAMS });
      expect(sel.strike).toBeNull();

      // Rule 2: the IV cap shrinks the target's IV to HV × 1.5.
      const cap = capExpectedMoveByHv(t.room, t.iv, t.hv, 1.5);
      expect(cap.capped).toBe(true);
      expect(cap.points).toBeLessThan(t.room * 0.45);

      // Rules 3 and 4 on the 3100 PE itself (if it had been forced).
      const forced = buildTradeSetup(strikes, 3100, 'BEARISH', 85, cap.points, undefined, 15, 0, 200, t.atr, opts(t, true));
      expect(forced.noTradeCode).toBe('COST_TOO_HIGH');
      const noisePremium = MIN_OPTION_STOP_ATR * t.atr * 0.19;
      expect(noisePremium / t.entry).toBeGreaterThan(0.45); // the stop could not reach 1 ATR inside the 45% cap either
    });
  }

  it('with the fallback: the Oct 27 contract on a representative quote still fails reward:risk once the target IV is capped', async () => {
    // ASSUMED Oct 27 3100 PE at the time of the trade: ₹110 mid, 1% spread, delta -0.40, ATM IV 30%.
    // IV 30 < HV 26.66 × 1.5, so the cap does not bind; a one-day 30%-IV move with 65 of 375 minutes left is ~20 pts.
    const t = trades[0];
    const zeroDte = chainOf([putRow(3100, bseLeg(t), -39), putRow(3200, { ...liquid, ltp: 62, bid: 61.5, ask: 62.5, delta: -0.85, moneyness: 'ITM' }, 61)], {
      expiry: '2026-09-29', availableExpiries: ['2026-09-29', '2026-10-27', '2026-11-23'], dte: 0, lotSize: 200, atmStrike: 3100, spotPrice: t.spot,
    });
    const oct = chainOf([putRow(3100, { ...liquid, ltp: 110, bid: 109.45, ask: 110.55, delta: -0.4, iv: 30, theta: -2.5, moneyness: 'OTM' }, -39)], {
      expiry: '2026-10-27', dte: 28, lotSize: 200, atmStrike: 3100, spotPrice: t.spot,
    });
    const oneDay = t.spot * 0.3 * Math.sqrt(1 / 365) * Math.sqrt(65 / 375);
    const out = await buildWithFnoValidation({
      enabled: true, primary: zeroDte, side: 'PE', params: PARAMS,
      contextFor: (c) => ctx(c === zeroDte ? capExpectedMoveByHv(t.room, t.iv, t.hv, 1.5).points : Math.min(oneDay, t.room)),
      build: (c, strike, context) => buildTradeSetup(c.strikes, strike, 'BEARISH', 85, context.expectedMovePoints, undefined, 15, c.dte, c.lotSize, t.atr, opts(t, true)),
      fetchNextExpiry: async () => oct,
    });
    expect(out.setup.available).toBe(false);
    expect(out.fnoValidation?.expiryFallback).toBe(true);
    expect(out.fnoValidation?.primaryRefusalCode).toBe('OPTION_DELTA_OUT_OF_BAND');
    expect(out.setup.noTradeCode).toBe('REWARD_RISK_TOO_LOW');
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
