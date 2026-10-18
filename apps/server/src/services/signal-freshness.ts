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
  /**
   * Audit 2026-10-18 (DATA-1): the EXCHANGE's own times for that option quote (Angel One FULL mode). The fields
   * above are the server's fetch times, so a quote the exchange published minutes earlier looked fresh. Present
   * only when the broker gave them.
   */
  optionExchange?: number | null;
  optionLastTrade?: number | null;
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
  leg: { timestamp?: number | null; exchangeTimestamp?: number | null; lastTradeTimestamp?: number | null } | null | undefined
): InputTimestamps {
  const chainTs = validTs(chain?.timestamp);
  const legTs = validTs(leg?.timestamp);
  const exchangeTs = validTs(leg?.exchangeTimestamp);
  const lastTradeTs = validTs(leg?.lastTradeTimestamp);
  return {
    underlyingQuote: chainTs,
    optionQuote: legTs,
    oi: legTs,
    pcr: chainTs,
    iv: legTs,
    greeks: legTs,
    volume: legTs,
    ...(exchangeTs != null ? { optionExchange: exchangeTs } : {}),
    ...(lastTradeTs != null ? { optionLastTrade: lastTradeTs } : {}),
  };
}

const RECEIVED_FIELDS = ['underlyingQuote', 'optionQuote', 'oi', 'pcr', 'iv', 'greeks', 'volume'] as const;

/**
 * Seconds between the OLDEST input and the decision, on the server's receive times (as recorded since Phase 1, so
 * rows stay comparable). Null when no input carried a timestamp. The exchange-time age is exchangeQuoteAgeSeconds.
 */
export function signalAgeSeconds(decidedAt: number, timestamps: InputTimestamps): number | null {
  const all = RECEIVED_FIELDS.map((k) => timestamps[k]).filter((v): v is number => v != null);
  if (all.length === 0) return null;
  const oldest = Math.min(...all);
  return Math.max(0, Math.round((decidedAt - oldest) / 10) / 100);
}

/**
 * Seconds from when the EXCHANGE published the option quote to the decision. Deliberately NOT clamped: a negative
 * age means the server clock is behind the exchange's, and hiding that is how the old clamp made skew invisible.
 * Null when the broker gave no exchange time.
 */
export function exchangeQuoteAgeSeconds(decidedAt: number, timestamps: InputTimestamps | null | undefined): number | null {
  const ex = timestamps?.optionExchange;
  return ex != null ? Math.round((decidedAt - ex) / 10) / 100 : null;
}

// --- STALE_QUOTE (audit 2026-10-18, DATA-1): measured, never enforced ---
// The pre-registered limit is 120 s of exchange age on the option quote a decision used. SHADOW (the default)
// writes a STALE_QUOTE gate-diagnostic row for every recorded decision that has an exchange time; OFF writes none.
// There is deliberately no ENFORCE yet: refusing trades is a strategy change, made only once the shadow rows show
// what it would have refused and how those trades did.

export type StaleQuoteMode = 'SHADOW' | 'OFF';
export function parseStaleQuoteMode(raw: string | undefined): StaleQuoteMode {
  return raw?.trim().toUpperCase() === 'OFF' ? 'OFF' : 'SHADOW';
}
export const STALE_QUOTE_MODE: StaleQuoteMode = parseStaleQuoteMode(process.env.STALE_QUOTE_GATE);
export const STALE_QUOTE_MAX_AGE_S = envNumber('STALE_QUOTE_MAX_AGE_S', 120);
/** An exchange time this far AHEAD of the server clock is recorded as clock skew. */
const CLOCK_SKEW_S = 5;

/** The STALE_QUOTE shadow row: PASS / FAIL on the exchange age; NOT_EVALUATED without an exchange time. Never deciding. */
export function staleQuoteDiagnostic(decidedAt: number, timestamps: InputTimestamps | null | undefined, maxAgeS: number = STALE_QUOTE_MAX_AGE_S): GateDiagnostic {
  const age = exchangeQuoteAgeSeconds(decidedAt, timestamps);
  const status = age == null ? 'NOT_EVALUATED' : age > maxAgeS ? 'FAIL' : 'PASS';
  return {
    gate: 'STALE_QUOTE',
    status,
    reason:
      age == null
        ? 'Not measurable: the broker gave no exchange time for this option quote.'
        : age > maxAgeS
          ? `The option quote was ${age}s old by the exchange's clock, beyond the ${maxAgeS}s limit. Measured only — the decision was NOT changed.`
          : `The option quote was ${age}s old by the exchange's clock, inside the ${maxAgeS}s limit.`,
    threshold: { staleQuoteMaxAgeSeconds: maxAgeS },
    input_values: {
      exchangeAgeSeconds: age,
      optionExchangeTimestamp: timestamps?.optionExchange ?? null,
      optionLastTradeTimestamp: timestamps?.optionLastTrade ?? null,
      optionReceivedTimestamp: timestamps?.optionQuote ?? null,
      clockSkew: age != null && age < -CLOCK_SKEW_S,
      enforced: false,
    },
    timestamp: decidedAt,
    was_deciding_gate: false,
  };
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
