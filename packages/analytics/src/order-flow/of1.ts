// ============================================================
// OF1 — Order Flow Confirmation (pre-registered, OF1-1.0)
// ============================================================
// LOCATION + ORDER FLOW + PRICE RESPONSE, judged at the close of a decision
// bar i on bars ≤ i only. Independent of every other family: it needs no
// other trigger first. Shadow / measurement only until promoted.
//
// Bullish (bearish mirrors):
//   LOCATION   a SUPPORT level known before bar i — previous-session low /
//              high (PDL / PDH), opening-range low / high, session VWAP,
//              an unfilled bullish FVG, a FRESH OB-2.0 block, the previous
//              session's VAL / POC / VAH, a confirmed swing low — that bar i
//              reaches: low_i ≤ level + locationTolAtr × ATR. The nearest such
//              level to bar i's low is the location.
//   PRICE      bar i closes above the level (reclaim / hold) and in the
//              upper half of its own range.
//   FLOW       at least minFlowEvidence of these, counted only where the
//              footprint can measure them (an unmeasurable item never counts):
//                DELTA        deltaPct ≥ deltaPctMin
//                IMBALANCE    ≥ minImbalances buy-imbalance levels
//                ABSORPTION   selling absorbed at the lows (order-flow/index.ts)
//                POC_UP       the bar's POC above the previous bar's POC
//                ACCEPTANCE   ≥ acceptanceShare of the bar's volume above the level
//              and the footprint must exist (deltaMode ≠ UNAVAILABLE).
// Entry = close_i. Stop = min(low_i, level) − stopBufferAtr × ATR. T1 = the
// nearest RESISTANCE level above the entry by ≥ targetMinAtr × ATR (none →
// no target: recorded, never tradeable).
// ============================================================

import { atrAsOf, detectOrderBlocks, type OhlcBar } from '../market-structure/index.js';
import { detectFairValueGaps } from '../fvg/index.js';
import { findSwingPoints } from '../patterns/index.js';
import { absorption, valueArea, volumeShareBeyond, type DeltaMode, type FootprintBar } from './index.js';

export const OF1_VERSION = 'OF1-1.0';

export const OF1_RULES = Object.freeze({
  locationTolAtr: 0.25,
  minFlowEvidence: 2,
  deltaPctMin: 0.1,
  minImbalances: 2,
  acceptanceShare: 0.6,
  stopBufferAtr: 0.1,
  targetMinAtr: 0.5,
  openingRangeBars: 2,
});

export type Of1LocationKind = 'PDH' | 'PDL' | 'OR_HIGH' | 'OR_LOW' | 'VWAP' | 'FVG' | 'ORDER_BLOCK' | 'VAH' | 'VAL' | 'POC' | 'SWING_HIGH' | 'SWING_LOW';
export interface Of1Location {
  kind: Of1LocationKind;
  price: number;
  /** SUPPORT for a bullish read, RESISTANCE for a bearish one; VWAP / POC serve both. */
  role: 'SUPPORT' | 'RESISTANCE' | 'BOTH';
}

export type Of1Evidence = 'DELTA' | 'IMBALANCE' | 'ABSORPTION' | 'POC_UP' | 'POC_DOWN' | 'ACCEPTANCE';

export interface Of1Bar extends OhlcBar {
  time: number;
  volume?: number;
}

export interface Of1Candidate {
  version: typeof OF1_VERSION;
  direction: 'BULLISH' | 'BEARISH';
  decisionIndex: number;
  decisionTime: number;
  /** e.g. PDL_ABSORPTION: the location kind and the first evidence in fixed order. */
  subtype: string;
  location: Of1Location;
  atr: number;
  entry: number;
  stop: number;
  target: Of1Location | null;
  evidence: Of1Evidence[];
  /** Evidence items that could be measured on this footprint. */
  measurable: Of1Evidence[];
  deltaMode: DeltaMode;
  delta: number | null;
  deltaPct: number | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  imbalances: number;
  absorption: boolean | null;
  priceConfirmation: string;
}

const istDate = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** The levels known before bar i (bars < i, footprints < i). */
export function of1Locations(bars: readonly Of1Bar[], i: number, footprints: ReadonlyMap<number, FootprintBar>): Of1Location[] {
  const out: Of1Location[] = [];
  const day = istDate(bars[i].time);
  const start = bars.findIndex((b) => istDate(b.time) === day);
  const prevBars = start > 0 ? bars.slice(0, start).filter((b) => istDate(b.time) === istDate(bars[start - 1].time)) : [];
  if (prevBars.length) {
    out.push({ kind: 'PDH', price: Math.max(...prevBars.map((b) => b.high)), role: 'RESISTANCE' });
    out.push({ kind: 'PDL', price: Math.min(...prevBars.map((b) => b.low)), role: 'SUPPORT' });
    // The previous session's volume profile, from its footprints.
    const merged = new Map<number, number>();
    for (const b of prevBars) for (const l of footprints.get(b.time)?.levels ?? []) merged.set(l.price, (merged.get(l.price) ?? 0) + l.buy + l.sell + l.unclassified);
    const va = valueArea([...merged].map(([price, total]) => ({ price, total })));
    if (va) out.push({ kind: 'VAH', price: va.vah, role: 'RESISTANCE' }, { kind: 'VAL', price: va.val, role: 'SUPPORT' }, { kind: 'POC', price: va.poc, role: 'BOTH' });
  }
  const today = bars.slice(start, i);
  if (today.length >= OF1_RULES.openingRangeBars) {
    const or = today.slice(0, OF1_RULES.openingRangeBars);
    out.push({ kind: 'OR_HIGH', price: Math.max(...or.map((b) => b.high)), role: 'RESISTANCE' }, { kind: 'OR_LOW', price: Math.min(...or.map((b) => b.low)), role: 'SUPPORT' });
  }
  // Session VWAP on the bars' own volume (typical price); unavailable without volume.
  const vw = today.filter((b) => (b.volume ?? 0) > 0);
  if (vw.length) {
    const v = vw.reduce((a, b) => a + (b.volume ?? 0), 0);
    out.push({ kind: 'VWAP', price: vw.reduce((a, b) => a + ((b.high + b.low + b.close) / 3) * (b.volume ?? 0), 0) / v, role: 'BOTH' });
  }
  const hist = bars.slice(0, i);
  for (const g of detectFairValueGaps(hist.map((b) => b.high), hist.map((b) => b.low)))
    if (!g.filled) out.push({ kind: 'FVG', price: g.type === 'BULLISH' ? g.top : g.bottom, role: g.type === 'BULLISH' ? 'SUPPORT' : 'RESISTANCE' });
  for (const ob of detectOrderBlocks(hist))
    if (ob.state === 'FRESH') out.push({ kind: 'ORDER_BLOCK', price: ob.type === 'BULLISH' ? ob.top : ob.bottom, role: ob.type === 'BULLISH' ? 'SUPPORT' : 'RESISTANCE' });
  const { peaks, troughs } = findSwingPoints(hist.map((b) => b.high), hist.map((b) => b.low), 2);
  for (const p of peaks.slice(-3)) out.push({ kind: 'SWING_HIGH', price: p.price, role: 'RESISTANCE' });
  for (const t of troughs.slice(-3)) out.push({ kind: 'SWING_LOW', price: t.price, role: 'SUPPORT' });
  return out;
}

const EVIDENCE_ORDER: readonly Of1Evidence[] = ['ABSORPTION', 'IMBALANCE', 'DELTA', 'POC_UP', 'POC_DOWN', 'ACCEPTANCE'];

/**
 * OF1 at closed bar i, both directions; null when neither qualifies. Reads
 * bars ≤ i and footprints of bars ≤ i only.
 */
export function evaluateOf1(bars: readonly Of1Bar[], i: number, footprints: ReadonlyMap<number, FootprintBar>, locations: readonly Of1Location[] = of1Locations(bars, i, footprints)): Of1Candidate[] {
  const R = OF1_RULES;
  const a = atrAsOf(bars.slice(0, i + 1))[i];
  const fp = footprints.get(bars[i].time);
  if (a == null || !(a > 0) || !fp || fp.deltaMode === 'UNAVAILABLE') return [];
  const bar = bars[i];
  const prevFp = i > 0 ? footprints.get(bars[i - 1].time) ?? null : null;
  const out: Of1Candidate[] = [];
  for (const dir of ['BULLISH', 'BEARISH'] as const) {
    const bull = dir === 'BULLISH';
    const near = locations
      .filter((l) => l.role === 'BOTH' || l.role === (bull ? 'SUPPORT' : 'RESISTANCE'))
      .filter((l) => (bull ? bar.low <= l.price + R.locationTolAtr * a && bar.close > l.price : bar.high >= l.price - R.locationTolAtr * a && bar.close < l.price))
      .sort((x, y) => Math.abs((bull ? bar.low : bar.high) - x.price) - Math.abs((bull ? bar.low : bar.high) - y.price) || x.kind.localeCompare(y.kind));
    const loc = near[0];
    if (!loc) continue;
    const range = bar.high - bar.low;
    const halfOk = range > 0 && (bull ? bar.close >= bar.low + range / 2 : bar.close <= bar.high - range / 2);
    if (!halfOk) continue;

    const measurable: Of1Evidence[] = [];
    const evidence: Of1Evidence[] = [];
    const take = (e: Of1Evidence, v: boolean | null) => {
      if (v == null) return;
      measurable.push(e);
      if (v) evidence.push(e);
    };
    take('DELTA', fp.deltaPct == null ? null : bull ? fp.deltaPct >= R.deltaPctMin : fp.deltaPct <= -R.deltaPctMin);
    take('IMBALANCE', fp.delta == null ? null : (bull ? fp.buyImbalances : fp.sellImbalances) >= R.minImbalances);
    take('ABSORPTION', absorption(fp, bar, dir));
    take(bull ? 'POC_UP' : 'POC_DOWN', fp.poc == null || prevFp?.poc == null ? null : bull ? fp.poc > prevFp.poc : fp.poc < prevFp.poc);
    const share = volumeShareBeyond(fp, loc.price, bull ? 'ABOVE' : 'BELOW');
    take('ACCEPTANCE', share == null ? null : share >= R.acceptanceShare);
    if (evidence.length < R.minFlowEvidence) continue;

    const entry = bar.close;
    const stop = bull ? Math.min(bar.low, loc.price) - R.stopBufferAtr * a : Math.max(bar.high, loc.price) + R.stopBufferAtr * a;
    const target =
      locations
        .filter((l) => l.role === 'BOTH' || l.role === (bull ? 'RESISTANCE' : 'SUPPORT'))
        .filter((l) => (bull ? l.price - entry : entry - l.price) >= R.targetMinAtr * a)
        .sort((x, y) => Math.abs(x.price - entry) - Math.abs(y.price - entry) || x.kind.localeCompare(y.kind))[0] ?? null;
    const primary = EVIDENCE_ORDER.find((e) => evidence.includes(e))!;
    out.push({
      version: OF1_VERSION,
      direction: dir,
      decisionIndex: i,
      decisionTime: bar.time,
      subtype: `${loc.kind}_${primary}`,
      location: loc,
      atr: a,
      entry,
      stop,
      target,
      evidence,
      measurable,
      deltaMode: fp.deltaMode,
      delta: fp.delta,
      deltaPct: fp.deltaPct,
      poc: fp.poc,
      vah: fp.vah,
      val: fp.val,
      imbalances: bull ? fp.buyImbalances : fp.sellImbalances,
      absorption: absorption(fp, bar, dir),
      priceConfirmation: bull ? `closed ${entry} above ${loc.kind} ${round(loc.price)}, upper half of its range` : `closed ${entry} below ${loc.kind} ${round(loc.price)}, lower half of its range`,
    });
  }
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100;
