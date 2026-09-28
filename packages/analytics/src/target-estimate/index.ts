// ============================================================
// TARGET ESTIMATE v2 (Phase 2 — shadow only)
// ============================================================
// The live target is first-order only (buildNakedLong):
//
//     deltaMove = |delta| x expectedMovePoints
//     target    = entry + deltaMove
//
// That ignores two things every long option has: convexity (gamma adds
// premium as the move extends in the holder's favour) and time decay (theta
// is paid over the hold whether or not the move arrives). This computes the
// second-order estimate from Greeks already on the chain leg:
//
//     gammaTerm   = 0.5 x |gamma| x M^2          (M = underlying move, points)
//     thetaDecay  = |theta per day| x holdHours / 24
//     targetV2    = entry + deltaMove + gammaTerm - thetaDecay
//
// The gamma term is the standard Taylor term, 0.5 x gamma x (dS)^2, with dS
// the UNDERLYING move. (The Phase 2 plan wrote it as 0.5 x gamma x
// deltaMove^2; deltaMove is already in premium points, so squaring it would
// scale gamma by delta^2 and be dimensionally wrong. The underlying move is
// what gamma is defined against.) The theta convention — per-day theta
// pro-rated over the expected hold in hours — is the same one
// option-quality's thetaCostOverHold already uses.
//
// SHADOW ONLY. The live target and stop are not changed. The expected net R
// uses the live entry, the live stop, and the live path's own cost model
// (estimateRoundTripCost), so it differs from the live net R only through the
// target.
// ============================================================

import { estimateRoundTripCost } from '../trade-setup/index.js';

export interface TargetEstimateInput {
  /** Live entry (mid). */
  entry: number;
  stopLoss: number;
  /** The live target, for the divergence figure. */
  liveTarget: number;
  delta: number;
  gamma: number | null | undefined;
  /** Theta per day in premium points, as the chain reports it. */
  theta: number | null | undefined;
  /** The same (room-capped) underlying move the live target was projected from. */
  expectedMovePoints: number;
  expectedHoldHours: number;
  bid: number;
  ask: number;
  lotSize: number;
}

export interface TargetEstimateResult {
  shadow: true;
  deltaMove: number;
  gammaTerm: number;
  thetaDecay: number;
  shadowTargetV2: number | null;
  shadowExpectedNetRV2: number | null;
  /** shadowTargetV2 - liveTarget, in premium points. */
  targetDivergence: number | null;
  /** Which Greeks were unusable and treated as zero. */
  missing: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function estimateTargetV2(input: TargetEstimateInput): TargetEstimateResult {
  const missing: string[] = [];
  const move = Math.max(input.expectedMovePoints, 0);
  const absDelta = Number.isFinite(input.delta) ? Math.abs(input.delta) : 0;
  if (!Number.isFinite(input.delta)) missing.push('delta');

  // Identical to buildNakedLong's deltaMove.
  const deltaMove = absDelta * move;

  const gamma = input.gamma != null && Number.isFinite(input.gamma) ? Math.abs(input.gamma) : null;
  if (gamma == null) missing.push('gamma');
  const gammaTerm = gamma != null ? 0.5 * gamma * move * move : 0;

  const thetaPerDay = input.theta != null && Number.isFinite(input.theta) ? Math.abs(input.theta) : null;
  if (thetaPerDay == null) missing.push('theta');
  const thetaDecay = thetaPerDay != null && input.expectedHoldHours > 0 ? thetaPerDay * (input.expectedHoldHours / 24) : 0;

  if (!(input.entry > 0)) {
    return { shadow: true, deltaMove: round2(deltaMove), gammaTerm: round2(gammaTerm), thetaDecay: round2(thetaDecay), shadowTargetV2: null, shadowExpectedNetRV2: null, targetDivergence: null, missing };
  }

  const shadowTargetV2 = round2(input.entry + deltaMove + gammaTerm - thetaDecay);

  const cost = estimateRoundTripCost(input.entry, input.bid, input.ask, input.lotSize).perUnit;
  const denom = input.entry - input.stopLoss + cost;
  const shadowExpectedNetRV2 = denom > 0 ? round2((shadowTargetV2 - input.entry - cost) / denom) : null;

  return {
    shadow: true,
    deltaMove: round2(deltaMove),
    gammaTerm: round2(gammaTerm),
    thetaDecay: round2(thetaDecay),
    shadowTargetV2,
    shadowExpectedNetRV2,
    targetDivergence: round2(shadowTargetV2 - input.liveTarget),
    missing,
  };
}
