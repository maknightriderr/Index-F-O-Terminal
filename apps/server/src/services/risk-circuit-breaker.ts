// ============================================================
// DAILY RISK CIRCUIT BREAKER
// ============================================================
// A capital control that sits outside the signal engine and can veto it. The
// engine decides whether a trade is good; this decides whether the account
// should be taking any trade at all today.
//
// It is deliberately not a model and not fitted to history. The thresholds
// are risk policy — how much of a day you are willing to lose before
// stopping — and they are configurable rather than optimised. The defaults
// are set against the recorded book: the worst day in the sample lost about
// 3.5R and the worst losing streak ran to 9 trades, so 3R or three straight
// stop-outs stops the day.
//
// Counting reads closed setups from the `signals` table, so a restart cannot
// forget that the day already went badly.
//
// ------------------------------------------------------------
// CURRENTLY DISABLED — see DAILY_RISK_BREAKER_ENABLED below.
// ------------------------------------------------------------
// The four automated rules are inert. They are still COMPUTED and reported,
// so the numbers stay visible, but they no longer veto anything.
//
// Why: every rule here counts rows written by recordTradeSetupGenerated() —
// setups the engine MINTED. Nothing in this system records whether a setup was
// actually entered; there is no taken/executed/filled flag anywhere. So the
// day's "realised R" was never realised. On 2026-09-23 three generated setups
// were watched into their stops and the account was stopped for the day at
// -3.65R of losses nobody had taken.
//
// The manual kill switch is NOT disabled: that is an explicit human decision
// and does not depend on the broken input.
//
// To re-enable: set DAILY_RISK_BREAKER_ENABLED to true. Nothing else needs to
// change — no rule was deleted and no threshold was altered. But note that
// re-enabling restores the same defect unless executed trades are tracked
// separately first.
// ============================================================

import { redis } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import type { Exchange, TradingMode } from '@fno/shared';

export interface RiskLimits {
  /** Stop for the day once realised losses reach this many R. */
  maxDailyLossR: number;
  /** Stop after this many consecutive stop-outs, whatever the R. */
  maxConsecutiveStops: number;
  /** Hard ceiling on setups minted in one IST day, across all symbols. */
  maxTradesPerDay: number;
  /** Positions allowed open at once. */
  maxOpenPositions: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxDailyLossR: 3,
  maxConsecutiveStops: 3,
  maxTradesPerDay: 6,
  maxOpenPositions: 4,
};

/**
 * Whether the four automated rules may veto a setup.
 *
 * FALSE while the breaker's input is wrong: it counts GENERATED setups as
 * though they were taken trades. Flip to true to restore the previous
 * behaviour exactly — the thresholds above are untouched and every rule is
 * still evaluated below, so this is the only line that changes.
 *
 * The rules keep running while disabled. `readRiskState()` reports what WOULD
 * have fired in `suppressedReason`, so turning the veto off does not turn the
 * observation off — the same shadow-rule pattern the rest of the engine uses.
 */
export const DAILY_RISK_BREAKER_ENABLED = false;

export interface RiskState {
  day: string;
  realisedR: number;
  consecutiveStops: number;
  tradesToday: number;
  openPositions: number;
  riskOff: boolean;
  reason: string | null;
  /** Whether the automated rules are permitted to veto. */
  breakerEnabled: boolean;
  /**
   * What would have blocked trading if the breaker were enabled.
   *
   * Populated instead of `reason` while disabled, so the rule is observable
   * without being in force. Null when nothing would have fired.
   */
  suppressedReason: string | null;
}

const MANUAL_OVERRIDE_KEY = 'risk:manual_off';
const COST_FALLBACK_PCT = 3;

function istDay(at = Date.now()): string {
  return new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Realised R for one recorded setup, net of costs — the same arithmetic the Backtesting page uses. */
function realisedR(inputs: any, fwd: string | null): number | null {
  const ret = fwd != null ? Number(fwd) : null;
  const entry = Number(inputs?.entry ?? 0);
  const stop = Number(inputs?.stopLoss ?? 0);
  if (ret == null || !(entry > 0) || !(stop > 0) || stop >= entry) return null;
  const net = ret - Number(inputs?.estimatedCostPct ?? COST_FALLBACK_PCT);
  const riskPct = ((entry - stop) / entry) * 100;
  return riskPct > 0 ? net / riskPct : null;
}

/**
 * The day's realised risk picture. Reads the recorded setups rather than a
 * counter, so it survives restarts and matches what the Backtesting page shows.
 */
export async function readRiskState(limits: RiskLimits = DEFAULT_RISK_LIMITS): Promise<RiskState> {
  const day = istDay();
  const state: RiskState = {
    day, realisedR: 0, consecutiveStops: 0, tradesToday: 0, openPositions: 0,
    riskOff: false, reason: null,
    breakerEnabled: DAILY_RISK_BREAKER_ENABLED, suppressedReason: null,
  };

  try {
    const manual = await redis.get(MANUAL_OVERRIDE_KEY);
    if (manual) {
      state.riskOff = true;
      state.reason = `Trading is switched off manually (${manual}).`;
      return state;
    }
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Risk breaker: manual-override read failed');
  }

  try {
    const rows = await sql<{ inputs: any; fwd: string | null; time: Date }[]>`
      SELECT inputs, fwd_1d_return AS fwd, time FROM signals
      WHERE signal_type = 'TRADE_SETUP'
        AND (time AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date
      ORDER BY time ASC
    `;
    state.tradesToday = rows.length;
    state.openPositions = rows.filter((r) => r.inputs?.outcome == null).length;

    let streak = 0;
    for (const row of rows) {
      if (row.inputs?.outcome == null) continue;
      const r = realisedR(row.inputs, row.fwd);
      if (r != null) state.realisedR += r;
      if (row.inputs?.outcome === 'LOSS') streak += 1;
      else if (row.inputs?.outcome === 'WIN') streak = 0;
    }
    state.consecutiveStops = streak;
  } catch (err: any) {
    // A database problem must not silently disable the breaker; say so and
    // let the engine's own gates carry the day.
    logger.warn({ error: err.message }, 'Risk breaker: could not read the day — proceeding without it');
    return state;
  }

  // Every rule is still evaluated. Whether the verdict VETOES is the only
  // thing the flag changes, so a disabled breaker still reports what it saw.
  const verdict: string | null =
    state.realisedR <= -limits.maxDailyLossR
      ? `The day is down ${state.realisedR.toFixed(2)}R, at or past the ${limits.maxDailyLossR}R stop. No new setups until tomorrow.`
      : state.consecutiveStops >= limits.maxConsecutiveStops
        ? `${state.consecutiveStops} stop-outs in a row today — the day is over, whatever the next signal looks like.`
        : state.tradesToday >= limits.maxTradesPerDay
          ? `${state.tradesToday} setups already taken today, at the ${limits.maxTradesPerDay} ceiling.`
          : state.openPositions >= limits.maxOpenPositions
            ? `${state.openPositions} positions are already open, at the ${limits.maxOpenPositions} limit — nothing new until one closes.`
            : null;

  if (verdict != null) {
    if (DAILY_RISK_BREAKER_ENABLED) {
      state.riskOff = true;
      state.reason = verdict;
    } else {
      // Recorded, not enforced. Every figure in it is derived from generated
      // setups rather than taken trades, which is why it is not enforced.
      state.suppressedReason = verdict;
    }
  }
  return state;
}

/**
 * Null when trading may continue; otherwise the reason it may not.
 *
 * The manual kill switch still returns a reason while the automated rules are
 * disabled — switching trading off by hand is a human decision and does not
 * rest on the broken input.
 */
export async function riskOffReason(_exchange: Exchange, _mode: TradingMode, limits: RiskLimits = DEFAULT_RISK_LIMITS): Promise<string | null> {
  const state = await readRiskState(limits);
  if (state.riskOff && state.reason) {
    logger.info({ ...state }, 'Risk circuit breaker: RISK_OFF');
    return state.reason;
  }
  // Logged at warn so a suppressed veto is not invisible: the day HAS gone
  // badly on paper, and that is worth seeing even though it no longer blocks.
  if (state.suppressedReason != null) {
    logger.warn(
      { ...state },
      'Risk circuit breaker: rule matched but is DISABLED — not vetoing (counts generated setups, not taken trades)'
    );
  }
  return null;
}

/** Switches trading off until cleared. For a human decision, not an automated one. */
export async function setManualRiskOff(note: string): Promise<void> {
  await redis.set(MANUAL_OVERRIDE_KEY, note);
}

export async function clearManualRiskOff(): Promise<void> {
  await redis.del(MANUAL_OVERRIDE_KEY);
}
