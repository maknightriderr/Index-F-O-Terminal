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
import {
  OPTION_DELTA_BAND_MIN as OPTION_DELTA_BAND_MIN_DEFAULT,
  OPTION_DELTA_BAND_MAX as OPTION_DELTA_BAND_MAX_DEFAULT,
  OPTION_DELTA_TARGET as OPTION_DELTA_TARGET_DEFAULT,
  IV_TARGET_CAP_MULT as IV_TARGET_CAP_MULT_DEFAULT,
  MAX_COST_PCT_OF_PREMIUM as MAX_COST_PCT_OF_PREMIUM_DEFAULT,
  MIN_OPTION_STOP_ATR as MIN_OPTION_STOP_ATR_DEFAULT,
} from '@fno/analytics';

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
 *   2026-09-29.momentum-break.1     the momentum-break trigger family (flag
 *                                   MOMENTUM_BREAK) sharing the sticky slot, its
 *                                   regime assist, and the LEVEL_RECLAIMED /
 *                                   TRIGGER_REVERSAL exits — stamped only while
 *                                   that flag is on (see logicStamp)
 *   2026-09-29.structure.1          the structure family (flag STRUCTURE) and
 *                                   F&O trade validation (FNO_VALIDATION), with
 *                                   the CONSENSUS_SETUPS switch — stamped while
 *                                   STRUCTURE is on (see logicStamp)
 */
export const LOGIC_VERSION = '2026-09-29.coverage-lag.1';

// The momentum-break code ships dark (its backtest failed the go-live bar).
// Stamping every setup with this version while the flag is off would split
// identical logic across two versions in the before/after reports.
export const MOMENTUM_BREAK_LOGIC_VERSION = '2026-09-29.momentum-break.1';

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

// ============================================================
// MOMENTUM-BREAK ROUND (2026-09-29)
// ============================================================
// A separate trigger family (packages/analytics momentum-break): a closed 15m
// bar breaking a key level on range and volume, stop beyond the level, target
// the next level. Its rules were chosen on the in-sample two thirds of a year
// of 15m history and validated ONCE on the last third against a pre-registered
// bar (npm run backtest-momentum; the report is in the PR). The default below
// is whatever that out-of-sample result earned — see MOMENTUM_BREAK_DEFAULT.
// ============================================================

/**
 * OUT-OF-SAMPLE RESULT: pending — set from the single out-of-sample run.
 */
export const MOMENTUM_BREAK_DEFAULT = false;

export interface MomentumBreakParams {
  /** The variant chosen in-sample. Pre-registered grid: {1.2, 1.5}. */
  MOMENTUM_BREAK_RANGE_MULT: number;
  /** The variant chosen in-sample. Pre-registered grid: {1.5, 2.0}. */
  MOMENTUM_BREAK_VOL_MULT: number;
  /** 15m history the live detector loads so its same-slot volume median has 10 previous sessions, like the backtest. */
  MOMENTUM_BREAK_HISTORY_DAYS: number;
  /** Cache TTL of that longer history; the fresh 15m candles are merged over it on every read. */
  MOMENTUM_BREAK_HISTORY_TTL_SECONDS: number;
}

export const MOMENTUM_BREAK_PARAM_DEFAULTS: Readonly<MomentumBreakParams> = {
  MOMENTUM_BREAK_RANGE_MULT: 1.5,
  MOMENTUM_BREAK_VOL_MULT: 1.5,
  MOMENTUM_BREAK_HISTORY_DAYS: 21,
  MOMENTUM_BREAK_HISTORY_TTL_SECONDS: 300,
};

/**
 * Symbols the trigger may run on. The backtest's rule: a symbol needs ≥ 10
 * out-of-sample trades and a non-negative out-of-sample average. With the
 * flag defaulting OFF this list only matters if the flag is switched on.
 */
export const MOMENTUM_BREAK_SYMBOLS_DEFAULT = '';

export function readMomentumBreakFlag(env: Env = process.env): boolean {
  return parseFlag(env.MOMENTUM_BREAK, MOMENTUM_BREAK_DEFAULT);
}

export function readMomentumBreakParams(env: Env = process.env): MomentumBreakParams {
  const out = { ...MOMENTUM_BREAK_PARAM_DEFAULTS };
  for (const key of Object.keys(MOMENTUM_BREAK_PARAM_DEFAULTS) as (keyof MomentumBreakParams)[]) {
    out[key] = parseNumber(env[key], MOMENTUM_BREAK_PARAM_DEFAULTS[key]);
  }
  return out;
}

/** "SYMBOL:EXCHANGE,..." with an explicit empty default (no symbols), unlike BACKGROUND_BIAS_SYMBOLS. */
export function parseMomentumBreakSymbols(raw: string | undefined): { symbols: BackgroundSymbol[]; rejected: string[] } {
  const source = raw == null || raw.trim() === '' ? MOMENTUM_BREAK_SYMBOLS_DEFAULT : raw;
  if (source.trim() === '') return { symbols: [], rejected: [] };
  return parseBackgroundSymbols(source);
}

export const MOMENTUM_BREAK: boolean = readMomentumBreakFlag();
export const MOMENTUM_BREAK_PARAMS: Readonly<MomentumBreakParams> = Object.freeze(readMomentumBreakParams());
const parsedMomentumSymbols = parseMomentumBreakSymbols(process.env.MOMENTUM_BREAK_SYMBOLS);
export const MOMENTUM_BREAK_SYMBOLS: readonly BackgroundSymbol[] = Object.freeze(parsedMomentumSymbols.symbols);
export const MOMENTUM_BREAK_SYMBOLS_REJECTED: readonly string[] = Object.freeze(parsedMomentumSymbols.rejected);

/** Whether the trigger runs for this symbol/mode: flag on, INTRADAY, and on the allow-list. */
export function momentumBreakEnabledFor(
  underlying: string,
  exchange: string,
  mode: string,
  enabled: boolean = MOMENTUM_BREAK,
  symbols: readonly BackgroundSymbol[] = MOMENTUM_BREAK_SYMBOLS
): boolean {
  return enabled && mode === 'INTRADAY' && symbols.some((s) => s.symbol === underlying.toUpperCase() && s.exchange === exchange);
}

// ============================================================
// F&O TRADE VALIDATION (Part A, 2026-09-29)
// ============================================================
// Applies to every setup family. The 29 Sep BSE 3100 PE losses were a ₹7
// "ATM" put at delta -0.19, a 9.4% round trip, an IV of 98-138% against HV
// 27% producing a fake 3.2x target, and a stop 0.94 ATR away — nothing
// refused any of it. With the flag on: strike by |delta| band, the target's
// IV capped at HV × mult, a round-trip cost ceiling, a stop outside the
// underlying's noise, and a next-expiry fallback for a failing 0-DTE contract.
// Flag off = byte-identical old behaviour (the golden snapshots hold that).
// ============================================================

export const FNO_VALIDATION_DEFAULT = true;

export interface FnoValidationParams {
  /** UNTESTED DEFAULT. Lower bound of the traded strike's |delta|. */
  OPTION_DELTA_BAND_MIN: number;
  /** UNTESTED DEFAULT. Upper bound of the traded strike's |delta|. */
  OPTION_DELTA_BAND_MAX: number;
  /** UNTESTED DEFAULT. The |delta| the chosen strike is closest to. */
  OPTION_DELTA_TARGET: number;
  /** UNTESTED DEFAULT. The target's expected move uses IV ≤ HV × this. */
  IV_TARGET_CAP_MULT: number;
  /** UNTESTED DEFAULT. Round-trip cost ceiling, % of entry premium. */
  MAX_COST_PCT_OF_PREMIUM: number;
  /** UNTESTED DEFAULT. Minimum underlying equivalent of the premium stop, in 15m ATR. */
  MIN_OPTION_STOP_ATR: number;
}

export const FNO_VALIDATION_PARAM_DEFAULTS: Readonly<FnoValidationParams> = {
  OPTION_DELTA_BAND_MIN: OPTION_DELTA_BAND_MIN_DEFAULT,
  OPTION_DELTA_BAND_MAX: OPTION_DELTA_BAND_MAX_DEFAULT,
  OPTION_DELTA_TARGET: OPTION_DELTA_TARGET_DEFAULT,
  IV_TARGET_CAP_MULT: IV_TARGET_CAP_MULT_DEFAULT,
  MAX_COST_PCT_OF_PREMIUM: MAX_COST_PCT_OF_PREMIUM_DEFAULT,
  MIN_OPTION_STOP_ATR: MIN_OPTION_STOP_ATR_DEFAULT,
};

export function readFnoValidationFlag(env: Env = process.env): boolean {
  return parseFlag(env.FNO_VALIDATION, FNO_VALIDATION_DEFAULT);
}

export function readFnoValidationParams(env: Env = process.env): FnoValidationParams {
  const out = { ...FNO_VALIDATION_PARAM_DEFAULTS };
  for (const key of Object.keys(FNO_VALIDATION_PARAM_DEFAULTS) as (keyof FnoValidationParams)[]) {
    out[key] = parseNumber(env[key], FNO_VALIDATION_PARAM_DEFAULTS[key]);
  }
  return out;
}

export const FNO_VALIDATION: boolean = readFnoValidationFlag();
export const FNO_VALIDATION_PARAMS: Readonly<FnoValidationParams> = Object.freeze(readFnoValidationParams());

// ============================================================
// STRUCTURE ENGINE ROUND (2026-09-29)
// ============================================================
// A third setup family (packages/analytics structure-engine): a Tier-1
// liquidity pool swept, a displacement the other way, a LIMIT at the
// displacement's fair-value gap. Lifecycle WATCH → DEVELOPING → CONFIRMED is
// shown on screen (Redis structure_setup:*, never the paper-trade slot) and
// only a filled limit (ENTRY) mints a paper trade, through the same mint lock.
//
// STRUCTURE ships ON by the user's decision (live now, behind this flag). Its
// out-of-sample backtest decided CONSENSUS_SETUPS instead: the pre-registered
// bar (≥ 30 trades, avg net R ≥ +0.10, PF ≥ 1.2) was NOT met — see
// CONSENSUS_SETUPS_DEFAULT.
// ============================================================

export const STRUCTURE_LOGIC_VERSION = '2026-09-29.structure.1';
/** Stamped instead of STRUCTURE_LOGIC_VERSION while STRUCTURE_ENTRY_TF = '5m' (15m pools, 5m sweep/displacement/zone/fill). */
export const STRUCTURE_5M_LOGIC_VERSION = '2026-09-29.structure.2';

/** User decision: live now, behind the flag. */
export const STRUCTURE_DEFAULT = true;

// ---- Entry timeframe (structure round 2, 2026-09-30) ----
// Liquidity pools stay on 15m bars; with '5m' the sweep close-back,
// displacement, FVG zone, stop and limit fill run on closed 5m bars
// (evaluateStructureSessionMTF, STRUCTURE_RULES_5M). The default is set by
// the PRE-REGISTERED head-to-head (npm run backtest-structure-5m): 5m goes
// live only if, on the same out-of-sample dates, its avg net R AND PF both
// beat the live 15m config's, with ≥ 20 trades.
//
// RESULT (5m OOS 2026-07-31 → 2026-09-28, 5m-D1.5-C60 chosen in-sample, run
// once): 5m 19 trades, avg net R −0.270, PF 0.64; 15m D1.0-NOGUARD on the same
// dates 23 trades, avg net R −0.046, PF 0.94 — 5m loses on all three checks,
// so it ships OFF: '15m'. 5m still detects the same sweeps ~7 minutes earlier
// on average (median 5); it does not trade them better.
export type StructureEntryTimeframe = '15m' | '5m';
export const STRUCTURE_ENTRY_TF_DEFAULT: StructureEntryTimeframe = '15m';

/** '5m' or '15m' (case-insensitive); anything else — logged at boot via STRUCTURE_ENTRY_TF_REJECTED — is the default. */
export function parseStructureEntryTimeframe(raw: string | undefined): { value: StructureEntryTimeframe; rejected: string | null } {
  if (raw == null || raw.trim() === '') return { value: STRUCTURE_ENTRY_TF_DEFAULT, rejected: null };
  const v = raw.trim().toLowerCase();
  if (v === '5m' || v === '15m') return { value: v, rejected: null };
  return { value: STRUCTURE_ENTRY_TF_DEFAULT, rejected: raw };
}

/**
 * OUT-OF-SAMPLE RESULT (npm run backtest-structure, D1.0-NOGUARD chosen
 * in-sample, run once 2026-06-03 → 2026-09-28): 32 trades, 34.4% win,
 * avg net R −0.005, PF 0.99, max DD 6.44R — FAILS the pre-registered bar
 * (avg ≥ +0.10, PF ≥ 1.2). So the consensus engine keeps minting (ON) and
 * both families run. Had it passed, this would be false: the consensus
 * engine would still compute bias and votes as context but never mint.
 */
export const CONSENSUS_SETUPS_DEFAULT = true;

export interface StructureParams {
  /** The variant chosen in-sample. Pre-registered grid: {1.0, 1.5}. */
  STRUCTURE_DISP_MULT: number;
  /** The variant chosen in-sample: 0 = the 60-minute opening guard does not apply to this family's fills, 1 = it does. */
  STRUCTURE_OPENING_GUARD: number;
  /** Lifecycle state TTL in Redis (structure_setup:*). Operational, not a trading threshold. */
  STRUCTURE_STATE_TTL_SECONDS: number;
  /** A CONFIRMED transition older than this (minutes) is recorded but not pushed to Telegram — a restart must not send stale alerts. */
  STRUCTURE_ALERT_MAX_AGE_MIN: number;
  /**
   * The structure engine's own closing guard: no fill is minted with fewer
   * than this many minutes to the close (the consensus engine keeps
   * SETUP_CLOSING_GUARD_MINUTES = 60, its targets being time-scaled).
   * Pre-registered choice between 60 and 15, made by the backtest for the
   * live timeframe: 15m in-sample 2025-09-29 → 2026-06-02, D1.0 no opening
   * guard — C60 avg net R −0.138 (71 trades) vs C15 −0.166 (76) → 60. (The
   * chosen 5m variant also carries 60.) Applies only while CLOSING_GUARD is on.
   */
  STRUCTURE_CLOSING_GUARD_MIN: number;
  /**
   * DISP_MULT used only while STRUCTURE_ENTRY_TF = '5m': the 5m backtest's
   * in-sample choice (5m-D1.5-C60 — the variant that was run out of sample),
   * so switching the timeframe runs the tested 5m config. The 15m engine
   * keeps STRUCTURE_DISP_MULT.
   */
  STRUCTURE_5M_DISP_MULT: number;
}

export const STRUCTURE_PARAM_DEFAULTS: Readonly<StructureParams> = {
  STRUCTURE_DISP_MULT: 1.0,
  STRUCTURE_OPENING_GUARD: 0,
  STRUCTURE_STATE_TTL_SECONDS: 60 * 60 * 36,
  STRUCTURE_ALERT_MAX_AGE_MIN: 30,
  STRUCTURE_CLOSING_GUARD_MIN: 60,
  STRUCTURE_5M_DISP_MULT: 1.5,
};

/** Empty = every symbol the engine evaluates (the user's default). Otherwise "SYMBOL:EXCHANGE,...". */
export const STRUCTURE_SYMBOLS_DEFAULT = '';

export function readStructureFlag(env: Env = process.env): boolean {
  return parseFlag(env.STRUCTURE, STRUCTURE_DEFAULT);
}

export function readConsensusSetupsFlag(env: Env = process.env): boolean {
  return parseFlag(env.CONSENSUS_SETUPS, CONSENSUS_SETUPS_DEFAULT);
}

export function readStructureParams(env: Env = process.env): StructureParams {
  const out = { ...STRUCTURE_PARAM_DEFAULTS };
  for (const key of Object.keys(STRUCTURE_PARAM_DEFAULTS) as (keyof StructureParams)[]) {
    out[key] = parseNumber(env[key], STRUCTURE_PARAM_DEFAULTS[key]);
  }
  return out;
}

/** "SYMBOL:EXCHANGE,..."; empty (the default) means all symbols. */
export function parseStructureSymbols(raw: string | undefined): { all: boolean; symbols: BackgroundSymbol[]; rejected: string[] } {
  const source = raw == null ? STRUCTURE_SYMBOLS_DEFAULT : raw;
  if (source.trim() === '') return { all: true, symbols: [], rejected: [] };
  return { all: false, ...parseBackgroundSymbols(source) };
}

export const STRUCTURE: boolean = readStructureFlag();
export const CONSENSUS_SETUPS: boolean = readConsensusSetupsFlag();
export const STRUCTURE_PARAMS: Readonly<StructureParams> = Object.freeze(readStructureParams());
const parsedStructureSymbols = parseStructureSymbols(process.env.STRUCTURE_SYMBOLS);
export const STRUCTURE_SYMBOLS: Readonly<{ all: boolean; symbols: readonly BackgroundSymbol[] }> = Object.freeze({
  all: parsedStructureSymbols.all,
  symbols: Object.freeze(parsedStructureSymbols.symbols),
});
export const STRUCTURE_SYMBOLS_REJECTED: readonly string[] = Object.freeze(parsedStructureSymbols.rejected);
const parsedStructureEntryTf = parseStructureEntryTimeframe(process.env.STRUCTURE_ENTRY_TF);
export const STRUCTURE_ENTRY_TF: StructureEntryTimeframe = parsedStructureEntryTf.value;
/** A STRUCTURE_ENTRY_TF value that was not '5m'/'15m' (null when valid or unset) — logged at boot. */
export const STRUCTURE_ENTRY_TF_REJECTED: string | null = parsedStructureEntryTf.rejected;

/** Whether the structure engine runs for this symbol/mode: flag on, INTRADAY, and on the list (empty list = all). */
export function structureEnabledFor(
  underlying: string,
  exchange: string,
  mode: string,
  enabled: boolean = STRUCTURE,
  symbols: Readonly<{ all: boolean; symbols: readonly BackgroundSymbol[] }> = STRUCTURE_SYMBOLS
): boolean {
  return enabled && mode === 'INTRADAY' && (symbols.all || symbols.symbols.some((s) => s.symbol === underlying.toUpperCase() && s.exchange === exchange));
}

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
  /** The momentum-break round's switch, tunables and allow-list (absent on setups minted before it). */
  momentumBreak?: {
    enabled: boolean;
    params: MomentumBreakParams;
    symbols: BackgroundSymbol[];
  };
  /** Part A's switch and tunables (absent on setups minted before it). */
  fnoValidation?: {
    enabled: boolean;
    params: FnoValidationParams;
  };
  /** The structure round's switches, tunables and symbol list (absent on setups minted before it). */
  structure?: {
    enabled: boolean;
    consensusSetups: boolean;
    params: StructureParams;
    allSymbols: boolean;
    symbols: BackgroundSymbol[];
    /** STRUCTURE_ENTRY_TF (absent on setups minted before it: 15m). */
    entryTimeframe?: StructureEntryTimeframe;
  };
}

/**
 * The rounds after momentum-break, passed as one trailing object so the
 * positional signature above (and every test that pins it) is unchanged.
 * Omitted = not recorded, and the version is decided exactly as before.
 */
export interface LogicStampExtras {
  fnoValidation?: { enabled: boolean; params: Readonly<FnoValidationParams> };
  structure?: {
    enabled: boolean;
    consensusSetups: boolean;
    params: Readonly<StructureParams>;
    symbols: Readonly<{ all: boolean; symbols: readonly BackgroundSymbol[] }>;
    /** Absent = '15m' (the stamp then reads exactly as before). */
    entryTimeframe?: StructureEntryTimeframe;
  };
}

/** What gets written onto every setup and decision. */
export function logicStamp(
  flags: Readonly<TradingFlags> = TRADING_FLAGS,
  params: Readonly<TradingParams> = TRADING_PARAMS,
  lagFlags: Readonly<CoverageLagFlags> = COVERAGE_LAG_FLAGS,
  lagParams: Readonly<CoverageLagParams> = COVERAGE_LAG_PARAMS,
  backgroundSymbols: readonly BackgroundSymbol[] = BACKGROUND_BIAS_SYMBOLS,
  momentumEnabled: boolean = MOMENTUM_BREAK,
  momentumParams: Readonly<MomentumBreakParams> = MOMENTUM_BREAK_PARAMS,
  momentumSymbols: readonly BackgroundSymbol[] = MOMENTUM_BREAK_SYMBOLS,
  extras: LogicStampExtras = {}
): LogicStamp {
  // The structure version is stamped only while its flag is on (the same
  // mechanism as momentum-break), and takes precedence when both are.
  // 5m entries are a different rule set, so they carry their own version.
  const logicVersion = extras.structure?.enabled
    ? extras.structure.entryTimeframe === '5m'
      ? STRUCTURE_5M_LOGIC_VERSION
      : STRUCTURE_LOGIC_VERSION
    : momentumEnabled
      ? MOMENTUM_BREAK_LOGIC_VERSION
      : LOGIC_VERSION;
  return {
    logicVersion,
    flags: { ...flags },
    params: { ...params },
    coverageLag: { flags: { ...lagFlags }, params: { ...lagParams }, backgroundSymbols: backgroundSymbols.map((s) => ({ ...s })) },
    momentumBreak: { enabled: momentumEnabled, params: { ...momentumParams }, symbols: momentumSymbols.map((s) => ({ ...s })) },
    ...(extras.fnoValidation ? { fnoValidation: { enabled: extras.fnoValidation.enabled, params: { ...extras.fnoValidation.params } } } : {}),
    ...(extras.structure
      ? {
          structure: {
            enabled: extras.structure.enabled,
            consensusSetups: extras.structure.consensusSetups,
            params: { ...extras.structure.params },
            allSymbols: extras.structure.symbols.all,
            symbols: extras.structure.symbols.symbols.map((s) => ({ ...s })),
            ...(extras.structure.entryTimeframe ? { entryTimeframe: extras.structure.entryTimeframe } : {}),
          },
        }
      : {}),
  };
}

/** The stamp with every live switch — what the engine writes on setups and decisions. */
export function liveLogicStamp(): LogicStamp {
  return logicStamp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    fnoValidation: { enabled: FNO_VALIDATION, params: FNO_VALIDATION_PARAMS },
    structure: { enabled: STRUCTURE, consensusSetups: CONSENSUS_SETUPS, params: STRUCTURE_PARAMS, symbols: STRUCTURE_SYMBOLS, entryTimeframe: STRUCTURE_ENTRY_TF },
  });
}
