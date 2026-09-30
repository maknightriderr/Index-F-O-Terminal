// ============================================================
// Harness parameterisation (bar length, file suffix, closing guard per
// strategy) and the 5m structure strategy
// ============================================================

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateStructureSessionMTF, prepareMomentumSeries, STRUCTURE_5M_VARIANTS, STRUCTURE_RULES_5M, STRUCTURE_VARIANTS, type MomentumBar } from '@fno/analytics';
import { CLOSING_GUARD_MIN, loadSymbol, replayStrategy, sessionMasks, type BacktestStrategy, type LoadedSymbol } from '../harness.js';
import { confirmedAt, sessionSetups, STRUCTURE_5M_STRATEGY, STRUCTURE_STRATEGY } from '../structure-backtest.js';
import { structureSymbol5m } from './fixtures/synthetic.js';

const M5 = 5 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const W = { from: '2026-01-01', to: '2026-12-31' };

describe('harness: per-strategy closing guard and bar length', () => {
  const at = (hhmm: string) => Date.parse(`2026-03-10T${hhmm}:00+05:30`);
  function toyLoaded(barMs: number, overrides: Record<number, Partial<MomentumBar>>): LoadedSymbol {
    const n = Math.round((375 * 60 * 1000) / barMs);
    const bars = Array.from({ length: n }, (_, k) => ({ time: at('09:15') + k * barMs, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000, ...(overrides[k] ?? {}) }));
    const series = prepareMomentumSeries(bars);
    return { spec: { symbol: 'TOY', exchange: 'NSE', priceFile: 'TOY', futuresPrice: false }, series, ...sessionMasks(series, false), droppedPartial: 0, droppedOutOfSession: 0, volumeCoverage: 1, firstBar: null, lastBar: null, ...(barMs !== M15 ? { barMs } : {}) };
  }
  const toy = (signalBar: number, closingGuardMin?: number, fillWithinBars = 8): BacktestStrategy<{ id: string }, { at: number }> => ({
    name: 'TOY',
    orderType: 'LIMIT',
    variants: [{ id: 'v' }],
    evaluate: (_l, i) => (i === signalBar ? { at: i } : null),
    toOrder: () => ({ direction: 'BEARISH', type: 'LIMIT', entry: 100.5, stop: 101.5, target: 98.5, fillWithinBars }),
    invalidateOnClose: () => (b) => b.close > 101.2,
    invalidationExit: 'SWEEP_RECLAIMED',
    openingGuard: () => false,
    ...(closingGuardMin != null ? { closingGuardMin: () => closingGuardMin } : {}),
    groupKeys: {},
  });

  it('without closingGuardMin the LIMIT closing guard is the shipped 60 minutes', () => {
    expect(CLOSING_GUARD_MIN).toBe(60);
    const l = toyLoaded(M15, { 21: { high: 100.6 } }); // 14:30 fill, 60 min before 15:30
    expect(replayStrategy(l, toy(19), { id: 'v' }, W).unfilled[0].outcome).toBe('GUARDED');
  });

  it('a strategy closing guard of 15 minutes lets a 14:30 fill trade, and still refuses one at 15:15', () => {
    const l = toyLoaded(M15, { 21: { high: 100.6 } });
    expect(replayStrategy(l, toy(19, 15), { id: 'v' }, W).trades).toHaveLength(1);
    const late = toyLoaded(M15, { 24: { high: 100.6 } }); // 15:15 fill
    expect(replayStrategy(late, toy(22, 15), { id: 'v' }, W).unfilled[0].outcome).toBe('GUARDED');
  });

  it('a 5m series decides and exits on 5m bar closes', () => {
    const l = toyLoaded(M5, { 30: { high: 100.6 }, 33: { low: 98.4, close: 98.6 } });
    const { trades } = replayStrategy(l, toy(28, 60, 24), { id: 'v' }, W);
    expect(trades).toHaveLength(1);
    expect(Date.parse(trades[0].decidedAt)).toBe(at('09:15') + 28 * M5 + M5);
    expect(Date.parse(trades[0].exitAt)).toBe(at('09:15') + 33 * M5 + M5);
    expect(trades[0].fill?.barsWaited).toBe(2);
  });

  it('the 15m structure strategy keeps 60 for the shipped variants; the closing-guard variants carry theirs', () => {
    for (const v of STRUCTURE_VARIANTS) expect(STRUCTURE_STRATEGY.closingGuardMin!(v)).toBe(60);
    expect(STRUCTURE_5M_VARIANTS.map((v) => STRUCTURE_5M_STRATEGY.closingGuardMin!(v))).toEqual([60, 15, 60, 15]);
  });
});

describe('loadSymbol: file suffix and bar length', () => {
  it('reads NAME.5m.json with 5m partial-bar rules, NAME.json untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fno-5m-'));
    const t0 = Date.parse('2026-03-10T09:15:00+05:30');
    const mk = (n: number, step: number, px: number) => Array.from({ length: n }, (_, k) => ({ timestamp: new Date(t0 + k * step).toISOString(), open: px, high: px + 1, low: px - 1, close: px, volume: 10 }));
    // fetchedAt 09:31: the 09:25 5m bar has closed (09:30), the 09:30 one has not; only the 09:15 15m bar has closed.
    const fetchedAt = new Date(t0 + 16 * 60 * 1000).toISOString();
    writeFileSync(join(dir, 'X.json'), JSON.stringify({ name: 'X', fetchedAt, bars: mk(3, M15, 200) }));
    writeFileSync(join(dir, 'X.5m.json'), JSON.stringify({ name: 'X.5m', fetchedAt, bars: mk(4, M5, 100) }));
    const spec = { symbol: 'X', exchange: 'NSE' as const, priceFile: 'X', futuresPrice: false };
    const l15 = loadSymbol(dir, spec)!;
    const l5 = loadSymbol(dir, spec, { barMs: M5, fileSuffix: '.5m' })!;
    expect(l15.barMs).toBeUndefined();
    expect(l15.series.bars.map((b) => b.close)).toEqual([200]);
    expect(l5.barMs).toBe(M5);
    expect(l5.series.bars.map((b) => b.time)).toEqual([t0, t0 + M5, t0 + 2 * M5]);
    expect(l5.droppedPartial).toBe(1);
  });
});

describe('STRUCTURE_5M strategy', () => {
  const loaded = structureSymbol5m();

  it('the fixture\'s 15m pool series is its 5m series aggregated', () => {
    const p = loaded.poolSeries!;
    expect(p.bars.length * 3).toBe(loaded.series.bars.length);
    for (let k = 0; k < p.bars.length; k++) {
      const three = loaded.series.bars.slice(3 * k, 3 * k + 3);
      expect(Math.max(...three.map((b) => b.high))).toBeCloseTo(p.bars[k].high, 9);
      expect(Math.min(...three.map((b) => b.low))).toBeCloseTo(p.bars[k].low, 9);
    }
  });

  it('setups read from the session-end replay equal a replay at the confirming 5m bar', () => {
    let checked = 0;
    for (const variant of STRUCTURE_5M_VARIANTS) {
      for (let i = 0; i < loaded.series.bars.length; i++) {
        for (const st of confirmedAt(loaded, i, variant)) {
          const atC = evaluateStructureSessionMTF(loaded.poolSeries!, loaded.series, i, variant).setups.find((x) => x.id === st.id)!;
          expect(atC.stage).toBe('CONFIRMED');
          expect({ entry: atC.entry, stop: atC.stop, t1: atC.t1, zone: atC.zone, extreme: atC.sweep.extreme, pool: atC.pool }).toEqual({
            entry: st.entry,
            stop: st.stop,
            t1: st.t1,
            zone: st.zone,
            extreme: st.sweep.extreme,
            pool: st.pool,
          });
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    // A full replay per confirmed setup: ~5s on a loaded machine, past vitest's default.
  }, 30_000);

  it('replays as 5m LIMIT orders resting 24 bars, filled at the setup entry', () => {
    expect(STRUCTURE_5M_STRATEGY.toOrder(sessionSetups(loaded, 1, STRUCTURE_5M_VARIANTS[0]).find((s) => s.entry != null && s.t1 != null)!).fillWithinBars).toBe(STRUCTURE_RULES_5M.fillWithinBars);
    const { trades, unfilled } = replayStrategy(loaded, STRUCTURE_5M_STRATEGY, STRUCTURE_5M_VARIANTS[0], W);
    expect(trades.length + unfilled.length).toBeGreaterThan(0);
    for (const t of trades) {
      expect(t.fill?.price).toBe(t.signal.entry);
      expect(t.fill!.barsWaited).toBeLessThanOrEqual(24);
      expect(t.grossR).toBeGreaterThanOrEqual(-1.0001);
      expect((Date.parse(t.decidedAt) - Date.parse('2026-01-01')) % M5).toBe(0);
    }
  });

  it('refuses a symbol without a 15m pool series', () => {
    const { poolSeries: _p, ...bare } = loaded;
    expect(() => STRUCTURE_5M_STRATEGY.evaluate(bare as LoadedSymbol, 10, STRUCTURE_5M_VARIANTS[0])).toThrow(/poolSeries/);
  });
});
