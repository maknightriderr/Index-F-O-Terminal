// ============================================================
// SETUP_EVENTS GRADING (Stage 2: signal-diagnostics)
// ============================================================
// Grades `setup_events` rows once their session has ended, using the ROW'S
// OWN stop and T1 — not the missed-winner audit's 2/3 ATR defaults. Uses
// gradePath directly on the underlying's closed bars after the event (the
// row already carries entry/stop/T1 as absolute price levels, so no ATR
// conversion is needed).
//
// Sibling to missed-winner-audit.ts, same shape: a periodic pass, a per-row
// fetch of historical candles (rate-limited), write-once via graded_at, and
// a row that cannot be graded is still marked so the sweep doesn't retry it
// forever.
//
// LOOK-AHEAD: this deliberately uses future data — that is what grading an
// outcome means. Nothing in the decision path reads `result_r` / `mfe_r` /
// `mae_r` / `exit_reason` / `graded_at`.
// ============================================================

import type { Exchange } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { resolveSpotToken } from './option-chain.js';
import { gradePath, type GradeBar } from './grade-path.js';
import { exitReasonFromGrade } from './exit-reason.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const TICK_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 7 * 60 * 1000; // offset from missed-winner-audit's own 5-minute delay
const HORIZON_MS = 8 * 60 * 60 * 1000; // one session
const MAX_PER_PASS = 25;
const STAGGER_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let started = false;

export function startSetupEventsGrading(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  const tick = () => {
    void runGradingPass(provider).catch((err: any) => logger.warn({ error: err.message }, 'setup_events grading: pass failed'));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, INITIAL_DELAY_MS);
  logger.info({ intervalMinutes: TICK_MS / 60000 }, 'setup_events grading started');
}

interface PendingRow {
  id: string;
  time: Date;
  instrument: string;
  exchange: string;
  direction: string;
  entry: string | null;
  stop: string | null;
  t1: string | null;
  cost_r: string | null;
}

async function runGradingPass(provider: MarketDataProvider): Promise<void> {
  const now = Date.now();
  const rows = await sql<PendingRow[]>`
    SELECT id, time, instrument, exchange, direction, entry, stop, t1, cost_r
    FROM setup_events
    WHERE graded_at IS NULL
      AND event_type IN ('TRADED', 'REJECTED', 'LOW_RR', 'LATE')
      AND time < ${new Date(now - HORIZON_MS)}
    ORDER BY time ASC
    LIMIT ${MAX_PER_PASS}
  `;
  if (rows.length === 0) return;

  let graded = 0;
  for (const row of rows) {
    try {
      const did = await gradeRow(provider, row);
      if (did) graded++;
      await sleep(STAGGER_MS);
    } catch (err: any) {
      await markUngradeable(row.id);
      logger.debug({ error: err.message, instrument: row.instrument }, 'setup_events grading: could not grade');
    }
  }
  if (graded > 0) logger.info({ graded, pending: rows.length }, 'setup_events grading: graded rows');
}

async function gradeRow(provider: MarketDataProvider, row: PendingRow): Promise<boolean> {
  const entry = num(row.entry);
  const stop = num(row.stop);
  const t1 = num(row.t1);
  const direction = row.direction === 'BULLISH' ? 1 : row.direction === 'BEARISH' ? -1 : 0;

  if (entry == null || stop == null || t1 == null || direction === 0) {
    await markUngradeable(row.id);
    return false;
  }

  const decidedAt = new Date(row.time).getTime();
  const candles = await fetchCandlesAfter(provider, row.instrument, row.exchange as Exchange, decidedAt);
  if (candles.length === 0) {
    await markUngradeable(row.id);
    return false;
  }

  const riskPoints = Math.abs(entry - stop);
  if (!(riskPoints > 0)) {
    await markUngradeable(row.id);
    return false;
  }

  // A structure entry is a limit into a zone. If price never traded back to
  // it, the rejected setup would not have filled, and counting its later move
  // would inflate filter leakage.
  const fill = firstFillIndex(candles, entry);
  if (fill < 0) {
    await sql`UPDATE setup_events SET exit_reason = 'NO_FILL', fill_status = 'NO_FILL', graded_at = ${new Date()} WHERE id = ${row.id}`;
    return true;
  }
  const filled = candles.slice(fill);

  const path = gradePath(filled, direction as 1 | -1, entry, stop, t1);
  const resultR = path.hitStop ? -1 : path.hitTarget ? Math.abs(t1 - entry) / riskPoints : finalR(direction as 1 | -1, entry, riskPoints, filled);
  const exitReason = exitReasonFromGrade(path.hitTarget, path.hitStop);
  const costR = num(row.cost_r);

  await sql`
    UPDATE setup_events SET
      result_r = ${round4(resultR)},
      mfe_r = ${round4(path.mfe / riskPoints)},
      mae_r = ${round4(path.mae / riskPoints)},
      exit_reason = ${exitReason},
      fill_status = 'FILLED',
      net_result_r = ${netResultR(resultR, costR)},
      graded_at = ${new Date()}
    WHERE id = ${row.id}
  `;
  return true;
}

/**
 * The first bar whose range includes the entry price: where a limit order
 * there would have filled. -1 when price never traded at the entry. The fill
 * bar itself is graded, stop-first, so a same-bar stop still counts.
 */
export function firstFillIndex(bars: readonly GradeBar[], entry: number): number {
  return bars.findIndex((b) => b.low <= entry && entry <= b.high);
}

/** The graded result after costs: result − cost, both in the underlying's R. Null without a measured cost (never a flat stand-in). */
export function netResultR(resultR: number, costR: number | null): number | null {
  return costR == null ? null : round4(resultR - costR);
}

/** Neither level was reached: the thesis's final mark, in R (never zero-padded as "flat"). */
function finalR(direction: 1 | -1, entry: number, riskPoints: number, candles: readonly GradeBar[]): number {
  const last = candles[candles.length - 1];
  const move = direction > 0 ? last.close - entry : entry - last.close;
  return move / riskPoints;
}

async function fetchCandlesAfter(provider: MarketDataProvider, symbol: string, exchange: Exchange, from: number): Promise<GradeBar[]> {
  const token = await resolveSpotToken(provider, symbol, exchange).catch(() => null);
  if (!token) return [];
  const fmt = (d: Date) => {
    const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())} ${pad(ist.getHours())}:${pad(ist.getMinutes())}`;
  };
  const candles = await provider.getHistoricalData({
    exchange,
    token,
    interval: 'FIFTEEN_MINUTE',
    fromDate: fmt(new Date(from)),
    toDate: fmt(new Date(from + HORIZON_MS)),
  });
  return candles
    .filter((c) => Date.parse(c.timestamp) > from)
    .map((c) => ({ high: c.high, low: c.low, close: c.close }));
}

async function markUngradeable(id: string): Promise<void> {
  await sql`UPDATE setup_events SET graded_at = ${new Date()}, exit_reason = 'OTHER' WHERE id = ${id}`.catch(() => undefined);
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round4 = (n: number) => Math.round(n * 10000) / 10000;
