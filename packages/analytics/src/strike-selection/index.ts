// ============================================================
// SHADOW STRIKE SELECTION (Phase 2 — shadow only)
// ============================================================
// The live engine always trades the ATM strike: buildNakedLong looks up
// `strikes.find(s => s.strike === atmStrike)` and discards every other strike
// in the chain window, even though the chain already carries bid/ask, OI,
// volume, IV and Greeks for all of them.
//
// This module scores those discarded candidates and names the one it WOULD
// have picked. It is SHADOW ONLY:
//
//   - the caller passes the chain it already fetched; no new API call, and no
//     expiry is ever requested that the live path did not already request;
//   - its result is persisted next to the live decision and read by the
//     shadow-vs-live comparison report, and by nothing else;
//   - the live `atmStrike` passed to buildTradeSetup is untouched.
//
// Nothing here is new scoring logic. The tradeability score IS the existing
// option-quality assessment (assessOptionQuality), the estimated option
// response IS its delta x expected-move figure (the same math as
// buildNakedLong's deltaMove), and the spread filter IS the existing
// MAX_ATM_SPREAD_PCT ceiling — applied to each candidate exactly as the live
// path applies it to the ATM leg. No new threshold is introduced.
// ============================================================

import type { OptionChainStrike, OptionType } from '@fno/shared';
import { assessOptionQuality, type OptionQualityGrade } from '../option-quality/index.js';
import { MAX_ATM_SPREAD_PCT } from '../trade-setup/index.js';

export interface StrikeSelectionInput {
  /** The chain window the live path already fetched (chain.strikes). */
  strikes: OptionChainStrike[];
  /** The strike the live path actually trades (chain.atmStrike). */
  liveStrike: number;
  /** CE for a bullish read, PE for a bearish one — same mapping as buildTradeSetup. */
  side: OptionType;
  /** The expiry these strikes belong to. The chain carries exactly one. */
  expiry: string | null;
  /** The same (room-capped) move the live target was projected from, in underlying points. */
  expectedMovePoints: number;
  dte: number;
  expectedHoldHours: number;
  ivRank?: number | null;
  hvPct?: number | null;
  tickSize?: number;
}

export interface StrikeCandidate {
  strike: number;
  expiry: string | null;
  isLive: boolean;
  /** Premium the candidate would be sized from — bid-ask mid, else LTP (same rule as the live path). */
  entryPremium: number | null;
  /** Delta x expected move, in premium points (assessOptionQuality's expectedPremiumGain). */
  estimatedOptionResponse: number | null;
  /** estimatedOptionResponse / entryPremium — the move's payoff per rupee of premium. */
  responsePerPremium: number | null;
  /** assessOptionQuality score, 0-100. */
  tradeabilityScore: number | null;
  grade: OptionQualityGrade | null;
  spreadPct: number | null;
  delta: number | null;
  /** Why this candidate could not be selected, or null when it was eligible. */
  rejectedReason: string | null;
}

export interface ShadowStrikeSelection {
  shadow: true;
  side: OptionType;
  liveStrike: number;
  /** The strike the scorer would have picked; null when no candidate was eligible. */
  selectedStrike: number | null;
  /** The selected candidate's tradeability score. */
  selectionScore: number | null;
  selectionReason: string;
  differsFromLive: boolean | null;
  /** Every candidate that was evaluated but not selected, with why. */
  rejectedAlternatives: StrikeCandidate[];
  candidatesEvaluated: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function evaluateCandidate(row: OptionChainStrike, input: StrikeSelectionInput): StrikeCandidate {
  const leg = input.side === 'CE' ? row.call : row.put;
  const base: StrikeCandidate = {
    strike: row.strike,
    expiry: input.expiry,
    isLive: row.strike === input.liveStrike,
    entryPremium: null,
    estimatedOptionResponse: null,
    responsePerPremium: null,
    tradeabilityScore: null,
    grade: null,
    spreadPct: null,
    delta: leg?.delta ?? null,
    rejectedReason: null,
  };

  // The same refusals buildNakedLong applies to the ATM leg, in the same order.
  if (!leg || !(leg.ltp > 0)) return { ...base, rejectedReason: 'NO_QUOTE' };
  if (!Number.isFinite(leg.delta) || Math.abs(leg.delta) > 1) return { ...base, rejectedReason: 'DELTA_OUT_OF_RANGE' };

  const hasQuote = leg.bid > 0 && leg.ask > 0;
  const mid = hasQuote ? (leg.bid + leg.ask) / 2 : leg.ltp;
  const spreadPct = hasQuote ? ((leg.ask - leg.bid) / mid) * 100 : null;
  const entryPremium = round2(mid);

  const quality = assessOptionQuality({
    entryPremium,
    bid: leg.bid,
    ask: leg.ask,
    volume: leg.volume,
    openInterest: leg.oi,
    delta: leg.delta,
    theta: leg.theta,
    iv: leg.iv,
    ivRank: input.ivRank ?? null,
    hvPct: input.hvPct ?? null,
    dte: input.dte,
    distanceFromSpot: Math.abs(row.distanceFromSpot ?? 0),
    expectedMovePoints: input.expectedMovePoints,
    expectedHoldHours: input.expectedHoldHours,
    tickSize: input.tickSize ?? 0.05,
    moneyness: leg.moneyness,
    greeksSource: leg.greeksSource,
  });

  const response = quality.expectedPremiumGain;
  const evaluated: StrikeCandidate = {
    ...base,
    entryPremium,
    estimatedOptionResponse: response,
    responsePerPremium: response != null && entryPremium > 0 ? round2(response / entryPremium) : null,
    tradeabilityScore: quality.tradeable ? quality.score : null,
    grade: quality.grade,
    spreadPct: spreadPct != null ? round2(spreadPct) : null,
  };

  if (spreadPct != null && spreadPct > MAX_ATM_SPREAD_PCT) return { ...evaluated, rejectedReason: 'WIDE_SPREAD' };
  if (!quality.tradeable) return { ...evaluated, rejectedReason: `UNTRADEABLE: ${quality.refusalReason ?? 'option quality floor'}` };
  if (!(response != null && response > 0)) return { ...evaluated, rejectedReason: 'NO_PROJECTED_RESPONSE' };
  return evaluated;
}

// ============================================================
// LIVE STRIKE BY DELTA BAND (Part A rule 1, flag FNO_VALIDATION)
// ============================================================
// Not shadow: with the flag on, the server trades the strike this returns in
// place of chain.atmStrike. It reuses evaluateCandidate above, so a candidate
// has to pass exactly the refusals the live ATM leg always had (quote, delta
// range, the MAX_ATM_SPREAD_PCT ceiling, the option-quality liquidity floors,
// a positive projected response) and then sit inside the |delta| band.
// Ordered by nearness of |delta| to the target; ties by tighter spread, then
// by nearness to the rounded ATM strike. The first eligible candidate wins.

export interface DeltaBandInput extends StrikeSelectionInput {
  deltaMin: number;
  deltaMax: number;
  deltaTarget: number;
}

export interface DeltaBandSelection {
  /** The strike to trade, or null when no candidate is eligible. */
  strike: number | null;
  candidate: StrikeCandidate | null;
  /** Every candidate with why it was not chosen (OUT_OF_BAND, WIDE_SPREAD, ...). */
  candidates: StrikeCandidate[];
  eligible: number;
  reason: string;
}

export function selectStrikeByDelta(input: DeltaBandInput): DeltaBandSelection {
  const candidates = input.strikes.map((row) => {
    const c = evaluateCandidate(row, input);
    if (c.rejectedReason != null) return c;
    const abs = Math.abs(c.delta ?? 0);
    return abs >= input.deltaMin && abs <= input.deltaMax ? c : { ...c, rejectedReason: `OUT_OF_BAND (|delta| ${round2(abs)})` };
  });
  const eligible = candidates.filter((c) => c.rejectedReason == null);
  eligible.sort(
    (a, b) =>
      Math.abs(Math.abs(a.delta ?? 0) - input.deltaTarget) - Math.abs(Math.abs(b.delta ?? 0) - input.deltaTarget) ||
      (a.spreadPct ?? 0) - (b.spreadPct ?? 0) ||
      Math.abs(a.strike - input.liveStrike) - Math.abs(b.strike - input.liveStrike)
  );
  const best = eligible[0] ?? null;
  const band = `${input.deltaMin}-${input.deltaMax}`;
  const atm = candidates.find((c) => c.isLive);
  const reason = best
    ? `${input.side} ${best.strike} chosen at delta ${best.delta?.toFixed(2)} (band ${band}, closest to ${input.deltaTarget}); ${eligible.length} eligible of ${candidates.length} strikes.`
    : `No ${input.side} strike of ${input.expiry ?? 'this expiry'} has |delta| in ${band} with a tradeable quote — ${candidates.length} evaluated` +
      (atm ? `; the rounded ATM ${atm.strike} ${atm.rejectedReason ? `was rejected (${atm.rejectedReason})` : ''}` : '') +
      '.';
  return { strike: best?.strike ?? null, candidate: best, candidates, eligible: eligible.length, reason };
}

/**
 * Ranks eligible candidates by tradeability score (the existing option-quality
 * score), breaking ties by response per rupee of premium, then by nearness to
 * the live strike. Pure; reads nothing but its input.
 */
export function scoreStrikeCandidates(input: StrikeSelectionInput): ShadowStrikeSelection {
  const candidates = input.strikes.map((row) => evaluateCandidate(row, input));
  const eligible = candidates.filter((c) => c.rejectedReason == null);

  eligible.sort(
    (a, b) =>
      (b.tradeabilityScore ?? -1) - (a.tradeabilityScore ?? -1) ||
      (b.responsePerPremium ?? -1) - (a.responsePerPremium ?? -1) ||
      Math.abs(a.strike - input.liveStrike) - Math.abs(b.strike - input.liveStrike)
  );

  const best = eligible[0] ?? null;
  const live = candidates.find((c) => c.isLive) ?? null;

  const rejectedAlternatives = candidates
    .filter((c) => c !== best)
    .map((c) => (c.rejectedReason == null ? { ...c, rejectedReason: 'LOWER_SCORE' } : c));

  let selectionReason: string;
  if (!best) {
    selectionReason = `No eligible ${input.side} candidate among ${candidates.length} strikes in the fetched window.`;
  } else if (best.isLive) {
    selectionReason = `The live ATM strike ${best.strike} already scores highest (tradeability ${best.tradeabilityScore}) among ${eligible.length} eligible of ${candidates.length} candidates.`;
  } else {
    selectionReason =
      `${input.side} ${best.strike} scores ${best.tradeabilityScore} (${best.grade?.toLowerCase()}) against the live ATM ${input.liveStrike}` +
      (live?.rejectedReason ? ` (rejected: ${live.rejectedReason})` : live?.tradeabilityScore != null ? ` at ${live.tradeabilityScore}` : '') +
      `; ${eligible.length} eligible of ${candidates.length} candidates. Shadow only — the live strike is unchanged.`;
  }

  return {
    shadow: true,
    side: input.side,
    liveStrike: input.liveStrike,
    selectedStrike: best?.strike ?? null,
    selectionScore: best?.tradeabilityScore ?? null,
    selectionReason,
    differsFromLive: best ? best.strike !== input.liveStrike : null,
    rejectedAlternatives,
    candidatesEvaluated: candidates.length,
  };
}
