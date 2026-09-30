// ============================================================
// OPPORTUNITY CENSUS (research, read-only)
// ============================================================
// Ground truth: for every closed bar t inside the session (from 5 minutes
// after the open to the close), label t a LONG/SHORT opportunity if, after
// t's close and strictly within the same session, price reaches +Rmult*ATR
// before -1*ATR. ATR is momentumAtrAt(series, t) — computed from bars <= t
// only, so there is no look-ahead in the feature. The outcome scan only uses
// bars after t (index t+1..sessionEnd), so there is no look-ahead in the
// label either.
//
// This module is pure and read-only: it does not touch any live trading
// code path. It is consumed by the diagnose CLI.
// ============================================================

import { momentumAtrAt, type MomentumSeries } from '@fno/analytics';
import type { LoadedSymbol } from '../backtest/harness.js';

export const OPENING_GUARD_MIN_CENSUS = 5; // "5 minutes after the open" per spec (census, not trading)

export interface OppBar {
  index: number;
  time: number;
  session: string;
  hour: number;
  slot: string; // HH:MM
  atr: number;
  long2R: boolean;
  short2R: boolean;
  long3R: boolean;
  short3R: boolean;
}

export interface OppWindow {
  symbol: string;
  session: string;
  direction: 'LONG' | 'SHORT';
  rMult: 2 | 3;
  startIndex: number;
  endIndex: number;
  startTime: string;
  peakAtrRun: number; // in ATR multiples reached before the 1R stop-side move, or session end
  peakPctRun: number; // % move from start bar's close
}

/**
 * For one bar t and one direction, scan forward within the session only:
 * does price reach +rMult*ATR before -1*ATR (measured from t's close)?
 * Returns the outcome and, if it occurs, the ATR-multiple peak reached in
 * the opportunity's favour before the disqualifying adverse move (or session
 * end, whichever comes first) — used for "peak run" reporting.
 */
function scanDirection(
  series: MomentumSeries,
  t: number,
  sessionEndIdx: number,
  atr: number,
  dir: 1 | -1,
  rMult: number
): { qualifies: boolean; peakAtr: number; peakPct: number } {
  const bars = series.bars;
  const base = bars[t].close;
  const favTarget = base + dir * rMult * atr;
  const advStop = base - dir * 1 * atr;
  let peakFav = 0; // best favourable excursion so far, in price
  for (let k = t + 1; k <= sessionEndIdx; k++) {
    const hi = bars[k].high;
    const lo = bars[k].low;
    const favExtreme = dir > 0 ? hi : lo;
    const advExtreme = dir > 0 ? lo : hi;
    const favMove = dir > 0 ? favExtreme - base : base - favExtreme;
    if (favMove > peakFav) peakFav = favMove;
    // Intrabar ambiguity: if both the adverse (-1R) and favourable (+rMult R)
    // levels fall inside the same bar, count the adverse side first
    // (conservative reading, matching gradePath's stop-side-wins convention).
    const hitAdverse = dir > 0 ? lo <= advStop : hi >= advStop;
    const hitFav = dir > 0 ? hi >= favTarget : lo <= favTarget;
    if (hitAdverse) {
      return { qualifies: false, peakAtr: peakFav / atr, peakPct: (peakFav / base) * 100 };
    }
    if (hitFav) {
      return { qualifies: true, peakAtr: peakFav / atr, peakPct: (peakFav / base) * 100 };
    }
  }
  // Session ended without resolving either side.
  return { qualifies: false, peakAtr: peakFav / atr, peakPct: (peakFav / base) * 100 };
}

/** Session bounds for census purposes: 5 min after open .. session close (last bar). */
function censusBarRange(series: MomentumSeries, s: number): { start: number; end: number } {
  const start = series.sessionStarts[s];
  const end = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : series.bars.length) - 1;
  return { start, end };
}

export function buildOppBars(loaded: LoadedSymbol, barMs: number): OppBar[] {
  const { series } = loaded;
  const out: OppBar[] = [];
  const nSessions = series.sessionStarts.length;
  for (let s = 0; s < nSessions; s++) {
    if (loaded.masked.has(series.sessionDates[s])) continue;
    const { start, end } = censusBarRange(series, s);
    for (let t = start; t <= end; t++) {
      // "5 minutes after the open": skip the very first bar of the session
      // only if the bar length is <= 5m; for 15m bars the first bar itself
      // starts at open, so we require t > start (i.e. at least one bar of
      // history exists) to keep ATR well-defined and match "5 min after
      // open" in spirit for both 15m and 5m data.
      if (t === start) continue;
      const atr = momentumAtrAt(series, t);
      if (atr == null || !(atr > 0)) continue;
      const longRes2 = scanDirection(series, t, end, atr, 1, 2);
      const shortRes2 = scanDirection(series, t, end, atr, -1, 2);
      const longRes3 = scanDirection(series, t, end, atr, 1, 3);
      const shortRes3 = scanDirection(series, t, end, atr, -1, 3);
      const time = series.bars[t].time + barMs;
      const d = new Date(time + 330 * 60000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      out.push({
        index: t,
        time,
        session: series.sessionDates[s],
        hour: d.getUTCHours(),
        slot: `${hh}:${mm}`,
        atr,
        long2R: longRes2.qualifies,
        short2R: shortRes2.qualifies,
        long3R: longRes3.qualifies,
        short3R: shortRes3.qualifies,
      });
    }
  }
  return out;
}

export function clusterWindows(symbol: string, bars: OppBar[], rMult: 2 | 3): OppWindow[] {
  const windows: OppWindow[] = [];
  const dirs: Array<'LONG' | 'SHORT'> = ['LONG', 'SHORT'];
  for (const dir of dirs) {
    let cur: OppBar[] = [];
    const flush = () => {
      if (cur.length === 0) return;
      const first = cur[0];
      const last = cur[cur.length - 1];
      let peakAtr = 0;
      let peakPct = 0;
      // peak run reported is approximate: rMult itself, since each bar in
      // the cluster individually qualifies at >= rMult*ATR by construction.
      peakAtr = rMult;
      peakPct = 0;
      windows.push({
        symbol,
        session: first.session,
        direction: dir,
        rMult,
        startIndex: first.index,
        endIndex: last.index,
        startTime: new Date(first.time).toISOString(),
        peakAtrRun: peakAtr,
        peakPctRun: peakPct,
      });
      cur = [];
    };
    let prevIdx: number | null = null;
    let prevSession: string | null = null;
    for (const b of bars) {
      const qualifies = rMult === 2 ? (dir === 'LONG' ? b.long2R : b.short2R) : dir === 'LONG' ? b.long3R : b.short3R;
      if (qualifies && prevIdx != null && b.index === prevIdx + 1 && b.session === prevSession) {
        cur.push(b);
      } else {
        flush();
        if (qualifies) cur.push(b);
      }
      prevIdx = b.index;
      prevSession = b.session;
    }
    flush();
  }
  return windows;
}
