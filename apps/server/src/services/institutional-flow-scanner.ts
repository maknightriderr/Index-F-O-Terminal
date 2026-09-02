// ============================================================
// INSTITUTIONAL FLOW — PREDICTION TRACKING SCANNER
// ============================================================
// Section 5's next-day bias is worth nothing without a real track
// record, so this generates and stores a NIFTY/BANKNIFTY prediction
// once per trading day and resolves the PRIOR day's prediction once
// the next session has real price action to check it against. Reuses
// the `signals` table (already in the schema, unused until now —
// see database/init/002_schema.sql) rather than a new migration:
// signal_type='NEXT_DAY_BIAS', the probability breakdown + actual
// outcome live in `inputs` JSONB, `fwd_1d_return` doubles as the
// "resolved" flag (NULL = still pending).
//
// This starts from zero real history today — accuracy stats will
// honestly read "not enough data yet" until real trading days
// accumulate. There is no way to backfill a genuine track record.
// ============================================================

import type {
  BiasDirection,
  InstitutionalFlowPrediction,
  PredictionAccuracyStats,
  PredictionAccuracyWindow,
} from '@fno/shared';
import { TRADING_HOURS } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { buildMarketBias } from './market-bias.js';
import { getLiveIndexQuotes, INDEX_LIST } from './indices.js';
import { deriveNextDayBias, INSTITUTIONAL_SYMBOLS } from './institutional-flow.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes — a same-day prediction/resolution doesn't need to be sub-minute fresh
const INITIAL_DELAY_MS = 60_000;
// Was a hardcoded "hour >= 15" — fired as early as 3:00pm, up to 30
// minutes before NSE's actual 15:30 close, locking in a mid-session LTP
// as the permanent "actualClose" for that prediction (the resolution
// query only picks up each pending row once, via fwd_1d_return IS NULL,
// so whichever snapshot wins the first post-gate tick is what sticks
// forever). Now derived from TRADING_HOURS.NSE.close (the same source
// of truth remainingSessionFraction() and isMarketOpen() use) plus a
// small buffer — by RESOLUTION_BUFFER_MINUTES after the bell, trading
// has actually stopped and LTP is genuinely frozen at the day's last
// print, not just "whatever it happened to be a half hour early."
const RESOLUTION_BUFFER_MINUTES = 5;
const [NSE_CLOSE_H, NSE_CLOSE_M] = TRADING_HOURS.NSE.close.split(':').map(Number);
const RESOLUTION_GATE_MINUTES = NSE_CLOSE_H * 60 + NSE_CLOSE_M + RESOLUTION_BUFFER_MINUTES;

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

async function runScan(provider: MarketDataProvider): Promise<void> {
  if (!provider.isAuthenticated()) return;

  const vixQuotes = await getLiveIndexQuotes(provider, [{ symbol: 'INDIAVIX', exchange: 'NSE' }]).catch(() => []);
  const vix = vixQuotes[0]?.ltp ?? null;

  for (const { symbol } of INSTITUTIONAL_SYMBOLS) {
    try {
      await upsertTodayPrediction(provider, symbol, vix);
    } catch (err: any) {
      logger.warn({ error: err.message, symbol }, 'Institutional flow: prediction upsert failed');
    }
  }

  if (istMinutesNow() >= RESOLUTION_GATE_MINUTES) {
    for (const { symbol } of INSTITUTIONAL_SYMBOLS) {
      try {
        await resolvePendingPredictions(provider, symbol);
      } catch (err: any) {
        logger.warn({ error: err.message, symbol }, 'Institutional flow: prediction resolution failed');
      }
    }
  }
}

async function upsertTodayPrediction(provider: MarketDataProvider, symbol: string, vix: number | null): Promise<void> {
  const entry = INDEX_LIST.find((i) => i.symbol === symbol) ?? { symbol, exchange: 'NSE' as const };
  const [{ bias, score }, quotes] = await Promise.all([
    buildMarketBias(provider, symbol, 'NSE'),
    getLiveIndexQuotes(provider, [entry]),
  ]);

  const currentClose = quotes[0]?.ltp;
  if (!currentClose || currentClose <= 0) return;

  const nextDay = deriveNextDayBias(symbol, bias, vix);
  const todayIST = istDateString();

  const inputs = {
    gapUpProbability: nextDay.gapUpProbability,
    gapDownProbability: nextDay.gapDownProbability,
    trendDayProbability: nextDay.trendDayProbability,
    rangeBoundProbability: nextDay.rangeBoundProbability,
    volatileSessionProbability: nextDay.volatileSessionProbability,
    predictedRangeLow: nextDay.expectedRangeLow,
    predictedRangeHigh: nextDay.expectedRangeHigh,
    predictionDayClose: currentClose,
  };

  const existing = await sql<{ id: string }[]>`
    SELECT id FROM signals
    WHERE symbol = ${symbol} AND signal_type = 'NEXT_DAY_BIAS'
      AND (time AT TIME ZONE 'Asia/Kolkata')::date = ${todayIST}::date
    LIMIT 1
  `;

  if (existing.length > 0) {
    await sql`
      UPDATE signals SET
        direction = ${bias.direction},
        confidence = ${bias.confidence},
        bullish_prob = ${bias.bullishProbability},
        bearish_prob = ${bias.bearishProbability},
        neutral_prob = ${bias.neutralProbability},
        inputs = ${sql.json(inputs)},
        reasoning = ${nextDay.reasoning.join(' ')},
        market_regime = ${bias.regime},
        intelligence_score = ${score.score}
      WHERE id = ${existing[0].id}
    `;
  } else {
    await sql`
      INSERT INTO signals (time, symbol, signal_type, direction, confidence, bullish_prob, bearish_prob, neutral_prob, inputs, reasoning, market_regime, intelligence_score)
      VALUES (NOW(), ${symbol}, 'NEXT_DAY_BIAS', ${bias.direction}, ${bias.confidence}, ${bias.bullishProbability}, ${bias.bearishProbability}, ${bias.neutralProbability}, ${sql.json(inputs)}, ${nextDay.reasoning.join(' ')}, ${bias.regime}, ${score.score})
    `;
  }
}

async function resolvePendingPredictions(provider: MarketDataProvider, symbol: string): Promise<void> {
  const todayIST = istDateString();

  const pending = await sql<{ id: string; inputs: any }[]>`
    SELECT id, inputs FROM signals
    WHERE symbol = ${symbol} AND signal_type = 'NEXT_DAY_BIAS'
      AND fwd_1d_return IS NULL
      AND (time AT TIME ZONE 'Asia/Kolkata')::date < ${todayIST}::date
  `;
  if (pending.length === 0) return;

  const entry = INDEX_LIST.find((i) => i.symbol === symbol) ?? { symbol, exchange: 'NSE' as const };
  const quotes = await getLiveIndexQuotes(provider, [entry]);
  const q = quotes[0];
  if (!q || q.ltp <= 0) return;

  for (const row of pending) {
    const predictionDayClose = Number(row.inputs?.predictionDayClose ?? 0);
    if (predictionDayClose <= 0) continue;

    const actualOpen = q.open;
    const actualHigh = q.high;
    const actualLow = q.low;
    const actualClose = q.ltp;

    const gapPct = ((actualOpen - predictionDayClose) / predictionDayClose) * 100;
    const actualGapType: 'GAP_UP' | 'GAP_DOWN' | 'FLAT' = gapPct > 0.15 ? 'GAP_UP' : gapPct < -0.15 ? 'GAP_DOWN' : 'FLAT';

    const dayChangePct = actualOpen > 0 ? ((actualClose - actualOpen) / actualOpen) * 100 : 0;
    const actualDirection: BiasDirection = dayChangePct > 0.1 ? 'BULLISH' : dayChangePct < -0.1 ? 'BEARISH' : 'NEUTRAL';

    const predictedRangeLow = Number(row.inputs?.predictedRangeLow ?? 0);
    const predictedRangeHigh = Number(row.inputs?.predictedRangeHigh ?? 0);
    const rangeAccurate =
      predictedRangeLow > 0 && predictedRangeHigh > 0 ? actualLow >= predictedRangeLow && actualHigh <= predictedRangeHigh : null;

    const forwardReturnPercent = ((actualClose - predictionDayClose) / predictionDayClose) * 100;

    const mergedInputs = { ...row.inputs, actualOpen, actualHigh, actualLow, actualClose, actualGapType, actualDirection, rangeAccurate };

    await sql`
      UPDATE signals SET inputs = ${sql.json(mergedInputs)}, fwd_1d_return = ${forwardReturnPercent}
      WHERE id = ${row.id}
    `;
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
  const predictedDirection = row.direction;
  const actualDirection: BiasDirection | null = inputs.actualDirection ?? null;

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
    directionCorrect: resolved && actualDirection != null ? actualDirection === predictedDirection : null,
    rangeAccurate: inputs.rangeAccurate ?? null,
    forwardReturnPercent: row.fwd_1d_return != null ? Number(row.fwd_1d_return) : null,
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

function accuracyWindow(predictions: InstitutionalFlowPrediction[]): PredictionAccuracyWindow {
  const resolved = predictions.filter((p) => p.resolved);
  const withDirection = resolved.filter((p) => p.directionCorrect != null);
  const withRange = resolved.filter((p) => p.rangeAccurate != null);
  const withReturn = resolved.filter((p) => p.forwardReturnPercent != null);

  return {
    count: predictions.length,
    resolvedCount: resolved.length,
    directionAccuracyPercent: withDirection.length > 0 ? Math.round((withDirection.filter((p) => p.directionCorrect).length / withDirection.length) * 100) : null,
    rangeAccuracyPercent: withRange.length > 0 ? Math.round((withRange.filter((p) => p.rangeAccurate).length / withRange.length) * 100) : null,
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

function istDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Minutes since midnight IST — comparable directly against
// TRADING_HOURS.NSE.close's own "HH:MM" so the resolution gate tracks
// the real exchange close instead of a hardcoded hour that drifted out
// of sync with it. Same Date-round-trip pattern market-bias.ts's own
// remainingSessionFraction() uses for the identical IST-minutes need.
function istMinutesNow(): number {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.getHours() * 60 + ist.getMinutes();
}
