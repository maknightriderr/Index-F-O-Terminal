// ============================================================
// OPENING-HOUR ENVIRONMENT CLASSIFIER (Phase 3 — observational, spec §15)
// ============================================================
// SETUP_OPENING_GUARD_MINUTES (market-bias.ts) already refuses every
// INTRADAY setup in the session's first hour — the measured evidence is that
// those entries lost 7.5R across 20 trades while everything after made
// money. That gate is UNCHANGED here and this file cannot touch it.
//
// What the opening hour has never had is any breakdown of WHAT KIND of open
// it was. classifyRegime() already computes everything needed to say that —
// ADX, a volatility z-score, and fresh-breakout flags — this just re-labels
// those same already-computed readings for the opening-hour context
// specifically, using the exact thresholds classifyRegime() itself uses
// (ADX 18/25, atrZ ±1), so a "high volatility" open here means the same
// thing "HIGH_VOLATILITY" means anywhere else in the engine.
//
// Pure, like the rest of the diagnostics layer: no I/O, reads nothing but
// its input, decides nothing, gates nothing. It is written here as its own
// module (rather than inline in market-bias.ts) purely because the plan
// asked for it as a unit test surface — the labelling logic has no
// out-of-sample validation yet, so per the project's own standing rule
// (validate a factor against forward outcomes before it becomes a filter)
// it is recorded and watched, not acted on.
// ============================================================

export type OpeningEnvironment =
  | 'OPENING_BREAKOUT'
  | 'OPENING_REVERSAL'
  | 'OPENING_RANGE'
  | 'HIGH_VOLATILITY_CHOP'
  | 'LOW_VOLATILITY_CHOP';

export interface OpeningClassifierInput {
  /** Minutes since the session opened, from the same minutesSinceSessionOpen() the live gate uses. Null off-hours. */
  minutesSinceOpen: number | null;
  /** classifyRegime()'s own adxValue input. */
  adxValue: number;
  /** classifyRegime()'s own atrZ (atrPctZ) input. */
  atrZ: number;
  /** classifyRegime()'s own freshBreakoutUp input. */
  freshBreakoutUp: boolean;
  /** classifyRegime()'s own freshBreakoutDown input. */
  freshBreakoutDown: boolean;
}

/**
 * Same ADX floor classifyRegime() uses for a trend read at all (its
 * WEAK_BULL_TREND/WEAK_BEAR_TREND band). Reused rather than re-picked so
 * "trending" means the same thing here as it does everywhere else in the
 * engine.
 */
const TREND_ADX_FLOOR = 18;

/**
 * Labels the opening-hour environment from readings classifyRegime() already
 * computes. Returns null outside the opening window (no minutes-since-open,
 * or at/after `openingGuardMinutes` — by which point this is no longer "the
 * opening", it's just the session). Pass SETUP_OPENING_GUARD_MINUTES as
 * `openingGuardMinutes` so this always agrees with the live gate's own
 * definition of the window; never hold a second copy of that constant here.
 */
export function classifyOpeningEnvironment(input: OpeningClassifierInput, openingGuardMinutes: number): OpeningEnvironment | null {
  const { minutesSinceOpen, adxValue, atrZ, freshBreakoutUp, freshBreakoutDown } = input;
  if (minutesSinceOpen == null || minutesSinceOpen < 0 || minutesSinceOpen >= openingGuardMinutes) return null;

  // A volume-confirmed break in the opening window — the exact same signal
  // classifyRegime() reads as BREAKOUT/BREAKDOWN, just named for the opening
  // context.
  if (freshBreakoutUp || freshBreakoutDown) return 'OPENING_BREAKOUT';

  // Elevated realised range (atrZ > 1) with no breakout confirmed:
  //   - a trend read already present (ADX >= 18, classifyRegime's own floor)
  //     without a fresh break means the open moved and gave part of it back
  //     rather than continuing — the opening whipsaw/reversal case.
  //   - no trend read at all is range expansion with no direction to it —
  //     chop, not a read anyone should trade off.
  if (atrZ > 1) {
    return adxValue >= TREND_ADX_FLOOR ? 'OPENING_REVERSAL' : 'HIGH_VOLATILITY_CHOP';
  }

  // Compressed range (atrZ < -1) — the open hasn't moved enough yet to read
  // anything from; classifyRegime's own LOW_VOLATILITY band.
  if (atrZ < -1) return 'LOW_VOLATILITY_CHOP';

  // Neither elevated nor compressed range, no breakout — an ordinary,
  // undramatic open.
  return 'OPENING_RANGE';
}
