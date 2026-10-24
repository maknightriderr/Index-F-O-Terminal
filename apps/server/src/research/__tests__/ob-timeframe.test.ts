// ============================================================
// OB1 timeframe test (research): the 15m arm is the live OB1 signal, and
// neither arm reads a bar after its decision bar. Skips when the saved
// snapshot data is absent.
// ============================================================

import { describe, it, expect } from 'vitest';
import { orderBlockSignalAt, prepareMomentumSeries } from '@fno/analytics';
import { BACKTEST_DATA_DIR } from '../../backtest/fetch-history.js';
import { loadSymbol } from '../../backtest/harness.js';
import { hourlyBars, obSignals, OB_MAX_AGE_DAYS } from '../ob-timeframe.js';

const full = loadSymbol(BACKTEST_DATA_DIR, { symbol: 'NIFTY', exchange: 'NSE', priceFile: 'NIFTY_INDEX', volumeFile: 'NIFTY_FUT', futuresPrice: false });

describe('OB1 timeframe research (skips if snapshot data is absent)', () => {
  if (!full || full.series.bars.length < 2000) {
    it.skip('snapshot NIFTY_INDEX.json not present in this environment', () => {});
    return;
  }
  const bars = full.series.bars;

  it('the 15m arm is orderBlockSignalAt bar by bar (live OB-2.0), within the live 10-day lookback', () => {
    const n = 1500;
    const head = prepareMomentumSeries(bars.slice(0, n));
    const fast = obSignals(head, 'NSE', '15m');
    let fired = 0;
    for (let i = 20; i < n; i++) {
      const live = orderBlockSignalAt(head.bars, i);
      const inAge = live && head.bars[i].time - head.bars[live.block.blockIndex].time <= OB_MAX_AGE_DAYS['15m'] * 86_400_000;
      const got = fast.get(i);
      if (!inAge) {
        // an out-of-age newest block can hide an older in-age one live does not see either way; only require no extra signal when live has none
        if (!live) expect(got).toBeUndefined();
        continue;
      }
      fired++;
      expect(got && [got.type, got.top, got.bottom, got.blockStartIndex]).toEqual([live!.block.type, live!.block.top, live!.block.bottom, live!.block.blockIndex]);
    }
    expect(fired).toBeGreaterThan(10);
  });

  it('1H bars are the session hours from the open: NSE 09:15, 10:15 ... 15:15 (the last one 15 minutes)', () => {
    const hours = hourlyBars(full.series, 'NSE').filter((h) => full.series.sessionDates[full.series.sessionIdx[h.firstSub]] === full.series.sessionDates[100]);
    const ist = (t: number) => new Date(t + 330 * 60_000).toISOString().slice(11, 16);
    expect(hours.map((h) => ist(h.time))).toEqual(['09:15', '10:15', '11:15', '12:15', '13:15', '14:15', '15:15']);
    expect(hours[0].lastSub - hours[0].firstSub).toBe(3);
    expect(hours[6].lastSub - hours[6].firstSub).toBe(0);
    const sub = bars.slice(hours[2].firstSub, hours[2].lastSub + 1);
    expect([hours[2].open, hours[2].high, hours[2].low, hours[2].close]).toEqual([sub[0].open, Math.max(...sub.map((b) => b.high)), Math.min(...sub.map((b) => b.low)), sub[sub.length - 1].close]);
  });

  for (const arm of ['15m', '1H'] as const) {
    it(`${arm} arm: a signal at bar i is unchanged when every bar after i is removed (no look-ahead)`, () => {
      const all = obSignals(full.series, 'NSE', arm);
      const sample = [...all.keys()].filter((i) => i > 500).filter((_, k) => k % 7 === 0).slice(0, 40);
      expect(sample.length).toBeGreaterThan(5);
      for (const i of sample) {
        const cut = prepareMomentumSeries(bars.slice(0, i + 1));
        expect(obSignals(cut, 'NSE', arm).get(i)).toEqual(all.get(i));
      }
      // and no signal appears in a truncated run that the full run does not have
      const i = sample[sample.length - 1];
      const cut = obSignals(prepareMomentumSeries(bars.slice(0, i + 1)), 'NSE', arm);
      for (const [k, v] of cut) expect(all.get(k)).toEqual(v);
    });
  }
});
