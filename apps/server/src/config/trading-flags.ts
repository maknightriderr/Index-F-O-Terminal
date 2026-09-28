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
 *
 * History:
 *   2026-09-28.validation-review.1  structural stop, location/room gates,
 *                                   concurrency cap, closing guard, rich-IV R:R
 *   2026-09-29.coverage-lag.1       background bias evaluator + mint lock,
 *                                   intraday positioning window, faster intraday
 *                                   regime, MCX positional in the background, and
 *                                   the MCX close-time correction (US DST 23:30)
 */
export const LOGIC_VERSION = '2026-09-29.coverage-lag.1';

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

// ============================================================
// COVERAGE / LAG ROUND (2026-09-29)
// ============================================================
// The 28 Sep CRUDEOIL fall (9292 -> 9020, 16:30-19:30 IST) produced no setup:
// MCX/BSE were only evaluated while a browser watched them, every positioning
// vote was measured against yesterday's close, and the regime needed hours of
// 1H ADX to leave RANGE_BOUND. Each fix below is its own switch, env-
// configurable, and OFF gives the pre-round behaviour.
//
// Kept as a separate set from TradingFlags on purpose: the validation-review
// set (and its tests) stays exactly as shipped, and the logic stamp carries
// both under their own keys.
// ============================================================

export interface CoverageLagFlags {
  /**
   * Evaluate BACKGROUND_BIAS_SYMBOLS on a timer with no browser open, and take
   * a Redis mint lock around the setup-creating branch so concurrent callers
   * (browser + evaluator + scanners) can never double-mint a setup, a decision
   * row or a Telegram message. Also puts those symbols first in the capture pass.
   */
  BACKGROUND_BIAS: boolean;
  /** INTRADAY only: futures OI / PCR / option OI flow / OI shifts measured over the last N minutes of captured snapshots, not since yesterday's close. */
  INTRADAY_POSITIONING: boolean;
  /** INTRADAY only: 15m ADX fallback when 1H ADX reads no trend, and BREAKOUT/BREAKDOWN held while price stays beyond the Bollinger midline. */
  FAST_INTRADAY_REGIME: boolean;
  /** The background evaluator also runs POSITIONAL mode for MCX symbols (15-30 DTE, multi-day move, 40% stop). */
  MCX_POSITIONAL_BACKGROUND: boolean;
}

export const COVERAGE_LAG_FLAG_DEFAULTS: Readonly<CoverageLagFlags> = {
  BACKGROUND_BIAS: true,
  INTRADAY_POSITIONING: true,
  FAST_INTRADAY_REGIME: true,
  MCX_POSITIONAL_BACKGROUND: true,
};

export interface CoverageLagParams {
  /** Background evaluator tick. Operational cadence, not a trading threshold. */
  BACKGROUND_BIAS_INTERVAL_MS: number;
  /** Skip a background read when anyone computed that symbol/mode this recently (a browser is already on it). */
  BACKGROUND_BIAS_RECENT_READ_MS: number;
  /** Intraday positioning window, minutes. UNTESTED DEFAULT — chosen, not fitted to outcomes. */
  INTRADAY_POSITIONING_WINDOW_MIN: number;
  /** Snapshots needed inside the window before an intraday vote replaces the day-level one. */
  INTRADAY_POSITIONING_MIN_SNAPSHOTS: number;
  /** The newest snapshot must be at most this old (minutes), else the day-level vote is used. */
  INTRADAY_POSITIONING_MAX_AGE_MIN: number;
  /** Change in OI-PCR over the window that starts a PCR vote. UNTESTED DEFAULT. */
  INTRADAY_PCR_DELTA_ENTER: number;
  /** Change in OI-PCR over the window a PCR vote holds through (hysteresis). UNTESTED DEFAULT. */
  INTRADAY_PCR_DELTA_HOLD: number;
  /** 15m bars a BREAKOUT/BREAKDOWN regime may persist while price holds beyond the midline. UNTESTED DEFAULT. */
  BREAKOUT_PERSIST_BARS: number;
  /** TTL of the setup mint lock. Only needs to outlast one mint (a few DB/Redis writes). */
  SETUP_MINT_LOCK_TTL_SECONDS: number;
  /** How long a caller that lost the mint race waits for the winner's setup to appear before giving up for this poll. */
  SETUP_MINT_LOCK_WAIT_MS: number;
}

export const COVERAGE_LAG_PARAM_DEFAULTS: Readonly<CoverageLagParams> = {
  BACKGROUND_BIAS_INTERVAL_MS: 120_000,
  BACKGROUND_BIAS_RECENT_READ_MS: 60_000,
  INTRADAY_POSITIONING_WINDOW_MIN: 60,
  INTRADAY_POSITIONING_MIN_SNAPSHOTS: 3,
  INTRADAY_POSITIONING_MAX_AGE_MIN: 20,
  INTRADAY_PCR_DELTA_ENTER: 0.05,
  INTRADAY_PCR_DELTA_HOLD: 0.02,
  BREAKOUT_PERSIST_BARS: 4,
  SETUP_MINT_LOCK_TTL_SECONDS: 30,
  SETUP_MINT_LOCK_WAIT_MS: 5_000,
};

export interface BackgroundSymbol {
  symbol: string;
  exchange: 'NSE' | 'BSE' | 'MCX';
}

/** The non-NSE dashboard symbols. NSE indices stay with the market scanner. */
export const BACKGROUND_BIAS_SYMBOLS_DEFAULT = 'SENSEX:BSE,CRUDEOIL:MCX,GOLD:MCX';

/** "SYMBOL:EXCHANGE,..." -> the valid entries, plus what was rejected so the caller can log it. */
export function parseBackgroundSymbols(raw: string | undefined): { symbols: BackgroundSymbol[]; rejected: string[] } {
  const source = raw == null || raw.trim() === '' ? BACKGROUND_BIAS_SYMBOLS_DEFAULT : raw;
  const symbols: BackgroundSymbol[] = [];
  const rejected: string[] = [];
  for (const entry of source.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [sym, ex] = entry.split(':').map((p) => p?.trim().toUpperCase());
    if (sym && (ex === 'NSE' || ex === 'BSE' || ex === 'MCX')) {
      if (!symbols.some((s) => s.symbol === sym && s.exchange === ex)) symbols.push({ symbol: sym, exchange: ex });
    } else {
      rejected.push(entry);
    }
  }
  return { symbols, rejected };
}

export function readCoverageLagFlags(env: Env = process.env): CoverageLagFlags {
  const out = { ...COVERAGE_LAG_FLAG_DEFAULTS };
  for (const key of Object.keys(COVERAGE_LAG_FLAG_DEFAULTS) as (keyof CoverageLagFlags)[]) {
    out[key] = parseFlag(env[key], COVERAGE_LAG_FLAG_DEFAULTS[key]);
  }
  return out;
}

export function readCoverageLagParams(env: Env = process.env): CoverageLagParams {
  const out = { ...COVERAGE_LAG_PARAM_DEFAULTS };
  for (const key of Object.keys(COVERAGE_LAG_PARAM_DEFAULTS) as (keyof CoverageLagParams)[]) {
    out[key] = parseNumber(env[key], COVERAGE_LAG_PARAM_DEFAULTS[key]);
  }
  return out;
}

export const COVERAGE_LAG_FLAGS: Readonly<CoverageLagFlags> = Object.freeze(readCoverageLagFlags());
export const COVERAGE_LAG_PARAMS: Readonly<CoverageLagParams> = Object.freeze(readCoverageLagParams());
const parsedBackgroundSymbols = parseBackgroundSymbols(process.env.BACKGROUND_BIAS_SYMBOLS);
export const BACKGROUND_BIAS_SYMBOLS: readonly BackgroundSymbol[] = Object.freeze(parsedBackgroundSymbols.symbols);
export const BACKGROUND_BIAS_SYMBOLS_REJECTED: readonly string[] = Object.freeze(parsedBackgroundSymbols.rejected);

export interface LogicStamp {
  logicVersion: string;
  flags: TradingFlags;
  params: TradingParams;
  /** The coverage/lag round's switches and tunables (absent on setups minted before it). */
  coverageLag?: {
    flags: CoverageLagFlags;
    params: CoverageLagParams;
    backgroundSymbols: BackgroundSymbol[];
  };
}

/** What gets written onto every setup and decision. */
export function logicStamp(
  flags: Readonly<TradingFlags> = TRADING_FLAGS,
  params: Readonly<TradingParams> = TRADING_PARAMS,
  lagFlags: Readonly<CoverageLagFlags> = COVERAGE_LAG_FLAGS,
  lagParams: Readonly<CoverageLagParams> = COVERAGE_LAG_PARAMS,
  backgroundSymbols: readonly BackgroundSymbol[] = BACKGROUND_BIAS_SYMBOLS
): LogicStamp {
  return {
    logicVersion: LOGIC_VERSION,
    flags: { ...flags },
    params: { ...params },
    coverageLag: { flags: { ...lagFlags }, params: { ...lagParams }, backgroundSymbols: backgroundSymbols.map((s) => ({ ...s })) },
  };
}
