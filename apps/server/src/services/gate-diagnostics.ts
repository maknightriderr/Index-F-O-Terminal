// ============================================================
// GATE DIAGNOSTICS — every gate, evaluated independently
// ============================================================
// The live gate chain in resolveStickyTradeSetup (market-bias.ts) is a
// strict first-match `??` chain. That is the right shape for DECIDING — the
// first refusal is enough — but it is the wrong shape for LEARNING: when a
// setup is refused on RISK_OFF nobody can see that it would also have failed
// LOW_SETUP_QUALITY and POSITIONING_CONFLICT, and when a taken trade loses
// nobody can see which gates it only narrowly passed.
//
// This module evaluates every gate on its own and returns one row per gate.
//
// IT IS OBSERVATION ONLY, BY CONSTRUCTION:
//   - It is pure. It takes values the caller already has in scope and
//     returns data; it reads nothing and writes nothing.
//   - The live refusal is an INPUT here (to mark which gate decided), never
//     an output. Nothing in this file can produce, change or veto a refusal.
//   - The caller computes these rows AFTER the live refusal is fixed and
//     only persists them next to the decision record.
//
// Where a gate's input was not available the row says NOT_EVALUATED rather
// than guessing PASS: "we did not look" and "it passed" are different facts.
// ============================================================

import type { BiasDirection, TradingMode } from '@fno/shared';

// ============================================================
// MINUTES SINCE LAST LOSS — pure (Phase 3, spec §16)
// ============================================================
// Split out so it is testable without Redis: market-bias.ts's
// readMinutesSinceLastLoss() fetches the two TTLs the cooldown gate already
// reads (postLossSettleKey, slCooldownKey) and hands them here. See that
// function's own comment for exactly what is and is not recoverable.
// ============================================================

/**
 * `settleTtlSeconds`/`sameSideCooldownTtlSeconds` are `redis.ttl()`'s raw
 * result (<=0 when the key is absent/expired) for postLossSettleKey and
 * slCooldownKey respectively — the SAME two reads losingCloseCooldownReason()
 * already makes for the gate. `postLossSettleMinutes`/`sameSideCooldownSeconds`
 * are the TTLs those keys were originally SET with, so elapsed time can be
 * backed out of what's left. Pure: no I/O, no Redis import.
 */
export function minutesSinceLastLossFromTtls(
  settleTtlSeconds: number,
  sameSideCooldownTtlSeconds: number,
  mode: TradingMode,
  postLossSettleMinutes: number,
  sameSideCooldownSeconds: number
): number | null {
  if (settleTtlSeconds > 0) {
    return Math.max(0, Math.round(postLossSettleMinutes - settleTtlSeconds / 60));
  }
  // The same-symbol+direction cooldown key lives SL_COOLDOWN_SECONDS
  // (INTRADAY) or 24h (POSITIONAL) — a 24h TTL isn't a usable "minutes since"
  // read against the 60-minute frame this recovers, so POSITIONAL returns
  // null past the settle window rather than a misleading huge number.
  if (mode === 'INTRADAY' && sameSideCooldownTtlSeconds > 0) {
    return Math.max(0, Math.round(sameSideCooldownSeconds / 60 - sameSideCooldownTtlSeconds / 60));
  }
  return null;
}

export type GateName =
  | 'RISK_OFF'
  | 'NO_QUOTE'
  | 'OPENING_HOUR'
  | 'LOW_SETUP_QUALITY'
  | 'POSITIONING_CONFLICT'
  | 'POST_LOSS_COOLDOWN'
  | 'DIRECTION_LOCKED'
  | 'SAME_SYMBOL_SIDE'
  | 'RELIABILITY_FILTER'
  // Not part of the live chain. Written when a sticky setup is re-surfaced
  // after the underlying moved away from it — see signal-freshness.ts.
  | 'SIGNAL_STALE'
  // Not part of the live chain either (spec §20, Phase 3). roomToTarget()'s
  // OI-wall filter has no freshness check today; this diagnostic measures
  // how old the OI data it used was, without changing what it filters.
  | 'OI_WALL_FRESHNESS'
  // Validation-review gates (validation-gates.ts). Each is enforced only when
  // its flag is on; the row is written either way, with `enforced` in its
  // input values. Kept out of LIVE_CHAIN_GATES so the pre-review chain and its
  // diagnostics are unchanged — see VALIDATION_GATES below.
  | 'CLOSING_HOUR'
  | 'POOR_LOCATION'
  | 'INSUFFICIENT_ROOM'
  | 'CONCURRENT_EXPOSURE';

/**
 * The validation-review gates, in the order the live chain evaluates them:
 * CLOSING_HOUR inside the session gate, POOR_LOCATION and INSUFFICIENT_ROOM
 * after LOW_SETUP_QUALITY, CONCURRENT_EXPOSURE last. Rows for them come from
 * evaluateValidationGateDiagnostics (validation-gates.ts).
 */
export const VALIDATION_GATES: readonly GateName[] = ['CLOSING_HOUR', 'POOR_LOCATION', 'INSUFFICIENT_ROOM', 'CONCURRENT_EXPOSURE'] as const;

export type GateStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'STALE';

/** The live chain's gates, in the exact order the `??` chain evaluates them. */
export const LIVE_CHAIN_GATES: readonly GateName[] = [
  'RISK_OFF',
  'NO_QUOTE',
  'OPENING_HOUR',
  'LOW_SETUP_QUALITY',
  'POSITIONING_CONFLICT',
  'POST_LOSS_COOLDOWN',
  'DIRECTION_LOCKED',
  'SAME_SYMBOL_SIDE',
  'RELIABILITY_FILTER',
] as const;

export interface GateDiagnostic {
  gate: GateName;
  status: GateStatus;
  reason: string | null;
  threshold: Record<string, unknown> | null;
  input_values: Record<string, unknown>;
  /** Epoch ms. */
  timestamp: number;
  /** True only for the one gate the live first-match chain refused on. */
  was_deciding_gate: boolean;
}

/** A gate's own refusal, in the shape the live chain produces it. */
export interface GateRefusalLike {
  code: string;
  reason: string;
}

/**
 * The raw post-loss state the cooldown family reads. The live
 * losingCloseCooldownReason() returns only the FIRST of its three codes; the
 * diagnostic needs each one on its own, so it takes the raw readings instead.
 */
export interface LosingCloseState {
  /** Seconds left on the exchange+mode post-loss settle (<= 0 when none). */
  settleTtlSeconds: number;
  /** Something already stopped out on this exchange+mode today. */
  lostToday: boolean;
  /** Stop-outs today for this symbol+direction. */
  sameDirectionLossCount: number;
  /** Seconds left on the symbol+direction cooldown (<= 0 when none). */
  sameSideCooldownTtlSeconds: number;
}

export interface GateEvaluationInputs {
  direction: BiasDirection;
  mode: TradingMode;
  /** The setup confidence the live chain compared against its floor. */
  confidence: number;

  /** riskOffReason()'s result. Always evaluated by the live chain. */
  riskOffReason: string | null;
  /** dataQualityBlock()'s result. */
  feedBlockReason: string | null;
  /** sessionGateReason()'s result, recomputed for the diagnostic. */
  sessionRefusal: GateRefusalLike | null;
  minutesSinceOpen: number | null;
  /** positioningConflictReason()'s result, recomputed for the diagnostic. */
  positioningRefusal: GateRefusalLike | null;
  /** The three positioning votes, or null when no vote snapshot existed. */
  positioningVotes: { futuresOi: number; pcr: number; optionOiFlow: number } | null;
  /** Null when the post-loss state could not be read. */
  losingClose: LosingCloseState | null;
  /**
   * checkReliabilityFilters()'s result. `evaluated: false` when the live
   * chain skipped it (it does so while RISK_OFF holds).
   */
  reliability: { evaluated: boolean; reason: string | null };

  /** The code the live chain actually refused on, or null if it passed. */
  liveRefusalCode: string | null;

  /** The live thresholds, passed in so this module holds no copy of them. */
  thresholds: {
    minSetupConfidence: number;
    openingSettleMinutes: number;
    openingGuardMinutes: number;
    postLossSettleMinutes: number;
    postLossMinConfidence: number;
    maxSameDirectionLossesPerDay: number;
  };
}

/** Which diagnostic gate a live refusal code belongs to. */
export function gateForRefusalCode(code: string | null | undefined): GateName | null {
  if (code == null) return null;
  // The session gate refuses with MARKET_CLOSED outside hours and
  // OPENING_HOUR inside the settle/guard window; both are the same gate.
  if (code === 'MARKET_CLOSED') return 'OPENING_HOUR';
  if ((VALIDATION_GATES as readonly string[]).includes(code)) return code as GateName;
  return (LIVE_CHAIN_GATES as readonly string[]).includes(code) ? (code as GateName) : null;
}

/**
 * One row per live-chain gate, each evaluated on its own. Pure.
 *
 * The inputs object is never mutated, and the live refusal is only read to
 * set `was_deciding_gate`.
 */
export function evaluateGateDiagnostics(inputs: Readonly<GateEvaluationInputs>, at: number): GateDiagnostic[] {
  const deciding = gateForRefusalCode(inputs.liveRefusalCode);
  const t = inputs.thresholds;
  const row = (
    gate: GateName,
    status: GateStatus,
    reason: string | null,
    threshold: Record<string, unknown> | null,
    inputValues: Record<string, unknown>
  ): GateDiagnostic => ({
    gate,
    status,
    reason,
    threshold,
    input_values: inputValues,
    timestamp: at,
    was_deciding_gate: deciding === gate,
  });

  const rows: GateDiagnostic[] = [];

  rows.push(
    inputs.riskOffReason != null
      ? row('RISK_OFF', 'FAIL', inputs.riskOffReason, null, { riskOff: true })
      : row('RISK_OFF', 'PASS', null, null, { riskOff: false })
  );

  rows.push(
    inputs.feedBlockReason != null
      ? row('NO_QUOTE', 'FAIL', inputs.feedBlockReason, null, { feedBlocked: true })
      : row('NO_QUOTE', 'PASS', null, null, { feedBlocked: false })
  );

  const sessionThreshold = {
    settleMinutes: t.openingSettleMinutes,
    intradayGuardMinutes: inputs.mode === 'INTRADAY' ? t.openingGuardMinutes : null,
  };
  // The session gate also carries the closing guard (CLOSING_HOUR), which has
  // its own diagnostic row — it is not an opening-hour failure.
  const openingRefusal = inputs.sessionRefusal != null && inputs.sessionRefusal.code !== 'CLOSING_HOUR' ? inputs.sessionRefusal : null;
  rows.push(
    openingRefusal != null
      ? row('OPENING_HOUR', 'FAIL', openingRefusal.reason, sessionThreshold, {
          code: openingRefusal.code,
          minutesSinceOpen: inputs.minutesSinceOpen,
          mode: inputs.mode,
        })
      : row('OPENING_HOUR', 'PASS', null, sessionThreshold, { minutesSinceOpen: inputs.minutesSinceOpen, mode: inputs.mode })
  );

  const confidenceFails = inputs.confidence < t.minSetupConfidence;
  rows.push(
    row(
      'LOW_SETUP_QUALITY',
      confidenceFails ? 'FAIL' : 'PASS',
      confidenceFails ? `Confidence ${inputs.confidence} is below ${t.minSetupConfidence}.` : null,
      { minSetupConfidence: t.minSetupConfidence },
      { confidence: inputs.confidence, marginToFloor: inputs.confidence - t.minSetupConfidence }
    )
  );

  if (inputs.direction === 'NEUTRAL' || inputs.positioningVotes == null) {
    rows.push(
      row(
        'POSITIONING_CONFLICT',
        'NOT_EVALUATED',
        inputs.direction === 'NEUTRAL' ? 'No direction to conflict with.' : 'No vote snapshot was available.',
        null,
        { direction: inputs.direction, votes: inputs.positioningVotes }
      )
    );
  } else {
    rows.push(
      row(
        'POSITIONING_CONFLICT',
        inputs.positioningRefusal != null ? 'FAIL' : 'PASS',
        inputs.positioningRefusal?.reason ?? null,
        { rule: 'futures OI, PCR and option OI flow ALL against the direction' },
        { direction: inputs.direction, votes: inputs.positioningVotes }
      )
    );
  }

  // The cooldown family. The live gate returns only the first of these;
  // each is evaluated on its own here.
  const lc = inputs.losingClose;
  if (inputs.direction === 'NEUTRAL' || lc == null) {
    const why = inputs.direction === 'NEUTRAL' ? 'The live cooldown gate does not apply to a NEUTRAL read.' : 'Post-loss state could not be read.';
    for (const gate of ['POST_LOSS_COOLDOWN', 'DIRECTION_LOCKED', 'SAME_SYMBOL_SIDE'] as const) {
      rows.push(row(gate, 'NOT_EVALUATED', why, null, { direction: inputs.direction }));
    }
  } else {
    const settleActive = lc.settleTtlSeconds > 0;
    const raisedBarFails = lc.lostToday && inputs.confidence < t.postLossMinConfidence;
    const postLossFails = settleActive || raisedBarFails;
    rows.push(
      row(
        'POST_LOSS_COOLDOWN',
        postLossFails ? 'FAIL' : 'PASS',
        settleActive
          ? `Inside the ${t.postLossSettleMinutes}-minute post-loss settle (${lc.settleTtlSeconds}s left).`
          : raisedBarFails
            ? `A stop-out already happened today and confidence ${inputs.confidence} is below the raised bar of ${t.postLossMinConfidence}.`
            : null,
        { postLossSettleMinutes: t.postLossSettleMinutes, postLossMinConfidence: t.postLossMinConfidence },
        { settleTtlSeconds: lc.settleTtlSeconds, lostToday: lc.lostToday, confidence: inputs.confidence }
      )
    );

    const locked = lc.sameDirectionLossCount >= t.maxSameDirectionLossesPerDay;
    rows.push(
      row(
        'DIRECTION_LOCKED',
        locked ? 'FAIL' : 'PASS',
        locked ? `${lc.sameDirectionLossCount} same-direction stop-outs today (limit ${t.maxSameDirectionLossesPerDay}).` : null,
        { maxSameDirectionLossesPerDay: t.maxSameDirectionLossesPerDay },
        { sameDirectionLossCount: lc.sameDirectionLossCount, direction: inputs.direction }
      )
    );

    const sameSide = lc.sameSideCooldownTtlSeconds > 0;
    rows.push(
      row(
        'SAME_SYMBOL_SIDE',
        sameSide ? 'FAIL' : 'PASS',
        sameSide ? `Same symbol+direction cooldown active (${lc.sameSideCooldownTtlSeconds}s left).` : null,
        null,
        { sameSideCooldownTtlSeconds: lc.sameSideCooldownTtlSeconds, direction: inputs.direction }
      )
    );
  }

  rows.push(
    !inputs.reliability.evaluated
      ? row('RELIABILITY_FILTER', 'NOT_EVALUATED', 'Skipped by the live chain (it is not run while RISK_OFF holds).', null, {})
      : inputs.reliability.reason != null
        ? row('RELIABILITY_FILTER', 'FAIL', inputs.reliability.reason, null, {})
        : row('RELIABILITY_FILTER', 'PASS', null, null, {})
  );

  return rows;
}

/**
 * The first FAILING gate in live-chain order. For a consistent set of inputs
 * this is the gate the live chain refused on — used by tests and reports to
 * check the diagnostic agrees with what actually happened.
 */
export function firstFailingGate(rows: readonly GateDiagnostic[]): GateName | null {
  for (const gate of LIVE_CHAIN_GATES) {
    if (rows.find((r) => r.gate === gate)?.status === 'FAIL') return gate;
  }
  return null;
}

// ============================================================
// OI-WALL FRESHNESS (Phase 3, spec §20 — diagnostic only)
// ============================================================
// roomToTarget() (market-bias.ts) filters candidate OI walls by
// OI_WALL_MIN_STRENGTH_PCT with no check on how old the OI data behind them
// is — it uses whatever the in-memory chain fetch happened to hold. This
// measures that age against a threshold and logs PASS/STALE. It is NOT part
// of LIVE_CHAIN_GATES: nothing reads this diagnostic back, roomToTarget's
// own filter and result are unchanged by it, and STALE never refuses a
// setup — it only tells a later report whether a room-to-target decision was
// ever made against stale OI.
// ============================================================

function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How old the OI-wall data may be before it's flagged STALE. Override with OI_WALL_FRESHNESS_STALE_SECONDS. */
export const OI_WALL_FRESHNESS_STALE_SECONDS = envSeconds('OI_WALL_FRESHNESS_STALE_SECONDS', 120);

/**
 * The OI_WALL_FRESHNESS diagnostic for one decision. `oiAgeSeconds` is the
 * age of the chain-fetch timestamp roomToTarget()'s OI levels were derived
 * from, already computed by the caller (market-bias.ts) at the exact point
 * roomToTarget() ran — no new measurement happens here, just the PASS/STALE
 * read against the threshold above.
 */
export function oiWallFreshnessDiagnostic(
  oiAgeSeconds: number | null,
  at: number,
  thresholdSeconds: number = OI_WALL_FRESHNESS_STALE_SECONDS
): GateDiagnostic {
  if (oiAgeSeconds == null) {
    return {
      gate: 'OI_WALL_FRESHNESS',
      status: 'NOT_EVALUATED',
      reason: 'No OI snapshot timestamp was available for this decision (e.g. no chain fetch, or a NEUTRAL direction with no room-to-target check).',
      threshold: { staleAfterSeconds: thresholdSeconds },
      input_values: { oiAgeSeconds: null },
      timestamp: at,
      was_deciding_gate: false,
    };
  }
  const stale = oiAgeSeconds > thresholdSeconds;
  return {
    gate: 'OI_WALL_FRESHNESS',
    status: stale ? 'STALE' : 'PASS',
    reason: stale
      ? `The OI-wall data roomToTarget() filtered candidates by was ${oiAgeSeconds}s old, beyond the ${thresholdSeconds}s freshness mark. Measured only — roomToTarget's own filter and its result are unchanged.`
      : `OI-wall data was ${oiAgeSeconds}s old, inside the ${thresholdSeconds}s freshness mark.`,
    threshold: { staleAfterSeconds: thresholdSeconds },
    input_values: { oiAgeSeconds },
    timestamp: at,
    was_deciding_gate: false,
  };
}
