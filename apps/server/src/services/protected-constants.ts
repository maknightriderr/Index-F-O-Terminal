// ============================================================
// PROTECTED TRADING CONSTANTS
// ============================================================
// The machine-readable list of every live trading constant that the
// data-integrity and observability work is forbidden to touch.
//
// WHY THIS IS A MODULE AND NOT PROSE
//
// The previous report claimed "18 live constants byte-identical" above a
// table that listed 16 rows. The test had 18 entries and derived its count
// correctly; the write-up's table was maintained separately and drifted. A
// count that is typed by hand next to a list that is maintained by hand will
// eventually disagree, and the disagreement looks exactly like the thing the
// check exists to rule out.
//
// So there is now ONE list. The verification iterates it, the count is
// `PROTECTED_CONSTANTS.length`, and any report renders one row per entry.
// Nothing anywhere states a number that is not derived from this array.
//
// Pure and dependency-free so a test can load it without a database pool.
//
// Nothing here is read by the trading engine. Adding an entry does not
// change behaviour; it only widens what is checked.
// ============================================================

export interface ProtectedConstant {
  /** The exact source text that must still be present, byte for byte. */
  needle: string;
  /** Repo-relative file the needle must appear in. */
  file: string;
  /** What the constant governs, in the language of the trading rules. */
  label: string;
}

export const PROTECTED_CONSTANTS: readonly ProtectedConstant[] = [
  // ---- session and cooldown gates ----
  { needle: 'SETUP_OPENING_GUARD_MINUTES = 60', file: 'apps/server/src/services/market-bias.ts', label: 'opening-hour guard' },
  { needle: 'MIN_SETUP_CONFIDENCE = 75', file: 'apps/server/src/services/market-bias.ts', label: 'confidence floor' },
  { needle: 'POST_LOSS_SETTLE_MINUTES = 15', file: 'apps/server/src/services/market-bias.ts', label: 'post-loss cooldown' },
  { needle: 'POST_LOSS_MIN_CONFIDENCE = 80', file: 'apps/server/src/services/market-bias.ts', label: 'post-loss confidence floor' },
  { needle: 'MAX_SAME_DIRECTION_LOSSES_PER_DAY = 2', file: 'apps/server/src/services/market-bias.ts', label: 'two-direction lock' },
  { needle: 'SL_COOLDOWN_SECONDS = 60 * 60', file: 'apps/server/src/services/market-bias.ts', label: 'same symbol/side cooldown' },

  // ---- setup geometry ----
  { needle: 'MIN_RISK_REWARD = 1.5', file: 'packages/analytics/src/trade-setup/index.ts', label: 'reward:risk requirement' },
  { needle: 'MIN_STOP_ATR = 2', file: 'packages/analytics/src/trade-setup/index.ts', label: 'stop ATR floor' },
  { needle: 'MAX_TARGET_ATR = 6', file: 'packages/analytics/src/trade-setup/index.ts', label: 'target ATR ceiling' },
  { needle: 'MAX_ATM_SPREAD_PCT = 5', file: 'packages/analytics/src/trade-setup/index.ts', label: 'spread limit' },
  { needle: 'MIN_SL_PREMIUM_PCT = 0.15', file: 'packages/analytics/src/trade-setup/index.ts', label: 'stop-loss floor' },
  { needle: 'MAX_SL_PREMIUM_PCT = 0.45', file: 'packages/analytics/src/trade-setup/index.ts', label: 'stop-loss ceiling' },

  // ---- circuit breakers ----
  { needle: 'maxDailyLossR: 3', file: 'apps/server/src/services/risk-circuit-breaker.ts', label: 'circuit breaker: daily loss' },
  { needle: 'maxConsecutiveStops: 3', file: 'apps/server/src/services/risk-circuit-breaker.ts', label: 'circuit breaker: consecutive stops' },
  { needle: 'maxTradesPerDay: 6', file: 'apps/server/src/services/risk-circuit-breaker.ts', label: 'circuit breaker: trade count' },
  { needle: 'maxOpenPositions: 4', file: 'apps/server/src/services/risk-circuit-breaker.ts', label: 'circuit breaker: open exposure' },

  // ---- trade health / time stop ----
  { needle: 'DEAD_CHECK_MINUTES = 30', file: 'apps/server/src/services/trade-health.ts', label: 'trade-health DEAD window' },
  { needle: 'DEAD_PROGRESS_ATR = 0.25', file: 'apps/server/src/services/trade-health.ts', label: 'trade-health DEAD threshold' },
] as const;

/**
 * The count. Derived, never typed.
 *
 * Any report stating how many constants were checked must read this, so the
 * stated number and the rendered table cannot drift apart again.
 */
export const PROTECTED_CONSTANT_COUNT = PROTECTED_CONSTANTS.length;

/** The files the audit touches, deduplicated — useful for a reader checking coverage. */
export function protectedConstantFiles(): string[] {
  return [...new Set(PROTECTED_CONSTANTS.map((c) => c.file))].sort();
}

export interface ProtectedConstantResult extends ProtectedConstant {
  present: boolean;
}

/**
 * Verifies every entry against source text supplied by the caller.
 *
 * Takes a reader rather than doing its own file IO so it stays pure and the
 * failure path can be tested against constructed sources.
 */
export function auditProtectedConstants(read: (file: string) => string): {
  total: number;
  present: number;
  changed: ProtectedConstantResult[];
  results: ProtectedConstantResult[];
  holds: boolean;
  detail: string;
} {
  const results = PROTECTED_CONSTANTS.map((c) => ({ ...c, present: read(c.file).includes(c.needle) }));
  const changed = results.filter((r) => !r.present);
  return {
    total: results.length,
    present: results.length - changed.length,
    changed,
    results,
    holds: changed.length === 0,
    detail:
      changed.length === 0
        ? `all ${results.length} protected constants byte-identical`
        : changed.map((c) => `CHANGED: ${c.label} (${c.needle}) in ${c.file}`).join(' | '),
  };
}
