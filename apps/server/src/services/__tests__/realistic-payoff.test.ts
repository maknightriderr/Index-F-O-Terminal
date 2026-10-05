// ============================================================
// OPTION & RISK — realistic payoff (OPTION-2.0): the target premium is what
// the expected move actually pays the contract (delta + gamma − theta over
// the hold), R:R is after costs, and a cheap OTM contract is not chosen for
// its theoretical percentage return.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { buildTradeSetup, realisticPayoff } from '@fno/analytics';
import type { OptionChain, OptionChainLeg, OptionChainStrike } from '@fno/shared';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leg } from './trade-setup-fixtures.js';

vi.mock('../../lib/redis.js', () => ({ redis: {} }));
vi.mock('../../lib/db.js', () => ({ sql: () => undefined }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { validateOnChain, strikeNetRR } = await import('../fno-validation.js');
const { triggerSlPremiumPct } = await import('../momentum-break-live.js');

describe('realisticPayoff', () => {
  it('delta gain + gamma convexity − theta over the hold on trading time', () => {
    const p = realisticPayoff({ delta: 0.5, gamma: 0.002, theta: -40, movePoints: 100, holdHours: 3.125, sessionHours: 6.25 });
    expect(p).toEqual({ deltaGain: 50, gammaGain: 10, thetaDecay: 20, netGain: 40, holdHours: 3.13, sessionHours: 6.25 });
  });
  it('gamma never adds more than delta could still gain (delta ≤ 1)', () => {
    expect(realisticPayoff({ delta: 0.9, gamma: 0.05, theta: 0, movePoints: 100, holdHours: 1, sessionHours: 6.25 }).gammaGain).toBe(10);
  });
  it('a longer session spends a day\'s theta more slowly (MCX vs NSE)', () => {
    const nse = realisticPayoff({ delta: 0.5, gamma: 0, theta: -30, movePoints: 50, holdHours: 3, sessionHours: 6.25 });
    const mcx = realisticPayoff({ delta: 0.5, gamma: 0, theta: -30, movePoints: 50, holdHours: 3, sessionHours: 14.5 });
    expect(mcx.thetaDecay).toBeLessThan(nse.thetaDecay);
  });
  it('missing Greeks contribute nothing (never invented)', () => {
    expect(realisticPayoff({ delta: 0.5, gamma: null, theta: undefined, movePoints: 10, holdHours: 2, sessionHours: 6.25 })).toMatchObject({ gammaGain: 0, thetaDecay: 0, netGain: 5 });
  });
});

const liquid = { volume: 50_000, oi: 500_000 };
function ceRow(strike: number, over: Partial<OptionChainLeg>, dist: number): OptionChainStrike {
  return { strike, distanceFromSpot: dist, put: null, call: leg({ token: `CE${strike}`, ...liquid, ...over }) };
}
const chainOf = (strikes: OptionChainStrike[]): OptionChain =>
  ({ symbol: 'SYN', underlying: 'SYN', exchange: 'NSE', spotPrice: 25000, expiry: '2030-01-07', availableExpiries: ['2030-01-07'], dte: 1, strikeInterval: 100, atmStrike: 25000, lotSize: 75, strikes, pcrDetail: { oiPCR: 1, volumePCR: 1, changeOiPCR: 1, nearAtmPCR: 1 }, expectedMove: { points: 100, upperBound: 0, lowerBound: 0 } }) as unknown as OptionChain;

// The structure path's own sizing: premium stop = |Δ| × the underlying stop distance (with the floor).
const MOVE = 120;
const STOP = 40;
const build = (realistic: boolean) => (c: OptionChain, strike: number) =>
  buildTradeSetup(c.strikes, strike, 'BULLISH', 100, MOVE, triggerSlPremiumPct(c.strikes, strike, 'BULLISH', STOP)?.slPremiumPct, null, c.dte, c.lotSize, 60, {
    tickSize: 0.05,
    expectedHoldHours: 3,
    rrGate: false,
    ...(realistic ? { realisticPayoff: { sessionHours: 6.25 } } : {}),
  });

describe('builder: target is the realistic payoff, R:R after costs', () => {
  const atm = ceRow(25000, { ltp: 120, bid: 119.9, ask: 120.1, delta: 0.5, gamma: 0.0012, theta: -40, moneyness: 'ATM' }, 0);
  it('target = entry + delta + gamma − theta; the breakdown is on the setup', () => {
    const s = build(true)(chainOf([atm]), 25000);
    expect(s.available).toBe(true);
    const p = realisticPayoff({ delta: 0.5, gamma: 0.0012, theta: -40, movePoints: MOVE, holdHours: 3, sessionHours: 6.25 });
    expect(s.target).toBeCloseTo(120 + p.netGain, 2);
    expect(s.projectedPayoff).toEqual(p);
    // Delta-only (research / golden) is unchanged: entry + |Δ| × move.
    expect(build(false)(chainOf([atm]), 25000).target).toBeCloseTo(120 + 0.5 * MOVE, 2);
    // Net R:R after costs is lower than the gross ratio.
    expect(strikeNetRR(s)!).toBeLessThan(s.riskReward!);
  });
  it('decay that eats the move → no realistic target (refused, never a fantasy target)', () => {
    const decaying = ceRow(25000, { ltp: 60, bid: 59.9, ask: 60.1, delta: 0.4, gamma: 0, theta: -200, moneyness: 'ATM' }, 0);
    const s = build(true)(chainOf([decaying]), 25000);
    expect(s).toMatchObject({ available: false, noTradeCode: 'UNREALISTIC_TARGET' });
    expect(s.projectedPayoff!.netGain).toBeLessThanOrEqual(0);
  });
});

describe('no cheap OTM chosen for its theoretical percentage return', () => {
  // ATM vs a cheap in-band OTM (heavy decay relative to its premium) and a far-OTM lottery ticket.
  const atm = ceRow(25000, { ltp: 120, bid: 119.9, ask: 120.1, delta: 0.5, gamma: 0.0012, theta: -40, moneyness: 'ATM' }, 0);
  const otm = ceRow(25100, { ltp: 30, bid: 29.9, ask: 30.1, delta: 0.36, gamma: 0.0011, theta: -45, moneyness: 'OTM' }, 100);
  const far = ceRow(25400, { ltp: 6, bid: 5.95, ask: 6.05, delta: 0.12, gamma: 0.0005, theta: -12, moneyness: 'OTM' }, 400);
  const chain = chainOf([atm, otm, far]);
  const params = { deltaMin: 0.35, deltaMax: 0.65, deltaTarget: 0.5 };
  // The trade's invalidation is STOP points away on the underlying (as the structure path passes it).
  const context = { expectedMovePoints: MOVE, expectedHoldHours: 3, ivRank: null, hvPct: null, ivCap: null, underlyingStopPoints: STOP };

  it('the OTM legs promise far more on a delta-only % basis', () => {
    const pct = (l: OptionChainLeg) => (Math.abs(l.delta) * MOVE) / l.ltp;
    expect(pct(otm.call!)).toBeGreaterThan(pct(atm.call!));
    expect(pct(far.call!)).toBeGreaterThan(pct(atm.call!));
  });

  it('with the realistic payoff the ATM leg is selected; the far-OTM one is never in the band', () => {
    const out = validateOnChain({ chain, side: 'CE', params, context, build: build(true) });
    expect(out.setup.available).toBe(true);
    expect(out.setup.strike).toBe(25000);
    const cands = out.fnoValidation!.strikeSelection!.optionCandidates!;
    expect(cands.find((c) => c.strike === 25400)).toMatchObject({ status: 'REJECTED', rejectedAt: 'DELTA' });
    const atmC = cands.find((c) => c.strike === 25000)!;
    const otmC = cands.find((c) => c.strike === 25100)!;
    expect(otmC.status === 'RANKED' || otmC.status === 'REJECTED').toBe(true);
    // Against the same underlying invalidation the ATM leg pays more per unit of risk once decay and costs are counted…
    expect(atmC.comparableRR!).toBeGreaterThan(otmC.comparableRR!);
    // …even though its own built stop (percentage rules: expiry-day widening) makes its raw net R:R look worse.
    expect(otmC.netRR!).toBeGreaterThan(atmC.netRR!);
  });

  it('without a known underlying invalidation the ranking falls back to the built net R:R (as before)', () => {
    const { underlyingStopPoints: _u, ...noStop } = context;
    const out = validateOnChain({ chain, side: 'CE', params, context: noStop, build: build(true) });
    for (const c of out.fnoValidation!.strikeSelection!.optionCandidates!) expect(c.comparableRR ?? null).toBeNull();
  });

  it('every live build passes the realistic payoff (one per buildTradeSetup call)', () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../market-bias.ts'), 'utf8');
    const builds = (src.match(/buildTradeSetup\(/g) ?? []).length;
    expect((src.match(/realisticPayoff: \{ sessionHours: sessionHoursFor\(exchange\) \}/g) ?? []).length).toBe(builds);
  });
});
