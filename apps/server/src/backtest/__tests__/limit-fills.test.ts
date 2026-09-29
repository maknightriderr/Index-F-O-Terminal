// ============================================================
// Harness LIMIT fills — conservative by construction
// ============================================================
// A toy LIMIT strategy on fabricated NSE bars: it places one bearish order
// at a chosen bar (entry 100.5, stop 101.5, target 98.5 → 1R = 1.0, T = 2R).
// ============================================================

import { describe, it, expect } from 'vitest';
import { prepareMomentumSeries, type MomentumBar } from '@fno/analytics';
import { replayStrategy, sessionMasks, COST_R, type BacktestStrategy, type LoadedSymbol } from '../harness.js';

const BAR = 15 * 60 * 1000;
const at = (hhmm: string) => Date.parse(`2026-03-10T${hhmm}:00+05:30`);
const flat = (k: number): MomentumBar => ({ time: at('09:15') + k * BAR, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000 });

function loaded(overrides: Record<number, Partial<MomentumBar>>): LoadedSymbol {
  const bars = Array.from({ length: 25 }, (_, k) => ({ ...flat(k), ...(overrides[k] ?? {}) }));
  const series = prepareMomentumSeries(bars);
  return {
    spec: { symbol: 'TOY', exchange: 'NSE', priceFile: 'TOY', futuresPrice: false },
    series,
    ...sessionMasks(series, false),
    droppedPartial: 0,
    droppedOutOfSession: 0,
    volumeCoverage: 1,
    firstBar: null,
    lastBar: null,
  };
}

interface Sig { at: number }
const toy = (signalBars: number[], openingGuard = true): BacktestStrategy<{ id: string }, Sig> => ({
  name: 'TOY',
  orderType: 'LIMIT',
  variants: [{ id: 'v' }],
  evaluate: (_l, i) => (signalBars.includes(i) ? { at: i } : null),
  toOrder: () => ({ direction: 'BEARISH', type: 'LIMIT', entry: 100.5, stop: 101.5, target: 98.5, fillWithinBars: 8 }),
  invalidateOnClose: () => (b) => b.close > 101.2,
  invalidationExit: 'SWEEP_RECLAIMED',
  openingGuard: () => openingGuard,
  groupKeys: {},
});
const W = { from: '2026-01-01', to: '2026-12-31' };

describe('LIMIT fills', () => {
  it('fills at the limit on the first touch and grades from the fill', () => {
    const l = loaded({ 8: { high: 100.6 }, 10: { low: 98.4, close: 98.6 } });
    const { trades } = replayStrategy(l, toy([6]), { id: 'v' }, W);
    expect(trades).toHaveLength(1);
    expect(trades[0].fill).toMatchObject({ price: 100.5, barsWaited: 2 });
    expect(trades[0].exit).toBe('TARGET');
    expect(trades[0].grossR).toBe(2);
    expect(trades[0].netR).toBe(2 - COST_R);
  });

  it('a fill bar that also reaches the stop is a full loss', () => {
    const l = loaded({ 8: { high: 101.6, close: 100.2 } });
    const { trades } = replayStrategy(l, toy([6]), { id: 'v' }, W);
    expect(trades[0]).toMatchObject({ exit: 'STOP', grossR: -1 });
  });

  it('the target is not credited on the fill bar (it may have printed before the fill)', () => {
    const l = loaded({ 8: { high: 100.6, low: 98.3, close: 99.0 } });
    const { trades } = replayStrategy(l, toy([6]), { id: 'v' }, W);
    expect(trades[0].exit).not.toBe('TARGET');
    expect(trades[0].exit).toBe('SESSION_END');
  });

  it('a gap through the entry still fills AT the entry, never better', () => {
    const l = loaded({ 8: { open: 101.0, high: 101.1, low: 100.9, close: 101.0 } });
    const { trades } = replayStrategy(l, toy([6]), { id: 'v' }, W);
    expect(trades[0].fill?.price).toBe(100.5);
  });

  it('the target reached before any touch is MISSED, not a trade', () => {
    const l = loaded({ 8: { low: 98.4 }, 9: { high: 100.7 } });
    const { trades, unfilled } = replayStrategy(l, toy([6]), { id: 'v' }, W);
    expect(trades).toHaveLength(0);
    expect(unfilled[0].outcome).toBe('MISSED');
  });

  it('no touch within the window is NO_FILL, and the pending window blocks other orders', () => {
    const l = loaded({ 16: { high: 100.6 } });
    const { trades, unfilled } = replayStrategy(l, toy([6, 10]), { id: 'v' }, W);
    // 6 rests through bar 14 (no touch); 10 is inside that window and never evaluated.
    expect(unfilled.map((u) => u.outcome)).toEqual(['NO_FILL']);
    expect(trades).toHaveLength(0);
  });

  it('the opening guard judges the fill: a first-hour fill is GUARDED; with the guard off it trades', () => {
    const l = loaded({ 3: { high: 100.6 } }); // bar 3 = 10:00-10:15, inside the first hour
    expect(replayStrategy(l, toy([1], true), { id: 'v' }, W).unfilled[0].outcome).toBe('GUARDED');
    expect(replayStrategy(l, toy([1], false), { id: 'v' }, W).trades).toHaveLength(1);
  });

  it('the closing guard judges the fill too', () => {
    const l = loaded({ 21: { high: 100.6 } }); // 14:30-14:45, inside the last hour
    expect(replayStrategy(l, toy([19]), { id: 'v' }, W).unfilled[0].outcome).toBe('GUARDED');
  });

  it('the invalidation close exits at that close after the fill', () => {
    const l = loaded({ 8: { high: 100.6 }, 9: { high: 101.4, close: 101.3 } });
    const { trades } = replayStrategy(l, toy([6]), { id: 'v' }, W);
    expect(trades[0]).toMatchObject({ exit: 'SWEEP_RECLAIMED', exitPrice: 101.3 });
    expect(trades[0].grossR).toBeCloseTo(-0.8, 5);
  });
});
