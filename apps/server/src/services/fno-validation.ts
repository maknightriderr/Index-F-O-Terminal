// ============================================================
// F&O TRADE VALIDATION — the caller's half (Part A, flag FNO_VALIDATION)
// ============================================================
// buildTradeSetup (packages/analytics) enforces the rules it can see from one
// leg: the round-trip cost ceiling and the stop outside the underlying's
// noise. This module owns the parts that need the whole chain:
//
//   1. the strike: EVERY strike inside the |delta| band (selectStrikeByDelta's
//      eligible set) is built through the family's own builder and ranked by
//      rankStrikeBuilds — the best AVAILABLE one is traded, so a strike that
//      fails a hard check falls through to the next. No eligible strike
//      refuses OPTION_DELTA_OUT_OF_BAND;
//   2. the IV cap on the target move is computed by the family's own
//      contextFor(chain) (consensus only — a structural target has no IV);
//   5. the expiry fallback: a 0-DTE contract that fails rule 1, 3 or 4 is
//      re-validated on the next expiry's chain; both failing refuses with the
//      most specific reason.
//
// Pure apart from the injected fetchNextExpiry, so it is tested without a
// broker. Flag off = build(primary, primary.atmStrike), exactly the old call.
// ============================================================

import { selectStrikeByDelta, MAX_ATM_SPREAD_PCT, type StrikeCandidate } from '@fno/analytics';
import type { OptionCandidate, OptionCandidateStage, OptionChain, OptionType, TradeSetup, TradeSetupFnoValidation } from '@fno/shared';
import type { GateDiagnostic } from './gate-diagnostics.js';

export const FNO_REFUSAL_CODES = ['OPTION_DELTA_OUT_OF_BAND', 'COST_TOO_HIGH', 'STOP_INSIDE_NOISE'] as const;
export type FnoRefusalCode = (typeof FNO_REFUSAL_CODES)[number];

export function isFnoRefusal(code: string | null | undefined): code is FnoRefusalCode {
  return code != null && (FNO_REFUSAL_CODES as readonly string[]).includes(code);
}

/**
 * How far into validation a refusal got. A later rule is the more specific
 * statement: "no strike in the band" says nothing about the contract that
 * would have been traded, a cost or noise refusal names that contract's own
 * flaw, and a refusal after every F&O rule passed (reward:risk, quality) is
 * about the trade itself. When both expiries fail, the higher rank is shown.
 */
export function refusalSpecificity(code: string | null | undefined): number {
  if (code === 'OPTION_DELTA_OUT_OF_BAND') return 1;
  if (code === 'COST_TOO_HIGH') return 2;
  if (code === 'STOP_INSIDE_NOISE') return 3;
  return code == null ? 0 : 4;
}

/** The next listed expiry after the chain's own, or null. */
export function nextExpiryAfter(chain: Pick<OptionChain, 'expiry' | 'availableExpiries'>): string | null {
  const later = [...(chain.availableExpiries ?? [])].filter((e) => e > chain.expiry).sort();
  return later[0] ?? null;
}

export interface FnoSelectionParams {
  deltaMin: number;
  deltaMax: number;
  deltaTarget: number;
}

/** What the family knows about a chain before building on it. */
export interface FnoChainContext {
  /** The target move the leg is projected from (already IV-capped / room-capped by the family). */
  expectedMovePoints: number;
  expectedHoldHours: number;
  ivRank: number | null;
  hvPct: number | null;
  /** Rule 2's record for this chain; null when the family's target is structural. */
  ivCap: TradeSetupFnoValidation['ivCap'];
  /**
   * The trade's invalidation distance on the UNDERLYING (points). When known,
   * strikes are compared on the R:R each would have against this same move
   * (comparableRR) — so percentage-of-premium stop rules (floors, caps,
   * expiry-day widening) cannot make a cheap OTM contract look better than
   * the ATM one. The trade itself keeps its own built stop.
   */
  underlyingStopPoints?: number | null;
}

export interface ValidatedBuild {
  setup: TradeSetup;
  /** The chain the setup was built (or finally refused) on — the next expiry's after a fallback. */
  chain: OptionChain;
  fnoValidation: TradeSetupFnoValidation | null;
}

function emptyRecord(chain: OptionChain): TradeSetupFnoValidation {
  return {
    strikeSelection: null,
    ivCap: null,
    costPct: null,
    maxCostPct: 0,
    stopUnderlyingAtr: null,
    minStopAtr: 0,
    stopWidenedForNoise: false,
    expiryFallback: false,
    primaryExpiry: chain.expiry,
    primaryRefusalCode: null,
    finalExpiry: chain.expiry,
    refusalCode: null,
  };
}

/** One in-band strike as built. */
export interface StrikeBuild {
  strike: number;
  delta: number | null;
  spreadPct: number | null;
  setup: TradeSetup;
  /** The contract's instrument token — the last tie-break (absent in older callers: ''). */
  token?: string | null;
  /** Net R:R against the common underlying invalidation (comparableNetRR); ranks in place of netRR when present. */
  comparableRR?: number | null;
}

/**
 * Net R:R of a built leg measured against the trade's UNDERLYING
 * invalidation: (target − entry − cost) / (|Δ| × underlyingStop + cost).
 * Every strike faces the same underlying risk, so only what the move really
 * pays each contract (delta, gamma, theta, cost) separates them.
 */
export function comparableNetRR(setup: TradeSetup, delta: number | null, underlyingStopPoints: number | null | undefined): number | null {
  if (!setup.available || setup.entry == null || setup.target == null || setup.estimatedCostPct == null) return null;
  if (delta == null || !Number.isFinite(delta) || !(underlyingStopPoints != null && underlyingStopPoints > 0)) return null;
  const cost = setup.entry * (setup.estimatedCostPct / 100);
  const risk = Math.abs(delta) * underlyingStopPoints + cost;
  return risk > 0 ? Math.round(((setup.target - setup.entry - cost) / risk) * 100) / 100 : null;
}

/** Net R:R after costs of a built (or R:R-planned) leg: (target − entry − cost) / (entry − SL + cost). */
export function strikeNetRR(setup: TradeSetup): number | null {
  if (setup.available && setup.entry != null && setup.stopLoss != null && setup.target != null && setup.estimatedCostPct != null) {
    const cost = setup.entry * (setup.estimatedCostPct / 100);
    const risk = setup.entry - setup.stopLoss + cost;
    return risk > 0 ? Math.round(((setup.target - setup.entry - cost) / risk) * 100) / 100 : null;
  }
  return setup.rrPlan?.riskRewardNet ?? null;
}

/**
 * PRE-REGISTERED strike ranking, identical for every engine (S1, indicator,
 * trigger families), first difference wins:
 *   1. tradeable — the builder accepted it (every hard check passed); among
 *      refusals, an R:R-only refusal (it still has a plan) first, then the
 *      most specific refusal
 *   2. net R:R after the option cost model, higher first (2 dp) — measured
 *      against the common underlying invalidation (comparableRR, OPTSEL-2.0)
 *      when the caller knows it, so premium-% stop rules cannot favour a
 *      cheap OTM contract
 *   3. execution quality — bid-ask spread % of mid, tighter first
 *   4. sensitivity — |delta| nearest the target delta
 *   5. premium risk — entry − SL per unit, smaller first
 *   6. target potential — (target − entry) / entry, larger first
 *   7. strike nearest the rounded ATM, then the lower strike, then the
 *      instrument token (a total order: the input order never matters)
 * Never "nearest ATM", "cheapest" or "highest delta" on its own.
 */
export function rankStrikeBuilds(builds: readonly StrikeBuild[], deltaTarget: number, atmStrike: number): StrikeBuild[] {
  // Tradeable first (every genuine check passed). Live builds never refuse for
  // R:R (rrGate: false), so net R:R below only RANKS; an R:R refusal can only
  // come from a caller that keeps the builder's gate on (research).
  const tier = (b: StrikeBuild) => (b.setup.available ? 0 : b.setup.rrPlan ? 1 : 2);
  const levels = (b: StrikeBuild) => (b.setup.available ? b.setup : b.setup.rrPlan ?? null);
  const nz = (v: number | null | undefined, worst: number) => (v == null || !Number.isFinite(v) ? worst : v);
  return [...builds].sort((a, b) => {
    const la = levels(a);
    const lb = levels(b);
    return (
      tier(a) - tier(b) ||
      (tier(a) === 2 ? refusalSpecificity(b.setup.noTradeCode) - refusalSpecificity(a.setup.noTradeCode) : 0) ||
      nz(b.comparableRR ?? strikeNetRR(b.setup), -Infinity) - nz(a.comparableRR ?? strikeNetRR(a.setup), -Infinity) ||
      nz(a.spreadPct, Infinity) - nz(b.spreadPct, Infinity) ||
      Math.abs(Math.abs(nz(a.delta, 0)) - deltaTarget) - Math.abs(Math.abs(nz(b.delta, 0)) - deltaTarget) ||
      nz(la ? la.entry! - la.stopLoss! : null, Infinity) - nz(lb ? lb.entry! - lb.stopLoss! : null, Infinity) ||
      nz(lb && lb.entry! > 0 ? (lb.target! - lb.entry!) / lb.entry! : null, -Infinity) - nz(la && la.entry! > 0 ? (la.target! - la.entry!) / la.entry! : null, -Infinity) ||
      Math.abs(a.strike - atmStrike) - Math.abs(b.strike - atmStrike) ||
      a.strike - b.strike ||
      (a.token ?? '').localeCompare(b.token ?? '')
    );
  });
}

// ---------------- the OptionCandidate pipeline record (Phase 3) ----------------

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The pipeline stage a builder refusal belongs to (NET_RR only for a caller that keeps the research R:R gate). */
export function stageOfRefusal(code: string | null | undefined): OptionCandidateStage {
  switch (code) {
    case 'NO_QUOTE':
    case 'NO_CHAIN':
      return 'AVAILABILITY';
    case 'LOW_OPTION_LIQUIDITY':
    case 'POOR_OPTION_QUALITY':
      return 'LIQUIDITY';
    case 'WIDE_SPREAD':
    case 'COST_TOO_HIGH':
      return 'SPREAD';
    case 'OPTION_DELTA_OUT_OF_BAND':
      return 'DELTA';
    case 'STOP_INSIDE_NOISE':
      return 'PREMIUM_RISK';
    case 'UNREALISTIC_TARGET':
    case 'COST_EXCEEDS_EDGE':
      return 'TARGET_POTENTIAL';
    case 'REWARD_RISK_TOO_LOW':
      return 'NET_RR';
    default:
      return 'BUILD';
  }
}

/**
 * The first stage a strike failed before any build, in pipeline order
 * (availability → liquidity → spread → delta → target potential). The
 * selector short-circuits in its own order, so the stage is read from what it
 * measured: a wide-spread strike whose liquidity also failed is reported at
 * LIQUIDITY (the earlier stage).
 */
export function preBuildRejection(c: Pick<StrikeCandidate, 'rejectedReason' | 'grade' | 'spreadPct'>): { stage: OptionCandidateStage; reason: string } | null {
  const r = c.rejectedReason;
  if (r == null) return null;
  if (r === 'NO_QUOTE') return { stage: 'AVAILABILITY', reason: 'No live quote (no LTP) for this contract.' };
  if (c.grade === 'UNTRADEABLE' || r.startsWith('UNTRADEABLE')) return { stage: 'LIQUIDITY', reason: r };
  if (r === 'WIDE_SPREAD') return { stage: 'SPREAD', reason: `Bid-ask spread ${c.spreadPct ?? '?'}% of mid is above the ${MAX_ATM_SPREAD_PCT}% ceiling.` };
  if (r === 'DELTA_OUT_OF_RANGE') return { stage: 'DELTA', reason: 'Delta missing or outside ±1 — unreliable Greeks.' };
  if (r.startsWith('OUT_OF_BAND')) return { stage: 'DELTA', reason: r };
  if (r === 'NO_PROJECTED_RESPONSE') return { stage: 'TARGET_POTENTIAL', reason: 'No projected premium response to the expected move.' };
  return { stage: 'BUILD', reason: r };
}

/**
 * Pure: EVERY strike of the side through the pipeline, best first — the
 * ranked builds (the first available one SELECTED, other available ones
 * RANKED, refusals REJECTED at their stage), then the pre-build rejections in
 * strike order. Net R:R is recorded and ranks; it never rejects.
 */
export function optionCandidatesOf(args: { chain: OptionChain; side: OptionType; candidates: readonly StrikeCandidate[]; ranked: readonly StrikeBuild[] }): OptionCandidate[] {
  const { chain, side, candidates, ranked } = args;
  const legOf = (strike: number) => {
    const row = chain.strikes.find((s) => s.strike === strike);
    return side === 'CE' ? row?.call ?? null : row?.put ?? null;
  };
  const out: OptionCandidate[] = [];
  let rank = 0;
  let selected = false;
  for (const b of ranked) {
    const leg = legOf(b.strike);
    const levels = b.setup.available ? b.setup : b.setup.rrPlan ?? null;
    const entry = levels?.entry ?? null;
    const sel = b.setup.available && !selected;
    if (sel) selected = true;
    const rejected = !b.setup.available;
    out.push({
      side,
      strike: b.strike,
      token: b.token ?? leg?.token ?? null,
      expiry: chain.expiry ?? null,
      delta: b.delta,
      spreadPct: b.spreadPct,
      premium: entry,
      premiumRisk: levels && levels.entry != null && levels.stopLoss != null ? r2(levels.entry - levels.stopLoss) : null,
      targetPotential: levels && levels.entry != null && levels.target != null && levels.entry > 0 ? r2((levels.target - levels.entry) / levels.entry) : null,
      netRR: strikeNetRR(b.setup),
      comparableRR: b.comparableRR ?? null,
      status: rejected ? 'REJECTED' : sel ? 'SELECTED' : 'RANKED',
      rank: rejected ? null : ++rank,
      rejectedAt: rejected ? stageOfRefusal(b.setup.noTradeCode) : null,
      rejectionReason: rejected ? `${b.setup.noTradeCode ?? 'REFUSED'}: ${b.setup.reason}` : null,
    });
  }
  const built = new Set(ranked.map((b) => b.strike));
  const pre = candidates.filter((c) => !built.has(c.strike) && c.rejectedReason != null).sort((a, b) => a.strike - b.strike);
  for (const c of pre) {
    const rej = preBuildRejection(c)!;
    out.push({
      side,
      strike: c.strike,
      token: legOf(c.strike)?.token ?? null,
      expiry: chain.expiry ?? null,
      delta: c.delta,
      spreadPct: c.spreadPct,
      premium: c.entryPremium,
      premiumRisk: null,
      targetPotential: null,
      netRR: null,
      comparableRR: null,
      status: 'REJECTED',
      rank: null,
      rejectedAt: rej.stage,
      rejectionReason: rej.reason,
    });
  }
  return out;
}

/**
 * One chain: build EVERY strike in the delta band, rank the builds
 * (rankStrikeBuilds) and take the best — the first available one, else the
 * best refusal — then fold what the builder recorded into the full record.
 */
export function validateOnChain(args: {
  chain: OptionChain;
  side: OptionType;
  params: FnoSelectionParams;
  context: FnoChainContext;
  build: (chain: OptionChain, strike: number, context: FnoChainContext) => TradeSetup;
}): ValidatedBuild {
  const { chain, side, params, context, build } = args;
  const sel = selectStrikeByDelta({
    strikes: chain.strikes,
    liveStrike: chain.atmStrike,
    side,
    expiry: chain.expiry,
    expectedMovePoints: context.expectedMovePoints,
    dte: chain.dte,
    expectedHoldHours: context.expectedHoldHours,
    ivRank: context.ivRank,
    hvPct: context.hvPct,
    tickSize: 0.05,
    deltaMin: params.deltaMin,
    deltaMax: params.deltaMax,
    deltaTarget: params.deltaTarget,
  });
  // Every in-band strike, built through the family's own builder, ranked.
  const inBand = sel.candidates.filter((c) => c.rejectedReason == null);
  const tokenOf = (strike: number) => {
    const row = chain.strikes.find((s) => s.strike === strike);
    return (side === 'CE' ? row?.call?.token : row?.put?.token) ?? null;
  };
  const ranked = rankStrikeBuilds(
    inBand.map((c) => {
      const setup = build(chain, c.strike, context);
      return { strike: c.strike, delta: c.delta ?? null, spreadPct: c.spreadPct ?? null, setup, token: tokenOf(c.strike), comparableRR: comparableNetRR(setup, c.delta ?? null, context.underlyingStopPoints) };
    }),
    params.deltaTarget,
    chain.atmStrike
  );
  const best = ranked[0] ?? null;
  const leg = best ? chain.strikes.find((s) => s.strike === best.strike) : null;
  const chosenLeg = leg ? (side === 'CE' ? leg.call : leg.put) : null;
  const strikeSelection: TradeSetupFnoValidation['strikeSelection'] = {
    method: 'BEST_OF_BAND',
    band: [params.deltaMin, params.deltaMax],
    selectedStrike: best?.strike ?? null,
    atmStrike: chain.atmStrike,
    delta: best?.delta ?? null,
    moneyness: chosenLeg?.moneyness ?? null,
    candidatesEvaluated: sel.candidates.length,
    eligible: sel.eligible,
    ranking: ranked.map((r) => ({ strike: r.strike, delta: r.delta, spreadPct: r.spreadPct, available: r.setup.available, code: r.setup.available ? null : r.setup.noTradeCode ?? null, netRR: strikeNetRR(r.setup) })),
    optionCandidates: optionCandidatesOf({ chain, side, candidates: sel.candidates, ranked }),
  };

  let setup: TradeSetup;
  if (best == null) {
    const reason = `F&O validation: ${sel.reason} A contract far from 0.5 delta pays for the stop without responding to the move, so no strike is forced.`;
    setup = {
      available: false,
      noTradeCode: 'OPTION_DELTA_OUT_OF_BAND',
      reason,
      contractValidation: {
        tradeable: false,
        refusalReason: reason,
        checks: sel.candidates.map((c) => ({ strike: c.strike, delta: c.delta, spreadPct: c.spreadPct, rejectedReason: c.rejectedReason })),
      },
    };
  } else {
    setup = best.setup;
  }
  const code = setup.available ? null : setup.noTradeCode ?? null;
  const record: TradeSetupFnoValidation = {
    ...emptyRecord(chain),
    ...(setup.fnoValidation ?? {}),
    strikeSelection,
    ivCap: context.ivCap,
    primaryExpiry: chain.expiry,
    finalExpiry: chain.expiry,
    refusalCode: isFnoRefusal(code) ? code : null,
  };
  return { setup: { ...setup, fnoValidation: record }, chain, fnoValidation: record };
}

/**
 * The whole rule. Disabled: the old call on chain.atmStrike, no record.
 * Enabled: validate on the primary chain; a 0-DTE F&O refusal re-validates on
 * the next expiry; both failing refuses with the more specific reason.
 */
export async function buildWithFnoValidation(args: {
  enabled: boolean;
  primary: OptionChain;
  side: OptionType;
  params: FnoSelectionParams;
  contextFor: (chain: OptionChain) => FnoChainContext;
  build: (chain: OptionChain, strike: number, context: FnoChainContext) => TradeSetup;
  fetchNextExpiry: (expiry: string) => Promise<OptionChain | null>;
  /** Failures are logged by the caller; the fallback is then treated as unavailable. */
  onError?: (stage: 'FETCH_NEXT_EXPIRY', err: unknown) => void;
}): Promise<ValidatedBuild> {
  const { enabled, primary, side, params, contextFor, build, fetchNextExpiry, onError } = args;
  if (!enabled) {
    return { setup: build(primary, primary.atmStrike, contextFor(primary)), chain: primary, fnoValidation: null };
  }

  const first = validateOnChain({ chain: primary, side, params, context: contextFor(primary), build });
  const firstCode = first.setup.available ? null : first.setup.noTradeCode ?? null;
  if (first.setup.available || !isFnoRefusal(firstCode) || primary.dte !== 0) return first;

  // Rule 5: the expiring contract failed an F&O rule — try the next expiry.
  const nextExpiry = nextExpiryAfter(primary);
  let next: OptionChain | null = null;
  if (nextExpiry) {
    try {
      next = await fetchNextExpiry(nextExpiry);
    } catch (err) {
      onError?.('FETCH_NEXT_EXPIRY', err);
      next = null;
    }
  }
  if (!next || !(next.strikes?.length > 0)) {
    const note = ` The next expiry${nextExpiry ? ` (${nextExpiry})` : ''} could not be priced, so there was no fallback contract.`;
    const record = { ...first.fnoValidation!, expiryFallback: false, primaryRefusalCode: firstCode };
    return { ...first, setup: { ...first.setup, reason: `${first.setup.reason}${note}`, fnoValidation: record }, fnoValidation: record };
  }

  const second = validateOnChain({ chain: next, side, params, context: contextFor(next), build });
  const secondCode = second.setup.available ? null : second.setup.noTradeCode ?? null;
  const fallbackRecord = (base: TradeSetupFnoValidation, finalChain: OptionChain): TradeSetupFnoValidation => ({
    ...base,
    expiryFallback: true,
    primaryExpiry: primary.expiry,
    primaryRefusalCode: firstCode,
    finalExpiry: finalChain.expiry,
  });

  if (second.setup.available) {
    const record = fallbackRecord(second.fnoValidation!, next);
    const note = `Expiry fallback: the 0-DTE ${primary.expiry} contract failed F&O validation (${firstCode}), so the ${next.expiry} expiry is traded instead. `;
    return { setup: { ...second.setup, reason: `${note}${second.setup.reason}`, fnoValidation: record }, chain: next, fnoValidation: record };
  }

  // Both failed. Show the more specific reason; ties go to the later expiry (the one that would have been traded).
  const useSecond = refusalSpecificity(secondCode) >= refusalSpecificity(firstCode);
  const chosen = useSecond ? second : first;
  const chosenChain = useSecond ? next : primary;
  const record = fallbackRecord(chosen.fnoValidation!, chosenChain);
  const note = `Both expiries fail: the 0-DTE ${primary.expiry} contract (${firstCode}) and the next expiry ${next.expiry} (${secondCode}). `;
  return { setup: { ...chosen.setup, reason: `${note}${chosen.setup.reason}`, fnoValidation: record }, chain: chosenChain, fnoValidation: record };
}

/** The FNO_VALIDATION gate-diagnostics row: FAIL when an F&O rule refused, PASS when the contract passed, NOT_EVALUATED otherwise. */
export function fnoValidationDiagnostic(args: {
  enabled: boolean;
  record: TradeSetupFnoValidation | null;
  params: Record<string, number>;
  at: number;
}): GateDiagnostic {
  const { enabled, record, params, at } = args;
  if (!enabled || record == null) {
    return {
      gate: 'FNO_VALIDATION',
      status: 'NOT_EVALUATED',
      reason: !enabled ? 'FNO_VALIDATION flag is off.' : 'The decision was settled before a contract was validated.',
      threshold: params,
      input_values: { enforced: enabled },
      timestamp: at,
      was_deciding_gate: false,
    };
  }
  const failed = record.refusalCode != null;
  return {
    gate: 'FNO_VALIDATION',
    status: failed ? 'FAIL' : 'PASS',
    reason: failed ? `${record.refusalCode}${record.expiryFallback ? ` (after expiry fallback ${record.primaryExpiry} → ${record.finalExpiry})` : ''}` : null,
    threshold: params,
    input_values: { enforced: true, ...record },
    timestamp: at,
    was_deciding_gate: failed,
  };
}
