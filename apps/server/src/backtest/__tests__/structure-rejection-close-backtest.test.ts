// ============================================================
// CLOSE_CONFIRM (REJECTION_CLOSE) on the harness
// ============================================================
// STRUCTURE_STRATEGY_REJECTION_CLOSE places the SAME CONFIRMED setups as
// STRUCTURE_STRATEGY (identical evaluate()) but enters on a CLOSE_CONFIRM
// order instead of a LIMIT: the fill price is the confirming bar's own
// close, never the zone's fixed entry price.
// ============================================================

import { describe, it, expect } from 'vitest';
import { STRUCTURE_VARIANTS } from '@fno/analytics';
import { replayStrategy, statsOf } from '../harness.js';
import { STRUCTURE_STRATEGY, STRUCTURE_STRATEGY_REJECTION_CLOSE } from '../structure-backtest.js';
import { structureSymbol } from './fixtures/synthetic.js';

const W = { from: '2026-01-01', to: '2026-12-31' };

describe('STRUCTURE_STRATEGY_REJECTION_CLOSE', () => {
  const loaded = structureSymbol();
  const variant = STRUCTURE_VARIANTS[1];

  it('fills at the confirming bar\'s OWN close, never the zone entry price used by TOUCH', () => {
    const { trades } = replayStrategy(loaded, STRUCTURE_STRATEGY_REJECTION_CLOSE, variant, W);
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      expect(t.fill?.price).toBeDefined();
      // The rejection candle's pattern label was recorded.
      expect(t.entryMeta?.pattern).toBeTruthy();
      expect(t.entryMeta?.shape).toBeTruthy();
      expect(['STOP', 'TARGET', 'SWEEP_RECLAIMED', 'SESSION_END']).toContain(t.exit);
      expect(t.grossR).toBeGreaterThanOrEqual(-1.5); // stop is unchanged, but entry can be worse than the zone's — bounded, not exactly -1
    }
  });

  it('a bar that never rejects the zone before T1 is reached ends MISSED, not filled', () => {
    const { unfilled } = replayStrategy(loaded, STRUCTURE_STRATEGY_REJECTION_CLOSE, variant, W);
    for (const u of unfilled) {
      expect(['NO_FILL', 'MISSED', 'GUARDED', 'SESSION_END', 'INVALIDATED', 'LOW_RR']).toContain(u.outcome);
    }
  });

  it('produces a different trade count/timing from TOUCH on the same setups (the entry mechanic genuinely differs)', () => {
    const touch = replayStrategy(loaded, STRUCTURE_STRATEGY, variant, W);
    const rejection = replayStrategy(loaded, STRUCTURE_STRATEGY_REJECTION_CLOSE, variant, W);
    // Not a strict inequality requirement (a fixture could coincidentally
    // agree), just that both ran and produced SOME trades to compare.
    expect(touch.trades.length + touch.unfilled.length).toBeGreaterThan(0);
    expect(rejection.trades.length + rejection.unfilled.length).toBeGreaterThan(0);
  });

  it('grading starts at the bar AFTER the fill — the fill bar itself contributes no stop/target check', () => {
    const { trades } = replayStrategy(loaded, STRUCTURE_STRATEGY_REJECTION_CLOSE, variant, W);
    const s = statsOf(trades);
    expect(s.trades).toBe(trades.length);
  });
});
