// ============================================================
// Structure strategy on the harness — equivalence and mechanics
// ============================================================
// The harness reads "setups confirmed on bar i" from ONE engine replay per
// session (at its last bar) for speed. That is only legitimate if it equals
// replaying at i: checked here on a seeded synthetic series, setup by setup.
// ============================================================

import { describe, it, expect } from 'vitest';
import { evaluateStructureSession, STRUCTURE_VARIANTS } from '@fno/analytics';
import { replayStrategy, statsOf } from '../harness.js';
import { confirmedAt, isFalsePositive, sessionSetups, STRUCTURE_STRATEGY, countSetups } from '../structure-backtest.js';
import { structureSymbol } from './fixtures/synthetic.js';

const W = { from: '2026-01-01', to: '2026-12-31' };

describe('structure strategy', () => {
  const loaded = structureSymbol();

  it('setups read from the session-end replay equal a replay at the confirming bar', () => {
    let checked = 0;
    for (const variant of STRUCTURE_VARIANTS) {
      for (let i = 0; i < loaded.series.bars.length; i++) {
        for (const st of confirmedAt(loaded, i, variant)) {
          const atC = evaluateStructureSession(loaded.series, i, variant).setups.find((x) => x.id === st.id)!;
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
  });

  it('replays as LIMIT orders: every trade filled at its setup entry with R bounded by the conservative rules', () => {
    const variant = STRUCTURE_VARIANTS[1];
    const { trades, unfilled } = replayStrategy(loaded, STRUCTURE_STRATEGY, variant, W);
    expect(trades.length + unfilled.length).toBeGreaterThan(0);
    for (const t of trades) {
      expect(t.fill?.price).toBe(t.signal.entry);
      expect(t.grossR).toBeGreaterThanOrEqual(-1.0001);
      if (t.exit === 'TARGET') expect(t.grossR).toBeGreaterThanOrEqual(1.5 - 1e-9);
      expect(['STOP', 'TARGET', 'SWEEP_RECLAIMED', 'SESSION_END']).toContain(t.exit);
    }
    const s = statsOf(trades);
    expect(s.trades).toBe(trades.length);
    expect(trades.filter(isFalsePositive).every((t) => t.exit === 'STOP')).toBe(true);
    const all = loaded.series.sessionDates.flatMap((_, s2) => sessionSetups(loaded, s2, variant));
    const c = countSetups(all);
    expect(c.sweeps).toBeGreaterThanOrEqual(c.confirmedOrLater);
  });
});
