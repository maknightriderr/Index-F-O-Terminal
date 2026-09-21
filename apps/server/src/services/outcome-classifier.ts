// ============================================================
// OUTCOME CLASSIFICATION
// ============================================================
// How a refused setup is graded once the market has answered.
//
// Pure, and in its own module rather than inside the audit service, for two
// reasons. It is the piece with the actual judgement in it — everything else
// in the audit is fetching candles and writing rows — so it is the piece
// that needs testing in isolation. And the audit service opens a database
// pool at import time, which a unit test should not have to stand up just to
// ask whether a 1.5R refusal counts as a missed winner.
// ============================================================

export type OutcomeClass = 'GOOD_REJECTION' | 'MISSED_WINNER' | 'MISSED_LOSER' | 'NEUTRAL' | 'TAKEN' | 'UNKNOWN';

/**
 * Below this favourable excursion, in R, a refused setup neither ran nor
 * failed. Refusing it gave up nothing worth counting, so it is NEUTRAL
 * rather than being scored as a win for the filter — a filter should not get
 * credit for declining trades that were never going anywhere.
 */
export const NEUTRAL_BAND_R = 0.25;

/**
 * Grades one decision against what the market did afterwards.
 *
 * `settledR` is where the thesis finished: at its stop, at its target, or at
 * its final mark if neither was reached inside the horizon. `mfeR` is the
 * furthest it ever ran in favour.
 *
 * The two are separate on purpose. A refusal that ran 1.8R in favour and
 * then gave it all back settled at nothing — but a real trade with a target
 * sitting in front of it would have taken the money, so refusing it did cost
 * something and it counts as a missed winner. The same excursion ending in a
 * loss does not: the trade would have been stopped before the give-back
 * mattered, and the filter was right.
 */
export function classifyOutcome(decision: string, settledR: number, mfeR: number): OutcomeClass {
  if (decision === 'TAKE') return 'TAKEN';

  // Cleanly profitable: the filter cost real money.
  if (settledR >= 1) return 'MISSED_WINNER';

  // Cleanly negative: the filter saved real money.
  if (settledR <= -0.5) return 'GOOD_REJECTION';

  // Ran far enough to have paid a target, and finished positive.
  if (mfeR >= 1 && settledR > 0) return 'MISSED_WINNER';

  // Never went anywhere either way.
  if (mfeR < NEUTRAL_BAND_R && Math.abs(settledR) < 0.5) return 'NEUTRAL';

  if (settledR < 0) return 'GOOD_REJECTION';
  return 'NEUTRAL';
}
