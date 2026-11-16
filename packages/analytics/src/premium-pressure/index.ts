// ============================================================
// EXPIRY PREMIUM PRESSURE & WRITER DOMINANCE (GXP-1.0) — inside the gamma-exposure read, paper only
// ============================================================
// Pure and deterministic: a series of option-chain samples in, one analysis out. No I/O, no clock, no broker.
//
// What it reads, per side (CE / PE), on ATM +/- 2 strikes (only strikes with a live two-sided book):
//   1. Premium change over rolling windows (default 1 / 3 / 5 / 10 minutes), velocity and acceleration.
//   2. A repricing decomposition of that change:  dP ~ delta*dS + 0.5*gamma*dS^2 + theta*dt + vega*dIV  (+ residual).
//      Units: theta per CALENDAR day (dt in days), vega per 1 volatility point (IV in percent), as greeks/index.ts.
//      "Pressure" is the part of the premium change that is neither the underlying's move nor time decay
//      (the IV term plus the residual). A premium that fell only by theta is NOT writing pressure.
//   3. OI and volume change over the window, read with the premium as a PROBABILISTIC label (writing / short covering /
//      long build-up / long unwinding). OI alone never identifies who traded.
//   4. Estimated GEX context (the existing calculateGammaExposure convention: calls +, puts -; an ESTIMATE, dealer books
//      are not observable), plus an estimated gamma-flip level from repricing gamma on a spot grid.
//
// Nothing is a hard directional rule: GEX is context, weights are configurable, and a missing input lowers confidence
// instead of counting as neutral or positive. Insufficient data is DATA_GAP, never a signal.
// ============================================================

import { calculateGreeks } from '../greeks/index.js';

export const GXP_VERSION = 'GXP-1.0';
export const GXP_STRATEGY_ID = 'GXP_PREMIUM_PRESSURE_V1';

export type PpSide = 'CE' | 'PE';
export type PpPeriod = 'NON_EXPIRY' | 'EXPIRY' | 'EXPIRY_LAST_60' | 'EXPIRY_LAST_30';
export type PpClass = 'BULLISH_PREMIUM_PRESSURE' | 'BEARISH_PREMIUM_PRESSURE' | 'DUAL_SIDE_COMPRESSION' | 'PREMIUM_TRAP' | 'NONE' | 'DATA_GAP';
export type PpState = 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH' | 'LOW_CONFIDENCE' | 'DATA_GAP';
export type PpDecay = 'DIRECTIONAL_DECAY' | 'THETA_DOMINATED_DECAY' | 'IV_CRUSH_DOMINATED' | 'MIXED_DECAY' | 'UNCLASSIFIED' | 'NOT_DECAYING';
export type PpOiRead = 'POTENTIAL_WRITING' | 'POTENTIAL_SHORT_COVERING' | 'POTENTIAL_LONG_BUILDUP' | 'POTENTIAL_LONG_UNWINDING' | 'UNCLEAR';

export interface PpLeg {
  ltp: number; bid: number; ask: number;
  oi: number | null; volume: number | null;
  /** Percent (14 = 14%). */
  iv: number | null;
  delta: number | null; gamma: number | null;
  /** Per calendar day (negative for a long option). */
  theta: number | null;
  /** Per 1 volatility point. */
  vega: number | null;
}
export interface PpStrike { strike: number; call: PpLeg | null; put: PpLeg | null }
export interface PpSample {
  /** When the chain was read (epoch ms). */
  at: number;
  spot: number;
  /** When the underlying price was observed; a gap to `at` beyond the config is a dislocation (DATA_GAP). */
  spotAt?: number;
  expiry: string;
  /** Minutes from `at` to the contract's expiry instant. */
  minutesToExpiry: number;
  strikeStep: number;
  strikes: PpStrike[];
}

export interface PpPeriodRules {
  /** Composite score (0-100, either sign) for a directional class / for STRONG. */
  entryScore: number; strongScore: number;
  minPremium: number; maxSpreadPct: number;
  /** Which window (index into `windows`) the decomposition and scores read first; falls back to the others. */
  primary: number;
  /** Paper entries allowed in this period (the adapter still prices, sizes and applies costs). */
  entries: boolean;
}
export interface PpWeights { premium: number; oiVolume: number; underlying: number; gex: number; decomposition: number }
export interface PpConfig {
  /** Rolling windows in minutes, ascending. */
  windows: readonly number[];
  /** A window is read from the sample nearest its start, within this fraction of the window (min 30 s). */
  windowTolerance: number;
  strikesEachSide: number;
  minLiquidStrikes: number;
  maxSampleAgeMs: number;
  maxSpotSkewMs: number;
  /** A spot jump between consecutive samples above this many expected one-window moves is a feed discontinuity. */
  maxSpotJumpSigma: number;
  weights: PpWeights;
  periods: Record<PpPeriod, PpPeriodRules>;
  minConfidence: number;
  /** Trading minutes per year for the expected-move normaliser (252 sessions x 375 minutes). */
  minutesPerYear: number;
}

/** Initial values: research defaults, NOT validated predictive values. Every one is configurable. */
export const GXP_CONFIG: PpConfig = Object.freeze({
  windows: [1, 3, 5, 10],
  windowTolerance: 0.4,
  strikesEachSide: 2,
  minLiquidStrikes: 3,
  maxSampleAgeMs: 150_000,
  maxSpotSkewMs: 20_000,
  maxSpotJumpSigma: 8,
  weights: { premium: 25, oiVolume: 20, underlying: 20, gex: 20, decomposition: 15 },
  periods: {
    NON_EXPIRY: { entryScore: 35, strongScore: 60, minPremium: 5, maxSpreadPct: 3, primary: 3, entries: true },
    EXPIRY: { entryScore: 38, strongScore: 60, minPremium: 3, maxSpreadPct: 5, primary: 2, entries: true },
    EXPIRY_LAST_60: { entryScore: 48, strongScore: 65, minPremium: 3, maxSpreadPct: 6, primary: 1, entries: true },
    EXPIRY_LAST_30: { entryScore: 55, strongScore: 70, minPremium: 2, maxSpreadPct: 8, primary: 1, entries: false },
  },
  minConfidence: 45,
  minutesPerYear: 252 * 375,
}) as PpConfig;

export interface PpDecomposition {
  windowMin: number; actual: number; directional: number; theta: number; vega: number; residual: number;
  /** actual - directional - theta: the change the underlying and the clock do not explain. */
  pressure: number;
  classification: PpDecay; reliable: boolean;
}
export interface PpStrikeRow {
  strike: number;
  ce: { premium: number; changePct: number | null; oiChangePct: number | null; oiRead: PpOiRead; pressurePct: number | null } | null;
  pe: { premium: number; changePct: number | null; oiChangePct: number | null; oiRead: PpOiRead; pressurePct: number | null } | null;
  pressure: 'BULLISH' | 'BEARISH' | 'DUAL_COMPRESSION' | 'NEUTRAL' | 'NO_DATA';
}
export interface PpSideRead {
  side: PpSide; liquidStrikes: number;
  /** Mean premium change % per window (null when that window has no sample). */
  changePct: Array<number | null>;
  /** % per minute over the primary window, and short-window rate minus long-window rate. */
  velocity: number | null; acceleration: number | null;
  /** Premium change over the primary window in expected-move units (delta x expected underlying move), mean over strikes. */
  normalizedChange: number | null;
  /** Pressure (see PpDecomposition) as % of premium and in expected-move units; negative = pressed down. */
  pressurePct: number | null; pressureZ: number | null;
  ivChange: number | null; oiChangePct: number | null;
  /** Volume traded in the window against the session's average rate for the same length (null without a session open). */
  volumeRatio: number | null;
  /** Share of liquid strikes whose premium + OI read as potential writing. */
  writingShare: number;
  /** Windows (of those available) in which the premium fell / rose. */
  compressionWindows: number; expansionWindows: number; windowsAvailable: number;
  decay: PpDecay; decompositionReliable: boolean;
  /** 0-100. Built from pressure-compression (40), OI increase (25), volume (15), multi-strike consistency (20). */
  writerPressure: number;
  writerParts: { compression: number; oi: number | null; volume: number | null; consistency: number };
}
export interface PpGex {
  estimated: true;
  netGex: number; regime: 'LONG_GAMMA' | 'SHORT_GAMMA' | 'NEUTRAL';
  netGexChange: number | null;
  gammaWall: number | null;
  /** Largest positive / negative per-strike estimated GEX. */
  topPositive: number[]; topNegative: number[];
  callGammaShare: number | null;
  /** Share of gross gamma x OI sitting within one strike of ATM. */
  atmConcentration: number | null;
  gammaFlip: number | null; spotVsFlipPct: number | null;
  flipCrossed: 'UP' | 'DOWN' | null;
  pinned: boolean;
}
export interface PpComponents { premium: number | null; oiVolume: number | null; underlying: number | null; gex: number | null; decomposition: number | null }
export interface PpAnalysis {
  version: string; symbol: string; at: number; expiry: string; period: PpPeriod; minutesToExpiry: number;
  spot: number; atm: number;
  classification: PpClass; state: PpState;
  /** -100..100, positive bullish. */
  score: number; confidence: number;
  components: PpComponents;
  dataQuality: { status: 'OK' | 'DEGRADED' | 'DATA_GAP'; issues: string[] };
  ce: PpSideRead | null; pe: PpSideRead | null;
  gex: PpGex | null;
  underlying: { changePct: Array<number | null>; moveSigma: number | null };
  rows: PpStrikeRow[];
  trap: { side: PpSide; detail: string } | null;
  explanation: string[];
  invalidation: string[];
}

export interface PpInput {
  symbol: string; now: number;
  /** Same expiry, any order; older samples give the windows. */
  samples: readonly PpSample[];
  /** Session open (epoch ms): enables the volume-rate confirmation. */
  sessionOpen?: number;
  config?: PpConfig;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function ppPeriod(minutesToExpiry: number): PpPeriod {
  // Expiry "day" = the last session: within 6.5 hours of the expiry instant.
  if (minutesToExpiry > 6.5 * 60) return 'NON_EXPIRY';
  return minutesToExpiry <= 30 ? 'EXPIRY_LAST_30' : minutesToExpiry <= 60 ? 'EXPIRY_LAST_60' : 'EXPIRY';
}

const liquid = (l: PpLeg | null, rules: PpPeriodRules): l is PpLeg =>
  !!l && fin(l.ltp) && l.ltp >= rules.minPremium && l.bid > 0 && l.ask >= l.bid && ((l.ask - l.bid) / ((l.ask + l.bid) / 2)) * 100 <= rules.maxSpreadPct && (l.volume == null || l.volume > 0);

const legOf = (s: PpStrike | undefined, side: PpSide) => (s ? (side === 'CE' ? s.call : s.put) : null);

/** The sample nearest `now - minutes`, inside the tolerance; null when the window cannot be read. */
export function ppSampleAt(samples: readonly PpSample[], now: number, minutes: number, tolerance: number): PpSample | null {
  const target = now - minutes * 60_000, tol = Math.max(30_000, minutes * 60_000 * tolerance);
  let best: PpSample | null = null;
  for (const s of samples) if (Math.abs(s.at - target) <= tol && (!best || Math.abs(s.at - target) < Math.abs(best.at - target))) best = s;
  return best;
}

export function ppOiRead(premiumChangePct: number | null, oiChangePct: number | null): PpOiRead {
  if (premiumChangePct == null || oiChangePct == null) return 'UNCLEAR';
  // Dead bands: a tick of premium or a rounding of OI is not a read.
  if (Math.abs(premiumChangePct) < 0.5 || Math.abs(oiChangePct) < 0.2) return 'UNCLEAR';
  if (premiumChangePct < 0) return oiChangePct > 0 ? 'POTENTIAL_WRITING' : 'POTENTIAL_LONG_UNWINDING';
  return oiChangePct > 0 ? 'POTENTIAL_LONG_BUILDUP' : 'POTENTIAL_SHORT_COVERING';
}

/** dP ~ delta*dS + 0.5*gamma*dS^2 + theta*dt + vega*dIV, on the average of the two samples' Greeks. */
export function ppDecompose(before: PpLeg, after: PpLeg, dSpot: number, elapsedMin: number, windowMin: number): PpDecomposition {
  const actual = after.ltp - before.ltp;
  const avg = (a: number | null, b: number | null) => (fin(a) && fin(b) ? (a + b) / 2 : fin(a) ? a : fin(b) ? b : null);
  const delta = avg(before.delta, after.delta), gamma = avg(before.gamma, after.gamma), theta = avg(before.theta, after.theta), vega = avg(before.vega, after.vega);
  const dIv = fin(before.iv) && fin(after.iv) ? after.iv - before.iv : null;
  const have = delta != null && gamma != null && theta != null;
  const directional = have ? delta! * dSpot + 0.5 * gamma! * dSpot * dSpot : 0;
  const th = have ? theta! * (elapsedMin / 1440) : 0;
  const vg = vega != null && dIv != null ? vega * dIv : 0;
  const residual = actual - directional - th - vg;
  const pressure = actual - directional - th;
  const noise = Math.max(0.05, Math.abs(before.ltp) * 0.004);
  // Unreliable: Greeks missing, or the model leaves more than half of a real move unexplained with IV available.
  const reliable = have && (Math.abs(actual) <= noise || vega == null || dIv == null || Math.abs(residual) <= Math.max(noise, 0.5 * Math.abs(actual)));
  let classification: PpDecay = 'NOT_DECAYING';
  if (actual < -noise) {
    if (!have) classification = 'UNCLASSIFIED';
    else {
      // Shares of the fall among the three explained drivers (IV term includes the residual: the broker's IV is itself
      // solved from the premium, so what the model cannot place sits with volatility / supply, not with spot or time).
      const parts = { DIRECTIONAL_DECAY: Math.max(0, -directional), THETA_DOMINATED_DECAY: Math.max(0, -th), IV_CRUSH_DOMINATED: Math.max(0, -(vg + residual)) };
      const total = parts.DIRECTIONAL_DECAY + parts.THETA_DOMINATED_DECAY + parts.IV_CRUSH_DOMINATED;
      const top = (Object.entries(parts) as Array<[PpDecay, number]>).sort((a, b) => b[1] - a[1])[0];
      classification = total <= 0 ? 'UNCLASSIFIED' : top[1] / total >= 0.55 ? top[0] : 'MIXED_DECAY';
      if (!reliable && vega != null && dIv != null) classification = 'UNCLASSIFIED';
    }
  }
  return { windowMin, actual: r2(actual), directional: r2(directional), theta: r2(th), vega: r2(vg), residual: r2(residual), pressure: r2(pressure), classification, reliable };
}

interface GexCalc { net: number; perStrike: Array<{ strike: number; gex: number }>; callGamma: number; putGamma: number; atmGross: number; gross: number }
/** The existing estimated-GEX convention (gamma-exposure/index.ts): (callGamma*OI - putGamma*OI) * spot^2 * 100 / 1e7. */
function gexOf(s: PpSample, atm: number): GexCalc {
  let callGamma = 0, putGamma = 0, atmGross = 0, gross = 0;
  const perStrike = s.strikes.map((k) => {
    const c = k.call && fin(k.call.gamma) && (k.call.oi ?? 0) > 0 ? k.call.gamma * k.call.oi! : 0;
    const p = k.put && fin(k.put.gamma) && (k.put.oi ?? 0) > 0 ? k.put.gamma * k.put.oi! : 0;
    callGamma += c; putGamma += p; gross += c + p;
    if (Math.abs(k.strike - atm) <= s.strikeStep * 1.01) atmGross += c + p;
    return { strike: k.strike, gex: r2(((c - p) * s.spot * s.spot * 100) / 1e7) };
  });
  return { net: r2(perStrike.reduce((a, b) => a + b.gex, 0)), perStrike, callGamma, putGamma, atmGross, gross };
}

/**
 * Estimated gamma flip: the spot level nearest the current spot at which net estimated GEX changes sign, found by
 * repricing every leg's gamma (Black-Scholes, the leg's own IV, the sample's time to expiry) on a +/-4% spot grid.
 * Null when there is no crossing in the grid or IV is missing. An estimate under the same dealer-sign assumption.
 */
export function ppGammaFlip(s: PpSample): number | null {
  const t = Math.max(s.minutesToExpiry, 1) / (365 * 1440);
  const legs: Array<{ strike: number; iv: number; oi: number; sign: 1 | -1 }> = [];
  for (const k of s.strikes) {
    if (k.call && fin(k.call.iv) && k.call.iv > 0 && (k.call.oi ?? 0) > 0) legs.push({ strike: k.strike, iv: k.call.iv / 100, oi: k.call.oi!, sign: 1 });
    if (k.put && fin(k.put.iv) && k.put.iv > 0 && (k.put.oi ?? 0) > 0) legs.push({ strike: k.strike, iv: k.put.iv / 100, oi: k.put.oi!, sign: -1 });
  }
  if (legs.length < 4) return null;
  const net = (spot: number) => legs.reduce((a, l) => a + l.sign * l.oi * calculateGreeks({ spotPrice: spot, strikePrice: l.strike, timeToExpiry: t, riskFreeRate: 0.065, iv: l.iv, optionType: 'CE' }).gamma, 0);
  let best: number | null = null, prevSpot = s.spot * 0.96, prev = net(prevSpot);
  for (let i = 1; i <= 80; i++) {
    const spot = s.spot * (0.96 + i * 0.001), v = net(spot);
    if ((prev < 0 && v >= 0) || (prev > 0 && v <= 0)) {
      const x = prev === v ? spot : prevSpot + ((0 - prev) / (v - prev)) * (spot - prevSpot);
      if (best == null || Math.abs(x - s.spot) < Math.abs(best - s.spot)) best = x;
    }
    prevSpot = spot; prev = v;
  }
  return best == null ? null : r2(best);
}

function gap(symbol: string, now: number, issues: string[], last?: PpSample): PpAnalysis {
  return {
    version: GXP_VERSION, symbol, at: now, expiry: last?.expiry ?? '', period: last ? ppPeriod(last.minutesToExpiry) : 'NON_EXPIRY', minutesToExpiry: last?.minutesToExpiry ?? 0,
    spot: last?.spot ?? 0, atm: 0, classification: 'DATA_GAP', state: 'DATA_GAP', score: 0, confidence: 0,
    components: { premium: null, oiVolume: null, underlying: null, gex: null, decomposition: null },
    dataQuality: { status: 'DATA_GAP', issues }, ce: null, pe: null, gex: null, underlying: { changePct: [], moveSigma: null }, rows: [], trap: null,
    explanation: [`No read: ${issues.join(', ').toLowerCase().replace(/_/g, ' ')}.`], invalidation: [],
  };
}

export function analyzePremiumPressure(input: PpInput): PpAnalysis {
  const cfg = input.config ?? GXP_CONFIG, now = input.now;
  const all = [...input.samples].sort((a, b) => a.at - b.at).filter((s) => s.at <= now);
  const last = all[all.length - 1];
  if (!last) return gap(input.symbol, now, ['NO_CHAIN_SAMPLE']);
  const samples = all.filter((s) => s.expiry === last.expiry);
  const issues: string[] = [];
  if (now - last.at > cfg.maxSampleAgeMs) issues.push('STALE_CHAIN_SNAPSHOT');
  if (!fin(last.spot) || last.spot <= 0) issues.push('INVALID_UNDERLYING_PRICE');
  if (!last.expiry || !fin(last.minutesToExpiry) || last.minutesToExpiry <= 0) issues.push('EXPIRY_MAPPING_INVALID');
  if (last.spotAt != null && Math.abs(last.at - last.spotAt) > cfg.maxSpotSkewMs) issues.push('SPOT_CHAIN_TIMESTAMP_MISMATCH');
  if (issues.length) return gap(input.symbol, now, issues, last);

  const period = ppPeriod(last.minutesToExpiry), rules = cfg.periods[period];
  const sorted = [...last.strikes].sort((a, b) => a.strike - b.strike);
  const atmIdx = sorted.reduce((best, k, i) => (Math.abs(k.strike - last.spot) < Math.abs(sorted[best].strike - last.spot) ? i : best), 0);
  const atm = sorted[atmIdx]?.strike ?? 0;
  // ATM +/- n by the chain's own strike step: a missing strike is a hole, never replaced by a farther one.
  const window: PpStrike[] = [];
  for (let i = -cfg.strikesEachSide; i <= cfg.strikesEachSide; i++) { const k = sorted.find((x) => Math.abs(x.strike - (atm + i * last.strikeStep)) <= last.strikeStep * 0.01); if (k) window.push(k); }
  if (window.length < cfg.strikesEachSide * 2 + 1) issues.push('MISSING_STRIKES');
  const befores = cfg.windows.map((w) => ppSampleAt(samples.slice(0, -1), last.at, w, cfg.windowTolerance));
  if (!befores.some(Boolean)) return gap(input.symbol, now, [...issues, 'NO_EARLIER_SAMPLE_FOR_ANY_WINDOW'], last);

  // The window the read is built on: the period's primary one, else the nearest available.
  const order = cfg.windows.map((_, i) => i).sort((a, b) => Math.abs(a - rules.primary) - Math.abs(b - rules.primary));
  const wi = order.find((i) => befores[i])!, before = befores[wi]!, windowMin = cfg.windows[wi], elapsedMin = (last.at - before.at) / 60_000;
  const atmLeg = legOf(sorted[atmIdx], 'CE') ?? legOf(sorted[atmIdx], 'PE');
  const atmIv = mean([sorted[atmIdx]?.call?.iv, sorted[atmIdx]?.put?.iv].filter((x): x is number => fin(x) && x > 0));
  const sigma = (minutes: number) => (atmIv ? last.spot * (atmIv / 100) * Math.sqrt(minutes / cfg.minutesPerYear) : null);
  const sigmaW = sigma(Math.max(elapsedMin, 0.5));
  const dSpot = last.spot - before.spot;
  // Feed discontinuity: the underlying "moved" many expected moves between two consecutive samples.
  const prev = samples[samples.length - 2];
  if (prev && sigma(Math.max((last.at - prev.at) / 60_000, 0.5)) != null && Math.abs(last.spot - prev.spot) > cfg.maxSpotJumpSigma * sigma(Math.max((last.at - prev.at) / 60_000, 0.5))!) return gap(input.symbol, now, [...issues, 'UNDERLYING_DISCONTINUITY'], last);
  if (!atmLeg || !atmIv || sigmaW == null) issues.push('MISSING_IV_OR_GREEKS');

  const beforeStrike = (s: PpSample | null, strike: number) => s?.strikes.find((k) => k.strike === strike);
  const minutesOpen = input.sessionOpen != null ? Math.max(1, (last.at - input.sessionOpen) / 60_000) : null;

  const sideRead = (side: PpSide): PpSideRead => {
    const live = window.filter((k) => liquid(legOf(k, side), rules) && liquid(legOf(beforeStrike(before, k.strike), side) ?? null, { ...rules, minPremium: 0.05, maxSpreadPct: rules.maxSpreadPct * 2 }));
    const changePct = cfg.windows.map((_, i) => mean(live.flatMap((k) => { const b = legOf(beforeStrike(befores[i], k.strike), side), a = legOf(k, side)!; return b && b.ltp > 0 ? [((a.ltp - b.ltp) / b.ltp) * 100] : []; })));
    const norm: number[] = [], pressPct: number[] = [], pressZ: number[] = [], ivCh: number[] = [], oiCh: number[] = [], volRatio: number[] = [], decays: PpDecomposition[] = [];
    let writing = 0;
    for (const k of live) {
      const a = legOf(k, side)!, b = legOf(beforeStrike(before, k.strike), side)!;
      const d = ppDecompose(b, a, dSpot, elapsedMin, windowMin); decays.push(d);
      // Expected premium move: the leg's delta on one expected underlying move, floored at half its spread.
      const expected = Math.max((a.ask - a.bid) / 2, Math.abs(a.delta ?? b.delta ?? 0.5) * (sigmaW ?? 0), 0.05);
      norm.push((a.ltp - b.ltp) / expected); pressPct.push((d.pressure / b.ltp) * 100); pressZ.push(d.pressure / expected);
      if (fin(a.iv) && fin(b.iv)) ivCh.push(a.iv - b.iv);
      const oiPct = fin(a.oi) && fin(b.oi) && b.oi > 0 ? ((a.oi - b.oi) / b.oi) * 100 : null;
      if (oiPct != null) oiCh.push(oiPct);
      if (ppOiRead(((a.ltp - b.ltp) / b.ltp) * 100, oiPct) === 'POTENTIAL_WRITING') writing++;
      if (minutesOpen != null && fin(a.volume) && fin(b.volume) && a.volume > 0 && a.volume >= b.volume) volRatio.push((a.volume - b.volume) / Math.max(1e-9, (a.volume / minutesOpen) * elapsedMin));
    }
    const pz = mean(pressZ), oi = mean(oiCh), vr = mean(volRatio), share = live.length ? writing / live.length : 0;
    const reliable = decays.length > 0 && decays.filter((d) => d.reliable).length >= Math.ceil(decays.length / 2);
    const falling = decays.filter((d) => d.classification !== 'NOT_DECAYING');
    const tally = new Map<PpDecay, number>(); for (const d of falling) tally.set(d.classification, (tally.get(d.classification) ?? 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const decay: PpDecay = falling.length < Math.ceil(Math.max(1, live.length) / 2) ? 'NOT_DECAYING' : !reliable ? 'UNCLASSIFIED' : top[1] > falling.length / 2 ? top[0] : 'MIXED_DECAY';
    // Writer pressure. Compression is the PRESSURE part only (theta and the underlying's move are already removed), so
    // IV behaviour is inside it and is not scored a second time; the underlying is scored in the signal, not here.
    const compression = clamp((-(pz ?? 0) / 1.5) * 100, 0, 100);
    const oiPart = oi == null ? null : clamp((oi / 2) * 100, 0, 100);
    const volPart = vr == null ? null : clamp(((vr - 0.8) / 1.2) * 100, 0, 100);
    const consistency = share * 100;
    const parts: Array<[number, number | null]> = [[40, compression], [25, oiPart], [15, volPart], [20, consistency]];
    // A missing part scores zero (missing is never positive); nothing is renormalised.
    const writerPressure = Math.round(parts.reduce((a, [w, v]) => a + (w * (v ?? 0)) / 100, 0));
    const avail = changePct.filter((x): x is number => x != null);
    const rate = (i: number) => (changePct[i] != null ? changePct[i]! / cfg.windows[i] : null);
    const shortI = changePct.findIndex((x) => x != null), longI = changePct.length - 1 - [...changePct].reverse().findIndex((x) => x != null);
    return {
      side, liquidStrikes: live.length, changePct: changePct.map((x) => (x == null ? null : r2(x))),
      velocity: rate(wi) == null ? null : r2(rate(wi)!), acceleration: shortI >= 0 && longI > shortI ? r2(rate(shortI)! - rate(longI)!) : null,
      normalizedChange: mean(norm) == null ? null : r2(mean(norm)!), pressurePct: mean(pressPct) == null ? null : r2(mean(pressPct)!), pressureZ: pz == null ? null : r2(pz),
      ivChange: mean(ivCh) == null ? null : r2(mean(ivCh)!), oiChangePct: oi == null ? null : r2(oi), volumeRatio: vr == null ? null : r2(vr), writingShare: r2(share),
      compressionWindows: avail.filter((x) => x < -0.3).length, expansionWindows: avail.filter((x) => x > 0.3).length, windowsAvailable: avail.length,
      decay, decompositionReliable: reliable, writerPressure, writerParts: { compression: Math.round(compression), oi: oiPart == null ? null : Math.round(oiPart), volume: volPart == null ? null : Math.round(volPart), consistency: Math.round(consistency) },
    };
  };
  const ce = sideRead('CE'), pe = sideRead('PE');
  if (ce.liquidStrikes < cfg.minLiquidStrikes || pe.liquidStrikes < cfg.minLiquidStrikes) return { ...gap(input.symbol, now, [...issues, 'ILLIQUID_OR_MISSING_STRIKES'], last), atm };
  if (ce.oiChangePct == null || pe.oiChangePct == null) issues.push('MISSING_OI');
  if (!ce.decompositionReliable || !pe.decompositionReliable) issues.push('DECOMPOSITION_UNRELIABLE');

  // ---- Estimated GEX context ----
  const g = gexOf(last, atm), gBefore = gexOf(before, atm);
  let wall: number | null = null, maxAbs = 0; for (const p of g.perStrike) if (Math.abs(p.gex) > maxAbs) { maxAbs = Math.abs(p.gex); wall = p.strike; }
  const flip = ppGammaFlip(last), flipBefore = flip == null ? null : ppGammaFlip(before);
  const flipCrossed = flip != null && flipBefore != null ? (before.spot < flipBefore && last.spot >= flip ? 'UP' : before.spot > flipBefore && last.spot <= flip ? 'DOWN' : null) : null;
  const regime = g.net > 0 ? 'LONG_GAMMA' : g.net < 0 ? 'SHORT_GAMMA' : 'NEUTRAL';
  const pinned = regime === 'LONG_GAMMA' && wall != null && Math.abs(last.spot - wall) <= last.strikeStep * 0.3;
  const gex: PpGex | null = g.gross > 0 ? {
    estimated: true, netGex: g.net, regime, netGexChange: gBefore.gross > 0 ? r2(g.net - gBefore.net) : null, gammaWall: wall,
    topPositive: [...g.perStrike].filter((p) => p.gex > 0).sort((a, b) => b.gex - a.gex).slice(0, 3).map((p) => p.strike),
    topNegative: [...g.perStrike].filter((p) => p.gex < 0).sort((a, b) => a.gex - b.gex).slice(0, 3).map((p) => p.strike),
    callGammaShare: r2(g.callGamma / g.gross), atmConcentration: r2(g.atmGross / g.gross),
    gammaFlip: flip, spotVsFlipPct: flip == null ? null : r2(((last.spot - flip) / flip) * 100), flipCrossed, pinned,
  } : null;
  if (!gex) issues.push('GEX_UNAVAILABLE');

  // ---- Components, each -1..1 (positive bullish), null when it cannot be read ----
  const spotChange = cfg.windows.map((_, i) => (befores[i] ? r2(((last.spot - befores[i]!.spot) / befores[i]!.spot) * 100) : null));
  const moveSigma = sigmaW ? dSpot / sigmaW : null;
  const premium = ce.pressureZ != null && pe.pressureZ != null ? clamp((ce.pressureZ - pe.pressureZ) / 2 / 1.2, -1, 1) : null;
  const oiSub = (s: PpSideRead) => (s.writerParts.oi == null ? null : (0.45 * s.writerParts.oi + 0.2 * (s.writerParts.volume ?? 0) + 0.35 * s.writerParts.consistency) / 100);
  const oiVolume = oiSub(pe) != null && oiSub(ce) != null ? clamp(oiSub(pe)! - oiSub(ce)!, -1, 1) : null;
  const underlying = moveSigma == null ? null : clamp(moveSigma / 1.2, -1, 1);
  const lean = (premium ?? 0) * cfg.weights.premium + (oiVolume ?? 0) * cfg.weights.oiVolume + (underlying ?? 0) * cfg.weights.underlying;
  const dir = Math.abs(lean) < 4 ? 0 : Math.sign(lean);
  // GEX as context for the direction the other evidence leans to: short gamma amplifies a move in progress, a long-gamma
  // pin at the wall works against any breakout, a flip crossing in the direction supports it. Never a direction itself.
  let gexSupport: number | null = null;
  if (gex) {
    gexSupport = 0;
    if (dir !== 0) {
      if (gex.regime === 'SHORT_GAMMA') gexSupport += 0.5;
      if (gex.regime === 'LONG_GAMMA') gexSupport -= 0.15;
      if (gex.pinned) gexSupport -= period === 'NON_EXPIRY' ? 0.35 : 0.6;
      if (gex.flipCrossed) gexSupport += (gex.flipCrossed === 'UP' ? 1 : -1) * dir * 0.5;
      if (wall != null && !gex.pinned && gex.regime === 'LONG_GAMMA' && (wall - last.spot) * dir > 0 && Math.abs(wall - last.spot) <= last.strikeStep * 0.6) gexSupport -= 0.25;
    }
    gexSupport = clamp(gexSupport, -1, 1) * dir;
  }
  // Decomposition: is the pressed side's fall a side-specific pressure (informative) or time / a two-sided IV fall (not)?
  let decomposition: number | null = null;
  if (ce.decompositionReliable && pe.decompositionReliable && dir !== 0) {
    const pressed = dir > 0 ? pe : ce, other = dir > 0 ? ce : pe;
    const oneSidedIv = pressed.ivChange != null && other.ivChange != null && pressed.ivChange < -0.05 && pressed.ivChange < other.ivChange - 0.1;
    decomposition = dir * (pressed.decay === 'THETA_DOMINATED_DECAY' ? -0.3 : pressed.decay === 'IV_CRUSH_DOMINATED' ? (oneSidedIv ? 1 : -0.2) : pressed.decay === 'DIRECTIONAL_DECAY' ? 0.35 : pressed.decay === 'MIXED_DECAY' ? (oneSidedIv ? 0.5 : 0.1) : 0);
  }
  const components: PpComponents = { premium, oiVolume, underlying, gex: gexSupport, decomposition };
  const w = cfg.weights, total = w.premium + w.oiVolume + w.underlying + w.gex + w.decomposition;
  const parts: Array<[number, number | null]> = [[w.premium, premium], [w.oiVolume, oiVolume], [w.underlying, underlying], [w.gex, gexSupport], [w.decomposition, decomposition]];
  // The weights are a blend of evidence in [-1, 1]; x1.6 puts "most evidence agrees moderately" near the entry score.
  const score = Math.round(clamp((parts.reduce((a, [wt, v]) => a + wt * (v ?? 0), 0) / total) * 160, -100, 100));
  const sgn = Math.sign(score);
  const availableWeight = parts.reduce((a, [wt, v]) => a + (v == null ? 0 : wt), 0) / total;
  const agreeWeight = parts.reduce((a, [wt, v]) => a + (v != null && sgn !== 0 && v * sgn > 0.1 ? wt : 0), 0) / total;
  const confidence = Math.round(100 * availableWeight * (0.35 + 0.65 * agreeWeight) * (issues.includes('DECOMPOSITION_UNRELIABLE') ? 0.8 : 1) * (issues.includes('MISSING_STRIKES') ? 0.9 : 1));

  // ---- Classification ----
  const both = (f: (s: PpSideRead) => boolean) => f(ce) && f(pe);
  const quiet = moveSigma != null && Math.abs(moveSigma) < 0.6;
  const dual = both((s) => s.compressionWindows >= Math.max(1, Math.ceil(s.windowsAvailable / 2)) && (s.changePct[wi] ?? 0) < -0.5) && quiet &&
    both((s) => s.decay === 'THETA_DOMINATED_DECAY' || s.decay === 'IV_CRUSH_DOMINATED' || s.decay === 'MIXED_DECAY' || (s.ivChange ?? 0) < 0);
  const trap = ppTrap(samples, last, window, cfg);
  // Core premium evidence, plus any two of: OI/volume, underlying, GEX not strongly against. Nothing else is mandatory.
  const directional = (d: 1 | -1) => {
    const pressed = d > 0 ? pe : ce, other = d > 0 ? ce : pe;
    const core = (premium ?? 0) * d >= 0.25 && pressed.compressionWindows >= Math.max(1, Math.ceil(pressed.windowsAvailable / 2)) && (other.pressureZ ?? 0) > (pressed.pressureZ ?? 0);
    const support = [(oiVolume ?? 0) * d >= 0.15, (underlying ?? 0) * d >= 0.25, gexSupport != null && gexSupport * d > -0.4].filter(Boolean).length;
    return core && support >= 2 && score * d >= rules.entryScore;
  };
  let classification: PpClass = 'NONE';
  if (trap) classification = 'PREMIUM_TRAP';
  else if (directional(1)) classification = 'BULLISH_PREMIUM_PRESSURE';
  else if (directional(-1)) classification = 'BEARISH_PREMIUM_PRESSURE';
  else if (dual) classification = 'DUAL_SIDE_COMPRESSION';
  let state: PpState = 'NEUTRAL';
  if (classification === 'BULLISH_PREMIUM_PRESSURE' || classification === 'BEARISH_PREMIUM_PRESSURE') {
    state = confidence < cfg.minConfidence ? 'LOW_CONFIDENCE' : Math.abs(score) >= rules.strongScore ? (score > 0 ? 'STRONG_BULLISH' : 'STRONG_BEARISH') : score > 0 ? 'BULLISH' : 'BEARISH';
  }

  const rows: PpStrikeRow[] = window.map((k) => {
    const cell = (side: PpSide) => {
      const a = legOf(k, side), b = legOf(beforeStrike(before, k.strike), side);
      if (!a || !b || !(a.ltp > 0) || !(b.ltp > 0)) return null;
      const chg = ((a.ltp - b.ltp) / b.ltp) * 100, oiPct = fin(a.oi) && fin(b.oi) && b.oi > 0 ? ((a.oi - b.oi) / b.oi) * 100 : null;
      const d = ppDecompose(b, a, dSpot, elapsedMin, windowMin);
      return { premium: a.ltp, changePct: r2(chg), oiChangePct: oiPct == null ? null : r2(oiPct), oiRead: ppOiRead(chg, oiPct), pressurePct: r2((d.pressure / b.ltp) * 100) };
    };
    const c = cell('CE'), p = cell('PE');
    const cp = c?.pressurePct ?? null, pp = p?.pressurePct ?? null;
    const pressure = cp == null || pp == null ? 'NO_DATA' : cp < -1 && pp < -1 ? 'DUAL_COMPRESSION' : pp < -1 && cp > pp + 1 ? 'BULLISH' : cp < -1 && pp > cp + 1 ? 'BEARISH' : 'NEUTRAL';
    return { strike: k.strike, ce: c, pe: p, pressure };
  });

  const analysis: PpAnalysis = {
    version: GXP_VERSION, symbol: input.symbol, at: now, expiry: last.expiry, period, minutesToExpiry: Math.round(last.minutesToExpiry), spot: last.spot, atm,
    classification, state, score, confidence,
    components: { premium: premium == null ? null : r2(premium), oiVolume: oiVolume == null ? null : r2(oiVolume), underlying: underlying == null ? null : r2(underlying), gex: gexSupport == null ? null : r2(gexSupport), decomposition: decomposition == null ? null : r2(decomposition) },
    dataQuality: { status: issues.length ? 'DEGRADED' : 'OK', issues }, ce, pe, gex,
    underlying: { changePct: spotChange, moveSigma: moveSigma == null ? null : r2(moveSigma) }, rows, trap, explanation: [], invalidation: [],
  };
  const text = ppExplain(analysis, windowMin);
  return { ...analysis, explanation: text.explanation, invalidation: text.invalidation };
}

/**
 * Premium trap: one side's premium expanded while the underlying broke out, the underlying gave the move back, that
 * premium reversed quickly, the opposite side is now expanding, and the first side's OI never confirmed a build-up.
 * Needs three points in time, so it reads the longest window and its midpoint.
 */
function ppTrap(samples: readonly PpSample[], last: PpSample, window: PpStrike[], cfg: PpConfig): PpAnalysis['trap'] {
  const long = cfg.windows[cfg.windows.length - 1], start = ppSampleAt(samples.slice(0, -1), last.at, long, cfg.windowTolerance);
  if (!start) return null;
  const mids = samples.filter((s) => s.at > start.at && s.at < last.at);
  if (!mids.length) return null;
  const sideMean = (s: PpSample, side: PpSide) => mean(window.flatMap((k) => { const l = legOf(s.strikes.find((x) => x.strike === k.strike), side); return l && l.ltp > 0 ? [l.ltp] : []; }));
  const oiSum = (s: PpSample, side: PpSide) => window.reduce((a, k) => a + (legOf(s.strikes.find((x) => x.strike === k.strike), side)?.oi ?? 0), 0);
  for (const side of ['CE', 'PE'] as const) {
    const d = side === 'CE' ? 1 : -1, other: PpSide = side === 'CE' ? 'PE' : 'CE';
    const p0 = sideMean(start, side), p1 = sideMean(last, side), o1 = sideMean(last, other);
    if (p0 == null || p1 == null || o1 == null) continue;
    // The peak of the side's premium between the two ends.
    const peak = mids.map((m) => ({ m, p: sideMean(m, side) })).filter((x): x is { m: PpSample; p: number } => x.p != null).sort((a, b) => b.p - a.p)[0];
    if (!peak) continue;
    const rise = peak.p - p0, spotBreak = (peak.m.spot - start.spot) * d, oPeak = sideMean(peak.m, other);
    if (rise / p0 < 0.06 || spotBreak <= 0 || oPeak == null) continue;
    const gaveBack = (peak.p - p1) / rise >= 0.7, spotFailed = (last.spot - start.spot) * d <= spotBreak * 0.25, otherExpanding = o1 > oPeak * 1.02;
    const oiConfirmed = oiSum(start, side) > 0 && (oiSum(peak.m, side) - oiSum(start, side)) / oiSum(start, side) >= 0.01;
    const quickly = last.at - peak.m.at <= long * 60_000 * 0.75;
    if (gaveBack && spotFailed && otherExpanding && !oiConfirmed && quickly) {
      return { side, detail: `${side} premium rose ${r2((rise / p0) * 100)}% with the underlying's ${d > 0 ? 'up' : 'down'}-move, the move failed and ${Math.round(((peak.p - p1) / rise) * 100)}% of the rise is gone; ${other} premium is expanding; ${side} OI did not confirm the first move` };
    }
  }
  return null;
}

/** Deterministic, human-readable account of one analysis (the AI review is separate and reads this, never the reverse). */
export function ppExplain(a: PpAnalysis, windowMin: number): { explanation: string[]; invalidation: string[] } {
  const out: string[] = [], inv: string[] = [];
  if (!a.ce || !a.pe) return { explanation: a.explanation, invalidation: inv };
  const side = (s: PpSideRead) => `${s.side} premium ${s.changePct.map((x, i) => (x == null ? null : `${x > 0 ? '+' : ''}${x}%`)).filter(Boolean).join(' / ') || 'n/a'} (${s.liquidStrikes} strikes), pressure ${s.pressurePct ?? 'n/a'}% beyond the underlying's move and theta, IV ${s.ivChange == null ? 'n/a' : `${s.ivChange > 0 ? '+' : ''}${s.ivChange}`}, OI ${s.oiChangePct == null ? 'n/a' : `${s.oiChangePct > 0 ? '+' : ''}${s.oiChangePct}%`}, decay ${s.decay.toLowerCase().replace(/_/g, ' ')}, writer pressure ${s.writerPressure}/100`;
  out.push(`${a.symbol} ${a.classification.replace(/_/g, ' ').toLowerCase()} (${a.state.replace(/_/g, ' ').toLowerCase()}), score ${a.score}, confidence ${a.confidence}, ${a.period.replace(/_/g, ' ').toLowerCase()}, read over ${windowMin} min on ${a.rows.map((r) => r.strike).join(', ')}.`);
  out.push(side(a.pe)); out.push(side(a.ce));
  out.push(`Underlying ${a.underlying.moveSigma == null ? 'move unreadable' : `moved ${a.underlying.moveSigma} expected moves ${a.underlying.moveSigma >= 0 ? 'up' : 'down'}`}.`);
  if (a.gex) out.push(`Estimated GEX ${a.gex.netGex} (${a.gex.regime.toLowerCase().replace('_', ' ')})${a.gex.gammaFlip != null ? `, estimated flip ${a.gex.gammaFlip} (spot ${a.gex.spotVsFlipPct! >= 0 ? 'above' : 'below'} by ${Math.abs(a.gex.spotVsFlipPct!)}%)` : ', no flip level in range'}${a.gex.gammaWall != null ? `, largest concentration ${a.gex.gammaWall}` : ''}${a.gex.pinned ? ' — spot is pinned at it' : ''}: ${a.components.gex == null || a.components.gex === 0 ? 'neutral context' : a.components.gex * Math.sign(a.score || 1) > 0 ? 'supports the read' : 'works against the read'}.`);
  if (a.trap) out.push(`Trap: ${a.trap.detail}. No reversal entry without independent confirmation.`);
  if (a.classification === 'DUAL_SIDE_COMPRESSION') out.push('Both sides are losing premium with a quiet underlying: range / volatility contraction, not a breakout call.');
  if (a.dataQuality.issues.length) out.push(`Data: ${a.dataQuality.issues.join(', ').toLowerCase().replace(/_/g, ' ')} (confidence reduced).`);
  if (a.classification === 'BULLISH_PREMIUM_PRESSURE' || a.classification === 'BEARISH_PREMIUM_PRESSURE') {
    const bull = a.classification === 'BULLISH_PREMIUM_PRESSURE', pressed = bull ? 'PE' : 'CE';
    inv.push(`${pressed} premium stops falling and recovers its ${windowMin}-minute loss`);
    inv.push(`the underlying closes back through the structure stop (${bull ? 'below' : 'above'} the recent swing)`);
    inv.push(`${pressed} OI starts to fall while its premium rises (potential short covering)`);
    if (a.gex?.gammaFlip != null) inv.push(`spot crosses the estimated gamma flip ${a.gex.gammaFlip} against the trade`);
  }
  return { explanation: out, invalidation: inv };
}

export interface PpBar { time: number; open: number; high: number; low: number; close: number }
export interface PpPlan {
  ok: true; side: 'BULLISH' | 'BEARISH'; optionSide: PpSide; entry: number; stop: number; target: number; riskAtr: number; rr: number;
  /** ATM and one strike in the money, by the chain's own strike step. */
  strikes: number[];
}
export const GXP_PLAN = Object.freeze({ swingBars: 6, stopBufferAtr: 0.1, minRiskAtr: 0.5, maxRiskAtr: 1.6, rr: 1.5, chaseZ: 2.5 });

/**
 * A paper-entry plan on the UNDERLYING (the paper adapter prices the option, costs, spread and net R:R). Structure
 * stop: beyond the last `swingBars` closed 5-minute bars' extreme. Refuses only what makes the plan meaningless:
 * no direction, entries off for the period, an already-expanded premium on the side to buy, a stop too far.
 */
export function ppEntryPlan(a: PpAnalysis, bars5: readonly PpBar[], atr: number, price: number, cfg: PpConfig = GXP_CONFIG): PpPlan | { ok: false; code: string } {
  const bull = a.state === 'BULLISH' || a.state === 'STRONG_BULLISH', bear = a.state === 'BEARISH' || a.state === 'STRONG_BEARISH';
  if (!bull && !bear) return { ok: false, code: a.state === 'DATA_GAP' ? 'DATA_GAP' : a.state === 'LOW_CONFIDENCE' ? 'LOW_CONFIDENCE' : 'NO_DIRECTIONAL_PRESSURE' };
  if (!cfg.periods[a.period].entries) return { ok: false, code: 'NO_ENTRIES_IN_LAST_30_MINUTES' };
  if (!(atr > 0) || !(price > 0) || bars5.length < GXP_PLAN.swingBars) return { ok: false, code: 'UNDERLYING_BARS_UNAVAILABLE' };
  const buy = bull ? a.ce! : a.pe!;
  if ((buy.normalizedChange ?? 0) > GXP_PLAN.chaseZ) return { ok: false, code: 'PREMIUM_ALREADY_EXPANDED' };
  const recent = bars5.slice(-GXP_PLAN.swingBars);
  const swing = bull ? Math.min(...recent.map((b) => b.low)) : Math.max(...recent.map((b) => b.high));
  let risk = Math.abs(price - swing) + GXP_PLAN.stopBufferAtr * atr;
  if (risk > GXP_PLAN.maxRiskAtr * atr) return { ok: false, code: 'STRUCTURE_STOP_TOO_FAR' };
  risk = Math.max(risk, GXP_PLAN.minRiskAtr * atr);
  const d = bull ? 1 : -1, step = a.rows.length > 1 ? Math.abs(a.rows[1].strike - a.rows[0].strike) : 0;
  return {
    ok: true, side: bull ? 'BULLISH' : 'BEARISH', optionSide: bull ? 'CE' : 'PE', entry: r2(price), stop: r2(price - d * risk), target: r2(price + d * risk * GXP_PLAN.rr),
    riskAtr: r2(risk / atr), rr: GXP_PLAN.rr, strikes: step > 0 ? [a.atm, a.atm - d * step] : [a.atm],
  };
}

export type PpLossClass = 'UNDERLYING_REVERSED' | 'PRESSURE_DID_NOT_FOLLOW_THROUGH' | 'TIME_RAN_OUT' | 'THETA_OUTRAN_THE_MOVE' | 'WEAK_EVIDENCE_AT_ENTRY' | 'COSTS_ONLY' | 'UNCLASSIFIED';
/** Routine, deterministic classification of a losing paper trade from its exit reason and the read it was entered on. */
export function ppClassifyLoss(x: { exitReason: string | null; netPnl: number; grossPnl?: number | null; entry?: Pick<PpAnalysis, 'confidence' | 'period' | 'components'> | null }): PpLossClass {
  if (x.grossPnl != null && x.grossPnl >= 0 && x.netPnl < 0) return 'COSTS_ONLY';
  const reason = (x.exitReason ?? '').toUpperCase();
  if (/STRUCTUR|STOP|INVALIDATION/.test(reason)) return x.entry && x.entry.confidence < 55 ? 'WEAK_EVIDENCE_AT_ENTRY' : 'UNDERLYING_REVERSED';
  if (/NO_PROGRESS|MAX_HOLD/.test(reason)) return x.entry && x.entry.period !== 'NON_EXPIRY' ? 'THETA_OUTRAN_THE_MOVE' : 'PRESSURE_DID_NOT_FOLLOW_THROUGH';
  if (/SESSION|CUTOFF|TIME/.test(reason)) return 'TIME_RAN_OUT';
  return 'UNCLASSIFIED';
}

// ============================================================
// Replay (historical validation on STORED chain snapshots; never reconstructs premiums from current data)
// ============================================================
export type PpVariant = 'GEX_PLUS_PRESSURE' | 'PRESSURE_ONLY' | 'GEX_CONTEXT_ONLY' | 'UNDERLYING_BASELINE';
export interface PpReplayTrade { variant: PpVariant; day: string; at: number; side: 'BULLISH' | 'BEARISH'; strike: number; entry: number; exit: number; exitAt: number; reason: 'TARGET' | 'STOP' | 'TIME' | 'SESSION_END'; netPoints: number; r: number; period: PpPeriod; holdMin: number }
export interface PpReplayStats { variant: PpVariant; signals: number; trades: number; bullish: number; bearish: number; winRate: number | null; avgWinR: number | null; avgLossR: number | null; netR: number; profitFactor: number | null; maxDrawdownR: number; avgHoldMin: number | null; perSession: number | null; expiry: { trades: number; netR: number }; nonExpiry: { trades: number; netR: number } }
export interface PpReplayOptions {
  config: PpConfig;
  /** Half-spread paid on each side when the stored row has no bid / ask, as a fraction of premium. */
  slippagePct: number;
  /** Round-trip charges as a fraction of premium turnover (brokerage, STT on the sell, exchange fees, GST), an estimate. */
  costPct: number;
  maxHoldMin: number;
  rr: number;
  /** Underlying stop in expected moves of one primary window. */
  stopSigma: number;
  cooldownMin: number;
}
const istDay = (t: number) => new Date(t + 19_800_000).toISOString().slice(0, 10);

/**
 * Walks one symbol's samples in time order with no look-ahead: at each sample only earlier samples are visible; an
 * entry is priced on that sample's ask (or ltp + slippage), the exit on a LATER sample's bid (or ltp - slippage) when
 * the underlying reaches the stop / target, the hold limit passes, or the day's samples end.
 */
export function ppReplay(symbol: string, samples: readonly PpSample[], variant: PpVariant, o: PpReplayOptions): { trades: PpReplayTrade[]; signals: number; sessions: number } {
  const sorted = [...samples].sort((a, b) => a.at - b.at), trades: PpReplayTrade[] = [];
  const cfg: PpConfig = variant === 'PRESSURE_ONLY' ? { ...o.config, weights: { ...o.config.weights, gex: 0 } } : o.config;
  const long = cfg.windows[cfg.windows.length - 1];
  let signals = 0, busyUntil = 0;
  const days = new Set(sorted.map((s) => istDay(s.at)));
  for (let i = 1; i < sorted.length; i++) {
    const now = sorted[i], day = istDay(now.at);
    if (now.at < busyUntil) continue;
    const visible = sorted.slice(Math.max(0, i - 40), i + 1).filter((s) => istDay(s.at) === day && now.at - s.at <= long * 60_000 * 1.6);
    const a = analyzePremiumPressure({ symbol, now: now.at, samples: visible, config: { ...cfg, maxSampleAgeMs: Number.MAX_SAFE_INTEGER } });
    if (a.state === 'DATA_GAP') continue;
    let side: 'BULLISH' | 'BEARISH' | null = null;
    if (variant === 'GEX_PLUS_PRESSURE' || variant === 'PRESSURE_ONLY') side = a.state === 'BULLISH' || a.state === 'STRONG_BULLISH' ? 'BULLISH' : a.state === 'BEARISH' || a.state === 'STRONG_BEARISH' ? 'BEARISH' : null;
    else {
      const m = a.underlying.moveSigma ?? 0;
      // Baselines: the underlying's own move; and the same move taken only when the existing GEX read says SHORT_GAMMA
      // (the existing GEX output has no direction of its own: it is a regime, so it can only gate a direction).
      if (Math.abs(m) >= 1) side = m > 0 ? 'BULLISH' : 'BEARISH';
      if (variant === 'GEX_CONTEXT_ONLY' && a.gex?.regime !== 'SHORT_GAMMA') side = null;
    }
    if (!side) continue;
    signals++;
    if (!cfg.periods[a.period].entries) continue;
    const d = side === 'BULLISH' ? 1 : -1, optSide: PpSide = side === 'BULLISH' ? 'CE' : 'PE';
    const strike = a.atm, leg = legOf(now.strikes.find((k) => k.strike === strike), optSide);
    const iv = leg?.iv ?? null;
    if (!leg || !(leg.ltp > 0) || !fin(iv) || !fin(leg.delta)) continue;
    const entry = leg.ask > 0 && leg.ask >= leg.ltp * 0.9 ? leg.ask : leg.ltp * (1 + o.slippagePct);
    const sigma = now.spot * (iv / 100) * Math.sqrt(cfg.windows[cfg.periods[a.period].primary] / cfg.minutesPerYear) * o.stopSigma;
    const stop = now.spot - d * sigma, target = now.spot + d * sigma * o.rr;
    let exit: number | null = null, exitAt = now.at, reason: PpReplayTrade['reason'] = 'SESSION_END';
    for (let j = i + 1; j < sorted.length; j++) {
      const s = sorted[j]; if (istDay(s.at) !== day) break;
      const l = legOf(s.strikes.find((k) => k.strike === strike), optSide); if (!l || !(l.ltp > 0)) continue;
      const px = l.bid > 0 && l.bid <= l.ltp * 1.1 ? l.bid : l.ltp * (1 - o.slippagePct);
      exit = px; exitAt = s.at; reason = 'SESSION_END';
      if ((s.spot - stop) * d <= 0) { reason = 'STOP'; break; }
      if ((s.spot - target) * d >= 0) { reason = 'TARGET'; break; }
      if (s.at - now.at >= o.maxHoldMin * 60_000) { reason = 'TIME'; break; }
    }
    if (exit == null) continue;
    const net = exit - entry - (entry + exit) * (o.costPct / 2);
    // 1R = the premium the option was expected to lose at the underlying stop (delta, first order), floored.
    const risk = Math.max(Math.abs(leg.delta) * sigma, entry * 0.05);
    trades.push({ variant, day, at: now.at, side, strike, entry: r2(entry), exit: r2(exit), exitAt, reason, netPoints: r2(net), r: r2(net / risk), period: a.period, holdMin: Math.round((exitAt - now.at) / 60_000) });
    busyUntil = Math.max(exitAt, now.at + o.cooldownMin * 60_000);
  }
  return { trades, signals, sessions: days.size };
}

export function ppReplayStats(variant: PpVariant, runs: ReadonlyArray<{ trades: PpReplayTrade[]; signals: number; sessions: number }>): PpReplayStats {
  const trades = runs.flatMap((r) => r.trades).sort((a, b) => a.at - b.at), wins = trades.filter((t) => t.r > 0), losses = trades.filter((t) => t.r <= 0);
  let eq = 0, peak = 0, dd = 0; for (const t of trades) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const sum = (xs: PpReplayTrade[]) => r2(xs.reduce((a, t) => a + t.r, 0)), sessions = runs.reduce((a, r) => a + r.sessions, 0);
  const exp = trades.filter((t) => t.period !== 'NON_EXPIRY'), non = trades.filter((t) => t.period === 'NON_EXPIRY');
  return {
    variant, signals: runs.reduce((a, r) => a + r.signals, 0), trades: trades.length, bullish: trades.filter((t) => t.side === 'BULLISH').length, bearish: trades.filter((t) => t.side === 'BEARISH').length,
    winRate: trades.length ? r2((wins.length / trades.length) * 100) : null, avgWinR: wins.length ? r2(sum(wins) / wins.length) : null, avgLossR: losses.length ? r2(sum(losses) / losses.length) : null,
    netR: sum(trades), profitFactor: losses.length && sum(losses) < 0 ? r2(sum(wins) / -sum(losses)) : null, maxDrawdownR: r2(dd),
    avgHoldMin: trades.length ? Math.round(trades.reduce((a, t) => a + t.holdMin, 0) / trades.length) : null, perSession: sessions ? r2(trades.length / sessions) : null,
    expiry: { trades: exp.length, netR: sum(exp) }, nonExpiry: { trades: non.length, netR: sum(non) },
  };
}
