// ============================================================
// VWAP (master prompt 8.1) and RELATIVE VOLUME (8.2)
// ============================================================
// Session VWAP = Σ(price × qty) / Σ(qty), reset at the session boundary. Standard-deviation bands use the volume-
// weighted variance Σ(p²q)/Σq − VWAP². From observed trades it is 'ESTIMATED' (a sample: unreconciled volume has no
// price) and INCOMPLETE below the sampled-coverage floor; from candles (typical price × volume) it is labelled
// 'APPROXIMATION', always.
// Slope: VWAP change over `vwapSlopeBars` bars ÷ ATR. Distance: (close − VWAP) in SDs and in ATRs.
// Reclaim: previous close below VWAP, this close above it; rejection (bearish): high reached VWAP from below and the
// bar closed back below it. Mirrors for the other side.
// RVOL: this interval's volume ÷ mean volume of the same time-of-day interval over the previous 20 valid sessions;
// fewer than 20 sessions -> UNAVAILABLE (never a noisy ratio from 3 days).
// ============================================================

import { FLOW_MIN_SAMPLED_COVERAGE } from '../order-flow/index.js';
import { DHAN_ENGINE_RULES, roundDp, type EngineStatus, type Side } from './common.js';

export interface VwapSums {
  /** Σ price × qty, Σ qty, Σ price² × qty. */
  pv: number;
  v: number;
  p2v: number;
}

export const emptyVwapSums = (): VwapSums => ({ pv: 0, v: 0, p2v: 0 });
export function addTrade(s: VwapSums, price: number, qty: number): VwapSums {
  if (!(qty > 0) || !Number.isFinite(price)) return s;
  s.pv += price * qty; s.v += qty; s.p2v += price * price * qty;
  return s;
}

export interface VwapReading {
  status: EngineStatus;
  source: 'TRADES' | 'CANDLES';
  vwap: number | null;
  sd: number | null;
  bands: { upper1: number; lower1: number; upper2: number; lower2: number } | null;
}

export function vwapFromSums(s: VwapSums, source: 'TRADES' | 'CANDLES', unreconciled = 0): VwapReading {
  if (!(s.v > 0)) return { status: 'UNAVAILABLE', source, vwap: null, sd: null, bands: null };
  const vwap = s.pv / s.v;
  const sd = Math.sqrt(Math.max(0, s.p2v / s.v - vwap * vwap));
  // Sampled (owner, 9 Nov): observed trades stand for the session's VWAP while they cover enough of its volume.
  const coverage = unreconciled > 0 ? s.v / (unreconciled + s.v) : 1;
  const status: EngineStatus = source === 'CANDLES' ? 'APPROXIMATION' : coverage < FLOW_MIN_SAMPLED_COVERAGE ? 'INCOMPLETE' : 'ESTIMATED';
  return { status, source, vwap: roundDp(vwap, 4), sd: roundDp(sd, 4), bands: { upper1: roundDp(vwap + sd, 4), lower1: roundDp(vwap - sd, 4), upper2: roundDp(vwap + 2 * sd, 4), lower2: roundDp(vwap - 2 * sd, 4) } };
}

export interface VwapBarInput {
  time: number;
  high: number;
  low: number;
  close: number;
  /** This bar's own sums (not cumulative). For candles, use candleSums(bar). */
  sums: VwapSums;
  unreconciled?: number;
}

export interface VwapPoint extends VwapReading {
  time: number;
  slopeAtr: number | null;
  distanceSd: number | null;
  distanceAtr: number | null;
  event: { type: 'RECLAIM' | 'REJECTION'; side: Side } | null;
}

/** Typical-price candle sums: the approximation used when no trades are available. */
export const candleSums = (b: { high: number; low: number; close: number; volume: number }): VwapSums => {
  const tp = (b.high + b.low + b.close) / 3;
  return { pv: tp * b.volume, v: b.volume, p2v: tp * tp * b.volume };
};

export function vwapSeries(bars: readonly VwapBarInput[], sessionOf: (t: number) => string, source: 'TRADES' | 'CANDLES', atr: number | null, slopeBars: number = DHAN_ENGINE_RULES.vwapSlopeBars): VwapPoint[] {
  const out: VwapPoint[] = [];
  let session = '', acc = emptyVwapSums(), unrec = 0, start = 0;
  bars.forEach((b, i) => {
    const s = sessionOf(b.time);
    if (s !== session) (session = s), (acc = emptyVwapSums()), (unrec = 0), (start = i);
    acc = { pv: acc.pv + b.sums.pv, v: acc.v + b.sums.v, p2v: acc.p2v + b.sums.p2v };
    unrec += b.unreconciled ?? 0;
    const r = vwapFromSums(acc, source, unrec);
    const back = i - slopeBars >= start ? out[i - slopeBars] : undefined;
    const slopeAtr = r.vwap != null && back?.vwap != null && atr && atr > 0 ? roundDp((r.vwap - back.vwap) / atr, 4) : null;
    const prev = i > start ? out[i - 1] : undefined;
    let event: VwapPoint['event'] = null;
    if (r.vwap != null && prev?.vwap != null) {
      const pc = bars[i - 1].close;
      if (pc < prev.vwap && b.close > r.vwap) event = { type: 'RECLAIM', side: 'BULLISH' };
      else if (pc > prev.vwap && b.close < r.vwap) event = { type: 'RECLAIM', side: 'BEARISH' };
      else if (pc < prev.vwap && b.high >= r.vwap && b.close < r.vwap) event = { type: 'REJECTION', side: 'BEARISH' };
      else if (pc > prev.vwap && b.low <= r.vwap && b.close > r.vwap) event = { type: 'REJECTION', side: 'BULLISH' };
    }
    out.push({
      ...r, time: b.time, slopeAtr, event,
      distanceSd: r.vwap != null && r.sd ? roundDp((b.close - r.vwap) / r.sd, 4) : null,
      distanceAtr: r.vwap != null && atr && atr > 0 ? roundDp((b.close - r.vwap) / atr, 4) : null,
    });
  });
  return out;
}

export interface RvolReading {
  status: EngineStatus;
  rvol: number | null;
  sessions: number;
  breakout: boolean;
}

/** `references` = the same time-of-day interval's volume on previous valid sessions, most recent last. */
export function relativeVolume(current: number, references: readonly number[], sessions: number = DHAN_ENGINE_RULES.rvolSessions, threshold: number = DHAN_ENGINE_RULES.rvolBreakout): RvolReading {
  const ref = references.filter((v) => Number.isFinite(v) && v >= 0).slice(-sessions);
  const mean = ref.reduce((a, v) => a + v, 0) / Math.max(1, ref.length);
  if (ref.length < sessions || !(mean > 0) || !Number.isFinite(current)) return { status: 'UNAVAILABLE', rvol: null, sessions: ref.length, breakout: false };
  const rvol = roundDp(current / mean, 4);
  return { status: 'VERIFIED', rvol, sessions: ref.length, breakout: rvol >= threshold };
}
