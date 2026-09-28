// ============================================================
// TRADING FLAGS — validation-review fixes, each behind its own switch
// ============================================================
// Every behaviour change from the validation review sits behind one flag
// here, read from an environment variable so it can be flipped in Railway
// with no code change. A flag that is OFF gives byte-identical old
// behaviour; trade-setup-golden.test.ts holds that contract.
//
// The analytics package never reads these. The server reads them here and
// hands the booleans and numbers to buildTradeSetup through its options
// object, so packages/analytics stays pure.
//
// Every setup (signals.inputs.logic) and every decision
// (decision_snapshots.logic_version / logic_flags, migration 026) is stamped
// with LOGIC_VERSION and the flag set that was live, so trades taken under
// different rules are never pooled when the results are read.
//
// Deliberately NOT here: DAILY_RISK_BREAKER_ENABLED stays a compiled `false`
// in risk-circuit-breaker.ts, and none of the protected constants in
// protected-constants.ts is configurable from this file.
// ============================================================

import { RICH_IV_MIN_RISK_REWARD as RICH_IV_MIN_RISK_REWARD_DEFAULT, STRUCTURAL_STOP_BUFFER_ATR as STRUCTURAL_STOP_BUFFER_ATR_DEFAULT } from '@fno/analytics';

/**
 * Bumped whenever the rules that decide a setup change. Rows written before
 * this existed carry no version at all and read as the pre-review engine.
 */
export const LOGIC_VERSION = '2026-09-28.validation-review.1';

export interface TradingFlags {
  /** Fix 1: stop sized from structure and never squeezed to fit R:R. */
  STRUCTURAL_STOP: boolean;
  /** Fix 2: refuse POOR_LOCATION below LOCATION_GATE_MIN_SCORE. */
  LOCATION_GATE: boolean;
  /** Fix 2: refuse INSUFFICIENT_ROOM on the corrected (V2) room measure. No outcome data yet. */
  ROOM_GATE: boolean;
  /** Fix 4: refuse CONCURRENT_EXPOSURE at MAX_CONCURRENT_SAME_DIRECTION. A quantity limit, like the breaker. */
  CONCURRENCY_CAP: boolean;
  /** Fix 5: refuse new INTRADAY setups in the last SETUP_CLOSING_GUARD_MINUTES of the session. */
  CLOSING_GUARD: boolean;
  /** Fix 6: require RICH_IV_MIN_RISK_REWARD instead of MIN_RISK_REWARD when IV is rich against HV. */
  RICH_IV_RR: boolean;
}

export const TRADING_FLAG_DEFAULTS: Readonly<TradingFlags> = {
  STRUCTURAL_STOP: true,
  LOCATION_GATE: true,
  ROOM_GATE: false,
  CONCURRENCY_CAP: false,
  CLOSING_GUARD: true,
  RICH_IV_RR: true,
};

export interface TradingParams {
  /**
   * ATR beyond the nearest structural level the structural stop sits at.
   * UNTESTED DEFAULT — chosen as a small buffer, not fitted to outcomes.
   */
  STRUCTURAL_STOP_BUFFER_ATR: number;
  /** The existing shadow threshold for POOR_LOCATION (location score < 40), not a new number. */
  LOCATION_GATE_MIN_SCORE: number;
  /** Same-direction + correlated live setups at which CONCURRENT_EXPOSURE refuses. */
  MAX_CONCURRENT_SAME_DIRECTION: number;
  /** Minutes before the exchange close after which no new INTRADAY setup is built. */
  SETUP_CLOSING_GUARD_MINUTES: number;
  /** Reward:risk required when IV is RICH against HV. MIN_RISK_REWARD itself is untouched. */
  RICH_IV_MIN_RISK_REWARD: number;
}

export const TRADING_PARAM_DEFAULTS: Readonly<TradingParams> = {
  STRUCTURAL_STOP_BUFFER_ATR: STRUCTURAL_STOP_BUFFER_ATR_DEFAULT,
  LOCATION_GATE_MIN_SCORE: 40,
  MAX_CONCURRENT_SAME_DIRECTION: 3,
  SETUP_CLOSING_GUARD_MINUTES: 60,
  RICH_IV_MIN_RISK_REWARD: RICH_IV_MIN_RISK_REWARD_DEFAULT,
};

type Env = Record<string, string | undefined>;

/** 'true'/'1'/'on'/'yes' → true, 'false'/'0'/'off'/'no' → false, anything else → the default. */
export function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(v)) return true;
  if (['false', '0', 'off', 'no'].includes(v)) return false;
  return fallback;
}

/** A finite, non-negative number, or the default. */
export function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readTradingFlags(env: Env = process.env): TradingFlags {
  const out = { ...TRADING_FLAG_DEFAULTS };
  for (const key of Object.keys(TRADING_FLAG_DEFAULTS) as (keyof TradingFlags)[]) {
    out[key] = parseFlag(env[key], TRADING_FLAG_DEFAULTS[key]);
  }
  return out;
}

export function readTradingParams(env: Env = process.env): TradingParams {
  const out = { ...TRADING_PARAM_DEFAULTS };
  for (const key of Object.keys(TRADING_PARAM_DEFAULTS) as (keyof TradingParams)[]) {
    out[key] = parseNumber(env[key], TRADING_PARAM_DEFAULTS[key]);
  }
  return out;
}

/** Read once at boot. A Railway variable change redeploys the service, which re-reads them. */
export const TRADING_FLAGS: Readonly<TradingFlags> = Object.freeze(readTradingFlags());
export const TRADING_PARAMS: Readonly<TradingParams> = Object.freeze(readTradingParams());

export interface LogicStamp {
  logicVersion: string;
  flags: TradingFlags;
  params: TradingParams;
}

/** What gets written onto every setup and decision. */
export function logicStamp(flags: Readonly<TradingFlags> = TRADING_FLAGS, params: Readonly<TradingParams> = TRADING_PARAMS): LogicStamp {
  return { logicVersion: LOGIC_VERSION, flags: { ...flags }, params: { ...params } };
}
