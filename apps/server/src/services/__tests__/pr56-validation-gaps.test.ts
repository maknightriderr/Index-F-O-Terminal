import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTradeSetup, validNakedLongGeometry } from '@fno/analytics';
import type { OptionChain } from '@fno/shared';
import { leg } from './trade-setup-fixtures.js';

const mocked = vi.hoisted(() => ({ next: null as OptionChain | null }));
vi.mock('../../lib/db.js', () => ({ sql: vi.fn() }));
vi.mock('../../lib/redis.js', () => ({ redis: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), on: vi.fn() }, scanKeys: vi.fn(async () => []) }));
vi.mock('../fno-scanner.js', () => ({ ivRankFor: vi.fn(async () => null) }));
vi.mock('../option-chain.js', () => ({ buildOptionChain: vi.fn(async () => mocked.next), resolveSpotToken: vi.fn(), resolveNearestFuturesContract: vi.fn() }));

import { buildStructureContract, structureChainGeometry, structureEntrySpot } from '../market-bias.js';
import { structureSequenceRefusal, type LiveLifecycle } from '../structure-live.js';
import { preMintCheck } from '../slot-arbitration.js';
import { triggerSlPremiumPct } from '../momentum-break-live.js';

const T = Date.parse('2026-10-23T10:30:00+05:30');
const row = (delta = 0.5, over: object = {}) => ({ strike: 100, distanceFromSpot: 0,
  call: leg({ ltp: 100, bid: 99.5, ask: 100.5, delta, gamma: 0.002, theta: -1, volume: 50000, oi: 500000, ...over }),
  put: leg({ ltp: 100, bid: 99.5, ask: 100.5, delta: -delta, gamma: 0.002, theta: -1, volume: 50000, oi: 500000, ...over }),
});
const chain = (over: Partial<OptionChain> = {}): OptionChain => ({
  symbol: 'SYN', underlying: 'SYN', exchange: 'NSE', expiry: '2026-10-23', availableExpiries: ['2026-10-23', '2026-10-29'],
  dte: 0, spotPrice: 100, atmStrike: 100, lotSize: 75, timestamp: T, strikes: [row()], ...over,
}) as OptionChain;
const lifecycle = (bear: boolean) => ({ id: 'geometry-test', triggerId: 'A3', entry: 100, rejectionFillPrice: 100,
  stop: bear ? 130 : 70, t1: { kind: 'PD', price: bear ? 60 : 140 }, direction: bear ? 'BEARISH' : 'BULLISH', sweepExtreme: bear ? 129 : 71, atr: 5,
}) as LiveLifecycle;
const round2 = (x: number) => Math.round(x * 100) / 100;

for (const bear of [false, true]) describe(`${bear ? 'bearish PE' : 'bullish CE'}: independent arithmetic and validation`, () => {
  const direction = bear ? 'BEARISH' : 'BULLISH';
  const side = bear ? 'PE' : 'CE';
  const build = (pct = 0.3, opts: { lot?: number; tick?: number; quote?: object; move?: number; vix?: number | null; dte?: number } = {}) =>
    buildTradeSetup([row(0.5, opts.quote)], 100, direction, 90, opts.move ?? 60, pct, opts.vix ?? null, opts.dte ?? 5, opts.lot ?? 75, 5,
      { flags: { structuralStop: true }, rrGate: false, tickSize: opts.tick ?? 0.05 });

  it('reproduces the reviewed negative-stop input and refuses it before sizing', () => {
    const sl = triggerSlPremiumPct([row()], 100, direction, 300)!;
    expect(sl.slPremiumPct).toBe(1.5); // 0.5 delta × 300 underlying points / 100 premium
    // Before: entry 100 - width 150 = -50, available=true. Now: no invented tighter stop.
    expect(build(sl.slPremiumPct)).toMatchObject({ available: false, noTradeCode: 'INVALID_TRADE_GEOMETRY' });
  });
  it.each([NaN, Infinity, -Infinity, -0.1, 0, 0.450001, 1, 1.5])('refuses invalid/out-of-limit stop fraction %s', (pct) => {
    expect(build(pct).available).toBe(false);
  });
  it.each([null, 12, 25])('cannot hide an oversized base stop with VIX %s or expiry widening', (vix) => {
    for (const dte of [0, 1, 5]) expect(build(1.5, { vix, dte }).available).toBe(false);
  });
  it('accepts the exact 45% boundary, with independently bounded quantity', () => {
    const result = build(0.45);
    expect(result).toMatchObject({ available: true, side, entry: 100, stopLoss: 55, target: 130 });
    // 500000 capital, 2% risk, 5% premium: min(floor(10000/(45*75)), floor(25000/(100*75))) = 2 lots.
    expect(result.positionSize).toMatchObject({ lots: 2, quantity: 150, riskAmount: 6750, premiumOutlay: 15000 });
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid lot size %s', (lot) => expect(build(0.3, { lot }).available).toBe(false));
  it.each([0, -0.05, NaN, Infinity])('rejects invalid tick size %s', (tick) => expect(build(0.3, { tick }).available).toBe(false));
  it.each([NaN, Infinity, 0, -1])('rejects invalid last price %s', (ltp) => expect(build(0.3, { quote: { ltp } }).available).toBe(false));
  it.each([{ bid: NaN }, { ask: Infinity }, { bid: -1 }, { bid: 102, ask: 101 }])('rejects malformed depth %j', (quote) => expect(build(0.3, { quote }).available).toBe(false));
  it.each([NaN, Infinity, 0, -1])('rejects invalid target move %s', (move) => expect(build(0.3, { move }).available).toBe(false));
  it('rejects sub-cent premiums that round to an empty risk interval', () => {
    expect(build(0.3, { quote: { ltp: 0.001, bid: 0, ask: 0 } }).available).toBe(false);
  });
  it('pre-mint independently refuses malformed premium geometry, expiry and lot sizes', () => {
    const setup = { ...build(), expiry: '2026-10-23' };
    expect(preMintCheck(setup, chain(), T)).toBeNull();
    for (const stopLoss of [-50, 0, 54.99, 100, 101, NaN, Infinity]) {
      expect(preMintCheck({ ...setup, stopLoss }, chain(), T)?.code).toBe('INVALID_TRADE_GEOMETRY');
    }
    for (const target of [99, 100, NaN, Infinity]) expect(preMintCheck({ ...setup, target }, chain(), T)?.code).toBe('INVALID_TRADE_GEOMETRY');
    expect(preMintCheck(setup, chain({ lotSize: 0 }), T)?.code).toBe('INVALID_TRADE_GEOMETRY');
    expect(preMintCheck({ ...setup, strike: undefined }, chain(), T)?.code).toBe('NO_QUOTE');
    expect(preMintCheck({ ...setup, side: undefined }, chain(), T)?.code).toBe('NO_QUOTE');
    for (const timestamp of [undefined, NaN, Infinity, 0]) expect(preMintCheck(setup, chain({ timestamp }), T)?.code).toBe('STALE_QUOTE');
    expect(preMintCheck(setup, chain({ expiry: '2026-10-29' }), T)?.code).toBe('NO_QUOTE');
    expect(preMintCheck(setup, chain({ strikes: [row(0.5, { ask: Infinity })] }), T)?.code).toBe('NO_QUOTE');
  });

  describe('real contract pipeline with next-expiry fetch (external services mocked)', () => {
    beforeEach(() => { mocked.next = chain({ expiry: '2026-10-29', dte: 6, spotPrice: bear ? 90 : 110 }); });
    const call = (lc = lifecycle(bear), primary = chain({ strikes: [row(0.1)] })) => buildStructureContract({
      provider: { getQuote: async () => [] } as any, underlying: 'SYN', exchange: 'NSE', chain: primary, lc, spot: structureEntrySpot(lc, primary),
      side, direction, confidence: 90, optionAtr: 5, fiveMinute: false, entryContext: undefined, at: T,
    });
    it('reprices target, stop, ranking risk and returned fill geometry on the selected expiry', async () => {
      const lc = lifecycle(bear), before = JSON.stringify(lc);
      const result = await call(lc);
      expect(result.validated.setup.available).toBe(true);
      expect(result.validated.chain.expiry).toBe('2026-10-29');
      expect(result).toMatchObject({ spot: bear ? 90 : 110, stopDistance: 40, targetMove: 30, remainingRToT1: 0.75 });
      // Payoff = |delta|*30 + gamma*30²/2 - |theta|*hold/6.25; risk = |delta|*40 = 20 premium points.
      expect(result.validated.setup.target).toBe(round2(100 + 0.5 * 30 + 0.002 * 30 * 30 / 2 - result.expectedHoldHours / 6.25));
      expect(result.validated.setup.stopLoss).toBe(80);
      expect(result.validated.fnoValidation?.expiryFallback).toBe(true);
      // Experiment callers stamp this selected expiry before the same final guard as production.
      expect(preMintCheck({ ...result.validated.setup, expiry: result.validated.chain.expiry }, result.validated.chain, T)).toBeNull();
      expect(JSON.stringify(lc)).toBe(before);
    });
    it.each(['stop', 'target', 'beyond-stop', 'beyond-target', 'zero', 'nan', 'infinity'] as const)('refuses fallback with %s spot before building a contract', async (kind) => {
      const lc = lifecycle(bear);
      const values = { stop: lc.stop!, target: lc.t1!.price, 'beyond-stop': lc.stop! + (bear ? 1 : -1), 'beyond-target': lc.t1!.price + (bear ? -1 : 1), zero: 0, nan: NaN, infinity: Infinity };
      mocked.next!.spotPrice = values[kind];
      const result = await call(lc);
      expect(result.validated.setup).toMatchObject({ available: false, noTradeCode: 'STRUCTURE_SEQUENCE' });
      expect(result.validated.chain.expiry).toBe('2026-10-29');
    });
    it.each([0, -1, NaN, Infinity])('invalid primary live spot %s never substitutes the old close', async (spotPrice) => {
      const lc = lifecycle(bear), primary = chain({ spotPrice });
      expect(structureSequenceRefusal(lc, structureEntrySpot(lc, primary))).not.toBeNull();
      expect((await call(lc, primary)).validated.setup.available).toBe(false);
    });
    it('preserves S1 confirming-close geometry through fallback', async () => {
      const lc = { ...lifecycle(bear), triggerId: undefined };
      expect(structureChainGeometry(lc, mocked.next!, 100)).toMatchObject({ spot: 100, stopDistance: 30, targetMove: 40 });
      const result = await call(lc);
      expect(result.validated.setup.available).toBe(true);
      expect(result).toMatchObject({ spot: 100, stopDistance: 30, targetMove: 40, remainingRToT1: 1.333 });
    });
  });
});

it('the naked-long guard is direction-independent: buying a PE still loses when its premium falls', () => {
  expect(validNakedLongGeometry(100, 70, 130)).toBe(true);
  expect(validNakedLongGeometry(100, 130, 70)).toBe(false);
});
