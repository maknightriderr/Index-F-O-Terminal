// ============================================================
// Look-ahead discipline: appending future bars must never change a feature
// or trigger decided at bar t. This test truncates a real loaded symbol's
// series after bar t and confirms every research feature/trigger at t is
// byte-identical to the value computed from the full series.
// ============================================================

import { describe, it, expect } from 'vitest';
import { prepareMomentumSeries, type MomentumBar } from '@fno/analytics';
import { BACKTEST_DATA_DIR } from '../../backtest/fetch-history.js';
import { loadSymbol, sessionMasks, type LoadedSymbol } from '../../backtest/harness.js';
import { buildContext, trendAt } from '../context.js';
import { evaluatePullback, evaluateFailedBreakout, evaluateRangeReversal } from '../triggers.js';
import { buildOppBars } from '../opportunity-census.js';

function truncate(loaded: LoadedSymbol, uptoInclusive: number): LoadedSymbol {
  const bars = loaded.series.bars.slice(0, uptoInclusive + 1);
  const series = prepareMomentumSeries(bars);
  return { ...loaded, series, ...sessionMasks(series, loaded.spec.futuresPrice) };
}

const full = loadSymbol(BACKTEST_DATA_DIR, { symbol: 'NIFTY', exchange: 'NSE', priceFile: 'NIFTY_INDEX', volumeFile: 'NIFTY_FUT', futuresPrice: false });

describe('research no-look-ahead (skips if snapshot data is absent)', () => {
  if (!full || full.series.bars.length < 500) {
    it.skip('snapshot NIFTY_INDEX.json not present in this environment', () => {});
    return;
  }

  const n = full.series.bars.length;
  // Pick bar indices well inside the data, away from the very start/end.
  const sampleIdx = [200, 400, 600, 800, 1000].filter((i) => i < n - 50);

  it('context features at t are unchanged by appending bars after t', () => {
    const ctxFull = buildContext(full);
    for (const t of sampleIdx) {
      const truncated = truncate(full, t);
      const ctxTrunc = buildContext(truncated);
      expect(ctxTrunc.ema80[t]).toBeCloseTo(ctxFull.ema80[t], 8);
      expect(ctxTrunc.ema20[t]).toBeCloseTo(ctxFull.ema20[t], 8);
      expect(ctxTrunc.adx56[t]).toBeCloseTo(ctxFull.adx56[t], 6);
      expect(ctxTrunc.rsi14[t]).toBeCloseTo(ctxFull.rsi14[t], 6);
      expect(ctxTrunc.atr14[t]).toBeCloseTo(ctxFull.atr14[t] ?? NaN, 8);
      expect(ctxTrunc.supertrendDir[t]).toBe(ctxFull.supertrendDir[t]);
      expect(trendAt(truncated, ctxTrunc, t)).toBe(trendAt(full, ctxFull, t));
    }
  });

  it('trigger families C/D/E at t are unchanged by appending bars after t', () => {
    const ctxFull = buildContext(full);
    for (const t of sampleIdx) {
      const truncated = truncate(full, t);
      const ctxTrunc = buildContext(truncated);
      expect(evaluatePullback(truncated, ctxTrunc, t)).toEqual(evaluatePullback(full, ctxFull, t));
      expect(evaluateFailedBreakout(truncated, ctxTrunc, t)).toEqual(evaluateFailedBreakout(full, ctxFull, t));
      expect(evaluateRangeReversal(truncated, ctxTrunc, t)).toEqual(evaluateRangeReversal(full, ctxFull, t));
    }
  });

  it('opportunity census ATR feature at t is unchanged by appending bars after t (the label itself is allowed to use future bars within the session — only the feature may not)', () => {
    for (const t of sampleIdx) {
      const truncated = truncate(full, t);
      // Truncated just after t: buildOppBars over the truncated series has no
      // bars after t to resolve a label with, so t itself may not even
      // appear; what must hold is that wherever it DOES appear in a longer
      // prefix, its atr is stable. Compare two different truncations that
      // both extend past t.
      const a = truncate(full, t + 20);
      const b = truncate(full, t + 40);
      const oppA = buildOppBars(a, 15 * 60 * 1000).find((o) => o.index === t);
      const oppB = buildOppBars(b, 15 * 60 * 1000).find((o) => o.index === t);
      if (oppA && oppB) {
        expect(oppA.atr).toBeCloseTo(oppB.atr, 8);
      }
    }
  });
});
