// ============================================================
// SIGNAL FRESHNESS — measured, never enforced (Phase 1)
// ============================================================
// Two questions nobody could answer about a setup:
//
//   1. How old were the inputs it was built from, at the instant it was
//      built? The chain and each option leg carry their own timestamps;
//      until now they were thrown away and only the decision time survived.
//
//   2. When a sticky setup locked in Redis is handed back on a LATER poll,
//      is it still the same trade? A setup minted with spot at 24,000 and
//      re-surfaced with spot at 24,300 is a different entry with the same
//      numbers on it.
//
// This module answers both and changes nothing. A stale sticky setup is
// flagged and a SIGNAL_STALE diagnostic is written, but the setup stays live
// exactly as before: invalidating it is Phase 2, and only once this data
// shows that invalidation would actually have helped.
//
// Pure: no I/O, so the live engine and a test read the same functions.
// ============================================================

import type { GateDiagnostic } from './gate-diagnostics.js';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * How far the underlying may move, in ATR of the read's own timeframe, before
 * a re-surfaced sticky setup is flagged stale. A measurement threshold, not a
 * trading rule: it decides which rows get a SIGNAL_STALE diagnostic and gates
 * nothing. Override with the SIGNAL_STALENESS_MOVE_ATR env var.
 */
export const SIGNAL_STALENESS_MOVE_ATR = envNumber('SIGNAL_STALENESS_MOVE_ATR', 0.5);

/**
 * How long a freshly-minted setup is recorded as valid for (valid_until).
 * Recorded only; nothing expires a setup on it. Override with the
 * SIGNAL_VALIDITY_SECONDS env var.
 */
export const SIGNAL_VALIDITY_SECONDS = envNumber('SIGNAL_VALIDITY_SECONDS', 15 * 60);

/** Epoch-ms source timestamps for each input a decision was made from. */
export interface InputTimestamps {
  underlyingQuote: number | null;
  optionQuote: number | null;
  oi: number | null;
  pcr: number | null;
  iv: number | null;
  greeks: number | null;
  volume: number | null;
}

const validTs = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The finest-grained timestamps the feed carries today. The chain stamps
 * itself once (spot, PCR — both derived from that one fetch) and each leg
 * stamps itself once (quote, OI, IV, Greeks, volume all arrive on that leg).
 * Several fields therefore share an instant; they are kept separate so a
 * feed that stamps inputs independently needs no schema change.
 */
export function inputTimestampsFrom(
  chain: { timestamp?: number | null } | null | undefined,
  leg: { timestamp?: number | null } | null | undefined
): InputTimestamps {
  const chainTs = validTs(chain?.timestamp);
  const legTs = validTs(leg?.timestamp);
  return {
    underlyingQuote: chainTs,
    optionQuote: legTs,
    oi: legTs,
    pcr: chainTs,
    iv: legTs,
    greeks: legTs,
    volume: legTs,
  };
}

/** Seconds between the OLDEST input and the decision. Null when no input carried a timestamp. */
export function signalAgeSeconds(decidedAt: number, timestamps: InputTimestamps): number | null {
  const all = Object.values(timestamps).filter((v): v is number => v != null);
  if (all.length === 0) return null;
  const oldest = Math.min(...all);
  return Math.max(0, Math.round((decidedAt - oldest) / 10) / 100);
}

export function validUntil(decidedAt: number, validitySeconds: number = SIGNAL_VALIDITY_SECONDS): number {
  return decidedAt + validitySeconds * 1000;
}

export interface StalenessInput {
  /** The underlying price the setup was minted against. */
  underlyingAtGeneration: number | null | undefined;
  /** The underlying price on this poll. */
  currentUnderlying: number | null | undefined;
  /** ATR of the underlying, in points, from the setup's own entry context. */
  atrPoints: number | null | undefined;
  /** When the setup was minted (epoch ms). */
  generatedAt: number | null | undefined;
  now: number;
  thresholdAtr?: number;
}

export interface StalenessAssessment {
  /** False when there was not enough to measure against. Never read as "fresh". */
  evaluated: boolean;
  stale: boolean;
  /** Absolute move since generation, in ATR. */
  moveAtr: number | null;
  ageSeconds: number | null;
  thresholdAtr: number;
  reason: string;
}

/**
 * Has the underlying moved far enough from where this setup was minted that
 * re-surfacing it would present a different trade under the same numbers?
 *
 * Direction-agnostic on purpose: a move in favour also means the entry on
 * the card is no longer an entry anyone could get.
 */
export function assessStaleness(input: StalenessInput): StalenessAssessment {
  const thresholdAtr = input.thresholdAtr ?? SIGNAL_STALENESS_MOVE_ATR;
  const ageSeconds = input.generatedAt != null && input.generatedAt > 0 ? Math.max(0, Math.round((input.now - input.generatedAt) / 1000)) : null;
  const gen = input.underlyingAtGeneration;
  const cur = input.currentUnderlying;
  const atr = input.atrPoints;
  if (gen == null || !(gen > 0) || cur == null || !(cur > 0) || atr == null || !(atr > 0)) {
    return {
      evaluated: false,
      stale: false,
      moveAtr: null,
      ageSeconds,
      thresholdAtr,
      reason: 'Not measurable: generation price, current price or ATR missing.',
    };
  }
  const moveAtr = Math.abs(cur - gen) / atr;
  const stale = moveAtr > thresholdAtr;
  return {
    evaluated: true,
    stale,
    moveAtr: Math.round(moveAtr * 10000) / 10000,
    ageSeconds,
    thresholdAtr,
    reason: stale
      ? `Underlying moved ${moveAtr.toFixed(2)} ATR (${gen} -> ${cur}) since this setup was minted, beyond the ${thresholdAtr} ATR staleness mark. Measured only — the setup was NOT invalidated.`
      : `Underlying moved ${moveAtr.toFixed(2)} ATR since generation, inside the ${thresholdAtr} ATR mark.`,
  };
}

/** The SIGNAL_STALE diagnostic row for a stale re-surfaced setup. */
export function staleSignalDiagnostic(
  assessment: StalenessAssessment,
  context: { underlyingAtGeneration: number | null; currentUnderlying: number | null; atrPoints: number | null },
  at: number
): GateDiagnostic {
  return {
    gate: 'SIGNAL_STALE',
    status: !assessment.evaluated ? 'NOT_EVALUATED' : assessment.stale ? 'FAIL' : 'PASS',
    reason: assessment.reason,
    threshold: { signalStalenessMoveAtr: assessment.thresholdAtr },
    input_values: {
      underlyingAtGeneration: context.underlyingAtGeneration,
      currentUnderlying: context.currentUnderlying,
      atrPoints: context.atrPoints,
      moveAtr: assessment.moveAtr,
      ageSeconds: assessment.ageSeconds,
      enforced: false,
    },
    timestamp: at,
    // Not a live-chain gate: it never decides anything.
    was_deciding_gate: false,
  };
}
