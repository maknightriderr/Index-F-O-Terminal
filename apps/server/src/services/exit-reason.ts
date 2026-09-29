// ============================================================
// EXIT REASON — one explicit vocabulary for how a SIMULATED trade ended
// ============================================================
// This is a paper-trading system. Every "exit" here is simulated against a
// stop/target level; no order was placed and no fill happened.
//
// Two places already decide how a trade ended, each in its own terms:
//
//   - missed-winner-audit gradeDecision() replays the UNDERLYING against
//     ATR-scaled stop/target levels and records hit_target / hit_stop.
//   - the live sticky-setup path closes a paper position with a
//     TradeCloseReason (TARGET, STOP_LOSS, SESSION_ENDED, BIAS_REVERSED...).
//
// Neither was expressed as an exit reason a report could group by. These
// two pure functions make that explicit without changing either decision.
// ============================================================

export type ExitReason = 'TARGET' | 'STOP' | 'TIME_EXIT' | 'EXPIRY' | 'INVALIDATED' | 'MANUAL_TEST_EXIT' | 'OTHER';

export const EXIT_REASONS: readonly ExitReason[] = ['TARGET', 'STOP', 'TIME_EXIT', 'EXPIRY', 'INVALIDATED', 'MANUAL_TEST_EXIT', 'OTHER'] as const;

/**
 * gradeDecision()'s truth table, made explicit.
 *
 *   hit_stop  hit_target  ->  exit_reason
 *   false     false           TIME_EXIT   (the grading horizon ran out first)
 *   false     true            TARGET
 *   true      false           STOP
 *   true      true            STOP        (a bar spanning both is scored as
 *                                          the stop — gradeDecision's own
 *                                          conservative rule; it never sets
 *                                          both, but the mapping is total)
 */
export function exitReasonFromGrade(hitTarget: boolean, hitStop: boolean): ExitReason {
  if (hitStop) return 'STOP';
  if (hitTarget) return 'TARGET';
  return 'TIME_EXIT';
}

/** A live paper close's TradeCloseReason, in the same vocabulary. */
export function exitReasonFromCloseReason(closeReason: string | null | undefined): ExitReason {
  switch (closeReason) {
    case 'TARGET':
      return 'TARGET';
    case 'STOP_LOSS':
    case 'TRAILING_STOP':
    case 'BREAKEVEN_STOP':
      return 'STOP';
    case 'SESSION_ENDED':
    case 'TIME_STOP':
    case 'TRADE_DECAY':
      return 'TIME_EXIT';
    case 'BIAS_REVERSED':
    case 'LEVEL_RECLAIMED':
    case 'TRIGGER_REVERSAL':
    case 'SWEEP_RECLAIMED':
    case 'SETUP_INVALIDATED':
    case 'THESIS_INVALIDATED':
    case 'IV_COLLAPSE':
    case 'LIQUIDITY_DETERIORATION':
      return 'INVALIDATED';
    case 'MANUAL_EXIT':
      // A person closed a paper position by hand — a test exit, not a fill.
      return 'MANUAL_TEST_EXIT';
    default:
      return 'OTHER';
  }
}
