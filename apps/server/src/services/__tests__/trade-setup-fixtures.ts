// ============================================================
// GOLDEN CASE MATRIX for buildTradeSetup (shared by the golden test and the
// validation-review flag tests). Not a test file itself.
// ============================================================
// Every case passes NO validation-review inputs and NO flags, which is
// exactly "all new flags OFF" (see trade-setup-golden.test.ts).
//
// Every chain number is a FABRICATED fixture, copied verbatim from
// phase2-shadow.test.ts (leg()/fixtureStrikes()), phase3.test.ts
// (strikesWith()) and explosive-option-move.test.ts (ENTRY_CHAIN).
// ============================================================

import { buildTradeSetup } from '@fno/analytics';
import type { OptionChainLeg, OptionChainStrike } from '@fno/shared';

// ---------------- phase2-shadow.test.ts fixture ----------------
export function leg(over: Partial<OptionChainLeg>): OptionChainLeg {
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

export const ATM = 25000;
export const LOT = 75;

export function fixtureStrikes(): OptionChainStrike[] {
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
      call: leg({ token: 'CE25100', ltp: 60, bid: 55, ask: 65, volume: 50, oi: 100, delta: 0.4, moneyness: 'OTM' }),
      put: leg({ token: 'PE25100', ltp: 150, bid: 149.5, ask: 150.5, delta: -0.6, moneyness: 'ITM' }),
    },
  ];
}

// ---------------- phase3.test.ts fixture ----------------
export function strikesWith(atmCall: Partial<OptionChainLeg>): OptionChainStrike[] {
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

// ---------------- explosive-option-move.test.ts fixture ----------------
export const SYNTH = { atmStrike: 1800, otmPutStrike: 1600, entrySpot: 1800, otmPutEntryPremium: 1.75, atmPutEntryPremium: 40, entryIvPct: 30, lotSize: 400, dte: 5 };
function eLeg(over: Partial<OptionChainLeg>): OptionChainLeg {
  return {
    token: 'SYNTH',
    ltp: 1,
    bid: 0.95,
    ask: 1.05,
    volume: 50_000,
    oi: 400_000,
    changeOi: 0,
    changePercent: 0,
    iv: SYNTH.entryIvPct,
    delta: -0.5,
    gamma: 0.002,
    theta: -2,
    vega: 1.5,
    oiInterpretation: 'NEUTRAL' as OptionChainLeg['oiInterpretation'],
    moneyness: 'ATM',
    greeksSource: 'BROKER',
    timestamp: Date.parse('2030-01-07T05:00:00Z'),
    ...over,
  };
}
export const ENTRY_CHAIN: OptionChainStrike[] = [
  {
    strike: SYNTH.otmPutStrike,
    distanceFromSpot: SYNTH.otmPutStrike - SYNTH.entrySpot,
    call: null,
    put: eLeg({ token: 'SYNTH_PE_OTM', ltp: SYNTH.otmPutEntryPremium, bid: 1.7, ask: 1.8, delta: -0.03, moneyness: 'OTM' }),
  },
  {
    strike: SYNTH.atmStrike,
    distanceFromSpot: 0,
    call: eLeg({ token: 'SYNTH_CE_ATM', ltp: 40, bid: 39.9, ask: 40.1, delta: 0.5 }),
    put: eLeg({ token: 'SYNTH_PE_ATM', ltp: SYNTH.atmPutEntryPremium, bid: 39.9, ask: 40.1, delta: -0.5 }),
  },
];

/**
 * The case matrix. Each entry is the exact positional argument list handed to
 * buildTradeSetup — expected move, VIX, DTE, ATR, SL% and lot size are varied
 * across the ranges the live engine produces, including every refusal path
 * reachable from these chains.
 */
type Args = Parameters<typeof buildTradeSetup>;
export const GOLDEN_CASES: Record<string, () => Args> = {};

const moves = [20, 45, 60, 100, 150, 250];
const vixes: (number | null)[] = [null, 14, 20, 32];
const dtes: (number | null)[] = [null, 0, 1, 3, 10];
for (const move of moves) {
  for (const vix of vixes) {
    for (const dte of dtes) {
      GOLDEN_CASES[`p2 BULL move=${move} vix=${vix} dte=${dte}`] = () => [fixtureStrikes(), ATM, 'BULLISH', 80, move, undefined, vix, dte, LOT, null, { tickSize: 0.05, expectedHoldHours: 5 }];
    }
  }
}
for (const move of [40, 80, 120, 200]) {
  for (const atr of [null, 10, 25, 60]) {
    GOLDEN_CASES[`p2 BEAR move=${move} atr=${atr}`] = () => [fixtureStrikes(), ATM, 'BEARISH', 82, move, undefined, 17, 3, LOT, atr, { tickSize: 0.05, expectedHoldHours: 4, ivRank: 55, hvPct: 14 }];
    GOLDEN_CASES[`p2 BULL positional move=${move} atr=${atr}`] = () => [fixtureStrikes(), ATM, 'BULLISH', 90, move, 0.4, 22, 20, LOT, atr, { tickSize: 0.05, expectedHoldHours: 31.25, ivRank: 20, hvPct: 18 }];
  }
}
// Confidence / direction refusals.
GOLDEN_CASES['p2 low confidence'] = () => [fixtureStrikes(), ATM, 'BULLISH', 60, 100, undefined, null, 3, LOT, null, {}];
GOLDEN_CASES['p2 neutral'] = () => [fixtureStrikes(), ATM, 'NEUTRAL', 90, 100, undefined, null, 3, LOT, null, {}];
GOLDEN_CASES['p2 no quote at atm'] = () => [fixtureStrikes(), 99999, 'BULLISH', 90, 100, undefined, null, 3, LOT, null, {}];
GOLDEN_CASES['p2 zero move'] = () => [fixtureStrikes(), ATM, 'BULLISH', 90, 0, undefined, null, 3, LOT, null, {}];
GOLDEN_CASES['p2 default args'] = () => [fixtureStrikes(), ATM, 'BULLISH', 90, 100];

// phase3 strikesWith() variants: thin, wide, bad delta, rich spread, lot sizes.
const p3Variants: Record<string, Partial<OptionChainLeg>> = {
  liquid: { ltp: 100, bid: 99.5, ask: 100.5, volume: 20000, oi: 300000, delta: 0.5, theta: -5 },
  thin: { ltp: 100, bid: 99, ask: 101, volume: 10, oi: 50, delta: 0.5, theta: -5 },
  wideSpread: { ltp: 100, bid: 94, ask: 106, volume: 20000, oi: 300000 },
  badDelta: { delta: 1.7 },
  noBidAsk: { ltp: 80, bid: 0, ask: 0, volume: 20000, oi: 300000, delta: 0.55 },
  cheapLeg: { ltp: 4, bid: 3.95, ask: 4.05, volume: 20000, oi: 300000, delta: 0.5, theta: -1 },
  highDelta: { ltp: 100, bid: 99.8, ask: 100.2, volume: 20000, oi: 300000, delta: 0.95, theta: -2 },
};
for (const [name, v] of Object.entries(p3Variants)) {
  for (const move of [30, 70, 140, 400]) {
    for (const lot of [1, 25, 75, 1800]) {
      GOLDEN_CASES[`p3 ${name} move=${move} lot=${lot}`] = () => [strikesWith(v), ATM, 'BULLISH', 80, move, undefined, 16, 2, lot, 30, { tickSize: 0.05, expectedHoldHours: 3 }];
    }
  }
}

// explosive-option-move ENTRY_CHAIN (the bearish ATM put).
for (const move of [10, 25, 60, 90, 150]) {
  for (const atr of [null, 5, 15]) {
    for (const dte of [0, 1, 5]) {
      GOLDEN_CASES[`explosive BEAR move=${move} atr=${atr} dte=${dte}`] = () => [ENTRY_CHAIN, SYNTH.atmStrike, 'BEARISH', 80, move, undefined, null, dte, SYNTH.lotSize, atr];
    }
  }
}
GOLDEN_CASES['explosive BULL call'] = () => [ENTRY_CHAIN, SYNTH.atmStrike, 'BULLISH', 85, 60, undefined, 24, 5, SYNTH.lotSize, 15];
