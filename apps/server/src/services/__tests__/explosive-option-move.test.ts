// ============================================================
// SYNTHETIC REGRESSION TEST — EXPLOSIVE OPTION MOVE
// ============================================================
// *** EVERY NUMBER IN THIS FILE IS FABRICATED. ***
//
// This is a Policybazaar-CLASS scenario — the SHAPE of a cheap out-of-the-
// money put (~1.75) exploding to ~500 on a bearish structure break with IV
// expansion — built from made-up, internally-consistent data. It is NOT a
// replay of any real symbol's history. No real historical option-chain data
// for that stock or period exists anywhere in this system (capture began
// 2026-09-21), and nothing here pretends otherwise. The symbol is named
// SYNTHETIC_EXPLOSIVE_PE for that reason.
//
// The specific strike/premium/spot values live ONLY in this fixture. The
// production classifier (explosive-option-move.ts) is generic; the last test
// below checks that none of these fixture numbers leaked into it.
//
// What it exercises: the fixture's underlying candles go through the same
// @fno/analytics market-structure and setup-classifier functions market-
// bias.ts uses, the entry chain goes through trade-setup/index.ts's
// buildTradeSetup, the strategy labeller names the setup, and the generic
// EXPLOSIVE_OPTION_MOVE classifier must recognise the option path.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyzeMarketStructure, buildTradeSetup, classifySetup } from '@fno/analytics';
import type { OptionChainLeg, OptionChainStrike } from '@fno/shared';
import { classifyExplosiveOptionMove, type OptionPathPoint } from '../explosive-option-move.js';
import { classifyStrategyLabels } from '../strategy-label.js';

// ---------------- SYNTHETIC FIXTURE (fabricated) ----------------
const SYNTHETIC = {
  label: 'SYNTHETIC — fabricated data, not historical',
  symbol: 'SYNTHETIC_EXPLOSIVE_PE',
  entrySpot: 1800,
  atmStrike: 1800,
  otmPutStrike: 1600,
  otmPutEntryPremium: 1.75,
  otmPutPeakPremium: 500.5,
  atmPutEntryPremium: 40,
  entryIvPct: 30,
  peakIvPct: 75,
  finalSpot: 1100,
  lotSize: 400,
  dte: 5,
  t0: Date.parse('2030-01-07T05:00:00Z'), // a fictional date, deliberately outside any recorded period
} as const;

/** Linear path through pivot closes, `barsPerLeg` bars per leg. */
function zigzag(pivots: number[], barsPerLeg = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    for (let b = 0; b < barsPerLeg; b++) out.push(pivots[i] + ((pivots[i + 1] - pivots[i]) * b) / barsPerLeg);
  }
  out.push(pivots[pivots.length - 1]);
  return out;
}

// Rising swings first (higher highs / higher lows), then the structure
// breaks down: a lower high, a lower low, and a collapse.
const CLOSES = zigzag([1700, 1760, 1720, 1800, 1780, 1790, 1700, 1720, 1500, 1550, 1300, 1320, SYNTHETIC.finalSpot, SYNTHETIC.finalSpot + 10, SYNTHETIC.finalSpot]);
const HIGHS = CLOSES.map((c) => c + 2);
const LOWS = CLOSES.map((c) => c - 2);

function leg(over: Partial<OptionChainLeg>): OptionChainLeg {
  return {
    token: 'SYNTH',
    ltp: 1,
    bid: 0.95,
    ask: 1.05,
    volume: 50_000,
    oi: 400_000,
    changeOi: 0,
    changePercent: 0,
    iv: SYNTHETIC.entryIvPct,
    delta: -0.5,
    gamma: 0.002,
    theta: -2,
    vega: 1.5,
    oiInterpretation: 'NEUTRAL' as OptionChainLeg['oiInterpretation'],
    moneyness: 'ATM',
    greeksSource: 'BROKER',
    timestamp: SYNTHETIC.t0,
    ...over,
  };
}

const ENTRY_CHAIN: OptionChainStrike[] = [
  {
    strike: SYNTHETIC.otmPutStrike,
    distanceFromSpot: SYNTHETIC.otmPutStrike - SYNTHETIC.entrySpot,
    call: null,
    put: leg({ token: 'SYNTH_PE_OTM', ltp: SYNTHETIC.otmPutEntryPremium, bid: 1.7, ask: 1.8, delta: -0.03, moneyness: 'OTM' }),
  },
  {
    strike: SYNTHETIC.atmStrike,
    distanceFromSpot: 0,
    call: leg({ token: 'SYNTH_CE_ATM', ltp: 40, bid: 39.9, ask: 40.1, delta: 0.5 }),
    put: leg({ token: 'SYNTH_PE_ATM', ltp: SYNTHETIC.atmPutEntryPremium, bid: 39.9, ask: 40.1, delta: -0.5 }),
  },
];

/** The option's fabricated path: premium and IV expand as the underlying collapses. */
function putPath(strike: number, entryPremium: number, peakPremium: number): OptionPathPoint[] {
  const steps = 8;
  const pts: OptionPathPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const underlying = SYNTHETIC.entrySpot + (SYNTHETIC.finalSpot - SYNTHETIC.entrySpot) * f;
    // Convex: premium grows geometrically toward the peak (fabricated, not a pricing model).
    const premium = i === steps ? peakPremium : entryPremium * Math.pow(peakPremium / entryPremium, f * f);
    const iv = SYNTHETIC.entryIvPct + (SYNTHETIC.peakIvPct - SYNTHETIC.entryIvPct) * f;
    pts.push({ t: SYNTHETIC.t0 + i * 15 * 60 * 1000, premium, iv, underlying });
  }
  void strike;
  return pts;
}

// ---------------- TESTS ----------------

describe(`EXPLOSIVE_OPTION_MOVE — ${SYNTHETIC.label}`, () => {
  const structure = analyzeMarketStructure(HIGHS, LOWS);

  it('the synthetic underlying shows a bearish structure break (via @fno/analytics market structure)', () => {
    expect(structure.lastEvent).not.toBeNull();
    expect(structure.lastEvent!.direction).toBe('BEARISH');
  });

  it('the setup classifier and strategy labeller name it as a structure trade', () => {
    const cls = classifySetup({
      direction: 'BEARISH',
      structureEvent: structure.lastEvent ? { type: structure.lastEvent.type, direction: structure.lastEvent.direction } : null,
    });
    const labels = classifyStrategyLabels({ direction: 'BEARISH', setupTriggers: cls.allTriggers });
    expect(['BOS', 'CHOCH']).toContain(labels.primary);
  });

  it('trade-setup/index.ts builds its setup at the ATM strike — Phase 1 does not change strike selection', () => {
    const setup = buildTradeSetup(ENTRY_CHAIN, SYNTHETIC.atmStrike, 'BEARISH', 80, 60, undefined, null, SYNTHETIC.dte, SYNTHETIC.lotSize, 15);
    // The builder takes the ATM put (mid-price entry) and never reaches for
    // the cheap OTM strike — which is exactly why an explosive OTM move is a
    // Phase 2 selection question, not something Phase 1 changes.
    expect(setup.available).toBe(true);
    expect(setup.side).toBe('PE');
    expect(setup.strike).toBe(SYNTHETIC.atmStrike);
    expect(setup.strike).not.toBe(SYNTHETIC.otmPutStrike);
  });

  it('classifies the cheap OTM put path as EXPLOSIVE_OPTION_MOVE', () => {
    const result = classifyExplosiveOptionMove({
      side: 'PE',
      strike: SYNTHETIC.otmPutStrike,
      path: putPath(SYNTHETIC.otmPutStrike, SYNTHETIC.otmPutEntryPremium, SYNTHETIC.otmPutPeakPremium),
      structureEvent: structure.lastEvent ? { type: structure.lastEvent.type, direction: structure.lastEvent.direction } : null,
    });
    expect(result.classification).toBe('EXPLOSIVE_OPTION_MOVE');
    for (const [name, c] of Object.entries(result.criteria)) {
      expect(c.pass, `criterion ${name}`).toBe(true);
    }
  });

  it('control: the ATM put on the same move is not "cheap", so it is not classified explosive', () => {
    const result = classifyExplosiveOptionMove({
      side: 'PE',
      strike: SYNTHETIC.atmStrike,
      path: putPath(SYNTHETIC.atmStrike, SYNTHETIC.atmPutEntryPremium, SYNTHETIC.atmStrike - SYNTHETIC.finalSpot),
      structureEvent: structure.lastEvent ? { type: structure.lastEvent.type, direction: structure.lastEvent.direction } : null,
    });
    expect(result.classification).toBe('NONE');
    expect(result.criteria.outOfTheMoneyAtEntry.pass).toBe(false);
    expect(result.criteria.cheapAtEntry.pass).toBe(false);
  });

  it('control: without a structure break in the option\'s favour it is not classified explosive', () => {
    const result = classifyExplosiveOptionMove({
      side: 'PE',
      strike: SYNTHETIC.otmPutStrike,
      path: putPath(SYNTHETIC.otmPutStrike, SYNTHETIC.otmPutEntryPremium, SYNTHETIC.otmPutPeakPremium),
      structureEvent: { type: 'BOS', direction: 'BULLISH' },
    });
    expect(result.classification).toBe('NONE');
    expect(result.criteria.structureBreakInFavour.pass).toBe(false);
  });

  it('control: without IV expansion it is not classified explosive', () => {
    const flatIv = putPath(SYNTHETIC.otmPutStrike, SYNTHETIC.otmPutEntryPremium, SYNTHETIC.otmPutPeakPremium).map((p) => ({ ...p, iv: SYNTHETIC.entryIvPct }));
    const result = classifyExplosiveOptionMove({
      side: 'PE',
      strike: SYNTHETIC.otmPutStrike,
      path: flatIv,
      structureEvent: { type: 'BOS', direction: 'BEARISH' },
    });
    expect(result.classification).toBe('NONE');
    expect(result.criteria.ivExpansion.pass).toBe(false);
  });

  it('no fixture-specific symbol, strike or premium is hard-coded in the production classifier', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.resolve(here, '../explosive-option-move.ts'), 'utf-8');
    for (const forbidden of ['1.75', '500', '1600', '1800', '1100', 'POLICYBAZAAR', 'PB FINTECH', 'SYNTHETIC_EXPLOSIVE_PE']) {
      expect(source.toUpperCase()).not.toContain(forbidden.toUpperCase());
    }
  });
});
