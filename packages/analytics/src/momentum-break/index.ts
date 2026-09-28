// ============================================================
// MOMENTUM-BREAK TRIGGER (pure)
// ============================================================
// A separate setup family from the consensus engine. The consensus read is
// an average of indicator agreement, so it can only rise after most of its
// indicators have already turned: it confirms a move once the move is over.
// This is a trigger instead. A CLOSED 15m bar breaks a key level with an
// expanded range and heavy volume; the stop sits just beyond the broken
// level, the target is the next level ahead, and indicators play no part.
//
// LOOK-AHEAD CONTRACT
//   - The decision is made on closed bar i. Levels, ATR and the volume
//     baseline are built from bars strictly before i; bar i contributes only
//     its own OHLCV (the thing being judged). Nothing after i is ever read.
//   - Entry is bar i's close.
//   - Every function here takes the whole series plus an index and slices
//     internally, so appending future bars cannot change a decision at i.
//     The backtest and the live engine call the same functions.
//
// OI walls are deliberately NOT levels in v1: there is no OI history to
// backtest them on, and the live rule must equal the tested rule.
// ============================================================

import { atr } from '../indicators/index.js';
import { findSwingPoints } from '../patterns/index.js';

export interface MomentumBar {
  /** Bar OPEN time, epoch ms. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MomentumLevelKind =
  | 'OPENING_RANGE_HIGH'
  | 'OPENING_RANGE_LOW'
  | 'DAY_HIGH'
  | 'DAY_LOW'
  | 'PREV_DAY_HIGH'
  | 'PREV_DAY_LOW'
  | 'VWAP'
  | 'SWING_HIGH'
  | 'SWING_LOW'
  | 'PIVOT_R1'
  | 'PIVOT_S1';

export interface MomentumLevel {
  kind: MomentumLevelKind;
  price: number;
}

/** The fixed rule. Only RANGE_MULT and VOL_MULT vary, and only across MOMENTUM_BREAK_VARIANTS. */
export const MOMENTUM_BREAK_RULES = {
  /** The close must clear the level by this much ATR. */
  breakAtr: 0.1,
  /** Bearish: close in the lower 35% of the bar's range (bullish mirrors). */
  closeLocationMax: 0.35,
  /** No chasing: the close may be at most this much ATR beyond the level. */
  maxChaseAtr: 1,
  /** Stop beyond the broken level, in ATR (the value of STRUCTURAL_STOP_BUFFER_ATR). */
  stopBufferAtr: 0.25,
  /** ...and at least this far beyond the close. */
  minStopAtr: 0.5,
  /** The target is the next level at least this many stop-distances away. */
  minTargetR: 1.5,
  atrPeriod: 14,
  /** ATR is Wilder's ATR14 over this many bars before i (a fixed window, so live and replay agree). */
  atrWindowBars: 100,
  /** Volume baseline: median of the same time slot over this many previous sessions... */
  volLookbackSessions: 10,
  /** ...with at least this many samples, or there is no volume read and no trigger. */
  volMinSessions: 5,
  openingRangeMinutes: 30,
  swingLookback: 2,
  swingWindowBars: 100,
} as const;

export type MomentumBreakRules = typeof MOMENTUM_BREAK_RULES;

export interface MomentumBreakVariant {
  id: string;
  rangeMult: number;
  volMult: number;
}

/** Pre-registered. The backtest chooses one on the in-sample period; nothing else is tuned. */
export const MOMENTUM_BREAK_VARIANTS: readonly MomentumBreakVariant[] = [
  { id: 'R1.2-V1.5', rangeMult: 1.2, volMult: 1.5 },
  { id: 'R1.2-V2.0', rangeMult: 1.2, volMult: 2.0 },
  { id: 'R1.5-V1.5', rangeMult: 1.5, volMult: 1.5 },
  { id: 'R1.5-V2.0', rangeMult: 1.5, volMult: 2.0 },
] as const;

const IST_OFFSET_MS = 330 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000;

/** IST calendar date of an epoch-ms instant, YYYY-MM-DD. */
export function istDateOf(time: number): string {
  return new Date(time + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** IST wall-clock HH:MM of an epoch-ms instant. */
export function istSlotOf(time: number): string {
  return new Date(time + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/**
 * The series with its session structure precomputed. Every field is a pure
 * function of each bar's own timestamp (or of earlier bars), so a prepared
 * prefix is identical to the same prefix of a longer prepared series.
 */
export interface MomentumSeries {
  bars: MomentumBar[];
  /** Session ordinal of each bar. */
  sessionIdx: number[];
  /** Index of the first bar of each session ordinal. */
  sessionStarts: number[];
  /** IST date of each session ordinal. */
  sessionDates: string[];
  /** Per session ordinal: time slot → bar index. */
  slotIndex: Array<Map<string, number>>;
}

/** Bars must be sorted ascending by time. A session is one IST calendar date. */
export function prepareMomentumSeries(bars: MomentumBar[]): MomentumSeries {
  const sessionIdx: number[] = [];
  const sessionStarts: number[] = [];
  const sessionDates: string[] = [];
  const slotIndex: Array<Map<string, number>> = [];
  let lastDate = '';
  for (let i = 0; i < bars.length; i++) {
    const date = istDateOf(bars[i].time);
    if (date !== lastDate) {
      sessionStarts.push(i);
      sessionDates.push(date);
      slotIndex.push(new Map());
      lastDate = date;
    }
    const s = sessionStarts.length - 1;
    sessionIdx.push(s);
    slotIndex[s].set(istSlotOf(bars[i].time), i);
  }
  return { bars, sessionIdx, sessionStarts, sessionDates, slotIndex };
}

/** Wilder ATR14 over the fixed window of bars before i. Null without enough history. */
export function momentumAtrAt(series: MomentumSeries, i: number, rules: MomentumBreakRules = MOMENTUM_BREAK_RULES): number | null {
  const from = Math.max(0, i - rules.atrWindowBars);
  const window = series.bars.slice(from, i);
  if (window.length < rules.atrPeriod + 1) return null;
  const values = atr(
    window.map((b) => b.high),
    window.map((b) => b.low),
    window.map((b) => b.close),
    rules.atrPeriod
  );
  const v = values[values.length - 1];
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

/** Median volume of bar i's time slot over the previous sessions (never bar i's own session). */
export function slotVolumeBaseline(
  series: MomentumSeries,
  i: number,
  rules: MomentumBreakRules = MOMENTUM_BREAK_RULES
): { median: number | null; samples: number } {
  const s = series.sessionIdx[i];
  const slot = istSlotOf(series.bars[i].time);
  const vols: number[] = [];
  for (let k = s - 1; k >= 0 && k >= s - rules.volLookbackSessions; k--) {
    const j = series.slotIndex[k].get(slot);
    if (j != null && j < i) vols.push(series.bars[j].volume);
  }
  if (vols.length < rules.volMinSessions) return { median: null, samples: vols.length };
  vols.sort((a, b) => a - b);
  const mid = Math.floor(vols.length / 2);
  const median = vols.length % 2 ? vols[mid] : (vols[mid - 1] + vols[mid]) / 2;
  return { median: median > 0 ? median : null, samples: vols.length };
}

/**
 * The key levels at bar i, from bars strictly before i: opening range, day
 * high/low so far, previous day high/low, session VWAP, the last confirmed
 * swing high/low, and the classic pivot R1/S1 from the previous session.
 */
export function buildMomentumLevels(series: MomentumSeries, i: number, rules: MomentumBreakRules = MOMENTUM_BREAK_RULES): MomentumLevel[] {
  const { bars } = series;
  const levels: MomentumLevel[] = [];
  const s = series.sessionIdx[i];
  const start = series.sessionStarts[s];

  // Today so far: bars [start, i).
  if (i > start) {
    let hi = -Infinity;
    let lo = Infinity;
    let pv = 0;
    let v = 0;
    for (let j = start; j < i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
      pv += ((bars[j].high + bars[j].low + bars[j].close) / 3) * bars[j].volume;
      v += bars[j].volume;
    }
    levels.push({ kind: 'DAY_HIGH', price: hi }, { kind: 'DAY_LOW', price: lo });
    if (v > 0) levels.push({ kind: 'VWAP', price: pv / v });

    // Opening range: the session's first `openingRangeMinutes`, only once
    // every bar in it has closed before bar i opens.
    const orEnd = bars[start].time + rules.openingRangeMinutes * 60 * 1000;
    if (bars[i].time >= orEnd) {
      let orHi = -Infinity;
      let orLo = Infinity;
      for (let j = start; j < i && bars[j].time < orEnd; j++) {
        orHi = Math.max(orHi, bars[j].high);
        orLo = Math.min(orLo, bars[j].low);
      }
      if (Number.isFinite(orHi)) levels.push({ kind: 'OPENING_RANGE_HIGH', price: orHi }, { kind: 'OPENING_RANGE_LOW', price: orLo });
    }
  }

  // Previous session: high/low and classic pivots.
  if (s > 0) {
    const pStart = series.sessionStarts[s - 1];
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = pStart; j < start; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    const close = bars[start - 1].close;
    const pp = (hi + lo + close) / 3;
    levels.push(
      { kind: 'PREV_DAY_HIGH', price: hi },
      { kind: 'PREV_DAY_LOW', price: lo },
      { kind: 'PIVOT_R1', price: 2 * pp - lo },
      { kind: 'PIVOT_S1', price: 2 * pp - hi }
    );
  }

  // Last CONFIRMED swing high/low: findSwingPoints only reports a fractal
  // once `lookback` bars after it exist, and it only sees bars before i.
  const wFrom = Math.max(0, i - rules.swingWindowBars);
  const window = bars.slice(wFrom, i);
  if (window.length >= 2 * rules.swingLookback + 1) {
    const { peaks, troughs } = findSwingPoints(window.map((b) => b.high), window.map((b) => b.low), rules.swingLookback);
    const peak = peaks[peaks.length - 1];
    const trough = troughs[troughs.length - 1];
    if (peak) levels.push({ kind: 'SWING_HIGH', price: peak.price });
    if (trough) levels.push({ kind: 'SWING_LOW', price: trough.price });
  }

  return levels.filter((l) => Number.isFinite(l.price) && l.price > 0);
}

export interface MomentumBreakSignal {
  direction: 'BULLISH' | 'BEARISH';
  levelKind: MomentumLevelKind;
  levelPrice: number;
  /** Trigger bar's close. */
  entry: number;
  stop: number;
  target: number;
  targetKind: MomentumLevelKind;
  /** Target distance in stop distances (underlying). */
  rUnderlying: number;
  /** Bar volume ÷ same-slot median. */
  volMult: number;
  /** True range ÷ ATR. */
  rangeMult: number;
  /** 0 = closed at the extreme in the trigger direction, 1 = at the opposite extreme. */
  closeLocation: number;
  atr: number;
  /** 70-95 from volume, range and close-location strength. */
  quality: number;
  /** Trigger bar OPEN time (epoch ms); it closed 15 minutes later. */
  barTime: number;
  variantId: string;
}

export type MomentumNoTrigger =
  | 'NO_HISTORY'
  | 'NO_ATR'
  | 'NO_VOLUME_BASELINE'
  | 'NO_LEVEL_BROKEN'
  | 'RANGE_TOO_SMALL'
  | 'VOLUME_TOO_LOW'
  | 'WEAK_CLOSE'
  | 'CHASING'
  | 'NO_TARGET';

export interface MomentumBreakEvaluation {
  signal: MomentumBreakSignal | null;
  /** The first rule that failed, when there is no signal. */
  failed: MomentumNoTrigger | null;
  atr: number | null;
  volMult: number | null;
  rangeMult: number | null;
  closeLocation: number | null;
  levels: MomentumLevel[];
}

const KIND_ORDER: MomentumLevelKind[] = [
  'PREV_DAY_HIGH',
  'PREV_DAY_LOW',
  'OPENING_RANGE_HIGH',
  'OPENING_RANGE_LOW',
  'DAY_HIGH',
  'DAY_LOW',
  'SWING_HIGH',
  'SWING_LOW',
  'PIVOT_R1',
  'PIVOT_S1',
  'VWAP',
];

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Judges closed bar i. Pure: reads bars[0..i] only (it slices off everything
 * after i before doing anything else).
 *
 * Bearish (bullish mirrors):
 *   previous close ≥ L and close ≤ L − 0.1·ATR
 *   true range ≥ RANGE_MULT·ATR14
 *   volume ≥ VOL_MULT × median volume of this time slot over the previous 10 sessions
 *   close in the lower 35% of the bar's range
 *   no chasing: L − close ≤ 1·ATR
 *   stop  = max(L + 0.25·ATR, close + 0.5·ATR)
 *   target = the nearest level below the close at least 1.5 stop-distances away; none → no trade
 *
 * When several levels break on the same bar, the one nearest the close is
 * used (the tightest honest stop); ties go to KIND_ORDER.
 */
export function evaluateMomentumBreak(
  seriesIn: MomentumSeries,
  i: number,
  variant: MomentumBreakVariant,
  rules: MomentumBreakRules = MOMENTUM_BREAK_RULES
): MomentumBreakEvaluation {
  const series = truncateSeries(seriesIn, i + 1);
  const empty = (failed: MomentumNoTrigger, extra: Partial<MomentumBreakEvaluation> = {}): MomentumBreakEvaluation => ({
    signal: null,
    failed,
    atr: null,
    volMult: null,
    rangeMult: null,
    closeLocation: null,
    levels: [],
    ...extra,
  });

  const { bars } = series;
  if (i < 1 || i >= bars.length) return empty('NO_HISTORY');
  const s = series.sessionIdx[i];
  // The bar before must be in the same session: a first bar of the day is
  // judged against yesterday's close, which is a gap, not a break.
  if (i === series.sessionStarts[s]) return empty('NO_HISTORY');

  const atrNow = momentumAtrAt(series, i, rules);
  if (atrNow == null) return empty('NO_ATR');
  const bar = bars[i];
  const prevClose = bars[i - 1].close;
  const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  const rangeMult = tr / atrNow;
  const span = bar.high - bar.low;
  const levels = buildMomentumLevels(series, i, rules);
  const base = slotVolumeBaseline(series, i, rules);
  const volMult = base.median != null ? bar.volume / base.median : null;

  const bearish = bar.close < prevClose;
  const direction: 'BULLISH' | 'BEARISH' = bearish ? 'BEARISH' : 'BULLISH';
  const closeLocation = span > 0 ? (bearish ? (bar.close - bar.low) / span : (bar.high - bar.close) / span) : 1;
  const diag = { atr: atrNow, volMult, rangeMult, closeLocation, levels };

  const broken = levels
    .filter((l) =>
      bearish
        ? prevClose >= l.price && bar.close <= l.price - rules.breakAtr * atrNow
        : prevClose <= l.price && bar.close >= l.price + rules.breakAtr * atrNow
    )
    .sort((a, b) => Math.abs(bar.close - a.price) - Math.abs(bar.close - b.price) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  if (broken.length === 0) return empty('NO_LEVEL_BROKEN', diag);
  if (rangeMult < variant.rangeMult) return empty('RANGE_TOO_SMALL', diag);
  if (base.median == null) return empty('NO_VOLUME_BASELINE', diag);
  if (volMult! < variant.volMult) return empty('VOLUME_TOO_LOW', diag);
  if (closeLocation > rules.closeLocationMax) return empty('WEAK_CLOSE', diag);
  const level = broken.find((l) => Math.abs(bar.close - l.price) <= rules.maxChaseAtr * atrNow);
  if (!level) return empty('CHASING', diag);

  const sign = bearish ? -1 : 1;
  const stop = bearish
    ? Math.max(level.price + rules.stopBufferAtr * atrNow, bar.close + rules.minStopAtr * atrNow)
    : Math.min(level.price - rules.stopBufferAtr * atrNow, bar.close - rules.minStopAtr * atrNow);
  const stopDist = Math.abs(bar.close - stop);
  const targets = levels
    .filter((l) => l !== level && sign * (l.price - bar.close) >= rules.minTargetR * stopDist)
    .sort((a, b) => Math.abs(a.price - bar.close) - Math.abs(b.price - bar.close) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const target = targets[0];
  if (!target) return empty('NO_TARGET', diag);

  // Strength past each threshold, 0 at the threshold and 1 at double it
  // (close location: 0 at the 35% line, 1 at the extreme).
  const volScore = clamp01(volMult! / variant.volMult - 1);
  const rangeScore = clamp01(rangeMult / variant.rangeMult - 1);
  const closeScore = clamp01((rules.closeLocationMax - closeLocation) / rules.closeLocationMax);
  const quality = Math.round(70 + 25 * ((volScore + rangeScore + closeScore) / 3));

  return {
    signal: {
      direction,
      levelKind: level.kind,
      levelPrice: round2(level.price),
      entry: bar.close,
      stop: round2(stop),
      target: round2(target.price),
      targetKind: target.kind,
      rUnderlying: round2(Math.abs(target.price - bar.close) / stopDist),
      volMult: round2(volMult!),
      rangeMult: round2(rangeMult),
      closeLocation: round2(closeLocation),
      atr: round2(atrNow),
      quality,
      barTime: bar.time,
      variantId: variant.id,
    },
    failed: null,
    ...diag,
  };
}

/** A 15m close back through the broken level ends the trade (LEVEL_RECLAIMED). */
export function isLevelReclaimed(direction: 'BULLISH' | 'BEARISH', levelPrice: number, close: number): boolean {
  return direction === 'BEARISH' ? close > levelPrice : close < levelPrice;
}

/**
 * The most recent trigger among the last `maxBars` closed bars ending at i
 * that price has not since closed back through. Used for the regime assist:
 * a qualified trigger reads as BREAKOUT/BREAKDOWN for that many bars.
 */
export function recentMomentumBreak(
  series: MomentumSeries,
  i: number,
  maxBars: number,
  variant: MomentumBreakVariant,
  rules: MomentumBreakRules = MOMENTUM_BREAK_RULES
): { signal: MomentumBreakSignal; barsAgo: number } | null {
  for (let k = i; k >= 0 && k > i - maxBars; k--) {
    const { signal } = evaluateMomentumBreak(series, k, variant, rules);
    if (!signal) continue;
    for (let j = k + 1; j <= i; j++) {
      if (isLevelReclaimed(signal.direction, signal.levelPrice, series.bars[j].close)) return null;
    }
    return { signal, barsAgo: i - k };
  }
  return null;
}

/** The prefix [0, n) of a prepared series, as if only those bars existed. */
export function truncateSeries(series: MomentumSeries, n: number): MomentumSeries {
  if (n >= series.bars.length) return series;
  const lastSession = n > 0 ? series.sessionIdx[n - 1] : -1;
  const slotIndex = series.slotIndex.slice(0, lastSession + 1);
  if (lastSession >= 0) {
    const trimmed = new Map<string, number>();
    for (const [slot, j] of slotIndex[lastSession]) if (j < n) trimmed.set(slot, j);
    slotIndex[lastSession] = trimmed;
  }
  return {
    bars: series.bars.slice(0, n),
    sessionIdx: series.sessionIdx.slice(0, n),
    sessionStarts: series.sessionStarts.slice(0, lastSession + 1),
    sessionDates: series.sessionDates.slice(0, lastSession + 1),
    slotIndex,
  };
}

/** Closed bars only: drop any bar that had not finished by `now` (the live newest bar is still forming). */
export function closedBarsAt<T extends { time: number }>(bars: T[], now: number, barMs: number = BAR_MS): T[] {
  let n = bars.length;
  while (n > 0 && bars[n - 1].time + barMs > now) n--;
  return n === bars.length ? bars : bars.slice(0, n);
}
