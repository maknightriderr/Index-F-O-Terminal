// ============================================================
// DHAN ENGINE v2 — SETUPS A–E (E: pure order flow), 10-POINT SCORE, MANDATORY GATES, NO-TRADE ENGINE (master prompt Parts 10, 12, 18)
// ============================================================
// SHADOW ONLY (phase 3): a signal is recorded with its full evidence; nothing here opens a paper or real position.
//
// Decision timeframe (v1): the contract's closed 15-minute footprint bars. Part 11 wants 5-minute setup
// confirmation; the v1 recorder builds footprints with price levels on 15 minutes only, so A–D are evaluated on
// 15-minute closes and the 30-minute frame (two 15-minute bars from the session open) is the higher timeframe.
// Recorded as a known deviation, to revisit when 5-minute footprints exist.
//
// Each setup is written once, for the BULLISH side. The BEARISH side runs the identical rules on the price-mirrored
// context (every price p -> -p, highs <-> lows, buy <-> sell volume, delta -> -delta), so both directions follow
// exactly the same conditions; results are mirrored back. Every condition is a named check; the first that fails
// is the refusal reason.
//
// Shared numbers (research values, versioned here):
//   SL buffer = max(2 ticks, 0.1 ATR); a retest = low within 0.25 ATR of the broken level and a close above it.
//   Target = the nearest of {liquidity levels, swing highs, POC / VAH, VWAP} beyond the entry (conservative).
//   R:R is GROSS on the underlying here; option costs are applied in phase 4.
// ============================================================

import type { FootprintBar } from '../order-flow/index.js';
import { DHAN_ENGINE_RULES, roundDp, type EngineBar, type Side } from './common.js';
import { diagonalImbalances, type FootprintV2 } from './footprint-v2.js';
import { analyzeStructure, detectFailedBreakouts, detectSweeps, liquidityLevels, referenceLevels, type LiquidityLevel, type StructureState } from './structure.js';
import { cvdDivergences, cvdSeries, istSession, type CvdDivergence, type CvdPoint } from './cvd.js';
import { profileFromFootprints, type VolumeProfile } from './volume-profile.js';
import { vwapSeries, type VwapPoint, type VwapSums } from './vwap.js';
import { detectAbsorption, detectExhaustion, type AbsorptionEvent, type ExhaustionEvent } from './absorption.js';
import { combineRegime, type MtfRegime, type TimeframeInputs } from './regime.js';

export const DHAN_SETUP_VERSION = 'DHAN-SETUPS-1.4';

export const DHAN_SETUP_IDS = {
  A: 'DHAN_A_SWEEP_ABSORPTION',
  B: 'DHAN_B_IMBALANCE_BREAKOUT',
  C: 'DHAN_C_FAILED_AUCTION_CVD',
  D: 'DHAN_D_VWAP_PROFILE_REJECTION',
  E: 'DHAN_E_ORDER_FLOW',
} as const;
export type DhanSetupKey = keyof typeof DHAN_SETUP_IDS;

export const DHAN_SETUP_RULES = Object.freeze({
  atrBars: 14,
  minAtrBars: 5,
  slBufferTicks: 2,
  slBufferAtr: 0.1,
  retestAtr: 0.25,
  /** A: the sweep must have reclaimed within this many bars of the decision. */
  sweepRecencyBars: 6,
  /** B: consolidation box length, its maximum height, and how recent the breakout must be. */
  boxBars: 4,
  boxMaxAtr: 1.5,
  breakoutRecencyBars: 3,
  breakoutDeltaPct: 0.15,
  extendedAtr: 1.0,
  /** C: the second (lower-low) pivot must be this recent. */
  pivotRecencyBars: 10,
  /** D: a touch is within 0.1 ATR of the zone; rejection needs a lower wick >= 40% of the bar's range. */
  touchAtr: 0.1,
  rejectionWick: 0.4,
  /** Zone for the 10-point score: within this many ATR of a named reference / profile level. */
  zoneAtr: 0.25,
  minRr: 2,
  minTrades: 30,
  maxUnknownShare: 0.2,
  scorePreferred: 8,
  scoreConditional: 7,
  /** E: the absorption bar must be at most this many bars before the decision bar. */
  orderFlowRecencyBars: 4,
  /** E (owner, 9 Nov): a stacked imbalance is 2+ consecutive rows here (A-D keep the master prompt's 3). */
  orderFlowStackedMin: 2,
  /** E (owner, 10 Nov): the target must pay at least this many times the risk (10 Nov: a signal with R:R 0.04). */
  orderFlowMinRr: 1,
  /** New setup entries end this long before the session close (the paper path's cutoff: 14:45 on NSE / BSE). */
  lastEntryBeforeCloseMs: 45 * 60_000,
});

export interface SetupContext {
  symbol: string;
  instrument: string | null;
  kind: 'INDEX' | 'STOCK' | 'COMMODITY' | null;
  exchange: string;
  tickSize: number;
  /** All in-memory closed 15-minute bars of this contract (prior sessions + today), oldest first, aligned with fps. */
  bars: EngineBar[];
  fps: FootprintBar[];
  /** Per-bar trade VWAP sums (null where unknown), aligned with bars. */
  vwapSums: Array<VwapSums | null>;
  /** Per-bar RVOL (null = unavailable: fewer than 20 sessions of the same interval), aligned with bars. */
  rvol: Array<number | null>;
  /** Completed prior daily bars, oldest first. */
  daily: EngineBar[];
  sessionOpen: number;
  /** The bar length of `bars` / `fps` in ms. Absent = 15 minutes (the live engine). The 5-minute order-flow shadow
   *  (11 Nov) passes 300 000: only the contiguity check and the decision time use it; no rule changes with it. */
  barMs?: number;
  /** The exchange's session close (DST-aware for MCX). Absent = no close-based cutoff (fixtures). */
  sessionClose?: number;
  /** Whether the previous session / previous week in `daily` are complete (8 Nov audit): a level from a partial day or
   *  week (feed connected late, a restart, a short memory) is not the real PDH / PDL / PWH / PWL and is dropped.
   *  Absent = trust `daily` as given (fixtures, replays that supply full history). */
  referenceComplete?: { previousDay: boolean; previousWeek: boolean };
  /** sessionGapAt: the first lost bar of today's session (restart / unreconciled-only): session totals end there. */
  health: { stale: boolean; mappingValid: boolean; sessionGapAt?: number | null };
}

export interface Check { id: string; ok: boolean; value?: unknown }
export interface TradePlan { entry: number; sl: number; target: number; targetKind: string; rr: number }
export interface ScoreLine { item: string; points: number; max: number }
export interface NoTradeReport { tradeable: boolean; reasons: string[]; notEvaluated: string[] }

export interface SetupResult {
  setup: DhanSetupKey;
  strategy: string;
  side: Side;
  /** SIGNAL: every condition, gate, score >= 7 and the no-trade engine clear. NO_TRADE: conditions met, rejected after.
   *  NO_SETUP: a condition failed (named in `failed`). */
  status: 'SIGNAL' | 'NO_TRADE' | 'NO_SETUP';
  failed: string | null;
  checks: Check[];
  plan: TradePlan | null;
  score: { total: number; lines: ScoreLine[]; eligibility: 'PREFERRED' | 'CONDITIONAL' | 'REJECT' } | null;
  gates: Check[];
  noTrade: NoTradeReport | null;
  evidence: Record<string, unknown>;
}

export interface SetupsEvaluation {
  version: string;
  symbol: string;
  barTime: number | null;
  sessionWindow: string;
  regime: MtfRegime | null;
  results: SetupResult[];
}

// ---------------- mirroring ----------------

const mBar = (b: EngineBar): EngineBar => ({ time: b.time, open: -b.open, high: -b.low, low: -b.high, close: -b.close, volume: b.volume });
const neg = (x: number | null | undefined) => (x == null ? (x as null) : -x);
function mFp(f: FootprintBar): FootprintBar {
  return {
    ...f, levels: f.levels.map((l) => ({ price: -l.price, buy: l.sell, sell: l.buy, unclassified: l.unclassified })).sort((a, b) => a.price - b.price),
    buyVolume: f.sellVolume, sellVolume: f.buyVolume, delta: neg(f.delta), deltaPct: neg(f.deltaPct), buyImbalances: f.sellImbalances, sellImbalances: f.buyImbalances,
    poc: neg(f.poc), vah: neg(f.val), val: neg(f.vah), high: neg(f.low), low: neg(f.high), close: neg(f.close),
  };
}
export function mirrorContext(c: SetupContext): SetupContext {
  return { ...c, bars: c.bars.map(mBar), fps: c.fps.map(mFp), daily: c.daily.map(mBar), vwapSums: c.vwapSums.map((s) => (s ? { pv: -s.pv, v: s.v, p2v: s.p2v } : null)) };
}

// ---------------- derived state (one side) ----------------

interface Derived {
  c: SetupContext;
  s0: number;
  bars: EngineBar[];
  fps: FootprintBar[];
  i: number;
  atr: number | null;
  buf: number;
  structure: StructureState;
  levels: LiquidityLevel[];
  named: number[];
  cvd: CvdPoint[];
  divergences: CvdDivergence[];
  diag: FootprintV2[];
  vwap: VwapPoint[] | null;
  absorption: AbsorptionEvent[];
  exhaustion: ExhaustionEvent[];
  profile: VolumeProfile;
  regime: MtfRegime;
  m30Trend: Side | 'UNKNOWN';
  /** Index of the first session bar after a lost bar (Infinity when the session is complete). */
  fromGap: number;
}

function meanRange(bars: readonly EngineBar[], n: number, min: number): number | null {
  const r = bars.slice(-n).map((b) => b.high - b.low);
  return r.length >= min ? r.reduce((a, x) => a + x, 0) / r.length : null;
}

/** Two 15-minute bars per 30-minute bar, grouped from each session's first bar. */
export function thirtyMinuteBars(bars: readonly EngineBar[]): EngineBar[] {
  const out: EngineBar[] = [];
  let k = 0;
  while (k < bars.length) {
    const s = istSession(bars[k].time);
    const day: EngineBar[] = [];
    while (k < bars.length && istSession(bars[k].time) === s) day.push(bars[k++]);
    for (let j = 0; j < day.length; j += 2) {
      const g = day.slice(j, j + 2);
      out.push({ time: g[0].time, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[g.length - 1].close, volume: g.reduce((a, x) => a + (x.volume ?? 0), 0) });
    }
  }
  return out;
}

function pctRank(values: readonly number[]): number | null {
  if (values.length < 10) return null;
  const last = values[values.length - 1];
  return values.filter((v) => v <= last).length / values.length;
}

function frameInputs(bars: readonly EngineBar[], tick: number, d: { slope: number | null; cvdMom: number | null; close: number; profile: VolumeProfile; rvol: number | null }): TimeframeInputs {
  const st = bars.length >= 5 ? analyzeStructure(bars.slice(-60), tick) : null;
  const p = d.profile;
  const pv = p.poc == null ? null : d.close > (p.vah ?? Infinity) ? 'ABOVE_VAH' : d.close < (p.val ?? -Infinity) ? 'BELOW_VAL' : d.close >= p.poc ? 'ABOVE_POC' : 'BELOW_POC';
  return {
    structure: st ? st.trend : 'UNKNOWN', vwapSlopeAtr: d.slope, atrPercentile: pctRank(bars.slice(-50).map((b) => b.high - b.low)), rvol: d.rvol,
    cvdDirection: d.cvdMom == null ? null : d.cvdMom > 0 ? 'UP' : d.cvdMom < 0 ? 'DOWN' : 'FLAT', priceVsValue: pv as TimeframeInputs['priceVsValue'],
  };
}

function derive(c: SetupContext): Derived | null {
  const n = c.bars.length;
  if (!n) return null;
  const i0 = n - 1, session = istSession(c.bars[i0].time);
  let s0 = i0;
  while (s0 > 0 && istSession(c.bars[s0 - 1].time) === session) s0--;
  const bars = c.bars.slice(s0), fps = c.fps.slice(s0), i = bars.length - 1;
  const atr = meanRange(c.bars, DHAN_SETUP_RULES.atrBars, DHAN_SETUP_RULES.minAtrBars);
  const buf = Math.max(DHAN_SETUP_RULES.slBufferTicks * c.tickSize, DHAN_SETUP_RULES.slBufferAtr * (atr ?? 0));
  const structure = analyzeStructure(bars, c.tickSize);
  const refRaw = referenceLevels(c.daily, bars, c.sessionOpen, 15);
  const ref = { ...refRaw, ...(c.referenceComplete && !c.referenceComplete.previousDay ? { pdh: null, pdl: null } : {}), ...(c.referenceComplete && !c.referenceComplete.previousWeek ? { pwh: null, pwl: null } : {}) };
  const levels = liquidityLevels(bars, ref, bars[0].time === c.sessionOpen ? 0 : -1);
  const cvdBars = bars.map((b, k) => ({ ...b, delta: fps[k].deltaMode === 'UNAVAILABLE' ? null : fps[k].delta }));
  const cvd = cvdSeries(cvdBars, istSession);
  // A lost bar of today's session (restart gap): the session CVD / VWAP no longer equal the session's from there on.
  const gapAt = c.health.sessionGapAt ?? null;
  const gapIdx = gapAt == null ? -1 : bars.findIndex((b) => b.time > gapAt);
  const fromGap = gapAt == null ? Infinity : gapIdx < 0 ? bars.length : gapIdx;
  for (let k = fromGap; k < cvd.length; k++) cvd[k] = { ...cvd[k], status: 'INCOMPLETE' };
  const divergences = cvdDivergences(cvdBars, cvd);
  const diag = fps.map((f) => diagonalImbalances(f));
  const sums = c.vwapSums.slice(s0);
  const vwapRaw = sums.every((s) => s != null) ? vwapSeries(bars.map((b, k) => ({ time: b.time, high: b.high, low: b.low, close: b.close, sums: sums[k]!, unreconciled: fps[k].unreconciledVolume ?? 0 })), istSession, 'TRADES', atr) : null;
  const vwap = vwapRaw ? vwapRaw.map((p, k) => (k >= fromGap ? { ...p, status: 'INCOMPLETE' as const } : p)) : null;
  const absorption = atr ? detectAbsorption(c.fps, atr, c.bars).filter((e) => e.index >= s0).map((e) => ({ ...e, index: e.index - s0, resolvedAt: e.resolvedAt == null ? null : e.resolvedAt - s0 })) : [];
  const exhaustion = detectExhaustion(c.fps, c.bars).filter((e) => e.index >= s0).map((e) => ({ ...e, index: e.index - s0, resolvedAt: e.resolvedAt == null ? null : e.resolvedAt - s0 }));
  const profile = profileFromFootprints(fps.filter((f) => f.deltaMode !== 'UNAVAILABLE'));
  const named = [ref.pdh, ref.pdl, ref.pwh, ref.pwl, ref.orHigh, ref.orLow, profile.poc, profile.vah, profile.val, vwap?.[i]?.vwap ?? null, ...profile.lvn, ...profile.hvn].filter((x): x is number => x != null);
  const m30 = thirtyMinuteBars(c.bars);
  const last = bars[i];
  const dd = { slope: vwap?.[i]?.slopeAtr ?? null, cvdMom: cvd[i]?.momentum ?? null, close: last.close, profile, rvol: c.rvol[c.rvol.length - 1] ?? null };
  const m30In = frameInputs(m30, c.tickSize, dd);
  const regime = combineRegime({ daily: c.daily.length >= 5 ? frameInputs(c.daily, c.tickSize, { ...dd, slope: null, cvdMom: null }) : null, m30: m30In, m15: frameInputs(c.bars, c.tickSize, dd) });
  return { c, s0, bars, fps, i, atr, buf, structure, levels, named, cvd, divergences, diag, vwap, absorption, exhaustion, profile, regime, fromGap, m30Trend: m30In.structure === 'RANGE' ? 'UNKNOWN' : m30In.structure };
}

// ---------------- shared helpers ----------------

const validFp = (f: FootprintBar) => f.deltaMode !== 'UNAVAILABLE' && !f.incomplete && f.delta != null;

function nearestTarget(d: Derived, entry: number, exclude: number | null = null): { price: number; kind: string } | null {
  const minGap = d.c.tickSize;
  const cands: Array<{ price: number; kind: string }> = [
    ...d.levels.filter((l) => l.side === 'HIGH' && l.knownFrom <= d.i).map((l) => ({ price: l.price, kind: l.kind })),
    ...(d.profile.poc != null ? [{ price: d.profile.poc, kind: 'POC' }] : []),
    ...(d.profile.vah != null ? [{ price: d.profile.vah, kind: 'VAH' }] : []),
    ...(d.vwap?.[d.i]?.vwap != null ? [{ price: d.vwap[d.i].vwap!, kind: 'VWAP' }] : []),
  ].filter((x) => x.price >= entry + minGap && (exclude == null || Math.abs(x.price - exclude) > (d.atr ?? 0) * DHAN_SETUP_RULES.touchAtr));
  return cands.sort((a, b) => a.price - b.price)[0] ?? null;
}

function planOf(d: Derived, entry: number, sl: number, exclude: number | null = null, fallback: { price: number; kind: string } | null = null): TradePlan | null {
  const t = nearestTarget(d, entry, exclude) ?? fallback;
  if (!t || !(entry > sl)) return null;
  return { entry, sl: roundDp(sl, 4), target: t.price, targetKind: t.kind, rr: roundDp((t.price - entry) / (entry - sl), 2) };
}

const nearNamed = (d: Derived, price: number) => d.atr != null && d.named.some((p) => Math.abs(p - price) <= DHAN_SETUP_RULES.zoneAtr * d.atr!);

interface Raw { checks: Check[]; failed: string | null; plan: TradePlan | null; from: number; zone: number | null; evidence: Record<string, unknown>; extended?: boolean }

function run(steps: Array<[string, () => unknown]>): { checks: Check[]; failed: string | null } {
  const checks: Check[] = [];
  for (const [id, f] of steps) {
    const v = f();
    const ok = v !== false && v != null;
    checks.push({ id, ok, ...(typeof v === 'object' || typeof v === 'number' ? { value: v } : {}) });
    if (!ok) return { checks, failed: id };
  }
  return { checks, failed: null };
}

// ---------------- Setup A: liquidity sweep + absorption reversal ----------------

function setupA(d: Derived): Raw {
  const { i, bars, fps } = d;
  const R = DHAN_SETUP_RULES;
  let sweep: ReturnType<typeof detectSweeps>[number] | undefined, abs: AbsorptionEvent | undefined, brk: StructureState['breaks'][number] | undefined;
  const flow = { delta: fps.map((f) => (validFp(f) ? f.delta : null)), absorption: bars.map((_, k) => d.absorption.find((e) => e.index === k && e.state !== 'FAILED')?.side ?? null) };
  const { checks, failed } = run([
    ['A1_SUPPORT_IDENTIFIED', () => d.levels.some((l) => l.side === 'LOW' && l.knownFrom <= i) || null],
    ['A2_SWEEP', () => (sweep = detectSweeps(bars, d.levels.filter((l) => l.side === 'LOW'), d.c.tickSize, flow).filter((s) => s.reclaimIndex <= i && s.reclaimIndex >= i - R.sweepRecencyBars).at(-1)) && { level: sweep.level.price, kind: sweep.level.kind, extreme: sweep.extreme, flow: sweep.flow }],
    ['A3_SELLING_AGGRESSION_UP', () => {
      const prev = fps.slice(Math.max(0, sweep!.index - 3), sweep!.index).filter(validFp).map((f) => f.sellVolume ?? 0);
      const now = fps[sweep!.index].sellVolume ?? 0;
      return prev.length > 0 && now > prev.reduce((a, x) => a + x, 0) / prev.length && validFp(fps[sweep!.index]) ? { sell: now } : null;
    }],
    ['A4_A5_ABSORPTION_CONFIRMED', () => (abs = d.absorption.find((e) => e.side === 'BULLISH' && e.state === 'CONFIRMED' && e.index >= sweep!.index - 1 && e.index <= sweep!.reclaimIndex + 1 && (e.resolvedAt ?? Infinity) <= i)) && { zone: abs.zone, progressAtr: abs.progressAtr }],
    ['A6_CVD_IMPROVES', () => d.cvd[i].status === 'ESTIMATED' && (d.cvd[i].cvd > d.cvd[sweep!.index].cvd || d.divergences.some((x) => x.side === 'BULLISH' && x.knownAt <= i && x.second >= sweep!.index - 2)) ? { cvd: d.cvd[i].cvd } : null],
    ['A7_BUY_IMBALANCE', () => d.diag.slice(sweep!.index, i + 1).some((x) => x.buyImbalances > 0) || null],
    ['A8_BULLISH_BOS', () => (brk = d.structure.breaks.filter((b) => b.side === 'BULLISH' && b.index > sweep!.index && b.index < i).at(-1)) && { type: brk.type, level: brk.level }],
    ['A9_RETEST_HOLDS', () => bars[i].low <= brk!.level + R.retestAtr * d.atr! && bars[i].close > brk!.level && bars.slice(brk!.index + 1, i + 1).every((b) => b.close > brk!.level) || null],
  ]);
  const plan = failed ? null : planOf(d, bars[i].close, sweep!.extreme - d.buf);
  return { checks, failed, plan, from: sweep ? sweep.index : i, zone: sweep?.level.price ?? null, evidence: { sweep, absorption: abs, break: brk } };
}

// ---------------- Setup B: footprint imbalance breakout ----------------

function setupB(d: Derived): Raw {
  const { i, bars, fps } = d;
  const R = DHAN_SETUP_RULES;
  let b = -1, boxHigh = 0, boxLow = 0;
  for (let k = i - 1; k >= Math.max(R.boxBars, i - R.breakoutRecencyBars); k--) {
    const box = bars.slice(k - R.boxBars, k);
    const hi = Math.max(...box.map((x) => x.high)), lo = Math.min(...box.map((x) => x.low));
    if (d.atr != null && hi - lo <= R.boxMaxAtr * d.atr && bars[k].close >= hi + DHAN_SETUP_RULES.slBufferTicks * d.c.tickSize) { b = k; boxHigh = hi; boxLow = lo; break; }
  }
  const { checks, failed } = run([
    ['B1_HTF_BULLISH', () => d.m30Trend === 'BULLISH' && d.regime.allowed.includes('BULLISH') ? { regime: d.regime.regime } : null],
    ['B2_ABOVE_VWAP', () => d.vwap?.[i]?.vwap != null && d.vwap[i].status !== 'INCOMPLETE' && bars[i].close > d.vwap[i].vwap! ? { vwap: d.vwap![i].vwap } : null],
    ['B3_CONSOLIDATION_BELOW_RESISTANCE', () => b >= 0 ? { boxHigh, boxLow, breakoutIndex: b } : null],
    ['B4_RVOL_EXPANSION', () => { const r = d.c.rvol[d.s0 + b]; return r != null && r >= DHAN_ENGINE_RULES.rvolBreakout ? { rvol: r } : null; }],
    ['B5_DELTA_EXPANSION', () => {
      const f = fps[b];
      const boxMax = Math.max(...fps.slice(b - R.boxBars, b).map((x) => (validFp(x) ? x.delta! : 0)));
      return validFp(f) && f.delta! > 0 && (f.deltaPct ?? 0) >= R.breakoutDeltaPct && f.delta! > boxMax ? { delta: f.delta, deltaPct: f.deltaPct } : null;
    }],
    ['B6_STACKED_BUY_IMBALANCE', () => { const st = d.diag[b].stacks.find((x) => x.side === 'BUY'); return st ? { rows: st.rows } : null; }],
    ['B7_CLOSE_ABOVE_RESISTANCE', () => bars[b].close >= boxHigh + R.slBufferTicks * d.c.tickSize || null],
    ['B8_RETEST_HOLDS', () => bars[i].low <= boxHigh + R.retestAtr * d.atr! && bars[i].close > boxHigh && bars.slice(b + 1, i + 1).every((x) => x.close > boxHigh) || null],
    ['B9_NO_OPPOSING_ABSORPTION', () => !d.absorption.some((e) => e.side === 'BEARISH' && e.state !== 'FAILED' && e.index >= b && e.index <= i) || null],
  ]);
  const extended = !failed && bars[i].close - boxHigh > R.extendedAtr * d.atr!;
  const plan = failed ? null : planOf(d, bars[i].close, Math.min(bars[i].low, boxHigh) - d.buf, null, { price: roundDp(bars[i].close + (boxHigh - boxLow)), kind: 'MEASURED_MOVE' });
  return { checks, failed, plan, from: Math.max(0, b - R.boxBars), zone: b >= 0 ? boxHigh : null, evidence: { breakoutIndex: b, boxHigh, boxLow }, extended };
}

// ---------------- Setup C: failed auction + CVD divergence ----------------

function setupC(d: Derived): Raw {
  const { i, bars, fps } = d;
  const R = DHAN_SETUP_RULES;
  const lows = d.structure.pivots.filter((p) => p.kind === 'LOW' && p.confirmedAt <= i);
  const a = lows.at(-2), b = lows.at(-1);
  let div: CvdDivergence | undefined, ex: ExhaustionEvent | undefined, brk: StructureState['breaks'][number] | undefined;
  const { checks, failed } = run([
    ['C1_CONFIRMED_LOWER_LOW', () => a && b && b.price < a.price && b.index >= i - R.pivotRecencyBars ? { first: a.price, second: b.price } : null],
    ['C2_CVD_HIGHER_LOW', () => (div = d.divergences.find((x) => x.side === 'BULLISH' && x.first === a!.index && x.second === b!.index && x.knownAt <= i)) && { cvd: div.cvd }],
    ['C3_SELLING_REDUCES', () => validFp(fps[a!.index]) && validFp(fps[b!.index]) && (fps[b!.index].sellVolume ?? 0) < (fps[a!.index].sellVolume ?? 0) || null],
    ['C4_SELLING_EXHAUSTION', () => (ex = d.exhaustion.find((e) => e.side === 'BULLISH' && e.state !== 'FAILED' && Math.abs(e.index - b!.index) <= 1)) && { state: ex.state }],
    ['C5_RECLAIMS_STRUCTURE', () => bars[i].close > a!.price || null],
    ['C6_POSITIVE_DELTA', () => validFp(fps[i]) && fps[i].delta! > 0 ? { delta: fps[i].delta } : null],
    ['C7_BULLISH_BOS', () => (brk = d.structure.breaks.find((x) => x.side === 'BULLISH' && x.index === i)) && { type: brk.type, level: brk.level }],
  ]);
  const plan = failed ? null : planOf(d, bars[i].close, b!.price - d.buf);
  return { checks, failed, plan, from: a ? a.index : i, zone: b?.price ?? null, evidence: { pivots: a && b ? [a, b] : null, divergence: div, exhaustion: ex, break: brk } };
}

// ---------------- Setup D: VWAP + volume profile rejection ----------------

function setupD(d: Derived): Raw {
  const { i, bars, fps } = d;
  const R = DHAN_SETUP_RULES;
  let touch = -1, zone = 0, zoneKind = '', abs: AbsorptionEvent | undefined;
  for (const t of [i, i - 1]) {
    if (t < 1 || d.atr == null) continue;
    const prior = profileFromFootprints(fps.slice(0, t).filter((f) => f.deltaMode !== 'UNAVAILABLE'));
    // Profile and VWAP zones are session totals: none of them after a lost bar of the session.
    const complete = t - 1 < d.fromGap;
    const zones: Array<[number | null, string]> = complete ? [[prior.val, 'VAL'], [d.vwap?.[t - 1]?.status !== 'INCOMPLETE' ? d.vwap?.[t - 1]?.vwap ?? null : null, 'VWAP'], ...prior.lvn.map((p) => [p, 'LVN'] as [number, string])] : [];
    const bt = bars[t], range = bt.high - bt.low;
    for (const [z, k] of zones) {
      if (z == null) continue;
      const wick = range > 0 ? (Math.min(bt.open, bt.close) - bt.low) / range : 0;
      if (bt.low <= z + R.touchAtr * d.atr && bt.close > z && wick >= R.rejectionWick) { touch = t; zone = z; zoneKind = k; }
    }
    if (touch === t) break;
  }
  const { checks, failed } = run([
    ['D1_ZONE_REJECTED', () => touch >= 0 ? { zone, kind: zoneKind, touchIndex: touch } : null],
    ['D2_BULLISH_ABSORPTION', () => (abs = d.absorption.find((e) => e.side === 'BULLISH' && e.state !== 'FAILED' && (e.index === touch || e.index === i) && Math.abs(e.zone - zone) <= R.zoneAtr * d.atr!)) && { zone: abs.zone, state: abs.state }],
    ['D3_CVD_IMPROVES', () => validFp(fps[i]) && fps[i].delta! > 0 && touch >= 1 && d.cvd[i].status === 'ESTIMATED' && d.cvd[i].cvd > d.cvd[touch - 1].cvd ? { cvd: d.cvd[i].cvd } : null],
    ['D4_RECLAIMS_ZONE', () => bars[i].close > zone + R.slBufferTicks * d.c.tickSize || null],
    ['D5_BULLISH_STRUCTURE', () => d.structure.trend === 'BULLISH' || d.structure.breaks.some((x) => x.side === 'BULLISH' && x.index >= i - 3 && x.index <= i) || null],
  ]);
  const plan = failed ? null : planOf(d, bars[i].close, bars[touch].low - d.buf, zone);
  return { checks, failed, plan, from: Math.max(0, touch), zone: touch >= 0 ? zone : null, evidence: { zoneKind, absorption: abs } };
}

// ---------------- Setup E: pure order flow + footprint (owner, 9 Nov) ----------------
// Only order-flow and footprint evidence: no VWAP, EMA, trend, RVOL, regime or score. Bullish (bearish = distribution,
// the mirror): sellers absorbed at the value-area low / POC, then buyers take over.
//   E1 absorption: heavy estimated selling at a row of a recent bar, price barely moved below it (5.3 rules), not FAILED;
//   E2 location: that bar's low is at / below VAL, or within 0.25 ATR of VAL or POC (today's footprint profile);
//   E3 delta turns: summed delta of the bars after the absorption bar is positive;
//   E4 stacked buy imbalance (2+ consecutive rows, owner 9 Nov) on the absorption bar or after it (the longest is recorded);
//   E5 entry bar: positive delta, closes up and above the absorption bar's high (the sellers failed).
// Stop below the lowest low since the absorption bar (SL buffer); target the POC, else the VAH, above the entry.
// Data: every bar from the absorption bar on must be a usable footprint (sampled or complete, never INCOMPLETE).

function setupE(d: Derived): Raw {
  const { i, bars, fps } = d;
  const R = DHAN_SETUP_RULES;
  let abs: AbsorptionEvent | undefined, target: { price: number; kind: string } | null = null;
  const p = d.profile;
  const { checks, failed } = run([
    ['E1_ABSORPTION', () => (abs = d.absorption.filter((e) => e.side === 'BULLISH' && e.state !== 'FAILED' && e.index < i && e.index >= i - R.orderFlowRecencyBars).at(-1)) && { zone: abs.zone, progressAtr: abs.progressAtr, bar: abs.index }],
    ['E2_AT_VALUE_LOW_OR_POC', () => {
      const low = bars[abs!.index].low, z = R.zoneAtr * (d.atr ?? 0);
      const at = p.val != null && low <= p.val + z ? 'VAL' : p.poc != null && Math.abs(low - p.poc) <= z ? 'POC' : null;
      return at && d.atr != null ? { at, val: p.val, poc: p.poc } : null;
    }],
    ['E3_DELTA_TURNS_UP', () => {
      const after = fps.slice(abs!.index + 1, i + 1);
      if (!after.length || !after.every(validFp)) return null;
      const sum = after.reduce((a, f) => a + f.delta!, 0);
      return sum > 0 ? { deltaSinceAbsorption: sum } : null;
    }],
    ['E4_STACKED_BUY_IMBALANCE', () => {
      const st = fps.slice(abs!.index, i + 1).flatMap((f) => diagonalImbalances(f, { stackedMin: R.orderFlowStackedMin }).stacks).filter((x) => x.side === 'BUY').sort((a, b) => b.rows - a.rows)[0];
      return st ? { rows: st.rows, low: st.low, high: st.high } : null;
    }],
    ['E5_ENTRY_BAR', () => validFp(fps[i]) && fps[i].delta! > 0 && bars[i].close > bars[i].open && bars[i].close > bars[abs!.index].high ? { delta: fps[i].delta, close: bars[i].close } : null],
    // E6 (owner, 10 Nov): POC, else VAH, whichever first pays >= orderFlowMinRr times the risk to the stop.
    ['E6_TARGET_POC_OR_VAH', () => {
      const entry = bars[i].close, risk = entry - (Math.min(...bars.slice(abs!.index, i + 1).map((b) => b.low)) - d.buf);
      if (!(risk > 0)) return null;
      const pays = (x: number | null): x is number => x != null && (x - entry) / risk >= R.orderFlowMinRr;
      target = pays(p.poc) ? { price: p.poc, kind: 'POC' } : pays(p.vah) ? { price: p.vah, kind: 'VAH' } : null;
      return target;
    }],
  ]);
  let plan: TradePlan | null = null;
  if (!failed && target) {
    const entry = bars[i].close, sl = Math.min(...bars.slice(abs!.index, i + 1).map((b) => b.low)) - d.buf, t = target as { price: number; kind: string };
    plan = entry > sl ? { entry, sl: roundDp(sl, 4), target: t.price, targetKind: t.kind, rr: roundDp((t.price - entry) / (entry - sl), 2) } : null;
  }
  return { checks, failed, plan, from: abs ? abs.index : i, zone: abs?.zone ?? null, evidence: { absorption: abs, profile: { poc: p.poc, vah: p.vah, val: p.val } } };
}

const SETUPS: Record<DhanSetupKey, (d: Derived) => Raw> = { A: setupA, B: setupB, C: setupC, D: setupD, E: setupE };

// ---------------- score, gates, no-trade ----------------

function scoreOf(d: Derived, key: DhanSetupKey, r: Raw): SetupResult['score'] {
  const w = { from: r.from, to: d.i };
  const inW = (k: number) => k >= w.from && k <= w.to;
  const htf = d.m30Trend === 'BULLISH' && d.regime.allowed.includes('BULLISH');
  const zone = key === 'A' || key === 'D' || (r.zone != null && nearNamed(d, r.zone));
  const absorbed = d.absorption.some((e) => e.side === 'BULLISH' && e.state === 'CONFIRMED' && inW(e.index));
  const failedAuction = key === 'C' || detectSweeps(d.bars, d.levels.filter((l) => l.side === 'LOW'), d.c.tickSize).some((s) => inW(s.reclaimIndex)) || detectFailedBreakouts(d.bars, d.levels, d.c.tickSize).some((f) => f.side === 'BULLISH' && inW(f.failIndex));
  const cvdOk = (d.cvd[d.i].momentum ?? 0) > 0 || (validFp(d.fps[d.i]) && d.fps[d.i].delta! > 0);
  const stacked = d.diag.slice(w.from, w.to + 1).some((x) => x.stacks.some((s) => s.side === 'BUY'));
  const bos = d.structure.breaks.some((b) => b.side === 'BULLISH' && inW(b.index));
  const rrLiq = r.plan != null && r.plan.rr >= DHAN_SETUP_RULES.minRr && liquid(d);
  // Each piece of evidence is counted once: absorption sits only in its 2-point line, delta only in the CVD line.
  const lines: ScoreLine[] = [
    { item: 'HTF_ALIGNMENT', points: htf ? 2 : 0, max: 2 },
    { item: 'LIQUIDITY_PROFILE_ZONE', points: zone ? 2 : 0, max: 2 },
    { item: 'ABSORPTION_OR_FAILED_AUCTION', points: absorbed || failedAuction ? 2 : 0, max: 2 },
    { item: 'CVD_DELTA', points: cvdOk ? 1 : 0, max: 1 },
    { item: 'STACKED_IMBALANCE', points: stacked ? 1 : 0, max: 1 },
    { item: 'BOS_CHOCH', points: bos ? 1 : 0, max: 1 },
    { item: 'RR_AND_LIQUIDITY', points: rrLiq ? 1 : 0, max: 1 },
  ];
  const total = lines.reduce((a, l) => a + l.points, 0);
  return { total, lines, eligibility: total >= DHAN_SETUP_RULES.scorePreferred ? 'PREFERRED' : total >= DHAN_SETUP_RULES.scoreConditional ? 'CONDITIONAL' : 'REJECT' };
}

function liquid(d: Derived): boolean {
  const f = d.fps[d.i];
  return f.trades >= DHAN_SETUP_RULES.minTrades && f.delta != null;
}

function windowIncomplete(d: Derived, from: number): boolean {
  return d.fps.slice(from, d.i + 1).some((f, i, window) =>
    f.incomplete || f.deltaMode === 'UNAVAILABLE'
    || (i > 0 && f.barTime - window[i - 1].barTime !== (d.c.barMs ?? 15 * 60_000)));
}

function gatesOf(d: Derived, r: Raw): Check[] {
  return [
    { id: 'VALID_DATA', ok: !d.c.health.stale && d.c.health.mappingValid && !windowIncomplete(d, r.from) },
    { id: 'DEFINED_ENTRY', ok: r.plan != null && Number.isFinite(r.plan.entry) },
    { id: 'DEFINED_SL', ok: r.plan != null && r.plan.sl < r.plan.entry },
    { id: 'STRUCTURAL_CONFIRMATION', ok: d.structure.breaks.some((b) => b.side === 'BULLISH' && b.index >= r.from && b.index <= d.i) || d.structure.trend === 'BULLISH' },
    { id: 'MIN_RR_2', ok: r.plan != null && r.plan.rr >= DHAN_SETUP_RULES.minRr, ...(r.plan ? { value: r.plan.rr } : {}) },
    { id: 'INSTRUMENT_LIQUIDITY', ok: liquid(d) },
  ];
}

/** Part 18. Items that need phase-4 option data or sources not connected are listed as not evaluated (never assumed clear). */
function noTradeOf(d: Derived, key: DhanSetupKey, r: Raw): NoTradeReport {
  const f = d.fps[d.i];
  const vol = f.volume ?? 0;
  const reasons: string[] = [];
  const add = (cond: boolean, code: string) => { if (cond) reasons.push(code); };
  add(d.c.health.stale, 'FEED_STALE');
  add(windowIncomplete(d, r.from), 'DATA_INCOMPLETE');
  add(!d.c.health.mappingValid, 'INSTRUMENT_MAPPING_INVALID');
  add(f.delta == null, 'CLASSIFICATION_UNRELIABLE');
  add(vol > 0 && (f.unclassifiedVolume ?? 0) / vol > DHAN_SETUP_RULES.maxUnknownShare, 'EXCESSIVE_UNKNOWN_VOLUME');
  add(d.structure.trend === 'UNKNOWN', 'STRUCTURE_UNCLEAR');
  add(d.absorption.some((e) => e.side === 'BEARISH' && e.state !== 'FAILED' && e.index >= r.from && e.index <= d.i), 'CONFLICTING_ABSORPTION');
  // Breakout participation (RVOL >= 1.5 at the breakout bar) is condition B4 itself; nothing to add here.
  add(r.plan == null || r.plan.rr < DHAN_SETUP_RULES.minRr, 'RR_BELOW_2');
  add(!liquid(d), 'CONTRACT_ILLIQUID');
  add(!!r.extended, 'EXCESSIVELY_EXTENDED');
  add(r.plan == null || !(r.plan.sl < r.plan.entry), 'SL_NOT_LOGICAL');
  add(d.atr == null, 'REQUIRED_DATA_UNAVAILABLE');
  return { tradeable: reasons.length === 0, reasons, notEvaluated: ['OPTION_SPREAD', 'DAILY_LOSS_LIMIT', 'FO_RESTRICTIONS'] };
}

// ---------------- session windows (Part 17) ----------------

/** NSE / BSE: 09:15-09:30 observation only; new setups 09:30-14:45. MCX: the first 15 minutes are observation. */
export function sessionWindow(exchange: string, barClose: number, sessionClose?: number): string {
  const d = new Date(barClose + 19_800_000), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  // 10 Nov: MCX signals at 23:15 IST were emitted although paper entries had ended at close - 45 min (DEADLINE_EXPIRED).
  if (exchange === 'MCX') return m <= 9 * 60 + 15 ? 'MCX_OPENING_OBSERVATION' : sessionClose != null && barClose >= sessionClose - DHAN_SETUP_RULES.lastEntryBeforeCloseMs ? 'AFTER_CUTOFF' : 'MCX_SESSION';
  if (m <= 9 * 60 + 30) return 'OPENING_OBSERVATION';
  if (m <= 11 * 60 + 30) return 'PRIMARY';
  if (m <= 13 * 60 + 30) return 'SELECTIVE';
  if (m < 14 * 60 + 45) return 'SECONDARY'; // a bar closing at 14:45 cannot be entered inside the window
  return 'AFTER_CUTOFF';
}
const tradableWindow = (w: string) => w === 'PRIMARY' || w === 'SELECTIVE' || w === 'SECONDARY' || w === 'MCX_SESSION';

// ---------------- entry point ----------------

const MIRROR_KIND: Record<string, string> = { VAH: 'VAL', VAL: 'VAH' };
const mPlan = (p: TradePlan | null): TradePlan | null => (p ? { ...p, entry: -p.entry, sl: -p.sl, target: -p.target, targetKind: MIRROR_KIND[p.targetKind] ?? p.targetKind } : null);
function mirrorValue(v: unknown): unknown {
  // Evidence prices are mirrored back where they are plain price fields; structures are kept as recorded on the mirror.
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = typeof x === 'number' && /^(level|extreme|zone|boxHigh|boxLow|vwap|first|second|price)$/.test(k) ? -x : x;
    if ('boxHigh' in o && 'boxLow' in o) [o.boxHigh, o.boxLow] = [o.boxLow, o.boxHigh];
    return o;
  }
  return v;
}

export function evaluateDhanSetups(ctx: SetupContext): SetupsEvaluation {
  const last = ctx.bars.at(-1);
  const window = last ? sessionWindow(ctx.exchange, last.time + (ctx.barMs ?? 900_000), ctx.sessionClose) : 'NO_DATA';
  const base: SetupsEvaluation = { version: DHAN_SETUP_VERSION, symbol: ctx.symbol, barTime: last?.time ?? null, sessionWindow: window, regime: null, results: [] };
  const up = derive(ctx);
  if (!up) return base;
  const down = derive(mirrorContext(ctx))!;
  base.regime = up.regime;
  for (const key of Object.keys(SETUPS) as DhanSetupKey[]) {
    for (const [side, d] of [['BULLISH', up], ['BEARISH', down]] as const) {
      const r = SETUPS[key](d);
      const flip = side === 'BEARISH';
      const res: SetupResult = {
        setup: key, strategy: DHAN_SETUP_IDS[key], side, status: 'NO_SETUP', failed: r.failed, gates: [], score: null, noTrade: null,
        checks: flip ? r.checks.map((c) => ({ ...c, value: mirrorValue(c.value) })) : r.checks, plan: flip ? mPlan(r.plan) : r.plan,
        evidence: { zone: r.zone == null ? null : flip ? -r.zone : r.zone, atr: d.atr, window },
      };
      if (!r.failed && key === 'E') {
        // Pure order flow (owner, 9 Nov): only data validity, a defined plan and the session window; no score.
        res.gates = [
          { id: 'VALID_DATA', ok: !d.c.health.stale && d.c.health.mappingValid && !windowIncomplete(d, r.from) },
          { id: 'DEFINED_PLAN', ok: r.plan != null && r.plan.sl < r.plan.entry && r.plan.target > r.plan.entry, ...(r.plan ? { value: r.plan.rr } : {}) },
          { id: 'SESSION_WINDOW', ok: tradableWindow(window), value: window },
        ];
        res.status = res.gates.every((g) => g.ok) ? 'SIGNAL' : 'NO_TRADE';
      } else if (!r.failed) {
        const score = scoreOf(d, key, r)!;
        let noTrade = noTradeOf(d, key, r);
        if (!tradableWindow(window)) noTrade = { ...noTrade, tradeable: false, reasons: [...noTrade.reasons, `SESSION_${window}`] };
        res.score = score;
        res.gates = gatesOf(d, r);
        res.noTrade = noTrade;
        const ok = res.gates.every((g) => g.ok) && score.eligibility !== 'REJECT' && noTrade.tradeable;
        res.status = ok ? 'SIGNAL' : 'NO_TRADE';
      }
      base.results.push(res);
    }
  }
  return base;
}
