// ============================================================
// CVD (master prompt 4.3) — one stream per contract, reset per session
// ============================================================
// CVD = previous CVD + current VALID delta. A bar whose delta is withheld (INCOMPLETE / UNAVAILABLE) adds nothing, and
// every later point of that session is INCOMPLETE: a gap means the running total no longer equals the session's true
// estimated delta, so nothing downstream (divergence) may read it as complete. The next session starts clean.
// Rolling CVD: sum of the last N deltas (null if any of them is missing). Delta momentum: CVD change over the last k
// bars (null across a gap). Delta reversal: two bars of one sign, then the opposite sign.
// Divergence uses confirmed price pivots (structure.ts), never an incomplete bar:
//   bullish: the last two pivot lows make a lower low while CVD at them makes a higher low; bearish the mirror.
// Futures and spot are never mixed: the caller passes one contract's bars.
// ============================================================

import { confirmedPivots } from './structure.js';
import { DHAN_ENGINE_RULES, type EngineBar, type EngineStatus, type Side } from './common.js';

export interface CvdInputBar extends EngineBar {
  /** Estimated delta of the bar; null when withheld. */
  delta: number | null;
}

export interface CvdPoint {
  time: number;
  session: string;
  delta: number | null;
  cvd: number;
  status: Extract<EngineStatus, 'ESTIMATED' | 'INCOMPLETE'>;
  rolling: number | null;
  momentum: number | null;
  reversal: Side | null;
}

export function cvdSeries(bars: readonly CvdInputBar[], sessionOf: (time: number) => string, opts: { rollingBars?: number; momentumBars?: number } = {}): CvdPoint[] {
  const nRoll = opts.rollingBars ?? DHAN_ENGINE_RULES.cvdRollingBars;
  const nMom = opts.momentumBars ?? DHAN_ENGINE_RULES.cvdMomentumBars;
  const out: CvdPoint[] = [];
  let session = '', cvd = 0, gap = false, start = 0;
  bars.forEach((b, i) => {
    const s = sessionOf(b.time);
    if (s !== session) (session = s), (cvd = 0), (gap = false), (start = i);
    if (b.delta == null) gap = true;
    else cvd += b.delta;
    const win = bars.slice(Math.max(start, i - nRoll + 1), i + 1);
    const rolling = win.length === nRoll && win.every((x) => x.delta != null) ? win.reduce((a, x) => a + (x.delta as number), 0) : null;
    const back = out[i - nMom];
    const momentum = i - nMom >= start && back && back.status === 'ESTIMATED' && !gap ? cvd - back.cvd : null;
    const d = (k: number) => (k >= start ? bars[k].delta : null);
    const [d2, d1, d0] = [d(i - 2), d(i - 1), b.delta];
    const reversal: Side | null = d2 != null && d1 != null && d0 != null ? (d2 < 0 && d1 < 0 && d0 > 0 ? 'BULLISH' : d2 > 0 && d1 > 0 && d0 < 0 ? 'BEARISH' : null) : null;
    out.push({ time: b.time, session: s, delta: b.delta, cvd, status: gap ? 'INCOMPLETE' : 'ESTIMATED', rolling, momentum, reversal });
  });
  return out;
}

export interface CvdDivergence {
  side: Side;
  /** The two pivots compared (bar indices) and the bar from which the divergence is known. */
  first: number;
  second: number;
  knownAt: number;
  price: [number, number];
  cvd: [number, number];
}

/** Divergences between confirmed price pivots and CVD, within one session, on complete CVD only. */
export function cvdDivergences(bars: readonly CvdInputBar[], points: readonly CvdPoint[]): CvdDivergence[] {
  const out: CvdDivergence[] = [];
  const pivots = confirmedPivots(bars);
  for (const kind of ['LOW', 'HIGH'] as const) {
    const ps = pivots.filter((p) => p.kind === kind);
    for (let k = 1; k < ps.length; k++) {
      const a = ps[k - 1], b = ps[k];
      const pa = points[a.index], pb = points[b.index];
      if (!pa || !pb || pa.session !== pb.session || pa.status !== 'ESTIMATED' || pb.status !== 'ESTIMATED') continue;
      if (kind === 'LOW' && b.price < a.price && pb.cvd > pa.cvd) out.push({ side: 'BULLISH', first: a.index, second: b.index, knownAt: b.confirmedAt, price: [a.price, b.price], cvd: [pa.cvd, pb.cvd] });
      if (kind === 'HIGH' && b.price > a.price && pb.cvd < pa.cvd) out.push({ side: 'BEARISH', first: a.index, second: b.index, knownAt: b.confirmedAt, price: [a.price, b.price], cvd: [pa.cvd, pb.cvd] });
    }
  }
  return out.sort((x, y) => x.knownAt - y.knownAt);
}

/** IST trading-day key (exchange sessions are within one IST calendar day for NSE / BSE / MCX). */
export const istSession = (t: number) => new Date(t + 19_800_000).toISOString().slice(0, 10);
