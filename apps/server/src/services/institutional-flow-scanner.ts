// ============================================================
// INSTITUTIONAL FLOW — PREDICTION TRACKING SCANNER
// ============================================================
// Section 5's next-day read is worth nothing without a real track record,
// so this records one prediction per NSE trading day for NIFTY and
// BANKNIFTY and grades it against the next session. Reuses the `signals`
// table: signal_type='NEXT_DAY_BIAS', the estimate + actual outcome live in
// `inputs` JSONB, `fwd_1d_return` doubles as the "resolved" flag.
//
// How it's recorded and graded (rebuilt 17 Sep 2026 — the first version
// produced a track record that couldn't be trusted):
//   - A prediction is written only on a trading day, after that session's
//     close, from its completed daily candle. The old scanner upserted
//     around the clock, so Saturdays, Sundays and holidays got their own
//     "predictions" from frozen data.
//   - It's graded from daily candles: the prediction day's close against
//     the NEXT trading session's open/high/low/close, and only once that
//     session is over. The old resolver used whatever live quote it saw
//     after 15:35 — on a weekend or holiday that was the prediction day's
//     own quote, so those rows were graded against themselves (the
//     close-to-close 0.00% rows).
//   - Direction is graded close-to-close (a next-day read is made at the
//     close), with a ±0.15% flat band.
//   - History recorded under the old scanner is repaired once: rows dated
//     on non-trading days are deleted, and the rest are re-graded from
//     daily candles. Their direction calls are kept (labelled legacy); their
//     ranges were to-expiry bands, not one-day ranges, so they aren't
//     graded as ranges.
// ============================================================

import type { BiasDirection, InstitutionalFlowPrediction, PredictionAccuracyStats, PredictionAccuracyWindow } from '@fno/shared';
import { getSessionWindow } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { buildNextDayBias, getDailyBars, INSTITUTIONAL_SYMBOLS } from './institutional-flow.js';
import {
  NEXT_DAY_MODEL_VERSION,
  GAP_THRESHOLD_PCT,
  DIRECTION_FLAT_BAND_PCT,
  gapPct,
  isVolatileNext,
} from './next-day-model.js';
import type { DailyBar } from './next-day-model.js';
import { sql } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000;
// Daily candles settle a few minutes after the bell.
const AFTER_CLOSE_BUFFER_MS = 10 * 60 * 1000;
const LEGACY_MODEL = 'legacy-intraday-bias';
const HISTORY_REPAIR_KEY = 'next_day_bias:history_repaired:v2';

let scannerStarted = false;

export function startInstitutionalFlowScanner(provider: MarketDataProvider): void {
  if (scannerStarted) return;
  scannerStarted = true;

  const tick = () => {
    runScan(provider).catch((err) => logger.error({ error: err.message }, 'Institutional flow scan tick failed'));
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, SCAN_INTERVAL_MS);
  logger.info({ intervalMs: SCAN_INTERVAL_MS }, 'Institutional flow prediction scanner started');
}

function istDate(at: number = Date.now()): string {
  return new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** True once `date`'s NSE session has closed and its daily candle has settled. */
function sessionSettled(date: string, now = Date.now()): boolean {
  const session = getSessionWindow('NSE', date);
  return !!session && now >= session.close + AFTER_CLOSE_BUFFER_MS;
}

async function runScan(provider: MarketDataProvider): Promise<void> {
  if (!provider.isAuthenticated()) return;

  await repairHistoryOnce().catch((err: any) => logger.warn({ error: err.message }, 'Next-day history repair failed — will retry'));

  const today = istDate();
  const recordToday = sessionSettled(today);

  for (const { symbol } of INSTITUTIONAL_SYMBOLS) {
    try {
      if (recordToday) await recordPrediction(provider, symbol, today);
      await resolvePending(provider, symbol);
    } catch (err: any) {
      logger.warn({ error: err.message, symbol }, 'Institutional flow: prediction record/resolve failed');
    }
  }
}

async function recordPrediction(provider: MarketDataProvider, symbol: string, today: string): Promise<void> {
  const nextDay = await buildNextDayBias(provider, symbol, { freshHistory: true });
  const evidence = nextDay.evidence;
  // Today's candle not in the history yet — try again next tick rather than
  // recording yesterday's basis under today's date.
  if (!evidence || evidence.basisDate !== today || !evidence.basisFinal) return;

  const inputs = {
    model: NEXT_DAY_MODEL_VERSION,
    gapUpProbability: nextDay.gapUpProbability,
    gapDownProbability: nextDay.gapDownProbability,
    flatOpenProbability: nextDay.flatOpenProbability ?? null,
    trendDayProbability: nextDay.trendDayProbability,
    rangeBoundProbability: nextDay.rangeBoundProbability,
    volatileSessionProbability: nextDay.volatileSessionProbability,
    predictedRangeLow: nextDay.expectedRangeLow,
    predictedRangeHigh: nextDay.expectedRangeHigh,
    predictionDayClose: evidence.basisClose,
    evidence: { ...evidence },
  } as Record<string, any>;

  const existing = await sql<{ id: string; fwd_1d_return: string | null }[]>`
    SELECT id, fwd_1d_return FROM signals
    WHERE symbol = ${symbol} AND signal_type = 'NEXT_DAY_BIAS'
      AND (time AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date
    LIMIT 1
  `;
  if (existing.length > 0) {
    if (existing[0].fwd_1d_return != null) return; // already graded — never rewrite a resolved prediction
    await sql`
      UPDATE signals SET
        direction = ${nextDay.predictedDirection},
        confidence = ${nextDay.confidence},
        bullish_prob = ${null},
        bearish_prob = ${null},
        neutral_prob = ${null},
        inputs = ${sql.json(inputs)},
        reasoning = ${nextDay.reasoning.join(' ')},
        market_regime = ${null},
        intelligence_score = ${null}
      WHERE id = ${existing[0].id}
    `;
  } else {
    await sql`
      INSERT INTO signals (time, symbol, signal_type, direction, confidence, inputs, reasoning)
      VALUES (NOW(), ${symbol}, 'NEXT_DAY_BIAS', ${nextDay.predictedDirection}, ${nextDay.confidence}, ${sql.json(inputs)}, ${nextDay.reasoning.join(' ')})
    `;
  }
}

const ACTUAL_FIELDS = ['actualOpen', 'actualHigh', 'actualLow', 'actualClose', 'actualGapType', 'actualDirection', 'rangeAccurate', 'gapLeanCorrect', 'volatileActual', 'resolvedSessionDate'];

/**
 * One-time repair of predictions recorded by the first scanner: delete rows
 * dated on non-trading days, and clear every other row's grade so
 * resolvePending re-grades it from daily candles.
 */
async function repairHistoryOnce(): Promise<void> {
  if (await redis.get(HISTORY_REPAIR_KEY)) return;

  const rows = await sql<{ id: string; day: string; inputs: any }[]>`
    SELECT id, to_char((time AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, inputs
    FROM signals WHERE signal_type = 'NEXT_DAY_BIAS'
  `;
  let deleted = 0;
  let reset = 0;
  for (const row of rows) {
    if (!getSessionWindow('NSE', row.day)) {
      await sql`DELETE FROM signals WHERE id = ${row.id}`;
      deleted++;
      continue;
    }
    const inputs = { ...(row.inputs ?? {}) };
    if (!inputs.model) inputs.model = LEGACY_MODEL;
    for (const k of ACTUAL_FIELDS) delete inputs[k];
    await sql`UPDATE signals SET inputs = ${sql.json(inputs)}, fwd_1d_return = NULL WHERE id = ${row.id}`;
    reset++;
  }
  await redis.set(HISTORY_REPAIR_KEY, String(Date.now()));
  logger.info({ deleted, reset }, 'Next-day prediction history repaired — non-trading-day rows removed, the rest queued for re-grading from daily candles');
}

async function resolvePending(provider: MarketDataProvider, symbol: string): Promise<void> {
  const pending = await sql<{ id: string; day: string; direction: BiasDirection | null; inputs: any }[]>`
    SELECT id, to_char((time AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, direction, inputs
    FROM signals
    WHERE symbol = ${symbol} AND signal_type = 'NEXT_DAY_BIAS' AND fwd_1d_return IS NULL
    ORDER BY time ASC
  `;
  if (pending.length === 0) return;

  const bars: DailyBar[] = await getDailyBars(provider, symbol, true);
  const indexByDate = new Map(bars.map((b, i) => [b.date, i]));

  for (const row of pending) {
    const i = indexByDate.get(row.day);
    if (i == null) {
      // A non-trading day that slipped in (e.g. a holiday added to the
      // calendar later) can never be graded.
      if (!getSessionWindow('NSE', row.day)) await sql`DELETE FROM signals WHERE id = ${row.id}`;
      continue;
    }
    const basis = bars[i];
    const next = bars[i + 1];
    if (!next || !sessionSettled(next.date)) continue;
    // A prediction is only valid for the session right after it.
    if (next.date === row.day) continue;

    const inputs = row.inputs ?? {};
    const isEmpirical = inputs.model === NEXT_DAY_MODEL_VERSION;
    const gap = gapPct(basis, next);
    const actualGapType: 'GAP_UP' | 'GAP_DOWN' | 'FLAT' = gap > GAP_THRESHOLD_PCT ? 'GAP_UP' : gap < -GAP_THRESHOLD_PCT ? 'GAP_DOWN' : 'FLAT';
    const forwardReturnPercent = ((next.close - basis.close) / basis.close) * 100;
    const actualDirection: BiasDirection =
      forwardReturnPercent > DIRECTION_FLAT_BAND_PCT ? 'BULLISH' : forwardReturnPercent < -DIRECTION_FLAT_BAND_PCT ? 'BEARISH' : 'NEUTRAL';

    const low = Number(inputs.predictedRangeLow ?? 0);
    const high = Number(inputs.predictedRangeHigh ?? 0);
    const rangeAccurate = isEmpirical && low > 0 && high > 0 ? next.close >= low && next.close <= high : null;


    const merged = {
      ...inputs,
      predictionDayClose: basis.close,
      resolvedSessionDate: next.date,
      actualOpen: next.open,
      actualHigh: next.high,
      actualLow: next.low,
      actualClose: next.close,
      actualGapType,
      actualDirection,
      rangeAccurate,
      volatileActual: isEmpirical ? isVolatileNext(bars, i) : null,
    };

    await sql`UPDATE signals SET inputs = ${sql.json(merged)}, fwd_1d_return = ${forwardReturnPercent} WHERE id = ${row.id}`;
  }
}

// --- Read side ---

interface SignalRow {
  id: string;
  time: Date;
  symbol: string;
  direction: BiasDirection;
  confidence: string;
  inputs: any;
  fwd_1d_return: string | null;
}

function toPrediction(row: SignalRow): InstitutionalFlowPrediction {
  const inputs = row.inputs ?? {};
  const resolved = row.fwd_1d_return != null;
  const predictedDirection = (row.direction ?? 'NEUTRAL') as BiasDirection;
  const actualDirection: BiasDirection | null = inputs.actualDirection ?? null;
  const model: string = inputs.model ?? LEGACY_MODEL;
  // The empirical model makes no direction call, so there's nothing to grade.
  const directionCall = model !== NEXT_DAY_MODEL_VERSION && predictedDirection !== 'NEUTRAL';

  return {
    id: row.id,
    symbol: row.symbol,
    predictionDate: new Date(row.time).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
    createdAt: new Date(row.time).getTime(),
    predictedDirection,
    gapUpProbability: Number(inputs.gapUpProbability ?? 0),
    gapDownProbability: Number(inputs.gapDownProbability ?? 0),
    trendDayProbability: Number(inputs.trendDayProbability ?? 0),
    rangeBoundProbability: Number(inputs.rangeBoundProbability ?? 0),
    volatileSessionProbability: Number(inputs.volatileSessionProbability ?? 0),
    predictedRangeLow: Number(inputs.predictedRangeLow ?? 0),
    predictedRangeHigh: Number(inputs.predictedRangeHigh ?? 0),
    predictionDayClose: Number(inputs.predictionDayClose ?? 0),
    resolved,
    actualOpen: inputs.actualOpen ?? null,
    actualHigh: inputs.actualHigh ?? null,
    actualLow: inputs.actualLow ?? null,
    actualClose: inputs.actualClose ?? null,
    actualGapType: inputs.actualGapType ?? null,
    actualDirection,
    directionCorrect: resolved && directionCall && actualDirection != null ? actualDirection === predictedDirection : null,
    rangeAccurate: inputs.rangeAccurate ?? null,
    forwardReturnPercent: row.fwd_1d_return != null ? Number(row.fwd_1d_return) : null,
    model,
    flatOpenProbability: inputs.flatOpenProbability ?? null,
    volatileActual: inputs.volatileActual ?? null,
  };
}

export async function getPredictionHistory(symbol: string, limit = 30): Promise<InstitutionalFlowPrediction[]> {
  const rows = await sql<SignalRow[]>`
    SELECT id, time, symbol, direction, confidence, inputs, fwd_1d_return FROM signals
    WHERE symbol = ${symbol} AND signal_type = 'NEXT_DAY_BIAS'
    ORDER BY time DESC
    LIMIT ${limit}
  `;
  return rows.map(toPrediction);
}

const share = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);

function accuracyWindow(predictions: InstitutionalFlowPrediction[]): PredictionAccuracyWindow {
  const resolved = predictions.filter((p) => p.resolved);
  const directionCalls = resolved.filter((p) => p.directionCorrect != null);
  const ranges = resolved.filter((p) => p.rangeAccurate != null);
  const gaps = resolved.filter((p) => p.model === NEXT_DAY_MODEL_VERSION && p.actualGapType != null);
  const volatile = resolved.filter((p) => p.volatileActual != null);
  const withReturn = resolved.filter((p) => p.forwardReturnPercent != null);

  return {
    count: predictions.length,
    resolvedCount: resolved.length,
    directionAccuracyPercent: share(directionCalls.filter((p) => p.directionCorrect).length, directionCalls.length),
    directionCallCount: directionCalls.length,
    rangeAccuracyPercent: share(ranges.filter((p) => p.rangeAccurate).length, ranges.length),
    rangeCount: ranges.length,
    gapUpPredictedPercent: gaps.length > 0 ? Math.round(gaps.reduce((a, p) => a + p.gapUpProbability, 0) / gaps.length) : null,
    gapUpActualPercent: share(gaps.filter((p) => p.actualGapType === 'GAP_UP').length, gaps.length),
    gapDownPredictedPercent: gaps.length > 0 ? Math.round(gaps.reduce((a, p) => a + p.gapDownProbability, 0) / gaps.length) : null,
    gapDownActualPercent: share(gaps.filter((p) => p.actualGapType === 'GAP_DOWN').length, gaps.length),
    volatilePredictedPercent: volatile.length > 0 ? Math.round(volatile.reduce((a, p) => a + p.volatileSessionProbability, 0) / volatile.length) : null,
    volatileActualPercent: share(volatile.filter((p) => p.volatileActual).length, volatile.length),
    avgForwardReturnPercent: withReturn.length > 0 ? Math.round((withReturn.reduce((a, p) => a + (p.forwardReturnPercent ?? 0), 0) / withReturn.length) * 100) / 100 : null,
  };
}

export async function getAccuracyStats(symbol: string): Promise<PredictionAccuracyStats> {
  const all = await getPredictionHistory(symbol, 100);
  return {
    symbol,
    last7: accuracyWindow(all.slice(0, 7)),
    last30: accuracyWindow(all.slice(0, 30)),
    last100: accuracyWindow(all),
    allTime: accuracyWindow(all),
  };
}
