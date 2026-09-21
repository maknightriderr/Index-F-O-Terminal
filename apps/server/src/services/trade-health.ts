// ============================================================
// TRADE HEALTH
// ============================================================
// Answers one question, continuously, for an open position: is this trade
// actually working? Pure functions with no I/O, so they can be unit-tested
// and run identically in the live monitor and in a backtest.
//
// The core reading comes from the recorded trades (24 Aug - 17 Sep, 102
// reconstructed against the underlying's 5-minute candles):
//
//   favourable move by 30 min     trades   total R   avg R
//   under 0.25 ATR                    11     -9.8     -0.89
//   0.25 ATR or more                  41     +7.9     +0.19
//
// The same split holds at 0.5 ATR (-0.42R) and 0.75 ATR (-0.40R), so it is a
// slope rather than a knife-edge. Winners had already travelled a median
// 2.09 ATR by 30 minutes; trades that went on to stop out had 0.18. A trade
// that has not started working inside half an hour does not start later.
//
// Expected progress uses sqrt(time): price travel scales with the square
// root of elapsed time, so a trade one quarter of the way through its
// horizon is "on schedule" at half its target, not a quarter of it.
//
// NOTHING here closes a position yet. The engine records what it WOULD do
// (see TradeHealthAssessment.wouldExit) so the decision can be judged
// against real outcomes before it is given control.
// ============================================================

export type TradeHealthState = 'DEVELOPING' | 'HEALTHY' | 'WEAKENING' | 'FAILED' | 'DEAD';

/** Minutes before a trade is judged at all — below this, everything is DEVELOPING. */
export const HEALTH_GRACE_MINUTES = 15;
/** The evidence threshold: no meaningful progress by this point means dead. */
export const DEAD_CHECK_MINUTES = 30;
export const DEAD_PROGRESS_ATR = 0.25;
/** Progress relative to the sqrt-time schedule: at or above is healthy, below the lower bound is weakening. */
export const HEALTHY_PROGRESS_RATIO = 0.7;
export const WEAKENING_PROGRESS_RATIO = 0.3;

export interface TradeHealthInput {
  /** Minutes since entry. */
  elapsedMinutes: number;
  /** Minutes this trade realistically has — the rest of the session for intraday. */
  horizonMinutes: number;
  /** Best favourable underlying move so far, in ATR. */
  mfeAtr: number | null;
  /** Where the underlying is right now versus entry, in ATR (negative = against). */
  currentProgressAtr: number | null;
  /** How far the target is, in ATR. */
  targetAtr: number | null;
  /** Current premium as a fraction of entry premium (1 = flat, 1.2 = +20%). */
  premiumRatio: number | null;
  /** True when the bias engine has already declared the thesis dead. */
  thesisInvalidated?: boolean;
}

export interface TradeHealthAssessment {
  state: TradeHealthState;
  /** 0-100, how the trade is tracking against its own schedule. Not a probability. */
  score: number;
  expectedProgressAtr: number | null;
  progressRatio: number | null;
  /** What a time-stop would do right now, and why. Shadow only. */
  wouldExit: boolean;
  reason: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Where a trade should be by now if it were going to reach its target within
 * its horizon. Square-root of elapsed time, the same scaling the expected-move
 * maths uses.
 */
export function expectedProgressAtr(elapsedMinutes: number, horizonMinutes: number, targetAtr: number | null): number | null {
  if (targetAtr == null || !(targetAtr > 0) || !(horizonMinutes > 0)) return null;
  const fraction = clamp(elapsedMinutes / horizonMinutes, 0, 1);
  return targetAtr * Math.sqrt(fraction);
}

export function assessTradeHealth(input: TradeHealthInput): TradeHealthAssessment {
  const { elapsedMinutes, horizonMinutes, mfeAtr, currentProgressAtr, targetAtr, premiumRatio, thesisInvalidated } = input;

  if (thesisInvalidated) {
    return { state: 'FAILED', score: 0, expectedProgressAtr: null, progressRatio: null, wouldExit: true, reason: 'Thesis invalidated — the read that minted this trade no longer holds.' };
  }

  const expected = expectedProgressAtr(elapsedMinutes, horizonMinutes, targetAtr);
  const best = mfeAtr ?? 0;
  const ratio = expected != null && expected > 0 ? best / expected : null;

  if (elapsedMinutes < HEALTH_GRACE_MINUTES) {
    return {
      state: 'DEVELOPING',
      score: 50,
      expectedProgressAtr: expected,
      progressRatio: ratio,
      wouldExit: false,
      reason: `${Math.round(elapsedMinutes)} minutes in — too early to judge; a trade is given ${HEALTH_GRACE_MINUTES} minutes before it is assessed.`,
    };
  }

  // The measured rule: no meaningful progress by DEAD_CHECK_MINUTES.
  if (elapsedMinutes >= DEAD_CHECK_MINUTES && best < DEAD_PROGRESS_ATR) {
    return {
      state: 'DEAD',
      score: 5,
      expectedProgressAtr: expected,
      progressRatio: ratio,
      wouldExit: true,
      reason:
        `${Math.round(elapsedMinutes)} minutes in and the best favourable move is ${best.toFixed(2)} ATR, under the ${DEAD_PROGRESS_ATR} ATR mark. ` +
        `Trades in that state went on to lose 0.89R on average across the recorded history, against +0.19R for those that had moved.`,
    };
  }

  // Premium already in profit is the strongest single signal that it works.
  if (premiumRatio != null && premiumRatio > 1.05) {
    return {
      state: 'HEALTHY',
      score: clamp(Math.round(60 + (premiumRatio - 1) * 200), 60, 100),
      expectedProgressAtr: expected,
      progressRatio: ratio,
      wouldExit: false,
      reason: `Premium is ${((premiumRatio - 1) * 100).toFixed(0)}% above entry and the underlying has travelled ${best.toFixed(2)} ATR in favour.`,
    };
  }

  if (ratio == null) {
    return {
      state: 'DEVELOPING',
      score: 50,
      expectedProgressAtr: expected,
      progressRatio: null,
      wouldExit: false,
      reason: 'No ATR or target reference available for this trade — health cannot be scored, so it is left alone.',
    };
  }

  if (ratio >= HEALTHY_PROGRESS_RATIO) {
    return {
      state: 'HEALTHY',
      score: clamp(Math.round(50 + ratio * 40), 50, 100),
      expectedProgressAtr: expected,
      progressRatio: ratio,
      wouldExit: false,
      reason: `On schedule: ${best.toFixed(2)} ATR travelled against ${expected!.toFixed(2)} expected by now.`,
    };
  }

  if (ratio >= WEAKENING_PROGRESS_RATIO) {
    const drifting = currentProgressAtr != null && currentProgressAtr < 0;
    return {
      state: 'WEAKENING',
      score: clamp(Math.round(20 + ratio * 40), 10, 50),
      expectedProgressAtr: expected,
      progressRatio: ratio,
      wouldExit: false,
      reason:
        `Behind schedule: ${best.toFixed(2)} ATR against ${expected!.toFixed(2)} expected` +
        (drifting ? `, and the underlying is currently ${Math.abs(currentProgressAtr!).toFixed(2)} ATR the wrong side of entry.` : '.'),
    };
  }

  return {
    state: 'WEAKENING',
    score: clamp(Math.round(ratio * 40), 5, 30),
    expectedProgressAtr: expected,
    progressRatio: ratio,
    wouldExit: false,
    reason: `Well behind schedule: ${best.toFixed(2)} ATR against ${expected!.toFixed(2)} expected by now, but it has not yet failed the ${DEAD_PROGRESS_ATR} ATR test.`,
  };
}

// --- Excursion tracking -----------------------------------------------------
// Recorded on every open position so the next review measures rather than
// reconstructs. Kept small: this is written to Redis alongside the setup.

export interface TradeExcursion {
  /** The underlying's price when the trade was minted, and the ATR it was judged against. */
  underlyingEntry: number | null;
  atrAtEntry: number | null;
  /** Best and worst PREMIUM seen since entry, and when. */
  premiumMfe: number;
  premiumMae: number;
  premiumMfeAt: number | null;
  premiumMaeAt: number | null;
  /** Best and worst UNDERLYING move since entry, in points, signed so positive is favourable. */
  underlyingMfe: number;
  underlyingMae: number;
  /** Minutes from entry to each R milestone on the premium. */
  timeTo025R: number | null;
  timeTo05R: number | null;
  timeTo1R: number | null;
  /** Minutes from entry to the best premium seen. */
  timeToMfe: number | null;
  updatedAt: number;
}

export function emptyExcursion(underlyingEntry: number | null, atrAtEntry: number | null, entryPremium: number): TradeExcursion {
  return {
    underlyingEntry,
    atrAtEntry,
    premiumMfe: entryPremium,
    premiumMae: entryPremium,
    premiumMfeAt: null,
    premiumMaeAt: null,
    underlyingMfe: 0,
    underlyingMae: 0,
    timeTo025R: null,
    timeTo05R: null,
    timeTo1R: null,
    timeToMfe: null,
    updatedAt: Date.now(),
  };
}

export interface ExcursionUpdate {
  excursion: TradeExcursion;
  /** True when something actually moved — the caller only writes to Redis then. */
  changed: boolean;
}

/**
 * Folds one observation into the running excursion record. `bullish` is the
 * option side's own direction (a put gains when the underlying falls), so
 * underlying moves are stored already signed in the trade's favour.
 */
export function updateExcursion(
  current: TradeExcursion,
  observation: { premium: number | null; underlying: number | null; entryPremium: number; initialStop: number | null; bullish: boolean; at: number; generatedAt: number },
): ExcursionUpdate {
  const { premium, underlying, entryPremium, initialStop, bullish, at, generatedAt } = observation;
  const next: TradeExcursion = { ...current };
  let changed = false;
  const minutes = Math.max(0, Math.round((at - generatedAt) / 60000));

  if (premium != null && premium > 0) {
    if (premium > next.premiumMfe) {
      next.premiumMfe = premium;
      next.premiumMfeAt = at;
      next.timeToMfe = minutes;
      changed = true;
    }
    if (premium < next.premiumMae) {
      next.premiumMae = premium;
      next.premiumMaeAt = at;
      changed = true;
    }
    const risk = initialStop != null ? entryPremium - initialStop : null;
    if (risk != null && risk > 0) {
      const rMultiple = (premium - entryPremium) / risk;
      if (next.timeTo025R == null && rMultiple >= 0.25) { next.timeTo025R = minutes; changed = true; }
      if (next.timeTo05R == null && rMultiple >= 0.5) { next.timeTo05R = minutes; changed = true; }
      if (next.timeTo1R == null && rMultiple >= 1) { next.timeTo1R = minutes; changed = true; }
    }
  }

  if (underlying != null && underlying > 0 && next.underlyingEntry != null && next.underlyingEntry > 0) {
    const move = bullish ? underlying - next.underlyingEntry : next.underlyingEntry - underlying;
    if (move > next.underlyingMfe) { next.underlyingMfe = move; changed = true; }
    if (-move > next.underlyingMae) { next.underlyingMae = -move; changed = true; }
  }

  if (changed) next.updatedAt = at;
  return { excursion: next, changed };
}

/** Favourable underlying excursion in ATR — the number the health rule is measured in. */
export function mfeInAtr(excursion: TradeExcursion | undefined): number | null {
  if (!excursion || !excursion.atrAtEntry || !(excursion.atrAtEntry > 0)) return null;
  return excursion.underlyingMfe / excursion.atrAtEntry;
}
