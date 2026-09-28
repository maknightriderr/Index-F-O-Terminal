// ============================================================
// INVALIDATION REASON (Phase 2 — live, labelling only)
// ============================================================
// A taken paper trade is closed by one of two branches, which are ALREADY
// separate and ALREADY evaluated in the right order in
// market-bias.ts resolveStickyTradeSetup (and the price-level monitor):
//
//   1. the option-premium stop/target check — first and unconditional, "so a
//      real win/loss is never masked by a same-tick direction flicker";
//   2. only if that did not fire, the underlying bias-reversal branch, with
//      its own confirm-streak debounce (close reason BIAS_REVERSED).
//
// Each branch already stamps a distinct TradeCloseReason at the point it
// fires. This names which branch that was, in the spec's vocabulary, so a
// report can ask "were losses mostly premium stops or thesis reversals?".
// No condition is added and no branch is reordered: this is a pure mapping
// of the close reason the firing branch already set.
// ============================================================

export type InvalidationReason = 'OPTION_EMERGENCY_STOP' | 'OPTION_TARGET_HIT' | 'UNDERLYING_STRUCTURAL_INVALIDATION';

export const INVALIDATION_REASONS: readonly InvalidationReason[] = [
  'OPTION_EMERGENCY_STOP',
  'OPTION_TARGET_HIT',
  'UNDERLYING_STRUCTURAL_INVALIDATION',
] as const;

/**
 * Which close branch fired, from the close reason that branch set. Null for
 * closes that are neither branch: SESSION_ENDED (day rollover) and
 * SETUP_INVALIDATED (self-heal of an implausible stored setup).
 */
export function invalidationReasonFromCloseReason(closeReason: string | null | undefined): InvalidationReason | null {
  switch (closeReason) {
    // Branch 1, premium stop side (closeReasonForPriceHit). A trailed stop is
    // still the premium-stop branch firing, whatever the P&L.
    case 'STOP_LOSS':
    case 'TRAILING_STOP':
    case 'BREAKEVEN_STOP':
      return 'OPTION_EMERGENCY_STOP';
    // Branch 1, premium target side.
    case 'TARGET':
      return 'OPTION_TARGET_HIT';
    // Branch 2.
    case 'BIAS_REVERSED':
      return 'UNDERLYING_STRUCTURAL_INVALIDATION';
    default:
      return null;
  }
}
