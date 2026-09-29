// ============================================================
// F&O TRADE VALIDATION — the caller's half (Part A, flag FNO_VALIDATION)
// ============================================================
// buildTradeSetup (packages/analytics) enforces the rules it can see from one
// leg: the round-trip cost ceiling and the stop outside the underlying's
// noise. This module owns the parts that need the whole chain:
//
//   1. the strike, chosen by |delta| band (selectStrikeByDelta) instead of
//      chain.atmStrike — no eligible strike refuses OPTION_DELTA_OUT_OF_BAND;
//   2. the IV cap on the target move is computed by the family's own
//      contextFor(chain) (consensus only — a structural target has no IV);
//   5. the expiry fallback: a 0-DTE contract that fails rule 1, 3 or 4 is
//      re-validated on the next expiry's chain; both failing refuses with the
//      most specific reason.
//
// Pure apart from the injected fetchNextExpiry, so it is tested without a
// broker. Flag off = build(primary, primary.atmStrike), exactly the old call.
// ============================================================

import { selectStrikeByDelta } from '@fno/analytics';
import type { OptionChain, OptionType, TradeSetup, TradeSetupFnoValidation } from '@fno/shared';
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

/**
 * One chain: pick the strike by delta band, build on it, and fold what the
 * builder recorded into the full record.
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
  const leg = sel.strike != null ? chain.strikes.find((s) => s.strike === sel.strike) : null;
  const chosenLeg = leg ? (side === 'CE' ? leg.call : leg.put) : null;
  const strikeSelection: TradeSetupFnoValidation['strikeSelection'] = {
    method: 'DELTA_BAND',
    band: [params.deltaMin, params.deltaMax],
    selectedStrike: sel.strike,
    atmStrike: chain.atmStrike,
    delta: sel.candidate?.delta ?? null,
    moneyness: chosenLeg?.moneyness ?? null,
    candidatesEvaluated: sel.candidates.length,
    eligible: sel.eligible,
  };

  let setup: TradeSetup;
  if (sel.strike == null) {
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
    setup = build(chain, sel.strike, context);
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
