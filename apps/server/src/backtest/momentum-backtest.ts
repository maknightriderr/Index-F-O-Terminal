// ============================================================
// MOMENTUM-BREAK BACKTEST (pure)
// ============================================================
// Replays the snapshots written by fetch-history.ts bar by bar through the
// same detector the live engine runs (@fno/analytics momentum-break), with
// no look-ahead: the detector sees bars up to and including the closed
// trigger bar, entry is that bar's close, and the grading walks only the
// bars after it (gradePath, the missed-winner audit's own loop).
//
// Live session rules applied: the 60-minute opening guard, the 60-minute
// closing guard (against each date's real close, so MCX's 23:30/23:55 DST
// switch is honoured), and one open trade per symbol at a time. Exits:
// stop (wins ties), target, a 15m close back through the broken level
// (LEVEL_RECLAIMED), or the session's last bar. 0.1R is deducted per trade.
//
// Data hygiene (documented in the report, not tuned):
//   - bars that had not closed when the snapshot was taken are dropped;
//   - bars outside the exchange session window are dropped;
//   - THIN sessions (< half the symbol's median bar count — half-day
//     sessions, and the sparse final weeks of an illiquid expiring MCX
//     contract) take no entries;
//   - ROLL sessions on a stitched futures price series take no entries,
//     nor does the session after. A roll date is where the stitched
//     near-month hands over: session volume at least ROLL_VOLUME_JUMP× the
//     previous full session's (the expiring contract drains, the new one
//     trades). It is masked when the inter-session gap on that date exceeds
//     ROLL_GAP_ATR × ATR — the plan's rule.
//
// The loop, the loading and the statistics now live in harness.ts (shared
// with the structure backtest); this module is the momentum-break STRATEGY
// on it plus the names the momentum CLI and tests have always imported. The
// replay is unchanged — momentum-harness-refactor.test.ts holds that.
// ============================================================

import {
  evaluateMomentumBreak,
  isLevelReclaimed,
  MOMENTUM_BREAK_VARIANTS,
  type MomentumBreakSignal,
  type MomentumBreakVariant,
} from '@fno/analytics';
import {
  replayStrategy,
  type BacktestStrategy,
  type BacktestTrade as HarnessTrade,
  type LoadedSymbol,
  type ReplayWindow,
} from './harness.js';

export {
  COST_R,
  OPENING_GUARD_MIN,
  CLOSING_GUARD_MIN,
  THIN_SESSION_FRACTION,
  ROLL_VOLUME_JUMP,
  ROLL_GAP_ATR,
  BACKTEST_SYMBOLS,
  readSnapshot,
  borrowVolume,
  loadSymbol,
  sessionMasks,
  statsOf,
  groupStats,
  GO_LIVE_BAR,
  SYMBOL_MIN_OOS_TRADES,
  passesGoLiveBar,
  allowedSymbols,
  splitDate,
  chooseVariant,
} from './harness.js';
export type { SymbolSpec, LoadedSymbol, ReplayWindow, TradeStats, ExitKind } from './harness.js';

export type BacktestTrade = HarnessTrade<MomentumBreakSignal>;

/** Momentum-break as a harness strategy: a MARKET entry at the trigger bar's close. */
export const MOMENTUM_STRATEGY: BacktestStrategy<MomentumBreakVariant, MomentumBreakSignal> = {
  name: 'MOMENTUM_BREAK',
  orderType: 'MARKET',
  variants: MOMENTUM_BREAK_VARIANTS,
  evaluate: (loaded, i, variant) => evaluateMomentumBreak(loaded.series, i, variant).signal,
  toOrder: (signal) => ({ direction: signal.direction, type: 'MARKET', entry: signal.entry, stop: signal.stop, target: signal.target }),
  invalidateOnClose: (signal) => (b) => isLevelReclaimed(signal.direction, signal.levelPrice, b.close),
  invalidationExit: 'LEVEL_RECLAIMED',
  openingGuard: () => true,
  groupKeys: {
    'By level type': (t) => t.signal.levelKind,
    'By decision hour (IST)': (t) => String(t.hour).padStart(2, '0'),
    'By direction': (t) => t.signal.direction,
    'By exit': (t) => t.exit,
  },
};

/**
 * One symbol, one variant, one period. Entries only on non-masked sessions
 * inside the window; a trade can run to its own session's end.
 */
export function replaySymbol(loaded: LoadedSymbol, variant: MomentumBreakVariant, window: ReplayWindow): BacktestTrade[] {
  return replayStrategy(loaded, MOMENTUM_STRATEGY, variant, window).trades;
}
