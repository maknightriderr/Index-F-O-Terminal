// ============================================================
// VALIDATION-REVIEW GATES — pure, each behind its own flag
// ============================================================
// The four refusals the validation review added to the live chain in
// resolveStickyTradeSetup (market-bias.ts), written as pure functions so the
// boundaries can be tested without Redis, Postgres or a clock:
//
//   POOR_LOCATION        flag LOCATION_GATE   (default ON)
//   INSUFFICIENT_ROOM    flag ROOM_GATE       (default OFF — corrected measure, no outcome data yet)
//   CLOSING_HOUR         flag CLOSING_GUARD   (default ON)
//   CONCURRENT_EXPOSURE  flag CONCURRENCY_CAP (default OFF — a quantity limit, like the breaker)
//
// Each takes its flag as an argument and returns null when the flag is off,
// so a flag-off chain is exactly the pre-review chain.
//
// The matching gate-diagnostic rows are built here too. They are observation
// only, like everything in gate-diagnostics.ts: a row reports whether the gate
// WOULD refuse and whether it is enforced, and is never read back.
// ============================================================

import type { Exchange, NoTradeCode, TradingMode } from '@fno/shared';
import { getSessionWindow } from '@fno/shared';
import type { ExposureSnapshot } from './exposure-tracker.js';
import { gateForRefusalCode, VALIDATION_GATES, type GateDiagnostic, type GateName, type GateStatus } from './gate-diagnostics.js';

export interface ValidationRefusal {
  code: NoTradeCode;
  reason: string;
}

// ---------------- CLOSING_HOUR ----------------

/**
 * Minutes until the exchange's session closes at `at`, or null outside a
 * live session. Uses the same per-exchange close times remainingSessionFraction
 * reads (getSessionCloseTime, via getSessionWindow — which also honours MCX's
 * US-DST 23:30 close, its 23:55 close otherwise, and its partial-day holidays).
 */
export function minutesToSessionClose(exchange: Exchange, at: number): number | null {
  const date = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const window = getSessionWindow(exchange, date);
  if (!window || at < window.open || at > window.close) return null;
  return (window.close - at) / 60000;
}

/**
 * Fix 5. New INTRADAY setups are refused once fewer than `guardMinutes` remain.
 * Existing setups are untouched (this is only consulted when minting), and so
 * is CLOSING_WINDOW_MINUTES' volume rule. Evidence is thin — NSE entries with
 * under two hours left: 5 trades, 0 wins — which is why it is a flag.
 *
 * `guardMinutes` is per engine: the consensus engine passes
 * SETUP_CLOSING_GUARD_MINUTES (60, its targets are time-scaled); the structure
 * engine passes STRUCTURE_CLOSING_GUARD_MIN (chosen by its backtest). The NSE
 * evidence sentence is only cited on NSE/BSE — it was never measured on MCX.
 */
export function closingGuardReason(args: {
  enabled: boolean;
  mode: TradingMode;
  exchange: Exchange;
  minutesToClose: number | null;
  guardMinutes: number;
}): ValidationRefusal | null {
  if (!args.enabled || args.mode !== 'INTRADAY' || args.minutesToClose == null) return null;
  if (args.minutesToClose >= args.guardMinutes) return null;
  const head = `Only ${Math.floor(args.minutesToClose)} minutes left before ${args.exchange} closes, and new intraday setups stop ${args.guardMinutes} minutes before the close. `;
  return {
    code: 'CLOSING_HOUR',
    reason:
      args.exchange === 'NSE' || args.exchange === 'BSE'
        ? head + `A late entry has too little session left to reach its target (thin evidence: NSE entries with under two hours left went 0 for 5).`
        : head + `Past the ${args.guardMinutes}-minute cutoff a late entry has too little session left to reach its target.`,
  };
}

// ---------------- POOR_LOCATION ----------------

/**
 * Fix 2. The location score was already computed and recorded as a shadow
 * reading (POOR_LOCATION below 40); this enforces that same threshold.
 * Recorded evidence: score ≥ 60 PF 2.35, score < 40 PF 0.93.
 */
export function locationGateReason(args: { enabled: boolean; locationScore: number | null; minScore: number; locationReason?: string | null }): ValidationRefusal | null {
  if (!args.enabled || args.locationScore == null) return null;
  if (args.locationScore >= args.minScore) return null;
  return {
    code: 'POOR_LOCATION',
    reason:
      `Location score ${args.locationScore}/100 is below ${args.minScore} — entering into the level ahead rather than away from support.` +
      (args.locationReason ? ` ${args.locationReason}` : '') +
      ` Recorded setups below ${args.minScore} ran a profit factor of 0.93 against 2.35 at 60 and above.`,
  };
}

// ---------------- INSUFFICIENT_ROOM (V2) ----------------

/** The same margin assessRoom() applies (location-quality.ts ROOM_MARGIN). */
export const ROOM_V2_MARGIN = 1.15;

/**
 * Fix 2, corrected room measure. The old measure compared the UNCAPPED
 * full-session expected move against the nearest level of any kind and failed
 * ~94% of the time. V2 measures the target distance ACTUALLY used — the move
 * after the room cap has trimmed it — in ATR.
 */
export function roomV2(args: { availableAtr: number | null; targetMovePoints: number; atrPoints: number | null }): {
  requiredAtrV2: number | null;
  sufficientV2: boolean | null;
} {
  const requiredAtrV2 = args.atrPoints != null && args.atrPoints > 0 && args.targetMovePoints > 0 ? args.targetMovePoints / args.atrPoints : null;
  if (args.availableAtr == null || requiredAtrV2 == null) return { requiredAtrV2, sufficientV2: null };
  return { requiredAtrV2, sufficientV2: args.availableAtr >= requiredAtrV2 * ROOM_V2_MARGIN };
}

export function roomGateReason(args: { enabled: boolean; sufficientV2: boolean | null; availableAtr: number | null; requiredAtrV2: number | null }): ValidationRefusal | null {
  if (!args.enabled || args.sufficientV2 !== false) return null;
  return {
    code: 'INSUFFICIENT_ROOM',
    reason: `Only ${args.availableAtr?.toFixed(2)} ATR to the first level ahead, but the target actually used needs ${args.requiredAtrV2?.toFixed(2)} ATR (×${ROOM_V2_MARGIN} margin) — the move has nowhere to go.`,
  };
}

// ---------------- CONCURRENT_EXPOSURE ----------------

/**
 * Fix 4. How many live paper setups already lean this way: every same-direction
 * peer, plus the correlated ones (same direction, same index family) counted a
 * second time — a NIFTY and a BANKNIFTY long are one concentrated bet, so they
 * weigh more than two unrelated stocks. Read from computeExposure's counts.
 */
export function concurrentCount(exposure: ExposureSnapshot): number {
  return exposure.sameDirectionExposure + exposure.correlatedExposure;
}

export function concurrencyGateReason(args: { enabled: boolean; exposure: ExposureSnapshot | null; max: number }): ValidationRefusal | null {
  if (!args.enabled || !args.exposure) return null;
  const n = concurrentCount(args.exposure);
  if (n < args.max) return null;
  return {
    code: 'CONCURRENT_EXPOSURE',
    reason:
      `${args.exposure.sameDirectionExposure} live setups already lean the same way (${args.exposure.correlatedExposure} of them in the same index family), ` +
      `an exposure count of ${n} against a cap of ${args.max}. A further one adds concentration, not an independent bet.`,
  };
}

// ---------------- DIAGNOSTICS ----------------

export { VALIDATION_GATES };

export interface ValidationGateInputs {
  mode: TradingMode;
  exchange: Exchange;
  liveRefusalCode: string | null;
  closing: { enforced: boolean; minutesToClose: number | null; guardMinutes: number };
  location: { enforced: boolean; score: number | null; minScore: number };
  room: { enforced: boolean; availableAtr: number | null; requiredAtrV2: number | null; sufficientV2: boolean | null; requiredAtrV1: number | null; sufficientV1: boolean | null };
  /** Null exposure = not read (the Redis read only runs when CONCURRENCY_CAP is on). */
  concurrency: { enforced: boolean; exposure: ExposureSnapshot | null; max: number };
}

/**
 * One row per validation gate. A row whose flag is off still says whether the
 * gate WOULD have refused (status FAIL, `enforced: false`), which is how the
 * shadow value of an unenforced gate is measured. Pure; never refuses anything.
 */
export function evaluateValidationGateDiagnostics(inputs: Readonly<ValidationGateInputs>, at: number): GateDiagnostic[] {
  const deciding = gateForRefusalCode(inputs.liveRefusalCode);
  const row = (gate: GateName, status: GateStatus, reason: string | null, threshold: Record<string, unknown>, inputValues: Record<string, unknown>): GateDiagnostic => ({
    gate,
    status,
    reason,
    threshold,
    input_values: inputValues,
    timestamp: at,
    was_deciding_gate: deciding === gate,
  });
  const rows: GateDiagnostic[] = [];

  const c = inputs.closing;
  if (inputs.mode !== 'INTRADAY' || c.minutesToClose == null) {
    rows.push(
      row('CLOSING_HOUR', 'NOT_EVALUATED', inputs.mode !== 'INTRADAY' ? 'The closing guard applies to INTRADAY setups only.' : 'No live session to measure the close against.', { guardMinutes: c.guardMinutes }, {
        enforced: c.enforced,
        mode: inputs.mode,
        minutesToClose: c.minutesToClose,
      })
    );
  } else {
    const would = closingGuardReason({ enabled: true, mode: inputs.mode, exchange: inputs.exchange, minutesToClose: c.minutesToClose, guardMinutes: c.guardMinutes });
    rows.push(
      row('CLOSING_HOUR', would ? 'FAIL' : 'PASS', would?.reason ?? null, { guardMinutes: c.guardMinutes }, {
        enforced: c.enforced,
        mode: inputs.mode,
        exchange: inputs.exchange,
        minutesToClose: Math.round(c.minutesToClose * 10) / 10,
      })
    );
  }

  const l = inputs.location;
  if (l.score == null) {
    rows.push(row('POOR_LOCATION', 'NOT_EVALUATED', 'No location score was computed for this decision.', { minScore: l.minScore }, { enforced: l.enforced, score: null }));
  } else {
    const would = locationGateReason({ enabled: true, locationScore: l.score, minScore: l.minScore });
    rows.push(row('POOR_LOCATION', would ? 'FAIL' : 'PASS', would?.reason ?? null, { minScore: l.minScore }, { enforced: l.enforced, score: l.score, marginToFloor: l.score - l.minScore }));
  }

  const r = inputs.room;
  const roomInputs = { enforced: r.enforced, availableAtr: r.availableAtr, requiredAtrV2: r.requiredAtrV2, sufficientV2: r.sufficientV2, requiredAtrV1: r.requiredAtrV1, sufficientV1: r.sufficientV1 };
  if (r.sufficientV2 == null) {
    rows.push(row('INSUFFICIENT_ROOM', 'NOT_EVALUATED', 'Room cannot be judged — no ATR, no target move, or no level ahead.', { margin: ROOM_V2_MARGIN, measure: 'V2' }, roomInputs));
  } else {
    const would = roomGateReason({ enabled: true, sufficientV2: r.sufficientV2, availableAtr: r.availableAtr, requiredAtrV2: r.requiredAtrV2 });
    rows.push(row('INSUFFICIENT_ROOM', would ? 'FAIL' : 'PASS', would?.reason ?? null, { margin: ROOM_V2_MARGIN, measure: 'V2' }, roomInputs));
  }

  const x = inputs.concurrency;
  if (!x.exposure) {
    rows.push(
      row('CONCURRENT_EXPOSURE', 'NOT_EVALUATED', x.enforced ? 'Live exposure could not be read.' : 'CONCURRENCY_CAP is off, so live exposure is not read at decision time.', { max: x.max }, { enforced: x.enforced })
    );
  } else {
    const would = concurrencyGateReason({ enabled: true, exposure: x.exposure, max: x.max });
    rows.push(
      row('CONCURRENT_EXPOSURE', would ? 'FAIL' : 'PASS', would?.reason ?? null, { max: x.max }, {
        enforced: x.enforced,
        sameDirection: x.exposure.sameDirectionExposure,
        correlated: x.exposure.correlatedExposure,
        count: concurrentCount(x.exposure),
      })
    );
  }

  return rows;
}
