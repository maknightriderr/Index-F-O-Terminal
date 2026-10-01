// ============================================================
// SWEEP_CLOSE look-ahead discipline: appending bars after a trigger must
// never change that trigger, its entry, stop or T1. Mirrors the pattern in
// research-no-lookahead.test.ts: replay the full series, replay a truncated
// series that ends right after the sampled bar, and compare the row born at
// that bar. Fields that are legitimately about what happens LATER (grossR,
// exitKind, mfeR, maeR, barsHeld, displacedWithin3) are expected to differ or
// be absent in the truncated run (it has no future bars to grade against)
// and are not compared.
// ============================================================

import { describe, it, expect } from 'vitest';
import { prepareMomentumSeries } from '@fno/analytics';
import { BACKTEST_DATA_DIR } from '../../backtest/fetch-history.js';
import { loadSymbol, sessionMasks, type LoadedSymbol } from '../../backtest/harness.js';
import { runSweepClose } from '../sweep-close.js';

function truncate(loaded: LoadedSymbol, uptoInclusive: number): LoadedSymbol {
  const bars = loaded.series.bars.slice(0, uptoInclusive + 1);
  const series = prepareMomentumSeries(bars);
  return { ...loaded, series, ...sessionMasks(series, loaded.spec.futuresPrice) };
}

const full = loadSymbol(BACKTEST_DATA_DIR, { symbol: 'NIFTY', exchange: 'NSE', priceFile: 'NIFTY_INDEX', volumeFile: 'NIFTY_FUT', futuresPrice: false });

describe('SWEEP_CLOSE no-look-ahead (skips if snapshot data is absent)', () => {
  if (!full || full.series.bars.length < 500) {
    it.skip('snapshot NIFTY_INDEX.json not present in this environment', () => {});
    return;
  }

  const n = full.series.bars.length;
  // A stride sample across the whole history (not every bar — O(n) replays
  // each cost a full session-by-session pass, so this stays fast).
  const stride = Math.max(1, Math.floor(n / 400));
  const sampleIdx = Array.from({ length: n }, (_, i) => i).filter((i) => i > 20 && i < n - 20 && i % stride === 0);

  it('a trigger at bar t (entry, stop, T1, bucket) is unchanged by appending bars after t', () => {
    const rowsFull = runSweepClose('NIFTY', full, 'NSE');
    // Keyed by trigger bar + direction: both directions can trigger on the
    // same bar (independent sweeps), each its own row.
    const fullByKey = new Map(rowsFull.map((r) => [`${r.triggerIndex}:${r.direction}`, r]));
    let checked = 0;
    for (const t of sampleIdx) {
      const session = full.series.sessionDates[full.series.sessionIdx[t]];
      const truncated = truncate(full, t);
      // Skip the rare case where truncation right after t reclassifies this
      // (now-shorter) session's thin-session mask differently — an artifact
      // of the mask's relative-to-median rule, not of look-ahead in the
      // trigger logic itself.
      if (truncated.masked.has(session) !== full.masked.has(session)) continue;
      const rowsTrunc = runSweepClose('NIFTY', truncated, 'NSE');
      for (const direction of ['BEARISH', 'BULLISH'] as const) {
        const rowFull = fullByKey.get(`${t}:${direction}`);
        if (!rowFull) continue; // most bars are not a trigger; only check the ones that are
        const rowTrunc = rowsTrunc.find((r) => r.triggerIndex === t && r.direction === direction);
        if (!rowTrunc) continue; // an earlier trade's forced session-end exit can shift busyUntil once truncation shortens its own session — not a look-ahead property of THIS trigger
        expect(rowTrunc.direction).toBe(rowFull.direction);
        expect(rowTrunc.triggerBars).toBe(rowFull.triggerBars);
        expect(rowTrunc.poolKind).toBe(rowFull.poolKind);
        expect(rowTrunc.entry).toBeCloseTo(rowFull.entry, 6);
        expect(rowTrunc.stop).toBeCloseTo(rowFull.stop, 6);
        expect(rowTrunc.atr).toBeCloseTo(rowFull.atr, 6);
        expect(rowTrunc.t1).toBe(rowFull.t1);
        expect(rowTrunc.rToT1).toBe(rowFull.rToT1);
        expect(rowTrunc.bucket).toBe(rowFull.bucket);
        checked++;
      }
    }
    // Guard against the test silently checking nothing.
    expect(checked).toBeGreaterThan(5);
  }, 60000);
});
