// ============================================================
// SESSION-CLOSE BAR ANOMALY (2026-10-09) — data quality
// ============================================================
// The broker's 15m history, read right after an NSE session closes, has
// served a final (15:15) index bar whose high / low lie OUTSIDE the day's
// real range — NIFTY on 6, 7 and 8 Oct, BANKNIFTY on 6 and 8 Oct — later
// replaced by a flat bar at the closing price. Such a bar feeds false events
// into the close-of-day structure state and false target / stop hits into
// grading.
//
// Rule (fixed, documented): on NSE / BSE, the session's FINAL bar is an
// anomaly when its range is more than ANOMALY_RANGE_MULT × the median range of
// the session's earlier bars AND it trades beyond the earlier session high or
// low. MCX is excluded: its final bar can be a genuine late move (CRUDEOIL
// 1 Oct 23:15 opened at the previous close and closed 1.7% higher) and the
// broker anomaly has only been observed on NSE indices.
//
// What is done with it: recorded (bar_anomalies) and, in GRADING only,
// replaced by a flat bar at its close (what the broker serves later). The
// live engines are not changed by this release — they read the bar as
// before — until the recorded anomalies confirm the rule.
// ============================================================

import { getSessionWindow, type Exchange } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';

export const BAR_ANOMALY_MIGRATION = '039_bar_anomalies.sql';
export const ANOMALY_RANGE_MULT = 3;
const BAR_MS = 15 * 60 * 1000;
const MIN_SESSION_BARS = 8;

export interface OhlcTimeBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CloseBarAnomaly {
  index: number;
  barTime: number;
  high: number;
  low: number;
  close: number;
  sessionHigh: number;
  sessionLow: number;
  medianRange: number;
  reason: string;
}

const istDate = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Pure: is bar `i` its session's final bar AND anomalous? */
export function sessionCloseBarAnomalyAt(bars: readonly OhlcTimeBar[], i: number, exchange: Exchange): CloseBarAnomaly | null {
  const b = bars[i];
  if (!b || (exchange !== 'NSE' && exchange !== 'BSE')) return null;
  const day = istDate(b.time);
  const w = getSessionWindow(exchange, day);
  if (!w || b.time + BAR_MS < w.close) return null;
  const earlier = bars.slice(0, i).filter((x) => istDate(x.time) === day);
  if (earlier.length < MIN_SESSION_BARS) return null;
  const med = median(earlier.map((x) => x.high - x.low));
  if (!(med > 0)) return null;
  const sessionHigh = Math.max(...earlier.map((x) => x.high));
  const sessionLow = Math.min(...earlier.map((x) => x.low));
  const range = b.high - b.low;
  if (range <= ANOMALY_RANGE_MULT * med || (b.high <= sessionHigh && b.low >= sessionLow)) return null;
  return {
    index: i,
    barTime: b.time,
    high: b.high,
    low: b.low,
    close: b.close,
    sessionHigh,
    sessionLow,
    medianRange: Math.round(med * 100) / 100,
    reason: `final bar range ${Math.round(range * 100) / 100} > ${ANOMALY_RANGE_MULT}× the session median ${Math.round(med * 100) / 100} and beyond the session's ${b.high > sessionHigh ? 'high' : 'low'}`,
  };
}

/** Pure: every session-close anomaly in a series. */
export function sessionCloseBarAnomalies(bars: readonly OhlcTimeBar[], exchange: Exchange): CloseBarAnomaly[] {
  const out: CloseBarAnomaly[] = [];
  for (let i = 0; i < bars.length; i++) {
    const a = sessionCloseBarAnomalyAt(bars, i, exchange);
    if (a) out.push(a);
  }
  return out;
}

/** Pure: the series with every anomalous session-close bar flattened to its close (grading only). */
export function sanitizeSessionCloseBars<T extends OhlcTimeBar>(bars: readonly T[], exchange: Exchange): T[] {
  const bad = new Set(sessionCloseBarAnomalies(bars, exchange).map((a) => a.index));
  return bars.map((b, i) => (bad.has(i) ? { ...b, open: b.close, high: b.close, low: b.close } : b));
}

/** Record the newest bar's anomaly (once per bar). Never throws. */
export async function recordCloseBarAnomaly(symbol: string, exchange: Exchange, bars: readonly OhlcTimeBar[]): Promise<CloseBarAnomaly | null> {
  const a = bars.length ? sessionCloseBarAnomalyAt(bars, bars.length - 1, exchange) : null;
  if (!a || !schemaFileReady(BAR_ANOMALY_MIGRATION)) return a;
  try {
    await sql`
      INSERT INTO bar_anomalies (symbol, exchange, bar_time, kind, high, low, close, session_high, session_low, median_range, reason)
      VALUES (${symbol}, ${exchange}, ${new Date(a.barTime)}, 'SESSION_CLOSE_BAR', ${a.high}, ${a.low}, ${a.close}, ${a.sessionHigh}, ${a.sessionLow}, ${a.medianRange}, ${a.reason})
      ON CONFLICT (symbol, exchange, bar_time, kind) DO NOTHING
    `;
    logger.warn({ symbol, exchange, barTime: a.barTime, reason: a.reason }, 'Data quality: anomalous session-close bar recorded');
  } catch (err: any) {
    logger.warn({ error: err.message, symbol }, 'Data quality: bar anomaly record failed');
  }
  return a;
}
