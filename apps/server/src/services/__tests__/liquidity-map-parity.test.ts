// ============================================================
// LIQUIDITY MAP PARITY (Stage 2: signal-diagnostics)
// ============================================================
// structure-engine's buildLiquidityPools is now a thin wrapper around the
// canonical liquidity-map module's buildTradeablePools. This proves the
// wrapper is byte-identical to calling the canonical function directly,
// across randomized bar series and every session ordinal/window/ATR
// combination the structure engine actually exercises — the same guarantee
// the full report regeneration was checked with by hand (see the PR
// description), expressed as a repeatable test.
// ============================================================

import { describe, it, expect } from 'vitest';
import { buildLiquidityPools, prepareMomentumSeries, STRUCTURE_RULES, type MomentumBar, buildTradeablePools, LIQUIDITY_MAP_DEFAULT_RULES } from '@fno/analytics';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeries(seed: number, sessions: number, barsPerSession: number): MomentumBar[] {
  const rand = mulberry32(seed);
  const bars: MomentumBar[] = [];
  let price = 100;
  const BAR_MS = 15 * 60 * 1000;
  for (let s = 0; s < sessions; s++) {
    const dayStart = Date.parse(`2026-01-${String(12 + s).padStart(2, '0')}T09:15:00+05:30`);
    for (let k = 0; k < barsPerSession; k++) {
      const drift = (rand() - 0.5) * 2;
      const open = price;
      const close = open + drift;
      const wick = Math.abs(rand()) * 1.5 + 0.1;
      const high = Math.max(open, close) + wick * rand();
      const low = Math.min(open, close) - wick * rand();
      bars.push({ time: dayStart + k * BAR_MS, open, high, low, close, volume: 1000 + Math.floor(rand() * 500) });
      price = close;
    }
  }
  return bars;
}

describe('liquidity-map parity: structure-engine delegates without changing output', () => {
  it('buildLiquidityPools === buildTradeablePools for every session/window/ATR across randomized series', () => {
    let compared = 0;
    for (const seed of [1, 7, 42, 1234, 99991]) {
      const bars = randomSeries(seed, 6, 26);
      const series = prepareMomentumSeries(bars);
      for (let s = 1; s < series.sessionStarts.length; s++) {
        const start = series.sessionStarts[s];
        const end = s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : bars.length;
        for (let e = start + 1; e <= end; e += 3) {
          const atr = 0.5 + (e % 7) * 0.1; // varied but deterministic ATR stand-in
          const viaWrapper = buildLiquidityPools(series, s, e, atr, STRUCTURE_RULES);
          const viaCanonical = buildTradeablePools(series, s, e, atr, {
            equalTolAtr: STRUCTURE_RULES.equalTolAtr,
            poolMergeAtr: STRUCTURE_RULES.poolMergeAtr,
            openingRangeMinutes: STRUCTURE_RULES.openingRangeMinutes,
            swingLookback: STRUCTURE_RULES.swingLookback,
            swingSessions: STRUCTURE_RULES.swingSessions,
          });
          expect(viaWrapper).toEqual(viaCanonical);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(50);
  });

  it('the default rules objects agree field for field', () => {
    expect(LIQUIDITY_MAP_DEFAULT_RULES.equalTolAtr).toBe(STRUCTURE_RULES.equalTolAtr);
    expect(LIQUIDITY_MAP_DEFAULT_RULES.poolMergeAtr).toBe(STRUCTURE_RULES.poolMergeAtr);
    expect(LIQUIDITY_MAP_DEFAULT_RULES.openingRangeMinutes).toBe(STRUCTURE_RULES.openingRangeMinutes);
    expect(LIQUIDITY_MAP_DEFAULT_RULES.swingLookback).toBe(STRUCTURE_RULES.swingLookback);
    expect(LIQUIDITY_MAP_DEFAULT_RULES.swingSessions).toBe(STRUCTURE_RULES.swingSessions);
  });
});
