// ============================================================
// CAPTURE QUALITY CONTRACT
// ============================================================
// What the persistence layer promises about every row it writes.
//
// The previous release inferred "missing" from a numeric zero. That was
// directionally right and contractually wrong: a numeric zero does not
// universally mean missing, and only the code that saw the raw value knows
// which it was looking at. A far-OTM gamma that genuinely rounds to zero and
// a delta returned by a model handed no price are indistinguishable at read
// time and completely distinguishable at write time.
//
// So validity is STATED here, once, by the writer — and the raw value is
// preserved alongside the interpreted one so the interpretation itself stays
// auditable.
//
// None of this is visible to the trading engine. The live `hasQuote` check
// continues to read `bid > 0` exactly as before; this layer sits strictly
// between the chain and the database.
// ============================================================

import type { OptionChainLeg } from '@fno/shared';

/**
 * Which persistence contract produced a row.
 *
 * LEGACY_ZERO_MAPPING rows stored an absent quote or a failed model as 0.
 * They are retained research data — the retention horizon is 400 days, so
 * they are not going to "age out" of anything, and a report that waits for
 * that is a report that never becomes correct. The honest alternative is to
 * state the population.
 */
export type CaptureQualityVersion = 'LEGACY_ZERO_MAPPING' | 'NULL_PRESERVING_V1';

export const CAPTURE_QUALITY_VERSION: CaptureQualityVersion = 'NULL_PRESERVING_V1';

/**
 * The instant the write contract changed, fixed and never recomputed.
 *
 * Rows written before it followed LEGACY_ZERO_MAPPING; rows after it follow
 * NULL_PRESERVING_V1. Both populations are real and neither is rewritten —
 * the cutover exists so a research query can say which contract it is
 * standing on rather than discovering the difference as an anomaly.
 *
 * This is the deploy instant of commit 88164aa, when nullIfZero reached
 * production. It is a constant rather than a lookup because a boundary that
 * moves is not a boundary.
 */
export const DATA_QUALITY_CUTOVER_AT = Date.parse('2026-09-21T16:05:00Z');

/** The pricing model these Greeks come from, named so a replay can reproduce them. */
export const GREEKS_MODEL_NAME = 'black-scholes-merton';
/**
 * Bumped whenever the pricing path changes in a way that would produce a
 * different number from the same inputs. A replay comparing across a version
 * change is comparing two different models.
 */
export const GREEKS_MODEL_VERSION = 'v1';

export interface LegQuality {
  quoteAvailable: boolean;
  depthAvailable: boolean;
  ivAvailable: boolean;
  greeksAvailable: boolean;
  /**
   * The research predicate. `usable_greek = greeks_valid`, never
   * `greek <> 0` — that comparison cannot tell a legitimate near-zero
   * measurement from a model that was handed nothing.
   */
  greeksValid: boolean;
  validityReason: string | null;
}

/**
 * States what is actually known about one chain leg.
 *
 * The rules, in the order they are applied:
 *
 *   A quote exists when the leg carries a positive last price. Without one
 *   there is nothing for a model to price against, so every Greek derived
 *   from it is an artefact whatever its numeric value.
 *
 *   Depth is never available today: the chain leg does not carry bid and ask
 *   quantities at all. That is a SOURCE limitation, recorded as one, and it
 *   is why depth quantities are NULL rather than zero.
 *
 *   IV is available when the model produced a positive implied volatility. A
 *   zero IV is not a measurement of a contract that cannot move; it is the
 *   solver failing to converge or being handed no price.
 *
 *   Greeks are VALID when a quote existed AND the model produced a non-
 *   degenerate delta. The delta test is deliberately the only numeric one:
 *   gamma, theta and vega can all legitimately be tiny far from the money,
 *   while a delta of exactly zero on a listed option cannot.
 */
export function assessLegQuality(leg: OptionChainLeg): LegQuality {
  const quoteAvailable = Number.isFinite(leg.ltp) && leg.ltp > 0;
  // The chain leg carries no depth quantities. Stated, not discovered.
  const depthAvailable = false;
  const ivAvailable = Number.isFinite(leg.iv) && leg.iv > 0;
  const greeksAvailable = [leg.delta, leg.gamma, leg.theta, leg.vega].every((g) => Number.isFinite(g));

  const reasons: string[] = [];
  if (!quoteAvailable) reasons.push('no last price, so nothing was priced against');
  if (!ivAvailable) reasons.push('implied volatility did not solve to a positive value');
  if (!greeksAvailable) reasons.push('one or more Greeks came back non-finite');
  if (quoteAvailable && greeksAvailable && leg.delta === 0) {
    reasons.push('delta is exactly zero on a listed option, which is a degenerate model output rather than a measurement');
  }

  const greeksValid = quoteAvailable && greeksAvailable && ivAvailable && leg.delta !== 0;

  return {
    quoteAvailable,
    depthAvailable,
    ivAvailable,
    greeksAvailable,
    greeksValid,
    validityReason: reasons.length > 0 ? reasons.join('; ') : null,
  };
}

/**
 * The raw leg exactly as it arrived, before the persistence layer touched
 * anything.
 *
 * Kept so the interpretation is auditable: with only the stored column there
 * is no way to tell a value the broker sent as zero from one this layer
 * converted, and the whole point of the null-preserving contract is that the
 * conversion is visible.
 */
export function rawLegValues(leg: OptionChainLeg): Record<string, unknown> {
  return {
    ltp: leg.ltp,
    bid: leg.bid,
    ask: leg.ask,
    iv: leg.iv,
    delta: leg.delta,
    gamma: leg.gamma,
    theta: leg.theta,
    vega: leg.vega,
    volume: leg.volume,
    oi: leg.oi,
    changeOi: leg.changeOi,
    greeksSource: leg.greeksSource,
  };
}

/**
 * Persists a value that is only meaningful when positive, storing absence as
 * NULL rather than as zero.
 *
 * Applied ONLY where a zero cannot be a measurement — a price, an implied
 * volatility, a spot. Open interest, change in open interest and volume keep
 * their zeros, which are real.
 *
 * Note this is now a narrower tool than it was: validity is stated by
 * `assessLegQuality`, and this only handles the storage representation. The
 * two used to be the same decision, which is what made a near-zero gamma
 * indistinguishable from a missing one.
 */
export function storeIfPositive(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(v) || v <= 0 ? null : v;
}

/**
 * Persists a signed value, storing a non-finite one as NULL.
 *
 * Deliberately does NOT drop zeros: delta, gamma, theta and vega are signed
 * and a genuine near-zero is a measurement. Whether it is usable is
 * `greeks_valid`, not the number.
 */
export function storeIfFinite(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(v) ? null : v;
}

/** Which contract a row written at this instant followed. */
export function qualityVersionAt(at: number): CaptureQualityVersion {
  return at >= DATA_QUALITY_CUTOVER_AT ? 'NULL_PRESERVING_V1' : 'LEGACY_ZERO_MAPPING';
}
